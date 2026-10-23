import type {
  BlockDefinition,
  DeclaredInstruction,
  DomainDeclaration,
  FunctionDefinition,
  InstructionNode,
  IRModule,
  MemoryDefinition,
  OutputDefinition,
  ProviderDefinition,
} from './types';
import type {
  IRDiagnosticCode,
  IRDiagnosticLocation,
  IRInstructionValidator,
  IRValidationOptions,
} from './validation-types';

export type ModuleModel = Pick<
  IRModule,
  'memories' | 'functions' | 'domainDeclarations' | 'instructions'
> & {
  readonly outputs?: readonly OutputDefinition[];
  readonly providers?: readonly ProviderDefinition[];
};

export interface InstructionValidationState {
  readonly module: ModuleModel;
  readonly fn: FunctionDefinition;
  readonly block: BlockDefinition;
  readonly location: IRDiagnosticLocation;
  readonly options: IRValidationOptions;
  readonly memories: ReadonlyMap<object, MemoryDefinition>;
  readonly functions: ReadonlyMap<object, FunctionDefinition>;
  readonly domains: ReadonlyMap<object, DomainDeclaration>;
  readonly outputs: ReadonlyMap<object, OutputDefinition>;
  readonly declarations: ReadonlyMap<string, DeclaredInstruction>;
  readonly validators: ReadonlyMap<string, IRInstructionValidator>;
  readonly providers: ReadonlyMap<object, ProviderDefinition>;
  /** Set when validating a provider artifact; every static reference must be imported. */
  readonly imports?: ReadonlySet<object>;
  report(code: IRDiagnosticCode, message: string): void;
  call(target: FunctionDefinition, instruction: InstructionNode): void;
}

export function isReservedOperation(op: string): boolean {
  if (op === 'resource.update_bytes' || op === 'resource.fill_bytes') return false;
  return /^(?:(?:kernel|provider|checkpoint|dispatch)(?:[._-]|$)|resource[._-](?:update|fill))/i.test(
    op,
  );
}

export function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
