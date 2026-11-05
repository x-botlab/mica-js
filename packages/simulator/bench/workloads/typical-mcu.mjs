import { readFile } from 'node:fs/promises';
import { compileDDL } from '@mica-js/ddl';
import { createDeviceBuilder, types } from '../../../device-model/dist/index.js';

export const timing = Object.freeze({
  frequencyHz: 100_000_000,
  cyclePs: 10_000,
  timerCycles: 100_000,
  handoffCycles: 1_000,
  quantumPs: 10_000_000,
  workCycles: 10,
  // Nearest even integer ps, required by the fixture's half-bit sampler.
  bitTimePs: 8_680_556,
  bytesPerPeriod: 11,
});
export const snapshotFields = Object.freeze([
  'workCount',
  'acc',
  'remaining',
  'timerTicks',
  'irqCount',
  'rxCount',
  'rxServiced',
  'rxDropped',
  'gpioCount',
  'gpioValue',
  'pc',
]);
const models = new Map();
const uartModel = await compileDDL(
  await readFile(
    new URL('../../../../tests/conformance/devices/uart/uart.ddl', import.meta.url),
    'utf8',
  ),
);
export { uartModel };
export const byteAt = (ordinal) => (ordinal * 29 + Math.floor(ordinal / 256) * 17 + 85) & 255;
export const iterationsPerPeriod = (busyPercent) => busyPercent * 100;

export function modelFor(busyPercent) {
  if (models.has(busyPercent)) return models.get(busyPercent);
  const d = createDeviceBuilder();
  d.memory({ name: 'code', length: 256 });
  d.memory({ name: 'ram', length: 64, public: true });
  d.memory({ name: 'rxFifo', length: 16 });
  d.memory({ name: 'snapshot', length: snapshotFields.length * 4, public: true });
  for (const name of [...snapshotFields, 'returnPc', 'rxHead', 'rxTail', 'rxQueued']) {
    d.state({
      name,
      type: types.number,
      initial: name === 'remaining' ? iterationsPerPeriod(busyPercent) : 0,
    });
  }
  d.state({ name: 'irqEnabled', type: types.bool, initial: true });
  d.state({ name: 'timerPending', type: types.bool, initial: false });
  d.pin({ name: 'supply' });
  d.pin({ name: 'reference' });
  d.pin({ name: 'gpio', initial: (b) => b.returnValue(b.resistor('reference', 25)) });
  d.channel({ name: 'rxByte', direction: 'input', type: types.number, capacity: 16 });
  for (const name of ['timerAck', 'rxAck', 'gpioEdge'])
    d.channel({ name, direction: 'output', type: types.number, capacity: 16 });
  d.notification({ name: 'snapshotRequest', direction: 'input' });
  d.derived({ name: 'takeIrq', type: types.bool }, (b) =>
    b.returnValue(
      b.and(b.readState('irqEnabled', types.bool), (c) =>
        c.or(c.readState('timerPending', types.bool), (e) =>
          e.greaterThan(e.readState('rxQueued', types.number), 0),
        ),
      ),
    ),
  );
  d.pureFn({ name: 'canResume', params: [], returns: types.bool }, (b) =>
    b.returnValue(
      b.or(b.readDerived('takeIrq', types.bool), (c) =>
        c.greaterThan(c.readState('remaining', types.number), 0),
      ),
    ),
  );
  d.fn({ name: 'enterIrq', params: [] }, (b) => {
    b.writeState('returnPc', b.readState('pc', types.number));
    b.writeState('irqEnabled', false);
    b.redirect(
      b.select(
        types.number,
        b.readState('timerPending', types.bool),
        () => 128,
        () => 129,
      ),
      2 * timing.cyclePs,
    );
  });
  d.state({ name: 'timerStarted', type: types.bool, initial: false });
  d.on({ name: 'timer', sourcePath: ['timerStarted'] }, (b) =>
    b.loop((c) => {
      c.wait(timing.timerCycles * timing.cyclePs);
      c.writeState('timerTicks', c.add(c.readState('timerTicks', types.number), 1));
      c.writeState('timerPending', true);
      if (busyPercent !== 100)
        c.writeState(
          'remaining',
          c.add(c.readState('remaining', types.number), iterationsPerPeriod(busyPercent)),
        );
    }),
  );
  d.fn({ name: 'enqueueRx', params: [{ name: 'value', type: types.number }] }, (b, { value }) => {
    b.writeState('rxCount', b.add(b.readState('rxCount', types.number), 1));
    b.if(
      b.lessThan(b.readState('rxQueued', types.number), 16),
      (c) => {
        c.store8('rxFifo', c.readState('rxTail', types.number), value);
        c.writeState('rxTail', c.bitAnd(c.add(c.readState('rxTail', types.number), 1), 15));
        c.writeState('rxQueued', c.add(c.readState('rxQueued', types.number), 1));
      },
      (c) => c.writeState('rxDropped', c.add(c.readState('rxDropped', types.number), 1)),
    );
  });
  d.start((b) => {
    b.writeState('timerStarted', true);
    b.loop((c) => c.call('enqueueRx', c.receive('rxByte', types.number)));
  });
  d.on({ name: 'captureState', sourcePath: ['snapshotRequest'] }, (b) => {
    snapshotFields.forEach((name, index) =>
      b.store32le('snapshot', index * 4, b.readState(name, types.number)),
    );
  });
  const model = d.finish();
  models.set(busyPercent, model);
  return model;
}

// Synthetic accumulator ISA, not a physical ARM/AVR: WAIT/TEST 1 cycle,
// ALU+RAM work instruction 10 cycles, IRQ entry 2, service 4, IRET 2.
// Work has real scalar ALU and RAM effects; no host callback executes CPU work.
export function translator({ waiting, busyPercent }) {
  return ({ pc, code }, block) => {
    if (code[pc] !== pc) throw new Error(`Invalid typical-MCU firmware at ${pc}`);
    block.instruction({ pc, nextPc: pc === 0 ? 1 : pc + 1 }, (b) => {
      const state = (name) => b.readState(name, types.number);
      const workReady = () => b.greaterThan(state('remaining'), 0);
      if (pc === 0 && waiting === 'wfi') {
        b.elapse(timing.cyclePs);
        b.waitUntil('canResume');
      } else if (pc === 0 || pc === 1) {
        b.redirect(
          b.select(
            types.number,
            workReady(),
            () => 2,
            () => 0,
          ),
          timing.cyclePs,
        );
      } else if (pc === 2) {
        const index = b.bitAnd(state('workCount'), 63);
        const value = b.bitAnd(b.add(b.add(state('acc'), b.load8('ram', index)), 17), 255);
        b.writeState('acc', value);
        b.store8('ram', index, value);
        b.writeState('workCount', b.add(state('workCount'), 1));
        if (busyPercent !== 100) b.writeState('remaining', b.subtract(state('remaining'), 1));
        b.redirect(
          b.select(
            types.number,
            workReady(),
            () => 2,
            () => 0,
          ),
          timing.workCycles * timing.cyclePs,
        );
      } else if (pc === 128) {
        b.writeState('timerPending', false);
        b.writeState('irqCount', b.add(state('irqCount'), 1));
        b.send('timerAck', state('timerTicks'));
        b.if(b.equal(types.number, b.remainder(state('timerTicks'), 10), 0), (c) => {
          const high = c.equal(types.number, c.readState('gpioValue', types.number), 0);
          c.writeState(
            'gpioValue',
            c.select(
              types.number,
              high,
              () => 1,
              () => 0,
            ),
          );
          c.writeState('gpioCount', c.add(c.readState('gpioCount', types.number), 1));
          c.if(
            high,
            (e) => e.writeIntent('gpio', e.resistor('supply', 25)),
            (e) => e.writeIntent('gpio', e.resistor('reference', 25)),
          );
          c.send('gpioEdge', c.readState('gpioValue', types.number));
        });
        b.redirect(130, 4 * timing.cyclePs);
      } else if (pc === 129) {
        b.send('rxAck', b.load8('rxFifo', state('rxHead')));
        b.writeState('rxHead', b.bitAnd(b.add(state('rxHead'), 1), 15));
        b.writeState('rxQueued', b.subtract(state('rxQueued'), 1));
        b.writeState('rxServiced', b.add(state('rxServiced'), 1));
        b.redirect(130, 4 * timing.cyclePs);
      } else if (pc === 130) {
        b.writeState('irqEnabled', true);
        b.redirect(state('returnPc'), 2 * timing.cyclePs);
      } else throw new Error(`Unknown typical-MCU instruction ${pc}`);
    });
    return block.finish();
  };
}

// Incremental independent result oracle. Never called from runUntil or adapter sync.
export function createWorkOracle() {
  const ram = new Uint8Array(64);
  let count = 0;
  let acc = 0;
  return {
    advance(to) {
      if (!Number.isSafeInteger(to) || to < count)
        throw new RangeError('Oracle cannot run backwards');
      while (count < to) {
        const index = count % 64;
        acc = (acc + ram[index] + 17) % 256;
        ram[index] = acc;
        count++;
      }
      return { count, acc, ram: ram.slice() };
    },
  };
}
