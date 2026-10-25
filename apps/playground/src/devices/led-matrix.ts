import type { FunctionBuilder, Value } from '@mica-js/ir';
import type { DeviceBehaviorApi, DeviceDescription } from '@mica-js/simulator';
import { LOGIC_VOLTAGE, packagePins, pinMap } from './shared';

/** Column data bus, least significant bit first. */
export const LED_MATRIX_DATA_PINS = Object.freeze(['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7']);

/** Row select bus, least significant bit first. */
export const LED_MATRIX_ROW_PINS = Object.freeze([
  'ROW0',
  'ROW1',
  'ROW2',
  'ROW3',
  'ROW4',
  'ROW5',
  'ROW6',
  'ROW7',
]);

/** Side length of the matrix, in LEDs. */
export const LED_MATRIX_SIZE = 8;

/**
 * 8×8 LED matrix behind a parallel bus (RFC 0004, `api.pinGroup`).
 *
 * The MCU owns the scan: `ROW0`–`ROW7` selects one row (one-hot) and `D0`–`D7`
 * carries that row's eight columns. The matrix is a pure load, so it reads both
 * buses with a pin group instead of driving them:
 *
 * ```ts
 * const rows = api.pinGroup(ROW_PINS).readDigital(); // one u32, ROW0 = bit 0
 * const data = api.pinGroup(DATA_PINS).readDigital(); // one u32, D0 = bit 0
 * ```
 *
 * Each tick latches one row into the framebuffer and publishes it as a
 * `(row, data)` pair, which is what the matrix widget accumulates into a picture.
 * A bus that does not select exactly one row is ignored, so a floating or
 * all-low selection can never scribble over the frame.
 */

/** Package device id of the matrix. */
export const LED_MATRIX_DEVICE = 'lab:led-matrix';

/** IR device type of the matrix. */
export const LED_MATRIX_TYPE = 'led-matrix';

/** Pins block of the device-package description. */
export const LED_MATRIX_PACKAGE = Object.freeze({
  pins: {
    ...packagePins(LED_MATRIX_DATA_PINS, 'left'),
    ...packagePins(LED_MATRIX_ROW_PINS, 'right'),
  },
  pinGroups: {
    data: { pins: [...LED_MATRIX_DATA_PINS] },
    rows: { pins: [...LED_MATRIX_ROW_PINS] },
  },
  ports: {
    row: {
      title: '行号',
      description: '最近一次锁存的行（0–7）。',
      direction: 'output',
      type: 'number',
    },
    data: {
      title: '列数据',
      description: '该行的 8 位列数据，D0 是最低位。',
      direction: 'output',
      type: 'number',
    },
    clear: {
      title: '清屏',
      description: '投递任意布尔值把整帧清零。',
      direction: 'input',
      type: 'boolean',
    },
  },
  designatorPrefix: 'DS',
});

/**
 * Decodes a one-hot row bus into `(index, valid)` without a branch.
 *
 * `index` is the weight of the selected bit and `valid` is "exactly one bit is
 * high"; both come from the same fold, so a two-hot bus is rejected as a whole.
 */
function decodeRow(
  b: FunctionBuilder<readonly []>,
  rows: Value<'u32'>,
): { readonly index: Value<'u32'>; readonly valid: Value<'bool'> } {
  let index = b.const('u32', 0);
  let count = b.const('u32', 0);
  for (let bit = 0; bit < LED_MATRIX_SIZE; bit += 1) {
    const on = b.int.and(b.int.lshr(rows, b.const('u32', bit)), b.const('u32', 1));
    index = b.int.add(index, b.int.mul(on, b.const('u32', bit)));
    count = b.int.add(count, on);
  }
  return { index, valid: b.int.cmp('eq', count, b.const('u32', 1)) };
}

function tick(
  api: DeviceBehaviorApi,
  read: (index: Value<'u32'>) => Value<'u8'>,
  write: (index: Value<'u32'>, value: Value<'u8'>) => void,
): void {
  const b = api.builder;
  const rows = api.pinGroup(LED_MATRIX_ROW_PINS).readDigital();
  const data = api.pinGroup(LED_MATRIX_DATA_PINS).readDigital();
  const { index, valid } = decodeRow(b, rows);

  const safe = b.select(valid, index, b.const('u32', 0));
  const byte = b.int.trunc('u8', data);
  const cleared = api.state<'bool'>('clear').load();
  const next = b.select(cleared, b.const('u8', 0), b.select(valid, byte, read(safe)));
  write(safe, b.select(b.bool.or(valid, cleared), next, read(safe)));
  api.state<'bool'>('clear').store(b.const('bool', false));

  const lastRow = api.state<'u32'>('lastRow');
  const lastData = api.state<'u32'>('lastData');
  const updated = api.state<'bool'>('updated');
  lastRow.store(b.select(valid, index, lastRow.load()));
  lastData.store(b.select(valid, data, lastData.load()));
  updated.store(b.bool.or(updated.load(), b.bool.or(valid, cleared)));
}

function update(api: DeviceBehaviorApi): void {
  const b = api.builder;
  api.topics.publish('row', [b.convert.intToFloat('f64', api.state<'u32'>('lastRow').load())]);
  api.topics.publish('data', [b.convert.intToFloat('f64', api.state<'u32'>('lastData').load())]);
  api.state<'bool'>('updated').store(b.const('bool', false));
}

/** Unified-IR description of the matrix, with its own framebuffer array. */
export function createLedMatrixDescription(): DeviceDescription {
  return {
    name: LED_MATRIX_TYPE,
    pins: {
      ...pinMap(LED_MATRIX_DATA_PINS, 'input'),
      ...pinMap(LED_MATRIX_ROW_PINS, 'input'),
    },
    states: {
      lastRow: { type: 'u32', initial: 0 },
      lastData: { type: 'u32', initial: 0 },
      clear: { type: 'bool', initial: false },
      updated: { type: 'bool', initial: false },
    },
    powerDomains: [{ name: 'vdd', voltage: LOGIC_VOLTAGE }],
    ports: {
      row: { direction: 'output', type: 'number', title: '行号' },
      data: { direction: 'output', type: 'number', title: '列数据' },
      clear: { direction: 'input', type: 'boolean', title: '清屏' },
    },
    kernel: (context) => {
      const frame = context.module.array(
        `led_matrix_${context.deviceId}`,
        'u8',
        Array.from({ length: LED_MATRIX_SIZE }, () => 0),
      );
      return {
        initialize: (api) => {
          for (const name of LED_MATRIX_DATA_PINS) api.pin(name).pull('down');
          for (const name of LED_MATRIX_ROW_PINS) api.pin(name).pull('down');
          api.topics.subscribe('clear', (handler) => {
            handler.state<'bool'>('clear').store(handler.builder.const('bool', true));
          });
        },
        tick: (api) => {
          tick(
            api,
            (index) => api.builder.array.load(frame, index),
            (index, value) => api.builder.array.store(frame, index, value),
          );
        },
        update,
      };
    },
  };
}
