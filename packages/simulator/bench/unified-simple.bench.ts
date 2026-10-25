/**
 * Unified IR module vs. the scheduler architecture, MCU + LED.
 *
 * Both sides simulate exactly the same circuit — `mcu.PA0 -> led.anode`,
 * `led.cathode -> ground` — and the same device logic:
 *
 * ```text
 * mcu.tick :  PA0 = !PA0 ; mode = PUSH_PULL
 * net      :  PA0 mode == PUSH_PULL && PA0  ->  anode
 * led      :  lamp = anode && !cathode
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
import { createLedDescription, createMcuDescription } from '../src/unified-ir/compiler';
import { Circuit } from '../src/unified-ir/runtime';
import { createCurrentArchitecture } from './current-architecture';

/** Ticks per measured op for the head-to-head comparison. */
const TICKS = 2_000;

/** Batch size for the absolute throughput measurement. */
const THROUGHPUT_TICKS = 1_000_000;

/** The same circuit both sides compile. */
async function createUnifiedMcuLed() {
  return Circuit.create({
    devices: [
      { id: 'mcu', type: 'mcu', description: createMcuDescription() },
      { id: 'led', type: 'ideal-led', description: createLedDescription() },
    ],
    connections: [
      { from: 'mcu.PA0', to: 'led.anode' },
      { from: 'led.cathode', to: 'GND' },
    ],
  });
}

const current = createCurrentArchitecture();
const unified = await createUnifiedMcuLed();

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

test('MCU + LED: unified IR module vs. per-device modules on the scheduler', async ({ bench }) => {
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

  // The ratios above are observations: benchmarks report, they never gate.
});

test('MCU + LED: 1M-tick latency and throughput observation', async () => {
  const circuit = await createUnifiedMcuLed();
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

  // Latency and throughput are reported, never asserted.
  // The lamp must still follow the pin after a million steps: an even tick
  // count leaves PA0 low, an odd one leaves it high.
  if (circuit.devices.led.isOn() !== (circuit.tickCount % 2n === 1n)) {
    throw new Error('the batched loop left the LED out of phase with PA0');
  }
  circuit.dispose();
});

test('MCU + LED: the baseline and the unified module agree on every tick', async () => {
  const baseline = createCurrentArchitecture();
  const circuit = await createUnifiedMcuLed();
  for (let tick = 0; tick < 32; tick += 1) {
    baseline.tick();
    circuit.step();
    const lampOn = circuit.devices.led.isOn();
    const anode = circuit.getPin('led.anode');
    if (baseline.readLed() !== lampOn || lampOn !== anode) {
      throw new Error(
        `tick ${tick + 1}: baseline led=${baseline.readLed()}, unified led=${lampOn}, anode=${anode}`,
      );
    }
  }
  circuit.dispose();
});
