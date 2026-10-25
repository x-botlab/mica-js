import type { DeviceBehaviorApi, DeviceDescription } from '@mica-js/simulator';
import { LOGIC_VOLTAGE, packagePins, pinMap } from './shared';

/**
 * Four-channel SPI analog-to-digital converter (RFC 0002 §5, `pin.sampleAnalog`).
 *
 * The part samples four single-ended inputs against its own 3.3 V supply and
 * reports them in volts. Two independent command paths exist, on purpose:
 *
 * - **Wire path.** `CS`/`SCK`/`MOSI` are a mode-0 SPI slave. A command byte is
 *   shifted in while `CS` is low; the rising edge of `CS` starts one conversion,
 *   which the next tick performs. `MISO` carries the *conversion complete* flag,
 *   so a host can poll the part without decoding a full response frame.
 * - **Topic path.** A `read` delivery requests the same conversion. The bench
 *   uses it because it drives devices through topic endpoints rather than by
 *   bit-banging pins.
 *
 * Both paths funnel into the same conversion, so the electrical behaviour a
 * reader observes on `AIN0`–`AIN3` is identical either way.
 */

/** Package device id; the `lab:` prefix marks playground-only parts. */
export const ADC_MODULE_DEVICE = 'lab:adc-module';

/** IR device type reported to the compiler and the accessor surface. */
export const ADC_MODULE_TYPE = 'adc-module';

/** Analog inputs, in channel order. */
export const ADC_INPUT_PINS = Object.freeze(['AIN0', 'AIN1', 'AIN2', 'AIN3']);

/** Serial control lines, in symbol order. */
export const ADC_CONTROL_PINS = Object.freeze(['CS', 'SCK', 'MOSI']);

/** Channels the part converts per request. */
export const ADC_CHANNEL_COUNT = ADC_INPUT_PINS.length;

/** Pins block of the device-package description (drawing side + pin groups). */
export const ADC_MODULE_PACKAGE = Object.freeze({
  pins: {
    ...packagePins(ADC_CONTROL_PINS, 'left'),
    MISO: { kind: 'signal', side: 'left' },
    ...packagePins(ADC_INPUT_PINS, 'right'),
  },
  pinGroups: {
    spi: { pins: ['CS', 'SCK', 'MOSI', 'MISO'] },
    analog: { pins: [...ADC_INPUT_PINS] },
  },
  ports: {
    read: {
      title: '采样',
      description: '投递任意布尔值触发一次四通道转换；结果在下一次 update 发布。',
      direction: 'input',
      type: 'boolean',
    },
    ...Object.fromEntries(
      ADC_INPUT_PINS.map((pin, channel) => [
        `ch${channel}`,
        {
          title: `${pin} 电压`,
          description: `${pin} 上一次解网得到的电压，单位伏特。`,
          direction: 'output',
          type: 'number',
        },
      ]),
    ),
  },
  designatorPrefix: 'U',
});

/** Channels keyed by state name, so the behaviour and the ports cannot drift. */
function channelStates(): readonly string[] {
  return ADC_INPUT_PINS.map((_, channel) => `ch${channel}`);
}

function configure(api: DeviceBehaviorApi): void {
  for (const name of ADC_CONTROL_PINS) {
    api.pin(name).configure('high-z');
    api.pin(name).pull('down');
  }
  api.pin('MISO').configure('push-pull');
  api.pin('MISO').writeDigital(api.builder.const('bool', false));
  // `configure({ mode: 'analog' })` marks the pin as an analog input without
  // enabling a drive, so the channel reads the solved net and never fights it.
  for (const name of ADC_INPUT_PINS) {
    api.pin(name).configure({ mode: 'analog' });
  }
}

/**
 * One tick of the SPI slave plus the conversion of any pending request.
 *
 * Conversions run in `tick` (before the solve) so a request issued during the
 * previous tick already sees that tick's solved node voltages.
 */
function tick(api: DeviceBehaviorApi): void {
  const b = api.builder;
  const cs = api.pin('CS').sampleDigital();
  const sck = api.pin('SCK').sampleDigital();
  const mosi = api.pin('MOSI').sampleDigital();

  const clock = api.state<'bool'>('clock');
  const selected = api.state<'bool'>('selected');
  const shift = api.state<'u32'>('shift');
  const pending = api.state<'bool'>('pending');
  const ready = api.state<'bool'>('ready');

  const wasClock = clock.load();
  const wasSelected = selected.load();
  const rising = b.bool.and(sck, b.bool.not(wasClock));
  const frameStart = b.bool.and(b.bool.not(cs), wasSelected);
  const frameEnd = b.bool.and(cs, b.bool.not(wasSelected));

  // A conversion requested by either path happens before the new request lands.
  const convert = pending.load();

  const bit = b.select(mosi, b.const('u32', 1), b.const('u32', 0));
  const shifted = b.int.and(
    b.int.or(b.int.shl(shift.load(), b.const('u32', 1)), bit),
    b.const('u32', 0xff),
  );
  const sampling = b.bool.and(b.bool.not(cs), rising);
  shift.store(b.select(frameStart, b.const('u32', 0), b.select(sampling, shifted, shift.load())));

  for (const [channel, state] of channelStates().entries()) {
    const handle = api.state<'f32'>(state);
    handle.store(
      b.select(convert, api.pin(ADC_INPUT_PINS[channel] as string).sampleAnalog(), handle.load()),
    );
  }
  ready.store(convert);
  // Frame end queues the conversion for the next tick, matching the SPI part's
  // "sample after the command frame" timing.
  pending.store(frameEnd);

  // Open-drain style status line: high while a fresh result is available.
  api.pin('MISO').writeDigital(ready.load());

  clock.store(sck);
  selected.store(cs);
}

/** Publishes the latched channels; the output endpoint is sampled every tick. */
function update(api: DeviceBehaviorApi): void {
  const b = api.builder;
  // Publish all channels every tick
  for (const [channel, state] of channelStates().entries()) {
    const handle = api.state<'f32'>(state);
    api.topics.publish(`ch${channel}`, [b.convert.float('f64', handle.load())]);
  }
  api.state<'bool'>('ready').store(b.const('bool', false));
}

/** Unified-IR description of the converter. */
export function createAdcModuleDescription(): DeviceDescription {
  const states: Record<
    string,
    { readonly type: 'bool' | 'u32' | 'f32'; readonly initial: boolean | number }
  > = {
    clock: { type: 'bool', initial: false },
    selected: { type: 'bool', initial: false },
    shift: { type: 'u32', initial: 0 },
    pending: { type: 'bool', initial: false },
    ready: { type: 'bool', initial: false },
  };
  for (const state of channelStates()) {
    states[state] = { type: 'f32', initial: 0 };
  }
  return {
    name: ADC_MODULE_TYPE,
    pins: {
      ...pinMap(ADC_CONTROL_PINS, 'input'),
      MISO: { direction: 'output' },
      ...pinMap(ADC_INPUT_PINS, 'input', 'signal'),
    },
    states,
    powerDomains: [{ name: 'vdd', voltage: LOGIC_VOLTAGE }],
    ports: {
      read: { direction: 'input', type: 'boolean', title: '采样' },
      ...Object.fromEntries(
        ADC_INPUT_PINS.map((pin, channel) => [
          `ch${channel}`,
          { direction: 'output' as const, type: 'number' as const, title: `${pin} 电压` },
        ]),
      ),
    },
    behaviors: {
      initialize: (api) => {
        configure(api);
        api.topics.subscribe('read', (handler) => {
          // Any delivery is a request; the payload itself carries no channel mask.
          handler.state<'bool'>('pending').store(handler.builder.const('bool', true));
        });
      },
      tick,
      update,
    },
  };
}
