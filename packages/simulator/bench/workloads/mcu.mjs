import { createDeviceBuilder, types } from '../../../device-model/dist/index.js';

export const workloadNames = Object.freeze(['alu-branch', 'ram', 'gpio-timer-irq']);
export const instructionCycles = Object.freeze({
  ADDI: 2,
  XORI: 2,
  JMP: 1,
  IRET: 2,
  LD: 2,
  ST: 2,
  OUT: 2,
});

// Benchmark-only synthetic derivative of the minimal accumulator fixture, NOT ARM/AVR.
// Each instruction has a known cycle cost; IRQ entry costs two additional cycles.
// 11 ADDI(2), 12 XORI(2), 30 JMP(1), 40 IRET(2), 60 LD(2), 61 ST(2), 62 OUT(2).
// LD captures data before elapse and commits afterward, exercising continuation slicing.
export function firmwareFor(workload) {
  const code = new Uint8Array(256);
  if (workload === 'alu-branch') code.set([0x11, 3, 0x12, 0xa5, 0x30, 0]);
  else if (workload === 'ram')
    code.set([0x11, 1, 0x61, 16, 0x12, 0x33, 0x60, 16, 0x12, 0x5a, 0x61, 17, 0x30, 0]);
  else if (workload === 'gpio-timer-irq') {
    code.set([0x12, 1, 0x62, 0x30, 0]);
    code.set([0x60, 255, 0x11, 1, 0x61, 255, 0x40], 128);
  } else throw new RangeError(`Unknown synthetic MCU workload: ${workload}`);
  return code;
}

export function buildSyntheticMcu({ workload, cyclePs, irqPeriodCycles }) {
  const d = createDeviceBuilder();
  d.property({ name: 'firmware', type: types.bytes });
  d.memory({ name: 'code', length: 256 });
  d.memory({ name: 'ram', length: 256, public: true });
  d.memory({ name: 'snapshot', length: 12, public: true });
  for (const name of ['pc', 'acc', 'returnPc', 'gpioValue', 'timerTicks'])
    d.state({ name, type: types.number, initial: 0 });
  for (const name of ['irqPending', 'wakeLatched'])
    d.state({ name, type: types.bool, initial: false });
  d.state({ name: 'irqEnabled', type: types.bool, initial: true });
  for (const name of ['irq', 'wake', 'snapshotRequest'])
    d.notification({ name, direction: 'input' });
  d.on({ name: 'latchIrq', sourcePath: ['irq'] }, (b) => b.writeState('irqPending', true));
  d.on({ name: 'latchWake', sourcePath: ['wake'] }, (b) => b.writeState('wakeLatched', true));
  d.derived({ name: 'takeIrq', type: types.bool }, (b) => {
    b.returnValue(
      b.and(b.readState('irqEnabled', types.bool), (c) => c.readState('irqPending', types.bool)),
    );
  });
  d.fn({ name: 'enterIrq', params: [] }, (b) => {
    b.writeState('returnPc', b.readState('pc', types.number));
    b.writeState('irqPending', false);
    b.writeState('irqEnabled', false);
    b.redirect(128, 2 * cyclePs);
  });
  d.fn({ name: 'returnIrq', params: [] }, (b) => {
    b.writeState('irqEnabled', true);
    b.redirect(b.readState('returnPc', types.number), 2 * cyclePs);
  });
  const io = workload === 'gpio-timer-irq';
  if (io) {
    d.pin({ name: 'supply' });
    d.pin({ name: 'reference' });
    d.pin({
      name: 'gpio',
      initial: (b) => b.returnValue(b.resistor('reference', 25)),
    });
    d.pin({ name: 'sense', low: 0.8, high: 2.0 });
    d.start((b) => {
      b.loop((c) => {
        c.wait(irqPeriodCycles * cyclePs);
        c.writeState('timerTicks', c.add(c.readState('timerTicks', types.number), 1));
        c.writeState('irqPending', true);
      });
    });
  }
  // This process runs ONLY when verify() requests one untimed capture, never per opcode.
  d.on({ name: 'captureState', sourcePath: ['snapshotRequest'] }, (b) => {
    for (const [offset, name] of ['pc', 'acc', 'returnPc'].entries())
      b.store8('snapshot', offset, b.readState(name, types.number));
    for (const [offset, name] of ['irqPending', 'irqEnabled'].entries()) {
      b.store8(
        'snapshot',
        offset + 3,
        b.select(
          types.number,
          b.readState(name, types.bool),
          () => 1,
          () => 0,
        ),
      );
    }
    b.store8('snapshot', 5, b.readState('gpioValue', types.number));
    b.store32le('snapshot', 8, b.readState('timerTicks', types.number));
    if (io) {
      const sample = b.readSample('sense');
      for (const [offset, level] of ['high', 'low'].entries())
        b.store8(
          'snapshot',
          offset + 6,
          b.select(
            types.number,
            b.equal(types.logic, b.field(sample, 'level'), types.logic.members[level]),
            () => 1,
            () => 0,
          ),
        );
    }
  });
  return d.finish();
}

export function syntheticTranslator(cyclePs) {
  return ({ pc, code }, block) => {
    let address = pc;
    // Two-instruction blocks retain real minimal-fixture JIT cache/boundary behavior.
    for (let count = 0; count < 2; count++) {
      const opcode = code[address];
      const operand = code[(address + 1) & 255];
      const width = [0x11, 0x12, 0x30, 0x60, 0x61].includes(opcode) ? 2 : 1;
      const nextPc = (address + width) & 255;
      block.instruction({ pc: address, nextPc }, (b) => {
        switch (opcode) {
          case 0x11:
            b.writeState('acc', b.bitAnd(b.add(b.readState('acc', types.number), operand), 255));
            b.elapse(2 * cyclePs);
            break;
          case 0x12:
            b.writeState('acc', b.bitXor(b.readState('acc', types.number), operand));
            b.elapse(2 * cyclePs);
            break;
          case 0x30:
            b.redirect(operand, cyclePs);
            break;
          case 0x40:
            b.call('returnIrq');
            break;
          case 0x60: {
            const value = b.load8('ram', operand);
            b.elapse(2 * cyclePs);
            b.writeState('acc', value);
            break;
          }
          case 0x61:
            b.store8('ram', operand, b.readState('acc', types.number));
            b.elapse(2 * cyclePs);
            break;
          case 0x62: {
            const value = b.bitAnd(b.readState('acc', types.number), 1);
            b.writeState('gpioValue', value);
            b.if(
              b.equal(types.number, value, 1),
              (c) => c.writeIntent('gpio', c.resistor('supply', 25)),
              (c) => c.writeIntent('gpio', c.resistor('reference', 25)),
            );
            b.elapse(2 * cyclePs);
            break;
          }
          default:
            throw new Error(`Invalid synthetic MCU opcode ${opcode} at ${address}`);
        }
      });
      if (opcode === 0x30 || opcode === 0x40) break;
      address = nextPc;
    }
    return block.finish();
  };
}

// Independent small interpreter, used only after timing. It never executes SDK/JIT IR.
// At target, timer events run, but CPU instructions/continuations do not start/resume.
export function createReference({ workload, cyclePs, irqPeriodCycles }) {
  const code = firmwareFor(workload);
  const state = {
    pc: 0,
    acc: 0,
    returnPc: 0,
    irqPending: false,
    irqEnabled: true,
    gpio: 0,
    timerTicks: 0,
    ram: new Uint8Array(256),
    instructionsIssued: 0,
  };
  let at = 0;
  let target = 0;
  let due = null;
  let loaded = null;
  let instructionCycleCostIssued = 0;
  let irqEntries = 0;
  const period = irqPeriodCycles * cyclePs;
  let timer = workload === 'gpio-timer-irq' ? period : Infinity;
  return {
    advance(to) {
      if (to < target) throw new RangeError('Reference cannot run backwards');
      target = to;
      for (;;) {
        if (timer <= to && (due === null ? timer <= at : timer <= due)) {
          state.timerTicks++;
          state.irqPending = true;
          timer += period;
          continue;
        }
        if (due !== null) {
          if (due >= to) break;
          at = due;
          due = null;
          if (loaded !== null) {
            state.acc = loaded;
            loaded = null;
          }
          continue;
        }
        if (at >= to) break;
        if (state.irqPending && state.irqEnabled) {
          state.returnPc = state.pc;
          state.irqPending = false;
          state.irqEnabled = false;
          state.pc = 128;
          irqEntries++;
          due = at + 2 * cyclePs;
          continue;
        }
        const opcode = code[state.pc];
        const operand = code[(state.pc + 1) & 255];
        state.instructionsIssued++;
        instructionCycleCostIssued += opcode === 0x30 ? 1 : 2;
        switch (opcode) {
          case 0x11:
            state.acc = (state.acc + operand) & 255;
            state.pc = (state.pc + 2) & 255;
            due = at + 2 * cyclePs;
            break;
          case 0x12:
            state.acc ^= operand;
            state.pc = (state.pc + 2) & 255;
            due = at + 2 * cyclePs;
            break;
          case 0x30:
            state.pc = operand;
            due = at + cyclePs;
            break;
          case 0x40:
            state.irqEnabled = true;
            state.pc = state.returnPc;
            due = at + 2 * cyclePs;
            break;
          case 0x60:
            loaded = state.ram[operand];
            state.pc = (state.pc + 2) & 255;
            due = at + 2 * cyclePs;
            break;
          case 0x61:
            state.ram[operand] = state.acc;
            state.pc = (state.pc + 2) & 255;
            due = at + 2 * cyclePs;
            break;
          case 0x62:
            state.gpio = state.acc & 1;
            state.pc = (state.pc + 1) & 255;
            due = at + 2 * cyclePs;
            break;
          default:
            throw new Error(`Reference invalid opcode ${opcode}`);
        }
      }
      const terminalRemainingCycles = due === null ? 0 : (due - to) / cyclePs;
      return {
        ...state,
        instructionCycleCostIssued,
        irqEntries,
        terminalRemainingCycles,
        elapsedBusyCycles: instructionCycleCostIssued + irqEntries * 2 - terminalRemainingCycles,
      };
    },
  };
}
