/**
 * U03 performance observations.
 *
 * The batch path is the throughput path: it runs an entire instruction slice
 * inside one engine call. The single-step path is the debugging path and is
 * reported separately.
 *
 * This file only reports numbers: there are no thresholds and no assertions,
 * because performance must never decide whether a test run passes. It is
 * excluded from `pnpm test` and runs on demand with `pnpm test:perf`.
 */
import { performance } from 'node:perf_hooks';
import { createIRJIT } from '@mica-js/ir';
import { describe, it } from 'vitest';
import { jitInternals } from '../../../../../ir/src/jit-runtime';
import { createTeachingMCUIR } from './index';
import { loopFirmware } from './teaching-mcu.test-helpers';

interface UnifiedMeasurement {
  /** Median wall time of one batch tick once the host has warmed up. */
  readonly milliseconds: number;
  /** Retired guest instructions in one batch tick. */
  readonly instructions: number;
  /** Wall time of the very first tick of a fresh instance (cold host code). */
  readonly coldMilliseconds: number;
  /** Translated units the provider built, and dispatch-site lookups per tick. */
  readonly units: number;
  readonly dispatchesPerTick: number;
}

/**
 * Ticks executed before the measured batch (V8 tiering, artifact caches and
 * region formation: `REGION_THRESHOLD` is 500 artifact entries).
 */
const WARMUP_TICKS = 1000;
/** Timed ticks per round; the median is reported so one GC pause cannot dominate. */
const MEASURED_TICKS = 24;
/**
 * Rounds of {@link MEASURED_TICKS} timed ticks. The reported time is the
 * *fastest* round's median: the workload is deterministic, so a slower round
 * only means the host was busy with something else (this file shares a machine
 * with the rest of the suite). Peak throughput is the property under test.
 */
const ROUNDS = 3;

function createBatchRuntime(): {
  readonly device: ReturnType<typeof createTeachingMCUIR>;
  readonly jit: ReturnType<typeof createIRJIT>;
  readonly context: { instanceId: string; virtualTime: number };
  readonly reset: () => void;
} {
  const device = createTeachingMCUIR('mcu', {
    firmware: loopFirmware(60_000),
    ports: ['A'],
    portWidth: 1,
    instructionsPerTick: 10_000_000,
    maxBlockInstructions: 4096,
  });
  const jit = createIRJIT(device.module, {
    validation: device.validation,
    maxSteps: Number.MAX_SAFE_INTEGER,
  });
  const context = { instanceId: 'perf', virtualTime: 0 };
  jit.execute(device.layout.entries.initialize, [], context);
  // Every batch tick starts from the same machine state, so the measured work
  // is identical no matter how many ticks ran before it.
  const reset = (): void => {
    jit.storage.storeState(device.layout.pc, 0);
    jit.storage.storeState(device.layout.cycles, 0);
    jit.storage.storeState(device.layout.sliceEnd, 0);
    jit.storage.storeState(device.layout.halted, false);
    jit.storage.storeState(device.layout.fault, false);
    jit.storage.storeState(device.layout.sleeping, false);
    jit.storage.storeState(device.layout.flags.n, false);
    jit.storage.storeState(device.layout.flags.z, false);
    jit.storage.storeState(device.layout.flags.c, false);
    jit.storage.storeState(device.layout.flags.v, false);
    jit.storage.storeArray(device.layout.registers, 1, 0);
    jit.storage.storeArray(device.layout.registers, 2, 0);
    jit.storage.storeArray(device.layout.registers, 3, 0);
    jit.storage.storeArray(device.layout.registers, 0, 0);
  };
  return { device, jit, context, reset };
}

function measureUnifiedBatch(): UnifiedMeasurement {
  const { device, jit, context, reset } = createBatchRuntime();
  reset();
  const coldStart = performance.now();
  jit.execute(device.layout.entries.tick, [], context);
  const coldMilliseconds = performance.now() - coldStart;
  const internals = (jit as unknown as Record<symbol, Record<string, number>>)[jitInternals];

  for (let index = 0; index < WARMUP_TICKS; index += 1) {
    reset();
    jit.execute(device.layout.entries.tick, [], context);
  }
  const dispatchesBefore =
    (internals?.icHits ?? 0) + (internals?.icMisses ?? 0) + (internals?.jumpHits ?? 0);

  const rounds: number[] = [];
  let instructions = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    const samples: number[] = [];
    for (let index = 0; index < MEASURED_TICKS; index += 1) {
      reset();
      const start = performance.now();
      jit.execute(device.layout.entries.tick, [], context);
      samples.push(performance.now() - start);
      instructions = Number(jit.storage.loadState(device.layout.cycles));
    }
    samples.sort((left, right) => left - right);
    rounds.push(samples[Math.floor(samples.length / 2)]!);
  }
  const dispatchesAfter =
    (internals?.icHits ?? 0) + (internals?.icMisses ?? 0) + (internals?.jumpHits ?? 0);
  return Object.freeze({
    milliseconds: Math.min(...rounds),
    instructions,
    coldMilliseconds,
    units: internals?.compiledArtifacts ?? 0,
    dispatchesPerTick: (dispatchesAfter - dispatchesBefore) / (MEASURED_TICKS * ROUNDS),
  });
}

function measureUnifiedSteps(ticks: number): UnifiedMeasurement {
  const device = createTeachingMCUIR('mcu', {
    firmware: loopFirmware(60_000),
    ports: ['A'],
    portWidth: 1,
    instructionsPerTick: 1,
  });
  const jit = createIRJIT(device.module, {
    validation: device.validation,
    maxSteps: Number.MAX_SAFE_INTEGER,
  });
  const context = { instanceId: 'perf-step', virtualTime: 0 };
  jit.execute(device.layout.entries.initialize, [], context);
  for (let index = 0; index < 2_000; index += 1) {
    jit.execute(device.layout.entries.tick, [], context);
  }
  jit.storage.storeState(device.layout.cycles, 0);
  const start = performance.now();
  for (let index = 0; index < ticks; index += 1) {
    jit.execute(device.layout.entries.tick, [], context);
  }
  const milliseconds = performance.now() - start;
  const instructions = Number(jit.storage.loadState(device.layout.cycles));
  return Object.freeze({
    milliseconds,
    instructions,
    coldMilliseconds: 0,
    units: 0,
    dispatchesPerTick: 0,
  });
}

describe('teaching MCU performance', () => {
  it('reports M3 batch and single-step throughput', { timeout: 60_000 }, () => {
    const batch = measureUnifiedBatch();
    const batchRate = batch.instructions / (batch.milliseconds / 1000);
    const coldRate = batch.instructions / (batch.coldMilliseconds / 1000);

    const steps = measureUnifiedSteps(100_000);
    const stepRate = steps.instructions / (steps.milliseconds / 1000);
    const stepNanoseconds = (steps.milliseconds * 1e6) / 100_000;

    console.log(
      [
        `M3 batch: ${(batchRate / 1e6).toFixed(2)} M inst/s, cold ${(coldRate / 1e6).toFixed(2)} M inst/s, ${batch.units} unit(s), ${batch.dispatchesPerTick.toFixed(2)} dispatches/tick`,
        `M3 single-step: ${(stepRate / 1e6).toFixed(2)} M inst/s, ${stepNanoseconds.toFixed(0)} ns/tick`,
      ].join('\n'),
    );

    // No thresholds: the numbers above are observations. Correctness of the
    // device is covered by teaching-mcu.test.ts / teaching-mcu.integration.test.ts.
  });
});
