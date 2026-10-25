/**
 * Region dispatch diagnostics for the teaching MCU example.
 *
 * The provider translates one guest basic block per artifact, so a guest loop
 * pays a host dispatch at every block boundary unless the engine's region
 * compiler fuses the hot dispatch chain. This test reports where the dispatches
 * go with regions on and off, which turns a region-formation regression into an
 * explicit dispatch count instead of only a slower benchmark.
 *
 * Measured shapes (M3 tight loop, three blocks per tick):
 * - regions on : one region over the whole chain, 1.00 dispatch per tick.
 * - regions off : the loop still runs inside one artifact (the backward branch
 *   is a self-loop), but the prologue and halt boundaries stay dispatches,
 *   so 3.00 dispatches per tick.
 */
import { createIRJIT } from '@mica-js/ir';
import { describe, expect, it } from 'vitest';
import { jitInternals } from '../../../../../ir/src/jit-runtime';
import { createTeachingMCUIR } from './index';
import { loopFirmware } from './teaching-mcu.test-helpers';

const WARMUP_TICKS = 1000;
const MEASURED_TICKS = 30;

interface DispatchCounts {
  readonly icHits: number;
  readonly jumpHits: number;
  readonly icMisses: number;
  readonly regions: number;
  readonly regionMembers: number;
  readonly units: number;
}

function measure(regions: boolean): DispatchCounts {
  const device = createTeachingMCUIR(`diag_${regions ? 'regions' : 'blocks'}`, {
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
  const context = { instanceId: 'region-debug', virtualTime: 0 };
  jit.execute(device.layout.entries.initialize, [], context);
  const reset = (): void => {
    jit.storage.storeState(device.layout.pc, 0);
    jit.storage.storeState(device.layout.cycles, 0);
    jit.storage.storeState(device.layout.sliceEnd, 0);
    jit.storage.storeState(device.layout.halted, false);
    jit.storage.storeState(device.layout.fault, false);
    jit.storage.storeState(device.layout.sleeping, false);
  };
  for (let index = 0; index < WARMUP_TICKS; index += 1) {
    reset();
    jit.execute(device.layout.entries.tick, [], context);
  }

  const internals = (jit as unknown as Record<symbol, Record<string, unknown>>)[jitInternals]!;
  const count = (name: string): number => (internals[name] as number | undefined) ?? 0;
  const before = {
    icHits: count('icHits'),
    jumpHits: count('jumpHits'),
    icMisses: count('icMisses'),
  };
  for (let index = 0; index < MEASURED_TICKS; index += 1) {
    reset();
    jit.execute(device.layout.entries.tick, [], context);
  }
  const source = internals.regionSource as string | undefined;
  const perTick = (value: number): number => value / MEASURED_TICKS;
  return Object.freeze({
    icHits: perTick(count('icHits') - before.icHits),
    jumpHits: perTick(count('jumpHits') - before.jumpHits),
    icMisses: perTick(count('icMisses') - before.icMisses),
    regions: count('regions'),
    regionMembers: source === undefined ? 0 : (source.match(/F = FS\[\d+\];/g) ?? []).length,
    units: count('compiledArtifacts'),
  });
}

describe('region dispatch diagnostics', () => {
  it('routes every tick through one region', () => {
    const fused = measure(true);
    const plain = measure(false);
    for (const [label, counts] of [
      ['regions on ', fused],
      ['regions off', plain],
    ] as const) {
      console.log(
        '%s: units=%d regions=%d members=%d dispatches/tick=%s (ic=%s jump=%s miss=%s)',
        label,
        counts.units,
        counts.regions,
        counts.regionMembers,
        (counts.icHits + counts.jumpHits + counts.icMisses).toFixed(2),
        counts.icHits.toFixed(2),
        counts.jumpHits.toFixed(2),
        counts.icMisses.toFixed(2),
      );
    }

    expect(fused.regions).toBeGreaterThanOrEqual(1);
    expect(fused.regionMembers).toBeGreaterThanOrEqual(1);
    expect(fused.icHits + fused.jumpHits + fused.icMisses).toBeCloseTo(1, 1);

    expect(plain.regions).toBe(0);
    expect(plain.icHits + plain.jumpHits + plain.icMisses).toBeCloseTo(3, 1);
  }, 240_000);
});
