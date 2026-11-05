import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as sdk from '../dist/index.js';
import { create, defaults, normalizeOptions, parseArgs, timing } from './typical-mcu.mjs';
import { createWorkOracle } from './workloads/typical-mcu.mjs';

const run = (options, chunks) => {
  const bench = create(sdk, options);
  try {
    for (const count of chunks) {
      bench.step(count);
      bench.verify();
    }
    return bench.verify();
  } finally {
    bench.dispose();
  }
};

for (const execution of ['precise', 'throughput']) {
  test(`${execution}: WFI and annotated polling preserve useful work, timer IRQ and real UART`, () => {
    const options = { execution, busyPercent: 1, cycles: 112_000 };
    const wfi = run({ ...options, waiting: 'wfi' }, [9_000, 91_000, 12_000]);
    const poll = run({ ...options, waiting: 'poll' }, [9_000, 91_000, 12_000]);
    for (const result of [wfi, poll]) {
      assert.equal(result.state.workCount, 200);
      assert.equal(result.state.remaining, 0);
      assert.equal(result.state.timerTicks, 1);
      assert.equal(result.state.irqCount, 1);
      assert.equal(result.uart.received, 12);
      assert.equal(result.uart.serviced, 12);
      assert.equal(result.uart.fifoCapacity, 16);
      assert.equal(result.uart.dropped, 0);
      assert.equal(result.uart.framingErrors, 0);
      assert.equal(result.uart.unknownSamples, 0);
      assert.ok(result.maxTimerIrqResponsePs <= timing.quantumPs + 12 * timing.cyclePs);
    }
    assert.equal(wfi.state.acc, poll.state.acc);
  });
}

for (const busyPercent of [1, 10, 30, 100]) {
  test(`${busyPercent}% configured work uses real ALU/RAM instructions in both execution modes`, () => {
    const precise = run(
      { execution: 'precise', waiting: 'wfi', busyPercent, cycles: 35_000 },
      [35_000],
    );
    const throughput = run(
      { execution: 'throughput', waiting: 'wfi', busyPercent, cycles: 35_000 },
      [35_000],
    );
    for (const result of [precise, throughput]) {
      assert.equal(result.configuredUsefulCyclesPerPeriod, busyPercent * 1_000);
      assert.equal(result.usefulCyclesIssued, result.state.workCount * 10);
      assert.ok(result.state.workCount > 0);
      assert.equal(result.uart.received, 4);
      assert.equal(result.uart.serviced, 3, 'fourth frame awaits fixed 350us handoff');
    }
    if (busyPercent !== 100) {
      assert.equal(precise.state.workCount, busyPercent * 100);
      assert.equal(throughput.state.workCount, precise.state.workCount);
      assert.equal(throughput.state.acc, precise.state.acc);
    }
  });
}

test('fixed external UART delivery schedule is independent of arbitrary host slicing', () => {
  const options = { execution: 'precise', waiting: 'wfi', cycles: 112_000 };
  const whole = run(options, [112_000]);
  const sliced = run(options, [1, 2, 97, 12_345, 99_555]);
  assert.deepEqual(sliced, whole);
});

for (const uartPeriodMs of [1, 10]) {
  for (const execution of ['precise', 'throughput']) {
    for (const waiting of ['wfi', 'poll']) {
      test(`${execution}/${waiting}: ${uartPeriodMs}ms UART bursts preserve exact sliced results`, () => {
        const periodCycles = uartPeriodMs * timing.timerCycles;
        const cycles = periodCycles + 102_000;
        const options = { execution, waiting, uartPeriodMs, cycles };
        const targets = [
          1,
          3,
          100,
          9_000,
          10_000,
          periodCycles - 1,
          periodCycles,
          periodCycles + 1,
          periodCycles + 1_000,
          periodCycles + 10_000,
          periodCycles + 100_000,
          cycles,
        ];
        const chunks = targets.map((target, index) => target - (targets[index - 1] ?? 0));
        const whole = run(options, [cycles]);
        const sliced = run(options, chunks);
        assert.deepEqual(sliced, whole);
        assert.equal(whole.uart.received, 22, 'two complete real 11-byte UART bursts');
        assert.equal(whole.uart.serviced, 22, 'FIFO preserves both bursts without loss');
        assert.equal(whole.uart.dropped, 0);
        assert.equal(whole.uart.framingErrors, 0);
        assert.equal(whole.uart.unknownSamples, 0);
        assert.equal(whole.uart.burstPeriodMs, uartPeriodMs);
        assert.equal(whole.uart.burstPeriodPs, uartPeriodMs * 1e9);
        assert.equal(whole.uart.burstBytes, 11);
        assert.equal(whole.uart.handoffPeriodPs, 10_000_000);
        assert.equal(whole.uart.offeredBytesPerSecond, 11_000 / uartPeriodMs);
        const timerTicks = Math.floor(cycles / timing.timerCycles);
        assert.equal(whole.state.timerTicks, timerTicks, 'UART spacing must not alter 1kHz timer');
        assert.equal(whole.state.irqCount, timerTicks);
        assert.equal(
          whole.state.workCount,
          (timerTicks + 1) * 100,
          'CPU quota remains per millisecond',
        );
        assert.equal(whole.state.gpioCount, Math.floor(timerTicks / 10));
        assert.ok(whole.maxTimerIrqResponsePs <= timing.quantumPs + 12 * timing.cyclePs);
      });
    }
  }
}

test('stable device model identity is shared across SDK modules, not board state', () => {
  const a = create(sdk, { execution: 'precise', cycles: 2_000 });
  const b = create(
    { ...sdk },
    { execution: 'precise', waiting: 'poll', uartPeriodMs: 10, cycles: 2_000 },
  );
  try {
    assert.equal(a.model, b.model);
    assert.notEqual(a.board, b.board);
    assert.equal(a.board.time, 0, 'create must not advance a cold board');
    assert.equal(a.progress.cycles, 0);
    a.step(2_000);
    assert.equal(a.verify().state.workCount, 100);
    assert.equal(b.progress.cycles, 0);
  } finally {
    a.dispose();
    b.dispose();
  }
});

test('factory passes explicit board quantum and declares only the polling PC', () => {
  const boardOptions = [];
  const registrations = [];
  const observed = {
    ...sdk,
    createBoard(library, description, options) {
      boardOptions.push(options);
      return sdk.createBoard(library, description, options);
    },
    createDeviceLibrary(entries) {
      return sdk.createDeviceLibrary(
        entries.map((entry) =>
          entry.id !== 'cpu'
            ? entry
            : {
                ...entry,
                create(ctx) {
                  return entry.create({
                    ...ctx,
                    attachJit(options) {
                      registrations.push(options);
                      return ctx.attachJit(options);
                    },
                  });
                },
              },
        ),
      );
    },
  };
  const bench = create(observed, { waiting: 'poll', execution: 'throughput', cycles: 1 });
  try {
    assert.deepEqual(boardOptions, [{ execution: 'throughput', cpuQuantum: 10_000_000 }]);
    assert.deepEqual(registrations[0].polling, [{ pc: 0, predicate: 'canResume' }]);
  } finally {
    bench.dispose();
  }
});

test('oracle checks every work RAM byte and rejects corruption outside timed execution', () => {
  let corrupt = false;
  const observed = {
    ...sdk,
    createDeviceLibrary(entries) {
      return sdk.createDeviceLibrary(
        entries.map((entry) =>
          entry.id !== 'cpu'
            ? entry
            : {
                ...entry,
                create(ctx) {
                  return entry.create({
                    ...ctx,
                    memory: {
                      get snapshot() {
                        return ctx.memory.snapshot;
                      },
                      get ram() {
                        const bytes = Uint8Array.from(ctx.memory.ram);
                        if (corrupt) bytes[63] ^= 1;
                        return bytes;
                      },
                    },
                  });
                },
              },
        ),
      );
    },
  };
  const bench = create(observed, { execution: 'precise', cycles: 2_000 });
  try {
    bench.step(2_000);
    bench.verify();
    corrupt = true;
    assert.throws(() => bench.verify(), /all useful-work RAM bytes/);
  } finally {
    bench.dispose();
  }
});

test('independent work oracle is incremental, deterministic, and never reverses', () => {
  const sliced = createWorkOracle();
  sliced.advance(7);
  assert.deepEqual(sliced.advance(200), createWorkOracle().advance(200));
  assert.throws(() => sliced.advance(199), /backwards/);
  assert.throws(() => sliced.advance(NaN));
});

test('10ms timer IRQ drives observable low-frequency GPIO output', () => {
  const result = run({ execution: 'throughput', waiting: 'wfi', cycles: 1_002_000 }, [1_002_000]);
  assert.equal(result.state.timerTicks, 10);
  assert.equal(result.state.irqCount, 10);
  assert.equal(result.state.gpioCount, 1);
  assert.equal(result.state.gpioValue, 1);
  assert.equal(result.uart.dropped, 0);
});

test('progress, budgets, disposal, and option validation are bounded', () => {
  assert.deepEqual(normalizeOptions(), defaults);
  assert.equal(normalizeOptions({ duration: 0.00002 }).cycles, 2_000);
  assert.equal(normalizeOptions({ uartPeriodMs: 1_000 }).uartPeriodMs, 1_000);
  for (const uartPeriodMs of [0, -1, 1.5, 1_001, NaN, Infinity, '10', true, undefined])
    assert.throws(() => normalizeOptions({ uartPeriodMs }), /uartPeriodMs must be an integer/);
  for (const options of [
    null,
    [],
    1,
    { waiting: 'sleep' },
    { execution: 'fast' },
    { busyPercent: 2 },
    { cycles: 0 },
    { cycles: 1.1 },
    { cycles: 100_000_001 },
    { duration: 0 },
    { duration: 2 },
    { duration: 1e-12 },
    { duration: 0.1, cycles: 1 },
    { frequencyHz: 1 },
  ])
    assert.throws(() => normalizeOptions(options));
  const bench = create(sdk, { execution: 'precise', cycles: 2_000 });
  try {
    assert.equal(bench.progress.simulatedSeconds, 0);
    for (const count of [0, -1, 1.5, NaN, Infinity, 2_001]) assert.throws(() => bench.step(count));
    const sample = bench.step(2_000);
    assert.equal(sample.simulatedSeconds, 0.00002);
    assert.ok(sample.wallSeconds >= 0);
    assert.equal(sample.runUntilCalls, 2);
    assert.equal(bench.progress.budgetCycles, 2_000);
    assert.throws(() => bench.step(1), /budget/);
  } finally {
    bench.dispose();
  }
  bench.dispose();
  assert.throws(() => bench.step(1), /disposed/);
  assert.throws(() => bench.verify(), /disposed/);
});

test('main guard is import-safe; CLI help and malformed options do not run benchmarks', () => {
  const entry = new URL('./typical-mcu.mjs', import.meta.url);
  const imported = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(entry.href)})`],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
  assert.equal(imported.stderr, '');
  const help = spawnSync(process.execPath, [fileURLToPath(entry), '--help'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stderr, '');
  assert.ok(help.stdout.startsWith('Usage: node packages\\simulator\\bench\\typical-mcu.mjs '));
  for (const flag of [
    '--duration-ms',
    '--warmup-ms',
    '--uart-period-ms',
    '--execution',
    '--waiting',
    '--busy',
  ])
    assert.ok(help.stdout.includes(flag), `Help documents ${flag}`);
  assert.match(help.stdout, /8 throughput cases/);
  assert.match(help.stdout, /one 9ms warm sample/);
  assert.match(help.stdout, /10ms warm sample use --duration-ms 11 --warmup-ms 1/);
  assert.match(help.stdout, /--uart-period-ms 1 offers 11000 B\/s \(default stress\)/);
  assert.match(help.stdout, /--uart-period-ms 10 offers 1100 B\/s \(moderate\)/);
  assert.match(help.stdout, /Synthetic MCU/);
  assert.doesNotMatch(help.stdout, /"cold"|"evidence"/);
  const invalid = spawnSync(process.execPath, [fileURLToPath(entry), '--duration-ms', 'NaN'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /duration cycles must be an integer/);
});

test('CLI defaults are modest throughput-only and long matrices need explicit narrowing', () => {
  assert.deepEqual(parseArgs([]), {
    durationMs: 10,
    warmupMs: 1,
    uartPeriodMs: 1,
    executions: ['throughput'],
    waitings: ['wfi', 'poll'],
    busy: [1, 10, 30, 100],
  });
  assert.equal(
    parseArgs(['--duration-ms', '1000', '--waiting', 'wfi', '--busy', '1']).durationMs,
    1000,
  );
  assert.equal(parseArgs(['--uart-period-ms', '10']).uartPeriodMs, 10);
  assert.equal(parseArgs(['--uart-period-ms', '1000']).uartPeriodMs, 1_000);
  for (const args of [
    ['--uart-period-ms', '0'],
    ['--uart-period-ms', '-1'],
    ['--uart-period-ms', '1.5'],
    ['--uart-period-ms', '1001'],
    ['--uart-period-ms', 'NaN'],
    ['--uart-period-ms', 'Infinity'],
    ['--uart-period-ms'],
    ['--duration-ms', '1000'],
    ['--unknown', '1'],
    ['--busy', '1,1'],
    ['--execution', 'wrong'],
    ['--waiting', 'wrong'],
    ['--warmup-ms', '0'],
    ['--duration-ms', '1'],
    ['--busy'],
    ['--duration-ms', 'NaN'],
  ])
    assert.throws(() => parseArgs(args));
});
