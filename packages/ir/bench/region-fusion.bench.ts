/**
 * Region fusion benchmark: cross-artifact redundant loads (O03, #158).
 *
 * A four-state machine, one provider artifact per state:
 *
 *  - every state imports the same shared configuration (`config_threshold`,
 *    `config_multiplier`) and reads it on every transition;
 *  - the configuration is mirrored into a constant-index `array`
 *    (`config_table`), the way a DBT keeps a descriptor block in guest memory,
 *    and every state reads its slot pair in every basic block as well;
 *  - a state does its work, publishes `current_state` and tail-dispatches the
 *    next state, so the chain is one hot dispatch ring;
 *  - the entry resets the machine and dispatches state 0, so one measured op
 *    runs exactly {@link TRANSITIONS} state transitions.
 *
 * Once the ring is hot, the region compiler (O01) fuses the four artifacts into
 * one JavaScript function. O03 (`jit.optimizations.loadElim`, #152/#158) is the
 * switch under test: it is what lets a dominated block reuse the value an
 * earlier block already loaded instead of reading storage again.
 *
 * The two memory layers are deliberate. Region compilation already hoists
 * `state` accesses shared by several members into region-wide locals, so the
 * `state` configuration measures that layer and comes out the same in both
 * configurations. Constant-index `array` elements are *not* promoted — they may
 * alias another member's access — so the `config_table` reads are the ones O03
 * removes inside the fused region. That is the cross-block load elimination
 * this benchmark exists to validate: per transition, each configuration slot is
 * read in the entry, work and exit blocks, and O03 leaves only the entry read
 * (the benchmark logs the emitted read counts).
 *
 * Both engines run the same module; only the O03 switch differs. The reported
 * ops/sec converts directly to transitions per second:
 *
 *     transitions/s = hz × TRANSITIONS
 */
import { test } from 'vitest';
import { CORE_INSTRUCTION_NAMES } from '../src/builder';
import { createIRInterpreter, createIRJIT, createIRModule } from '../src/index';
import { jitInternals } from '../src/jit-runtime';
import type { IRJITInternals } from '../src/jit-runtime';
import type {
  ArrayRef,
  FunctionRef,
  IRExecutionContext,
  IRModule,
  IRValidationOptions,
  ProviderRef,
  StateRef,
} from '../src/index';

/** Provider artifacts in the ring: idle → processing → waiting → draining. */
const STATE_COUNT = 4;
/** State transitions executed by one measured op (the task asks for 1000+). */
const TRANSITIONS = 4_096;
/** Warm-up runs; the first two already cross `REGION_THRESHOLD` entries. */
const WARMUP_RUNS = 100;

/** Shared configuration, mirrored into `config_table` slot pairs. */
const CONFIG = Object.freeze({ threshold: 0x0000_00ff, multiplier: 0x0000_0101 });

const CONTEXT: IRExecutionContext = Object.freeze({
  instanceId: 'region-fusion-bench',
  virtualTime: 0,
});

interface MachineRefs {
  readonly threshold: StateRef<'u32'>;
  readonly multiplier: StateRef<'u32'>;
  readonly current: StateRef<'u8'>;
  readonly counter: StateRef<'u32'>;
  /** Constant-index configuration table: interleaved threshold/multiplier. */
  readonly configTable: ArrayRef<'u32'>;
}

interface MachineFixture {
  readonly module: IRModule;
  readonly run: FunctionRef<readonly ['u32'], readonly ['u32']>;
  readonly refs: MachineRefs;
  readonly validation: IRValidationOptions;
}

function validationFor(module: IRModule): IRValidationOptions {
  const instructions = [...CORE_INSTRUCTION_NAMES];
  return Object.freeze({
    supportedInstructions: instructions,
    authorizedInstructions: instructions,
    resources: Object.freeze(
      module.memories.map((memory) => ({
        ref: memory.ref,
        access: memory.writable ? ('read-write' as const) : ('read' as const),
      })),
    ),
  });
}

/**
 * Build the state machine.
 *
 * Each artifact is a self-contained translation unit: its entry block loads the
 * shared configuration, its work block loads it again (dominated by the entry),
 * and its exit block reloads it once more. Without O03 every block pays for its
 * own load; with O03 only the dominating load survives.
 */
function buildMachine(): MachineFixture {
  const module = createIRModule();
  const threshold = module.state('config_threshold', 'u32', CONFIG.threshold);
  const multiplier = module.state('config_multiplier', 'u32', CONFIG.multiplier);
  const current = module.state('current_state', 'u8', 0);
  const counter = module.state('counter', 'u32', 0);
  const configTable = module.array(
    'config_table',
    'u32',
    Array.from({ length: STATE_COUNT }, () => [CONFIG.threshold, CONFIG.multiplier]).flat(),
  );
  const refs: MachineRefs = Object.freeze({ threshold, multiplier, current, counter, configTable });

  const states: ProviderRef<readonly ['u8'], readonly ['u32'], readonly ['u32']> = module.provider(
    'states',
    {
      keyTypes: ['u8'],
      params: ['u32'],
      results: ['u32'],
      reads: [],
      imports: [threshold, multiplier, current, counter, configTable],
    },
    (gen, [key]) => {
      const index = key as number;
      const next = (index + 1) % STATE_COUNT;
      const limitSlot = index * 2;
      const scaleSlot = limitSlot + 1;
      return gen.function((b, [remaining]) => {
        const zero = b.const('u32', 0);
        const one = b.const('u32', 1);
        const work = b.block(['u32', 'u32']);
        const tail = b.block(['u32', 'u32']);
        const done = b.block(['u32']);

        // State entry: read the shared configuration once per transition. The
        // seed carries those values into the work block; the later blocks still
        // reload them, and those are the redundant loads O03 removes.
        const entryThreshold = b.state.load(threshold);
        const entryMultiplier = b.state.load(multiplier);
        const entryLimit = b.array.load(configTable, b.const('u32', limitSlot));
        const entryScale = b.array.load(configTable, b.const('u32', scaleSlot));
        const seed = b.int.add(
          b.int.add(entryLimit, entryScale),
          b.int.add(entryThreshold, entryMultiplier),
        );
        b.state.store(current, b.const('u8', index));
        b.branch(
          b.int.cmp('eq', remaining, zero),
          { target: done, args: [remaining] },
          { target: work, args: [remaining, seed] },
        );

        b.at(work, (inner, [budget, carried]) => {
          // O03: these loads are dominated by the entry block's loads.
          const limit = inner.array.load(configTable, inner.const('u32', limitSlot));
          const scale = inner.array.load(configTable, inner.const('u32', scaleSlot));
          const count = inner.state.load(counter);
          const advanced = inner.int.add(
            inner.int.add(count, inner.int.mul(scale, inner.const('u32', index + 1))),
            inner.int.add(limit, carried),
          );
          inner.jump(tail, [budget, advanced]);
        });

        b.at(tail, (inner, [budget, advanced]) => {
          // O03: the state's exit path reuses the same dominating loads.
          const limit = inner.array.load(configTable, inner.const('u32', limitSlot));
          const scale = inner.array.load(configTable, inner.const('u32', scaleSlot));
          inner.state.store(counter, inner.int.add(advanced, inner.int.and(limit, scale)));
          inner.state.store(current, inner.const('u8', next));
          inner.dispatch(states, [inner.const('u8', next)], [inner.int.sub(budget, one)]);
        });

        b.at(done, (inner) => {
          // O03: the return path reuses the entry block's loads as well.
          const limit = inner.array.load(configTable, inner.const('u32', limitSlot));
          const scale = inner.array.load(configTable, inner.const('u32', scaleSlot));
          const count = inner.state.load(counter);
          inner.return([inner.int.add(count, inner.int.mul(scale, limit))]);
        });
      });
    },
  );

  const run = module.func('run', { params: ['u32'], results: ['u32'] });
  run.body((b, [transitions]) => {
    b.state.store(counter, b.const('u32', 0));
    b.state.store(current, b.const('u8', 0));
    b.dispatch(states, [b.const('u8', 0)], [transitions]);
  });

  return { module, run, refs, validation: validationFor(module) };
}

const fixture = buildMachine();
const { module, run, validation } = fixture;

function engine(loadElim: boolean) {
  return createIRJIT(module, {
    validation,
    maxSteps: Number.MAX_SAFE_INTEGER,
    jit: { optimizations: { loadElim } },
  });
}

function internals(runtime: ReturnType<typeof createIRJIT>): IRJITInternals {
  return (runtime as unknown as Record<symbol, IRJITInternals>)[jitInternals]!;
}

const withLoadElim = engine(true);
const withoutLoadElim = engine(false);

// Warm up outside the measured region: `REGION_THRESHOLD` entries per artifact
// are needed before the ring is fused, and both engines must be there before
// the first measured iteration.
for (let index = 0; index < WARMUP_RUNS; index += 1) {
  withLoadElim.execute(run, [TRANSITIONS], CONTEXT);
  withoutLoadElim.execute(run, [TRANSITIONS], CONTEXT);
}

const optimizedSource = internals(withLoadElim).regionSource ?? '';
const baselineSource = internals(withoutLoadElim).regionSource ?? '';
/**
 * Number of array reads emitted into a region source, independent of the host
 * endianness (a typed view on little-endian hosts, a `DataView` otherwise).
 */
const arrayReads = (source: string): number =>
  source.split('.view[').length - 1 + (source.split('.data.get').length - 1);

console.log(
  `[region-fusion.bench] regions: loadElim ${internals(withLoadElim).regions}, ` +
    `baseline ${internals(withoutLoadElim).regions}; region source ` +
    `${optimizedSource.length} B / ${baselineSource.length} B; config_table reads ` +
    `${arrayReads(optimizedSource)} / ${arrayReads(baselineSource)}`,
);
console.log(
  `[region-fusion.bench] one op = ${TRANSITIONS} state transitions ` +
    `(${STATE_COUNT} artifacts × ${TRANSITIONS / STATE_COUNT} visits each)`,
);

// The benchmark only measures what it claims when the ring is really fused
// into one region and O03 really removed the dominated table reads. Without
// those two invariants the timing comparison would silently measure nothing.
if (internals(withLoadElim).regions < 1 || internals(withoutLoadElim).regions < 1) {
  throw new Error('region fusion benchmark requires a compiled region in both engines');
}
if (!optimizedSource.includes(`case ${STATE_COUNT - 1}:`)) {
  throw new Error(
    `region fusion benchmark expected ${STATE_COUNT} fused artifacts in the region source`,
  );
}
if (arrayReads(optimizedSource) >= arrayReads(baselineSource)) {
  throw new Error(
    'O03 did not eliminate the cross-block config_table loads; check the loadElim pipeline',
  );
}

const OPTIMIZED = `loadElim / ${STATE_COUNT}-state ring (transitions/s = hz × ${TRANSITIONS})`;
const BASELINE = `baseline / ${STATE_COUNT}-state ring (transitions/s = hz × ${TRANSITIONS})`;

test(`region fusion: ${STATE_COUNT} artifacts × ${TRANSITIONS} transitions`, async ({ bench }) => {
  const results = await bench.compare(
    bench(OPTIMIZED, () => {
      withLoadElim.execute(run, [TRANSITIONS], CONTEXT);
    }),
    bench(BASELINE, () => {
      withoutLoadElim.execute(run, [TRANSITIONS], CONTEXT);
    }),
    { time: 5_000, warmupTime: 1_000 },
  );

  const optimized = results.get(OPTIMIZED).throughput.mean;
  const baseline = results.get(BASELINE).throughput.mean;
  const optimizedRate = (optimized * TRANSITIONS) / 1_000_000;
  const baselineRate = (baseline * TRANSITIONS) / 1_000_000;
  console.log(
    `[region-fusion.bench] measured: loadElim ${optimizedRate.toFixed(1)} M transitions/s, ` +
      `baseline ${baselineRate.toFixed(1)} M transitions/s ` +
      `(${((optimized / baseline) * 100 - 100).toFixed(1)} % faster; issue #158 targets 4-6 %)`,
  );
  // Timing on a shared machine is noisy, so the floor stays loose: the
  // structural checks above are what prove O03 ran, this only catches a real
  // regression (for example the region falling back to the trampoline).
  if (!(optimized > baseline * 0.9)) {
    throw new Error(
      'region fusion benchmark regressed by more than 10 %; check the O03 pipeline configuration',
    );
  }
});

test('region fusion: identical values and steps to the reference interpreter', () => {
  const reference = createIRInterpreter(module, {
    validation,
    maxSteps: Number.MAX_SAFE_INTEGER,
  });
  const expected = reference.execute(run, [TRANSITIONS], CONTEXT);
  for (const [name, runtime] of [
    ['loadElim', withLoadElim],
    ['baseline', withoutLoadElim],
  ] as const) {
    const actual = runtime.execute(run, [TRANSITIONS], CONTEXT);
    if (actual.steps !== expected.steps) {
      throw new Error(
        `${name} executed ${actual.steps} steps, reference executed ${expected.steps}`,
      );
    }
    if (String(actual.values) !== String(expected.values)) {
      throw new Error(
        `${name} returned ${String(actual.values)}, reference returned ${String(expected.values)}`,
      );
    }
  }
});
