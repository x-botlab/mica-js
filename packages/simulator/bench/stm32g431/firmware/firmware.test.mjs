import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  FLASH_BASE,
  FLASH_SIZE,
  RESET_PC,
  SRAM_SIZE,
  STACK_TOP,
  VECTOR_TABLE_ADDRESS,
  firmwareFor,
  fixtureNames,
  workloadNames,
} from './index.mjs';
import { runReference } from './tools/reference-run.mjs';

const NARROW_MNEMONICS = new Set([
  'addne',
  'adds',
  'ands',
  'asrs',
  'b',
  'beq',
  'bhi',
  'bne',
  'bx',
  'cmp',
  'cpsid',
  'cpsie',
  'eors',
  'ite',
  'itt',
  'ldr',
  'ldrb',
  'ldrh',
  'lsls',
  'lsrs',
  'mov',
  'moveq',
  'movne',
  'movs',
  'nop',
  'orrs',
  'pop',
  'push',
  'str',
  'strb',
  'strh',
  'subs',
]);
const WIDE_MNEMONICS = new Set(['movw', 'movt', 'bl']);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const parseDisassembly = (lines) =>
  lines.map((line) => {
    const match = /^([0-9a-f]{8}) {2}([0-9a-f]+) {2}(.*)$/.exec(line);
    assert.ok(match, `malformed disassembly line: ${line}`);
    // objdump prints each 16-bit halfword big-endian; flash stores it little-endian.
    const halfwords = match[2].match(/[0-9a-f]{4}/g);
    const bytes = halfwords.map((halfword) => halfword.slice(2) + halfword.slice(0, 2)).join('');
    return {
      address: Number.parseInt(match[1], 16),
      bytes,
      text: match[3],
      mnemonic: /^[a-z]+/.exec(match[3])[0],
      width: bytes.length / 2,
    };
  });

const compact = (snapshot) => ({
  instructions: snapshot.instructions,
  cycles: snapshot.cycles,
  pc: snapshot.pc,
  sp: snapshot.registers.sp,
  ram: snapshot.ram.map((entry) => entry.value),
  registers: snapshot.registers,
  gpio: snapshot.gpio,
  systick: {
    enable: snapshot.systick.enable,
    tickint: snapshot.systick.tickint,
    clksource: snapshot.systick.clksource,
    load: snapshot.systick.load,
    val: snapshot.systick.val,
    countflag: snapshot.systick.countflag,
  },
  systickExceptions: snapshot.systickExceptions,
});

test('exports the benchmark workloads and the coverage fixture', () => {
  assert.deepEqual(workloadNames, [
    'alu-branch',
    'ram-copy',
    'gpio-blink',
    'systick-irq',
    'mixed',
    'stress',
  ]);
  assert.deepEqual(fixtureNames, [...workloadNames, 'thumb32-coverage']);
});

for (const name of fixtureNames) {
  const fixture = firmwareFor(name);

  test(`${name}: image and metadata invariants`, () => {
    assert.equal(fixture.size, fixture.bytes.length);
    assert.equal(fixture.sha256, sha256(fixture.bytes));
    assert.equal(fixture.resetPc, RESET_PC);
    assert.equal(fixture.initialSp, STACK_TOP);
    assert.equal(fixture.vectorTable.address, VECTOR_TABLE_ADDRESS);
    assert.equal(fixture.vectorTable.initialSp, STACK_TOP);
    assert.equal(fixture.vectorTable.reset, RESET_PC | 1);
    assert.equal(fixture.vectorTable.systick, fixture.symbols.systickHandler | 1);
    assert.ok(fixture.bytes.length <= FLASH_SIZE);
    assert.ok(fixture.bytes.length > RESET_PC - FLASH_BASE);
    assert.equal(fixture.memory.flash.base, FLASH_BASE);
    assert.equal(fixture.memory.sram.size, SRAM_SIZE);

    for (const index of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
      assert.equal(
        fixture.vectorTable.entries[index],
        0,
        `vector ${index} must stay unused so faults are visible`,
      );
    }

    for (const [key, address] of Object.entries(fixture.symbols)) {
      assert.equal(address % 2, 0, `${key} must be an instruction address`);
      assert.ok(
        address >= RESET_PC && address < FLASH_BASE + fixture.size,
        `${key} (0x${address.toString(16)}) outside the image`,
      );
    }
    assert.ok(fixture.symbols.workload < fixture.symbols.mainLoop);
    assert.ok(fixture.symbols.reset < fixture.symbols.workload);
    assert.equal(fixture.symbols.systickHandler, fixture.vectorTable.systick & ~1);
  });

  test(`${name}: disassembly matches the tracked bytes`, () => {
    const instructions = parseDisassembly(fixture.disassembly);
    assert.ok(instructions.length > 20);
    assert.equal(instructions[0].address, RESET_PC);

    let narrow = 0;
    let wide = 0;
    for (const instruction of instructions) {
      const offset = instruction.address - FLASH_BASE;
      assert.ok(offset >= 0 && offset + instruction.width <= fixture.bytes.length);
      const actual = [...fixture.bytes.subarray(offset, offset + instruction.width)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      assert.equal(actual, instruction.bytes, `bytes at 0x${instruction.address.toString(16)}`);
      if (instruction.width === 2) {
        narrow++;
        assert.ok(
          NARROW_MNEMONICS.has(instruction.mnemonic),
          `unexpected 16-bit mnemonic ${instruction.mnemonic}`,
        );
      } else {
        wide++;
        assert.equal(instruction.width, 4, 'only 16-bit and 32-bit Thumb encodings exist');
        assert.ok(
          WIDE_MNEMONICS.has(instruction.mnemonic),
          `32-bit ${instruction.mnemonic} is outside the declared main benchmark set`,
        );
      }
    }

    assert.equal(narrow, fixture.instructions.narrow);
    assert.equal(wide, fixture.instructions.wide);
    assert.equal(narrow + wide, fixture.instructions.total);
    const observedWide = [
      ...new Set(
        instructions
          .filter((instruction) => instruction.width === 4)
          .map((instruction) => instruction.mnemonic),
      ),
    ].sort();
    assert.deepEqual(fixture.instructions.wideMnemonics, observedWide);
    assert.deepEqual(
      Object.keys(fixture.instructions.mnemonics).sort(),
      [...new Set(instructions.filter((i) => i.width === 2).map((i) => i.mnemonic))].sort(),
    );
    for (const [mnemonic, count] of Object.entries(fixture.instructions.mnemonics)) {
      assert.equal(
        instructions.filter(
          (instruction) => instruction.width === 2 && instruction.mnemonic === mnemonic,
        ).length,
        count,
      );
    }

    const startAddresses = new Set(instructions.map((instruction) => instruction.address));
    for (const [key, address] of Object.entries(fixture.symbols)) {
      assert.ok(startAddresses.has(address), `${key} does not point at an instruction`);
    }
  });

  test(`${name}: reference model reproduces the tracked expected state`, () => {
    const result = runReference(fixture);
    assert.deepEqual(compact(result.postReset), fixture.expected.postReset);
    assert.deepEqual(compact(result.settled), fixture.expected.settled);
    assert.equal(result.samples.length, fixture.expected.samples.length);
    result.samples.forEach((sample, index) => {
      assert.deepEqual(compact(sample), fixture.expected.samples[index]);
    });
    assert.equal(
      fixture.expected.cycleDependent,
      name === 'systick-irq' || name === 'mixed' || name === 'stress',
    );
    if (!fixture.expected.cycleDependent) {
      for (const sample of fixture.expected.samples) {
        assert.equal(sample.systickExceptions, 0);
      }
    } else {
      assert.ok(fixture.expected.settled.systickExceptions > 0);
    }
  });
}

test('firmwareFor returns independent byte copies and rejects unknown names', () => {
  const first = firmwareFor('alu-branch');
  const second = firmwareFor('alu-branch');
  assert.notEqual(first.bytes, second.bytes);
  first.bytes.fill(0);
  assert.equal(sha256(second.bytes), second.sha256);
  assert.throws(() => firmwareFor('nope'), /unknown STM32G431 firmware/);
});
