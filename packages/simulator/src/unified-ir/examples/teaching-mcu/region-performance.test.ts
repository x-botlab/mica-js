/**
 * JIT region performance for the teaching MCU example.
 *
 * The provider translates exactly one guest basic block per artifact, so a
 * guest loop costs one dispatch per basic block unless the engine fuses the hot
 * dispatch chain. This benchmark pins the behaviour the example relies on: with
 * regions enabled, a warm M3 loop retires at one dispatch per tick and far above
 * the 72 MHz real-time budget.
 *
 * With `regions` disabled the same loop still runs inside one artifact (the
 * backward branch is a self-loop), but every block boundary in the tick becomes
 * a host dispatch: three per tick instead of one.
 */
import { performance } from 'node:perf_hooks';
import { createIRJIT } from '@mica-js/ir';
import { describe, expect, it } from 'vitest';
import { jitInternals } from '../../../../../ir/src/jit-runtime';
import { createTeachingMCUIR } from './index';
import { loopFirmware } from './teaching-mcu.test-helpers';

/** Real-time budget of the target classroom device: 72 MHz of guest code. */
const REALTIME_MINST_PER_SECOND = 72;
const WARMUP_TICKS = 2000;
const MEASURED_TICKS = 60;
const ROUNDS = 3;

interface Measurement {
  /** Median of the per-round median wall times. */
  readonly mips: number;
  readonly instructionsPerTick: number;
  readonly dispatchesPerTick: number;
  readonly regions: number;
  readonly units: number;
}

function measure(regions: boolean): Measurement {
  const device = createTeachingMCUIR(`region_${regions ? 'on' : 'off'}`, {
    isa: 'm3',
    firmware: loopFirmware(60_000),
    ports: ['A'],
    portWidth: 1,
    instructionsPerTick: 10_000_000,
    maxBlockInstructions: 4096,
  });
  const jit = createIRJIT(device.module, {
    validation: device.validation,
    maxSteps: Number.MAX_SAFE_INTEGER,
    jit: { optimizations: { regions } },
  });
  const context = { instanceId: 'region-perf', virtualTime: 0 };
  jit.execute(device.layout.entries.initialize, [], context);
  const reset = (): void => {
    jit.storage.storeState(device.layout.pc, 0);
    jit.storage.storeState(device.layout.cycles, 0);
    jit.storage.storeState(device.layout.sliceEnd, 0);
    jit.storage.storeState(device.layout.halted, false);
    jit.storage.storeState(device.layout.fault, false);
    jit.storage.storeState(device.layout.sleeping, false);
  };

  // Warmup: enough entries per artifact for `REGION_THRESHOLD` (500).
  for (let index = 0; index < WARMUP_TICKS; index += 1) {
    reset();
    jit.execute(device.layout.entries.tick, [], context);
  }

  const internals = (jit as unknown as Record<symbol, Record<string, number>>)[jitInternals]!;
  const dispatches = (): number => internals.icHits! + internals.icMisses! + internals.jumpHits!;
  const before = dispatches();
  const rates: number[] = [];
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
    rates.push(instructions / (samples[Math.floor(samples.length / 2)]! / 1000) / 1e6);
  }
  rates.sort((left, right) => left - right);

  return {
    mips: rates[Math.floor(rates.length / 2)]!,
    instructionsPerTick: instructions,
    dispatchesPerTick: (dispatches() - before) / (MEASURED_TICKS * ROUNDS),
    regions: internals.regions!,
    units: internals.compiledArtifacts!,
  };
}

describe('region performance', () => {
  it('fuses the hot dispatch chain with one dispatch per tick', () => {
    const withRegions = measure(true);
    const withoutRegions = measure(false);

    console.log(
      [
        `regions on : ${withRegions.mips.toFixed(1)} M inst/s, ${withRegions.units} unit(s), ` +
          `${withRegions.regions} region(s), ${withRegions.dispatchesPerTick.toFixed(2)} dispatches/tick`,
        `regions off: ${withoutRegions.mips.toFixed(1)} M inst/s, ${withoutRegions.units} unit(s), ` +
          `${withoutRegions.regions} region(s), ${withoutRegions.dispatchesPerTick.toFixed(2)} dispatches/tick`,
      ].join('\n'),
    );

    // The tick body is three blocks: prologue, guest loop, halt.
    expect(withRegions.instructionsPerTick).toBe(180_003);
    // One region covering all three blocks means one host dispatch per tick.
    expect(withRegions.regions).toBeGreaterThanOrEqual(1);
    expect(withRegions.dispatchesPerTick).toBeLessThanOrEqual(1.05);
    // The real-time budget must stay satisfied without provider-side fusion.
    expect(withRegions.mips).toBeGreaterThan(REALTIME_MINST_PER_SECOND);
    // Without regions every block boundary stays a dispatch.
    expect(withoutRegions.dispatchesPerTick).toBeGreaterThan(1.5);
  }, 300_000);
});
