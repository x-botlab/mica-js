import { defineFunctionBody, CORE_INSTRUCTION_NAMES } from './builder';
import { fail } from './errors';
import type {
  ArrayRef,
  BytesOptions,
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
  InboxRef,
  IRModule,
  JSScalar,
  LifecycleRef,
  MemoryDefinition,
  ScalarType,
  StateRef,
  StaticRef,
} from './types';
import type {
  DomainDeclarationState,
  DomainInstructionState,
  FunctionDeclarationState,
  MemoryState,
  ModuleState,
} from './state';
import { toFunctionDefinition } from './state';
import {
  assertCapacity,
  assertName,
  assertScalarType,
  assertScalarTypeList,
  createArrayRef,
  createBytesRef,
  createDomainInstructionRef,
  createDomainStaticRef,
  createFunctionRef,
  createInboxRef,
  createStateRef,
  normalizeScalarLiteral,
} from './runtime';

export function createIRModule(): IRModule {
  return new IRModuleImpl();
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

  constructor() {
    this.core = {
      memories: [],
      functions: [],
      domainDeclarations: [],
      instructions: [],
      names: new Set(),
      instructionNames: new Set(CORE_INSTRUCTION_NAMES),
      bodyDepth: 0,
    };
  }

  get memories(): readonly MemoryDefinition[] {
    return this.core.memories.map((memory) => memory.definition);
  }

  get functions(): readonly FunctionDefinition[] {
    return this.core.functions.map((declaration) => toFunctionDefinition(declaration));
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
    if (this.core.names.has(name)) {
      fail(`Declaration "${name}" is already declared in this module`);
    }
    this.core.names.add(name);
  }
}
