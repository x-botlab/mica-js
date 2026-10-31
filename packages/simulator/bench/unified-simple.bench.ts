/**
 * Unified IR throughput: driver + sink.
 *
 * One IR module holds both devices, the net solver and the main loop. `step()` pays one host
 * entry per tick; `runBatch(n)` pays one host entry for the whole batch.
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
import { TEST_ELECTRICAL } from '../src/unified-ir/compiler/test-helpers';

/** Ticks per measured op for the host-driven vs batched comparison. */
const TICKS = 2_000;

/** Batch size for the absolute throughput measurement. */
const THROUGHPUT_TICKS = 10_000;

/** The circuit both measurements compile. */
async function createUnifiedCircuit() {
  return Circuit.create(
    {
      devices: [
        { id: 'driver', type: 'toggle-driver', description: toggleDriverDescription() },
        { id: 'sink', type: 'lamp-sink', description: lampSinkDescription() },
      ],
      connections: [
        { from: 'driver.PA0', to: 'sink.anode' },
        { from: 'sink.cathode', to: 'GND' },
      ],
    },
    { electrical: TEST_ELECTRICAL },
  );
}

const HOST = `host-driven step, ${TICKS} ticks`;
const BATCH = `runBatch(${TICKS}), one host call`;
type Variant = typeof HOST | typeof BATCH;

const clock = (): number => {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return perf === undefined ? Date.now() : perf.now();
};

const nsPerTick = (ticksPerSecond: number): number => 1e9 / ticksPerSecond;

test('driver + sink: host-driven step vs batched loop', async ({ bench }) => {
  const circuit = await createUnifiedCircuit();
  circuit.runBatch(200);

  const results = await bench.compare(
    bench(HOST, () => {
      for (let tick = 0; tick < TICKS; tick += 1) circuit.step();
    }),
    bench(BATCH, () => {
      circuit.runBatch(TICKS);
    }),
    { time: 3_000, warmupTime: 500 },
  );

  const rate = (name: Variant): number => {
    const result = results.get(name);
    if (result === undefined) throw new Error(`bench.compare did not report "${name}"`);
    // One op advances TICKS ticks.
    return result.throughput.mean * TICKS;
  };

  const host = rate(HOST);
  const batch = rate(BATCH);
  console.log(
    `[unified-simple.bench] per tick: host-driven ${nsPerTick(host).toFixed(1)} ns, ` +
      `batched ${nsPerTick(batch).toFixed(1)} ns (${(batch / host).toFixed(1)}x)`,
  );

  if (!(host > 0 && batch > 0)) throw new Error('invalid throughput measurement');
  circuit.dispose();
});

test('resistive driver + sink: report per-tick throughput and verify electrical state', async () => {
  const circuit = await createUnifiedCircuit();
  circuit.runBatch(1_000);

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

  // The lamp must still follow the pin after a million steps: an even tick
  // count leaves PA0 low, an odd one leaves it high.
  if (circuit.devices.sink.getState('lamp') !== (circuit.tickCount % 2n === 1n)) {
    throw new Error('the batched loop left the sink out of phase with PA0');
  }
  circuit.dispose();
});

test('driver + sink: step and batch stay in phase', async () => {
  const stepped = await createUnifiedCircuit();
  const batched = await createUnifiedCircuit();
  for (let tick = 0; tick < 32; tick += 1) {
    stepped.step();
    batched.runBatch(1);
    const steppedLamp = stepped.devices.sink.getState('lamp');
    const batchedLamp = batched.devices.sink.getState('lamp');
    if (steppedLamp !== batchedLamp || steppedLamp !== stepped.getPin('sink.anode')) {
      throw new Error(
        `tick ${tick + 1}: step=${steppedLamp}, batch=${batchedLamp}, ` +
          `anode=${stepped.getPin('sink.anode')}`,
      );
    }
  }
  stepped.dispose();
  batched.dispose();
});
