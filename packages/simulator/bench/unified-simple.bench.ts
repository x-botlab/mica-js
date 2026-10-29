/**
 * Unified IR module vs. the scheduler architecture, driver + sink.
 *
 * Both sides simulate exactly the same circuit — `driver.PA0 -> sink.anode`,
 * `sink.cathode -> ground` — and the same device logic:
 *
 * ```text
 * driver.tick :  PA0 = !PA0 ; mode = PUSH_PULL
 * net      :  PA0 mode == PUSH_PULL && PA0  ->  anode
 * sink      :  lamp = anode && !cathode
 * ```
 *
 * The left side is the scheduler path (see `current-architecture.ts`): one IR
 * module per device on the core scheduler plus a JavaScript net bridge — three
 * host entries per tick.
 *
 * The right side is the unified pipeline: one IR module holding both devices,
 * the net solver and the main loop. `step()` is one host entry per tick;
 * `runBatch(n)` is one host entry for the whole batch.
 *
 * Reported numbers are per simulated tick:
 *
 *     ns/tick = 1e9 / (ops/s × ticks per op)
 */
import { test } from 'vitest';
import {
  lampSinkDescription,
  toggleDriverDescription,
} from '../src/unified-ir/compiler/test-helpers';
import { Circuit } from '../src/unified-ir/runtime';
import { createCurrentArchitecture } from './current-architecture';

/** Ticks per measured op for the head-to-head comparison. */
const TICKS = 2_000;

/** Batch size for the absolute throughput measurement. */
const THROUGHPUT_TICKS = 1_000_000;

/** The same circuit both sides compile. */
async function createUnifiedCircuit() {
  return Circuit.create({
    devices: [
      { id: 'driver', type: 'toggle-driver', description: toggleDriverDescription() },
      { id: 'sink', type: 'lamp-sink', description: lampSinkDescription() },
    ],
    connections: [
      { from: 'driver.PA0', to: 'sink.anode' },
      { from: 'sink.cathode', to: 'GND' },
    ],
  });
}

const current = createCurrentArchitecture();
const unified = await createUnifiedCircuit();

// Compile and warm both paths outside the measured region: the first tick pays
// JIT compilation, the scheduler's first entry pays its own setup.
for (let tick = 0; tick < 200; tick += 1) current.tick();
unified.runBatch(200);

const CURRENT = `current: 2 IR modules + scheduler + JS net, ${TICKS} ticks`;
const UNIFIED_HOST = `unified: one IR module, ${TICKS} ticks, one host call each`;
const UNIFIED_BATCH = `unified: one IR module, ${TICKS} ticks, one host call per batch`;
type Variant = typeof CURRENT | typeof UNIFIED_HOST | typeof UNIFIED_BATCH;

const clock = (): number => {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return perf === undefined ? Date.now() : perf.now();
};

const nsPerTick = (ticksPerSecond: number): number => 1e9 / ticksPerSecond;

test('driver + sink: unified IR module vs. per-device modules on the scheduler', async ({
  bench,
}) => {
  const results = await bench.compare(
    bench(CURRENT, () => {
      for (let tick = 0; tick < TICKS; tick += 1) current.tick();
    }),
    bench(UNIFIED_HOST, () => {
      for (let tick = 0; tick < TICKS; tick += 1) unified.step();
    }),
    bench(UNIFIED_BATCH, () => {
      unified.runBatch(TICKS);
    }),
    { time: 3_000, warmupTime: 500 },
  );

  const rate = (name: Variant): number => {
    const result = results.get(name);
    if (result === undefined) throw new Error(`bench.compare did not report "${name}"`);
    // One op advances TICKS ticks.
    return result.throughput.mean * TICKS;
  };

  const base = rate(CURRENT);
  const host = rate(UNIFIED_HOST);
  const batch = rate(UNIFIED_BATCH);
  const factor = (value: number): string => `${(value / base).toFixed(1)}x`;

  console.log(
    `[unified-simple.bench] per tick: current ${nsPerTick(base).toFixed(1)} ns, ` +
      `unified host-driven ${nsPerTick(host).toFixed(1)} ns (${factor(host)}), ` +
      `unified batched ${nsPerTick(batch).toFixed(1)} ns (${factor(batch)})`,
  );

  // Timing on a shared machine is noisy, so the gates stay far below the
  // measured margins and only catch a real regression such as losing the
  // compiled tier or the batched loop.
  if (!(host > base * 3)) {
    throw new Error('unified host-driven steps regressed against the scheduler baseline');
  }
  if (!(batch > base * 10)) {
    throw new Error('the batched unified loop regressed against the scheduler baseline');
  }
});

test('driver + sink: 1M ticks meet the latency and throughput targets', async () => {
  const circuit = await createUnifiedCircuit();
  circuit.runBatch(100_000);

  const started = clock();
  circuit.runBatch(THROUGHPUT_TICKS);
  const elapsedMs = clock() - started;
  const ticksPerSecond = THROUGHPUT_TICKS / (elapsedMs / 1_000);
  const perTick = nsPerTick(ticksPerSecond);

  console.log(
    `[unified-simple.bench] ${THROUGHPUT_TICKS.toLocaleString()} ticks in ` +
      `${elapsedMs.toFixed(1)} ms = ${perTick.toFixed(1)} ns/tick ` +
      `(${(ticksPerSecond / 1_000_000).toFixed(1)} M ticks/s)`,
  );

  // Acceptance: < 200 ns per tick and > 5 M ticks/s.
  if (!(perTick < 200)) {
    throw new Error(`unified IR achieved ${perTick.toFixed(1)} ns/tick, target is < 200 ns`);
  }
  if (!(ticksPerSecond > 5_000_000)) {
    throw new Error(
      `unified IR achieved ${Math.round(ticksPerSecond)} ticks/s, target is > 5,000,000`,
    );
  }
  // The lamp must still follow the pin after a million steps: an even tick
  // count leaves PA0 low, an odd one leaves it high.
  if (circuit.devices.sink.getState('lamp') !== (circuit.tickCount % 2n === 1n)) {
    throw new Error('the batched loop left the sink out of phase with PA0');
  }
  circuit.dispose();
});

test('driver + sink: the baseline and the unified module agree on every tick', async () => {
  const baseline = createCurrentArchitecture();
  const circuit = await createUnifiedCircuit();
  for (let tick = 0; tick < 32; tick += 1) {
    baseline.tick();
    circuit.step();
    const lampOn = circuit.devices.sink.getState('lamp');
    const anode = circuit.getPin('sink.anode');
    if (baseline.readLamp() !== lampOn || lampOn !== anode) {
      throw new Error(
        `tick ${tick + 1}: baseline sink=${baseline.readLamp()}, unified sink=${lampOn}, anode=${anode}`,
      );
    }
  }
  circuit.dispose();
});
