import assert from 'node:assert/strict';
import test from 'node:test';
import { compileDDL } from '@mica-js/ddl';
import * as sdk from '../dist/index.js';
import {
  acceptanceSummary,
  createExercise,
  fillDeviceSource,
  instrumentEventQueue,
  normalizeConfig,
  probeBatchSupport,
  verifyExercise,
} from './batch-execution-fixture.mjs';
import { defaultSdkPath, parseArgs as parseNodeArgs, runBenchmark } from './batch-execution.mjs';
import { parseArgs as parseBrowserArgs, runBrowserBenchmark } from './batch-execution-browser.mjs';

const config = normalizeConfig({ iterations: 256, tickPs: 10 });
const model = await compileDDL(fillDeviceSource(config));

test('CLI defaults and smoke overrides stay on the acceptance shape', () => {
  const defaults = parseNodeArgs([]);
  assert.equal(defaults.samples, 25);
  assert.equal(defaults.warmup, 5);
  assert.equal(defaults.iterations, 65_536);
  assert.equal(defaults.tickPs, 10);
  assert.equal(defaults.execution, 'throughput');
  assert.equal(defaults.sdk, defaultSdkPath);
  assert.equal(defaults.baselineSha, '8a36ed4');
  const smoke = parseNodeArgs(['--smoke']);
  assert.equal(smoke.iterations, 256);
  assert.equal(smoke.samples, 3);
  assert.equal(smoke.warmup, 1);
  assert.throws(() => parseNodeArgs(['--samples=0']), /samples/);
  assert.throws(() => parseNodeArgs(['--samples=1', '--samples=2']), /Duplicate/);
  assert.throws(() => parseNodeArgs(['--unknown']), /Unknown/);
  assert.equal(parseNodeArgs(['--help']), null);

  const browser = parseBrowserArgs([]);
  assert.equal(browser.samples, 25);
  assert.equal(browser.warmup, 5);
  assert.equal(browser.iterations, 65_536);
  assert.equal(browser.sdk, defaultSdkPath);
  assert.ok(Number.isSafeInteger(browser.timeoutMs));
  assert.throws(() => parseBrowserArgs(['--baseline-sdk=missing']), /Unknown/);
  assert.equal(parseBrowserArgs(['--help']), null);
});

test('fixture checks all bytes, cursor, done time and real queue counts', () => {
  const support = probeBatchSupport(sdk, model, config);
  const variant = support.option
    ? { name: 'disabled', batchExecution: false, register: false }
    : { name: 'baseline-control', register: false };
  const exercise = createExercise(sdk, model, config, variant);
  try {
    const queue = instrumentEventQueue(exercise.board);
    assert.ok(queue, 'the board must expose its real EventQueue to the untimed probe');
    exercise.board.runUntil(config.runUntilPs);
    const evidence = verifyExercise(exercise);
    assert.equal(evidence.boardTime, 2570);
    assert.equal(evidence.cursor, 256);
    assert.equal(evidence.doneTime, 2560);
    assert.equal(evidence.memoryLength, 256);
    assert.equal(evidence.allBytes, true);
    assert.deepEqual(queue.read(), { pushes: 256, pops: 256 });
  } finally {
    exercise.dispose();
  }
});

test('registered batch run keeps observable equivalence when admitted', () => {
  const support = probeBatchSupport(sdk, model, config);
  if (!support.option || !support.registration) return; // Baseline control runs the preceding test until the runtime API lands.
  const disabled = createExercise(sdk, model, config, {
    name: 'disabled',
    batchExecution: false,
    register: false,
  });
  const active = createExercise(sdk, model, config, {
    name: 'active',
    batchExecution: true,
    register: true,
  });
  try {
    const disabledQueue = instrumentEventQueue(disabled.board);
    const activeQueue = instrumentEventQueue(active.board);
    assert.ok(disabledQueue);
    assert.ok(activeQueue);
    disabled.board.runUntil(config.runUntilPs);
    active.board.runUntil(config.runUntilPs);
    assert.deepEqual(verifyExercise(active), verifyExercise(disabled));
    const idle = disabledQueue.read();
    const batched = activeQueue.read();
    assert.equal(idle.pushes, 256);
    assert.equal(idle.pops, 256);
    assert.ok(
      batched.pushes < idle.pushes,
      `registered run should fold wakeups, got ${batched.pushes} pushes`,
    );
    assert.equal(batched.pops, batched.pushes, 'every enqueued wakeup is popped');
  } finally {
    disabled.dispose();
    active.dispose();
  }
});

test('acceptance summary applies wakeup, speedup and overhead thresholds to paired samples', () => {
  const sample = (disabled, active, noRegistration, baseline) => ({
    ms: {
      disabled,
      active,
      'enabled-no-registration': noRegistration,
      'baseline-disabled': baseline,
    },
  });
  const series = {
    variants: {
      disabled: { scheduling: { pushes: 100, pops: 100 }, warm: { medianMs: 10 } },
      active: { scheduling: { pushes: 1, pops: 1 }, warm: { medianMs: 5 } },
      'enabled-no-registration': {
        scheduling: { pushes: 100, pops: 100 },
        warm: { medianMs: 10.2 },
      },
      'baseline-disabled': { scheduling: { pushes: 100, pops: 100 }, warm: { medianMs: 10 } },
    },
    samples: [
      sample(10, 5, 10.2, 10),
      sample(10.2, 5.2, 10.4, 10.2),
      sample(9.9, 5.1, 10.1, 9.9),
      sample(10.1, 5.3, 10.3, 10.1),
    ],
  };
  const accepted = acceptanceSummary(series, { baseline: true });
  assert.equal(accepted.schedule.wakeReduction, 0.99);
  assert.equal(accepted.checks.wakeReduction, true);
  assert.equal(accepted.checks.activeMedianSpeedup, true);
  assert.equal(accepted.checks.disabledOverheadVsBaseline, true);
  assert.equal(accepted.checks.noRegistrationOverheadVsBaseline, true);
  assert.equal(accepted.passed, true);

  series.variants.active.warm.medianMs = 9.5;
  series.samples = series.samples.map((entry) => ({
    ms: { ...entry.ms, active: 9.5 },
  }));
  const slow = acceptanceSummary(series, { baseline: true });
  assert.equal(slow.checks.activeMedianSpeedup, false);
  assert.equal(slow.passed, false);
});

test('smoke benchmark records correctness before timing for every available variant', async () => {
  const result = await runBenchmark(parseNodeArgs(['--smoke']));
  assert.equal(result.kind, 'batch-execution-benchmark');
  assert.equal(result.environment.baselineSha, '8a36ed4');
  assert.equal(result.fixture.iterations, 256);
  assert.equal(result.fixture.donePs, 2560);
  assert.equal(result.fixture.runUntilPs, 2570);
  assert.equal(result.samples.length, 3);
  const names = Object.keys(result.variants);
  if (result.support.option) {
    assert.ok(names.includes('disabled'));
    assert.ok(names.includes('enabled-no-registration'));
    if (result.support.registration) assert.ok(names.includes('active'));
  } else {
    assert.deepEqual(names, ['baseline-control']);
    assert.equal(result.acceptance, null);
  }
  for (const variant of Object.values(result.variants)) {
    assert.equal(variant.correctness.cursor, 256);
    assert.equal(variant.correctness.doneTime, 2560);
    assert.equal(variant.correctness.allBytes, true);
    assert.ok(variant.scheduling.pushes >= 1);
    assert.equal(variant.scheduling.pops, variant.scheduling.pushes);
    assert.equal(variant.warm.samples, 3);
    assert.ok(variant.warm.medianMs > 0);
  }
});

test(
  'browser smoke runs the published bundle when explicitly requested',
  { skip: process.env.BATCH_EXECUTION_TEST_BROWSER !== '1' },
  async () => {
    const result = await runBrowserBenchmark(parseBrowserArgs(['--smoke']));
    assert.equal(result.kind, 'batch-execution-benchmark-browser');
    assert.equal(result.fixture.iterations, 256);
    assert.equal(result.samples.length, 3);
    assert.ok(result.bundle.totalBytes > 0);
    for (const variant of Object.values(result.variants)) {
      assert.equal(variant.correctness.cursor, 256);
      assert.equal(variant.correctness.doneTime, 2560);
      assert.equal(variant.correctness.allBytes, true);
      assert.equal(variant.scheduling.pops, variant.scheduling.pushes);
    }
  },
);
