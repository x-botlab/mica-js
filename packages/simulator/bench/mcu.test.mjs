import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as sdk from '../dist/index.js';
import {
  create,
  defaults,
  normalizeOptions,
  parseArgs,
  summarizeSteps,
  workloadNames,
} from './mcu.mjs';

const state = (bench) => bench.verify().snapshots[0];

for (const workload of workloadNames) {
  for (const size of [1, 4, 16]) {
    test(`${workload}, ${size} MCUs: monolithic equals irregular slices`, () => {
      const options = { workload, size, cyclePs: 7, irqPeriodCycles: 17 };
      const monolithic = create(sdk, options);
      const sliced = create(sdk, options);
      try {
        monolithic.step(413);
        const expected = monolithic.verify();
        let remaining = 413;
        const chunks = [1, 2, 19, 5, 37, 3, 17, 41];
        for (let index = 0; remaining > 0; index++) {
          const count = Math.min(remaining, chunks[index % chunks.length]);
          sliced.step(count);
          sliced.verify();
          remaining -= count;
        }
        assert.deepEqual(sliced.verify(), expected);
        assert.equal(expected.cyclesPerMcu, 413);
        assert.equal(expected.aggregateCycles, 413 * size);
        assert.equal(expected.time, 413 * 7);
        assert.equal(expected.snapshots.length, size);
        assert.equal(expected.busyCyclesPerMcu, 413);
        assert.equal(
          expected.instructionCycleCostIssuedPerMcu +
            2 * expected.irqEntriesPerMcu -
            expected.terminalRemainingCyclesPerMcu,
          413,
        );
      } finally {
        monolithic.dispose();
        sliced.dispose();
      }
    });
  }
}

test('progress exposes zero initial counters without advancing or capturing', () => {
  assert.deepEqual(normalizeOptions(), defaults);
  for (const invalid of [null, [], 1, 'ram']) assert.throws(() => normalizeOptions(invalid));
  const bench = create(sdk, { size: 4, cyclePs: 7 });
  try {
    assert.deepEqual(bench.progress, {
      time: 0,
      simulatedSeconds: 0,
      cyclesPerMcu: 0,
      aggregateCycles: 0,
    });
    const step = bench.step(1);
    assert.equal(step.simulatedSeconds, 7e-12);
    assert.deepEqual(bench.progress, {
      time: 7,
      simulatedSeconds: 7e-12,
      cyclesPerMcu: 1,
      aggregateCycles: 4,
    });
    const verified = bench.verify();
    assert.equal(verified.simulatedSeconds, 7e-12);
    assert.equal(verified.instructionsIssuedPerMcu, 1);
    assert.equal(verified.instructionCycleCostIssuedPerMcu, 2);
    assert.equal(verified.terminalRemainingCyclesPerMcu, 1);
    assert.equal(verified.busyCyclesPerMcu, 1);
    assert.equal(verified.irqEntriesPerMcu, 0);
    bench.step(1);
    const exact = bench.verify();
    assert.equal(exact.terminalRemainingCyclesPerMcu, 0);
    assert.equal(exact.instructionsIssuedPerMcu, 1);
    assert.equal(exact.busyCyclesPerMcu, 2);
  } finally {
    bench.dispose();
  }
});

test('exact instruction target does not start the next ALU instruction', () => {
  const bench = create(sdk, { cyclePs: 10_000 });
  try {
    const step = bench.step(2);
    assert.equal(step.to, 20_000);
    assert.equal(step.from, 0);
    assert.equal(step.cyclesPerMcu, 2);
    assert.ok(step.wallSeconds >= 0);
    assert.deepEqual([...state(bench).bytes.slice(0, 3)], [2, 3, 0]);
    assert.equal(bench.verify().instructionsIssuedPerMcu, 1);
    // Repeated untimed captures at the same target must not resume the CPU.
    assert.deepEqual([...state(bench).bytes.slice(0, 3)], [2, 3, 0]);
    bench.step(2);
    assert.deepEqual([...state(bench).bytes.slice(0, 3)], [4, 166, 0]);
    bench.step(1);
    assert.deepEqual([...state(bench).bytes.slice(0, 3)], [0, 166, 0]);
    assert.equal(bench.verify().instructionsIssuedPerMcu, 3);
    bench.step(1);
    assert.deepEqual([...state(bench).bytes.slice(0, 3)], [2, 169, 0]);
  } finally {
    bench.dispose();
  }
});

test('normal RAM load/store results and exact-target delayed load continuation', () => {
  const bench = create(sdk, { workload: 'ram', cyclePs: 1 });
  try {
    bench.step(6);
    assert.deepEqual([...state(bench).bytes.slice(0, 2)], [6, 50]);
    assert.equal(state(bench).ram[16], 1);
    bench.step(2);
    // LD has captured RAM[16]=1 but its post-elapse write must not run at t=8.
    assert.deepEqual([...state(bench).bytes.slice(0, 2)], [8, 50]);
    assert.deepEqual([...state(bench).bytes.slice(0, 2)], [8, 50]);
    bench.step(1);
    assert.deepEqual([...state(bench).bytes.slice(0, 2)], [10, 91]);
    bench.step(4);
    const first = state(bench);
    assert.deepEqual([...first.ram.slice(16, 18)], [1, 91]);
    assert.equal(
      first.ram.reduce((sum, value) => sum + value, 0),
      92,
    );
    assert.equal(bench.verify().instructionsIssuedPerMcu, 7);
    bench.step(13);
    assert.deepEqual([...state(bench).ram.slice(16, 18)], [92, 6]);
  } finally {
    bench.dispose();
  }
});

test('scheduled timer IRQ at exact boundary, entry delay, handler RAM and IRET', () => {
  const bench = create(sdk, { workload: 'gpio-timer-irq', cyclePs: 1, irqPeriodCycles: 17 });
  try {
    bench.step(17);
    let snapshot = state(bench);
    assert.deepEqual([...snapshot.bytes.slice(0, 8)], [2, 0, 0, 1, 1, 1, 1, 0]);
    assert.equal(new DataView(snapshot.bytes.buffer).getUint32(8, true), 1);
    bench.step(2);
    snapshot = state(bench);
    assert.deepEqual([...snapshot.bytes.slice(0, 5)], [128, 0, 2, 0, 0]);
    assert.equal(bench.verify().instructionsIssuedPerMcu, 10);
    bench.step(2);
    assert.deepEqual([...state(bench).bytes.slice(0, 5)], [130, 0, 2, 0, 0]);
    bench.step(2);
    assert.equal(state(bench).ram[255], 0, 'STORE must not start at ADDI completion target');
    bench.step(2);
    assert.equal(state(bench).ram[255], 1);
    assert.deepEqual([...state(bench).bytes.slice(0, 5)], [134, 1, 2, 0, 0]);
    bench.step(2);
    assert.deepEqual([...state(bench).bytes.slice(0, 8)], [2, 1, 2, 0, 1, 1, 1, 0]);
    bench.step(7);
    snapshot = state(bench);
    assert.equal(snapshot.bytes[3], 1, 'second timer IRQ latches at t=34');
    assert.equal(new DataView(snapshot.bytes.buffer).getUint32(8, true), 2);
    bench.step(300);
    snapshot = state(bench);
    assert.ok(snapshot.ram[255] > 1, 'handler keeps executing during continuous main loop');
    assert.equal(snapshot.bytes[6] + snapshot.bytes[7], 1, 'electrical sample must be known');
  } finally {
    bench.dispose();
  }
});

test('IRQ arriving mid-instruction waits for its boundary without interrupting elapse', () => {
  const bench = create(sdk, { workload: 'gpio-timer-irq', cyclePs: 1, irqPeriodCycles: 18 });
  try {
    bench.step(18);
    assert.deepEqual([...state(bench).bytes.slice(0, 5)], [3, 0, 0, 1, 1]);
    bench.step(1);
    assert.deepEqual([...state(bench).bytes.slice(0, 5)], [3, 0, 0, 1, 1]);
    bench.step(1);
    assert.deepEqual([...state(bench).bytes.slice(0, 5)], [128, 0, 3, 0, 0]);
    bench.step(1);
    assert.deepEqual([...state(bench).bytes.slice(0, 5)], [128, 0, 3, 0, 0]);
    bench.step(1);
    assert.deepEqual([...state(bench).bytes.slice(0, 5)], [130, 0, 3, 0, 0]);
  } finally {
    bench.dispose();
  }
});

test('all 256 RAM bytes are verified, not just a last-message checksum', () => {
  let corruptRead = false;
  const instrumented = {
    ...sdk,
    createDeviceLibrary(entries) {
      return sdk.createDeviceLibrary(
        entries.map((entry) => ({
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
                  if (corruptRead) bytes[200] = 99;
                  return bytes;
                },
              },
            });
          },
        })),
      );
    },
  };
  const bench = create(instrumented, { workload: 'ram' });
  try {
    bench.step(13);
    bench.verify();
    corruptRead = true;
    assert.throws(() => bench.verify(), /data RAM/);
  } finally {
    bench.dispose();
  }
});

test('SDK injection creates independent AB/BA boards and disposal is idempotent', () => {
  const calls = [0, 0];
  const alternative = (index) => ({
    ...sdk,
    createBoard(...args) {
      calls[index]++;
      return sdk.createBoard(...args);
    },
  });
  const a = create(alternative(0), { workload: 'ram' });
  const b = create(alternative(1), { workload: 'ram' });
  try {
    assert.equal(a.model, b.model, 'AB/BA must retain exactly the same model object');
    a.step(7);
    b.step(3);
    b.verify();
    a.verify();
    b.step(4);
    assert.deepEqual(a.verify(), b.verify());
    b.step(9);
    a.step(9);
    assert.deepEqual(b.verify(), a.verify());
    assert.deepEqual(calls, [1, 1]);
    a.dispose();
    a.dispose();
    assert.throws(() => a.step(), /disposed/);
    assert.throws(() => a.verify(), /disposed/);
    b.step(1);
    b.verify();
  } finally {
    a.dispose();
    b.dispose();
  }
});

test('MHz denominator is one MCU while aggregate rate scales with MCU count', () => {
  const steps = [
    { cyclesPerMcu: 100, wallSeconds: 0.001 },
    { cyclesPerMcu: 300, wallSeconds: 0.003 },
  ];
  const result = summarizeSteps({ size: 4, cyclePs: 10_000, steps, instructionsIssuedPerMcu: 240 });
  assert.equal(result.cyclesPerMcu, 400);
  assert.equal(result.aggregateCycles, 1600);
  assert.equal(result.simulatedSeconds, 0.000004);
  assert.equal(result.wallSeconds, 0.004);
  assert.equal(result.nominalMHz, 100);
  assert.equal(result.aggregateCyclesPerSecond, 400_000);
  assert.equal(result.effectiveRealTimeMHzPerMcu, 0.1);
  assert.equal(result.realTimeFactor, 0.001);
  assert.equal(result.aggregateInstructionsIssuedPerSecond, 240_000);
  assert.equal(result.instructionsIssuedPerSecondPerMcu, 60_000);
  assert.deepEqual(result.stepMs, { p50: 1, p95: 3, p99: 3 });
  const one = summarizeSteps({ size: 1, cyclePs: 10_000, steps, instructionsIssuedPerMcu: 240 });
  assert.equal(one.effectiveRealTimeMHzPerMcu, result.effectiveRealTimeMHzPerMcu);
  assert.equal(one.simulatedSeconds, result.simulatedSeconds);
  assert.equal(one.aggregateCyclesPerSecond * 4, result.aggregateCyclesPerSecond);
});

test('metric helper rejects samples using a different MCU count or nominal clock', () => {
  const options = { size: 4, cyclePs: 10_000, instructionsIssuedPerMcu: 1 };
  const step = {
    cyclesPerMcu: 2,
    aggregateCycles: 8,
    from: 0,
    to: 20_000,
    simulatedSeconds: 2e-8,
    wallSeconds: 0.001,
  };
  assert.equal(summarizeSteps({ ...options, steps: [step] }).cyclesPerMcu, 2);
  for (const changed of [
    { aggregateCycles: 2 },
    { from: 1 },
    { to: 2 },
    { from: undefined },
    { simulatedSeconds: 1 },
  ])
    assert.throws(() => summarizeSteps({ ...options, steps: [{ ...step, ...changed }] }));
  assert.throws(() => summarizeSteps({ ...options, size: 1, steps: [step] }), /MCU size/);
  assert.throws(() => summarizeSteps({ ...options, cyclePs: 1, steps: [step] }), /cyclePs/);
});

test('explicit initial-state verification is valid but initializes the board', () => {
  for (const workload of workloadNames) {
    const bench = create(sdk, { workload });
    try {
      const initial = bench.verify();
      assert.equal(initial.time, 0);
      assert.equal(initial.instructionsIssuedPerMcu, 0);
      assert.equal(initial.busyCyclesPerMcu, 0);
      assert.deepEqual([...initial.snapshots[0].bytes.slice(0, 6)], [0, 0, 0, 0, 1, 0]);
      assert.ok(initial.snapshots[0].ram.every((byte) => byte === 0));
    } finally {
      bench.dispose();
    }
  }
});

test('factory, steps, summaries and CLI reject invalid or excessive work', () => {
  for (const options of [
    { size: 0 },
    { size: 2 },
    { size: 17 },
    { workload: 'arm' },
    { cyclePs: 0 },
    { cyclePs: 1.5 },
    { cyclePs: Infinity },
    { cyclePs: 1_000_001 },
    { stepCycles: -1 },
    { stepCycles: NaN },
    { stepCycles: 1_000_001 },
    { irqPeriodCycles: 16 },
    { irqPeriodCycles: 1_000_001 },
    { trace: true },
  ])
    assert.throws(() => create(sdk, options));
  assert.throws(() => create({}, {}), /SDK/);
  const bench = create(sdk);
  try {
    for (const count of [0, -1, 1.5, NaN, Infinity, 1_000_001])
      assert.throws(() => bench.step(count));
    assert.equal(bench.board.time, 0);
  } finally {
    bench.dispose();
  }
  for (const args of [
    ['--unknown=1'],
    ['--samples=20', '--samples=21'],
    ['--samples=19'],
    ['--samples=201'],
    ['--warmup=0'],
    ['--warmup=21'],
    ['--sizes=2'],
    ['--sizes=1,1'],
    ['--sizes=1,x'],
    ['--workloads=ram,ram'],
    ['--workloads=arm'],
    ['--cycle-ps=0'],
    ['--cycle-ps=1.5'],
    ['--cycles-per-step=1000000'],
    ['--cycles-per-step=200000', '--sizes=16'],
    ['--irq-period-cycles=0'],
    ['--samples='],
    ['--samples'],
  ])
    assert.throws(() => parseArgs(args), `Should reject ${args}`);
  assert.deepEqual(parseArgs([]).sizes, [1, 4, 16]);
  assert.equal(parseArgs(['--sizes=4', '--cycle-ps=1', '--workloads=ram']).cyclePs, 1);
  const summary = { size: 1, cyclePs: 1, steps: [], instructionsIssuedPerMcu: 0 };
  assert.throws(() => summarizeSteps(summary), /No step/);
  for (const wallSeconds of [0, -1, NaN, Infinity])
    assert.throws(() => summarizeSteps({ ...summary, steps: [{ cyclesPerMcu: 1, wallSeconds }] }));
});

test('main guard is import-safe; CLI help and malformed options do not run benchmarks', () => {
  const entry = new URL('./mcu.mjs', import.meta.url);
  const imported = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(entry.href)})`],
    { encoding: 'utf8' },
  );
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
  const help = spawnSync(process.execPath, [fileURLToPath(entry), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Synthetic MCU/);
  assert.doesNotMatch(help.stdout, /coldFirstAdvance/);
  const invalid = spawnSync(process.execPath, [fileURLToPath(entry), '--sizes=2'], {
    encoding: 'utf8',
  });
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /size must be 1, 4, or 16/);
});
