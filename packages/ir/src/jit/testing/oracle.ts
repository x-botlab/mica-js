/**
 * Differential oracle for JIT parity fuzzing (#149).
 *
 * One {@link RandomProgram} is executed once per configuration on a fresh
 * engine instance. Every invocation records:
 *
 * - the returned values or the complete `IRExecutionError` shape;
 * - the exact step count and the provider generation count (equal to
 *   `ProviderRuntime.cacheEpoch` after a successful run);
 * - a deep `storage.dump()` snapshot.
 *
 * {@link runOracle} compares the reference interpreter against every requested
 * configuration and returns the first divergence with a precise path so a
 * failing seed can be replayed.
 */
import { IRExecutionError, createIRInterpreter } from '../../interpreter';
import type {
  IRExecutionContext,
  IRExecutionResult,
  IRInterpreter,
  IRInterpreterOptions,
} from '../../interpreter';
import type { IRStorage, IRStorageSnapshot, StorageValue } from '../../storage';
import type { IRModule, RuntimeScalar, ScalarType } from '../../types';
import { createIRJIT } from '../../jit-runtime';
import type { IRJITTuning } from '../../jit-runtime';
import type { RandomProgram } from './random-ir';

export interface ParityConfig {
  readonly name: string;
  create(module: IRModule, options: IRInterpreterOptions): IRInterpreter;
}

export const REFERENCE_CONFIG: ParityConfig = Object.freeze({
  name: 'reference',
  create: (module: IRModule, options: IRInterpreterOptions) => createIRInterpreter(module, options),
});

export function jitConfig(name: string, tuning: IRJITTuning): ParityConfig {
  return Object.freeze({
    name,
    create: (module: IRModule, options: IRInterpreterOptions) =>
      createIRJIT(module, { ...options, jit: tuning }),
  });
}

/** Configurations mandated by the J09 matrix. */
export const PARITY_CONFIGS: readonly ParityConfig[] = Object.freeze([
  REFERENCE_CONFIG,
  jitConfig('jit-heap', { tier: 'heap' }),
  jitConfig('jit', { tier: 'compiled', warmup: 'lazy' }),
  jitConfig('jit-default', {}),
  // Tier-2 immediately (inline + biased layout) and on the first hot call.
  jitConfig('jit-tier2', { tier: 'compiled', tierUpThreshold: 0 }),
  jitConfig('jit-hot', { tier: 'compiled', tierUpThreshold: 1 }),
  // The same pipeline with inlining disabled: the pass switch is observable.
  jitConfig('jit-tier2-no-inline', {
    tier: 'compiled',
    tierUpThreshold: 0,
    optimizations: { inline: false },
  }),
]);

export interface FailureCauseRecord {
  readonly name?: string;
  readonly code?: string;
  readonly message?: string;
}

export interface FailureRecord {
  readonly name: string;
  readonly code?: string;
  readonly message: string;
  readonly context?: IRExecutionContext;
  readonly location?: unknown;
  readonly callStack?: unknown;
  readonly steps: number;
  readonly diagnostics?: unknown;
  readonly cause?: FailureCauseRecord | { readonly value: string };
  readonly frozen: boolean;
}

export type InvocationRecord =
  | {
      readonly ok: true;
      readonly values: readonly RuntimeScalar[];
      readonly steps: number;
      /**
       * `ProviderRuntime.cacheEpoch` observed through the program's generation
       * callback: every successful generation bumps that counter exactly once.
       */
      readonly providerCacheEpoch: number;
      /** Keys that generated an artifact so far (cache state fingerprint). */
      readonly providerKeys: readonly number[];
      readonly storage: StorageRecord;
    }
  | {
      readonly ok: false;
      readonly steps: number;
      readonly error: FailureRecord;
      /** See {@link InvocationRecord} — generation count equals `cacheEpoch`. */
      readonly providerCacheEpoch: number;
      /** Keys that generated an artifact so far (cache state fingerprint). */
      readonly providerKeys: readonly number[];
      readonly storage: StorageRecord;
    };

export interface RunRecord {
  readonly config: string;
  readonly creationError?: FailureRecord;
  readonly invocations: readonly InvocationRecord[];
}

export interface StorageRecord {
  readonly scalars: readonly (readonly [string, StorageValue<ScalarType>])[];
  readonly arrays: readonly (readonly [string, readonly StorageValue<ScalarType>[]])[];
  readonly bytes: readonly (readonly [string, readonly number[]])[];
}

export interface Divergence {
  readonly seed: number;
  readonly profile: string;
  readonly config: string;
  readonly path: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

const CONTEXT_INSTANCE_PREFIX = 'fuzz';

function engineOptions(program: RandomProgram): IRInterpreterOptions {
  return {
    validation: program.validation,
    ...(program.maxSteps === undefined ? {} : { maxSteps: program.maxSteps }),
  };
}

function contextFor(program: RandomProgram): IRExecutionContext {
  return Object.freeze({
    instanceId: `${CONTEXT_INSTANCE_PREFIX}-${program.seed}`,
    virtualTime: program.seed * 1_000,
  });
}

function recordStorage(storage: IRStorage): StorageRecord {
  const snapshot: IRStorageSnapshot = storage.dump();
  const scalars = [...snapshot.scalars.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const arrays = [...snapshot.arrays.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const bytes = [...snapshot.bytes.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => [name, [...value]] as const);
  return Object.freeze({ scalars, arrays, bytes });
}

function causeRecord(cause: unknown): FailureCauseRecord | { readonly value: string } | undefined {
  if (cause === undefined) return undefined;
  if (typeof cause !== 'object' || cause === null) return { value: String(cause) };
  const record: {
    name?: string;
    code?: string;
    message?: string;
  } = {};
  const name = (cause as { name?: unknown }).name;
  const code = (cause as { code?: unknown }).code;
  const message = (cause as { message?: unknown }).message;
  if (typeof name === 'string') record.name = name;
  if (typeof code === 'string') record.code = code;
  if (typeof message === 'string') record.message = message;
  return record;
}

function recordFailure(cause: unknown): FailureRecord {
  if (!(cause instanceof IRExecutionError)) {
    const record: {
      name: string;
      message: string;
      steps: number;
      cause?: FailureCauseRecord | { readonly value: string };
      frozen: boolean;
    } = {
      name: typeof cause === 'object' && cause !== null ? 'non-IRExecutionError' : 'thrown',
      message: cause instanceof Error ? cause.message : String(cause),
      steps: 0,
      frozen: Object.isFrozen(cause),
    };
    const nested = causeRecord(cause);
    if (nested !== undefined) record.cause = nested;
    return record;
  }
  const record: {
    name: string;
    code?: string;
    message: string;
    context?: IRExecutionContext;
    location?: unknown;
    callStack?: unknown;
    steps: number;
    diagnostics?: unknown;
    cause?: FailureCauseRecord | { readonly value: string };
    frozen: boolean;
  } = {
    name: cause.name,
    code: cause.code,
    message: cause.message,
    steps: cause.steps,
    frozen: Object.isFrozen(cause),
  };
  if (cause.context !== undefined) record.context = cause.context;
  if (cause.location !== undefined) record.location = cause.location;
  if (cause.callStack !== undefined) record.callStack = cause.callStack;
  if (cause.diagnostics !== undefined) record.diagnostics = cause.diagnostics;
  const nested = causeRecord(cause.cause);
  if (nested !== undefined) record.cause = nested;
  return record;
}

/** Execute every program invocation against one fresh engine instance. */
export function runProgram(program: RandomProgram, config: ParityConfig): RunRecord {
  const options = engineOptions(program);
  program.stats.generated = 0;
  program.stats.keys.length = 0;
  let engine: IRInterpreter;
  try {
    engine = config.create(program.module, options);
  } catch (cause) {
    return Object.freeze({
      config: config.name,
      creationError: recordFailure(cause),
      invocations: [],
    });
  }
  const context = contextFor(program);
  const invocations: InvocationRecord[] = [];
  for (const args of program.invocations) {
    let result: IRExecutionResult | undefined;
    let failure: FailureRecord | undefined;
    try {
      result = engine.execute(program.target, args, context);
    } catch (cause) {
      failure = recordFailure(cause);
    }
    const storage = recordStorage(engine.storage);
    const providerCacheEpoch = program.stats.generated;
    const providerKeys = Object.freeze([...program.stats.keys]);
    if (failure === undefined) {
      invocations.push(
        Object.freeze({
          ok: true,
          values: result!.values,
          steps: result!.steps,
          providerCacheEpoch,
          providerKeys,
          storage,
        }),
      );
    } else {
      invocations.push(
        Object.freeze({
          ok: false,
          steps: failure.steps,
          error: failure,
          providerCacheEpoch,
          providerKeys,
          storage,
        }),
      );
    }
  }
  return Object.freeze({ config: config.name, invocations: Object.freeze(invocations) });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatPath(path: string, key: string | number): string {
  return typeof key === 'number' ? `${path}[${key}]` : path === '' ? key : `${path}.${key}`;
}

/** Structural diff that keeps `-0` distinct and treats NaN as equal to NaN. */
export function findDifference(
  expected: unknown,
  actual: unknown,
  path = '',
): { readonly path: string; readonly expected: unknown; readonly actual: unknown } | undefined {
  if (Object.is(expected, actual)) return undefined;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return { path, expected, actual };
    if (expected.length !== actual.length) return { path: `${path}.length`, expected, actual };
    for (let index = 0; index < expected.length; index += 1) {
      const difference = findDifference(expected[index], actual[index], formatPath(path, index));
      if (difference !== undefined) return difference;
    }
    return undefined;
  }
  if (isPlainObject(expected) || isPlainObject(actual)) {
    if (!isPlainObject(expected) || !isPlainObject(actual)) return { path, expected, actual };
    const expectedKeys = Object.keys(expected).sort();
    const actualKeys = Object.keys(actual).sort();
    const keyDifference = findDifference(expectedKeys, actualKeys, `${path}.keys`);
    if (keyDifference !== undefined) return keyDifference;
    for (const key of expectedKeys) {
      const difference = findDifference(expected[key], actual[key], formatPath(path, key));
      if (difference !== undefined) return difference;
    }
    return undefined;
  }
  return { path, expected, actual };
}

/**
 * Run `reference` and every other configuration; return the first divergence.
 * Pass the reference first (the default when omitted).
 */
export function runOracle(
  program: RandomProgram,
  configs: readonly ParityConfig[] = PARITY_CONFIGS,
): Divergence | undefined {
  const [reference, ...rest] = configs;
  if (reference === undefined) return undefined;
  const expected = runProgram(program, reference);
  // `config` names the row and is not part of the observable behavior.
  const expectedOutcome = {
    creationError: expected.creationError,
    invocations: expected.invocations,
  };
  for (const config of rest) {
    const actual = runProgram(program, config);
    const actualOutcome = {
      creationError: actual.creationError,
      invocations: actual.invocations,
    };
    const difference = findDifference(expectedOutcome, actualOutcome, '');
    if (difference !== undefined) {
      return {
        seed: program.seed,
        profile: program.profile,
        config: config.name,
        path: difference.path,
        expected: difference.expected,
        actual: difference.actual,
      };
    }
  }
  return undefined;
}

/** Human-readable one-liner used by test failure messages and long-run logs. */
export function formatDivergence(divergence: Divergence): string {
  return (
    `parity divergence: seed=${divergence.seed} profile=${divergence.profile} ` +
    `config=${divergence.config} path=${divergence.path}\n` +
    `  expected=${formatValue(divergence.expected)}\n` +
    `  actual=${formatValue(divergence.actual)}`
  );
}

function formatValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
