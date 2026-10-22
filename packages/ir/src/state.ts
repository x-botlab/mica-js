import type {
  BlockDefinition,
  DomainInstructionDefinition,
  FunctionBodyDefinition,
  FunctionBuilder,
  FunctionCategory,
  FunctionDefinition,
  FunctionRef,
  IRBuilderExtension,
  InstructionNode,
  MemoryDefinition,
  ScalarType,
  StaticRef,
  Terminator,
  Value,
} from './types';

/** Captured builder extension; method identity and receiver are fixed at module creation. */
export interface BuilderExtensionState {
  readonly namespace: string;
  readonly receiver: IRBuilderExtension;
  readonly create: (builder: FunctionBuilder) => unknown;
}

export interface ModuleState {
  readonly memories: MemoryState[];
  readonly functions: FunctionDeclarationState[];
  readonly domainDeclarations: DomainDeclarationState[];
  readonly instructions: DomainInstructionState[];
  readonly builderExtensions: readonly BuilderExtensionState[];
  readonly names: Set<string>;
  readonly instructionNames: Set<string>;
  bodyDepth: number;
}

export interface MemoryState {
  readonly module: ModuleState;
  definition: MemoryDefinition;
}

export interface FunctionDeclarationState {
  readonly module: ModuleState;
  readonly name: string;
  readonly category: FunctionCategory;
  readonly params: readonly ScalarType[];
  readonly results: readonly ScalarType[];
  ref: FunctionRef;
  body: FunctionBodyDefinition | undefined;
  defining: boolean;
}

export interface DomainDeclarationState {
  readonly module: ModuleState;
  readonly kind: string;
  readonly name: string;
  ref: StaticRef;
}

export interface DomainInstructionState {
  readonly module: ModuleState;
  readonly name: string;
  readonly definition: DomainInstructionDefinition;
}

export interface BuilderState {
  readonly module: ModuleState;
  readonly declaration: FunctionDeclarationState;
  readonly entry: BlockState;
  readonly blocks: BlockState[];
  readonly insertion: BlockState[];
  valueSeq: number;
  blockSeq: number;
  finished: boolean;
  invalidated: boolean;
}

export class BlockState implements BlockDefinition {
  readonly id: number;
  readonly paramTypes: readonly ScalarType[];
  readonly owner: BuilderState;
  params: Value[] = [];
  instructions: InstructionNode[] = [];
  terminator: Terminator | undefined = undefined;
  defined = false;
  defining = false;

  constructor(owner: BuilderState, id: number, paramTypes: readonly ScalarType[]) {
    this.owner = owner;
    this.id = id;
    this.paramTypes = paramTypes;
  }
}

export function toFunctionDefinition(state: FunctionDeclarationState): FunctionDefinition {
  return {
    ref: state.ref,
    name: state.name,
    category: state.category,
    params: state.params,
    results: state.results,
    body: state.body,
  };
}
