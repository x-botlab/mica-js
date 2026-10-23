import { CORE_INSTRUCTION_NAMES } from './builder';
import { IRExecutionError } from './interpreter';
import type {
  IRBridgeHost,
  IREventHost,
  IRInstructionExecution,
  IRInstructionExecutor,
  IRInterpreterOptions,
  IRStepBudget,
  IRStepObserver,
} from './interpreter';
import { createProviderRuntime } from './provider';
import type { ProviderRuntime } from './provider';
import { assertSynchronousCallback, getProviderMetadata } from './runtime';
import { createIRStorage } from './storage';
import type { IRStorage } from './storage';
import { refKind } from './types';
import type {
  BytesRef,
  EntryRef,
  FunctionDefinition,
  FunctionRef,
  IRModule,
  LifecycleRef,
  MemoryDefinition,
  OutputDefinition,
  ProviderDefinition,
} from './types';
import { validateIR } from './validate';
import type { IRValidationOptions } from './validation-types';

export type Target = FunctionRef | EntryRef | LifecycleRef;

export interface CapturedExecutor {
  readonly op: string;
  readonly execute: (request: IRInstructionExecution) => unknown;
}

/**
 * Host capabilities captured once at creation time. Both the reference interpreter and the JIT
 * read these records, so hook validation happens in exactly one place.
 */
export interface EngineHooks {
  readonly eventHost: IREventHost | undefined;
  readonly stepObserver: IRStepObserver | undefined;
  readonly stepBudget: IRStepBudget | undefined;
  readonly bridge: IRBridgeHost | undefined;
  readonly executors: ReadonlyMap<string, CapturedExecutor> | undefined;
}

export interface Model {
  readonly memories: readonly MemoryDefinition[];
  readonly functions: readonly FunctionDefinition[];
  readonly providers: readonly ProviderDefinition[];
  readonly domainDeclarations: IRModule['domainDeclarations'];
  readonly instructions: IRModule['instructions'];
  readonly outputs: IRModule['outputs'];
}

export interface EngineSetup extends EngineHooks {
  /** Captured and validated module snapshot; never the caller's mutable module. */
  readonly model: Model;
  readonly storage: IRStorage;
  readonly providers: ProviderRuntime;
  readonly maxSteps: number;
  readonly functions: ReadonlyMap<Target, FunctionDefinition>;
  readonly indices: ReadonlyMap<FunctionDefinition, number>;
  readonly outputs: ReadonlyMap<object, OutputDefinition>;
}

const supported = new Set(CORE_INSTRUCTION_NAMES);

/**
 * Creation-time checks and initialization shared by every execution engine. Error codes, messages
 * and their order match the reference interpreter contract exactly.
 */
export function prepareEngine(
  module: IRModule,
  options: IRInterpreterOptions,
  extra?: (options: IRInterpreterOptions) => void,
): EngineSetup {
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
  let stepBudget: IRStepBudget | undefined;
  let bridge: IRBridgeHost | undefined;
  let executors: ReadonlyMap<string, CapturedExecutor> | undefined;
  try {
    const host = options.eventHost;
    const observer = options.stepObserver;
    const budget = options.stepBudget;
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
    if (budget !== undefined) {
      stepBudget = Object.freeze({
        remaining: captureHook(budget, 'remaining'),
        consume: captureHook(budget, 'consume'),
      });
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
  if (stepObserver !== undefined && stepBudget !== undefined) {
    throw new IRExecutionError(
      'invalid-options',
      'stepObserver and stepBudget are mutually exclusive',
    );
  }
  extra?.(options);
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
  return {
    eventHost,
    stepObserver,
    stepBudget,
    bridge,
    executors,
    model,
    storage,
    providers,
    maxSteps,
    functions: new Map<Target, FunctionDefinition>(model.functions.map((fn) => [fn.ref, fn])),
    indices: new Map<FunctionDefinition, number>(model.functions.map((fn, index) => [fn, index])),
    outputs: new Map<object, OutputDefinition>(model.outputs.map((output) => [output.ref, output])),
  };
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
