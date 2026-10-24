/**
 * Example: measure batched throughput of one compiled circuit.
 *
 * `runBatch(n)` keeps the loop inside the generated module, so the whole batch
 * costs one engine call. That is the throughput path; `step()` is for debugging.
 */
import { Circuit, createLedIR, createMcuDescription, LED_IR_TYPE } from '../src/index';

/** Throughput measured by {@link run}. */
export interface BenchmarkResult {
  /** Ticks per measured batch. */
  readonly ticks: number;
  /** Best-of-`repeats` throughput in ticks per second. */
  readonly ticksPerSecond: number;
  /** Nanoseconds per tick implied by the best run. */
  readonly nsPerTick: number;
}

const now = (): number => performance.now();

/**
 * Warms the JIT, then times `repeats` batches of `ticks` ticks each.
 *
 * @param ticks - Ticks per measured batch (default 5,000,000).
 * @param repeats - Measured batches; the fastest one is reported.
 */
export async function run(ticks = 5_000_000, repeats = 3): Promise<BenchmarkResult> {
  const lamp = createLedIR('led1');
  const circuit = await Circuit.create({
    devices: [
      { id: 'mcu1', type: 'mcu', description: createMcuDescription() },
      { id: 'led1', type: LED_IR_TYPE, description: lamp.device.description },
    ],
    connections: [
      { from: 'mcu1.PA0', to: 'led1.anode' },
      { from: 'led1.cathode', to: 'GND' },
    ],
  });

  try {
    circuit.runBatch(200_000); // tier-up and warm caches outside the measurement

    let bestNs = Number.POSITIVE_INFINITY;
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const started = now();
      circuit.runBatch(ticks);
      const elapsedMs = now() - started;
      bestNs = Math.min(bestNs, (elapsedMs * 1_000_000) / ticks);
    }

    const ticksPerSecond = 1e9 / bestNs;
    return Object.freeze({ ticks, ticksPerSecond, nsPerTick: bestNs });
  } finally {
    circuit.dispose();
  }
}
