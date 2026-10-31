/**
 * End-to-end electrical `Circuit` throughput on one small mixed-signal board.
 *
 * Four variants share a single netlist and differ only in the one behaviour
 * being measured, so the four numbers are directly comparable:
 *
 * | variant       | per tick                                                 | solver work                     |
 * | ------------- | -------------------------------------------------------- | ------------------------------- |
 * | `stable`      | device phases, no version change                         | cached, no solve                |
 * | `resistance`  | device recomputes two resistor values from state         | matrix invalidation + factor    |
 * | `gpio-rhs`    | GPIO analog output writes a new voltage                  | RHS invalidation, factor reuse  |
 * | `contact`     | ideal contact toggles open/closed                        | topology invalidation + factor  |
 *
 * Timings use plain `performance.now()` loops over `runBatch`, exactly like
 * `bench/resistive-number.bench.ts`; the Vitest bench/Tinybench API is unused.
 * Run with:
 *
 *     pnpm --filter @mica-js/simulator exec vitest run --config bench/electrical-circuit.config.ts
 *
 * Optional environment knobs (defaults in parentheses):
 * `MICA_BENCH_TICKS` (2000), `MICA_BENCH_WARMUP_TICKS` (1000),
 * `MICA_BENCH_ROUNDS` (5).
 */
import { toNumber } from '@mica-js/ir';
import { expect, test } from 'vitest';
import { Circuit, PIN_MODE } from '../src/index';
import type { CircuitCompilationInput, DeviceBehaviorApi, DeviceDescription } from '../src/index';

/* -------------------------------------------------------------------------
 * Explicit physical parameters (S.I. volts and ohms).
 * ---------------------------------------------------------------------- */
const VDD_VOLTS = 3.3;
const GPIO_HIGH_OHMS = 30;
const GPIO_LOW_OHMS = 25;
const GPIO_ANALOG_OHMS = 200;
const SERIES_OHMS = 10_000;
const SHUNT_OHMS = 10_000;
const CONTACT_LOAD_OHMS = 1_000;
const DAC_LOAD_OHMS = 1_000;
const ADC_INPUT_OHMS = 100_000;
const POT_TRACK_OHMS = 10_000;
const POT_END_OHMS = 50;
const POT_INITIAL_POSITION = 0.5;
const POT_STEP = 1 / 1024;
const DAC_INITIAL_VOLTS = 1.25;
const DAC_MIN_VOLTS = 0.2;
const DAC_MAX_VOLTS = 3.1;
const DAC_STEP_VOLTS = 0.05;

/** Open divider: VDD/2 through two equal 10 kΩ branches. */
const OPEN_DIVIDER_VOLTS = VDD_VOLTS / 2;
/** Closed contact: 10 kΩ ∥ 1 kΩ to GND under a 10 kΩ series leg. */
const CLOSED_DIVIDER_VOLTS = VDD_VOLTS / 12;
/** 1.25 V behind 200 Ω into 1 kΩ. */
const DAC_IDLE_VOLTS = (DAC_INITIAL_VOLTS * DAC_LOAD_OHMS) / (GPIO_ANALOG_OHMS + DAC_LOAD_OHMS);

const ELECTRICAL = {
  sources: { VDD: { voltage: VDD_VOLTS } },
  interpretation: 'two-state',
} as const;

/**
 * Every pin the board declares; snapshots walk this list instead of guessing
 * which node a variant touched.
 */
const PIN_NAMES = [
  'gpio.DAC',
  'gpio.SENSE',
  'series.A',
  'series.B',
  'shunt.A',
  'shunt.B',
  'switch.A',
  'switch.B',
  'load.A',
  'load.B',
  'pot.TOP',
  'pot.WIPER',
  'pot.BOTTOM',
  'adc.A',
  'adc.B',
  'dacLoad.A',
  'dacLoad.B',
] as const;

const RESISTOR_NAMES = [
  'series.body',
  'shunt.body',
  'load.body',
  'pot.upper',
  'pot.lower',
  'adc.body',
  'dacLoad.body',
] as const;

const STATE_NAMES = [
  ['gpio', 'high'],
  ['gpio', 'level'],
  ['gpio', 'levelDirection'],
  ['pot', 'position'],
  ['pot', 'positionDirection'],
  ['switch', 'closed'],
] as const;

type Variant = 'stable' | 'resistance' | 'gpio-rhs' | 'contact';
type Reading = ReturnType<Circuit['getVoltage']>;

/* -------------------------------------------------------------------------
 * Device descriptions: exactly what a device package would ship, with the
 * variant expressed in one behaviour hook.
 * ---------------------------------------------------------------------- */

/** Passive two-terminal resistor; the value is fixed at factory time. */
function resistorDescription(ohms: number): DeviceDescription {
  return {
    name: 'bench-resistor',
    pins: { A: { kind: 'signal' }, B: { kind: 'signal' } },
    resistors: { body: { pins: ['A', 'B'] as const } },
    factory: ({ electrical }) => {
      electrical.initializeResistor('body', { resistance: ohms, enabled: true });
    },
  };
}

/** Triangle sweep over [min, max] driven by one f64 state and one bool direction. */
function sweep(
  api: DeviceBehaviorApi,
  stateName: string,
  step: number,
  min: number,
  max: number,
): void {
  const b = api.builder;
  const value = api.state<'f64'>(stateName);
  const direction = api.state<'bool'>(`${stateName}Direction`);
  const current = value.load();
  const rising = direction.load();
  const next = b.select(
    rising,
    b.float.sub(current, b.const('f64', step)),
    b.float.add(current, b.const('f64', step)),
  );
  const turn = b.bool.or(
    b.float.cmp('lt', next, b.const('f64', min)),
    b.float.cmp('gt', next, b.const('f64', max)),
  );
  value.store(b.select(turn, b.select(rising, b.const('f64', min), b.const('f64', max)), next));
  direction.store(b.bool.xor(rising, turn));
}

/** GPIO with an analog-capable output and one sensing input. */
function gpioDescription(variant: Variant): DeviceDescription {
  return {
    name: 'bench-gpio',
    pins: { DAC: { kind: 'signal' }, SENSE: { kind: 'signal' } },
    states: {
      high: { type: 'bool', initial: false },
      level: { type: 'f64', initial: DAC_INITIAL_VOLTS },
      levelDirection: { type: 'bool', initial: false },
    },
    factory: ({ electrical }) => {
      electrical.initializePin('DAC', {
        drive: {
          reference: { source: 'VDD' },
          highResistance: GPIO_HIGH_OHMS,
          lowResistance: GPIO_LOW_OHMS,
          analogResistance: GPIO_ANALOG_OHMS,
        },
        input: { reference: { source: 'VDD' }, low: 0.3, high: 0.7 },
      });
      electrical.initializePin('SENSE', {
        input: { reference: { source: 'VDD' }, low: 0.3, high: 0.7 },
      });
      return {
        initialize: (api) => {
          const b = api.builder;
          const pin = api.pin('DAC');
          pin.configure(PIN_MODE.analog);
          pin.setOutputEnabled(b.const('bool', true));
          pin.writeVoltage(b.const('f64', DAC_INITIAL_VOLTS));
        },
        ...(variant === 'gpio-rhs'
          ? {
              tick: (api: DeviceBehaviorApi) => {
                sweep(api, 'level', DAC_STEP_VOLTS, DAC_MIN_VOLTS, DAC_MAX_VOLTS);
                api.pin('DAC').writeVoltage(api.state<'f64'>('level').load());
              },
            }
          : {}),
        update: (api) => {
          api.state<'bool'>('high').store(api.pin('SENSE').sampleDigital());
        },
      };
    },
  };
}

/**
 * Potentiometer with two resistor branches around the wiper. Both variants
 * re-apply the resistances every tick; only `resistance` moves the wiper, so
 * the pair isolates the changed-matrix path from the unchanged-value compare.
 */
function potentiometerDescription(variant: Variant): DeviceDescription {
  const branch = (position: number) => POT_END_OHMS + POT_TRACK_OHMS * position;
  return {
    name: 'bench-potentiometer',
    pins: { TOP: { kind: 'power' }, WIPER: { kind: 'signal' }, BOTTOM: { kind: 'gnd' } },
    resistors: {
      upper: { pins: ['TOP', 'WIPER'] as const },
      lower: { pins: ['WIPER', 'BOTTOM'] as const },
    },
    states: {
      position: { type: 'f64', initial: POT_INITIAL_POSITION },
      positionDirection: { type: 'bool', initial: false },
    },
    factory: ({ electrical }) => {
      electrical.initializeResistor('upper', {
        resistance: branch(POT_INITIAL_POSITION),
        enabled: true,
      });
      electrical.initializeResistor('lower', {
        resistance: branch(1 - POT_INITIAL_POSITION),
        enabled: true,
      });
      return {
        tick: (api) => {
          if (variant === 'resistance') sweep(api, 'position', POT_STEP, 0, 1);
          const b = api.builder;
          const position = api.state<'f64'>('position').load();
          const end = b.const('f64', POT_END_OHMS);
          const track = b.const('f64', POT_TRACK_OHMS);
          api.applyResistors(
            ['upper', 'lower'],
            [
              b.float.add(end, b.float.mul(track, position)),
              b.float.add(end, b.float.mul(track, b.float.sub(b.const('f64', 1), position))),
            ],
          );
        },
      };
    },
  };
}

/** Ideal single-pole contact; only `contact` toggles it. */
function switchDescription(variant: Variant): DeviceDescription {
  return {
    name: 'bench-switch',
    pins: { A: { kind: 'signal' }, B: { kind: 'signal' } },
    connections: { contact: { pins: ['A', 'B'] as const, initial: 'open' } },
    states: { closed: { type: 'bool', initial: false } },
    factory: () => ({
      tick: (api) => {
        const b = api.builder;
        const state = api.state<'bool'>('closed');
        const closed = variant === 'contact' ? b.bool.not(state.load()) : state.load();
        state.store(closed);
        api.applyConnections(['contact'], [closed]);
      },
    }),
  };
}

/**
 * One board: VDD divider feeding a GPIO sense pin, the GPIO analog output into
 * its own load, a contact-switched load on the divider node, and a
 * potentiometer whose wiper feeds a 100 kΩ ADC resistance.
 */
function board(variant: Variant): CircuitCompilationInput {
  return {
    devices: [
      { id: 'gpio', type: 'bench-gpio', description: gpioDescription(variant) },
      { id: 'series', type: 'bench-resistor', description: resistorDescription(SERIES_OHMS) },
      { id: 'shunt', type: 'bench-resistor', description: resistorDescription(SHUNT_OHMS) },
      { id: 'switch', type: 'bench-switch', description: switchDescription(variant) },
      {
        id: 'load',
        type: 'bench-resistor',
        description: resistorDescription(CONTACT_LOAD_OHMS),
      },
      { id: 'pot', type: 'bench-potentiometer', description: potentiometerDescription(variant) },
      { id: 'adc', type: 'bench-resistor', description: resistorDescription(ADC_INPUT_OHMS) },
      {
        id: 'dacLoad',
        type: 'bench-resistor',
        description: resistorDescription(DAC_LOAD_OHMS),
      },
    ],
    connections: [
      { from: 'gpio.DAC', to: 'dacLoad.A' },
      { from: 'dacLoad.B', to: 'GND' },
      { from: 'VDD', to: 'series.A' },
      { from: 'series.B', to: 'shunt.A' },
      { from: 'series.B', to: 'gpio.SENSE' },
      { from: 'shunt.B', to: 'GND' },
      { from: 'series.B', to: 'switch.A' },
      { from: 'switch.B', to: 'load.A' },
      { from: 'load.B', to: 'GND' },
      { from: 'VDD', to: 'pot.TOP' },
      { from: 'pot.WIPER', to: 'adc.A' },
      { from: 'pot.BOTTOM', to: 'GND' },
      { from: 'adc.B', to: 'GND' },
    ],
  };
}

/* -------------------------------------------------------------------------
 * Correctness first: reference vs JIT, physics, then timing.
 * ---------------------------------------------------------------------- */

interface Snapshot {
  readonly voltages: ReadonlyMap<string, Reading>;
  readonly currents: ReadonlyMap<string, Reading>;
  readonly states: ReadonlyMap<string, unknown>;
}

function snapshot(circuit: Circuit): Snapshot {
  const voltages = new Map<string, Reading>();
  for (const pin of PIN_NAMES) voltages.set(pin, circuit.getVoltage(pin));
  const currents = new Map<string, Reading>();
  for (const resource of RESISTOR_NAMES) currents.set(resource, circuit.getCurrent(resource));
  const states = new Map<string, unknown>();
  for (const [device, state] of STATE_NAMES)
    states.set(`${device}.${state}`, circuit.devices[device]!.getState(state));
  return { voltages, currents, states };
}

function determinate(reading: Reading | undefined, label: string): number {
  expect(reading, label).toBeDefined();
  if (reading!.state !== 'determinate') throw new Error(`${label} is ${reading!.state}`);
  return reading!.value;
}

function assertSameSnapshot(actual: Snapshot, expected: Snapshot, label: string): void {
  for (const pin of PIN_NAMES) {
    const left = actual.voltages.get(pin)!;
    const right = expected.voltages.get(pin)!;
    expect(left.state, `${label} ${pin}`).toBe(right.state);
    if (left.state === 'determinate' && right.state === 'determinate')
      expect(left.value, `${label} ${pin}`).toBeCloseTo(right.value, 12);
  }
  for (const resource of RESISTOR_NAMES) {
    const left = actual.currents.get(resource)!;
    const right = expected.currents.get(resource)!;
    expect(left.state, `${label} ${resource}`).toBe(right.state);
    if (left.state === 'determinate' && right.state === 'determinate')
      expect(left.value, `${label} ${resource}`).toBeCloseTo(right.value, 12);
  }
  for (const [key, value] of actual.states) {
    const expectedValue = expected.states.get(key);
    const actualScalar = stateScalar(value);
    const expectedScalar = stateScalar(expectedValue);
    if (typeof actualScalar === 'number' && typeof expectedScalar === 'number')
      expect(actualScalar, `${label} ${key}`).toBeCloseTo(expectedScalar, 12);
    else expect(actualScalar, `${label} ${key}`).toBe(expectedScalar);
  }
}

/** `getState` returns a raw storage value: booleans stay booleans, f64 arrives packed. */
function stateScalar(value: unknown): number | boolean | undefined {
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value !== null && typeof value === 'object' && 'type' in value && value.type === 'f64')
    return toNumber(value as Parameters<typeof toNumber>[0]);
  return undefined;
}

/** Proves each variant really drives its own path instead of only being labelled. */
function assertVariantEffect(variant: Variant, circuit: Circuit, initial: Snapshot): void {
  const wiper0 = determinate(initial.voltages.get('pot.WIPER'), 'initial pot.WIPER');
  const dac0 = determinate(initial.voltages.get('gpio.DAC'), 'initial gpio.DAC');
  expect(determinate(initial.voltages.get('series.B'), 'initial series.B')).toBeCloseTo(
    OPEN_DIVIDER_VOLTS,
    12,
  );
  expect(dac0).toBeCloseTo(DAC_IDLE_VOLTS, 12);

  // 32 is even, so the contact variant is back to its initial open state.
  circuit.runBatch(32);
  const after = snapshot(circuit);
  expect(determinate(after.voltages.get('series.B'), 'series.B')).toBeCloseTo(
    OPEN_DIVIDER_VOLTS,
    12,
  );
  const wiper1 = determinate(after.voltages.get('pot.WIPER'), 'pot.WIPER');
  const dac1 = determinate(after.voltages.get('gpio.DAC'), 'gpio.DAC');
  if (variant === 'resistance') {
    expect(Math.abs(wiper1 - wiper0)).toBeGreaterThan(1e-3);
    expect(dac1).toBeCloseTo(dac0, 12);
  } else {
    expect(wiper1).toBeCloseTo(wiper0, 12);
  }
  if (variant === 'gpio-rhs') expect(Math.abs(dac1 - dac0)).toBeGreaterThan(1e-3);
  else expect(dac1).toBeCloseTo(dac0, 12);

  if (variant === 'contact') {
    // An even number of ticks leaves the contact open, one more closes it.
    circuit.step();
    expect(determinate(circuit.getVoltage('series.B'), 'closed series.B')).toBeCloseTo(
      CLOSED_DIVIDER_VOLTS,
      12,
    );
    circuit.step();
    expect(determinate(circuit.getVoltage('series.B'), 'reopened series.B')).toBeCloseTo(
      OPEN_DIVIDER_VOLTS,
      12,
    );
  }
  expect(circuit.tickCount).toBe(variant === 'contact' ? 34n : 32n);
}

async function createCircuit(variant: Variant, engine: 'reference' | 'jit'): Promise<Circuit> {
  return Circuit.create(board(variant), { engine, electrical: ELECTRICAL });
}

async function withCircuit(
  variant: Variant,
  engine: 'reference' | 'jit',
  run: (circuit: Circuit) => void | Promise<void>,
): Promise<void> {
  const circuit = await createCircuit(variant, engine);
  try {
    await run(circuit);
  } finally {
    circuit.dispose();
  }
}

test('electrical circuit: reference and JIT agree before any timing', async () => {
  for (const variant of ['stable', 'resistance', 'gpio-rhs', 'contact'] as const) {
    await withCircuit(variant, 'reference', async (reference) => {
      await withCircuit(variant, 'jit', async (jit) => {
        const startReference = snapshot(reference);
        const startJit = snapshot(jit);
        assertSameSnapshot(startJit, startReference, `${variant} t0`);

        // A short mixed step/batch prefix is enough to compare both engines:
        // every pin, every branch current and every device state is compared.
        for (let tick = 0; tick < 4; tick += 1) {
          reference.step();
          jit.step();
        }
        reference.runBatch(12);
        jit.runBatch(12);
        assertSameSnapshot(snapshot(jit), snapshot(reference), `${variant} t16`);
        expect(jit.tickCount).toBe(reference.tickCount);

        reference.reset();
        jit.reset();
        assertSameSnapshot(snapshot(jit), snapshot(reference), `${variant} reset`);
        assertSameSnapshot(snapshot(jit), startJit, `${variant} reset to t0`);
        // Physics run on the JIT instance only; the slow reference engine would
        // add seconds without checking anything the snapshots do not already cover.
        assertVariantEffect(variant, jit, startJit);
      });
    });
  }
}, 60_000);

/* -------------------------------------------------------------------------
 * Timing.
 * ---------------------------------------------------------------------- */

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min)
    throw new Error(`${name} must be an integer >= ${min}`);
  return value;
}

const TICKS = envInt('MICA_BENCH_TICKS', 2_000, 1);
const WARMUP_TICKS = envInt('MICA_BENCH_WARMUP_TICKS', 1_000, 0);
const ROUNDS = envInt('MICA_BENCH_ROUNDS', 5, 1);

interface Measured {
  readonly variant: Variant;
  readonly circuit: Circuit;
  readonly samples: number[];
}

test('electrical circuit: stable ticks, resistance, GPIO RHS and contact topology', async () => {
  const measured: Measured[] = [];
  try {
    const variants = ['stable', 'resistance', 'gpio-rhs', 'contact'] as const;
    const selected = process.env['MICA_BENCH_VARIANT'];
    if (selected !== undefined && !variants.some((variant) => variant === selected))
      throw new Error('MICA_BENCH_VARIANT must be stable, resistance, gpio-rhs or contact');
    for (const variant of variants) {
      if (selected !== undefined && variant !== selected) continue;
      const circuit = await createCircuit(variant, 'jit');
      measured.push({ variant, circuit, samples: [] });
      circuit.runBatch(WARMUP_TICKS);
    }

    for (let round = 0; round < ROUNDS; round += 1) {
      // Alternate the order so a scenario is not always measured at the same
      // point of the process' warmup/thermal curve.
      const order = round % 2 === 0 ? measured : [...measured].reverse();
      for (const { circuit, samples } of order) {
        const start = performance.now();
        circuit.runBatch(TICKS);
        samples.push(((performance.now() - start) * 1e6) / TICKS);
      }
    }

    console.log(
      `node=${process.version} platform=${process.platform}/${process.arch}; ` +
        `ticks/round=${TICKS}; warmup=${WARMUP_TICKS}; rounds=${ROUNDS}; compiler=${process.env['MICA_BENCH_REF'] ?? 'worktree'}`,
    );
    for (const { variant, circuit, samples } of measured) {
      const sorted = [...samples].sort((a, b) => a - b);
      const best = sorted[0]!;
      const median = sorted[Math.floor(ROUNDS / 2)]!;
      console.log(
        `${variant}: best=${best.toFixed(1)} median=${median.toFixed(1)} ns/tick; ` +
          `samples=${samples.map((value) => value.toFixed(1)).join(',')}`,
      );
      expect(circuit.tickCount).toBe(BigInt(WARMUP_TICKS + ROUNDS * TICKS));
    }
  } finally {
    for (const { circuit } of measured) circuit.dispose();
  }
}, 120_000);
