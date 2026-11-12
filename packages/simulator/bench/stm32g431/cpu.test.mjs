import assert from 'node:assert/strict';
import test from 'node:test';
import { compileBody, compileComputation } from '../../../compiler/dist/index.js';
import {
  createDeviceBuilder,
  createJitBlockBuilder,
  types,
} from '../../../device-model/dist/index.js';
import {
  EXC_RETURN,
  FLASH_BASE,
  FLASH_SIZE,
  RESET_PC,
  SRAM_BASE,
  SRAM_SIZE,
  STACK_TOP,
} from './constants.mjs';
import {
  CYCLE_TABLE,
  ThumbDecodeError,
  cpuInitialState,
  createThumbTranslator,
  decodeThumb,
  registerCpu,
} from './cpu.mjs';

const CYCLE_PS = 10;

// ---------------------------------------------------------------------------
// fixtures: flash image, byte-composing stub bus, mock execution host
// ---------------------------------------------------------------------------

/**
 * Test bus: every access is composed from byte accesses, like the default
 * `bytes` bus mode. Reads dispatch on the address range; the peripheral range
 * answers the vector-table base so exception entry can be exercised.
 */
function createStubBus() {
  const num = (builder, value) => builder.constant(types.number, value);
  const assemble = (builder, memory, base, address, width) => {
    let value = num(builder, 0);
    for (let index = 0; index < width; index++) {
      const offset = builder.add(
        builder.subtract(address, num(builder, base)),
        num(builder, index),
      );
      value = builder.add(
        value,
        builder.multiply(builder.load8(memory, offset), num(builder, 2 ** (index * 8))),
      );
    }
    return value;
  };
  return {
    emitLoad(b, address, width) {
      return b.select(
        types.number,
        b.lessThan(address, num(b, SRAM_BASE)),
        (code) => assemble(code, 'code', FLASH_BASE, address, width),
        (inner) =>
          inner.select(
            types.number,
            inner.lessThan(address, num(inner, 0xe0000000)),
            (ram) => assemble(ram, 'ram', SRAM_BASE, address, width),
            (peripheral) => peripheral.constant(types.number, FLASH_BASE),
          ),
      );
    },
    emitStore(b, address, value, width) {
      for (let index = 0; index < width; index++) {
        b.store8(
          'ram',
          b.add(b.subtract(address, num(b, SRAM_BASE)), num(b, index)),
          b.bitAnd(b.shiftRightUnsigned(value, num(b, index * 8)), num(b, 0xff)),
        );
      }
    },
  };
}

function createCpuModel({ cyclePs = CYCLE_PS } = {}) {
  const d = createDeviceBuilder();
  d.memory({ name: 'code', length: FLASH_SIZE });
  d.memory({ name: 'ram', length: SRAM_SIZE, public: true });
  registerCpu(d, { cyclePs, bus: createStubBus() });
  d.state({ name: 'irqPending', type: types.bool, initial: false });
  return d.finish();
}

const MODEL = createCpuModel();

function image(halfwords, entry = RESET_PC) {
  const code = new Uint8Array(FLASH_SIZE);
  let offset = entry - FLASH_BASE;
  for (const halfword of halfwords) {
    code[offset] = halfword & 0xff;
    code[offset + 1] = (halfword >> 8) & 0xff;
    offset += 2;
  }
  return code;
}

function createMachine(code, { initial = {}, translator = {} } = {}) {
  const states = new Map(Object.entries({ ...cpuInitialState, ...initial }));
  const memories = { code: Uint8Array.from(code), ram: new Uint8Array(SRAM_SIZE) };
  const read = (memory, offset, width) => {
    const bytes = memories[memory];
    if (!bytes) throw new Error(`unknown memory ${memory}`);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + width > bytes.length)
      throw new RangeError(`${memory} access out of bounds at ${offset}`);
    let value = 0;
    for (let index = 0; index < width; index++) value += bytes[offset + index] * 2 ** (index * 8);
    return value;
  };
  const write = (memory, offset, width, value) => {
    const bytes = memories[memory];
    if (!bytes) throw new Error(`unknown memory ${memory}`);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + width > bytes.length)
      throw new RangeError(`${memory} access out of bounds at ${offset}`);
    let rest = value >>> 0;
    for (let index = 0; index < width; index++) {
      bytes[offset + index] = rest & 0xff;
      rest = Math.floor(rest / 256);
    }
  };
  const nameOf = (memory) => (typeof memory === 'string' ? memory : memory?.name);
  const host = {
    read: (_resource, name) => {
      if (!states.has(name)) throw new Error(`unknown state ${name}`);
      return states.get(name);
    },
    write: (name, value) => {
      if (!states.has(name)) throw new Error(`unknown state ${name}`);
      states.set(name, value);
    },
    load: (kind, memory, offset) =>
      read(nameOf(memory), offset, kind === 'load8' ? 1 : kind === 'load16le' ? 2 : 4),
    store: (kind, memory, offset, value) =>
      write(nameOf(memory), offset, kind === 'store8' ? 1 : kind === 'store16le' ? 2 : 4, value),
  };
  const translate = createThumbTranslator({
    cyclePs: CYCLE_PS,
    bus: createStubBus(),
    ...translator,
  });
  const machine = {
    states,
    memories,
    host,
    time: 0,
    instructions: 0,
    get pc() {
      return states.get('pc');
    },
    word(address) {
      return read('ram', address - SRAM_BASE, 4);
    },
    /** Translate the block at pc and run its first instruction to completion. */
    step() {
      const pc = states.get('pc');
      const block = translate(
        { pc, code: memories.code },
        createJitBlockBuilder({ device: MODEL }),
      );
      const instruction = block.instructions[0];
      assert.equal(instruction.pc, pc, 'translation must start at the current pc');
      states.set('pc', instruction.nextPc);
      machine.runBody(compileBody(instruction.body)(host));
      machine.instructions++;
    },
    runBody(generator) {
      let step = generator.next();
      while (!step.done) {
        const signal = step.value;
        if (signal.kind === 'elapse') {
          machine.time += signal.duration;
          step = generator.next();
        } else if (signal.kind === 'redirect') {
          states.set('pc', signal.pc);
          machine.time += signal.delay;
          generator.return();
          return;
        } else if (signal.kind === 'stop') {
          generator.return();
          return;
        } else throw new Error(`unexpected signal ${signal.kind}`);
      }
    },
    /** Invoke a declared zero-parameter function such as enterIrq. */
    invoke(name) {
      const declaration = MODEL.declarations.find((entry) => entry.name === name);
      assert(declaration, `missing declaration ${name}`);
      machine.runBody(compileBody(declaration.body)(host));
    },
    derived(name) {
      const declaration = MODEL.declarations.find((entry) => entry.name === name);
      assert(declaration, `missing derived ${name}`);
      return compileComputation(declaration.value)(host);
    },
  };
  return machine;
}
// ---------------------------------------------------------------------------
// decoding
// ---------------------------------------------------------------------------

test('decodeThumb names instructions and marks control flow', () => {
  const code = image([0x2200, 0x1d00, 0x4288, 0xd1fb, 0x4770, 0xb406, 0x4c08]);
  const first = decodeThumb(code, RESET_PC);
  assert.equal(first.text, 'movs r2, #0');
  assert.equal(first.nextPc, RESET_PC + 2);
  assert.equal(first.cycles, CYCLE_TABLE.alu);
  assert.equal(first.terminal, false);
  assert.equal(decodeThumb(code, RESET_PC + 2).text, 'adds r0, r0, #4');
  assert.equal(decodeThumb(code, RESET_PC + 4).text, 'cmp r0, r1');
  const branch = decodeThumb(code, RESET_PC + 6);
  assert.equal(branch.text, 'bne 0x08000100');
  assert.equal(branch.terminal, 'branch');
  assert.equal(decodeThumb(code, RESET_PC + 8).text, 'bx lr');
  assert.equal(decodeThumb(code, RESET_PC + 8).terminal, 'indirect');
  assert.equal(decodeThumb(code, RESET_PC + 10).text, 'push {r1, r2}');
  assert.equal(decodeThumb(code, RESET_PC + 10).cycles, 2 + CYCLE_TABLE.pushPopOverhead);
  assert.equal(decodeThumb(code, RESET_PC + 12).text, 'ldr r4, [pc, #32]');
});

test('decodeThumb reports Thumb-32 forms and IT membership', () => {
  const code = image([0xf240, 0x01a5, 0xf2ca, 0x51a5, 0xbf1c, 0x460b, 0x189b]);
  assert.equal(decodeThumb(code, RESET_PC).text, 'movw r1, #165');
  assert.equal(decodeThumb(code, RESET_PC).size, 4);
  assert.equal(decodeThumb(code, RESET_PC).nextPc, RESET_PC + 4);
  assert.equal(decodeThumb(code, RESET_PC + 4).text, 'movt r1, #42405');
  const it = decodeThumb(code, RESET_PC + 8);
  assert.equal(it.kind, 'it');
  assert.equal(it.itstate, 0x1c);
  const first = decodeThumb(code, RESET_PC + 10);
  assert.equal(first.mnemonic, 'mov');
  assert.equal(first.cond, 0x1);
  assert.deepEqual(first.itstate, { after: 0x18, start: RESET_PC + 8 });
  const second = decodeThumb(code, RESET_PC + 12);
  assert.equal(second.mnemonic, 'adds');
  assert.equal(second.cond, 0x1);
  assert.equal(second.itstate.after, 0);
});

test('unknown encodings raise a diagnostic error with pc and opcode', () => {
  const cases = [0xdf00, 0xde00, 0xbe00, 0x4787];
  for (const opcode of cases) {
    const code = image([opcode]);
    assert.throws(
      () => decodeThumb(code, RESET_PC),
      (error) =>
        error instanceof ThumbDecodeError &&
        error.pc === RESET_PC &&
        error.opcode === opcode &&
        error.message.includes(`0x${opcode.toString(16)}`) &&
        error.message.includes('0x08000100'),
      `expected a diagnostic for 0x${opcode.toString(16)}`,
    );
  }
});

test('createThumbTranslator validates its options', () => {
  assert.throws(() => createThumbTranslator({ cyclePs: 0, bus: createStubBus() }), RangeError);
  assert.throws(
    () => createThumbTranslator({ cyclePs: 10, blockSize: 9, bus: createStubBus() }),
    RangeError,
  );
  assert.throws(
    () => createThumbTranslator({ cyclePs: 10, memoryAccess: 'words', bus: createStubBus() }),
    RangeError,
  );
  assert.throws(() => createThumbTranslator({ cyclePs: 10, bus: {} }), TypeError);
});

// ---------------------------------------------------------------------------
// ALU, NZCV and shifts
// ---------------------------------------------------------------------------

test('adds/subs maintain NZCV across the 32-bit boundaries', () => {
  const machine = createMachine(image([0x2000, 0x3801, 0x3001]));
  machine.step();
  assert.equal(machine.states.get('r0'), 0);
  assert.equal(machine.states.get('z'), true);
  machine.step();
  assert.equal(machine.states.get('r0'), 0xffffffff);
  assert.equal(machine.states.get('n'), true);
  assert.equal(machine.states.get('z'), false);
  assert.equal(machine.states.get('c'), false, '0 - 1 borrows');
  assert.equal(machine.states.get('v'), false);
  machine.step();
  assert.equal(machine.states.get('r0'), 0);
  assert.equal(machine.states.get('c'), true, 'carry out of 0xffffffff + 1');
  assert.equal(machine.states.get('z'), true);
  assert.equal(machine.states.get('n'), false);
  assert.equal(machine.states.get('v'), false);
});

test('signed overflow sets V without carry', () => {
  const machine = createMachine(image([0x3001]), { initial: { r0: 0x7fffffff } });
  machine.step();
  assert.equal(machine.states.get('r0'), 0x80000000);
  assert.equal(machine.states.get('v'), true);
  assert.equal(machine.states.get('c'), false);
  assert.equal(machine.states.get('n'), true);
  assert.equal(machine.states.get('z'), false);
});

test('register add, subtract and compare keep 32-bit wrap', () => {
  const machine = createMachine(image([0x1852, 0x1a40, 0x4291]), {
    initial: { r1: 0xffffffff, r2: 1 },
  });
  machine.step();
  assert.equal(machine.states.get('r2'), 0, '0xffffffff + 1 wraps');
  assert.equal(machine.states.get('c'), true);
  machine.states.set('r0', 0xffffffff);
  machine.states.set('r1', 1);
  machine.step();
  assert.equal(machine.states.get('r0'), 0xfffffffe);
  assert.equal(machine.states.get('c'), true, 'no borrow');
  assert.equal(machine.states.get('n'), true);
  machine.states.set('r1', 1);
  machine.states.set('r2', 2);
  machine.step();
  assert.equal(machine.states.get('r1'), 1, 'cmp leaves registers alone');
  assert.equal(machine.states.get('c'), false, '1 - 2 borrows');
  assert.equal(machine.states.get('n'), true);
});

test('shift immediates set carry, including the LSL direction and the 32-bit encode', () => {
  const lslLow = createMachine(image([0x0076]), { initial: { r6: 1 } });
  lslLow.step();
  assert.equal(lslLow.states.get('r6'), 2);
  assert.equal(lslLow.states.get('c'), false, 'lsl #1 shifts out bit 31, not bit 0');
  const lslHigh = createMachine(image([0x0076]), { initial: { r6: 0x80000000 } });
  lslHigh.step();
  assert.equal(lslHigh.states.get('r6'), 0);
  assert.equal(lslHigh.states.get('c'), true, 'the top bit lands in carry');
  const lslBit31 = createMachine(image([0x0076]), { initial: { r6: 0x40000000 } });
  lslBit31.step();
  assert.equal(lslBit31.states.get('c'), false);
  const lsl2 = createMachine(image([0x00b6]), { initial: { r6: 0x40000000 } });
  lsl2.step();
  assert.equal(lsl2.states.get('r6'), 0);
  assert.equal(lsl2.states.get('c'), true, 'lsl #2 shifts out bit 30');
  const lslZero = createMachine(image([0x0036]), { initial: { r6: 0x12345678, c: true } });
  lslZero.step();
  assert.equal(lslZero.states.get('r6'), 0x12345678, 'lsl #0 is a move');
  assert.equal(lslZero.states.get('c'), true, 'lsl #0 keeps carry');
  const machine = createMachine(image([0x08d7]), { initial: { r2: 0x80000000 } });
  machine.step();
  assert.equal(machine.states.get('r7'), 0x10000000);
  assert.equal(machine.states.get('c'), false, 'lsr #3 shifts out bit 2');
  const lsr32 = createMachine(image([0x0813]), { initial: { r2: 0x80000000 } });
  lsr32.step();
  assert.equal(lsr32.states.get('r3'), 0, 'lsr #32 clears the register');
  assert.equal(lsr32.states.get('c'), true);
  const asr32 = createMachine(image([0x1013]), { initial: { r2: 0x80000000 } });
  asr32.step();
  assert.equal(asr32.states.get('r3'), 0xffffffff, 'asr #32 replicates the sign');
  assert.equal(asr32.states.get('c'), true);
  const asr = createMachine(image([0x1213]), { initial: { r2: 0xf0000000 } });
  asr.step();
  assert.equal(asr.states.get('r3'), 0xfff00000);
  assert.equal(asr.states.get('n'), true);
});

test('shift by register uses the correct carry source and keeps C at zero', () => {
  const lsl = { r0: 0x80000001, r1: 1 };
  const lslTaken = createMachine(image([0x4088]), { initial: lsl });
  lslTaken.step();
  assert.equal(lslTaken.states.get('r0'), 2, 'lsls r0, r1 rotates the low word up');
  assert.equal(lslTaken.states.get('c'), true, 'lsl by register shifts out bit 31');
  const lslLow = createMachine(image([0x4088]), { initial: { r0: 1, r1: 1 } });
  lslLow.step();
  assert.equal(lslLow.states.get('r0'), 2);
  assert.equal(lslLow.states.get('c'), false);
  const lslZero = createMachine(image([0x4088]), { initial: { r0: 8, r1: 0, c: true } });
  lslZero.step();
  assert.equal(lslZero.states.get('r0'), 8);
  assert.equal(lslZero.states.get('c'), true, 'shift by zero keeps carry');
  const lsl32 = createMachine(image([0x4088]), { initial: { r0: 1, r1: 32 } });
  lsl32.step();
  assert.equal(lsl32.states.get('r0'), 0);
  assert.equal(lsl32.states.get('c'), true, 'lsl #32 carries out bit 0');
  const lsr = createMachine(image([0x40c8]), { initial: { r0: 0x80000000, r1: 4 } });
  lsr.step();
  assert.equal(lsr.states.get('r0'), 0x08000000);
  assert.equal(lsr.states.get('c'), false, 'lsr by register shifts out bit 3');
});
test('logical data processing sets N and Z but leaves C and V', () => {
  const machine = createMachine(image([0x4026, 0x4316, 0x4208, 0x4348, 0x4248]), {
    initial: { r6: 0xff00, r4: 0x0f0f, r2: 0x00f0, c: true, v: true },
  });
  machine.step();
  assert.equal(machine.states.get('r6'), 0x0f00);
  assert.equal(machine.states.get('c'), true);
  assert.equal(machine.states.get('v'), true);
  machine.step();
  assert.equal(machine.states.get('r6'), 0x0ff0);
  machine.states.set('r0', 0x0ff0);
  machine.states.set('r1', 0x00ff);
  machine.step();
  assert.equal(machine.states.get('r0'), 0x0ff0, 'tst only updates flags');
  assert.equal(machine.states.get('z'), false);
  assert.equal(machine.states.get('c'), true);
  machine.states.set('r0', 0xffffffff);
  machine.states.set('r1', 0xffffffff);
  machine.step();
  assert.equal(machine.states.get('r0'), 1, '32-bit mul keeps the low word exact');
  assert.equal(machine.states.get('c'), true, 'mul leaves C alone');
  machine.states.set('r1', 0);
  machine.step();
  assert.equal(machine.states.get('r0'), 0, 'rsbs negates the operand');
  assert.equal(machine.states.get('z'), true);
  assert.equal(machine.states.get('c'), true, '0 - 0 does not borrow');
});
// ---------------------------------------------------------------------------
// memory, stack and PC-relative addressing
// ---------------------------------------------------------------------------

test('word, byte, halfword and signed accesses go through the bus', () => {
  const base = SRAM_BASE + 0x40;
  const word = createMachine(image([0x6008, 0x680a]), { initial: { r1: base } });
  word.states.set('r0', 0x12345678);
  word.step();
  assert.equal(word.word(base), 0x12345678);
  assert.equal(word.time, 2 * CYCLE_PS, 'store costs two cycles');
  word.step();
  assert.equal(word.states.get('r2'), 0x12345678);
  const byte = createMachine(image([0x700c, 0x5ccd]), { initial: { r1: base, r4: 0x99, r3: 2 } });
  byte.step();
  assert.equal(byte.memories.ram[0x40], 0x99);
  byte.step();
  assert.equal(byte.states.get('r5'), 0);
  const half = createMachine(image([0x8041, 0x8842]), {
    initial: { r0: SRAM_BASE + 0x80, r1: 0x1234aaaa },
  });
  half.step();
  assert.equal(half.memories.ram[0x82] | (half.memories.ram[0x83] << 8), 0xaaaa);
  half.step();
  assert.equal(half.states.get('r2'), 0xaaaa);
  const signedByte = createMachine(image([0x560e]), { initial: { r1: base } });
  signedByte.memories.ram[0x40] = 0x80;
  signedByte.step();
  assert.equal(signedByte.states.get('r6'), 0xffffff80, 'ldrsb sign-extends');
  const signedHalf = createMachine(image([0x5e0f]), { initial: { r1: base } });
  signedHalf.memories.ram[0x40] = 0x00;
  signedHalf.memories.ram[0x41] = 0x80;
  signedHalf.step();
  assert.equal(signedHalf.states.get('r7'), 0xffff8000, 'ldrsh sign-extends');
});

test('literal, SP-relative, ADR and stack-pointer arithmetic', () => {
  const stack = STACK_TOP - 0x20;
  const machine = createMachine(
    image([
      0x4801, 0xe003, 0xbf00, 0xbf00, 0x1234, 0x5678, 0xa001, 0xab01, 0x9101, 0x9a01, 0xb002,
      0xb082,
    ]),
    { initial: { r13: stack } },
  );
  machine.step();
  assert.equal(machine.states.get('r0'), 0x56781234, 'ldr literal is word aligned pc + 4 + offset');
  machine.step();
  assert.equal(machine.pc, RESET_PC + 12, 'branch skips the literal pool');
  machine.step();
  assert.equal(machine.states.get('r0'), RESET_PC + 20, 'adr r0, #4 uses the aligned pc');
  machine.step();
  assert.equal(machine.states.get('r3'), stack + 4, 'add r3, sp, #4');
  machine.states.set('r1', 0xdeadbeef);
  machine.step();
  assert.equal(machine.word(stack + 4), 0xdeadbeef);
  machine.step();
  assert.equal(machine.states.get('r2'), 0xdeadbeef);
  machine.step();
  assert.equal(machine.states.get('r13'), stack + 8);
  machine.step();
  assert.equal(machine.states.get('r13'), stack);
});
test('push and pop keep the architectural stack order and cost registers + 1', () => {
  const machine = createMachine(image([0xb406, 0xbc18, 0xb500, 0xbd00]), {
    initial: { r1: 0x11111111, r2: 0x22222222, r14: RESET_PC + 0x21, r13: STACK_TOP },
  });
  machine.step();
  assert.equal(machine.states.get('r13'), STACK_TOP - 8);
  assert.equal(machine.word(STACK_TOP - 8), 0x11111111, 'lowest register at the lowest address');
  assert.equal(machine.word(STACK_TOP - 4), 0x22222222);
  assert.equal(machine.time, 3 * CYCLE_PS);
  machine.step();
  assert.equal(machine.states.get('r3'), 0x11111111);
  assert.equal(machine.states.get('r4'), 0x22222222);
  assert.equal(machine.states.get('r13'), STACK_TOP);
  assert.equal(machine.time, 6 * CYCLE_PS);
  machine.step();
  assert.equal(machine.word(STACK_TOP - 4), RESET_PC + 0x21, 'push {lr}');
  assert.equal(machine.states.get('r13'), STACK_TOP - 4);
  machine.step();
  assert.equal(machine.states.get('r13'), STACK_TOP, 'pop {pc} restores the stack');
  assert.equal(machine.pc, RESET_PC + 0x20, 'pop {pc} branches to the loaded address');
  assert.equal(machine.time, 10 * CYCLE_PS, 'pop {pc} costs registers + 1');
});

test('ldm and stm copy a block and write the base back', () => {
  const source = SRAM_BASE + 0x100;
  const machine = createMachine(image([0xc006, 0xc806]), {
    initial: { r0: source, r1: 0x11111111, r2: 0x22222222 },
  });
  machine.step();
  assert.equal(machine.word(source), 0x11111111);
  assert.equal(machine.word(source + 4), 0x22222222);
  assert.equal(machine.states.get('r0'), source + 8, 'stm writes back the base');
  assert.equal(machine.time, 4 * CYCLE_PS, 'two registers plus two cycles');
  machine.states.set('r0', source);
  machine.states.set('r1', 0);
  machine.states.set('r2', 0);
  machine.step();
  assert.equal(machine.states.get('r1'), 0x11111111);
  assert.equal(machine.states.get('r2'), 0x22222222);
  assert.equal(machine.states.get('r0'), source + 8);
});
// ---------------------------------------------------------------------------
// control flow
// ---------------------------------------------------------------------------

test('conditional branches select the target and charge 3/1 cycles', () => {
  const taken = createMachine(image([0xd1fe]), { initial: { z: false } });
  taken.step();
  assert.equal(taken.pc, RESET_PC, 'bne to itself');
  assert.equal(taken.time, CYCLE_TABLE.takenBranch * CYCLE_PS);
  const notTaken = createMachine(image([0xd1fe]), { initial: { z: true } });
  notTaken.step();
  assert.equal(notTaken.pc, RESET_PC + 2, 'not-taken falls through');
  assert.equal(notTaken.time, CYCLE_TABLE.notTaken * CYCLE_PS);
  const fixed = createMachine(image([0xd1fe]), {
    initial: { z: true },
    translator: { exactBranchCycles: false },
  });
  fixed.step();
  assert.equal(fixed.pc, RESET_PC + 2);
  assert.equal(
    fixed.time,
    CYCLE_TABLE.takenBranch * CYCLE_PS,
    'the fixed-cost variant overcharges',
  );
});

test('every condition code matches the NZCV lattice', () => {
  const cases = [
    { cond: 0x0, name: 'beq', taken: { z: true }, untaken: { z: false } },
    { cond: 0x1, name: 'bne', taken: { z: false }, untaken: { z: true } },
    { cond: 0x2, name: 'bcs', taken: { c: true }, untaken: { c: false } },
    { cond: 0x3, name: 'bcc', taken: { c: false }, untaken: { c: true } },
    { cond: 0x4, name: 'bmi', taken: { n: true }, untaken: { n: false } },
    { cond: 0x5, name: 'bpl', taken: { n: false }, untaken: { n: true } },
    { cond: 0x6, name: 'bvs', taken: { v: true }, untaken: { v: false } },
    { cond: 0x7, name: 'bvc', taken: { v: false }, untaken: { v: true } },
    { cond: 0x8, name: 'bhi', taken: { c: true, z: false }, untaken: { c: true, z: true } },
    { cond: 0x9, name: 'bls', taken: { c: false, z: false }, untaken: { c: true, z: false } },
    { cond: 0xa, name: 'bge', taken: { n: true, v: true }, untaken: { n: true, v: false } },
    { cond: 0xb, name: 'blt', taken: { n: true, v: false }, untaken: { n: true, v: true } },
    {
      cond: 0xc,
      name: 'bgt',
      taken: { n: true, v: true, z: false },
      untaken: { n: true, v: true, z: true },
    },
    {
      cond: 0xd,
      name: 'ble',
      taken: { n: true, v: false, z: false },
      untaken: { n: false, v: false, z: false },
    },
  ];
  for (const entry of cases) {
    const opcode = 0xd000 | (entry.cond << 8) | 0xfe;
    const taken = createMachine(image([opcode]), { initial: entry.taken });
    taken.step();
    assert.equal(taken.pc, RESET_PC, `${entry.name} must be taken`);
    const untaken = createMachine(image([opcode]), { initial: entry.untaken });
    untaken.step();
    assert.equal(untaken.pc, RESET_PC + 2, `${entry.name} must fall through`);
  }
});

test('unconditional branch and CBZ/CBNZ move the program counter', () => {
  const loop = createMachine(image([0xe7fe]));
  loop.step();
  assert.equal(loop.pc, RESET_PC, 'b . loops on itself');
  assert.equal(loop.time, CYCLE_TABLE.takenBranch * CYCLE_PS);
  const zero = createMachine(image([0xb108]), { initial: { r0: 0 } });
  zero.step();
  assert.equal(zero.pc, RESET_PC + 6, 'cbz takes pc + 4 + imm');
  const nonZero = createMachine(image([0xb908]), { initial: { r0: 3 } });
  nonZero.step();
  assert.equal(nonZero.pc, RESET_PC + 6, 'cbnz taken');
  const skip = createMachine(image([0xb908]), { initial: { r0: 0 } });
  skip.step();
  assert.equal(skip.pc, RESET_PC + 2, 'cbnz not taken');
  assert.equal(skip.time, CYCLE_TABLE.notTaken * CYCLE_PS);
}); // ---------------------------------------------------------------------------
// IT blocks, Thumb-32, system registers and exceptions
// ---------------------------------------------------------------------------

test('IT blocks execute or skip both instructions and advance ITSTATE', () => {
  const taken = createMachine(image([0xbf04, 0x2100, 0x3201]), {
    initial: { z: true, n: true, r1: 0x9, r2: 0 },
  });
  taken.step();
  assert.equal(taken.states.get('itstate'), 0x04, 'it eq stores cond:T');
  assert.equal(taken.time, CYCLE_PS);
  taken.step();
  assert.equal(taken.states.get('r1'), 0, 'the first slot executes');
  assert.equal(taken.states.get('itstate'), 0x08, 'the first slot advances');
  assert.equal(taken.states.get('n'), false, 'an executed instruction updates flags');
  assert.equal(taken.states.get('z'), true);
  taken.step();
  assert.equal(taken.states.get('r2'), 1, 'the second slot executes');
  assert.equal(taken.states.get('itstate'), 0, 'the block ends');
  const skipped = createMachine(image([0xbf04, 0x2100, 0x3201]), {
    initial: { z: false, n: true, r1: 0x9, r2: 0 },
  });
  skipped.step();
  skipped.step();
  assert.equal(skipped.states.get('r1'), 0x9, 'a skipped instruction keeps the register');
  assert.equal(skipped.states.get('n'), true, 'a skipped instruction keeps the flags');
  assert.equal(skipped.states.get('itstate'), 0x08, 'a skipped instruction still advances ITSTATE');
  assert.equal(skipped.time, 2 * CYCLE_PS, 'a skipped instruction costs one cycle');
  skipped.step();
  assert.equal(skipped.states.get('r2'), 0);
  assert.equal(skipped.states.get('itstate'), 0);
  assert.equal(skipped.time, 3 * CYCLE_PS);
});
test('Thumb-32 MOVW, MOVT and BL execute', () => {
  const machine = createMachine(
    image([0xf240, 0x01a5, 0xf2ca, 0x51a5, 0xf000, 0xf804, 0xbf00, 0xbf00, 0xbf00, 0xbf00, 0x4770]),
  );
  machine.step();
  assert.equal(machine.states.get('r1'), 0x00a5);
  assert.equal(machine.time, CYCLE_PS);
  machine.step();
  assert.equal(machine.states.get('r1'), 0xa5a500a5);
  assert.equal(machine.time, 2 * CYCLE_PS);
  machine.step();
  assert.equal(machine.states.get('r14'), (RESET_PC + 12) | 1, 'BL links the next instruction');
  assert.equal(machine.pc, RESET_PC + 20, 'BL target is pc + 4 + offset');
  assert.equal(machine.time, 5 * CYCLE_PS);
});

test('CPSID/CPSIE drive primask and takeIrq honours the mask', () => {
  const machine = createMachine(image([0xb672, 0xb662]), { initial: { irqPending: true } });
  assert.equal(machine.derived('takeIrq'), true);
  machine.step();
  assert.equal(machine.states.get('primask'), 1);
  assert.equal(machine.derived('takeIrq'), false, 'primask masks the interrupt');
  machine.step();
  assert.equal(machine.states.get('primask'), 0);
  assert.equal(machine.derived('takeIrq'), true);
  machine.states.set('ipsr', 15);
  assert.equal(machine.derived('takeIrq'), false, 'ipsr masks the interrupt');
  machine.states.set('ipsr', 0);
  machine.states.set('irqPending', false);
  assert.equal(machine.derived('takeIrq'), false);
});

test('exception entry stacks the hardware frame and bx EXC_RETURN restores it', () => {
  const handler = RESET_PC + 0x40;
  const returnAddress = RESET_PC + 2;
  const code = image([0xbf00]);
  const at = (address, value) => {
    for (let index = 0; index < 4; index++)
      code[address - FLASH_BASE + index] = (value >>> (index * 8)) & 0xff;
  };
  at(FLASH_BASE + 15 * 4, handler | 1);
  code[handler - FLASH_BASE] = 0x70;
  code[handler - FLASH_BASE + 1] = 0x47;
  const machine = createMachine(code, {
    initial: {
      r0: 0x11,
      r1: 0x22,
      r2: 0x33,
      r3: 0x44,
      r12: 0x55,
      r14: 0x66,
      n: true,
      c: true,
      itstate: 0x18,
      r13: STACK_TOP,
      irqPending: true,
      pc: returnAddress,
    },
  });
  machine.invoke('enterIrq');
  assert.equal(machine.pc, handler, 'the vector table selects the handler');
  assert.equal(machine.time, CYCLE_TABLE.exception * CYCLE_PS);
  assert.equal(machine.states.get('r13'), STACK_TOP - 32);
  assert.equal(machine.states.get('r14'), EXC_RETURN);
  assert.equal(machine.states.get('ipsr'), 15);
  assert.equal(machine.states.get('itstate'), 0, 'entry clears ITSTATE');
  assert.equal(machine.states.get('irqPending'), false);
  const frame = STACK_TOP - 32;
  assert.deepEqual(
    [0, 1, 2, 3].map((index) => machine.word(frame + index * 4)),
    [0x11, 0x22, 0x33, 0x44],
  );
  assert.equal(machine.word(frame + 16), 0x55, 'r12');
  assert.equal(machine.word(frame + 20), 0x66, 'lr');
  assert.equal(machine.word(frame + 24), returnAddress, 'the interrupted pc');
  const xpsr = machine.word(frame + 28);
  assert.equal((xpsr >>> 31) & 1, 1, 'N');
  assert.equal((xpsr >>> 30) & 1, 0, 'Z');
  assert.equal((xpsr >>> 29) & 1, 1, 'C');
  assert.equal((xpsr >>> 28) & 1, 0, 'V');
  assert.equal((xpsr >>> 24) & 1, 1, 'thumb bit');
  assert.equal((xpsr >>> 10) & 0x3f, (0x18 >>> 2) & 0x3f, 'IT[7:2]');
  assert.equal((xpsr >>> 25) & 3, 0x18 & 3, 'IT[1:0]');
  assert.equal(xpsr & 0x1ff, 0, 'the stacked IPSR belongs to the interrupted thread');
  machine.step();
  assert.equal(machine.pc, returnAddress, 'the stacked pc resumes the thread');
  assert.equal(machine.states.get('r13'), STACK_TOP, 'the frame is popped');
  assert.equal(machine.states.get('ipsr'), 0);
  assert.equal(machine.states.get('itstate'), 0x18, 'ITSTATE is restored');
  assert.equal(machine.states.get('n'), true);
  assert.equal(machine.states.get('c'), true);
  assert.equal(machine.states.get('r14'), 0x66);
  assert.equal(machine.time, 2 * CYCLE_TABLE.exception * CYCLE_PS);
});

test('instructions never increment a statistics counter', () => {
  const translate = createThumbTranslator({ cyclePs: CYCLE_PS, bus: createStubBus() });
  const code = image([0x1852, 0x680a]);
  const block = translate({ pc: RESET_PC, code }, createJitBlockBuilder({ device: MODEL }));
  const written = new Set();
  const visit = (region) => {
    for (const operation of region.operations) {
      if (operation.kind === 'write') written.add(operation.name);
      for (const value of Object.values(operation)) {
        if (!value || typeof value !== 'object') continue;
        if (Array.isArray(value.operations)) visit(value);
        else if (value.body?.operations) visit(value.body);
      }
    }
  };
  for (const instruction of block.instructions) visit(instruction.body);
  for (const name of written)
    assert(
      /^r\d+$/.test(name) ||
        ['n', 'z', 'c', 'v', 'itstate', 'primask', 'ipsr', 'irqPending'].includes(name),
      `unexpected state write ${name}`,
    );
  assert(block.instructions.every((instruction) => instruction.body.operations.length > 0));
});
// ---------------------------------------------------------------------------
// firmware coverage
// ---------------------------------------------------------------------------

/** Walks the linear code from `entry`, following direct branches only. */
function reachable(code, entry) {
  const seen = new Map();
  const pending = [entry];
  while (pending.length) {
    let pc = pending.pop();
    while (!seen.has(pc)) {
      const insn = decodeThumb(code, pc);
      seen.set(pc, insn);
      if (insn.terminal === 'branch') {
        pending.push(insn.target);
        if (insn.kind === 'b' || insn.kind === 'bl') break;
      } else if (insn.terminal === 'indirect') break;
      pc = insn.nextPc;
    }
  }
  return seen;
}

const CONDITION_SUFFIXES = [
  'eq',
  'ne',
  'cs',
  'hs',
  'cc',
  'lo',
  'mi',
  'pl',
  'vs',
  'vc',
  'hi',
  'ls',
  'ge',
  'lt',
  'gt',
  'le',
  'al',
];

/** Mnemonics the decoder emits, plus the assembler spellings the fixtures use. */
const BASE_MNEMONICS = new Set([
  'adc',
  'add',
  'adr',
  'and',
  'asr',
  'b',
  'bic',
  'bl',
  'blx',
  'bx',
  'cbz',
  'cbnz',
  'cmp',
  'cmn',
  'cpsid',
  'cpsie',
  'eor',
  'it',
  'ldm',
  'ldr',
  'ldrb',
  'ldrh',
  'ldrsb',
  'ldrsh',
  'lsl',
  'lsr',
  'mov',
  'movt',
  'movw',
  'mul',
  'mvn',
  'nop',
  'orr',
  'pop',
  'push',
  'rev',
  'rev16',
  'revsh',
  'ror',
  'rsb',
  'sbc',
  'sev',
  'stm',
  'str',
  'strb',
  'strh',
  'sub',
  'sxtb',
  'sxth',
  'tst',
  'uxtb',
  'uxth',
  'wfe',
  'wfi',
  'yield',
]);

/** Collapses `movne`/`movs`/`itt` spelling differences between the two disassemblers. */
function normalizeMnemonic(text) {
  const name = text.trim().split(/\s+/)[0].toLowerCase();
  if (/^it[et]*$/.test(name)) return 'it';
  const canonical = (candidate) => {
    if (BASE_MNEMONICS.has(candidate)) return candidate;
    if (candidate.endsWith('s') && BASE_MNEMONICS.has(candidate.slice(0, -1)))
      return candidate.slice(0, -1);
    return null;
  };
  const direct = canonical(name);
  if (direct) return direct;
  for (const suffix of CONDITION_SUFFIXES)
    if (name.length > suffix.length && name.endsWith(suffix)) {
      const stripped = canonical(name.slice(0, -suffix.length));
      if (stripped) return stripped;
    }
  return name;
}
function parseDisassembly(lines) {
  const map = new Map();
  for (const line of lines) {
    const match = /^([0-9a-f]{8})\s+([0-9a-f]+)\s+(\S+)/.exec(line);
    if (!match) continue;
    map.set(parseInt(match[1], 16), {
      halfwords: match[2].length / 4,
      mnemonic: normalizeMnemonic(match[3]),
    });
  }
  return map;
}

test('every reachable fixture instruction decodes and matches the assembler', async () => {
  const fixtures = await import('./firmware/index.mjs');
  for (const name of fixtures.fixtureNames) {
    const firmware = fixtures.firmwareFor(name);
    const code = new Uint8Array(FLASH_SIZE);
    code.set(firmware.bytes);
    const disassembly = parseDisassembly(firmware.disassembly);
    const decoded = new Map();
    for (const pc of [firmware.resetPc, firmware.vectorTable.systick & ~1])
      for (const [address, insn] of reachable(code, pc)) decoded.set(address, insn);
    assert.ok(decoded.size > 20, `${name} should cover the reset path and the vector handler`);
    for (const [address, insn] of decoded) {
      const reference = disassembly.get(address);
      assert.ok(
        reference,
        `${name}: 0x${address.toString(16)} decodes outside the fixture disassembly`,
      );
      assert.equal(insn.size / 2, reference.halfwords, `${name}: 0x${address.toString(16)} size`);
      // `lsls Rd, Rm, #0` and `movs Rd, Rm` are the same encoding.
      const aliased =
        (insn.mnemonic === 'lsls' && reference.mnemonic === 'mov') ||
        (insn.mnemonic === 'movs' && reference.mnemonic === 'lsl');
      if (!aliased)
        assert.equal(
          normalizeMnemonic(insn.mnemonic),
          reference.mnemonic,
          `${name}: 0x${address.toString(16)} ${insn.text}`,
        );
    }
    for (const symbol of ['reset', 'workload', 'mainLoop', 'systickHandler'])
      if (firmware.symbols[symbol] !== undefined)
        assert.ok(
          decoded.has(firmware.symbols[symbol]),
          `${name}: symbol ${symbol} at 0x${firmware.symbols[symbol].toString(16)} must decode`,
        );
  }
});
test('high-register operations move, compare and branch without touching flags', () => {
  const move = createMachine(image([0x4601]), { initial: { r0: 0x12345678, n: true } });
  move.step();
  assert.equal(move.states.get('r1'), 0x12345678);
  assert.equal(move.states.get('n'), true, 'mov does not update flags');
  const add = createMachine(image([0x4411]), { initial: { r1: 1, r2: 2 } });
  add.step();
  assert.equal(add.states.get('r1'), 3);
  assert.equal(add.states.get('z'), false, 'add (high) does not update flags');
  const compare = createMachine(image([0x4540]), { initial: { r0: 1, r8: 2, c: true } });
  compare.step();
  assert.equal(compare.states.get('r0'), 1);
  assert.equal(compare.states.get('c'), false, 'cmp (high) updates flags');
  const branch = createMachine(image([0x46bf]), { initial: { r7: (RESET_PC + 0x21) | 1 } });
  branch.step();
  assert.equal(branch.pc, RESET_PC + 0x20, 'mov pc, rm branches on the even address');
  assert.equal(branch.time, CYCLE_TABLE.takenBranch * CYCLE_PS);
  const link = createMachine(image([0x47c0]), { initial: { r8: (RESET_PC + 0x31) | 1 } });
  link.step();
  assert.equal(link.states.get('r14'), (RESET_PC + 2) | 1, 'blx rm links');
  assert.equal(link.pc, RESET_PC + 0x30);
});
