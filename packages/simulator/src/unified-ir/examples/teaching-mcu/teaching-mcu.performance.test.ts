/**
 * U03 performance observations.
 *
 * Compares the unified-IR teaching MCU against the current scheduler-based
 * device (`packages/device/examples/teaching-mcu`) using the same legacy
 * firmware and the same `@mica-js/core` scheduler host.
 *
 * The batch path is the throughput path: it runs an entire instruction slice
 * inside one engine call. The single-step path is the debugging path and is
 * reported separately.
 *
 * This file only reports numbers: there are no thresholds and no assertions,
 * because performance must never decide whether a test run passes. It is
 * excluded from `pnpm test` and runs on demand with `pnpm test:perf`.
 */
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createScheduler } from '@mica-js/core';
import {
  createDeviceInstance,
  loadDeviceModule,
  parseDeviceDescription,
  type DevicePinHost,
  type IDeviceProvider,
} from '@mica-js/device';
import { createIRJIT } from '@mica-js/ir';
import { describe, it } from 'vitest';
import { jitInternals } from '../../../../../ir/src/jit-runtime';
import { createTeachingMCUIR, type TeachingMCUISAType } from './index';
import { loopFirmware } from './teaching-mcu.test-helpers';

const EXAMPLE = new URL('../../../../../device/examples/teaching-mcu/', import.meta.url);
const MODEL = Object.freeze({
  kind: 'ideal-voltage' as const,
  minVoltage: 0,
  maxVoltage: 5,
  lowVoltage: 0,
  highVoltage: 5,
});

function exampleProvider(): IDeviceProvider {
  return {
    async resolve(deviceId: string) {
      if (deviceId !== 'mica:teaching-mcu') return undefined;
      const description = JSON.parse(
        await readFile(new URL('teaching-mcu.json', EXAMPLE), 'utf8'),
      ) as Record<string, unknown>;
      return {
        definition: parseDeviceDescription(description, { name: deviceId }),
        code: await readFile(new URL('teaching-mcu.js', EXAMPLE), 'utf8'),
      };
    },
  };
}

function hostStub(): DevicePinHost {
  return {
    pinIntent: (pin) => ({
      instanceId: pin.instanceId,
      pinName: pin.pinName,
      powerReady: true,
      mode: 'high-z',
      outputEnabled: false,
      pull: 'none',
      model: MODEL,
    }),
    updatePinStates: () => {},
    sampleDigital: () => ({ value: 0, ready: true, source: 'sampled' }),
  };
}

const LEGACY_FIRMWARE = Uint8Array.from([0x10, 1, 0x10, 2, 0x30, 8, 0x00, 0x00, 0x10, 4, 0x20, 0]);

async function measureLegacy(blocks: number): Promise<number> {
  const loaded = await loadDeviceModule('mica:teaching-mcu', exampleProvider());
  const scheduler = createScheduler();
  const device = createDeviceInstance(loaded, scheduler, {
    instanceId: 'mcu',
    pinHost: hostStub(),
  });
  scheduler.start({ until: 0 });
  if (device.state !== 'ready') {
    throw new Error(`legacy device did not reach the ready state (got "${device.state}")`);
  }
  const start = performance.now();
  scheduler.start({ until: blocks * 25_000 });
  const elapsed = performance.now() - start;
  device.destroy();
  return elapsed;
}

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

function createBatchRuntime(isa: TeachingMCUISAType): {
  readonly device: ReturnType<typeof createTeachingMCUIR>;
  readonly jit: ReturnType<typeof createIRJIT>;
  readonly context: { instanceId: string; virtualTime: number };
  readonly reset: () => void;
} {
  const firmware = isa === 'teaching' ? LEGACY_FIRMWARE : loopFirmware(60_000);
  const device = createTeachingMCUIR('mcu', {
    isa,
    firmware,
    ports: ['A'],
    portWidth: 1,
    instructionsPerTick: isa === 'teaching' ? 100_000 : 10_000_000,
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

function measureUnifiedBatch(isa: TeachingMCUISAType): UnifiedMeasurement {
  const { device, jit, context, reset } = createBatchRuntime(isa);
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
    isa: 'teaching',
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
  it('reports throughput against the scheduler-based device', { timeout: 60_000 }, async () => {
    const legacyBlocks = 10_000;
    const legacyMilliseconds = await measureLegacy(legacyBlocks);
    // The legacy firmware alternates 3-instruction and 2-instruction blocks.
    const legacyInstructions = legacyBlocks * 2.5;
    const legacyRate = legacyInstructions / (legacyMilliseconds / 1000);

    const teachingBatch = measureUnifiedBatch('teaching');
    const teachingRate = teachingBatch.instructions / (teachingBatch.milliseconds / 1000);
    const teachingSpeedup = teachingRate / legacyRate;

    const m3Batch = measureUnifiedBatch('m3');
    const m3Rate = m3Batch.instructions / (m3Batch.milliseconds / 1000);
    const m3Speedup = m3Rate / legacyRate;

    const steps = measureUnifiedSteps(100_000);
    const stepRate = steps.instructions / (steps.milliseconds / 1000);
    const stepSpeedup = stepRate / legacyRate;
    const stepNanoseconds = (steps.milliseconds * 1e6) / 100_000;

    console.log(
      [
        `legacy scheduler: ${(legacyRate / 1e6).toFixed(3)} M inst/s (${legacyMilliseconds.toFixed(1)} ms, ${legacyBlocks} blocks)`,
        `unified teaching batch: ${(teachingRate / 1e6).toFixed(2)} M inst/s (${teachingSpeedup.toFixed(1)}x), cold ${(teachingBatch.instructions / (teachingBatch.coldMilliseconds / 1000) / 1e6).toFixed(2)} M inst/s, ${teachingBatch.units} unit(s), ${teachingBatch.dispatchesPerTick.toFixed(2)} dispatches/tick`,
        `unified M3 batch: ${(m3Rate / 1e6).toFixed(2)} M inst/s (${m3Speedup.toFixed(1)}x), cold ${(m3Batch.instructions / (m3Batch.coldMilliseconds / 1000) / 1e6).toFixed(2)} M inst/s, ${m3Batch.units} unit(s), ${m3Batch.dispatchesPerTick.toFixed(2)} dispatches/tick`,
        `unified teaching single-step: ${(stepRate / 1e6).toFixed(2)} M inst/s (${stepSpeedup.toFixed(1)}x), ${stepNanoseconds.toFixed(0)} ns/tick`,
      ].join('\n'),
    );

    // No thresholds: the numbers above are observations. Correctness of the
    // device is covered by teaching-mcu.test.ts / teaching-mcu.integration.test.ts.
  });
});
