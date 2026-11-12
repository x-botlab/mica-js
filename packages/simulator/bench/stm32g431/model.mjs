import { createDeviceBuilder, types } from '../../../device-model/dist/index.js';
import { registerCpu, cpuInitialState } from './cpu.mjs';
import * as bus from './bus.mjs';
import { registerBus, busInitialState } from './bus.mjs';
import { DEFAULT_CYCLE_PS, FLASH_SIZE, SRAM_SIZE } from './constants.mjs';

const models = new Map();

export function modelFor({ cyclePs = DEFAULT_CYCLE_PS } = {}) {
  if (!Number.isSafeInteger(cyclePs) || cyclePs < 1 || cyclePs > 1_000_000)
    throw new RangeError('cyclePs must be an integer in [1, 1000000]');
  if (models.has(cyclePs)) return models.get(cyclePs);
  const d = createDeviceBuilder();
  d.property({ name: 'firmware', type: types.bytes });
  d.memory({ name: 'code', length: FLASH_SIZE });
  d.memory({ name: 'ram', length: SRAM_SIZE, public: true });
  registerCpu(d, { cyclePs, bus });
  registerBus(d, { cyclePs });
  const fields = Object.entries({ ...cpuInitialState, ...busInitialState }).map(
    ([name, initial]) => ({ name, boolean: typeof initial === 'boolean' }),
  );
  fields.push({ name: 'pa5Level', boolean: false, sample: true });
  d.memory({ name: 'snapshot', length: fields.length * 8, public: true });
  d.notification({ name: 'snapshotRequest', direction: 'input' });
  d.on({ name: 'captureState', sourcePath: ['snapshotRequest'] }, (b) => {
    for (const [index, field] of fields.entries()) {
      let value;
      if (field.sample) {
        const level = b.field(b.readSample('pa5'), 'level');
        value = b.select(
          types.number,
          b.equal(types.logic, level, types.logic.members.high),
          () => 1,
          (c) =>
            c.select(
              types.number,
              c.equal(types.logic, level, types.logic.members.low),
              () => 0,
              () => 2,
            ),
        );
      } else {
        value = field.boolean
          ? b.select(
              types.number,
              b.readState(field.name, types.bool),
              () => 1,
              () => 0,
            )
          : b.readState(field.name, types.number);
      }
      b.store32le('snapshot', index * 8, value);
      b.store32le('snapshot', index * 8 + 4, b.floor(b.divide(value, 0x100000000)));
    }
  });
  const result = Object.freeze({ model: d.finish(), fields: Object.freeze(fields) });
  models.set(cyclePs, result);
  return result;
}

export function readSnapshot(bytes, fields) {
  const copy = Uint8Array.from(bytes);
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  return Object.fromEntries(
    fields.map((field, index) => {
      const value =
        view.getUint32(index * 8, true) + view.getInt32(index * 8 + 4, true) * 0x100000000;
      return [field.name, field.boolean ? Boolean(value) : value];
    }),
  );
}
