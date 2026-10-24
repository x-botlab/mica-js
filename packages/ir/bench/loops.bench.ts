/**
 * Small-loop throughput benchmark (O02).
 *
 * The M3 benchmark is a tail-dispatch chain of straight-line guest blocks: it
 * has no IR-level loops, so loop unrolling cannot change its throughput. This
 * benchmark measures the transformation itself on the shape it targets: a chain
 * of counted loops (`for (i = 0; i < 64; i += 1)`) inside one function.
 * Both engines execute the same module; only the `unroll` switch differs. One
 * `execute` call runs a fixed number of reference steps, so the reported
 * ops/sec converts directly to guest M inst/s:
 *
 *     M inst/s = hz × (STEPS / 1_000_000)
 */
import { test } from 'vitest';
import { CORE_INSTRUCTION_NAMES } from '../src/builder';
import { createIRInterpreter, createIRJIT, createIRModule } from '../src/index';
import type { IRExecutionContext } from '../src/interpreter';
import { runOptimizationPipeline } from '../src/jit/passes';
import { compileModule } from '../src/jit/testing/compile-module';
import type { BlockRef, FunctionRef, IRModule } from '../src/types';
import type { IRValidationOptions } from '../src/validation-types';

/**
 * Number of sequential counted loops in the function.
 *
 * The unroll pass spends one growth allowance per function (default: 20 % of
 * its instruction count, at least 128 instructions). Each 64-trip loop here is
 * partially unrolled four times over, which costs 4 × 3 + 3 × 2 = 18
 * instructions, so the seven-loop chain fits the default allowance (126).
 */
const LOOPS = 7;
/** Trip count of every loop: partially unrolled four times over. */
const TRIPS = 64;

const CONTEXT: IRExecutionContext = Object.freeze({ instanceId: 'loops-bench', virtualTime: 0 });

function buildChain(): { module: IRModule; fn: FunctionRef<readonly ['u32'], readonly ['u32']> } {
  const module = createIRModule();
  const fn = module.func('chain', { params: ['u32'], results: ['u32'] });
  fn.body((b, [seed]) => {
    const zero = b.const('u32', 0);
    const one = b.const('u32', 1);
    const bound = b.const('u32', TRIPS);
    const three = b.const('u32', 3);
    const heads: BlockRef<readonly ['u32', 'u32']>[] = [];
    const bodies: BlockRef<readonly ['u32', 'u32']>[] = [];
    const dones: BlockRef<readonly ['u32']>[] = [];
    for (let index = 0; index < LOOPS; index += 1) {
      heads.push(b.block(['u32', 'u32']));
      bodies.push(b.block(['u32', 'u32']));
      dones.push(b.block(['u32']));
    }
    b.jump(heads[0]!, [zero, seed]);
    for (let index = 0; index < LOOPS; index += 1) {
      const head = heads[index]!;
      const body = bodies[index]!;
      const done = dones[index]!;
      const next = heads[index + 1];
      b.at(head, (inner, [cursor, acc]) =>
        inner.branch(
          inner.int.cmp('lt', cursor, bound),
          { target: body, args: [cursor, acc] },
          { target: done, args: [acc] },
        ),
      );
      b.at(body, (inner, [cursor, acc]) =>
        inner.jump(head, [
          inner.int.add(cursor, one),
          inner.int.add(acc, inner.int.mul(cursor, three)),
        ]),
      );
      b.at(done, (inner, [acc]) =>
        next === undefined ? inner.return([acc]) : inner.jump(next, [zero, acc]),
      );
    }
  });
  return { module, fn };
}

function validationFor(module: IRModule): IRValidationOptions {
  return {
    supportedInstructions: [...CORE_INSTRUCTION_NAMES],
    authorizedInstructions: [...CORE_INSTRUCTION_NAMES],
    resources: module.memories.map((memory) => ({
      ref: memory.ref,
      access: memory.writable ? ('read-write' as const) : ('read' as const),
    })),
  };
}

/** Lowered instruction count and emitted JavaScript size per configuration. */
function codeSize(unroll: boolean): { readonly mir: number; readonly source: number } {
  const engine = compileModule(
    module,
    { validation, maxSteps: Number.MAX_SAFE_INTEGER },
    { transform: (mir) => runOptimizationPipeline(mir, { passes: { unroll } }) },
  );
  engine.execute(fn, [0], CONTEXT);
  const mir = engine.mir[0]!;
  return {
    mir: mir.blocks.reduce((total, block) => total + block.insts.length, 0),
    source: engine.source(0).length,
  };
}

const { module, fn } = buildChain();
const validation = validationFor(module);
const STEPS = createIRInterpreter(module, { validation }).execute(fn, [0], CONTEXT).steps;
const unrolledSize = codeSize(true);
const baselineSize = codeSize(false);

function engine(unroll: boolean) {
  return createIRJIT(module, {
    validation,
    maxSteps: Number.MAX_SAFE_INTEGER,
    jit: { optimizations: { unroll } },
  });
}

const withUnroll = engine(true);
const withoutUnroll = engine(false);
// Compile outside the measured region.
withUnroll.execute(fn, [0], CONTEXT);
withoutUnroll.execute(fn, [0], CONTEXT);

const millionsPerOp = STEPS / 1_000_000;
const UNROLLED = `unroll / ${LOOPS} x ${TRIPS}-trip chain (M inst/s = hz × ${millionsPerOp})`;
const BASELINE = `baseline / ${LOOPS} x ${TRIPS}-trip chain (M inst/s = hz × ${millionsPerOp})`;

console.log(
  `[loops.bench] one op = ${STEPS.toLocaleString()} reference steps ` +
    `(${LOOPS} loops × ${TRIPS} trips); code size: ` +
    `unroll ${unrolledSize.mir} MIR / ${unrolledSize.source} B, ` +
    `baseline ${baselineSize.mir} MIR / ${baselineSize.source} B ` +
    `(${((unrolledSize.source / baselineSize.source) * 100 - 100).toFixed(1)} % source)`,
);

test(`${LOOPS} × ${TRIPS}-trip loops: unrolled vs baseline`, async ({ bench }) => {
  const results = await bench.compare(
    bench(UNROLLED, () => {
      withUnroll.execute(fn, [0], CONTEXT);
    }),
    bench(BASELINE, () => {
      withoutUnroll.execute(fn, [0], CONTEXT);
    }),
    { time: 3_000, warmupTime: 500 },
  );

  const unrolledMips = (results.get(UNROLLED).throughput.mean * STEPS) / 1_000_000;
  const baselineMips = (results.get(BASELINE).throughput.mean * STEPS) / 1_000_000;
  console.log(
    `[loops.bench] measured: unroll ${unrolledMips.toFixed(3)} M inst/s, ` +
      `baseline ${baselineMips.toFixed(3)} M inst/s ` +
      `(${((unrolledMips / baselineMips) * 100 - 100).toFixed(1)} % faster)`,
  );
  if (!(unrolledMips > baselineMips * 0.5)) {
    throw new Error(
      'loop unrolling lost a large amount of throughput; check the pass configuration',
    );
  }
});
