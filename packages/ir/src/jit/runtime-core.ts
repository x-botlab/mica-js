/**
 * JIT runtime core (J6).
 *
 * Generated code never references user strings or user objects directly: it
 * receives this runtime (`rt`), the per-function constant table (`k`) and the
 * module helpers (`H`). This module owns the step accounting state machine,
 * the tail-call sentinel and the translated error frames. The execution entry
 * point that drives `TAIL` chains lives in J7.
 */
import { invokeEvent, invokeExecutor, invokeOutput, sameResultTypes } from '../engine-host';
import type { EngineSetup } from '../engine-setup';
import { IRProviderError } from '../errors';
import { evaluateFloatInstruction } from '../float';
import { IRExecutionError } from '../interpreter';
import type {
  IRExecutionContext,
  IRExecutionLocation,
  IRStepBudget,
  IRStepObserver,
} from '../interpreter';
import type { ProviderArtifact, ProviderRuntime } from '../provider';
import { isFloatType } from '../runtime';
import { evaluateScalarInstruction } from '../scalar';
import { storageInternals } from '../storage';
import type {
  IRResourceDependency,
  ScalarRecordInternals,
  StorageControl,
  StorageInternals,
} from '../storage';
import type { FloatBits, FloatType, InstructionNode, RuntimeScalar, ScalarType } from '../types';
import type { ArtifactState } from './dispatch-ic';
import { DispatchRegistry, REGION_THRESHOLD } from './dispatch-ic';
import {
  convertFloat,
  floatCompare,
  fma32,
  fma64,
  fromBoundary,
  fromRaw32,
  fromRaw64,
  intToFloat,
  raw32,
  raw64,
  toBoundary,
  toNum,
} from './float-runtime';
import type { FloatValue } from './float-runtime';

/** A compiled MIR function. Arguments and results use MIR representations. */
export type CompiledFn = (...args: unknown[]) => unknown;

/**
 * The single frozen tail-transfer sentinel. A function that transfers control
 * to a provider artifact sets `rt.tailFn` / `rt.tailArgs` and returns `TAIL`;
 * the driver keeps calling `rt.runTail()` until it gets a real result, so a
 * dispatch chain never grows the JavaScript stack.
 */
export const TAIL: object = Object.freeze({});

/**
 * Internal unwinding record. It is deliberately not an `Error`: generated
 * code rethrows it through every frame, collecting call sites, and the
 * execution entry point turns it into an `IRExecutionError`.
 */
export class JitUnwind {
  readonly frames: IRExecutionLocation[] = [];

  constructor(
    readonly cause: unknown,
    readonly steps: number,
  ) {}
}

/** Per-compiled-function location table used for error reporting and unwind. */
export interface JitFrame {
  /** One entry per location id; exact-copy locations share the source object. */
  readonly locations: readonly IRExecutionLocation[];
  /** Steps remaining in the current segment after each location id. */
  readonly stepsAfter: Int32Array;
  /** Inlining frame chain per location; `-1` terminates the chain (J13). */
  readonly parent?: Int32Array;
  /** Virtual frames for locations copied by the inliner (J13). */
  readonly inlineFrames?: readonly unknown[];
}

export type BudgetMode = 'none' | 'observer' | 'budget';

export interface JitRuntimeOptions {
  readonly context: IRExecutionContext;
  readonly maxSteps: number;
  readonly stepObserver?: IRStepObserver;
  readonly stepBudget?: IRStepBudget;
}

/**
 * Step accounting shared by every function compiled for one execution.
 *
 * `steps` mirrors the reference interpreter's counter. The fast path advances
 * it by a whole segment at once; `limit` is the smallest step count that must
 * take the exact (per-item) path, either because `maxSteps` would be exceeded
 * or because the host budget must be consulted again.
 */
export class JitRuntime {
  steps = 0;
  committed = 0;
  limit: number;
  context: IRExecutionContext;
  /** Alias read by generated host calls (`rt.ctx`). */
  get ctx(): IRExecutionContext {
    return this.context;
  }
  readonly maxSteps: number;
  readonly mode: BudgetMode;
  /** Multi-result return slots, preallocated once per execution. */
  readonly ret: unknown[] = [];
  /** The tail sentinel, exposed to generated code as `rt.TAIL`. */
  readonly TAIL: object = TAIL;
  /** Pending tail transfer, consumed by {@link runTail}. */
  tailFn: CompiledFn | undefined = undefined;
  tailArgs: unknown[] | undefined = undefined;
  /** Artifact state of a pending tail transfer (J14 dispatch IC / regions). */
  tailState: ArtifactState | undefined = undefined;
  /** Artifact whose body is currently running; used for transition statistics. */
  currentState: ArtifactState | undefined = undefined;
  /**
   * Called when an artifact reaches {@link REGION_THRESHOLD} entries; the
   * execution engine (J7) uses it to build a region. Keeping it on the runtime
   * avoids a per-dispatch callback: the branch is a single integer compare.
   */
  regionTrigger: ((state: ArtifactState) => void) | undefined = undefined;
  /** Current compiled-function nesting depth; J7 owns the deep-recursion fallback. */
  depth = 0;
  maxDepth = 1_000_000;
  /** Per-function entry counters used by Tier-2 recompilation (J13). */
  counters: number[] = [];
  /** Entry count that promotes a function to Tier 2; infinity disables it. */
  tierUpThreshold = Number.POSITIVE_INFINITY;
  /** Tier-2 promotion callback installed by the execution engine (J13). */
  tierUp: (index: number) => void = () => undefined;

  /** Count one function entry and promote at the threshold (J13). */
  noteEntry(index: number): void {
    if (!Number.isFinite(this.tierUpThreshold)) return;
    const count = this.counters[index] ?? 0;
    if (count < 0) return;
    const next = count + 1;
    this.counters[index] = next;
    if (next >= this.tierUpThreshold) this.tierUp(index);
  }

  readonly #observer: IRStepObserver | undefined;
  readonly #budget: IRStepBudget | undefined;

  constructor(options: JitRuntimeOptions) {
    this.context = options.context;
    this.maxSteps = options.maxSteps;
    this.#observer = options.stepObserver;
    this.#budget = options.stepBudget;
    if (options.stepObserver !== undefined) {
      this.mode = 'observer';
      this.limit = -1;
    } else if (options.stepBudget !== undefined) {
      this.mode = 'budget';
      // The reference consumes exactly one step per instruction and never polls
      // `remaining`, so budgeted runs always take the exact (per-step) path.
      this.limit = -1;
    } else {
      this.mode = 'none';
      this.limit = this.maxSteps;
    }
  }

  /** Start a fresh execution on a reused runtime (compiled code captures `rt`). */
  begin(context: IRExecutionContext): void {
    this.context = context;
    this.steps = 0;
    this.committed = 0;
    this.ret.length = 0;
    this.tailFn = undefined;
    this.tailArgs = undefined;
    this.tailState = undefined;
    this.currentState = undefined;
    this.depth = 0;
    // Budgeted executions keep `limit` at -1 so every step takes the exact path,
    // matching the reference's one-`consume`-per-step protocol.
    this.limit = this.mode === 'none' ? this.maxSteps : -1;
  }

  /**
   * Exact-path check: called before a step when `steps >= limit`.
   *
   * Order matters (C3/R4): the hard `maxSteps` limit is checked before the host
   * is consulted, so a step that would exceed the budget is never consumed.
   */
  limitReached(location: IRExecutionLocation | undefined): void {
    if (this.steps >= this.maxSteps) {
      // The location is kept for diagnostics/debug builds; the reference error
      // itself carries no details (the caller's unwind adds them).
      void location;
      // The reference raises this without details; the caller's `wrapExecutionError`
      // fills in the location, call stack and step count.
      throw new IRExecutionError(
        'budget-exhausted',
        `Execution exceeded ${this.maxSteps} reference IR steps`,
      );
    }
    if (this.mode === 'observer') {
      this.#observer!.beforeStep(this.context);
      return;
    }
    if (this.mode === 'budget') {
      // One host call per step, in execution order. A throwing call must not
      // advance the counter, so `committed` only moves after it returns.
      this.#budget!.consume(this.context, 1);
      this.committed = this.steps + 1;
    }
  }

  /** Budget steps are committed one at a time; nothing is ever pending. */
  flush(): void {
    if (this.mode !== 'budget') return;
  }

  /** Host calls see a fully committed counter. */
  beforeHost(): void {
    if (this.mode !== 'budget' || this.steps <= this.committed) return;
    this.#budget!.consume(this.context, this.steps - this.committed);
    this.committed = this.steps;
  }

  /** After host code the counter is fully committed; `remaining` is never polled. */
  afterHost(): void {
    if (this.mode !== 'budget') return;
    this.committed = this.steps;
  }

  /** Append one frame's location chain (inlined locations have parents). */
  #pushFrames(frames: IRExecutionLocation[], loc: number, frame: JitFrame): void {
    const parents = frame.parent;
    const seen = new Set<number>();
    let current = loc;
    while (current >= 0 && !seen.has(current)) {
      seen.add(current);
      const location = frame.locations[current];
      if (location !== undefined) frames.push(location);
      current = parents?.[current] ?? -1;
    }
  }

  /** Translate any thrown value into a {@link JitUnwind}, appending this frame. */
  unwind(cause: unknown, loc: number, frame: JitFrame): JitUnwind {
    if (cause instanceof JitUnwind) {
      this.#pushFrames(cause.frames, loc, frame);
      return cause;
    }
    const after = loc >= 0 ? (frame.stepsAfter[loc] ?? 0) : 0;
    const unwind = new JitUnwind(cause, this.steps - after);
    this.#pushFrames(unwind.frames, loc, frame);
    return unwind;
  }

  /** Invoke the function installed by a `dispatch` or invalidated `checkpoint`. */
  runTail(): unknown {
    const fn = this.tailFn;
    const args = this.tailArgs;
    const state = this.tailState;
    if (fn === undefined || args === undefined) {
      throw new Error('JIT tail transfer has no target');
    }
    this.tailFn = undefined;
    this.tailArgs = undefined;
    this.tailState = undefined;
    if (state !== undefined) {
      this.currentState = state;
      const region = state.region;
      if (region !== undefined) {
        // A compiled region absorbs the whole call: one JS frame, one depth
        // increment, and member transitions stay in the region's own loop.
        return region.fn(state.regionIndex, ...args);
      }
      state.entries += 1;
      if (state.entries === REGION_THRESHOLD) this.regionTrigger?.(state);
    }
    return fn(...args);
  }

  /** Deep-recursion fallback; implemented by the execution engine (J7). */
  deep(functionIndex: number, ...args: unknown[]): unknown {
    throw new Error(
      `JIT deep recursion fallback for function ${functionIndex} is unavailable (arguments: ${
        args.length
      })`,
    );
  }
}

/** A memory record pre-fetched for generated code. */
export interface JitResource {
  readonly kind: 'state' | 'array' | 'bytes' | 'inbox';
  readonly type: ScalarType | undefined;
  readonly length: number;
  /** `undefined` on big-endian hosts; generated code then uses {@link data}. */
  readonly view:
    | Uint8Array
    | Int8Array
    | Uint16Array
    | Int16Array
    | Uint32Array
    | Int32Array
    | Float32Array
    | Float64Array
    | undefined;
  /** f32: one word per element; f64: two words (low first). */
  readonly raw: Uint32Array | undefined;
  readonly bytes: Uint8Array;
  readonly data: DataView;
  readonly tracked: () => boolean;
  /** Whole-resource unit advance after a fast-path write (bytes views never write). */
  readonly advance: () => void;
}

/** One resolved tail-transfer target. */
export interface JitTailTarget {
  readonly fn: CompiledFn;
  readonly args: unknown[];
  /** Artifact state; generated dispatch code stores it in `rt.tailState`. */
  readonly state: ArtifactState;
}

/**
 * Everything generated code reads besides its locals and the runtime.
 *
 * This is the J6 surface; J7 grows it with lazy compilation of provider
 * artifacts and the deep-recursion fallback.
 */
export interface JitHelpers {
  readonly storage: EngineSetup['storage'];
  readonly ctl: StorageControl;
  /** Provider runtime, exposing `cacheEpoch` (I2). */
  readonly prov: ProviderRuntime;
  /** Dispatch site and jump-cache registry (J14). */
  readonly ic: DispatchRegistry;
  readonly le: boolean;
  readonly res: readonly JitResource[];
  /** Compiled model functions by model index; filled by the compiler driver. */
  readonly fns: (CompiledFn | undefined)[];
  /** Scratch words for raw f64 stores; never re-entered. */
  readonly scratch: Uint32Array;
  readonly scalar: (
    node: InstructionNode,
    operands: readonly (boolean | number)[],
  ) => boolean | number;
  readonly floatToInt: (node: InstructionNode, value: number) => number;
  readonly toNum: (value: FloatValue) => number;
  readonly toBoundary: (type: FloatType, value: FloatValue) => FloatBits;
  readonly fromBoundary: (type: FloatType, value: FloatBits) => FloatValue;
  readonly fromRaw32: (raw: number) => FloatValue;
  readonly fromRaw64: (hi: number, lo: number) => FloatValue;
  readonly raw32: (value: FloatValue) => number;
  readonly raw64: (value: FloatValue, out: Uint32Array) => void;
  readonly fma32: (a: number, b: number, c: number) => number;
  readonly fma64: (a: number, b: number, c: number) => number;
  readonly convertFloat: (type: FloatType, value: number) => number;
  readonly intToFloat: (type: FloatType, value: number) => number;
  readonly compareFloat: (
    predicate: 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge',
    a: number,
    b: number,
  ) => boolean;
  readonly executor: (
    index: number,
    node: InstructionNode,
    operands: readonly RuntimeScalar[],
    context: IRExecutionContext,
  ) => readonly RuntimeScalar[];
  readonly event: (
    node: InstructionNode,
    operands: readonly RuntimeScalar[],
  ) => readonly RuntimeScalar[];
  readonly output: (
    node: InstructionNode,
    operands: readonly RuntimeScalar[],
    context: IRExecutionContext,
  ) => readonly RuntimeScalar[];
  readonly trap: (code: string) => never;
  readonly advance: (record: ScalarRecordInternals) => void;
  readonly validate: (dependencies: readonly IRResourceDependency[]) => boolean;
  readonly checkpointOutside: () => never;
  readonly materialize: (
    providerIndex: number,
    key: readonly unknown[],
    args: readonly unknown[],
  ) => JitTailTarget;
  readonly recover: (
    providerIndex: number,
    key: readonly unknown[],
    args: readonly unknown[],
    currentName: string,
    currentResults: readonly ScalarType[],
  ) => JitTailTarget;
  /** Convert one host boundary value into the MIR representation of `type`. */
  readonly argument: (type: ScalarType, value: RuntimeScalar) => unknown;
  /** Convert one MIR value back to the host boundary representation. */
  readonly result: (type: ScalarType, value: unknown) => RuntimeScalar;
}

export interface JitHelpersOptions {
  /** Compiles (or looks up) the artifact state; J7 supplies the real one. */
  readonly artifact?: (artifact: ProviderArtifact, providerIndex: number) => ArtifactState;
  /** Shared dispatch registry; one per engine. */
  readonly dispatch?: DispatchRegistry;
}

/** Convert one boundary value into the representation generated code expects. */
export function toJitArgument(type: ScalarType, value: RuntimeScalar): unknown {
  if (isFloatType(type)) {
    const type_ = type as FloatType;
    return fromBoundary(type_, toCapturedFloat(type_, value));
  }
  return value;
}

/** Convert one generated-code value back into an SSA boundary value. */
export function fromJitResult(type: ScalarType, value: unknown): RuntimeScalar {
  if (isFloatType(type)) {
    return toBoundary(type as FloatType, value as FloatValue) as RuntimeScalar;
  }
  return value as RuntimeScalar;
}

function toCapturedFloat(type: FloatType, value: RuntimeScalar): FloatBits {
  if (typeof value === 'object') return value;
  // `toBoundary` matches the reference `fromNumber` for every JS number.
  return toBoundary(type, value as FloatValue) as FloatBits;
}

/** Access the J3 storage fast path without widening the public interface. */
export function storageInternalsOf(storage: EngineSetup['storage']): StorageInternals {
  return (storage as unknown as { readonly [storageInternals]: StorageInternals })[
    storageInternals
  ];
}

/**
 * Build the helper object shared by every function compiled from one module.
 *
 * Resource records come from the storage fast path (J3); the generated code
 * reads typed arrays (or the record's DataView on big-endian hosts) directly.
 */
export function createJitHelpers(setup: EngineSetup, options: JitHelpersOptions = {}): JitHelpers {
  const internals = storageInternalsOf(setup.storage);
  const resources: JitResource[] = [];
  for (const memory of setup.model.memories) {
    if (memory.layout.kind === 'scalar') {
      const kind = memory.kind === 'state' ? 'state' : 'array';
      const record = internals.scalar(memory.ref, kind, memory.name);
      resources.push({
        kind,
        type: record.scalarType,
        length: record.length,
        view: record.view,
        raw: record.raw,
        bytes: record.bytes,
        data: new DataView(record.bytes.buffer, record.bytes.byteOffset, record.bytes.byteLength),
        tracked: record.tracked,
        advance: record.advance,
      });
    } else {
      // Prefetch never writes, so no writability check is required here.
      const record = internals.bytes(memory.ref, false, memory.name);
      resources.push({
        kind: memory.kind === 'inbox' ? 'inbox' : 'bytes',
        type: undefined,
        length: record.length,
        view: undefined,
        raw: undefined,
        bytes: record.bytes,
        data: record.data,
        tracked: () => false,
        advance: () => undefined,
      });
    }
  }
  const executors = [...(setup.executors?.values() ?? [])];
  const artifacts = options.artifact;
  const dispatch = options.dispatch ?? new DispatchRegistry();
  return {
    storage: setup.storage,
    ctl: internals.control,
    prov: setup.providers,
    ic: dispatch,
    le: internals.littleEndianHost,
    res: Object.freeze(resources),
    fns: [],
    scratch: new Uint32Array(2),
    scalar: (node, operands) => evaluateScalarInstruction(node, operands),
    floatToInt: (node, value) => {
      const result = evaluateFloatInstruction(node, [value]);
      return result as number;
    },
    toNum,
    toBoundary,
    fromBoundary,
    fromRaw32,
    fromRaw64,
    raw32,
    raw64,
    fma32,
    fma64,
    convertFloat,
    intToFloat,
    compareFloat: (predicate, a, b) => floatCompare(predicate, a, b),
    executor: (index, node, operands, context) => {
      const executor = executors[index];
      if (executor === undefined) {
        throw new IRExecutionError('unsupported-instruction', `No executor for ${node.op}`);
      }
      return invokeExecutor(executor, node, operands, context);
    },
    event: (node, operands) => invokeEvent(setup, node, operands),
    output: (node, operands, context) => invokeOutput(setup, node, operands, context),
    trap: (code) => {
      throw new IRExecutionError('trap', `IR trap: ${code}`);
    },
    advance: (record) => internals.advanceScalar(record),
    validate: (dependencies) => setup.storage.validateDependencies(dependencies),
    checkpointOutside: () => {
      throw new IRProviderError(
        'recovery-failed',
        'checkpoint executed outside a provider artifact',
      );
    },
    materialize: (providerIndex, key, args) => {
      const provider = setup.model.providers[providerIndex];
      if (provider === undefined) throw new Error('JIT dispatch target is not declared');
      const artifact = setup.providers.materialize(provider.ref, [...(key as RuntimeScalar[])]);
      return tailTarget(artifact, args, artifacts, providerIndex);
    },
    recover: (providerIndex, key, args, name, currentResults) => {
      const provider = setup.model.providers[providerIndex];
      if (provider === undefined) throw new Error('JIT checkpoint target is not declared');
      // Mirror `recoverCheckpoint`: materialize, require fresh dependencies and
      // the same result layout as the artifact being replaced.
      const artifact = setup.providers.materialize(provider.ref, [...(key as RuntimeScalar[])]);
      if (!setup.storage.validateDependencies(artifact.dependencies)) {
        throw new IRProviderError(
          'recovery-failed',
          `Recovery target for checkpoint in "${name}" still has stale dependencies`,
        );
      }
      if (!sameResultTypes(artifact.fn.results, currentResults)) {
        throw new IRProviderError(
          'recovery-failed',
          `Recovery target for checkpoint in "${name}" has a different result layout`,
        );
      }
      return tailTarget(artifact, args, artifacts, providerIndex);
    },
    argument: (type, value) => toJitArgument(type, value),
    result: (type, value) => fromJitResult(type, value),
  };
}

function tailTarget(
  artifact: ProviderArtifact,
  args: readonly unknown[],
  compile: ((artifact: ProviderArtifact, providerIndex: number) => ArtifactState) | undefined,
  providerIndex: number,
): JitTailTarget {
  const state = compile?.(artifact, providerIndex);
  if (state === undefined) {
    throw new Error(
      'JIT provider artifacts require the execution engine (J7) to compile the artifact function',
    );
  }
  return {
    fn: state.compiled.fn,
    state,
    args: artifact.fn.params.map((type, index) =>
      toJitArgument(type, args[index] as RuntimeScalar),
    ),
  };
}
