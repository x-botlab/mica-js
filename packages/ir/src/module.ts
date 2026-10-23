import { defineFunctionBody, CORE_INSTRUCTION_NAMES } from './builder';
import { IRProviderError, fail } from './errors';
import type {
  ArrayRef,
  BytesOptions,
  BytesOutputRef,
  BytesRef,
  DeclaredInstruction,
  DomainDeclaration,
  DomainInstruction,
  DomainInstructionDefinition,
  DomainOperandType,
  EntryRef,
  FunctionDefinition,
  FunctionRef,
  FunctionSignature,
  GeneratedFunction,
  GenerationContext,
  InboxRef,
  IRModule,
  IRModuleOptions,
  JSScalar,
  LifecycleRef,
  MemoryDefinition,
  OutputDefinition,
  OutputRef,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderRef,
  ResourceRef,
  ScalarArgs,
  ScalarType,
  StateRef,
  StaticRef,
} from './types';
import type {
  BuilderExtensionState,
  DomainDeclarationState,
  DomainInstructionState,
  FunctionDeclarationState,
  MemoryState,
  ModuleState,
  OutputState,
  ProviderState,
} from './state';
import { toFunctionDefinition, toProviderDefinition } from './state';
import {
  assertCapacity,
  assertName,
  assertScalarType,
  assertScalarTypeList,
  createArrayRef,
  createBytesOutputRef,
  createBytesRef,
  createDomainInstructionRef,
  createDomainStaticRef,
  createFunctionRef,
  createInboxRef,
  createOutputRef,
  createProviderRef,
  createStateRef,
  getMemoryMetadata,
  getRefModule,
  normalizeScalarLiteral,
  assertSynchronousCallback,
} from './runtime';
import { refKind } from './types';
const RESERVED_BUILDER_NAMES: ReadonlySet<string> = new Set([
  'const',
  'bits',
  'bool',
  'int',
  'float',
  'convert',
  'bitcast',
  'select',
  'state',
  'array',
  'bytes',
  'resource',
  'event',
  'call',
  'block',
  'at',
  'invoke',
  'return',
  'jump',
  'branch',
  'trap',
  'then',
  'constructor',
  '__proto__',
  'prototype',
]);

export function createIRModule(options?: IRModuleOptions): IRModule {
  return new IRModuleImpl(options);
}

function listLength(value: unknown, name: string, index: number): { readonly minLength?: number } {
  if (value === undefined) {
    return {};
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`Instruction "${name}" operand ${index} minLength must be a non-negative integer`);
  }
  return { minLength: value as number };
}

class IRModuleImpl implements IRModule {
  private readonly core: ModuleState;

  constructor(options: IRModuleOptions | undefined) {
    this.core = {
      memories: [],
      functions: [],
      providers: [],
      domainDeclarations: [],
      instructions: [],
      outputs: [],
      builderExtensions: captureBuilderExtensions(options),
      names: new Set(),
      instructionNames: new Set(CORE_INSTRUCTION_NAMES),
      bodyDepth: 0,
      providerDepth: 0,
    };
  }

  get memories(): readonly MemoryDefinition[] {
    return this.core.memories.map((memory) => memory.definition);
  }

  get functions(): readonly FunctionDefinition[] {
    return this.core.functions.map((declaration) => toFunctionDefinition(declaration));
  }

  get providers(): readonly ProviderDefinition[] {
    return this.core.providers.map((provider) => toProviderDefinition(provider));
  }

  get domainDeclarations(): readonly DomainDeclaration[] {
    return this.core.domainDeclarations.map(({ kind, name, ref }) => ({ kind, name, ref }));
  }

  get instructions(): readonly DeclaredInstruction[] {
    return this.core.instructions.map(({ name, definition }) => ({
      name,
      operands: definition.operands,
      results: definition.results,
    }));
  }

  get outputs(): readonly OutputDefinition[] {
    return this.core.outputs.map((output) => output.definition);
  }

  state<T extends ScalarType>(name: string, type: T, initial: JSScalar<NoInfer<T>>): StateRef<T> {
    this.declareName(name);
    assertScalarType(type, 'state type');
    const value = normalizeScalarLiteral(type, initial);
    const memory: MemoryState = {
      module: this.core,
      definition: undefined as unknown as MemoryDefinition,
    };
    const ref = createStateRef(memory, type);
    memory.definition = {
      name,
      kind: 'state',
      layout: { kind: 'scalar', scalarType: type, length: 1 },
      writable: true,
      initial: [value],
      ref,
    };
    this.core.memories.push(memory);
    return ref;
  }

  array<T extends ScalarType>(
    name: string,
    type: T,
    initial: readonly JSScalar<NoInfer<T>>[],
  ): ArrayRef<T> {
    this.declareName(name);
    assertScalarType(type, 'array element type');
    if (!Array.isArray(initial)) {
      fail(`Array "${name}" initial value must be an array`);
    }
    const values = Array.from(initial, (value, index) =>
      normalizeScalarLiteral(type, value, `array "${name}" initial[${index}]`),
    );
    const memory: MemoryState = {
      module: this.core,
      definition: undefined as unknown as MemoryDefinition,
    };
    const ref = createArrayRef(memory, type);
    memory.definition = {
      name,
      kind: 'array',
      layout: { kind: 'scalar', scalarType: type, length: values.length },
      writable: true,
      initial: values,
      ref,
    };
    this.core.memories.push(memory);
    return ref;
  }

  bytes<const ReadonlyBytes extends boolean>(
    name: string,
    initial: Uint8Array,
    options: BytesOptions<ReadonlyBytes>,
  ): BytesRef<ReadonlyBytes> {
    this.declareName(name);
    if (!(initial instanceof Uint8Array)) {
      fail(`Bytes "${name}" initial value must be a Uint8Array`);
    }
    if (typeof options !== 'object' || options === null) {
      fail(`Bytes "${name}" requires a readonly option`);
    }
    if (typeof options.readonly !== 'boolean') {
      fail(`Bytes "${name}" readonly option must be a boolean`);
    }
    const unitBytes = options.unitBytes ?? initial.length;
    if (options.unitBytes !== undefined) {
      assertCapacity(options.unitBytes, `Bytes "${name}" unitBytes`);
      if (options.unitBytes === 0) {
        fail(`Bytes "${name}" unitBytes must be positive`);
      }
    }
    const memory: MemoryState = {
      module: this.core,
      definition: undefined as unknown as MemoryDefinition,
    };
    const ref = createBytesRef(memory, options.readonly);
    memory.definition = {
      name,
      kind: 'bytes',
      layout: { kind: 'bytes', length: initial.length, unitBytes },
      writable: !options.readonly,
      initial: Array.from(initial),
      ref,
    };
    this.core.memories.push(memory);
    return ref;
  }

  inbox(name: string, capacity: number): InboxRef {
    this.declareName(name);
    assertCapacity(capacity, `Inbox "${name}" capacity`);
    const memory: MemoryState = {
      module: this.core,
      definition: undefined as unknown as MemoryDefinition,
    };
    const ref = createInboxRef(memory);
    memory.definition = {
      name,
      kind: 'inbox',
      layout: { kind: 'bytes', length: capacity, unitBytes: capacity },
      writable: false,
      initial: Array.from({ length: capacity }, () => 0),
      ref,
    };
    this.core.memories.push(memory);
    return ref;
  }

  func<const P extends readonly ScalarType[], const R extends readonly ScalarType[]>(
    name: string,
    signature: FunctionSignature<P, R>,
  ): FunctionRef<P, R> {
    const declaration = this.declareFunction(name, 'function', signature);
    return declaration.ref as FunctionRef<P, R>;
  }

  entry<const P extends readonly ScalarType[]>(name: string, params: P): EntryRef<P> {
    const declaration = this.declareFunction(name, 'entry', {
      params,
      results: [],
    });
    return declaration.ref as unknown as EntryRef<P>;
  }

  lifecycle<const P extends readonly ScalarType[]>(name: string, params: P): LifecycleRef<P> {
    const declaration = this.declareFunction(name, 'lifecycle', {
      params,
      results: [],
    });
    return declaration.ref as unknown as LifecycleRef<P>;
  }

  provider<
    const K extends readonly ScalarType[],
    const P extends readonly ScalarType[],
    const R extends readonly ScalarType[],
  >(
    name: string,
    descriptor: ProviderDescriptor<K, P, R>,
    generate: (
      gen: GenerationContext<NoInfer<P>, NoInfer<R>>,
      key: ScalarArgs<NoInfer<K>>,
    ) => GeneratedFunction<NoInfer<P>, NoInfer<R>>,
  ): ProviderRef<K, P, R> {
    this.declareName(name);
    if (typeof descriptor !== 'object' || descriptor === null) {
      fail(`Provider "${name}" requires a descriptor`);
    }
    const keyTypes = assertScalarTypeList(descriptor.keyTypes, `Provider "${name}" keyTypes`);
    const params = assertScalarTypeList(descriptor.params, `Provider "${name}" params`);
    const results = assertScalarTypeList(descriptor.results, `Provider "${name}" results`);
    const reads = captureProviderRefs(
      this.core,
      descriptor.reads,
      `Provider "${name}" reads`,
      PROVIDER_READ_CATEGORIES,
      true,
    ) as readonly ResourceRef[];
    const imports = captureProviderRefs(
      this.core,
      descriptor.imports,
      `Provider "${name}" imports`,
      PROVIDER_IMPORT_CATEGORIES,
      false,
    );
    assertSynchronousCallback(generate, `Provider "${name}" generate`);
    const provider: ProviderState = {
      module: this.core,
      name,
      keyTypes,
      params,
      results,
      reads,
      imports,
      generate: generate as (gen: unknown, key: readonly unknown[]) => unknown,
      ref: undefined as unknown as ProviderRef,
    };
    const ref = createProviderRef<K, P, R>(provider);
    provider.ref = ref as unknown as ProviderRef;
    this.core.providers.push(provider);
    return ref;
  }

  output<const P extends readonly ScalarType[]>(
    name: string,
    descriptor: { readonly params: P; readonly capacity: number },
  ): OutputRef<P> {
    this.declareName(name);
    if (typeof descriptor !== 'object' || descriptor === null) {
      fail(`Output "${name}" requires a descriptor`);
    }
    const params = assertScalarTypeList(descriptor.params, `Output "${name}" params`);
    assertPositiveCapacity(descriptor.capacity, `Output "${name}" capacity`);
    const state: OutputState = {
      module: this.core,
      definition: undefined as unknown as OutputDefinition,
    };
    const ref = createOutputRef<P>(state, params);
    state.definition = {
      kind: 'scalar-output',
      name,
      ref,
      params,
      capacity: descriptor.capacity,
    };
    this.core.outputs.push(state);
    return ref;
  }

  outputBytes(
    name: string,
    descriptor: { readonly maxBytes: number; readonly capacity: number },
  ): BytesOutputRef {
    this.declareName(name);
    if (typeof descriptor !== 'object' || descriptor === null) {
      fail(`Bytes output "${name}" requires a descriptor`);
    }
    const maxBytes = descriptor.maxBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      fail(`Bytes output "${name}" maxBytes must be a non-negative safe integer`);
    }
    assertPositiveCapacity(descriptor.capacity, `Bytes output "${name}" capacity`);
    const state: OutputState = {
      module: this.core,
      definition: undefined as unknown as OutputDefinition,
    };
    const ref = createBytesOutputRef(state);
    state.definition = {
      kind: 'bytes-output',
      name,
      ref,
      capacity: descriptor.capacity,
      maxBytes,
    };
    this.core.outputs.push(state);
    return ref;
  }

  domainDeclaration<Kind extends string>(kind: Kind, name: string): StaticRef<Kind> {
    if (typeof kind !== 'string' || kind.length === 0) {
      fail('Domain declaration kind must be a non-empty string');
    }
    this.declareName(name);
    const state: DomainDeclarationState = {
      module: this.core,
      kind,
      name,
      ref: undefined as unknown as StaticRef<Kind>,
    };
    const ref = createDomainStaticRef<Kind>(state);
    state.ref = ref;
    this.core.domainDeclarations.push(state);
    return ref;
  }

  domainInstruction<
    const O extends readonly DomainOperandType[],
    const R extends readonly ScalarType[],
  >(name: string, definition: DomainInstructionDefinition<O, R>): DomainInstruction<O, R> {
    assertName(name, 'Instruction');
    if (this.core.instructionNames.has(name)) {
      fail(`Instruction "${name}" is already declared or reserved by the core`);
    }
    if (typeof definition !== 'object' || definition === null) {
      fail(`Instruction "${name}" requires a definition`);
    }
    if (!Array.isArray(definition.operands)) {
      fail(`Instruction "${name}" operands must be an array`);
    }
    const operands = Array.from(definition.operands, (operand, index) => {
      if (typeof operand !== 'object' || operand === null) {
        fail(`Instruction "${name}" operand ${index} must be a descriptor`);
      }
      switch (operand.kind) {
        case 'value':
          assertScalarType(operand.type, `Instruction "${name}" operand ${index} type`);
          return { kind: 'value' as const, type: operand.type };
        case 'static':
          if (typeof operand.category !== 'string' || operand.category.length === 0) {
            fail(`Instruction "${name}" operand ${index} static category must be non-empty`);
          }
          return { kind: 'static' as const, category: operand.category };
        case 'literal':
          return { kind: 'literal' as const };
        case 'value-list':
          assertScalarType(operand.type, `Instruction "${name}" operand ${index} type`);
          return {
            kind: 'value-list' as const,
            type: operand.type,
            ...listLength(operand.minLength, name, index),
          };
        case 'static-list':
          if (typeof operand.category !== 'string' || operand.category.length === 0) {
            fail(`Instruction "${name}" operand ${index} static category must be non-empty`);
          }
          return {
            kind: 'static-list' as const,
            category: operand.category,
            ...listLength(operand.minLength, name, index),
          };
        default:
          fail(`Instruction "${name}" operand ${index} has an unknown kind`);
      }
    });
    const results = assertScalarTypeList(definition.results, `Instruction "${name}" results`);
    const state: DomainInstructionState = {
      module: this.core,
      name,
      definition: {
        operands: operands as unknown as O,
        results: results as unknown as R,
      },
    };
    this.core.instructionNames.add(name);
    this.core.instructions.push(state);
    return createDomainInstructionRef(state) as DomainInstruction<O, R>;
  }

  private declareFunction(
    name: string,
    category: FunctionDeclarationState['category'],
    signature: FunctionSignature<readonly ScalarType[], readonly ScalarType[]>,
  ): FunctionDeclarationState {
    this.declareName(name);
    if (typeof signature !== 'object' || signature === null) {
      fail(`Function "${name}" requires a signature`);
    }
    const params = assertScalarTypeList(signature.params, `Function "${name}" params`);
    const results =
      category === 'function'
        ? assertScalarTypeList(signature.results, `Function "${name}" results`)
        : [];
    const declaration = {
      module: this.core,
      name,
      category,
      params,
      results,
      body: undefined,
      defining: false,
    } as FunctionDeclarationState;
    declaration.ref = createFunctionRef(declaration, (target, callback) =>
      defineFunctionBody(target, callback),
    );
    this.core.functions.push(declaration);
    return declaration;
  }

  private declareName(name: string): void {
    assertName(name, 'Declaration');
    if (this.core.providerDepth > 0) {
      throw new IRProviderError(
        'illegal-operation',
        `Declaration "${name}" is not allowed during provider generation`,
      );
    }
    if (this.core.names.has(name)) {
      fail(`Declaration "${name}" is already declared in this module`);
    }
    this.core.names.add(name);
  }
}

const PROVIDER_READ_CATEGORIES = new Set(['state', 'array', 'bytes', 'inbox']);
const PROVIDER_IMPORT_CATEGORIES = new Set([
  ...PROVIDER_READ_CATEGORIES,
  'function',
  'entry',
  'provider',
  'scalar-output',
  'bytes-output',
]);

function captureProviderRefs(
  module: ModuleState,
  values: unknown,
  label: string,
  categories: ReadonlySet<string>,
  trackedRead: boolean,
): readonly StaticRef[] {
  if (!Array.isArray(values)) {
    fail(`${label} must be an array`);
  }
  const seen = new Set<object>();
  return Object.freeze(
    Array.from(values, (value, index) => {
      if (typeof value !== 'object' || value === null) {
        fail(`${label}[${index}] must be a static reference`);
      }
      const ref = value as StaticRef;
      const kind = ref[refKind];
      if (typeof kind !== 'string' || !categories.has(kind)) {
        fail(`${label}[${index}] must be a ${[...categories].join(' or ')} reference`);
      }
      if (getRefModule(ref) !== module) {
        fail(`${label}[${index}] belongs to another module`);
      }
      if (seen.has(ref)) {
        fail(`${label}[${index}] is listed more than once`);
      }
      seen.add(ref);
      if (trackedRead && kind === 'bytes') {
        const memory = getMemoryMetadata(ref);
        if (memory === undefined || memory.definition.writable) {
          fail(
            `${label}[${index}] cannot track writable bytes; ordinary bytes.store does not advance versions`,
          );
        }
      }
      return ref;
    }),
  );
}

function assertPositiveCapacity(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(`${label} must be a positive safe integer`);
  }
}

function captureBuilderExtensions(
  options: IRModuleOptions | undefined,
): readonly BuilderExtensionState[] {
  if (options === undefined) {
    return Object.freeze([]);
  }
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    fail('IR module options must be an object');
  }
  const raw = options.builderExtensions;
  if (raw === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(raw)) {
    fail('IR module builderExtensions must be an array');
  }
  const namespaces = new Set<string>();
  const captured = raw.map((extension, index): BuilderExtensionState => {
    if (typeof extension !== 'object' || extension === null) {
      fail(`Builder extension ${index} must be an object`);
    }
    const namespace = extension.namespace;
    assertName(namespace, `Builder extension ${index}`);
    if (RESERVED_BUILDER_NAMES.has(namespace)) {
      fail(`Builder extension namespace "${namespace}" collides with a built-in builder member`);
    }
    if (namespaces.has(namespace)) {
      fail(`Builder extension namespace "${namespace}" is already registered`);
    }
    namespaces.add(namespace);
    const create = extension.create;
    assertSynchronousCallback(create, `Builder extension "${namespace}" create`);
    return Object.freeze({ namespace, receiver: extension, create });
  });
  return Object.freeze(captured);
}
