/**
 * U03 performance validation.
 *
 * Compares the unified-IR teaching MCU against the current scheduler-based
 * device (`packages/device/examples/teaching-mcu`) using the same legacy
 * firmware and the same `@mica-js/core` scheduler host.
 *
 * The batch path is the throughput path: it runs an entire instruction slice
 * inside one engine call. A warmed unified JIT sits far above the 10× target;
 * the single-step path is the debugging path and is reported separately.
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
import { describe, expect, it } from 'vitest';
import { jitInternals } from '../../../../../ir/src/jit-runtime';
import { createTeachingMCUIR, RAM_BASE, type TeachingMCUISAType } from './index';
import { loopFirmware, wordsToBytes, encodeI, encodeR, Op } from './teaching-mcu.test-helpers';

/** Real-time budget of the target classroom device: 72 MHz of guest code. */
const REALTIME_MINST_PER_SECOND = 72;
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
  expect(device.state).toBe('ready');
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

/** Ticks executed before the measured batch (V8 tiering, artifact caches). */
const WARMUP_TICKS = 12;
/** Timed ticks; the median is reported so one GC pause cannot dominate. */
const MEASURED_TICKS = 24;

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

  const samples: number[] = [];
  let instructions = 0;
  for (let index = 0; index < MEASURED_TICKS; index += 1) {
    reset();
    const start = performance.now();
    jit.execute(device.layout.entries.tick, [], context);
    samples.push(performance.now() - start);
    instructions = Number(jit.storage.loadState(device.layout.cycles));
  }
  const dispatchesAfter =
    (internals?.icHits ?? 0) + (internals?.icMisses ?? 0) + (internals?.jumpHits ?? 0);
  samples.sort((left, right) => left - right);
  return Object.freeze({
    milliseconds: samples[Math.floor(samples.length / 2)]!,
    instructions,
    coldMilliseconds,
    units: internals?.compiledArtifacts ?? 0,
    dispatchesPerTick: (dispatchesAfter - dispatchesBefore) / MEASURED_TICKS,
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
  it('beats the scheduler-based device by more than 10x on the batch path', async () => {
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

    expect(teachingSpeedup).toBeGreaterThan(10);
    expect(m3Speedup).toBeGreaterThan(10);
    expect(teachingBatch.instructions).toBeGreaterThan(50_000);
    expect(m3Batch.instructions).toBeGreaterThan(100_000);
    // Real-time emulation budget: 72 M guest instructions per second.
    expect(teachingRate).toBeGreaterThan(REALTIME_MINST_PER_SECOND * 1e6);
    expect(m3Rate).toBeGreaterThan(REALTIME_MINST_PER_SECOND * 1e6);
    // Single-step is the debugging path; it must still beat the scheduler.
    expect(stepSpeedup).toBeGreaterThan(1.5);
    // One translated unit per guest loop, entered once per tick: the unit cache
    // is warm for every measured tick (>99% hit rate).
    expect(m3Batch.units).toBe(1);
    expect(m3Batch.dispatchesPerTick).toBeLessThanOrEqual(1.05);
    expect(teachingBatch.dispatchesPerTick).toBeLessThanOrEqual(1.05);
    // Guard against a regression that makes the measurement nonsense.
    expect(teachingBatch.milliseconds).toBeGreaterThan(0);
  }, 60_000);

  it('executes a RAM-heavy M3 workload at batch speed', () => {
    const firmware = wordsToBytes([
      encodeI(Op.MOVI, 1, 0, 0x0000),
      encodeI(Op.MOVT, 1, 0, 0x2000),
      encodeI(Op.MOVI, 0, 0, 0x55),
      encodeI(Op.STR, 0, 1, 0),
      encodeI(Op.LDR, 2, 1, 0),
      encodeR(Op.HALT, 0, 0, 0),
    ]);
    const device = createTeachingMCUIR('mcu', {
      isa: 'm3',
      firmware,
      ports: ['A'],
      portWidth: 1,
    });
    const jit = createIRJIT(device.module, {
      validation: device.validation,
      maxSteps: Number.MAX_SAFE_INTEGER,
    });
    const context = { instanceId: 'ram-perf', virtualTime: 0 };
    jit.execute(device.layout.entries.initialize, [], context);
    const accessor = device.buildAccessor(jit.storage, {
      step: () => jit.execute(device.layout.entries.tick, [], context),
    });
    accessor.step(6);
    expect(accessor.readRegister('r2')).toBe(0x55n);
    expect(accessor.readMemory(RAM_BASE, 4)).toBe(0x55);
  });
});
