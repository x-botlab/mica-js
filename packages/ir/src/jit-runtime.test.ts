import { describe, expect, it, vi } from 'vitest';
import { CORE_INSTRUCTION_NAMES } from './builder';
import {
  IRExecutionError,
  createIRInterpreter,
  createIRModule,
  type BytesRef,
  type EntryRef,
  type FunctionRef,
  type IRExecutionContext,
  type IRInterpreter,
  type IRModule,
  type IRResourcePermission,
  type IRValidationOptions,
  type LifecycleRef,
  type ProviderRef,
  type RuntimeScalar,
  type StateRef,
} from './index';
import { createIRJIT, jitInternals } from './jit-runtime';
import type { IRJITInternals } from './jit-runtime';

/* -------------------------------------------------------------------------
 * Harness
 * ---------------------------------------------------------------------- */

const context: IRExecutionContext = { instanceId: 'jit-runtime', virtualTime: 21 };

type Target = FunctionRef | EntryRef | LifecycleRef;

function policy(
  module: IRModule,
  extra: readonly IRResourcePermission[] = [],
): IRValidationOptions {
  return Object.freeze({
    supportedInstructions: CORE_INSTRUCTION_NAMES,
    authorizedInstructions: CORE_INSTRUCTION_NAMES,
    resources: Object.freeze([
      ...module.memories.map((memory) => ({
        ref: memory.ref,
        access: memory.writable ? ('read-write' as const) : ('read' as const),
      })),
      ...extra,
    ]),
  });
}

interface Outcome {
  readonly ok: boolean;
  readonly values: readonly RuntimeScalar[] | undefined;
  readonly steps: number;
  readonly code?: string | undefined;
  readonly message?: string | undefined;
  readonly location?: unknown;
  readonly callStack?: unknown;
  readonly context?: unknown;
  readonly causeName?: string | undefined;
  readonly causeCode?: string | undefined;
}

function capture(
  run: () => { readonly values: readonly RuntimeScalar[]; readonly steps: number },
): Outcome {
  try {
    const result = run();
    return { ok: true, values: result.values, steps: result.steps };
  } catch (caught) {
    if (!(caught instanceof IRExecutionError)) throw caught;
    const cause = caught.cause as { readonly name?: unknown; readonly code?: unknown } | undefined;
    return {
      ok: false,
      values: undefined,
      steps: caught.steps,
      code: caught.code,
      message: caught.message,
      location: caught.location,
      callStack: caught.callStack,
      context: caught.context,
      causeName: typeof cause?.name === 'string' ? cause.name : undefined,
      causeCode: typeof cause?.code === 'string' ? cause.code : undefined,
    };
  }
}

function engine(
  module: IRModule,
  options: Record<string, unknown> = {},
  permissions: readonly IRResourcePermission[] = [],
): IRInterpreter {
  return createIRJIT(module, {
    validation: policy(module, permissions),
    ...options,
  } as Parameters<typeof createIRJIT>[1]);
}

function referenceEngine(
  module: IRModule,
  options: Record<string, unknown> = {},
  permissions: readonly IRResourcePermission[] = [],
): IRInterpreter {
  return createIRInterpreter(module, {
    validation: policy(module, permissions),
    ...options,
  } as Parameters<typeof createIRInterpreter>[1]);
}

function maybeInternals(runtime: IRInterpreter): IRJITInternals | undefined {
  return (runtime as unknown as Record<symbol, IRJITInternals | undefined>)[jitInternals];
}

function internals(runtime: IRInterpreter): IRJITInternals {
  const value = maybeInternals(runtime);
  if (value === undefined) throw new Error('Not a JIT interpreter');
  return value;
}

/** Compare one call on fresh engines; fresh instances make failures comparable. */
function parity(
  module: IRModule,
  target: Target,
  inputs: readonly (readonly RuntimeScalar[])[],
  options: () => Record<string, unknown> = () => ({}),
): void {
  for (const args of inputs) {
    const expected = capture(() =>
      referenceEngine(module, options()).execute(target, args, context),
    );
    const actual = capture(() => engine(module, options()).execute(target, args, context));
    expect({ args, actual }).toEqual({ args, actual: expected });
  }
}

/* -------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------- */

function identityFixture() {
  const module = createIRModule();
  const identity = module.func('identity', { params: ['u32'], results: ['u32'] });
  identity.body((b, [value]) => b.return([value]));
  return { module, identity };
}

function countedLoopFixture() {
  const module = createIRModule();
  const sum = module.func('sum', { params: ['u32'], results: ['u32'] });
  sum.body((b, [n]) => {
    const zero = b.const('u32', 0);
    const one = b.const('u32', 1);
    const loop = b.block(['u32', 'u32']);
    const body = b.block(['u32', 'u32']);
    const done = b.block(['u32']);
    b.jump(loop, [zero, zero]);
    b.at(loop, (inner, [index, total]) =>
      inner.branch(
        inner.int.cmp('lt', index, n),
        { target: body, args: [index, total] },
        { target: done, args: [total] },
      ),
    );
    b.at(body, (inner, [index, total]) => {
      const next = inner.int.add(index, one);
      inner.jump(loop, [next, inner.int.add(total, next)]);
    });
    b.at(done, (inner, [total]) => inner.return([total]));
  });
  return { module, sum };
}

function nestedDivisionFixture() {
  const module = createIRModule();
  const state = module.state('state', 'u32', 0);
  const divide = module.func('divide', { params: ['u32'], results: ['u32'] });
  divide.body((b, [d]) => b.return([b.int.div(b.const('u32', 8), d)]));
  const middle = module.func('middle', { params: ['u32'], results: ['u32'] });
  middle.body((b, [d]) => b.return(b.call(divide, [d])));
  const outer = module.func('outer', { params: ['u32'], results: [] });
  outer.body((b, [d]) => {
    b.state.store(state, b.const('u32', 1));
    b.call(middle, [d]);
    b.state.store(state, b.const('u32', 2));
    b.return([]);
  });
  return { module, divide, middle, outer, state };
}

function contractFixture() {
  const module = createIRModule();
  const counter = module.state('counter', 'u32', 0);
  const echo = module.func('echo', {
    params: ['f32', 'f64', 'bool'],
    results: ['f32', 'f64', 'bool'],
  });
  echo.body((b, values) => b.return(values));
  const pair = module.func('pair', { params: ['u32'], results: ['u32', 'bool'] });
  pair.body((b, [value]) => b.return([b.int.add(value, b.const('u32', 1)), b.const('bool', true)]));
  const nothing = module.func('nothing', { params: [], results: [] });
  nothing.body((b) => b.return([]));
  const bump = module.entry('bump', ['u32']);
  bump.body((b, [by]) => {
    b.state.store(counter, b.int.add(b.state.load(counter), by));
    b.return([]);
  });
  const initialize = module.lifecycle('initialize', []);
  initialize.body((b) => {
    b.state.store(counter, b.const('u32', 100));
    b.return([]);
  });
  return { module, counter, echo, pair, nothing, bump, initialize };
}

function readingProviderFixture() {
  const module = createIRModule();
  const firmware = module.bytes('firmware', new Uint8Array([1, 2, 3, 4]), {
    readonly: true,
    unitBytes: 2,
  });
  const read = module.provider(
    'read',
    {
      keyTypes: ['u32'],
      params: ['u32'],
      results: ['u32'],
      reads: [firmware],
      imports: [],
    },
    (gen, [offset]) => {
      const value = gen.readBytes(firmware, offset as number, 1)[0]!;
      return gen.function((b, [x]) => b.return([b.int.add(x, b.const('u32', value))]));
    },
  );
  const run = module.func('run', { params: ['u32', 'u32'], results: ['u32'] });
  run.body((b, [value, key]) => b.dispatch(read, [key], [value]));
  return { module, firmware, read, run };
}

/**
 * Two-level provider chain: `outer` is a generated artifact that dispatches to
 * `base`, whose generation reads firmware.
 */
function chainedProviderFixture() {
  const module = createIRModule();
  const firmware = module.bytes('firmware', new Uint8Array([1, 2, 3, 4]), {
    readonly: true,
    unitBytes: 2,
  });
  const base = module.provider(
    'base',
    {
      keyTypes: ['u32'],
      params: ['u32'],
      results: ['u32'],
      reads: [firmware],
      imports: [],
    },
    (gen, [factor]) => {
      const offset = gen.readBytes(firmware, 0, 1)[0]!;
      return gen.function((b, [x]) =>
        b.return([
          b.int.add(b.int.mul(x, b.const('u32', factor as number)), b.const('u32', offset)),
        ]),
      );
    },
  );
  const outer = module.provider(
    'outer',
    {
      keyTypes: ['u32'],
      params: ['u32'],
      results: ['u32'],
      reads: [],
      imports: [base],
    },
    (gen, [factor]) =>
      gen.function((b, [x]) => b.dispatch(base, [b.const('u32', factor as number)], [x])),
  );
  const run = module.func('run', { params: ['u32'], results: ['u32'] });
  run.body((b, [value]) => b.dispatch(outer, [b.const('u32', 2)], [value]));
  return { module, firmware, base, outer, run };
}

interface RecoveryFixture {
  readonly module: IRModule;
  readonly firmware: BytesRef;
  readonly pc: StateRef<'u32'>;
  readonly result: StateRef<'u32'>;
  readonly patches: StateRef<'u32'>;
  readonly run: FunctionRef;
  readonly calls: { generated: number };
}

/**
 * Artifact that updates a depended-on unit and then hits a checkpoint, copied
 * from the reference checkpoint tests. Recovery must regenerate the artifact
 * and re-enter through the tail trampoline.
 */
function recoveryFixture(): RecoveryFixture {
  const calls = { generated: 0 };
  const module = createIRModule();
  const firmware = module.bytes('firmware', new Uint8Array([1, 2, 3, 4]), {
    readonly: true,
    unitBytes: 2,
  });
  const patch = module.bytes('patch', new Uint8Array([9]), { readonly: true });
  const pc = module.state('pc', 'u32', 0);
  const result = module.state('result', 'u32', 0);
  const patches = module.state('patches', 'u32', 0);
  const update = module.func('update', { params: [], results: [] });
  update.body((b) => {
    b.resource.updateBytes(
      firmware,
      b.const('u32', 0),
      patch,
      b.const('u32', 0),
      b.const('u32', 1),
    );
    b.state.store(patches, b.int.add(b.state.load(patches), b.const('u32', 1)));
    b.return([]);
  });
  const code: ProviderRef<readonly ['u32'], readonly [], readonly []> = module.provider(
    'code',
    {
      keyTypes: ['u32'],
      params: [],
      results: [],
      reads: [firmware],
      imports: [pc, result, patches, update],
    },
    (gen, [address]) => {
      calls.generated += 1;
      const value = gen.readBytes(firmware, address as number, 1)[0]!;
      return gen.function((b) => {
        if (address !== 0) {
          b.state.store(result, b.const('u32', 2000 + value));
          b.state.store(pc, b.const('u32', 2));
          b.return([]);
          return;
        }
        const nextPc = b.const('u32', 2);
        b.call(update, []);
        b.state.store(pc, nextPc);
        b.checkpoint(code, [nextPc], []);
        b.state.store(result, b.const('u32', 1000 + value));
        b.return([]);
      });
    },
  );
  const run = module.func('run', { params: [], results: [] });
  run.body((b) => b.dispatch(code, [b.state.load(pc)], []));
  return { module, firmware, pc, result, patches, run, calls };
}

/* -------------------------------------------------------------------------
 * Creation contract
 * ---------------------------------------------------------------------- */

describe('createIRJIT creation', () => {
  it('exposes the reference interpreter surface and freezes it', () => {
    const { module } = identityFixture();
    const runtime = engine(module);
    expect(typeof runtime.execute).toBe('function');
    expect(runtime.storage).toBeDefined();
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(internals(runtime)).toMatchObject({
      mode: 'jit',
      tier: 'auto',
      warmup: 'lazy',
      compiledFunctions: 0,
      compiledArtifacts: 0,
    });
  });

  it('reports the same creation errors as the reference interpreter', () => {
    const { module } = identityFixture();
    const cases: readonly [string, Record<string, unknown>][] = [
      ['options', { options: null }],
      ['maxSteps', { options: { maxSteps: -1 } }],
      ['stepObserver', { options: { stepObserver: {} } }],
      [
        'mutually exclusive',
        {
          options: {
            stepObserver: { beforeStep: () => undefined },
            stepBudget: { remaining: () => 1, consume: () => undefined },
          },
        },
      ],
    ];
    const creation = (create: () => unknown) => {
      try {
        create();
        return { ok: true };
      } catch (cause) {
        if (!(cause instanceof IRExecutionError)) throw cause;
        return { ok: false, code: cause.code, message: cause.message };
      }
    };
    for (const [label, entry] of cases) {
      const options = entry.options as Record<string, unknown>;
      expect({
        label,
        outcome: creation(() => createIRJIT(module, options as never)),
      }).toEqual({
        label,
        outcome: creation(() => createIRInterpreter(module, options as never)),
      });
    }
  });

  it.each([
    [null, /jit must be an object/],
    [[], /jit must be an object/],
    [{ nope: true }, /Unknown JIT option "nope"/],
    [{ tier: 'warm' }, /jit.tier/],
    [{ codegen: 'maybe' }, /jit.codegen/],
    [{ warmup: 'later' }, /jit.warmup/],
    [{ artifactWarmup: -1 }, /jit.artifactWarmup/],
    [{ artifactWarmup: 1.5 }, /jit.artifactWarmup/],
    [{ maxCompiledDepth: 0 }, /jit.maxCompiledDepth/],
    [{ maxCompiledDepth: Number.NaN }, /jit.maxCompiledDepth/],
    [{ optimizations: [] }, /jit.optimizations/],
    [{ optimizations: { teleport: true } }, /Unknown JIT optimization "teleport"/],
    [{ checkpointGranularity: 'per-block' }, /jit.checkpointGranularity/],
    [{ debug: null }, /jit.debug/],
    [{ debug: { verify: 'yes' } }, /jit.debug.verify/],
    [{ debug: { traces: true } }, /Unknown JIT debug option "traces"/],
  ] as const)('rejects invalid tuning %#', (jit, message) => {
    const { module } = identityFixture();
    let caught: unknown;
    try {
      engine(module, { jit });
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(IRExecutionError);
    expect((caught as IRExecutionError).code).toBe('invalid-options');
    expect((caught as IRExecutionError).message).toMatch(message);
  });

  it('accepts the documented tuning surface', () => {
    const { module, identity } = identityFixture();
    const runtime = engine(module, {
      jit: {
        tier: 'compiled',
        codegen: 'auto',
        warmup: 'eager',
        artifactWarmup: 2,
        maxCompiledDepth: 32,
        checkpointGranularity: 'per-safepoint',
        optimizations: {},
        debug: { verify: true },
      },
    });
    expect(internals(runtime).warmup).toBe('eager');
    expect(runtime.execute(identity, [7], context)).toEqual({ values: [7], steps: 1 });
  });

  it('rejects unknown JIT options before running any code', () => {
    const { module } = identityFixture();
    expect(() => engine(module, { jit: { nope: true } })).toThrow(/Unknown JIT option/);
  });

  it('falls back to the reference interpreter when codegen is unavailable', () => {
    const { module, identity } = identityFixture();
    vi.stubGlobal('Function', function blocked(): never {
      throw new Error('CSP');
    });
    try {
      const runtime = engine(module);
      expect(maybeInternals(runtime)).toBeUndefined();
      expect(runtime.execute(identity, [11], context)).toEqual({ values: [11], steps: 1 });
      expect(Object.isFrozen(runtime)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports invalid-options when codegen is required but unavailable', () => {
    const { module } = identityFixture();
    vi.stubGlobal('Function', function blocked(): never {
      throw new Error('CSP');
    });
    try {
      let caught: unknown;
      try {
        engine(module, { jit: { codegen: 'require' } });
      } catch (cause) {
        caught = cause;
      }
      expect(caught).toBeInstanceOf(IRExecutionError);
      expect(caught).toMatchObject({
        code: 'invalid-options',
        message: 'JIT code generation is unavailable in this environment',
      });
      expect((caught as IRExecutionError).cause).toBeInstanceOf(Error);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses the reference engine for the heap tier', () => {
    const { module, identity } = identityFixture();
    const runtime = engine(module, { jit: { tier: 'heap' } });
    expect(maybeInternals(runtime)).toBeUndefined();
    expect(runtime.execute(identity, [5], context)).toEqual({ values: [5], steps: 1 });
  });
});

/* -------------------------------------------------------------------------
 * Execution equivalence
 * ---------------------------------------------------------------------- */

describe('JIT execution equivalence', () => {
  it('executes functions, entries, multiple results and empty results', () => {
    const { module, echo, pair, nothing, bump, initialize, counter } = contractFixture();
    parity(module, echo, [
      [1, 2, true],
      [-0, Number.NaN, false],
    ]);
    parity(module, pair, [[0], [41], [0xffffffff]]);
    parity(module, nothing, [[]]);
    parity(module, bump, [[1], [2], [0]]);
    parity(module, initialize, [[]]);
    const jit = engine(module);
    jit.execute(initialize, [], context);
    expect(jit.storage.loadState(counter)).toBe(100);
    jit.execute(bump, [0], context);
    jit.execute(bump, [7], context);
    expect(jit.storage.loadState(counter)).toBe(107);
  });

  it('matches the reference over a loop with counting steps', () => {
    const { module, sum } = countedLoopFixture();
    parity(module, sum, [[0], [1], [2], [5], [17]]);
  });

  it('continues through the compiled-depth fallback', () => {
    const module = createIRModule();
    const leaf = module.func('leaf', { params: ['u32'], results: ['u32'] });
    leaf.body((b, [value]) => b.return([b.int.add(value, b.const('u32', 1))]));
    const middle = module.func('middle', { params: ['u32'], results: ['u32'] });
    middle.body((b, [value]) => {
      const [left] = b.call(leaf, [value]);
      const [right] = b.call(leaf, [left]);
      b.return([b.int.add(left, right)]);
    });
    const top = module.func('top', { params: ['u32'], results: ['u32'] });
    top.body((b, [value]) => {
      const [left] = b.call(middle, [value]);
      const [right] = b.call(middle, [left]);
      b.return([b.int.add(left, right)]);
    });
    // The reference ignores `jit`; the JIT restarts a compiled segment once the
    // nesting budget is reached and still produces the same values and steps.
    parity(module, top, [[0], [1], [9]], () => ({ jit: { maxCompiledDepth: 1 } }));
  });

  it('matches the reference for float arguments and results', () => {
    const { module, echo } = contractFixture();
    parity(module, echo, [
      [1.5, -2.25, true],
      [Number.MIN_VALUE, Number.MAX_VALUE, false],
    ]);
    const runtime = engine(module);
    expect(runtime.execute(echo, [0.5, 0.25, true], context).values).toEqual([
      { type: 'f32', bits: '0x3f000000' },
      { type: 'f64', bits: '0x3fd0000000000000' },
      true,
    ]);
  });

  it('passes the execution context and instruction node to executors', () => {
    const module = createIRModule();
    const probe = module.domainInstruction('probe.read', {
      operands: [{ kind: 'value', type: 'u32' }],
      results: ['u32'],
    });
    const run = module.func('run', { params: ['u32'], results: ['u32'] });
    run.body((b, [value]) => {
      const [echoed] = b.invoke(probe, [value]);
      b.return([echoed!]);
    });
    const seen: {
      readonly instruction: unknown;
      readonly operands: readonly RuntimeScalar[];
      readonly context: unknown;
    }[] = [];
    const validation = policy(module);
    const sensitive = {
      ...validation,
      supportedInstructions: [...CORE_INSTRUCTION_NAMES, 'probe.read'],
      authorizedInstructions: [...CORE_INSTRUCTION_NAMES, 'probe.read'],
      validators: [{ op: 'probe.read', validate: () => [] }],
    };
    const runtime = createIRJIT(module, {
      validation: sensitive,
      executors: [
        {
          op: 'probe.read',
          execute: (request) => {
            seen.push({
              instruction: request.instruction,
              operands: request.operands,
              context: request.context,
            });
            return request.operands;
          },
        },
      ],
    });
    expect(runtime.execute(run, [9], context)).toEqual({ values: [9], steps: 2 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.context).toEqual(context);
    expect(seen[0]!.operands).toEqual([9]);
    expect((seen[0]!.instruction as { op: string }).op).toBe('probe.read');
    // The same compiled constant is handed to every execution.
    runtime.execute(run, [10], context);
    expect(seen[1]!.instruction).toBe(seen[0]!.instruction);
  });

  it('drives event and bridge hosts like the reference', () => {
    const module = createIRModule();
    const later = module.entry('later', ['u32']);
    later.body((b, [value]) => {
      b.state.store(module.state('seen', 'u32', 0), value);
      b.return([]);
    });
    const out = module.output('out', { params: ['u32'], capacity: 4 });
    const run = module.func('run', { params: [], results: ['u32'] });
    run.body((b) => {
      const now = b.convert.floatToInt('u32', b.event.now());
      b.event.at(later, b.const('f64', 500), [b.const('u32', 9)]);
      const sent = b.output(out, [b.const('u32', 7)]);
      b.return([b.int.add(now, b.select(sent, b.const('u32', 1), b.const('u32', 0)))]);
    });
    const createHosts = () => {
      const events: unknown[] = [];
      const sends: unknown[] = [];
      return {
        events,
        sends,
        eventHost: {
          now: () => 100,
          at: (target: EntryRef, deadline: number, args: readonly RuntimeScalar[]) => {
            events.push({ target, deadline, args });
            return 1;
          },
          cancel: () => undefined,
        },
        bridge: {
          send: (output: unknown, payload: readonly unknown[], time: number) => {
            sends.push({ output, payload, time });
            return true;
          },
          sendBytes: () => true,
        },
      };
    };
    const jitHosts = createHosts();
    const referenceHosts = createHosts();
    const actual = capture(() =>
      engine(module, { eventHost: jitHosts.eventHost, bridge: jitHosts.bridge }).execute(
        run,
        [],
        context,
      ),
    );
    const expected = capture(() =>
      referenceEngine(module, {
        eventHost: referenceHosts.eventHost,
        bridge: referenceHosts.bridge,
      }).execute(run, [], context),
    );
    expect(actual).toEqual(expected);
    expect(jitHosts.events).toHaveLength(1);
    expect(jitHosts.sends).toEqual(referenceHosts.sends);
  });

  it('keeps invalid-target and invalid-argument non-faulting like the reference', () => {
    const { module, identity } = identityFixture();
    const outsider = createIRModule();
    const foreign = outsider.func('foreign', { params: [], results: [] });
    foreign.body((b) => b.return([]));
    const jit = engine(module);
    const reference = referenceEngine(module);
    const invalidTarget = capture(() => jit.execute(foreign as never, [], context));
    expect(invalidTarget).toEqual(capture(() => reference.execute(foreign as never, [], context)));
    expect(invalidTarget.code).toBe('invalid-target');
    expect(capture(() => jit.execute(identity, [], context)).code).toBe('invalid-argument');
    // Still usable after pre-execution failures.
    expect(jit.execute(identity, [3], context)).toEqual({ values: [3], steps: 1 });
  });

  it('matches the reference when a caller passes a non-array argument list', () => {
    const { module, identity } = identityFixture();
    parity(module, identity, [[], [1, 2]]);
  });
});

/* -------------------------------------------------------------------------
 * Errors and step accounting
 * ---------------------------------------------------------------------- */

describe('JIT errors', () => {
  it('reproduces nested error locations, call stacks and steps', () => {
    const { module, outer, state } = nestedDivisionFixture();
    const jit = engine(module);
    const actual = capture(() => jit.execute(outer, [0], context));
    const reference = capture(() => referenceEngine(module).execute(outer, [0], context));
    expect(actual).toEqual(reference);
    expect(actual).toMatchObject({
      ok: false,
      code: 'evaluation-failed',
      steps: 6,
      causeName: 'IRScalarEvaluationError',
      causeCode: 'division-by-zero',
      callStack: [
        { functionIndex: 2, functionName: 'outer', blockIndex: 0, blockId: 0, instructionIndex: 2 },
        {
          functionIndex: 1,
          functionName: 'middle',
          blockIndex: 0,
          blockId: 0,
          instructionIndex: 0,
        },
        {
          functionIndex: 0,
          functionName: 'divide',
          blockIndex: 0,
          blockId: 0,
          instructionIndex: 1,
        },
      ],
    });
    // Effects committed before the failure survive, exactly like the reference.
    expect(jit.storage.loadState(state)).toBe(1);
  });

  it('reproduces trap location, steps and effects', () => {
    const module = createIRModule();
    const state = module.state('state', 'u32', 0);
    const run = module.func('run', { params: [], results: [] });
    run.body((b) => {
      b.state.store(state, b.const('u32', 9));
      b.trap('invalidState');
    });
    const jit = engine(module);
    const actual = capture(() => jit.execute(run, [], context));
    expect(actual).toEqual(capture(() => referenceEngine(module).execute(run, [], context)));
    expect(actual).toMatchObject({
      ok: false,
      code: 'trap',
      steps: 3,
      location: {
        functionIndex: 0,
        functionName: 'run',
        blockIndex: 0,
        blockId: 0,
        terminator: true,
      },
    });
    expect(jit.storage.loadState(state)).toBe(9);
  });

  it('faults the instance after an execution error', () => {
    const { module, outer } = nestedDivisionFixture();
    const jit = engine(module);
    capture(() => jit.execute(outer, [0], context));
    const faulted = capture(() => jit.execute(outer, [1], context));
    expect(faulted).toMatchObject({
      ok: false,
      code: 'instance-faulted',
      message: 'The interpreter faulted; rebuild the instance',
      steps: 0,
    });
  });

  it('matches maxSteps budget exhaustion', () => {
    const { module, sum } = countedLoopFixture();
    for (const maxSteps of [0, 1, 2, 5, 9]) {
      const actual = capture(() => engine(module, { maxSteps }).execute(sum, [3], context));
      const expected = capture(() =>
        referenceEngine(module, { maxSteps }).execute(sum, [3], context),
      );
      expect({ maxSteps, actual }).toEqual({ maxSteps, actual: expected });
    }
  });

  it('matches the reference when the step observer throws', () => {
    const { module, sum } = countedLoopFixture();
    let failing = false;
    const observer = {
      beforeStep: () => {
        if (failing) throw new Error('observer failed');
      },
    };
    const jit = engine(module, { stepObserver: observer });
    const reference = referenceEngine(module, { stepObserver: observer });
    expect(jit.execute(sum, [2], context)).toEqual(reference.execute(sum, [2], context));
    failing = true;
    expect(capture(() => jit.execute(sum, [2], context))).toEqual(
      capture(() => reference.execute(sum, [2], context)),
    );
  });

  it('invokes beforeStep exactly once per step', () => {
    const { module, sum } = countedLoopFixture();
    const seen: IRExecutionContext[] = [];
    const runtime = engine(module, {
      stepObserver: {
        beforeStep: (execution: IRExecutionContext) => seen.push(execution),
      },
    });
    const result = runtime.execute(sum, [3], context);
    expect(seen).toHaveLength(result.steps);
    // `prepareExecution` freezes one captured context per execution.
    expect(seen.every((execution) => execution === seen[0])).toBe(true);
    expect(seen[0]).toEqual(context);
    expect(Object.isFrozen(seen[0])).toBe(true);
  });

  it('honours stepBudget accounting and results like the reference', () => {
    const { module, sum } = countedLoopFixture();
    const makeBudget = () => {
      let consumed = 0;
      return {
        budget: {
          remaining: () => 1_000,
          consume: (_execution: IRExecutionContext, steps: number) => {
            consumed += steps;
          },
        },
        consumed: () => consumed,
      };
    };
    const jitBudget = makeBudget();
    const referenceBudget = makeBudget();
    const actual = capture(() =>
      engine(module, { stepBudget: jitBudget.budget }).execute(sum, [4], context),
    );
    const expected = capture(() =>
      referenceEngine(module, { stepBudget: referenceBudget.budget }).execute(sum, [4], context),
    );
    expect(actual).toEqual(expected);
    expect(jitBudget.consumed()).toBe(referenceBudget.consumed());
    expect(jitBudget.consumed()).toBe(actual.steps);
  });

  it('matches the reference when the step budget is exhausted', () => {
    const { module, sum } = countedLoopFixture();
    const makeBudget = (limit: number) => {
      let consumed = 0;
      return {
        remaining: () => Math.max(0, limit - consumed),
        consume: (_execution: IRExecutionContext, steps: number) => {
          consumed += steps;
          if (consumed > limit) throw new Error('host budget exhausted');
        },
      };
    };
    for (const limit of [0, 1, 3, 8]) {
      const actual = capture(() =>
        engine(module, { stepBudget: makeBudget(limit) }).execute(sum, [4], context),
      );
      const expected = capture(() =>
        referenceEngine(module, { stepBudget: makeBudget(limit) }).execute(sum, [4], context),
      );
      expect({ limit, actual }).toEqual({ limit, actual: expected });
    }
  });

  it('never consults remaining(), so a throwing remaining() cannot fail an execution', () => {
    const { module, sum } = countedLoopFixture();
    const makeBudget = () => {
      const remaining = vi.fn(() => {
        throw new Error('remaining failed');
      });
      return { remaining, consume: () => undefined };
    };
    const budget = makeBudget();
    const actual = engine(module, { stepBudget: budget }).execute(sum, [2], context);
    // The reference protocol only ever calls `consume`, so both engines agree
    // and an unusable `remaining` is never reached.
    const expected = referenceEngine(module, { stepBudget: makeBudget() }).execute(
      sum,
      [2],
      context,
    );
    expect(actual).toEqual(expected);
    expect(budget.remaining).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------
 * Provider dispatch and lazy artifact compilation
 * ---------------------------------------------------------------------- */

describe('JIT provider artifacts', () => {
  it('compiles an artifact on first dispatch and reuses it afterwards', () => {
    const { module, run } = readingProviderFixture();
    const runtime = engine(module);
    expect(internals(runtime).compiledArtifacts).toBe(0);
    expect(internals(runtime).compiledFunctions).toBe(0);
    const first = runtime.execute(run, [10, 0], context);
    expect(internals(runtime).compiledFunctions).toBe(1);
    expect(first).toEqual(referenceEngine(module).execute(run, [10, 0], context));
    expect(internals(runtime).compiledArtifacts).toBe(1);
    const second = runtime.execute(run, [20, 0], context);
    expect(second.values).toEqual([21]);
    expect(internals(runtime).compiledArtifacts).toBe(1);
  });

  it('verifies lowered model and artifact MIR in debug mode', () => {
    const fixture = recoveryFixture();
    const permission = { ref: fixture.firmware, access: 'update' as const };
    const runtime = createIRJIT(fixture.module, {
      validation: policy(fixture.module, [permission]),
      jit: { debug: { verify: true } },
    });
    const reference = createIRInterpreter(fixture.module, {
      validation: policy(fixture.module, [permission]),
    });
    expect(capture(() => runtime.execute(fixture.run, [], context))).toEqual(
      capture(() => reference.execute(fixture.run, [], context)),
    );
    expect(runtime.storage.loadState(fixture.result)).toBe(2003);
  });

  it('does not compile artifacts during creation', () => {
    const { module } = readingProviderFixture();
    const runtime = engine(module, { jit: { warmup: 'eager' } });
    expect(internals(runtime).compiledArtifacts).toBe(0);
    expect(internals(runtime).compiledFunctions).toBe(module.functions.length);
  });

  it('matches the reference through a provider chain', () => {
    const { module, run } = chainedProviderFixture();
    parity(module, run, [[0], [1], [7], [1234]]);
    const runtime = engine(module);
    expect(runtime.execute(run, [3], context)).toEqual(
      referenceEngine(module).execute(run, [3], context),
    );
    expect(internals(runtime).compiledArtifacts).toBe(2);
  });

  it('regenerates and recompiles when a dependency unit changes', () => {
    const { module, firmware, run } = readingProviderFixture();
    const runtime = engine(module, {}, [{ ref: firmware, access: 'update' }]);
    expect(runtime.execute(run, [10, 0], context).values).toEqual([11]);
    expect(internals(runtime).compiledArtifacts).toBe(1);

    runtime.storage.updateBytesFromBytes(firmware, 0, new Uint8Array([9]));
    expect(runtime.execute(run, [10, 0], context).values).toEqual([19]);
    expect(internals(runtime).compiledArtifacts).toBe(2);

    // The regenerated artifact is cached again by identity.
    expect(runtime.execute(run, [10, 0], context).values).toEqual([19]);
    expect(internals(runtime).compiledArtifacts).toBe(2);
  });

  it('recompiles a cached parent artifact when a nested provider becomes stale', () => {
    const { module, firmware, run } = chainedProviderFixture();
    const runtime = engine(module, {}, [{ ref: firmware, access: 'update' }]);
    expect(runtime.execute(run, [3], context).values).toEqual([7]);
    expect(internals(runtime).compiledArtifacts).toBe(2);
    expect(internals(runtime).recompiledArtifacts).toBe(0);

    runtime.storage.updateBytesFromBytes(firmware, 0, new Uint8Array([10]));
    expect(runtime.execute(run, [3], context).values).toEqual([16]);
    // The parent's own reads did not change, but its provider chain did.
    expect(internals(runtime).recompiledArtifacts).toBeGreaterThanOrEqual(1);
    expect(internals(runtime).compiledArtifacts).toBeGreaterThan(2);
  });

  it('recovers an invalidated checkpoint by re-materializing the artifact', () => {
    const fixture = recoveryFixture();
    const permission = { ref: fixture.firmware, access: 'update' as const };
    const jit = createIRJIT(fixture.module, {
      validation: policy(fixture.module, [permission]),
    });
    jit.execute(fixture.run, [], context);
    expect(jit.storage.loadState(fixture.patches)).toBe(1);
    expect(jit.storage.loadState(fixture.pc)).toBe(2);
    expect(jit.storage.loadState(fixture.result)).toBe(2003);
    expect(fixture.calls.generated).toBe(2);
    expect(internals(jit).compiledArtifacts).toBeGreaterThanOrEqual(2);
  });

  it('matches the reference result of a checkpoint recovery', () => {
    const jitFixture = recoveryFixture();
    const referenceFixture = recoveryFixture();
    const permissionOf = (fixture: RecoveryFixture) => ({
      ref: fixture.firmware,
      access: 'update' as const,
    });
    const jit = createIRJIT(jitFixture.module, {
      validation: policy(jitFixture.module, [permissionOf(jitFixture)]),
    });
    const reference = createIRInterpreter(referenceFixture.module, {
      validation: policy(referenceFixture.module, [permissionOf(referenceFixture)]),
    });
    const actual = capture(() => jit.execute(jitFixture.run, [], context));
    const expected = capture(() => reference.execute(referenceFixture.run, [], context));
    expect(actual).toEqual(expected);
    expect(jit.storage.loadState(jitFixture.result)).toBe(
      reference.storage.loadState(referenceFixture.result),
    );
    expect(jit.storage.loadState(jitFixture.patches)).toBe(1);
  });
});

/* -------------------------------------------------------------------------
 * Warmup
 * ---------------------------------------------------------------------- */

describe('JIT warmup', () => {
  it('lazy warmup compiles only functions that run', () => {
    const module = createIRModule();
    const unused = module.func('unused', { params: [], results: [] });
    unused.body((b) => b.return([]));
    const called = module.func('called', { params: ['u32'], results: ['u32'] });
    called.body((b, [value]) => b.return([b.int.add(value, b.const('u32', 1))]));
    const run = module.func('run', { params: ['u32'], results: ['u32'] });
    run.body((b, [value]) => b.return(b.call(called, [value])));

    const runtime = engine(module);
    expect(internals(runtime).compiledFunctions).toBe(0);
    expect(runtime.execute(run, [2], context)).toEqual(
      referenceEngine(module).execute(run, [2], context),
    );
    expect(internals(runtime).compiledFunctions).toBe(2);
  });

  it('eager warmup compiles every model function at creation', () => {
    const { module } = identityFixture();
    const runtime = engine(module, { jit: { warmup: 'eager' } });
    expect(internals(runtime).compiledFunctions).toBe(module.functions.length);
  });

  it('falls back to the reference engine when a lazy compilation fails', () => {
    const { module, identity } = identityFixture();
    const runtime = engine(module);
    expect(internals(runtime).mode).toBe('jit');
    vi.stubGlobal('Function', function blocked(): never {
      throw new Error('CSP after creation');
    });
    try {
      expect(runtime.execute(identity, [13], context)).toEqual({ values: [13], steps: 1 });
      expect(internals(runtime).mode).toBe('reference');
      // The fallback keeps serving subsequent executions.
      expect(runtime.execute(identity, [14], context)).toEqual({ values: [14], steps: 1 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back when eager warmup cannot compile', () => {
    const { module } = identityFixture();
    vi.stubGlobal('Function', function blocked(): never {
      throw new Error('CSP during warmup');
    });
    try {
      const runtime = engine(module, { jit: { warmup: 'eager' } });
      expect(maybeInternals(runtime)).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/* -------------------------------------------------------------------------
 * Re-entrancy
 * ---------------------------------------------------------------------- */

describe('JIT re-entrancy', () => {
  function reentrantFixture() {
    const module = createIRModule();
    const inner = module.func('inner', { params: ['u32'], results: ['u32'] });
    inner.body((b, [value]) => b.return([b.int.add(value, b.const('u32', 1))]));
    const failing = module.func('failing', { params: [], results: [] });
    failing.body((b) => b.trap('innerFailure'));
    const target = module.domainInstruction('reenter.run', {
      operands: [],
      results: ['u32'],
    });
    const run = module.func('run', { params: [], results: ['u32'] });
    run.body((b) => {
      const [value] = b.invoke(target, []);
      b.return([value!]);
    });
    const validation = policy(module);
    const sensitive = {
      ...validation,
      supportedInstructions: [...CORE_INSTRUCTION_NAMES, 'reenter.run'],
      authorizedInstructions: [...CORE_INSTRUCTION_NAMES, 'reenter.run'],
      validators: [{ op: 'reenter.run', validate: () => [] }],
    };
    return { module, inner, failing, run, validation: sensitive };
  }

  it('keeps inner step counts out of the outer execution', () => {
    const fixture = reentrantFixture();
    const holder: { runtime?: IRInterpreter } = {};
    let innerSteps = 0;
    const runtime = createIRJIT(fixture.module, {
      validation: fixture.validation,
      executors: [
        {
          op: 'reenter.run',
          execute: () => {
            const result = holder.runtime!.execute(fixture.inner, [41], context);
            innerSteps = result.steps;
            return [result.values[0]!];
          },
        },
      ],
    });
    holder.runtime = runtime;
    const outer = runtime.execute(fixture.run, [], context);
    expect(innerSteps).toBe(3);
    expect(outer.steps).toBe(2);
    expect(outer.values).toEqual([42]);
  });

  it('lets an outer execution finish after a swallowed inner failure', () => {
    const fixture = reentrantFixture();
    let runtime: IRInterpreter | undefined;
    const make = (factory: typeof createIRJIT | typeof createIRInterpreter) =>
      factory(fixture.module, {
        validation: fixture.validation,
        executors: [
          {
            op: 'reenter.run',
            execute: () => {
              try {
                runtime!.execute(fixture.failing, [], context);
              } catch {
                // The host swallows the inner failure.
              }
              return [7];
            },
          },
        ],
      } as never) as IRInterpreter;

    runtime = make(createIRJIT);
    expect(runtime.execute(fixture.run, [], context)).toEqual({
      values: [7],
      steps: 2,
    });
    // The inner failure still faults the instance.
    expect(capture(() => runtime!.execute(fixture.run, [], context))).toMatchObject({
      code: 'instance-faulted',
      steps: 0,
    });

    runtime = make(createIRInterpreter);
    expect(runtime.execute(fixture.run, [], context)).toEqual({
      values: [7],
      steps: 2,
    });
    expect(capture(() => runtime!.execute(fixture.run, [], context))).toMatchObject({
      code: 'instance-faulted',
      steps: 0,
    });
  });
});
