import type { Value } from '@mica-js/ir';
import type { DeviceBehaviorApi, DeviceDescription } from '@mica-js/simulator';
import { LOGIC_VOLTAGE, packagePins, pinMap } from './shared';

/**
 * Two-channel SPI digital-to-analog converter (RFC 0002 §5, `pin.writeAnalog`).
 *
 * `writeAnalog(volts)` stores a voltage *intent* and puts the pin into the
 * analog drive mode; the next electrical solve arbitrates that intent against
 * the rails and every other driver on the net. The part therefore never writes
 * a level — it writes a voltage the solver has to agree with.
 *
 * Command paths, mirroring the ADC:
 *
 * - **Wire path.** A 16-bit mode-1 frame shifted into `MOSI`: bit 15 selects the
 *   channel, bits 14–3 carry the 12-bit code, bits 2–0 are ignored. The rising
 *   edge of `CS` latches the frame.
 * - **Topic path.** `vout0` / `vout1` deliveries take the voltage directly, which
 *   is what a widget binding uses.
 */

/** Package device id of the converter. */
export const DAC_MODULE_DEVICE = 'lab:dac-module';

/** IR device type of the converter. */
export const DAC_MODULE_TYPE = 'dac-module';

/** Serial control lines. */
export const DAC_CONTROL_PINS = Object.freeze(['CS', 'SCK', 'MOSI']);

/** Analog outputs, in channel order. */
export const DAC_OUTPUT_PINS = Object.freeze(['VOUT0', 'VOUT1']);

/** Full-scale code of the 12-bit converter. */
export const DAC_FULL_SCALE = 4095;

/** Pins block of the device-package description. */
export const DAC_MODULE_PACKAGE = Object.freeze({
  pins: {
    ...packagePins(DAC_CONTROL_PINS, 'left'),
    MISO: { kind: 'signal', side: 'left' },
    ...packagePins(DAC_OUTPUT_PINS, 'right'),
  },
  pinGroups: {
    spi: { pins: ['CS', 'SCK', 'MOSI', 'MISO'] },
    outputs: { pins: [...DAC_OUTPUT_PINS] },
  },
  ports: {
    vout0: {
      title: 'VOUT0 电压',
      description: '0–3.3 V；写入即更新模拟输出意图。',
      direction: 'input',
      type: 'number',
    },
    vout1: {
      title: 'VOUT1 电压',
      description: '0–3.3 V；写入即更新模拟输出意图。',
      direction: 'input',
      type: 'number',
    },
    ready: {
      title: '已更新',
      description: '本 tick 有新电压被锁存时输出 true。',
      direction: 'output',
      type: 'boolean',
    },
  },
  designatorPrefix: 'U',
});

function clampVoltage(api: DeviceBehaviorApi, value: Value<'f32'>): Value<'f32'> {
  const b = api.builder;
  const upper = b.const('f32', LOGIC_VOLTAGE);
  const lower = b.const('f32', 0);
  return b.select(
    b.float.cmp('gt', value, upper),
    upper,
    b.select(b.float.cmp('lt', value, lower), lower, value),
  );
}

function tick(api: DeviceBehaviorApi): void {
  const b = api.builder;
  const cs = api.pin('CS').sampleDigital();
  const sck = api.pin('SCK').sampleDigital();
  const mosi = api.pin('MOSI').sampleDigital();

  const clock = api.state<'bool'>('clock');
  const selected = api.state<'bool'>('selected');
  const shift = api.state<'u32'>('shift');
  const bits = api.state<'u32'>('bits');
  const fresh = api.state<'bool'>('fresh');
  const v0 = api.state<'f32'>('v0');
  const v1 = api.state<'f32'>('v1');

  const wasClock = clock.load();
  const wasSelected = selected.load();
  const rising = b.bool.and(sck, b.bool.not(wasClock));
  const frameStart = b.bool.and(b.bool.not(cs), wasSelected);
  const frameEnd = b.bool.and(cs, b.bool.not(wasSelected));

  const bit = b.select(mosi, b.const('u32', 1), b.const('u32', 0));
  const sampling = b.bool.and(b.bool.not(cs), rising);
  const shifted = b.int.or(b.int.shl(shift.load(), b.const('u32', 1)), bit);
  const nextShift = b.select(sampling, b.int.and(shifted, b.const('u32', 0xffff)), shift.load());
  const nextBits = b.select(
    frameStart,
    b.const('u32', 0),
    b.select(sampling, b.int.add(bits.load(), b.const('u32', 1)), bits.load()),
  );

  // Decode the latched frame: channel in bit 15, code in bits 14–3.
  const code = b.int.and(b.int.lshr(nextShift, b.const('u32', 3)), b.const('u32', DAC_FULL_SCALE));
  const scale = b.const('f32', DAC_FULL_SCALE);
  const volts = b.float.mul(
    b.float.div(b.convert.intToFloat('f32', code), scale),
    b.const('f32', LOGIC_VOLTAGE),
  );
  const channel = b.int.and(b.int.lshr(nextShift, b.const('u32', 15)), b.const('u32', 1));
  const latch = b.bool.and(frameEnd, b.int.cmp('ge', nextBits, b.const('u32', 16)));

  v0.store(
    b.select(
      latch,
      b.select(b.int.cmp('eq', channel, b.const('u32', 0)), volts, v0.load()),
      v0.load(),
    ),
  );
  v1.store(
    b.select(
      latch,
      b.select(b.int.cmp('eq', channel, b.const('u32', 1)), volts, v1.load()),
      v1.load(),
    ),
  );
  // A topic delivery may have set `fresh` before this tick; keep it until the
  // update phase has published the latched values.
  fresh.store(b.bool.or(fresh.load(), latch));
  shift.store(nextShift);
  bits.store(nextBits);
  clock.store(sck);
  selected.store(cs);

  // The intent is re-asserted every tick: it is a latch the solver reads, and
  // re-writing it keeps the pin in the analog drive mode after a reset.
  api.pin('VOUT0').writeAnalog(clampVoltage(api, v0.load()));
  api.pin('VOUT1').writeAnalog(clampVoltage(api, v1.load()));
  api.pin('MISO').writeDigital(fresh.load());
}

function publish(api: DeviceBehaviorApi): void {
  const b = api.builder;
  const fresh = api.state<'bool'>('fresh').load();
  api.topics.publish('ready', [fresh]);
  api.state<'bool'>('fresh').store(b.const('bool', false));
}

/** Unified-IR description of the converter. */
export function createDacModuleDescription(): DeviceDescription {
  return {
    name: DAC_MODULE_TYPE,
    pins: {
      ...pinMap(DAC_CONTROL_PINS, 'input'),
      MISO: { direction: 'output' },
      ...pinMap(DAC_OUTPUT_PINS, 'output'),
    },
    states: {
      clock: { type: 'bool', initial: false },
      selected: { type: 'bool', initial: false },
      shift: { type: 'u32', initial: 0 },
      bits: { type: 'u32', initial: 0 },
      fresh: { type: 'bool', initial: false },
      v0: { type: 'f32', initial: 0 },
      v1: { type: 'f32', initial: 0 },
    },
    powerDomains: [{ name: 'vdd', voltage: LOGIC_VOLTAGE }],
    ports: {
      vout0: { direction: 'input', type: 'number', title: 'VOUT0 电压' },
      vout1: { direction: 'input', type: 'number', title: 'VOUT1 电压' },
      ready: { direction: 'output', type: 'boolean', title: '已更新' },
    },
    behaviors: {
      initialize: (api) => {
        for (const name of DAC_CONTROL_PINS) {
          api.pin(name).configure('high-z');
          api.pin(name).pull('down');
        }
        api.pin('MISO').configure('push-pull');
        for (const name of DAC_OUTPUT_PINS) {
          api.pin(name).writeAnalog(0);
        }
        for (const [port, state] of [
          ['vout0', 'v0'],
          ['vout1', 'v1'],
        ] as const) {
          api.topics.subscribe(port, (handler) => {
            const value = handler.args[0];
            if (value === undefined) return;
            handler
              .state<'f32'>(state)
              .store(handler.builder.convert.float('f32', value as Value<'f64'>));
            handler.state<'bool'>('fresh').store(handler.builder.const('bool', true));
          });
        }
      },
      tick,
      update: publish,
    },
  };
}
