import { describe, it } from 'vitest';
import { Circuit } from './circuit';
import { mcuLedInput } from './test-helpers';

/**
 * U02 performance observations: batch throughput, single-step cost and
 * creation time on the two-device MCU + LED scene.
 *
 * This file only *reports* numbers: there are no thresholds and no assertions,
 * because performance must never decide whether a test run passes. It is
 * excluded from `pnpm test` and runs on demand with `pnpm test:perf`.
 *
 * Every measurement warms the compiled loop first and keeps the best round of
 * a short series, so a scheduling hiccup does not distort the reported number.
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
  it('reports creation time', async () => {
    const start = performance.now();
    const circuit = await Circuit.create(mcuLedInput());
    const elapsedMs = performance.now() - start;

    console.log(`create: ${elapsedMs.toFixed(2)} ms, tickCount=${circuit.tickCount.toString()}`);
  });

  it('reports batch throughput', async () => {
    const circuit = await Circuit.create(mcuLedInput());
    // Tier the generated loop up before timing it.
    circuit.runBatch(10_000);

    const bestMs = bestRound(() => circuit.runBatch(BATCH_TICKS), BATCH_ROUNDS);
    const throughput = BATCH_TICKS / (bestMs / 1000);

    console.log(
      `batch: ${(throughput / 1e6).toFixed(2)} M ticks/s (${((bestMs * 1e6) / BATCH_TICKS).toFixed(0)} ns/tick), ` +
        `tickCount=${circuit.tickCount.toString()}`,
    );
  });

  it('reports single-step cost', async () => {
    const circuit = await Circuit.create(mcuLedInput());
    for (let index = 0; index < 2_000; index += 1) circuit.step();

    const bestMs = bestRound(() => {
      for (let index = 0; index < STEP_TICKS; index += 1) circuit.step();
    }, STEP_ROUNDS);
    const averageNs = (bestMs * 1e6) / STEP_TICKS;

    console.log(`step: ${averageNs.toFixed(0)} ns/step`);
  });
});
