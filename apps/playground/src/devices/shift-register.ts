import type { Value } from '@mica-js/ir';
import type { DeviceBehaviorApi, DeviceDescription } from '@mica-js/simulator';
import { LOGIC_VOLTAGE, packagePins, pinMap } from './shared';

/**
 * 74HC595 serial-in / parallel-out shift register (RFC 0004, `api.pinGroup`).
 *
 * The part shows both halves of a pin group:
 *
 * ```ts
 * const outputs = api.pinGroup(Q_PINS);
 * outputs.writeDigital(0xa5);      // Q0 = 1, Q1 = 0, … Q7 = 1
 * const solved = outputs.readDigital(); // solved pin_input levels, LSB first
 * ```
 *
 * `writeDigital` drives all eight latches in one lowering; `readDigital` folds
 * the *solved* levels back into one `u32`, which is what a host uses to verify
 * that the electrical layer really carried the byte it wrote.
 *
 * Wire protocol: `DS` is sampled on every rising edge of `SHCP`; `STCP` rising
 * copies the shift register into the output latch. The `data` topic applies the
 * same latch update for hosts that drive devices through topic endpoints.
 */

/** Package device id of the shift register. */
export const SHIFT_REGISTER_DEVICE = 'lab:shift-register';

/** IR device type of the shift register. */
export const SHIFT_REGISTER_TYPE = 'shift-register';

/** Serial inputs. */
export const SHIFT_REGISTER_INPUT_PINS = Object.freeze(['DS', 'SHCP', 'STCP']);

/** Parallel outputs, least significant bit first. */
export const SHIFT_REGISTER_OUTPUT_PINS = Object.freeze([
  'Q0',
  'Q1',
  'Q2',
  'Q3',
  'Q4',
  'Q5',
  'Q6',
  'Q7',
]);

/** Pins block of the device-package description. */
export const SHIFT_REGISTER_PACKAGE = Object.freeze({
  pins: {
    ...packagePins(SHIFT_REGISTER_INPUT_PINS, 'left'),
    ...packagePins(SHIFT_REGISTER_OUTPUT_PINS, 'right'),
  },
  pinGroups: {
    serial: { pins: [...SHIFT_REGISTER_INPUT_PINS] },
    outputs: { pins: [...SHIFT_REGISTER_OUTPUT_PINS] },
  },
  ports: {
    data: {
      title: '并行输出',
      description: '0–255：直接写入输出锁存，等效于一次 STCP。',
      direction: 'input',
      type: 'number',
    },
    latch: {
      title: '锁存值',
      description: '输出锁存里的字节，Q0 是最低位。',
      direction: 'output',
      type: 'number',
    },
    outputs: {
      title: '回读',
      description: '解网后从 Q0–Q7 读回的字节，用来验证驱动真的到达了网络。',
      direction: 'output',
      type: 'number',
    },
  },
  designatorPrefix: 'U',
});

function tick(api: DeviceBehaviorApi): void {
  const b = api.builder;
  const ds = api.pin('DS').sampleDigital();
  const shcp = api.pin('SHCP').sampleDigital();
  const stcp = api.pin('STCP').sampleDigital();

  const shiftClock = api.state<'bool'>('shiftClock');
  const latchClock = api.state<'bool'>('latchClock');
  const shift = api.state<'u32'>('shift');
  const latch = api.state<'u32'>('latch');
  const updated = api.state<'bool'>('updated');

  const shiftRising = b.bool.and(shcp, b.bool.not(shiftClock.load()));
  const latchRising = b.bool.and(stcp, b.bool.not(latchClock.load()));

  const bit = b.select(ds, b.const('u32', 1), b.const('u32', 0));
  const nextShift = b.select(
    shiftRising,
    b.int.and(b.int.or(b.int.shl(shift.load(), b.const('u32', 1)), bit), b.const('u32', 0xff)),
    shift.load(),
  );
  const nextLatch = b.select(latchRising, nextShift, latch.load());

  shift.store(nextShift);
  latch.store(nextLatch);
  updated.store(b.bool.or(updated.load(), latchRising));
  shiftClock.store(shcp);
  latchClock.store(stcp);

  // One pin-group write for the whole byte.
  api.pinGroup(SHIFT_REGISTER_OUTPUT_PINS).writeDigital(nextLatch);
}

function update(api: DeviceBehaviorApi): void {
  const b = api.builder;
  const outputs = api.pinGroup(SHIFT_REGISTER_OUTPUT_PINS);
  api.topics.publish('latch', [b.convert.intToFloat('f64', api.state<'u32'>('latch').load())]);
  api.topics.publish('outputs', [b.convert.intToFloat('f64', outputs.readDigital())]);
  api.state<'bool'>('updated').store(b.const('bool', false));
}

/** Unified-IR description of the shift register. */
export function createShiftRegisterDescription(): DeviceDescription {
  return {
    name: SHIFT_REGISTER_TYPE,
    pins: {
      ...pinMap(SHIFT_REGISTER_INPUT_PINS, 'input'),
      // `bidirectional` keeps the driver role *and* senses the solved net, which
      // is what `pinGroup(...).readDigital()` folds back into the `outputs` port.
      ...pinMap(SHIFT_REGISTER_OUTPUT_PINS, 'bidirectional', 'signal'),
    },
    states: {
      shiftClock: { type: 'bool', initial: false },
      latchClock: { type: 'bool', initial: false },
      shift: { type: 'u32', initial: 0 },
      latch: { type: 'u32', initial: 0 },
      updated: { type: 'bool', initial: false },
      data: { type: 'u32', initial: 0 },
    },
    powerDomains: [{ name: 'vdd', voltage: LOGIC_VOLTAGE }],
    ports: {
      data: { direction: 'input', type: 'number', title: '并行输出' },
      latch: { direction: 'output', type: 'number', title: '锁存值' },
      outputs: { direction: 'output', type: 'number', title: '回读' },
    },
    behaviors: {
      initialize: (api) => {
        for (const name of SHIFT_REGISTER_INPUT_PINS) {
          api.pin(name).configure('high-z');
          api.pin(name).pull('down');
        }
        for (const name of SHIFT_REGISTER_OUTPUT_PINS) {
          api.pin(name).configure('push-pull');
        }
        api.pinGroup(SHIFT_REGISTER_OUTPUT_PINS).writeDigital(0);
        api.topics.subscribe('data', (handler) => {
          const value = handler.args[0];
          if (value === undefined) return;
          const byte = handler.builder.convert.floatToInt('u32', value as Value<'f64'>);
          handler
            .state<'u32'>('latch')
            .store(handler.builder.int.and(byte, handler.builder.const('u32', 0xff)));
          handler.state<'bool'>('updated').store(handler.builder.const('bool', true));
        });
      },
      tick,
      update,
    },
  };
}
