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
import { createTeachingMCUIR, RAM_BASE, type TeachingMCUISAType } from './index';
import { loopFirmware, wordsToBytes, encodeI, encodeR, Op } from './teaching-mcu.test-helpers';
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
  readonly milliseconds: number;
  readonly instructions: number;
}

function measureUnifiedBatch(isa: TeachingMCUISAType): UnifiedMeasurement {
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
  // Warm every translated block, then restore the machine.
  jit.execute(device.layout.entries.tick, [], context);
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

  const start = performance.now();
  jit.execute(device.layout.entries.tick, [], context);
  const milliseconds = performance.now() - start;
  const instructions = Number(jit.storage.loadState(device.layout.cycles));
  return Object.freeze({ milliseconds, instructions });
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
  for (let index = 0; index < 2; index += 1) {
    jit.execute(device.layout.entries.tick, [], context);
  }
  jit.storage.storeState(device.layout.cycles, 0);
  const start = performance.now();
  for (let index = 0; index < ticks; index += 1) {
    jit.execute(device.layout.entries.tick, [], context);
  }
  const milliseconds = performance.now() - start;
  const instructions = Number(jit.storage.loadState(device.layout.cycles));
  return Object.freeze({ milliseconds, instructions });
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

    const steps = measureUnifiedSteps(20_000);
    const stepRate = steps.instructions / (steps.milliseconds / 1000);
    const stepSpeedup = stepRate / legacyRate;

    console.log(
      [
        `legacy scheduler: ${(legacyRate / 1e6).toFixed(3)} M inst/s (${legacyMilliseconds.toFixed(1)} ms, ${legacyBlocks} blocks)`,
        `unified teaching batch: ${(teachingRate / 1e6).toFixed(2)} M inst/s (${teachingSpeedup.toFixed(1)}x)`,
        `unified M3 batch: ${(m3Rate / 1e6).toFixed(2)} M inst/s (${m3Speedup.toFixed(1)}x)`,
        `unified teaching single-step: ${(stepRate / 1e6).toFixed(2)} M inst/s (${stepSpeedup.toFixed(1)}x)`,
      ].join('\n'),
    );

    expect(teachingSpeedup).toBeGreaterThan(10);
    expect(m3Speedup).toBeGreaterThan(10);
    expect(teachingBatch.instructions).toBeGreaterThan(50_000);
    expect(m3Batch.instructions).toBeGreaterThan(100_000);
    // Single-step is the debugging path; it must still beat the scheduler.
    expect(stepSpeedup).toBeGreaterThan(1.5);
    // Guard against a regression that makes the measurement nonsense.
    expect(teachingBatch.milliseconds).toBeGreaterThan(0);
  }, 30_000);

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
