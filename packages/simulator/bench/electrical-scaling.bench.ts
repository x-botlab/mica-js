/**
 * Bounded independent-scaling benchmark for the resistive electrical model.
 *
 * The netlist is `N` topologically isolated loaded dividers sharing only the
 * fixed `VDD`/`GND` rails: each branch is one series resistor from `VDD` to its
 * own midpoint and one load resistor from that midpoint to `GND`. Nothing
 * couples branch `i` to branch `j`, so the matrix is block diagonal and every
 * branch has the same analytic answer, independent of `N`:
 *
 *     V_out = VDD * R_load / (R_series + R_load)
 *     I     = VDD / (R_series + R_load)        both resistors, endpoint order
 *
 * Two cases per size:
 *
 * | case         | per tick                                      | solver path                |
 * | ------------ | --------------------------------------------- | -------------------------- |
 * | `stable`     | device phases only, no value change           | cached, no solve           |
 * | `resistance` | every branch advances its series value by 1k  | matrix invalidation        |
 *
 * `ns/tick` growing with `N` is the expected independent-scaling signature; the
 * report therefore also prints `ns/tick/branch`. Timings are logged only and
 * never thresholded. Before any timing the tests assert the analytic physics and
 * that the `reference` interpreter and the JIT agree, bounded to the smallest
 * configured sizes and a handful of ticks. Run with:
 *
 *     pnpm --filter @mica-js/simulator exec vitest run --config bench/electrical-scaling.config.ts
 *
 * Optional environment knobs (defaults in parentheses):
 * `MICA_SCALING_BRANCHES` ("1,4,8"), `MICA_SCALING_TICKS` (1000),
 * `MICA_SCALING_WARMUP_TICKS` (500), `MICA_SCALING_ROUNDS` (3).
 */
import { expect, test } from 'vitest';
import { Circuit } from '../src/index';
import type { CircuitCompilationInput, DeviceDescription } from '../src/index';
import type { ElectricalReading } from '../src/test-helpers/electrical-observation';
import { createTestProbe } from '../src/test-helpers/circuit-probe';
import type { TestProbe } from '../src/test-helpers/circuit-probe';

/* -------------------------------------------------------------------------
 * Explicit physical parameters (S.I. volts and ohms).
 * ---------------------------------------------------------------------- */
const VDD_VOLTS = 3.3;
const SERIES_BASE_OHMS = 1_000;
const SERIES_STEPS = 8;
/** Eight exact 1/8 steps of 1 kΩ each; every applied value is an exact integer. */
const SERIES_STEP_FRACTION = 1 / SERIES_STEPS;
const SERIES_TRACK_OHMS = 8_000;
const LOAD_OHMS = 2_000;
const DEFAULT_BRANCHES = [1, 4, 8] as const;
/** The slow interpreter only ever sees these sizes, at most two of them. */
const REFERENCE_MAX_BRANCHES = 4;
const REFERENCE_TICKS = 4;

const ELECTRICAL = {
  sources: { VDD: { voltage: VDD_VOLTS } },
  interpretation: 'two-state',
} as const;

const VARIANTS = ['stable', 'resistance'] as const;
type Variant = (typeof VARIANTS)[number];
type Engine = 'reference' | 'jit';
type Reading = ElectricalReading;

/* -------------------------------------------------------------------------
 * Device: one divider branch. Only the `resistance` case defines a `tick`
 * hook, so the `stable` case exercises a loop with no device work at all.
 * ---------------------------------------------------------------------- */
function dividerDescription(variant: Variant): DeviceDescription {
  return {
    name: 'bench-scale-divider',
    pins: {
      TOP: { kind: 'power' },
      OUT: { kind: 'signal' },
      BOTTOM: { kind: 'gnd' },
    },
    resistors: {
      series: { pins: ['TOP', 'OUT'] as const },
      load: { pins: ['OUT', 'BOTTOM'] as const },
    },
    states: { position: { type: 'f64', initial: 0 } },
    factory: ({ electrical }) => {
      electrical.initializeResistor('series', {
        resistance: seriesOhmsAt(0),
        enabled: true,
      });
      electrical.initializeResistor('load', { resistance: LOAD_OHMS, enabled: true });
      if (variant === 'stable') return;
      return {
        tick: (api) => {
          const b = api.builder;
          const position = api.state<'f64'>('position');
          const next = b.float.add(position.load(), b.const('f64', SERIES_STEP_FRACTION));
          const wrapped = b.float.cmp('gt', next, b.const('f64', 1));
          const value = b.select(wrapped, b.const('f64', 0), next);
          position.store(value);
          api.applyResistors(
            ['series'],
            [
              b.float.add(
                b.const('f64', SERIES_BASE_OHMS),
                b.float.mul(b.const('f64', SERIES_TRACK_OHMS), value),
              ),
            ],
          );
        },
      };
    },
  };
}

/**
 * Series resistance after `ticks` position updates. The state walks eight exact
 * 1/8 steps and wraps, so `seriesOhmsAt(t)` is reproducible in the test without
 * reading device state: `1000 + 1000 * (t mod 9)`.
 */
function seriesOhmsAt(ticks: number): number {
  const position = (ticks % (SERIES_STEPS + 1)) * SERIES_STEP_FRACTION;
  return SERIES_BASE_OHMS + SERIES_TRACK_OHMS * position;
}

function adjustedSeriesOhms(variant: Variant, ticks: number): number {
  return variant === 'stable' ? seriesOhmsAt(0) : seriesOhmsAt(ticks);
}

interface Physics {
  readonly voltage: number;
  readonly current: number;
}

/** Closed-form divider: both resistors carry the same current in endpoint order. */
function analytic(seriesOhms: number): Physics {
  const total = seriesOhms + LOAD_OHMS;
  return { voltage: (VDD_VOLTS * LOAD_OHMS) / total, current: VDD_VOLTS / total };
}

function branchId(index: number): string {
  return `div${index}`;
}

function board(branches: number, variant: Variant): CircuitCompilationInput {
  const devices = Array.from({ length: branches }, (_unused, index) => ({
    id: branchId(index),
    type: 'bench-scale-divider',
    description: dividerDescription(variant),
  }));
  const connections = devices.flatMap((device) => [
    { from: 'VDD', to: `${device.id}.TOP` },
    { from: `${device.id}.BOTTOM`, to: 'GND' },
  ]);
  return { devices, connections };
}

async function createCircuit(branches: number, variant: Variant, engine: Engine): Promise<Circuit> {
  // `Circuit` already compiles the JIT at tier 2 on first entry, so bounded
  // loops measure the compiled path and no tuning is needed.
  return Circuit.create(board(branches, variant), { engine, electrical: ELECTRICAL });
}

function createProbe(branches: number, variant: Variant, engine: Engine): TestProbe {
  return createTestProbe(board(branches, variant), { engine, electrical: ELECTRICAL });
}

/* -------------------------------------------------------------------------
 * Correctness first: analytic physics, then reference/JIT equivalence.
 * ---------------------------------------------------------------------- */
interface Snapshot {
  readonly voltages: readonly number[];
  readonly currents: readonly number[];
}

function determinate(reading: Reading | undefined, label: string): number {
  expect(reading, label).toBeDefined();
  if (reading!.state !== 'determinate') throw new Error(`${label} is ${reading!.state}`);
  return reading!.value;
}

function snapshot(probe: TestProbe, branches: number): Snapshot {
  const voltages: number[] = [];
  const currents: number[] = [];
  for (let index = 0; index < branches; index += 1) {
    const id = branchId(index);
    voltages.push(determinate(probe.voltage(`${id}.OUT`), `${id}.OUT`));
    currents.push(determinate(probe.current(`${id}.series`), `${id}.series`));
    currents.push(determinate(probe.current(`${id}.load`), `${id}.load`));
  }
  return { voltages, currents };
}

function assertPhysics(
  probe: TestProbe,
  variant: Variant,
  branches: number,
  ticks: number,
  label: string,
): void {
  const { voltage, current } = analytic(adjustedSeriesOhms(variant, ticks));
  const readings = snapshot(probe, branches);
  expect(readings.voltages, `${label} branches`).toHaveLength(branches);
  for (let index = 0; index < branches; index += 1) {
    const id = branchId(index);
    // Independent branches: the same closed form holds for every size and for
    // every branch, so a coupling regression would fail here immediately.
    expect(readings.voltages[index], `${label} ${id}.OUT`).toBeCloseTo(voltage, 12);
    expect(readings.currents[index * 2], `${label} ${id}.series`).toBeCloseTo(current, 12);
    expect(readings.currents[index * 2 + 1], `${label} ${id}.load`).toBeCloseTo(current, 12);
  }
}

function assertSameSnapshot(actual: Snapshot, expected: Snapshot, label: string): void {
  expect(actual.voltages, `${label} voltages`).toHaveLength(expected.voltages.length);
  for (let at = 0; at < expected.voltages.length; at += 1) {
    expect(actual.voltages[at], `${label} voltage[${at}]`).toBeCloseTo(expected.voltages[at]!, 12);
  }
  expect(actual.currents, `${label} currents`).toHaveLength(expected.currents.length);
  for (let at = 0; at < expected.currents.length; at += 1) {
    expect(actual.currents[at], `${label} current[${at}]`).toBeCloseTo(expected.currents[at]!, 12);
  }
}

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min)
    throw new Error(`${name} must be an integer >= ${min}`);
  return value;
}

function envBranches(name: string, fallback: readonly number[]): readonly number[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const values = raw.split(',').map((part) => Number(part.trim()));
  if (values.length === 0 || values.some((value) => !Number.isSafeInteger(value) || value < 1))
    throw new Error(`${name} must be a comma-separated list of integers >= 1`);
  return [...new Set(values)].sort((left, right) => left - right);
}

const SIZES = envBranches('MICA_SCALING_BRANCHES', DEFAULT_BRANCHES);
/** At most two small sizes; the interpreter is never asked to solve a large netlist. */
const REFERENCE_SIZES: readonly number[] = (() => {
  const small = SIZES.filter((size) => size <= REFERENCE_MAX_BRANCHES).slice(0, 2);
  return small.length > 0 ? small : [DEFAULT_BRANCHES[0]];
})();

test('independent dividers: analytic physics and reference/JIT agreement', () => {
  for (const variant of VARIANTS) {
    for (const branches of REFERENCE_SIZES) {
      const reference = createProbe(branches, variant, 'reference');
      const jit = createProbe(branches, variant, 'jit');
      const label = `${variant}/n=${branches}`;
      assertPhysics(reference, variant, branches, 0, `${label} t0 reference`);
      assertPhysics(jit, variant, branches, 0, `${label} t0 jit`);
      assertSameSnapshot(snapshot(jit, branches), snapshot(reference, branches), `${label} t0`);

      // Two stepped plus two batched ticks stay inside one resistance
      // period (nine updates) and are enough to leave the initial solve.
      for (let tick = 0; tick < REFERENCE_TICKS / 2; tick += 1) {
        reference.step();
        jit.step();
      }
      reference.runBatch(REFERENCE_TICKS / 2);
      jit.runBatch(REFERENCE_TICKS / 2);
      assertPhysics(jit, variant, branches, REFERENCE_TICKS, `${label} t4 jit`);
      assertSameSnapshot(snapshot(jit, branches), snapshot(reference, branches), `${label} t4`);
      expect(jit.tickCount).toBe(reference.tickCount);

      reference.reset();
      jit.reset();
      assertPhysics(jit, variant, branches, 0, `${label} reset jit`);
      assertSameSnapshot(snapshot(jit, branches), snapshot(reference, branches), `${label} reset`);
      expect(jit.tickCount).toBe(0n);
    }
  }
}, 60_000);

/* -------------------------------------------------------------------------
 * Timing.
 * ---------------------------------------------------------------------- */
const TICKS = envInt('MICA_SCALING_TICKS', 1_000, 1);
const WARMUP_TICKS = envInt('MICA_SCALING_WARMUP_TICKS', 500, 0);
const ROUNDS = envInt('MICA_SCALING_ROUNDS', 3, 1);

interface Measured {
  readonly variant: Variant;
  readonly branches: number;
  readonly circuit: Circuit;
  readonly samples: number[];
}

test('independent dividers: logged ns/tick by branch count, no timing thresholds', async () => {
  const measured: Measured[] = [];
  try {
    for (const variant of VARIANTS) {
      for (const branches of SIZES) {
        const circuit = await createCircuit(branches, variant, 'jit');
        measured.push({ variant, branches, circuit, samples: [] });
        circuit.runBatch(WARMUP_TICKS);
        // One full-size batch before measuring: the loop specialisation that
        // follows the first compiled entry then finishes outside the samples.
        circuit.runBatch(TICKS);
      }
    }

    for (let round = 0; round < ROUNDS; round += 1) {
      // Alternate the order so a size is not always sampled at the same point
      // of the process' warmup/thermal curve.
      const order = round % 2 === 0 ? measured : [...measured].reverse();
      for (const { circuit, samples } of order) {
        const start = performance.now();
        circuit.runBatch(TICKS);
        samples.push(((performance.now() - start) * 1e6) / TICKS);
      }
    }

    const totalTicks = WARMUP_TICKS + TICKS + ROUNDS * TICKS;
    console.log(
      `node=${process.version} platform=${process.platform}/${process.arch}; ` +
        `branches=${SIZES.join(',')}; ticks/round=${TICKS}; warmup=${WARMUP_TICKS}; ` +
        `rounds=${ROUNDS}`,
    );
    for (const { variant, branches, circuit, samples } of measured) {
      const sorted = [...samples].sort((left, right) => left - right);
      const best = sorted[0]!;
      const median = sorted[Math.floor(ROUNDS / 2)]!;
      console.log(
        `${variant}/n=${branches}: best=${best.toFixed(1)} median=${median.toFixed(1)} ns/tick; ` +
          `per-branch=${(median / branches).toFixed(1)} ns/tick/branch; ` +
          `samples=${samples.map((value) => value.toFixed(1)).join(',')}`,
      );
      expect(circuit.tickCount).toBe(BigInt(totalTicks));
      // Physics must survive the timed loop: the position now sits at
      // `totalTicks mod 9` eighths, which this recomputes without state access.
      const probe = createProbe(branches, variant, 'jit');
      probe.runBatch(totalTicks);
      assertPhysics(probe, variant, branches, totalTicks, `${variant}/n=${branches} after timing`);
    }
  } finally {
    for (const { circuit } of measured) circuit.dispose();
  }
}, 120_000);
