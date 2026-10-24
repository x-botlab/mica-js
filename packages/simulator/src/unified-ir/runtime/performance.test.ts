import { describe, expect, it } from 'vitest';
import { Circuit } from './circuit';
import { mcuLedInput } from './test-helpers';

/**
 * U02 performance targets:
 * - batch throughput above 1 M ticks/s on the two-device MCU + LED scene,
 * - single-step entry below 1 µs,
 * - creation (compile + validate + JIT) below 500 ms.
 *
 * Every measurement warms the compiled loop first and keeps the best round of
 * a short series, so a scheduling hiccup on a busy CI machine cannot fail the
 * suite while the reported number stays the achievable one.
 */
const BATCH_TICKS = 1_000_000;
const BATCH_ROUNDS = 5;
const STEP_TICKS = 2_000;
const STEP_ROUNDS = 20;

function bestRound(run: () => void, rounds: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let round = 0; round < rounds; round += 1) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

describe('Circuit performance', () => {
  it('creates a two-device circuit in under 500 ms', async () => {
    const start = performance.now();
    const circuit = await Circuit.create(mcuLedInput());
    const elapsedMs = performance.now() - start;

    console.log(`create: ${elapsedMs.toFixed(2)} ms`);
    expect(elapsedMs).toBeLessThan(500);
    expect(circuit.tickCount).toBe(0n);
  });

  it('batches more than 1M ticks per second', async () => {
    const circuit = await Circuit.create(mcuLedInput());
    // Tier the generated loop up before timing it.
    circuit.runBatch(10_000);

    const bestMs = bestRound(() => circuit.runBatch(BATCH_TICKS), BATCH_ROUNDS);
    const throughput = BATCH_TICKS / (bestMs / 1000);

    console.log(
      `batch: ${(throughput / 1e6).toFixed(2)} M ticks/s (${((bestMs * 1e6) / BATCH_TICKS).toFixed(0)} ns/tick)`,
    );
    expect(throughput).toBeGreaterThan(1_000_000);
    expect(circuit.tickCount).toBe(BigInt(10_000 + BATCH_TICKS * BATCH_ROUNDS));
  });

  it('steps in under 1 µs on average', async () => {
    const circuit = await Circuit.create(mcuLedInput());
    for (let index = 0; index < 2_000; index += 1) circuit.step();

    const bestMs = bestRound(() => {
      for (let index = 0; index < STEP_TICKS; index += 1) circuit.step();
    }, STEP_ROUNDS);
    const averageNs = (bestMs * 1e6) / STEP_TICKS;

    console.log(`step: ${averageNs.toFixed(0)} ns/step`);
    expect(averageNs).toBeLessThan(1_000);
  });
});
