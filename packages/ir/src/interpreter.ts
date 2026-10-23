import { CORE_INSTRUCTION_NAMES } from './builder';
import { IRProviderError } from './errors';
import { evaluateFloatInstruction } from './float';
import { toNumber } from './float-ieee';
import { createProviderRuntime } from './provider';
import type { ProviderArtifact, ProviderRuntime } from './provider';
import { assertSynchronousCallback, isFloatType } from './runtime';
import { getProviderMetadata } from './runtime';
import { evaluateScalarInstruction } from './scalar';
import { createIRStorage, IRStorageError } from './storage';
import type { IRStorage } from './storage';
import type {
  ArrayRef,
  BlockDefinition,
  BytesOutputRef,
  BytesRef,
  Endian,
  EntryRef,
  FunctionDefinition,
  FunctionRef,
  InstructionNode,
  IRModule,
  LifecycleRef,
  MemoryDefinition,
  NumericType,
  OutputDefinition,
  OutputRef,
  ProviderDefinition,
  ReadableBytesRef,
  RuntimeScalar,
  ScalarType,
  StateRef,
  StaticRef,
  Value,
  WritableBytesRef,
} from './types';
import { refKind } from './types';
import { validateIR } from './validate';
import type { IRDiagnostic, IRValidationOptions } from './validation-types';

type Target = FunctionRef | EntryRef | LifecycleRef;

export interface IREventHost {
  now(): number;
  at(target: EntryRef, deadline: number, args: readonly RuntimeScalar[]): number;
  cancel(id: number): void;
}

export interface IRStepObserver {
  beforeStep(context: IRExecutionContext): void;
}

/**
 * Host-side sink for the explicit `bridge.send` / `bridge.send_bytes` instructions.
 * Calls happen at the instruction, after the payload and virtual time are captured;
 * the host owns bounded queues and returns `false` when they are full.
 */
export interface IRBridgeHost {
  send(output: OutputRef, payload: readonly (boolean | number)[], timePs: number): boolean;
  sendBytes(output: BytesOutputRef, bytes: Uint8Array, timePs: number): boolean;
}

/** One validated domain instruction presented to its trusted executor. */
export interface IRInstructionExecution {
  readonly instruction: InstructionNode;
  /** Resolved SSA operands in node operand order; list operands are flattened. */
  readonly operands: readonly RuntimeScalar[];
  readonly context: IRExecutionContext;
}

/**
 * Trusted synchronous executor for one declared domain instruction. Returning values must match
 * the instruction's declared result types; `void` instructions return an empty array.
 */
export interface IRInstructionExecutor {
  readonly op: string;
  execute(request: IRInstructionExecution): readonly RuntimeScalar[];
}

export interface IRInterpreterOptions {
  readonly validation: IRValidationOptions;
  readonly maxSteps?: number;
  readonly eventHost?: IREventHost;
  readonly stepObserver?: IRStepObserver;
  readonly bridge?: IRBridgeHost;
  readonly executors?: readonly IRInstructionExecutor[];
}

export interface IRExecutionContext {
  readonly instanceId: string;
  readonly virtualTime: number;
}

export interface IRExecutionResult {
  readonly values: readonly RuntimeScalar[];
  readonly steps: number;
}

export interface IRInterpreter {
  readonly storage: IRStorage;
  execute(
    target: Target,
    args: readonly RuntimeScalar[],
    context: IRExecutionContext,
  ): IRExecutionResult;
}

export type IRExecutionErrorCode =
  | 'invalid-options'
  | 'validation-failed'
  | 'invalid-target'
  | 'invalid-argument'
  | 'budget-exhausted'
  | 'trap'
  | 'evaluation-failed'
  | 'storage-failed'
  | 'unsupported-instruction'
  | 'instance-faulted'
  | 'provider-failed';

export interface IRExecutionLocation {
  readonly functionIndex: number;
  readonly functionName: string;
  readonly blockIndex: number;
  readonly blockId: number;
  readonly instructionIndex?: number;
  readonly terminator?: true;
}

export interface IRExecutionErrorDetails {
  readonly context?: IRExecutionContext;
  readonly location?: IRExecutionLocation;
  readonly callStack?: readonly IRExecutionLocation[];
  readonly steps?: number;
  readonly diagnostics?: readonly IRDiagnostic[];
  readonly cause?: unknown;
}

export class IRExecutionError extends Error {
  override readonly name = 'IRExecutionError';
  readonly context: IRExecutionContext | undefined;
  readonly location: IRExecutionLocation | undefined;
  readonly callStack: readonly IRExecutionLocation[];
  readonly steps: number;
  readonly diagnostics: readonly IRDiagnostic[];
  override readonly cause: unknown;

  constructor(
    readonly code: IRExecutionErrorCode,
    message: string,
    details: IRExecutionErrorDetails = {},
  ) {
    super(message, { cause: details.cause });
    this.context = details.context;
    this.location = details.location;
    this.callStack = details.callStack ?? [];
    this.steps = details.steps ?? 0;
    this.diagnostics = details.diagnostics ?? [];
    this.cause = details.cause;
  }
}

interface Model {
  readonly memories: readonly MemoryDefinition[];
  readonly functions: readonly FunctionDefinition[];
  readonly providers: readonly ProviderDefinition[];
  readonly domainDeclarations: IRModule['domainDeclarations'];
  readonly instructions: IRModule['instructions'];
  readonly outputs: IRModule['outputs'];
}

interface Frame {
  readonly fn: FunctionDefinition;
  readonly functionIndex: number;
  readonly values: Map<Value, RuntimeScalar>;
  block: BlockDefinition;
  position: number;
}

const supported = new Set(CORE_INSTRUCTION_NAMES);

export function createIRInterpreter(
  module: IRModule,
  options: IRInterpreterOptions,
): IRInterpreter {
  if (options === null || typeof options !== 'object') {
    throw new IRExecutionError('invalid-options', 'Expected interpreter options');
  }
  const configuredSteps = options.maxSteps;
  const maxSteps = configuredSteps === undefined ? 1_000_000 : configuredSteps;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 0) {
    throw new IRExecutionError('invalid-options', 'maxSteps must be a non-negative safe integer');
  }
  let eventHost: IREventHost | undefined;
  let stepObserver: IRStepObserver | undefined;
  let bridge: IRBridgeHost | undefined;
  let executors: ReadonlyMap<string, CapturedExecutor> | undefined;
  try {
    const host = options.eventHost;
    const observer = options.stepObserver;
    const bridgeHost = options.bridge;
    if (host !== undefined) {
      eventHost = Object.freeze({
        now: captureHook(host, 'now'),
        at: captureHook(host, 'at'),
        cancel: captureHook(host, 'cancel'),
      });
    }
    if (observer !== undefined) {
      stepObserver = Object.freeze({ beforeStep: captureHook(observer, 'beforeStep') });
    }
    if (bridgeHost !== undefined) {
      bridge = Object.freeze({
        send: captureHook(bridgeHost, 'send'),
        sendBytes: captureHook(bridgeHost, 'sendBytes'),
      });
    }
    executors = captureExecutors(options.executors);
  } catch (cause) {
    throw new IRExecutionError('invalid-options', 'Expected synchronous interpreter hooks', {
      cause,
    });
  }
  let source: Model;
  let model: Model;
  let validationOptions: IRValidationOptions;
  try {
    validationOptions = captureValidationOptions(options.validation);
    source = {
      memories: module.memories,
      functions: module.functions,
      providers: module.providers ?? [],
      domainDeclarations: module.domainDeclarations,
      instructions: module.instructions,
      outputs: module.outputs ?? [],
    };
    model = snapshot(source);
  } catch (cause) {
    throw new IRExecutionError('validation-failed', 'Could not capture the IR module', {
      cause,
      diagnostics: [
        {
          code: 'malformed-input',
          message: 'Could not capture the IR module',
          location: { path: '$' },
        },
      ],
    });
  }
  const validation = validateIR(model, validationOptions);
  if (!validation.ok) {
    throw new IRExecutionError('validation-failed', 'IR validation failed', {
      diagnostics: validation.diagnostics,
    });
  }
  for (const [functionIndex, fn] of model.functions.entries()) {
    for (const [blockIndex, block] of fn.body!.blocks.entries()) {
      for (const [instructionIndex, node] of block.instructions.entries()) {
        const core = supported.has(node.op);
        const executable = core
          ? (node.op.startsWith('event.') ? eventHost !== undefined : true) &&
            (node.op.startsWith('bridge.') ? bridge !== undefined : true)
          : executors?.has(node.op) === true;
        if (!executable) {
          throw new IRExecutionError('unsupported-instruction', `No executor for ${node.op}`, {
            location: {
              functionIndex,
              functionName: fn.name,
              blockIndex,
              blockId: block.id,
              instructionIndex,
            },
          });
        }
      }
    }
  }
  // Storage requires the original declaration identity, but its contents must be
  // exactly the snapshot just validated, including after extension validators run.
  if (!sameMemories(source.memories, model.memories)) {
    throw new IRExecutionError(
      'validation-failed',
      'Memory declarations changed during validation',
    );
  }
  let storage: IRStorage;
  try {
    storage = createIRStorage(source as IRModule, {
      updateResources: validationOptions.resources
        .filter((permission) => permission.access === 'update')
        .map((permission) => permission.ref as BytesRef),
    });
  } catch (cause) {
    throw new IRExecutionError('storage-failed', 'Could not allocate instance storage', { cause });
  }
  for (const provider of model.providers) {
    if (getProviderMetadata(provider.ref) === undefined) {
      throw new IRExecutionError(
        'validation-failed',
        `Provider "${provider.name}" has no generation callback; declare providers with createIRModule`,
      );
    }
  }
  const providers = createProviderRuntime({
    model,
    storage,
    validation: validationOptions,
    hasEventHost: eventHost !== undefined,
    hasBridge: bridge !== undefined,
  });
  return new Interpreter(
    model.functions,
    storage,
    maxSteps,
    eventHost,
    stepObserver,
    bridge,
    model.outputs,
    executors,
    providers,
  );
}

interface CapturedExecutor {
  readonly op: string;
  readonly execute: (request: IRInstructionExecution) => unknown;
}

function captureExecutors(
  values: readonly IRInstructionExecutor[] | undefined,
): ReadonlyMap<string, CapturedExecutor> | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) {
    throw new TypeError('executors must be an array');
  }
  const executors = new Map<string, CapturedExecutor>();
  for (const executor of values) {
    if (executor === null || typeof executor !== 'object') {
      throw new TypeError('Each executor must be an object');
    }
    const op = executor.op;
    if (typeof op !== 'string' || op.length === 0) {
      throw new TypeError('Executor op must be a non-empty string');
    }
    if (supported.has(op)) {
      throw new TypeError(`Executor "${op}" collides with a core instruction`);
    }
    if (executors.has(op)) {
      throw new TypeError(`Executor "${op}" is declared more than once`);
    }
    executors.set(
      op,
      Object.freeze({
        op,
        execute: captureHook(executor, 'execute') as (request: IRInstructionExecution) => unknown,
      }),
    );
  }
  return executors;
}

function captureHook<T, K extends keyof T>(receiver: T, key: K): T[K] {
  if (receiver === null || typeof receiver !== 'object') {
    throw new TypeError('Expected a hook object');
  }
  const method = receiver[key];
  assertSynchronousCallback(method, String(key));
  return ((...args: unknown[]) => {
    const result: unknown = Reflect.apply(method, receiver, args);
    if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
      if (typeof (result as { then?: unknown }).then === 'function') {
        void Promise.resolve(result).catch(() => undefined);
        throw new TypeError(`${String(key)} must not return a Promise or thenable`);
      }
      const kind = Object.prototype.toString.call(result);
      if (kind === '[object Generator]' || kind === '[object AsyncGenerator]') {
        throw new TypeError(`${String(key)} must not return a generator`);
      }
    }
    return result;
  }) as T[K];
}

function eventTime(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new TypeError('Event time must be a finite integer number of picoseconds');
  }
  if (value < 0 || value > 7_200_000_000_000_000) {
    throw new RangeError('Event time is outside [0, 7_200_000_000_000_000]');
  }
  return value === 0 ? 0 : value;
}

function eventId(value: unknown, allowZero: boolean): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError('Event ID must be a u32 integer');
  }
  if (value < (allowZero ? 0 : 1) || value > 0xffffffff) {
    throw new RangeError('Event ID is outside its u32 range');
  }
  return value === 0 ? 0 : value;
}

function captureValidationOptions(options: IRValidationOptions): IRValidationOptions {
  // Freeze policy data, not trusted validator objects: their existing callback
  // receiver and synchronous-callback checks must remain unchanged.
  return Object.freeze({
    ...options,
    supportedInstructions: Object.freeze([...options.supportedInstructions]),
    authorizedInstructions: Object.freeze([...options.authorizedInstructions]),
    resources: Object.freeze(
      options.resources.map((permission) => Object.freeze({ ...permission })),
    ),
    ...(options.validators === undefined
      ? {}
      : { validators: Object.freeze([...options.validators]) }),
  });
}

/** Clone iteratively: backedges and long call/block graphs must not use the JS stack. */
function snapshot(source: Model): Model {
  const copies = new Map<object, object>();
  const pending: [object, Record<PropertyKey, unknown>][] = [];
  const copy = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value;
    // Static references retain their nominal identity everywhere, including list operands.
    if ((value as Record<PropertyKey, unknown>)[refKind] !== undefined) return value;
    const previous = copies.get(value);
    if (previous !== undefined) return previous;
    const result = (Array.isArray(value) ? new Array(value.length) : {}) as Record<
      PropertyKey,
      unknown
    >;
    copies.set(value, result);
    pending.push([value, result]);
    return result;
  };
  const result = copy(source) as Model;
  while (pending.length > 0) {
    const [original, target] = pending.pop()!;
    for (const key of Reflect.ownKeys(original)) {
      if (!Object.prototype.propertyIsEnumerable.call(original, key) || key === 'owner') continue;
      const value = (original as Record<PropertyKey, unknown>)[key];
      // Static references retain their nominal identity; SSA values are copied
      // consistently through the graph so mutable source types cannot escape.
      Object.defineProperty(target, key, {
        value: key === 'ref' ? value : copy(value),
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    Object.freeze(target);
  }
  return result;
}

function sameMemories(
  source: readonly MemoryDefinition[],
  captured: readonly MemoryDefinition[],
): boolean {
  return (
    source.length === captured.length &&
    source.every((memory, i) => {
      const expected = captured[i]!;
      return (
        memory.ref === expected.ref &&
        memory.name === expected.name &&
        memory.kind === expected.kind &&
        memory.writable === expected.writable &&
        memory.layout.kind === expected.layout.kind &&
        memory.layout.length === expected.layout.length &&
        (memory.layout.kind === 'scalar'
          ? expected.layout.kind === 'scalar' &&
            memory.layout.scalarType === expected.layout.scalarType
          : expected.layout.kind === 'bytes' &&
            memory.layout.unitBytes === expected.layout.unitBytes) &&
        memory.initial.length === expected.initial.length &&
        memory.initial.every((value, index) => Object.is(value, expected.initial[index]))
      );
    })
  );
}

class Interpreter implements IRInterpreter {
  readonly #functions: ReadonlyMap<Target, FunctionDefinition>;
  readonly #indices: ReadonlyMap<FunctionDefinition, number>;
  readonly #maxSteps: number;
  readonly #eventHost: IREventHost | undefined;
  readonly #stepObserver: IRStepObserver | undefined;
  readonly #bridge: IRBridgeHost | undefined;
  readonly #outputs: ReadonlyMap<object, OutputDefinition>;
  readonly #executors: ReadonlyMap<string, CapturedExecutor> | undefined;
  readonly #providers: ProviderRuntime;
  #faulted = false;

  constructor(
    functions: readonly FunctionDefinition[],
    readonly storage: IRStorage,
    maxSteps: number,
    eventHost: IREventHost | undefined,
    stepObserver: IRStepObserver | undefined,
    bridge: IRBridgeHost | undefined,
    outputs: readonly OutputDefinition[],
    executors: ReadonlyMap<string, CapturedExecutor> | undefined,
    providers: ProviderRuntime,
  ) {
    this.#eventHost = eventHost;
    this.#stepObserver = stepObserver;
    this.#bridge = bridge;
    this.#outputs = new Map(outputs.map((output) => [output.ref, output]));
    this.#executors = executors;
    this.#functions = new Map(functions.map((fn) => [fn.ref, fn]));
    this.#indices = new Map(functions.map((fn, index) => [fn, index]));
    this.#maxSteps = maxSteps;
    this.#providers = providers;
    Object.freeze(this);
  }

  execute(
    target: Target,
    args: readonly RuntimeScalar[],
    context: IRExecutionContext,
  ): IRExecutionResult {
    if (this.#faulted) {
      throw new IRExecutionError(
        'instance-faulted',
        'The interpreter faulted; rebuild the instance',
      );
    }
    const fn = this.#functions.get(target);
    if (fn === undefined) {
      throw new IRExecutionError('invalid-target', 'Target does not belong to this interpreter');
    }
    if (
      context === null ||
      typeof context !== 'object' ||
      typeof context.instanceId !== 'string' ||
      context.instanceId.length === 0 ||
      !Number.isSafeInteger(context.virtualTime) ||
      context.virtualTime < 0
    ) {
      throw new IRExecutionError(
        'invalid-argument',
        'Expected instanceId and non-negative safe integer virtualTime',
      );
    }
    const capturedContext = Object.freeze({
      instanceId: context.instanceId,
      virtualTime: context.virtualTime === 0 ? 0 : context.virtualTime,
    });
    let inputs: RuntimeScalar[];
    try {
      if (!Array.isArray(args) || args.length !== fn.params.length) {
        throw new Error('Arguments must match the target signature');
      }
      inputs = fn.params.map((type, index) => captureArgument(type, args[index]!));
    } catch (cause) {
      throw new IRExecutionError('invalid-argument', 'Invalid execution arguments', {
        context: capturedContext,
        cause,
      });
    }
    const frames = [this.frame(fn, inputs)];
    let steps = 0;
    try {
      while (frames.length > 0) {
        const frame = frames[frames.length - 1]!;
        if (steps >= this.#maxSteps) {
          throw new IRExecutionError(
            'budget-exhausted',
            `Execution exceeded ${this.#maxSteps} reference IR steps`,
          );
        }
        this.#stepObserver?.beforeStep(capturedContext);
        steps += 1;
        const node = frame.block.instructions[frame.position];
        if (node !== undefined) {
          const operands = node.operands.flatMap((operand) => {
            if (operand.kind === 'ssa') return [read(frame, operand.value)];
            if (operand.kind === 'ssa-list') {
              return operand.values.map((value) => read(frame, value));
            }
            return [];
          });
          if (node.op === 'call') {
            const callee = this.#functions.get(reference(node, 0) as FunctionRef)!;
            frames.push(this.frame(callee, operands));
          } else {
            const executor = this.#executors?.get(node.op);
            const values =
              executor !== undefined
                ? this.domain(executor, node, operands, capturedContext)
                : node.op.startsWith('event.')
                  ? this.event(node, operands)
                  : node.op.startsWith('bridge.')
                    ? this.output(node, operands, capturedContext)
                    : evaluateInstruction(node, operands, this.storage);
            node.results.forEach((value, index) => frame.values.set(value, values[index]!));
            frame.position += 1;
          }
          continue;
        }
        const term = frame.block.terminator!;
        switch (term.kind) {
          case 'jump':
            enterBlock(frame, term.target, term.args);
            break;
          case 'branch': {
            const edge = read(frame, term.condition) === true ? term.yes : term.no;
            enterBlock(frame, edge.target, edge.args);
            break;
          }
          case 'return': {
            const values = term.values.map((value) => read(frame, value));
            frames.pop();
            const caller = frames[frames.length - 1];
            if (caller === undefined)
              return Object.freeze({ values: Object.freeze(values), steps });
            const call = caller.block.instructions[caller.position]!;
            call.results.forEach((value, index) => caller.values.set(value, values[index]!));
            caller.position += 1;
            break;
          }
          case 'trap':
            throw new IRExecutionError('trap', `IR trap: ${term.code}`);
          case 'dispatch': {
            const key = term.key.map((value) => read(frame, value));
            const args = term.args.map((value) => read(frame, value));
            const artifact = this.#providers.materialize(term.provider, key);
            // The artifact replaces this frame: dispatch is a tail transfer that keeps the
            // current entry, budget, and virtual time, and its return reaches our caller.
            const inputs = artifact.fn.params.map((type, index) =>
              captureArgument(type, args[index]!),
            );
            frames.pop();
            frames.push(this.generatedFrame(artifact, inputs));
            break;
          }
        }
      }
      throw new Error('Execution ended without returning');
    } catch (cause) {
      this.#faulted = true;
      const callStack = Object.freeze(frames.map(location));
      const code =
        cause instanceof IRExecutionError
          ? cause.code
          : cause instanceof IRProviderError
            ? 'provider-failed'
            : cause instanceof IRStorageError
              ? 'storage-failed'
              : 'evaluation-failed';
      throw new IRExecutionError(
        code,
        cause instanceof Error ? cause.message : 'IR execution failed',
        {
          context: capturedContext,
          ...(callStack.length > 0 ? { location: callStack[callStack.length - 1]! } : {}),
          callStack,
          steps,
          ...(cause instanceof IRProviderError && cause.diagnostics.length > 0
            ? { diagnostics: cause.diagnostics }
            : {}),
          cause,
        },
      );
    }
  }

  private domain(
    executor: CapturedExecutor,
    node: InstructionNode,
    args: readonly RuntimeScalar[],
    context: IRExecutionContext,
  ): readonly RuntimeScalar[] {
    const result: unknown = executor.execute(
      Object.freeze({
        instruction: node,
        operands: Object.freeze([...args]),
        context,
      }),
    );
    if (result === null || typeof result !== 'object') {
      throw new TypeError(`Executor "${executor.op}" must return an array of scalar values`);
    }
    if (!Array.isArray(result) || result.length !== node.results.length) {
      throw new TypeError(
        `Executor "${executor.op}" must return ${node.results.length} result value(s)`,
      );
    }
    return result.map((value, index) =>
      captureArgument(node.results[index]!.type, value as RuntimeScalar),
    );
  }

  private event(node: InstructionNode, args: readonly RuntimeScalar[]): readonly RuntimeScalar[] {
    const host = this.#eventHost!;
    switch (node.op) {
      case 'event.now':
        return [captureArgument('f64', eventTime(host.now()))];
      case 'event.at': {
        const target = reference(node, 0) as EntryRef;
        const fn = this.#functions.get(target)!;
        const captured = Object.freeze(
          fn.params.map((type, index) => captureArgument(type, args[index + 1]!)),
        );
        const raw = captureArgument('f64', args[0]!);
        const deadline = eventTime(typeof raw === 'object' ? toNumber(raw) : raw);
        if (deadline < eventTime(host.now())) {
          throw new RangeError('Event deadline cannot be before host.now()');
        }
        return [eventId(host.at(target, deadline, captured), false)];
      }
      case 'event.cancel':
        host.cancel(eventId(args[0], true));
        return [];
      default:
        throw new Error('Expected a core event instruction');
    }
  }

  private output(
    node: InstructionNode,
    args: readonly RuntimeScalar[],
    context: IRExecutionContext,
  ): readonly RuntimeScalar[] {
    const host = this.#bridge!;
    const ref = reference(node, 0);
    const definition = this.#outputs.get(ref);
    if (definition === undefined) {
      throw new Error('Bridge output is not declared in this module');
    }
    if (node.op === 'bridge.send') {
      if (definition.kind !== 'scalar-output') {
        throw new Error('bridge.send requires a scalar output');
      }
      if (args.length !== definition.params.length) {
        throw new Error('bridge.send arguments do not match its output signature');
      }
      const payload = args.map((value, index) => {
        const type = definition.params[index]!;
        return type === 'f32' || type === 'f64'
          ? typeof value === 'object'
            ? toNumber(value)
            : value
          : (value as boolean | number);
      });
      return [host.send(ref as OutputRef, Object.freeze(payload), context.virtualTime)];
    }
    if (definition.kind !== 'bytes-output') {
      throw new Error('bridge.send_bytes requires a bytes output');
    }
    const length = args[1] as number;
    if (length > definition.maxBytes) {
      throw new RangeError(
        `bridge.send_bytes length ${length} exceeds maxBytes ${definition.maxBytes}`,
      );
    }
    const bytes = this.storage.readVersionedBytes(
      reference(node, 1) as ReadableBytesRef,
      args[0] as number,
      length,
    ).bytes;
    return [host.sendBytes(ref as BytesOutputRef, bytes, context.virtualTime)];
  }

  private frame(fn: FunctionDefinition, args: readonly RuntimeScalar[]): Frame {
    const block = fn.body!.entry;
    return {
      fn,
      functionIndex: this.#indices.get(fn)!,
      block,
      position: 0,
      values: new Map(block.params.map((param, index) => [param, args[index]!])),
    };
  }

  private generatedFrame(artifact: ProviderArtifact, args: readonly RuntimeScalar[]): Frame {
    const block = artifact.fn.body!.entry;
    return {
      fn: artifact.fn,
      functionIndex: artifact.index,
      block,
      position: 0,
      values: new Map(block.params.map((param, index) => [param, args[index]!])),
    };
  }
}

function location(frame: Frame): IRExecutionLocation {
  return Object.freeze({
    functionIndex: frame.functionIndex,
    functionName: frame.fn.name,
    blockIndex: frame.fn.body!.blocks.indexOf(frame.block),
    blockId: frame.block.id,
    ...(frame.position < frame.block.instructions.length
      ? { instructionIndex: frame.position }
      : { terminator: true as const }),
  });
}

function read(frame: Frame, value: Value): RuntimeScalar {
  const result = frame.values.get(value);
  if (result === undefined) throw new Error('SSA value was not bound');
  return result;
}

function enterBlock(frame: Frame, block: BlockDefinition, args: readonly Value[]): void {
  // Read the entire edge before assigning any parameter (including self-backedges).
  const values = args.map((value) => read(frame, value));
  block.params.forEach((param, index) => frame.values.set(param, values[index]!));
  frame.block = block;
  frame.position = 0;
}

function reference(node: InstructionNode, index: number): StaticRef {
  const operand = node.operands[index]!;
  if (operand.kind !== 'static') throw new Error('Expected a validated static operand');
  return operand.ref;
}

function literal(node: InstructionNode, index: number): boolean | number | string {
  const operand = node.operands[index]!;
  if (operand.kind !== 'literal') throw new Error('Expected a validated literal operand');
  return operand.value;
}

function usesFloat(node: InstructionNode): boolean {
  return (
    node.results.some((value) => isFloatType(value.type)) ||
    node.operands.some((operand) => operand.kind === 'ssa' && isFloatType(operand.value.type))
  );
}

function evaluateInstruction(
  node: InstructionNode,
  args: readonly RuntimeScalar[],
  storage: IRStorage,
): readonly RuntimeScalar[] {
  switch (node.op) {
    case 'state.load':
      return [storage.loadState(reference(node, 0) as StateRef)];
    case 'state.store':
      storage.storeState(reference(node, 0) as StateRef, args[0]!);
      return [];
    case 'array.load':
      return [storage.loadArray(reference(node, 0) as ArrayRef, args[0] as number)];
    case 'array.store':
      storage.storeArray(reference(node, 0) as ArrayRef, args[0] as number, args[1]!);
      return [];
    case 'bytes.load':
      return [
        storage.loadBytes(
          literal(node, 0) as NumericType,
          literal(node, 1) as Endian,
          reference(node, 2) as ReadableBytesRef,
          args[0] as number,
        ),
      ];
    case 'bytes.store':
      storage.storeBytes(
        literal(node, 0) as NumericType,
        literal(node, 1) as Endian,
        reference(node, 2) as WritableBytesRef,
        args[0] as number,
        args[1]!,
      );
      return [];
    case 'resource.fill_bytes':
      storage.fillBytes(
        reference(node, 0) as BytesRef,
        args[0] as number,
        args[1] as number,
        args[2] as number,
      );
      return [];
    case 'resource.update_bytes':
      storage.updateBytes(
        reference(node, 0) as BytesRef,
        args[0] as number,
        reference(node, 2) as ReadableBytesRef,
        args[1] as number,
        args[2] as number,
      );
      return [];
    case 'bytes.copy':
      storage.copy(
        reference(node, 0) as WritableBytesRef,
        args[0] as number,
        reference(node, 2) as ReadableBytesRef,
        args[1] as number,
        args[2] as number,
      );
      return [];
    default:
      return [
        usesFloat(node)
          ? evaluateFloatInstruction(node, args)
          : evaluateScalarInstruction(node, args as readonly (boolean | number)[]),
      ];
  }
}

function captureArgument(type: ScalarType, value: RuntimeScalar): RuntimeScalar {
  const input = { type } as Value;
  const node: InstructionNode = {
    op: 'select',
    operands: [
      { kind: 'ssa', value: { type: 'bool' } as Value<'bool'> },
      { kind: 'ssa', value: input },
      { kind: 'ssa', value: input },
    ],
    results: [input],
  };
  const result = usesFloat(node)
    ? evaluateFloatInstruction(node, [true, value, value])
    : evaluateScalarInstruction(node, [true, value, value] as readonly (boolean | number)[]);
  return typeof result === 'object'
    ? Object.freeze({ type: result.type, bits: result.bits })
    : result;
}
