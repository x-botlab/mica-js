import assert from 'node:assert/strict';
import { arch, cpus, platform, release } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createProcessor } from '../../../tests/conformance/devices/minimal-processor/minimal-processor-adapter.js';
import {
  buildSyntheticMcu,
  createReference,
  firmwareFor,
  instructionCycles,
  syntheticTranslator,
  workloadNames,
} from './workloads/mcu.mjs';

export { instructionCycles, workloadNames };
export const limits = Object.freeze({ cyclesPerMcu: 5_000_000, aggregateCycles: 50_000_000 });
const allowedSizes = [1, 4, 16];
// SDK-independent IR identity is shared across AB/BA boards with matching timing/ISA.
const models = new Map();
export const defaults = Object.freeze({
  workload: 'alu-branch',
  size: 1,
  stepCycles: 10_000,
  cyclePs: 10_000,
  irqPeriodCycles: 97,
});

function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${label} must be an integer in [${min}, ${max}]`);
}

export function normalizeOptions(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('MCU options must be an object');
  for (const key of Object.keys(options))
    if (!Object.hasOwn(defaults, key)) throw new TypeError(`Unknown MCU option: ${key}`);
  const result = { ...defaults, ...options };
  if (!workloadNames.includes(result.workload)) throw new RangeError('Unknown MCU workload');
  if (!allowedSizes.includes(result.size)) throw new RangeError('MCU size must be 1, 4, or 16');
  integer(result.stepCycles, 1, 1_000_000, 'stepCycles');
  integer(result.cyclePs, 1, 1_000_000, 'cyclePs');
  integer(result.irqPeriodCycles, 17, 1_000_000, 'irqPeriodCycles');
  return result;
}

/**
 * Independent real SDK board; no global board state or alternate execution backend.
 * sdk is an imported simulator dist module, permitting AB/BA with alternative builds.
 * step(cycles?) times ONLY runUntil; verify() captures once at the current target and
 * checks an independent incremental interpreter, all RAM bytes, GPIO and IRQ state.
 * progress reads cumulative cycles/time without advancing or initializing the board.
 * Issued counts are cumulative from verify(); subtract two captures for a slice/window.
 * Never call verify before measuring the cold first step: capture initializes a board.
 */
export function create(sdk, options = {}) {
  const config = normalizeOptions(options);
  if (typeof sdk?.createBoard !== 'function' || typeof sdk?.createDeviceLibrary !== 'function')
    throw new TypeError('Supply the public simulator SDK module');
  const { size, workload, cyclePs, stepCycles } = config;
  const contexts = [];
  const modelKey = JSON.stringify([workload, cyclePs, config.irqPeriodCycles]);
  let model = models.get(modelKey);
  if (!model) {
    model = buildSyntheticMcu(config);
    models.set(modelKey, model);
  }
  const translate = syntheticTranslator(cyclePs);
  const library = sdk.createDeviceLibrary([
    {
      id: 'synthetic-mcu',
      model,
      create(context) {
        contexts.push(context);
        return createProcessor(context, translate);
      },
    },
  ]);
  const ids = Array.from({ length: size }, (_, index) => `mcu-${index}`);
  const endpoint = (instance, pin) => ({ instance, pin });
  const io = workload === 'gpio-timer-irq';
  const board = sdk.createBoard(library, {
    instances: ids.map((id) => ({
      id,
      type: 'synthetic-mcu',
      props: { firmware: firmwareFor(workload) },
    })),
    nets: io
      ? [
          { id: 'supply', voltage: 3.3, pins: ids.map((id) => endpoint(id, 'supply')) },
          { id: 'reference', voltage: 0, pins: ids.map((id) => endpoint(id, 'reference')) },
          ...ids.map((id) => ({
            id: `${id}-gpio`,
            pins: [endpoint(id, 'gpio'), endpoint(id, 'sense')],
          })),
        ]
      : [],
  });
  const reference = createReference(config);
  let disposed = false;
  let cycles = 0;
  const valid = () => {
    if (disposed) throw new Error('MCU benchmark is disposed');
  };
  return {
    board,
    model,
    config: Object.freeze(config),
    get progress() {
      return {
        time: cycles * cyclePs,
        simulatedSeconds: (cycles * cyclePs) / 1e12,
        cyclesPerMcu: cycles,
        aggregateCycles: cycles * size,
      };
    },
    unit: 'synthetic-cycles',
    description:
      'Synthetic minimal-accumulator MCU, not a physical ARM/AVR. Continuous JIT CPU execution; ' +
      'separate data RAM; two-cycle IRQ entry and IRET. No WAIT or host IRQ injection. ' +
      'GPIO mode retains scheduled timer, latched IRQ, RAM-backed ISR and electrical solves. ' +
      'No per-instruction host instrumentation; setup, oracle/capture and yields are untimed.',
    step(count = stepCycles) {
      valid();
      integer(count, 1, 1_000_000, 'step cycles');
      const next = cycles + count;
      if (next > limits.cyclesPerMcu || next * size > limits.aggregateCycles)
        throw new RangeError('MCU board cumulative cycle budget exceeded');
      const from = board.time;
      if (from !== cycles * cyclePs) throw new Error('Advance this MCU board through step() only');
      const to = next * cyclePs;
      const start = performance.now();
      board.runUntil(to);
      const wallSeconds = (performance.now() - start) / 1_000;
      cycles = next;
      return {
        from,
        to,
        cyclesPerMcu: count,
        aggregateCycles: count * size,
        simulatedSeconds: (count * cyclePs) / 1e12,
        wallSeconds,
      };
    },
    verify() {
      valid();
      assert.equal(board.status, 'ready');
      assert.equal(board.time, cycles * cyclePs);
      const expected = reference.advance(board.time);
      assert.equal(contexts.length, size);
      assert.equal(expected.elapsedBusyCycles, cycles, 'Continuous CPU cycle accounting');
      for (const context of contexts) context.inputs.snapshotRequest.notify();
      board.runUntil(board.time);
      const snapshots = contexts.map((context, index) => {
        const bytes = Uint8Array.from(context.memory.snapshot);
        const ram = Uint8Array.from(context.memory.ram);
        const expectedSnapshot = new Uint8Array(12);
        expectedSnapshot.set([
          expected.pc,
          expected.acc,
          expected.returnPc,
          Number(expected.irqPending),
          Number(expected.irqEnabled),
          expected.gpio,
          io ? expected.gpio : 0,
          io ? 1 - expected.gpio : 0,
        ]);
        new DataView(expectedSnapshot.buffer).setUint32(8, expected.timerTicks, true);
        assert.deepEqual(
          bytes,
          expectedSnapshot,
          `MCU ${index} CPU/GPIO/timer/IRQ at ${board.time}ps`,
        );
        assert.deepEqual(ram, expected.ram, `MCU ${index} data RAM at ${board.time}ps`);
        return { bytes, ram };
      });
      return {
        time: board.time,
        simulatedSeconds: board.time / 1e12,
        cyclesPerMcu: cycles,
        aggregateCycles: cycles * size,
        instructionsIssuedPerMcu: expected.instructionsIssued,
        instructionCycleCostIssuedPerMcu: expected.instructionCycleCostIssued,
        irqEntriesPerMcu: expected.irqEntries,
        terminalRemainingCyclesPerMcu: expected.terminalRemainingCycles,
        busyCyclesPerMcu: expected.elapsedBusyCycles,
        snapshots,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      board.dispose();
    },
  };
}

/** Count real-time MHz per MCU, NOT aggregate throughput or nominal simulated MHz. */
export function summarizeSteps({ size, cyclePs, steps, instructionsIssuedPerMcu }) {
  if (!allowedSizes.includes(size)) throw new RangeError('Invalid summary MCU size');
  integer(cyclePs, 1, 1_000_000, 'cyclePs');
  integer(instructionsIssuedPerMcu, 0, Number.MAX_SAFE_INTEGER, 'instructionsIssuedPerMcu');
  if (!Array.isArray(steps) || steps.length === 0) throw new RangeError('No step samples');
  let cyclesPerMcu = 0;
  let wallSeconds = 0;
  for (const step of steps) {
    integer(step.cyclesPerMcu, 1, limits.cyclesPerMcu, 'sample cyclesPerMcu');
    if (!Number.isFinite(step.wallSeconds) || step.wallSeconds <= 0)
      throw new RangeError('Sample wallSeconds must be positive');
    if (step.aggregateCycles !== undefined && step.aggregateCycles !== step.cyclesPerMcu * size)
      throw new RangeError('Sample aggregateCycles does not match MCU size');
    if (step.from !== undefined || step.to !== undefined) {
      integer(step.from, 0, Number.MAX_SAFE_INTEGER, 'sample from');
      integer(step.to, 0, Number.MAX_SAFE_INTEGER, 'sample to');
      if (step.to - step.from !== step.cyclesPerMcu * cyclePs)
        throw new RangeError('Sample target interval does not match cyclePs');
    }
    if (
      step.simulatedSeconds !== undefined &&
      step.simulatedSeconds !== (step.cyclesPerMcu * cyclePs) / 1e12
    )
      throw new RangeError('Sample simulatedSeconds does not match cyclePs');
    cyclesPerMcu += step.cyclesPerMcu;
    wallSeconds += step.wallSeconds;
  }
  const sorted = steps.map((step) => step.wallSeconds * 1_000).sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.ceil(sorted.length * p) - 1];
  const simulatedSeconds = (cyclesPerMcu * cyclePs) / 1e12;
  return {
    size,
    nominalCyclePs: cyclePs,
    nominalMHz: 1e6 / cyclePs,
    cyclesPerMcu,
    aggregateCycles: cyclesPerMcu * size,
    simulatedSeconds,
    wallSeconds,
    aggregateCyclesPerSecond: (cyclesPerMcu * size) / wallSeconds,
    effectiveRealTimeMHzPerMcu: cyclesPerMcu / wallSeconds / 1e6,
    realTimeFactor: simulatedSeconds / wallSeconds,
    instructionsIssuedPerMcu,
    aggregateInstructionsIssuedPerSecond: (instructionsIssuedPerMcu * size) / wallSeconds,
    instructionsIssuedPerSecondPerMcu: instructionsIssuedPerMcu / wallSeconds,
    stepMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
  };
}

export function parseArgs(args) {
  const options = {
    workloads: [...workloadNames],
    sizes: [...allowedSizes],
    samples: 20,
    warmup: 3,
    stepCycles: defaults.stepCycles,
    cyclePs: defaults.cyclePs,
    irqPeriodCycles: defaults.irqPeriodCycles,
  };
  const seen = new Set();
  const numeric = {
    samples: 'samples',
    warmup: 'warmup',
    'cycles-per-step': 'stepCycles',
    'cycle-ps': 'cyclePs',
    'irq-period-cycles': 'irqPeriodCycles',
  };
  for (const argument of args) {
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match) throw new TypeError(`Malformed MCU argument: ${argument}`);
    const [, key, value] = match;
    if (seen.has(key)) throw new TypeError(`Duplicate MCU option: ${key}`);
    seen.add(key);
    if (key === 'workloads') options.workloads = value.split(',');
    else if (key === 'sizes') {
      if (!/^\d+(,\d+)*$/.test(value)) throw new RangeError('Invalid sizes');
      options.sizes = value.split(',').map(Number);
    } else if (Object.hasOwn(numeric, key)) {
      if (!/^\d+$/.test(value)) throw new RangeError(`Invalid integer: ${key}`);
      options[numeric[key]] = Number(value);
    } else throw new TypeError(`Unknown MCU option: ${key}`);
  }
  for (const key of ['workloads', 'sizes'])
    if (options[key].length === 0 || new Set(options[key]).size !== options[key].length)
      throw new RangeError(`${key} must be nonempty and distinct`);
  integer(options.samples, 20, 200, 'samples');
  integer(options.warmup, 1, 20, 'warmup');
  for (const workload of options.workloads)
    for (const size of options.sizes)
      normalizeOptions({
        workload,
        size,
        stepCycles: options.stepCycles,
        cyclePs: options.cyclePs,
        irqPeriodCycles: options.irqPeriodCycles,
      });
  const steps = 1 + options.warmup + options.samples;
  const cyclesPerMcu = steps * options.stepCycles;
  const aggregate =
    options.workloads.length * options.sizes.reduce((a, b) => a + b, 0) * cyclesPerMcu;
  if (cyclesPerMcu > limits.cyclesPerMcu || aggregate > limits.aggregateCycles)
    throw new RangeError('Combined MCU CLI work exceeds cycle budget');
  return options;
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      'Usage: node packages\\simulator\\bench\\mcu.mjs ' +
        '[--workloads=alu-branch,ram,gpio-timer-irq] [--sizes=1,4,16] ' +
        '[--samples=20] [--warmup=3] [--cycles-per-step=10000] [--cycle-ps=10000] ' +
        '[--irq-period-cycles=97]\n' +
        'Bounds: samples 20..200, warmup 1..20, cycles-per-step 1..1000000, cycle-ps 1..1000000, ' +
        'IRQ period 17..1000000 cycles; <=5M cycles/MCU, <=50M aggregate cycles per invocation. ' +
        'JSON stdout. Synthetic MCU, not physical ARM/AVR MHz. Setup, verification and yields excluded.',
    );
    return;
  }
  const options = parseArgs(args);
  const sdk = await import('../dist/index.js');
  const results = [];
  for (const workload of options.workloads) {
    for (const size of options.sizes) {
      const bench = create(sdk, {
        workload,
        size,
        stepCycles: options.stepCycles,
        cyclePs: options.cyclePs,
        irqPeriodCycles: options.irqPeriodCycles,
      });
      try {
        const cold = bench.step();
        const coldState = bench.verify();
        for (let i = 0; i < options.warmup; i++) {
          bench.step();
          bench.verify();
          await yieldTurn();
        }
        const before = bench.verify();
        const steps = [];
        let final;
        for (let i = 0; i < options.samples; i++) {
          steps.push(bench.step());
          final = bench.verify();
          await yieldTurn();
        }
        results.push({
          workload,
          description: bench.description,
          coldFirstAdvance: summarizeSteps({
            size,
            cyclePs: options.cyclePs,
            steps: [cold],
            instructionsIssuedPerMcu: coldState.instructionsIssuedPerMcu,
          }),
          warmSteadyState: summarizeSteps({
            size,
            cyclePs: options.cyclePs,
            steps,
            instructionsIssuedPerMcu:
              final.instructionsIssuedPerMcu - before.instructionsIssuedPerMcu,
          }),
        });
      } finally {
        bench.dispose();
      }
    }
  }
  const hostCpus = cpus();
  console.log(
    JSON.stringify(
      {
        benchmark: 'synthetic-minimal-mcu-throughput',
        instructionCycles,
        irqEntryCycles: 2,
        options,
        host: {
          node: process.version,
          v8: process.versions.v8,
          platform: platform(),
          release: release(),
          arch: arch(),
          logicalCpus: hostCpus.length,
          cpuModel: hostCpus[0]?.model,
          execArgv: process.execArgv,
        },
        caveats: [
          'Synthetic instruction costs, not an ARM/AVR emulator or hardware performance claim.',
          'Effective MHz = elapsed cycles of ONE MCU / timed wall seconds / 1e6; aggregate cycles/s reported separately.',
          'Instruction rates count exactly derived ISSUED instructions, not retirements; IRQ entry is cycles but not an instruction.',
          'Elapsed busy cycles = issued instruction cycle costs + 2 * IRQ entries - terminal unelapsed remainder; no idle/WAIT cycles.',
          'Cold first advance includes initial scheduling, baseline electrical solve and JIT translation, not board/model creation.',
          'Cold means first advance of each board, not a fresh Node/V8 process; model IR identity is shared across matching configurations.',
          'Verification and event-loop yields are excluded but can affect host GC/JIT/cache conditions between samples.',
          'Warm means configured warmup steps, not proof of JIT path coverage; short/custom slices may not reach the first timer IRQ.',
          'MCUs run identical firmware in phase from t=0; these are synchronized independent workloads, not arbitrary firmware mixes.',
          'Warm summaries sum measured runUntil durations only; simulatedSeconds is one common board timeline, never multiplied by size.',
        ],
        results,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
