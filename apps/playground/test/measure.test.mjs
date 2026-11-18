import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMeasurementRecorder } from '../src/measure.ts';

/**
 * Measurement contract:
 *
 * - Disabled by default: no editor callbacks and `start()` refuses to run.
 * - `warmupMs`/`windowMs` are simulated durations; cold and steady split on completed tick
 *   `simTime`, not wall-clock `startedAt`.
 * - A tick spanning a boundary is excluded from both windows and counted as a crossing.
 * - Raw records are bounded per lane; dropped counts are explicit.
 * - A stop without a complete window is marked incomplete, and stop waits for in-flight rounds.
 * - start() is rejected while running, stopping, or with an observer advance in flight, so a
 *   pending stop() is never orphaned by a new measurement.
 * - Evicting warmup records must not move the steady wall anchor back to start(); missing or
 *   non-contiguous advance records make the window incomplete.
 */

const MS = 1_000_000_000;

class FakeClock {
  #now = 0;
  now() {
    return this.#now;
  }
  advance(ms) {
    this.#now += ms;
  }
}

function advanceSample(overrides = {}) {
  return {
    sequence: 1,
    trigger: 'frame',
    startedAt: 0,
    tickCompletedAt: 0,
    completedAt: 10,
    tickMs: 5,
    widgetMs: 5,
    idleMs: undefined,
    periodMs: undefined,
    skippedSlots: 0,
    simTime: 0,
    dt: 64 * MS,
    running: true,
    mode: 'simulation',
    frameMs: 64,
    ...overrides,
  };
}

function renderSample(overrides = {}) {
  return {
    sequence: 1,
    startedAt: 0,
    completedAt: 4,
    durationMs: 4,
    mode: 'simulation',
    widgets: 2,
    width: 800,
    height: 600,
    dpr: 1,
    ...overrides,
  };
}

function frameSample(overrides = {}) {
  return {
    at: 0,
    instanceId: 'seg-a',
    sequence: 1,
    width: 100,
    height: 40,
    dpr: 1,
    ...overrides,
  };
}

function topicSample(overrides = {}) {
  return {
    at: 0,
    symbol: 'ds1',
    port: 'digit1',
    simTime: 64 * MS,
    payload: 0x3f,
    ...overrides,
  };
}

function makeRecorderAt(wallMs, capacity = 64) {
  const clock = new FakeClock();
  clock.advance(wallMs);
  return createMeasurementRecorder({ enabled: true, clock, capacity });
}

function makeRecorder(capacity = 64) {
  return makeRecorderAt(0, capacity);
}

test('disabled recorder keeps callbacks off and refuses to start', () => {
  const recorder = createMeasurementRecorder({ enabled: false });
  assert.equal(recorder.enabled, false);
  assert.equal(recorder.editorMeasurement, undefined);
  assert.throws(() => recorder.start(), /disabled/);
});

test('splits cold and steady on completed sim ticks and retains bounded raw lanes', async () => {
  const recorder = makeRecorderAt(1000);
  recorder.setScenario({ documentId: 'ct107d-workbench', clockFrequencyHz: 11_059_200 });
  recorder.setArtifacts({
    status: 'ok',
    note: 'test artifacts',
    files: [{ path: 'firmware.bin', source: 'test', bytes: 3, sha256: 'abc', error: null }],
  });
  recorder.start({ warmupMs: 512, windowMs: 1024 });
  const measurement = recorder.editorMeasurement;
  assert.ok(measurement);

  // 24 ticks of 64 simulated ms: 8 cold ticks (64..512) and 16 steady ticks (576..1536).
  let wall = 1000;
  for (let index = 1; index <= 24; index += 1) {
    const startedAt = wall;
    measurement.advanceStart?.();
    measurement.advance(
      advanceSample({
        sequence: index,
        startedAt,
        tickCompletedAt: startedAt + 5,
        completedAt: startedAt + 8,
        tickMs: 5,
        widgetMs: 3,
        idleMs: index === 1 ? undefined : 92,
        periodMs: index === 1 ? undefined : 100,
        simTime: index * 64 * MS,
      }),
    );
    measurement.render(
      renderSample({ sequence: index, startedAt: startedAt + 2, completedAt: startedAt + 3 }),
    );
    measurement.widgetFrame(
      frameSample({
        at: startedAt + 1,
        instanceId: index % 2 === 0 ? 'seg-b' : 'seg-a',
        sequence: index,
      }),
    );
    measurement.topic(
      topicSample({
        at: startedAt + 3,
        symbol: index % 2 === 0 ? 'ds2' : 'ds1',
        port: 'digit1',
        simTime: index * 64 * MS,
        payload: index,
      }),
    );
    measurement.advanceSettled?.();
    wall += 100;
  }
  const report = await recorder.stop();

  assert.equal(report.phase, 'stopped');
  assert.equal(report.controls.warmupSimMs, 512);
  assert.equal(report.controls.windowSimMs, 1024);
  assert.equal(report.controls.boundarySimPs, 512 * MS);
  assert.equal(report.controls.endSimPs, 1536 * MS);
  assert.equal(report.controls.complete, true);
  assert.equal(report.controls.incompleteReason, null);
  assert.equal(report.controls.crossBoundary, 0);
  assert.equal(report.controls.crossEnd, 0);

  assert.equal(report.coldStart.advances, 8);
  assert.equal(report.steadyState.advances, 16);
  assert.equal(report.coldStart.sim.fromPs, 0);
  assert.equal(report.coldStart.sim.toPs, 512 * MS);
  assert.equal(report.coldStart.sim.elapsedMs, 512);
  assert.equal(report.coldStart.elapsedWallMs, 708);
  assert.equal(report.coldStart.wallMs, report.coldStart.elapsedWallMs);
  assert.equal(report.steadyState.sim.fromPs, 512 * MS);
  assert.equal(report.steadyState.sim.toPs, 1536 * MS);
  assert.equal(report.steadyState.sim.elapsedMs, 1024);
  // The steady span starts at the last warmup completion (1708), not the first steady start (1800).
  assert.equal(report.steadyState.elapsedWallMs, 1600);
  assert.equal(report.steadyState.wallMs, report.steadyState.elapsedWallMs);
  assert.equal(report.coldStart.realtimeRatio, 0.7232);
  assert.equal(report.steadyState.realtimeRatio, 0.64);

  assert.equal(report.raw.advances.length, 24);
  assert.equal(report.raw.renders.length, 24);
  assert.equal(report.raw.frames.length, 24);
  assert.equal(report.raw.topics.length, 24);
  assert.equal(report.buffers.capacity, 64);
  assert.equal(report.buffers.advances.dropped, 0);
  assert.equal(report.buffers.renders.dropped, 0);
  assert.equal(report.buffers.frames.dropped, 0);
  assert.equal(report.buffers.topics.dropped, 0);
  assert.equal(report.raw.frames[0].instanceId, 'seg-a');
  assert.equal(report.raw.frames[1].instanceId, 'seg-b');
  assert.equal(report.raw.topics[0].symbol, 'ds1');
  assert.equal(report.raw.topics[0].port, 'digit1');
  assert.equal(report.artifacts.status, 'ok');
  assert.equal(report.scenario.clockFrequencyHz, 11_059_200);
});

test('excludes a slow tick spanning the boundary from both windows and marks incomplete', async () => {
  const recorder = makeRecorderAt(1000);
  recorder.start({ warmupMs: 512, windowMs: 1024 });
  const measurement = recorder.editorMeasurement;
  assert.ok(measurement);

  // 300 ms ticks: 300 is cold, 600 crosses 512, 900/1200/1500 are steady, 1800 crosses 1536.
  let wall = 1000;
  for (const [index, simMs] of [300, 600, 900, 1200, 1500, 1800].entries()) {
    measurement.advanceStart?.();
    measurement.advance(
      advanceSample({
        sequence: index + 1,
        startedAt: wall,
        tickCompletedAt: wall + 5,
        completedAt: wall + 8,
        tickMs: 5,
        widgetMs: 3,
        simTime: simMs * MS,
        dt: 300 * MS,
      }),
    );
    measurement.advanceSettled?.();
    wall += 400;
  }
  const report = await recorder.stop();

  assert.equal(report.raw.advances.length, 6);
  assert.equal(report.coldStart.advances, 1);
  assert.equal(report.steadyState.advances, 3);
  assert.equal(report.controls.crossBoundary, 1);
  assert.equal(report.controls.crossEnd, 1);
  assert.equal(report.controls.complete, false);
  assert.match(report.controls.incompleteReason, /warmup boundary/);
  assert.equal(report.coldStart.sim.toPs, 300 * MS);
  assert.equal(report.steadyState.sim.fromPs, 600 * MS);
  assert.equal(report.steadyState.sim.toPs, 1500 * MS);
  assert.equal(report.steadyState.sim.elapsedMs, 900);
  assert.equal(report.steadyState.elapsedWallMs, 1200);
  assert.equal(report.steadyState.realtimeRatio, 0.75);
  assert.ok(report.warnings.some((warning) => warning.includes('incomplete')));
  assert.ok(report.warnings.some((warning) => warning.includes('not valid data')));
});

test('stop waits for an in-flight round and marks a short run incomplete', async () => {
  const recorder = makeRecorder();
  recorder.start({ warmupMs: 512, windowMs: 1024 });
  const measurement = recorder.editorMeasurement;
  assert.ok(measurement);

  measurement.advanceStart?.();
  const stopping = recorder.stop();
  measurement.advance(
    advanceSample({
      sequence: 1,
      startedAt: 100,
      tickCompletedAt: 105,
      completedAt: 108,
      tickMs: 5,
      widgetMs: 3,
      simTime: 64 * MS,
    }),
  );
  measurement.advanceSettled?.();
  const report = await stopping;

  assert.equal(report.phase, 'stopped');
  assert.equal(report.raw.advances.length, 1);
  assert.equal(report.coldStart.advances, 1);
  assert.equal(report.steadyState.advances, 0);
  assert.equal(report.controls.complete, false);
  assert.match(report.controls.incompleteReason, /No steady tick/);
  assert.equal(report.artifacts.status, 'pending');
  assert.ok(
    report.warnings.some((warning) => warning.includes('Artifact verification is pending')),
  );
});

test('bounded lanes report dropped and keep bitmap instance and topic port identifiers', async () => {
  const recorder = makeRecorder(2);
  recorder.start({ warmupMs: 0, windowMs: 0 });
  const measurement = recorder.editorMeasurement;
  assert.ok(measurement);

  for (let index = 1; index <= 3; index += 1) {
    measurement.advanceStart?.();
    measurement.advance(advanceSample({ sequence: index, simTime: index * 64 * MS, dt: 64 * MS }));
    measurement.advanceSettled?.();
    measurement.widgetFrame(frameSample({ at: index, instanceId: `seg-${index}` }));
    measurement.topic(topicSample({ at: index, symbol: `ds${index}`, port: 'digit1' }));
  }
  const report = await recorder.stop();

  assert.equal(report.raw.advances.length, 2);
  assert.equal(report.raw.frames.length, 2);
  assert.equal(report.raw.topics.length, 2);
  assert.equal(report.buffers.advances.dropped, 1);
  assert.equal(report.buffers.frames.dropped, 1);
  assert.equal(report.buffers.topics.dropped, 1);
  assert.deepEqual(
    report.raw.frames.map((frame) => frame.instanceId),
    ['seg-2', 'seg-3'],
  );
  assert.deepEqual(
    report.raw.topics.map((topic) => `${topic.symbol}/${topic.port}`),
    ['ds2/digit1', 'ds3/digit1'],
  );
  assert.equal(report.steadyState.advances, 2);
  assert.equal(report.controls.complete, false);
  assert.match(report.controls.incompleteReason, /windowMs=0/);
  assert.ok(report.warnings.some((warning) => warning.includes('dropped')));
});

test('moves from warmup to window when a tick completes past the boundary', async () => {
  const recorder = makeRecorderAt(100);
  recorder.start({ warmupMs: 128, windowMs: 256 });
  const measurement = recorder.editorMeasurement;
  assert.ok(measurement);

  measurement.advanceStart?.();
  measurement.advance(
    advanceSample({
      sequence: 1,
      startedAt: 100,
      completedAt: 110,
      simTime: 128 * MS,
      dt: 128 * MS,
    }),
  );
  measurement.advanceSettled?.();
  assert.equal(recorder.report().phase, 'warmup');

  measurement.advanceStart?.();
  measurement.advance(
    advanceSample({
      sequence: 2,
      startedAt: 120,
      completedAt: 130,
      simTime: 192 * MS,
      dt: 64 * MS,
    }),
  );
  measurement.advanceSettled?.();
  assert.equal(recorder.report().phase, 'window');

  const report = await recorder.stop();
  assert.equal(report.phase, 'stopped');
  assert.equal(report.coldStart.advances, 1);
  assert.equal(report.steadyState.advances, 1);
});

test('steady elapsed wall spans from the last warmup completion and includes scheduling idle', async () => {
  const recorder = makeRecorderAt(1000);
  recorder.start({ warmupMs: 512, windowMs: 1024 });
  const measurement = recorder.editorMeasurement;
  assert.ok(measurement);

  measurement.advanceStart?.();
  measurement.advance(
    advanceSample({
      sequence: 1,
      startedAt: 1000,
      completedAt: 1108,
      simTime: 512 * MS,
      dt: 512 * MS,
    }),
  );
  measurement.advanceSettled?.();

  let startedAt = 1500; // 392 ms of scheduling idle before the first steady round.
  for (let index = 2; index <= 17; index += 1) {
    measurement.advanceStart?.();
    measurement.advance(
      advanceSample({
        sequence: index,
        startedAt,
        completedAt: startedAt + 8,
        simTime: (512 + (index - 1) * 64) * MS,
        dt: 64 * MS,
      }),
    );
    measurement.advanceSettled?.();
    startedAt += 100;
  }
  const report = await recorder.stop();

  assert.equal(report.controls.complete, true);
  assert.equal(report.steadyState.advances, 16);
  assert.equal(report.coldStart.elapsedWallMs, 108);
  assert.equal(report.steadyState.elapsedWallMs, 1900);
  assert.equal(report.steadyState.wallMs, 1900);
  assert.equal(report.steadyState.realtimeRatio, 0.5389);
});

test('paused dt=0 frames neither satisfy the baseline nor pollute phases or windows', async () => {
  const recorder = makeRecorderAt(100);
  recorder.start({ warmupMs: 512, windowMs: 1024 });
  const measurement = recorder.editorMeasurement;
  assert.ok(measurement);

  // A paused frame at simTime=0 used to satisfy the baseline check.
  measurement.advanceStart?.();
  measurement.advance(
    advanceSample({
      sequence: 1,
      startedAt: 100,
      completedAt: 180,
      simTime: 0,
      dt: 0,
      tickMs: undefined,
      running: false,
    }),
  );
  measurement.advanceSettled?.();
  assert.equal(recorder.report().phase, 'warmup');
  assert.equal(recorder.report().raw.advances.length, 0);

  // A paused frame beyond the window end used to advance the phase and stop the run early.
  measurement.advanceStart?.();
  measurement.advance(
    advanceSample({
      sequence: 2,
      startedAt: 200,
      completedAt: 240,
      simTime: 1536 * MS,
      dt: 0,
      tickMs: undefined,
      running: false,
    }),
  );
  measurement.advanceSettled?.();
  assert.equal(recorder.report().phase, 'warmup');
  assert.equal(recorder.report().raw.advances.length, 0);

  // The first real tick starts at 64 simulated ms; the baseline must reject it.
  measurement.advanceStart?.();
  measurement.advance(
    advanceSample({
      sequence: 3,
      startedAt: 300,
      completedAt: 308,
      simTime: 128 * MS,
      dt: 64 * MS,
    }),
  );
  measurement.advanceSettled?.();
  const report = await recorder.stop();

  assert.equal(report.raw.advances.length, 1);
  assert.equal(report.controls.complete, false);
  assert.match(report.controls.incompleteReason, /started at 64 simulated ms, not 0/);
});

test('rejects start while running or stopping and restarts only after stop settles', async () => {
  const recorder = makeRecorder();
  recorder.start({ warmupMs: 512, windowMs: 1024 });
  const measurement = recorder.editorMeasurement;
  assert.ok(measurement);

  // A second start while the first measurement is live must not clear its buffers.
  assert.throws(() => recorder.start(), /already running; await stop\(\)/);

  measurement.advanceStart?.();
  const stopping = recorder.stop();
  assert.throws(() => recorder.start(), /stopping; await the pending stop\(\)/);
  measurement.advance(
    advanceSample({
      sequence: 1,
      startedAt: 100,
      tickCompletedAt: 105,
      completedAt: 108,
      tickMs: 5,
      widgetMs: 3,
      simTime: 64 * MS,
    }),
  );
  measurement.advanceSettled?.();
  const report = await stopping;

  assert.equal(report.phase, 'stopped');
  assert.equal(report.raw.advances.length, 1);

  recorder.start({ warmupMs: 0, windowMs: 0 });
  assert.equal(recorder.report().phase, 'window');
  assert.equal(recorder.report().raw.advances.length, 0);
  const restarted = await recorder.stop();
  assert.equal(restarted.controls.warmupSimMs, 0);
});

test('rejects start while an observer advance is in flight', async () => {
  const recorder = makeRecorder();
  const measurement = recorder.editorMeasurement;
  assert.ok(measurement);

  measurement.advanceStart?.();
  assert.throws(() => recorder.start(), /advance is still in flight/);
  measurement.advanceSettled?.();

  recorder.start({ warmupMs: 0, windowMs: 0 });
  assert.equal(recorder.report().phase, 'window');
  await recorder.stop();
});

test('keeps the steady wall anchor when the ring evicts all warmup records', async () => {
  const recorder = makeRecorderAt(1000, 16);
  recorder.start({ warmupMs: 512, windowMs: 1024 });
  const measurement = recorder.editorMeasurement;
  assert.ok(measurement);

  // 24 ticks: the ring keeps the 16 steady ticks and evicts all 8 warmup ticks.
  let wall = 1000;
  for (let index = 1; index <= 24; index += 1) {
    measurement.advanceStart?.();
    measurement.advance(
      advanceSample({
        sequence: index,
        startedAt: wall,
        tickCompletedAt: wall + 5,
        completedAt: wall + 8,
        tickMs: 5,
        widgetMs: 3,
        simTime: index * 64 * MS,
      }),
    );
    measurement.advanceSettled?.();
    wall += 100;
  }
  const report = await recorder.stop();

  assert.equal(report.buffers.capacity, 16);
  assert.equal(report.buffers.advances.retained, 16);
  assert.equal(report.buffers.advances.dropped, 8);
  assert.equal(report.raw.advances.length, 16);
  assert.equal(report.raw.advances[0].simTime, 576 * MS);
  assert.equal(report.controls.complete, true);
  assert.equal(report.controls.incompleteReason, null);
  assert.equal(report.coldStart.advances, 0);
  assert.equal(report.steadyState.advances, 16);
  assert.equal(report.steadyState.sim.fromPs, 512 * MS);
  assert.equal(report.steadyState.sim.toPs, 1536 * MS);
  // Tick 8 completed at 1708 and tick 24 at 3308. Falling back to start() (1000) would report
  // 2308 and mix the cold start into steady-state wall time.
  assert.equal(report.steadyState.elapsedWallMs, 1600);
  assert.equal(report.steadyState.realtimeRatio, 0.64);
  assert.ok(report.warnings.some((warning) => warning.includes('dropped')));
});

test('does not claim a complete window when a middle steady advance is missing', async () => {
  const recorder = makeRecorderAt(1000, 64);
  recorder.start({ warmupMs: 512, windowMs: 1024 });
  const measurement = recorder.editorMeasurement;
  assert.ok(measurement);

  let wall = 1000;
  for (let index = 1; index <= 24; index += 1) {
    if (index === 16) {
      wall += 100;
      continue;
    }
    measurement.advanceStart?.();
    measurement.advance(
      advanceSample({
        sequence: index,
        startedAt: wall,
        tickCompletedAt: wall + 5,
        completedAt: wall + 8,
        tickMs: 5,
        widgetMs: 3,
        simTime: index * 64 * MS,
      }),
    );
    measurement.advanceSettled?.();
    wall += 100;
  }
  const report = await recorder.stop();

  assert.equal(report.raw.advances.length, 23);
  assert.equal(report.steadyState.advances, 15);
  assert.equal(report.controls.complete, false);
  assert.match(report.controls.incompleteReason, /not contiguous/);
  // The retained endpoints still line up; only the missing middle round exposes the gap.
  assert.equal(report.steadyState.sim.fromPs, 512 * MS);
  assert.equal(report.steadyState.sim.toPs, 1536 * MS);
});

test('does not claim a complete window when the ring evicts a steady advance', async () => {
  const recorder = makeRecorderAt(1000, 15);
  recorder.start({ warmupMs: 512, windowMs: 1024 });
  const measurement = recorder.editorMeasurement;
  assert.ok(measurement);

  let wall = 1000;
  for (let index = 1; index <= 24; index += 1) {
    measurement.advanceStart?.();
    measurement.advance(
      advanceSample({
        sequence: index,
        startedAt: wall,
        tickCompletedAt: wall + 5,
        completedAt: wall + 8,
        tickMs: 5,
        widgetMs: 3,
        simTime: index * 64 * MS,
      }),
    );
    measurement.advanceSettled?.();
    wall += 100;
  }
  const report = await recorder.stop();

  assert.equal(report.buffers.advances.retained, 15);
  assert.equal(report.buffers.advances.dropped, 9);
  assert.equal(report.steadyState.advances, 15);
  assert.equal(report.steadyState.sim.fromPs, 576 * MS);
  assert.equal(report.controls.complete, false);
  assert.match(report.controls.incompleteReason, /evicted/);
});
