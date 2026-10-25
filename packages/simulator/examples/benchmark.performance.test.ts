/**
 * Benchmark example performance observation.
 *
 * Runs the documented benchmark example at its full size and prints the
 * throughput it measured.
 *
 * This file only reports numbers: there are no thresholds and no assertions,
 * because performance must never decide whether a test run passes. It is
 * excluded from `pnpm test` and runs on demand with `pnpm test:perf`.
 */
import { describe, it } from 'vitest';
import { run as runBenchmark } from './benchmark';

describe('benchmark example performance', () => {
  it('reports batch throughput', async () => {
    const result = await runBenchmark(1_000_000, 2);
    console.log(
      `benchmark: ${(result.ticksPerSecond / 1_000_000).toFixed(1)} M ticks/s ` +
        `(${result.nsPerTick.toFixed(1)} ns/tick)`,
    );
  });
});
