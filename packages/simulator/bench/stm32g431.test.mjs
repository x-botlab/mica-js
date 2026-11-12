import assert from 'node:assert/strict';
import test from 'node:test';
import * as sdk from '../dist/index.js';
import { create, defaults, normalizeOptions, parseArgs, workloadNames } from './stm32g431.mjs';
import { FLASH_BASE, RESET_PC, STACK_TOP } from './stm32g431/constants.mjs';
import { firmwareFor } from './stm32g431/firmware/index.mjs';

for (const workload of workloadNames) {
  test(`STM32 ${workload}: vectors and real Thumb firmware`, () => {
    const firmware = firmwareFor(workload);
    const view = new DataView(
      firmware.bytes.buffer,
      firmware.bytes.byteOffset,
      firmware.bytes.byteLength,
    );
    assert.equal(view.getUint32(0, true), STACK_TOP);
    assert.equal(view.getUint32(4, true), RESET_PC | 1);
    assert.ok(firmware.bytes.length > RESET_PC - FLASH_BASE);
  });

  test(`STM32 ${workload}: throughput, precise and irregular slices match reference`, () => {
    const whole = create(sdk, { workload });
    const precise = create(sdk, { workload, execution: 'precise' });
    const sliced = create(sdk, { workload });
    try {
      assert.deepEqual(whole.progress, { cycles: 0, time: 0 });
      whole.step(2_561);
      precise.step(2_561);
      const expected = whole.verify();
      const reference = precise.verify();
      assert.deepEqual(reference.states, expected.states);
      assert.deepEqual(reference.ram, expected.ram);
      assert.deepEqual(reference.gpioWrites, expected.gpioWrites);
      let remaining = 2_561;
      const chunks = [1, 2, 31, 257, 19, 128, 509];
      for (let index = 0; remaining; index++) {
        const count = Math.min(remaining, chunks[index % chunks.length]);
        sliced.step(count);
        remaining -= count;
      }
      const actual = sliced.verify();
      assert.deepEqual(actual.states, expected.states);
      assert.deepEqual(actual.ram, expected.ram);
      assert.deepEqual(actual.gpioWrites, expected.gpioWrites);
      assert.equal(actual.instructionsIssued, expected.instructionsIssued);
      assert.equal(actual.exceptionEntries, expected.exceptionEntries);
      assert.ok(expected.instructionsIssued > 0);
      assert.deepEqual(whole.verify(), expected, 'Repeated capture does not advance CPU');
    } finally {
      whole.dispose();
      precise.dispose();
      sliced.dispose();
    }
  });
}

test('STM32 wide-memory execution preserves byte-access results', () => {
  const bytes = create(sdk, { workload: 'ram-copy', memoryAccess: 'bytes' });
  const wide = create(sdk, { workload: 'ram-copy', memoryAccess: 'wide' });
  try {
    bytes.step(1_337);
    wide.step(1_337);
    const expected = bytes.verify();
    const actual = wide.verify();
    assert.deepEqual(actual.states, expected.states);
    assert.deepEqual(actual.ram, expected.ram);
    const profile = wide.profile();
    assert.ok(profile.translatedInstructions > 0);
    assert.ok(profile.operations > 0);
    assert.ok((profile.byKind.load32le ?? 0) + (profile.byKind.store32le ?? 0) > 0);
  } finally {
    bytes.dispose();
    wide.dispose();
  }
});

test('STM32 stress exposes large-function, select and wide-access IR', () => {
  const bench = create(sdk, { workload: 'stress', memoryAccess: 'wide' });
  try {
    bench.step(30_000);
    const profile = bench.profile();
    assert.ok(profile.translatedInstructions >= 300);
    assert.ok(profile.sourceCharacters > 100_000);
    assert.equal(profile.selectLabels, 0, 'pure selects fold to ternary expressions');
    assert.ok(profile.booleanChecks > 0);
    assert.ok((profile.byKind.load16le ?? 0) > 0);
    assert.ok((profile.byKind.store16le ?? 0) > 0);
    assert.ok((profile.byKind.and ?? 0) > 0);
    assert.ok((profile.byKind.assert ?? 0) > 0);
  } finally {
    bench.dispose();
  }
});

test('STM32 GPIO firmware reaches the real output channel', () => {
  const bench = create(sdk, { workload: 'gpio-blink' });
  try {
    bench.step(4_096);
    const result = bench.verify();
    assert.ok(result.gpioWrites.some((write) => (write.value & 32) !== 0));
    assert.ok(result.gpioWrites.some((write) => (write.value & 32) === 0));
    for (const write of result.gpioWrites)
      assert.ok(write.time >= 0 && write.time < bench.board.time);
  } finally {
    bench.dispose();
  }
});

test('STM32 SysTick firmware enters handler and returns to thread', () => {
  const bench = create(sdk, { workload: 'systick-irq' });
  try {
    bench.step(4_096);
    const result = bench.verify();
    assert.ok(result.exceptionEntries > 0);
    assert.ok(
      new DataView(result.ram.buffer).getUint32(0, true) > 0,
      'ISR increments SRAM counter',
    );
  } finally {
    bench.dispose();
  }
});

test('STM32 options, run budgets and disposal fail fast', () => {
  assert.deepEqual(normalizeOptions(), defaults);
  for (const options of [
    null,
    [],
    { workload: 'unknown' },
    { cyclePs: 0 },
    { execution: 'unknown' },
    { memoryAccess: 'unknown' },
    { extra: 1 },
  ])
    assert.throws(() => normalizeOptions(options));
  for (const args of [
    ['--unknown'],
    ['--samples=0'],
    ['--cycles=0'],
    ['--cycles=NaN'],
    ['--memory-access=unknown'],
    ['--workload=unknown'],
  ])
    assert.throws(() => parseArgs(args));
  assert.equal(parseArgs(['--smoke']).samples, 1);
  const bench = create(sdk);
  bench.dispose();
  bench.dispose();
  assert.throws(() => bench.step(1), /disposed/);
  assert.throws(() => bench.capture(), /disposed/);
  assert.throws(() => bench.profile(), /disposed/);
});
