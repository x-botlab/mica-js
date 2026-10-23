import { CORE_INSTRUCTION_NAMES, buildGeneratedFunctionBody } from './builder';
import { IRConstructionError, IRProviderError } from './errors';
import { fromNumber, toNumber } from './float-ieee';
import { integerRange, isFloatType, isIntegerType } from './runtime';
import { createGeneratedFunctionRef, getProviderMetadata } from './runtime';
import {
  IRStorageError,
  providerReadArray,
  providerReadState,
  resumeStorageWrites,
  suspendStorageWrites,
} from './storage';
import type { IRProviderTrackedReads, IRResourceDependency, IRStorage } from './storage';
import { refKind, scalarType, signature } from './types';
import type {
  ArrayRef,
  FloatBits,
  FunctionBodyDefinition,
  FunctionDefinition,
  FunctionRef,
  GeneratedFunction,
  GenerationContext,
  ProviderDefinition,
  ProviderRef,
  ReadableBytesRef,
  RuntimeScalar,
  ScalarType,
  StateRef,
  StaticRef,
} from './types';
import type { FunctionDeclarationState, ModuleState } from './state';
import { toProviderDefinition } from './state';
import { validateGeneratedFunction } from './validate';
import type { ModuleModel } from './validation-internal';
import type { IRDiagnostic, IRDiagnosticLocation, IRValidationOptions } from './validation-types';

export interface ProviderArtifact {
  readonly definition: ProviderDefinition;
  readonly fn: FunctionDefinition;
  readonly name: string;
  readonly index: number;
  readonly dependencies: readonly IRResourceDependency[];
}

export interface ProviderRuntimeOptions {
  readonly model: ModuleModel;
  readonly storage: IRStorage;
  readonly validation: IRValidationOptions;
  readonly hasEventHost: boolean;
  readonly hasBridge: boolean;
}

export interface ProviderRuntime {
  /** Returns the artifact for one dispatch after validating (and, on a miss, generating) it. */
  materialize(provider: ProviderRef, key: RuntimeScalar[]): ProviderArtifact;
}

const READABLE_KINDS = ['bytes', 'inbox'];

export function createProviderRuntime(options: ProviderRuntimeOptions): ProviderRuntime {
  return new ProviderRuntimeImpl(options);
}

interface BuiltArtifact {
  readonly handle: GeneratedFunction;
  readonly body: FunctionBodyDefinition;
}

class ProviderRuntimeImpl implements ProviderRuntime {
  readonly #model: ModuleModel;
  readonly #storage: IRStorage;
  readonly #artifactValidation: IRValidationOptions;
  readonly #hasEventHost: boolean;
  readonly #hasBridge: boolean;
  readonly #cache = new Map<StaticRef, Map<string, ProviderArtifact>>();
  readonly #functions: ReadonlyMap<object, FunctionDefinition>;
  #generated = 0;

  constructor(options: ProviderRuntimeOptions) {
    this.#model = options.model;
    this.#storage = options.storage;
    this.#hasEventHost = options.hasEventHost;
    this.#hasBridge = options.hasBridge;
    // Artifacts are built from the in-module IR surface: every implemented core instruction is
    // allowed, while imports still bound the static references and grants still bound resources.
    this.#artifactValidation = Object.freeze({
      supportedInstructions: CORE_INSTRUCTION_NAMES,
      authorizedInstructions: CORE_INSTRUCTION_NAMES,
      resources: options.validation.resources,
    });
    this.#functions = new Map(options.model.functions.map((fn) => [fn.ref, fn]));
  }

  materialize(provider: ProviderRef, keyValues: RuntimeScalar[]): ProviderArtifact {
    const target = getProviderMetadata(provider);
    if (target === undefined) {
      throw new IRProviderError(
        'invalid-provider',
        'Dispatch target is not a provider declared by this module',
      );
    }
    const definition = toProviderDefinition(target);
    const key = normalizeKey(definition.keyTypes, keyValues, definition.name);
    let entries = this.#cache.get(provider);
    if (entries === undefined) {
      entries = new Map();
      this.#cache.set(provider, entries);
    }
    const cached = entries.get(key.id);
    if (cached !== undefined && this.#storage.validateDependencies(cached.dependencies)) {
      return cached;
    }
    const artifact = this.#generate(target, definition, key);
    entries.set(key.id, artifact);
    return artifact;
  }

  #generate(
    target: NonNullable<ReturnType<typeof getProviderMetadata>>,
    definition: ProviderDefinition,
    key: { readonly values: readonly (boolean | number)[]; readonly id: string },
  ): ProviderArtifact {
    const name = `${definition.name}#${key.id}`;
    const state = target.module;
    const generated = createGenerationContext(state, definition, name, this.#storage);
    state.providerDepth += 1;
    suspendStorageWrites(this.#storage);
    let returned: unknown;
    try {
      returned = target.generate(generated.context, key.values);
    } catch (cause) {
      throw classifyGenerationError(cause, definition.name, key.id);
    } finally {
      resumeStorageWrites(this.#storage);
      state.providerDepth -= 1;
    }
    const built = generated.take();
    if (built === undefined) {
      throw new IRProviderError(
        'generation-failed',
        `Provider "${definition.name}" did not create an artifact with gen.function`,
      );
    }
    if (returned !== built.handle) {
      throw new IRProviderError(
        'illegal-operation',
        `Provider "${definition.name}" must return the artifact created by gen.function`,
      );
    }
    const dependencies = generated.dependencies();
    if (!this.#storage.validateDependencies(dependencies)) {
      throw new IRProviderError(
        'dependency-changed',
        `Provider "${definition.name}" dependency changed during generation; nothing was cached`,
      );
    }
    const fn: FunctionDefinition = {
      ref: {
        [refKind]: 'function',
        [signature]: { params: definition.params, results: definition.results },
      } as unknown as FunctionRef,
      name,
      category: 'function',
      params: definition.params,
      results: definition.results,
      body: built.body,
    };
    const diagnostics = [
      ...validateGeneratedFunction(this.#model, fn, this.#artifactValidation, definition.imports),
      ...this.#artifactDiagnostics(fn, definition),
    ];
    if (diagnostics.length > 0) {
      const onlyImports = diagnostics.every(
        (diagnostic) => diagnostic.code === 'provider-import-violation',
      );
      throw new IRProviderError(
        onlyImports ? 'import-violation' : 'invalid-artifact',
        `Provider "${definition.name}" produced an invalid artifact for key ${key.id}`,
        { diagnostics: Object.freeze(diagnostics) },
      );
    }
    if (!this.#storage.validateDependencies(dependencies)) {
      throw new IRProviderError(
        'dependency-changed',
        `Provider "${definition.name}" dependency changed before the artifact was published`,
      );
    }
    return Object.freeze({
      definition,
      fn,
      name,
      index: this.#model.functions.length + this.#generated++,
      dependencies,
    });
  }

  #artifactDiagnostics(
    fn: FunctionDefinition,
    definition: ProviderDefinition,
  ): readonly IRDiagnostic[] {
    const diagnostics: IRDiagnostic[] = [];
    const location: IRDiagnosticLocation = {
      path: `providers.${definition.name}.generated`,
      functionName: fn.name,
    };
    for (const block of fn.body!.blocks) {
      for (const node of block.instructions) {
        if (node.op.startsWith('event.') && !this.#hasEventHost) {
          diagnostics.push({
            code: 'unsupported-instruction',
            message: `Generated artifact uses ${node.op} but the interpreter has no event host`,
            location,
          });
        }
        if (node.op.startsWith('bridge.') && !this.#hasBridge) {
          diagnostics.push({
            code: 'unsupported-instruction',
            message: `Generated artifact uses ${node.op} but the interpreter has no bridge host`,
            location,
          });
        }
      }
    }
    const reads = new Set<StaticRef>(definition.reads);
    const violation = findTrackedWrite(fn, reads, this.#functions, new Set());
    if (violation !== undefined) {
      diagnostics.push({
        code: 'unsupported-provider',
        message: `Generated artifact writes generated-read resource ${violation}; runtime invalidation recovery is not implemented (#61)`,
        location,
      });
    }
    return diagnostics;
  }
}

function createGenerationContext(
  state: ModuleState,
  definition: ProviderDefinition,
  artifactName: string,
  storage: IRStorage,
): {
  readonly context: GenerationContext;
  take(): BuiltArtifact | undefined;
  dependencies(): readonly IRResourceDependency[];
} {
  const reads = new Set<StaticRef>(definition.reads);
  const tracked = new Set<IRResourceDependency>();
  let built: BuiltArtifact | undefined;
  const collect = (dependencies: readonly IRResourceDependency[]): void => {
    for (const dependency of dependencies) tracked.add(dependency);
  };
  const requireRead = (ref: StaticRef, kinds: readonly string[], method: string): void => {
    if (typeof ref !== 'object' || ref === null) {
      throw new IRProviderError('invalid-read', `gen.${method} requires a static reference`);
    }
    if (!reads.has(ref)) {
      throw new IRProviderError(
        'unauthorized-read',
        `gen.${method} reference is not listed in provider "${definition.name}" reads`,
      );
    }
    const kind = ref[refKind];
    if (typeof kind !== 'string' || !kinds.includes(kind)) {
      throw new IRProviderError(
        'invalid-read',
        `gen.${method} reference must be a ${kinds.join(' or ')} resource`,
      );
    }
  };
  const context = Object.freeze({
    readBytes(ref: ReadableBytesRef, offset: number, length: number): Uint8Array {
      requireRead(ref, READABLE_KINDS, 'readBytes');
      if (!Number.isInteger(offset) || !Number.isInteger(length)) {
        throw new IRProviderError('invalid-read', 'gen.readBytes requires integer offset/length');
      }
      try {
        const result = storage.readVersionedBytes(ref, offset, length);
        collect(result.dependencies);
        return result.bytes;
      } catch (cause) {
        throw invalidRead('readBytes', definition.name, cause);
      }
    },
    readState<T extends ScalarType>(ref: StateRef<T>): boolean | number {
      requireRead(ref, ['state'], 'readState');
      try {
        const result = (storage as unknown as IRProviderTrackedReads)[providerReadState](ref);
        collect(result.dependencies);
        return jsScalar((ref as unknown as Record<PropertyKey, unknown>)[scalarType], result.value);
      } catch (cause) {
        throw invalidRead('readState', definition.name, cause);
      }
    },
    readArray<T extends ScalarType>(ref: ArrayRef<T>, index: number): boolean | number {
      requireRead(ref, ['array'], 'readArray');
      if (!Number.isInteger(index)) {
        throw new IRProviderError('invalid-read', 'gen.readArray requires an integer index');
      }
      try {
        const result = (storage as unknown as IRProviderTrackedReads)[providerReadArray](
          ref,
          index,
        );
        collect(result.dependencies);
        return jsScalar((ref as unknown as Record<PropertyKey, unknown>)[scalarType], result.value);
      } catch (cause) {
        throw invalidRead('readArray', definition.name, cause);
      }
    },
    function(callback: unknown): GeneratedFunction {
      if (built !== undefined) {
        throw new IRProviderError(
          'illegal-operation',
          'gen.function may only create one artifact per generation',
        );
      }
      const handle = createGeneratedFunctionRef(definition.params, definition.results);
      const declaration: FunctionDeclarationState = {
        module: state,
        name: artifactName,
        category: 'function',
        params: definition.params,
        results: definition.results,
        ref: {
          [refKind]: 'function',
          [signature]: { params: definition.params, results: definition.results },
        } as unknown as FunctionRef,
        body: undefined,
        defining: false,
      };
      try {
        buildGeneratedFunctionBody(declaration, callback);
      } catch (cause) {
        throw new IRProviderError(
          'generation-failed',
          `Provider "${definition.name}" could not build its artifact: ${messageOf(cause)}`,
          { cause },
        );
      }
      built = { handle, body: declaration.body! };
      return handle;
    },
  }) as unknown as GenerationContext;
  return {
    context,
    take: () => built,
    dependencies: () => Object.freeze([...tracked]),
  };
}

function jsScalar(type: unknown, value: unknown): boolean | number {
  if (type === 'bool') {
    if (typeof value !== 'boolean') {
      throw new IRProviderError('invalid-read', 'Tracked state read did not produce a boolean');
    }
    return value;
  }
  if (typeof value === 'object' && value !== null && 'bits' in value) {
    return toNumber(value as FloatBits);
  }
  if (typeof value === 'number') return value;
  throw new IRProviderError('invalid-read', 'Tracked read produced a non-scalar value');
}

function invalidRead(method: string, providerName: string, cause: unknown): IRProviderError {
  if (cause instanceof IRProviderError) return cause;
  if (cause instanceof IRStorageError) {
    return new IRProviderError(
      'invalid-read',
      `gen.${method} for provider "${providerName}" failed: ${cause.message}`,
      { cause },
    );
  }
  return new IRProviderError(
    'invalid-read',
    `gen.${method} for provider "${providerName}" failed: ${messageOf(cause)}`,
    { cause },
  );
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function classifyGenerationError(
  cause: unknown,
  providerName: string,
  keyId: string,
): IRProviderError {
  if (cause instanceof IRProviderError) return cause;
  if (cause instanceof IRConstructionError) {
    return new IRProviderError(
      'illegal-operation',
      `Provider "${providerName}" attempted a declaration during generation of key ${keyId}: ${cause.message}`,
      { cause },
    );
  }
  if (cause instanceof IRStorageError) {
    return new IRProviderError(
      'illegal-operation',
      `Provider "${providerName}" attempted a storage write during generation of key ${keyId}`,
      { cause },
    );
  }
  return new IRProviderError(
    'generation-failed',
    `Provider "${providerName}" generation for key ${keyId} failed: ${messageOf(cause)}`,
    { cause },
  );
}

function normalizeKey(
  keyTypes: readonly ScalarType[],
  values: readonly RuntimeScalar[],
  providerName: string,
): { readonly values: readonly (boolean | number)[]; readonly id: string } {
  if (!Array.isArray(values) || values.length !== keyTypes.length) {
    throw new IRProviderError(
      'key-mismatch',
      `Provider "${providerName}" expects ${keyTypes.length} key value(s)`,
    );
  }
  const normalized: (boolean | number)[] = [];
  const parts: string[] = [];
  keyTypes.forEach((type, index) => {
    const value = values[index]!;
    if (type === 'bool') {
      if (typeof value !== 'boolean') throw keyMismatch(providerName, index, type);
      normalized.push(value);
      parts.push(`b:${value ? 1 : 0}`);
      return;
    }
    if (isFloatType(type)) {
      const number = typeof value === 'number' ? value : toNumber(value as FloatBits);
      if (typeof number !== 'number') throw keyMismatch(providerName, index, type);
      const bits = fromNumber(type as 'f32' | 'f64', number);
      normalized.push(toNumber(bits));
      parts.push(`f:${type}:${bits.bits}`);
      return;
    }
    if (isIntegerType(type)) {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw keyMismatch(providerName, index, type);
      }
      const range = integerRange(type as Parameters<typeof integerRange>[0]);
      if (value < range.min || value > range.max) {
        throw keyMismatch(providerName, index, type);
      }
      normalized.push(value);
      parts.push(`i:${value}`);
      return;
    }
    throw keyMismatch(providerName, index, type);
  });
  return { values: Object.freeze(normalized), id: parts.join('|') };
}

function keyMismatch(providerName: string, index: number, type: ScalarType): IRProviderError {
  return new IRProviderError(
    'key-mismatch',
    `Provider "${providerName}" key ${index} is not a valid ${type} scalar`,
  );
}

/**
 * Rejects artifacts that write a resource they were generated from. The transitive walk covers
 * ordinary calls inside this module; dispatch targets are re-checked when they run.
 */
function findTrackedWrite(
  fn: FunctionDefinition,
  reads: ReadonlySet<StaticRef>,
  functions: ReadonlyMap<object, FunctionDefinition>,
  visited: Set<object>,
): string | undefined {
  if (visited.has(fn)) return undefined;
  visited.add(fn);
  for (const block of fn.body?.blocks ?? []) {
    for (const node of block.instructions) {
      const written = writtenRef(node.op, node.operands);
      if (written !== undefined && reads.has(written)) return describeRef(written);
      if (node.op === 'call') {
        const target = (node.operands[0] as { readonly ref?: StaticRef } | undefined)?.ref;
        const callee = target === undefined ? undefined : functions.get(target);
        if (callee !== undefined) {
          const nested = findTrackedWrite(callee, reads, functions, visited);
          if (nested !== undefined) return nested;
        }
      }
    }
  }
  return undefined;
}

function writtenRef(
  op: string,
  operands: readonly { readonly kind: string; readonly ref?: StaticRef }[],
): StaticRef | undefined {
  switch (op) {
    case 'state.store':
    case 'array.store':
    case 'resource.update_bytes':
    case 'resource.fill_bytes':
      return operands[0]?.ref;
    case 'bytes.store':
      return operands[2]?.ref;
    case 'bytes.copy':
      return operands[0]?.ref;
    default:
      return undefined;
  }
}

function describeRef(ref: StaticRef): string {
  const kind = ref[refKind];
  return typeof kind === 'string' ? `${kind} resource` : 'tracked resource';
}
