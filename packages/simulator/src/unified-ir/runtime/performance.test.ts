import { createTestCircuit } from '../compiler/test-helpers';
import { describe, expect, it } from 'vitest';
import { driverSinkInput } from './test-helpers';

/** Resistive runtime smoke budgets; detailed throughput lives in bench/. */
const BATCH_TICKS = 10_000;
const BATCH_ROUNDS = 5;
const STEP_TICKS = 2_000;
const STEP_ROUNDS = 3;

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
  it('creates a two-device circuit within the resistive compile budget', async () => {
    const start = performance.now();
    const circuit = await createTestCircuit(driverSinkInput());
    const elapsedMs = performance.now() - start;

    console.log(`create: ${elapsedMs.toFixed(2)} ms`);
    expect(elapsedMs).toBeLessThan(5_000);
    expect(circuit.tickCount).toBe(0n);
  });

  it('batches a changing physical network', async () => {
    const circuit = await createTestCircuit(driverSinkInput());
    // Tier the generated loop up before timing it.
    circuit.runBatch(10_000);

    const bestMs = bestRound(() => circuit.runBatch(BATCH_TICKS), BATCH_ROUNDS);
    const throughput = BATCH_TICKS / (bestMs / 1000);

    console.log(
      `batch: ${(throughput / 1e6).toFixed(2)} M ticks/s (${((bestMs * 1e6) / BATCH_TICKS).toFixed(0)} ns/tick)`,
    );
    expect(throughput).toBeGreaterThan(10_000);
    expect(circuit.tickCount).toBe(BigInt(10_000 + BATCH_TICKS * BATCH_ROUNDS));
  });

  it('steps a changing physical network', async () => {
    const circuit = await createTestCircuit(driverSinkInput());
    for (let index = 0; index < 2_000; index += 1) circuit.step();

    const bestMs = bestRound(() => {
      for (let index = 0; index < STEP_TICKS; index += 1) circuit.step();
    }, STEP_ROUNDS);
    const averageNs = (bestMs * 1e6) / STEP_TICKS;

    console.log(`step: ${averageNs.toFixed(0)} ns/step`);
    expect(averageNs).toBeLessThan(1_000_000);
  });
});
