// Fixture-level verification on top of the reference Thumb model.
//
// Each workload is executed for a fixed instruction budget and checked against
// an independent restatement of its algorithm (for alu-branch a plain
// JavaScript recurrence, for ram-copy the flash source table, for gpio-blink the
// BSRR set/clear masks). The generator embeds the resulting samples in
// fixtures.mjs as `expected`, so a CPU model can diff against them.

import { createMachine } from './thumb16-check.mjs';

const SRAM_BASE = 0x20000000;

const TABLE_16 = Array.from({ length: 16 }, (_, index) => (0x10203040 + index * 0x01010101) >>> 0);
const TABLE_8 = Array.from({ length: 8 }, (_, index) => (0x11223344 + index * 0x11111111) >>> 0);

export const SAMPLE_OFFSETS = [128, 512, 2048];
export const MAX_INSTRUCTIONS = 24000;

const word = (machine, address) => machine.readSramWord(address);
const register = (snapshot, name) => snapshot.registers[name];

function snapshotAt(machine, name) {
  const snapshot = machine.snapshot();
  snapshot.name = name;
  return snapshot;
}

function ramOf(snapshot, address) {
  const entry = snapshot.ram.find((item) => item.address === address);
  if (!entry) throw new Error(`snapshot has no word for 0x${address.toString(16)}`);
  return entry.value;
}

function aluRecurrence(rounds) {
  let a = 1 >>> 0;
  let b = 0;
  for (let round = 0; round < rounds; round++) {
    for (let iteration = 0; iteration < 24; iteration++) {
      b = (b + a) >>> 0;
      const mixed = ((((a ^ b) >>> 0) << 1) >>> 0) + (b >>> 3);
      a = (a + (mixed & 0x5a5a5a5a)) & 0x5a5a5a5a;
    }
  }
  return { a: a >>> 0, b };
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function checksFor(name, machine, postReset, samples) {
  const failures = [];
  const runCheck = (label, action) => {
    try {
      action();
    } catch (error) {
      failures.push(`${label}: ${error.message}`);
    }
  };

  runCheck('post-reset', () => {
    check(
      postReset.ram.every((entry) => entry.value === 0),
      'scratch window is not cleared',
    );
    check(postReset.gpio.moder === 0x400, `GPIOA MODER is 0x${postReset.gpio.moder.toString(16)}`);
    check(postReset.systick.enable === 0, 'SysTick must stay disabled after reset');
    check(register(postReset, 'sp') === 0x20008000, 'MSP is not 0x20008000');
  });

  const last = samples[samples.length - 1];

  if (name === 'alu-branch') {
    runCheck('alu recurrence', () => {
      const rounds = ramOf(last, SRAM_BASE + 8);
      check(rounds > 0, 'no completed round');
      const expected = aluRecurrence(rounds);
      check(ramOf(last, SRAM_BASE + 0) === expected.a, 'a does not match the recurrence');
      check(ramOf(last, SRAM_BASE + 4) === expected.b, 'b does not match the recurrence');
      check((expected.a & 0x5a5a5a5a) === expected.a, 'a is not masked');
      const marker = ramOf(last, SRAM_BASE + 12);
      if (expected.a !== expected.b) {
        check(marker === (expected.a & 0xffff), 'a != b branch marker is wrong');
      } else {
        check(
          marker === ((expected.b & 0x5a5a5a5a) | expected.a) >>> 0,
          'a == b branch marker is wrong',
        );
        check(ramOf(last, SRAM_BASE + 16) === marker, 'orrs result was not published twice');
        check(ramOf(last, SRAM_BASE + 20) === (rounds * 24) >>> 0, '24 * rounds is wrong');
      }
    });
  }

  if (name === 'ram-copy') {
    runCheck('ram copy contents', () => {
      const passes = ramOf(last, SRAM_BASE + 4);
      check(passes > 0, 'no completed pass');
      for (let index = 0; index < 16; index++) {
        check(
          word(machine, SRAM_BASE + 0x20 + index * 4) === TABLE_16[index],
          `flash copy word ${index} is wrong`,
        );
        check(
          word(machine, SRAM_BASE + 0x60 + index * 4) === TABLE_16[index],
          `SRAM copy word ${index} is wrong`,
        );
      }
      const checksum = TABLE_16.reduce((accumulator, value) => (accumulator ^ value) >>> 0, 0);
      check(ramOf(last, SRAM_BASE + 0) === checksum, 'XOR checksum is wrong');
      check(ramOf(last, SRAM_BASE + 8) === TABLE_16[0], 'published first word is wrong');
      check(ramOf(last, SRAM_BASE + 12) === TABLE_16[15], 'published last byte-copy word is wrong');
      for (let index = 0; index < 64; index++) {
        const source = (TABLE_16[index >> 2] >>> ((index & 3) * 8)) & 0xff;
        check(
          machine.readByte(SRAM_BASE + 0xa0 + index) === source,
          `byte copy offset ${index} is wrong`,
        );
      }
    });
  }

  if (name === 'gpio-blink') {
    runCheck('gpio blink', () => {
      check(ramOf(last, SRAM_BASE + 0) === 0x20, 'PA5 set mask was not published');
      check(ramOf(last, SRAM_BASE + 4) === 0x20, 'ODR while PA5 is set is not 0x20');
      check(ramOf(last, SRAM_BASE + 8) === 0, 'ODR while PA5 is cleared is not 0');
      check(machine.gpio.moder === 0x400, 'MODER lost the PA5 output configuration');
      const toggles = ramOf(last, SRAM_BASE + 0x10);
      check(toggles > 0 && toggles % 2 === 0, 'toggle count must advance by 2 per loop');
      const bsrr = machine.gpioWrites;
      check(bsrr.length >= 4, 'fewer than two complete set/clear pairs were issued');
      for (let index = 0; index < bsrr.length; index += 2) {
        check(bsrr[index].value === 0x20, 'set phase must write 0x20 to BSRR');
        check(bsrr[index].odr === 0x20, 'set phase must raise PA5 in ODR');
        check(bsrr[index + 1].value === 0x00200000, 'clear phase must write 0x00200000 to BSRR');
        check(bsrr[index + 1].odr === 0, 'clear phase must lower PA5 in ODR');
      }
      check(machine.gpio.odr === 0, 'final ODR must be low');
    });
  }

  if (name === 'systick-irq') {
    runCheck('systick interrupts', () => {
      const ticks = ramOf(last, SRAM_BASE + 0);
      const snapshot = ramOf(last, SRAM_BASE + 8);
      check(machine.exceptionCount === ticks, 'tick counter does not match exception count');
      check(ticks > 0, 'no SysTick exception was taken');
      check(snapshot <= ticks, 'thread snapshot is ahead of the tick counter');
      check(ramOf(last, SRAM_BASE + 4) !== 0, 'thread accumulator never advanced');
      const expected = Math.floor(last.instructions / 256);
      check(
        Math.abs(ticks - expected) <= 2,
        `tick count ${ticks} is far from instructions/256 = ${expected}`,
      );
    });
  }

  if (name === 'mixed') {
    runCheck('mixed peripherals', () => {
      const ticks = ramOf(last, SRAM_BASE + 0);
      const snapshot = ramOf(last, SRAM_BASE + 8);
      const passes = ramOf(last, SRAM_BASE + 12);
      const checksum = ramOf(last, SRAM_BASE + 16);
      const odr = ramOf(last, SRAM_BASE + 20);
      const idr = ramOf(last, SRAM_BASE + 24);
      const accumulator = ramOf(last, SRAM_BASE + 4);
      check(ticks > 0, 'no SysTick exception was taken');
      check(snapshot <= ticks, 'thread snapshot is ahead of the tick counter');
      check(passes > 0, 'no completed thread pass');
      check(machine.exceptionCount === ticks, 'tick counter does not match exception count');
      check(machine.gpioWrites.length === ticks, 'handler must write BSRR once per tick');
      check(
        checksum ===
          TABLE_8.reduce((accumulatorValue, value) => (accumulatorValue ^ value) >>> 0, 0),
        'helper checksum is wrong',
      );
      check(odr === 0 || odr === 0x20, `ODR sample 0x${odr.toString(16)} is not a PA5 level`);
      check(idr === odr, 'IDR sample must follow the driven PA5 level');
      check(
        [0x10, 0x20].some(
          (delta) => accumulator === (((snapshot + delta) << 1) & 0x5a5a5a5a) >>> 0,
        ),
        'accumulator does not match the ITE delta formula',
      );
      check(
        ramOf(last, SRAM_BASE + 28) === ((accumulator ^ snapshot) & 0x5a5a5a5a) >>> 0,
        'tick ^ accumulator word is wrong',
      );
      check(machine.itTaken > 0 && machine.itSkipped > 0, 'both ITE paths must execute');
      for (let index = 0; index < 8; index++) {
        check(
          word(machine, SRAM_BASE + 0x20 + index * 4) === TABLE_8[index],
          `mixed copy word ${index} is wrong`,
        );
      }
    });
  }

  if (name === 'stress') {
    runCheck('stress workload', () => {
      const ticks = ramOf(last, SRAM_BASE + 0);
      const passes = ramOf(last, SRAM_BASE + 4);
      const accumulator = ramOf(last, SRAM_BASE + 8);
      const signature = ramOf(last, SRAM_BASE + 32);
      check(ticks > 0, 'no SysTick exception was taken');
      check(machine.exceptionCount === ticks, 'tick counter does not match exception count');
      check(passes > 0, 'no completed pass');
      check(signature === (accumulator ^ ticks) >>> 0, 'signature is not accumulator ^ tick');
      check(ramOf(last, SRAM_BASE + 12) !== 0, 'rolling RAM scratch word never advanced');
      check(machine.gpioWrites.length >= passes * 6, 'fewer than six BSRR writes per pass');
      check(machine.itTaken === 0 && machine.itSkipped === 0, 'stress must not rely on IT state');
      const hi = machine.conditionStats.get(0x8) ?? { taken: 0, skipped: 0 };
      check(hi.taken > 0 && hi.skipped > 0, 'bhi must be both taken and not taken across passes');
      const halfwords = [0x14, 0x16, 0x18, 0x1a].map(
        (offset) =>
          machine.readByte(SRAM_BASE + offset) | (machine.readByte(SRAM_BASE + offset + 1) << 8),
      );
      check(
        halfwords.some((value) => value !== 0),
        'strh never wrote a non-zero halfword',
      );
    });
  }

  if (name === 'thumb32-coverage') {
    runCheck('thumb32 coverage', () => {
      const passes = ramOf(last, SRAM_BASE + 0x0c);
      check(passes > 0, 'no completed pass');
      check(ramOf(last, SRAM_BASE + 0) === 255, 'BL subroutine sum is not 255');
      check(ramOf(last, SRAM_BASE + 4) === 3, 'IT block result is not 3');
      check(ramOf(last, SRAM_BASE + 8) === 0xa5a500a5, 'MOVW/MOVT constant is wrong');
      check(machine.primask === 0, 'CPSIE i did not clear PRIMASK');
    });
  }

  if (failures.length)
    throw new Error(`${name} reference checks failed:\n  ${failures.join('\n  ')}`);
}

export function runReference(fixture) {
  const machine = createMachine(fixture.bytes);
  const postResetTarget = fixture.symbols.workload;
  let postReset = null;
  let guard = 0;
  while (!postReset) {
    machine.step();
    if (machine.regs[15] === postResetTarget) postReset = snapshotAt(machine, 'post-reset');
    if (++guard > 4096) throw new Error(`${fixture.name}: reset never reached the workload entry`);
  }

  const samples = [];
  const targets = SAMPLE_OFFSETS.map((offset) => postReset.instructions + offset);
  let next = 0;
  while (next < targets.length) {
    machine.step();
    if (machine.instructions >= targets[next]) {
      samples.push(snapshotAt(machine, `instructions+${SAMPLE_OFFSETS[next]}`));
      next++;
    }
    if (machine.instructions > MAX_INSTRUCTIONS)
      throw new Error(`${fixture.name}: reference run did not converge`);
  }

  const final = snapshotAt(machine, 'final');
  (() => {
    const start = machine.instructions;
    while (machine.regs[15] !== fixture.symbols.mainLoop) {
      machine.step();
      if (machine.instructions - start > 8192)
        throw new Error(`${fixture.name}: loop start never revisited`);
    }
  })();
  const settled = snapshotAt(machine, 'settled');
  checksFor(fixture.name, machine, postReset, [settled]);

  return {
    postReset,
    samples,
    final,
    settled,
    cycleDependent:
      fixture.name === 'systick-irq' || fixture.name === 'mixed' || fixture.name === 'stress',
    instructionBudget: SAMPLE_OFFSETS[SAMPLE_OFFSETS.length - 1],
  };
}

export { TABLE_16, TABLE_8, aluRecurrence };
