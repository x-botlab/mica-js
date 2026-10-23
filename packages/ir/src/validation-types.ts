import type {
  BlockDefinition,
  FunctionDefinition,
  InstructionNode,
  IRModule,
  StaticRef,
} from './types';

export type IRDiagnosticCode =
  | 'malformed-input'
  | 'type-mismatch'
  | 'invalid-static-reference'
  | 'duplicate-definition'
  | 'ssa-undefined'
  | 'ssa-dominance'
  | 'invalid-block'
  | 'invalid-terminator'
  | 'signature-mismatch'
  | 'invalid-call-target'
  | 'recursive-call'
  | 'invalid-resource'
  | 'unauthorized-resource'
  | 'unauthorized-instruction'
  | 'unknown-instruction'
  | 'unsupported-instruction'
  | 'domain-validation'
  | 'extension-error'
  | 'invalid-provider'
  | 'provider-key-mismatch'
  | 'unsupported-provider'
  | 'provider-import-violation';

export interface IRDiagnosticLocation {
  readonly path: string;
  readonly functionIndex?: number;
  readonly functionName?: string;
  readonly blockIndex?: number;
  readonly blockId?: number;
  readonly instructionIndex?: number;
  readonly terminator?: true;
}

export interface IRDiagnostic {
  readonly code: IRDiagnosticCode;
  readonly message: string;
  readonly location: IRDiagnosticLocation;
}

export interface IRValidationResult {
  readonly ok: boolean;
  readonly diagnostics: readonly IRDiagnostic[];
}

export interface IRResourcePermission {
  readonly ref: StaticRef;
  readonly access: 'read' | 'write' | 'read-write' | 'update';
}

export interface IRInstructionValidationContext {
  readonly module: Pick<IRModule, 'memories' | 'functions' | 'domainDeclarations' | 'instructions'>;
  readonly fn: FunctionDefinition;
  readonly block: BlockDefinition;
  readonly instruction: InstructionNode;
  readonly location: IRDiagnosticLocation;
  readonly resources: readonly IRResourcePermission[];
}

export interface IRInstructionValidator {
  readonly op: string;
  validate(context: IRInstructionValidationContext): readonly string[];
}

export interface IRValidationOptions {
  readonly supportedInstructions: readonly string[];
  readonly authorizedInstructions: readonly string[];
  readonly resources: readonly IRResourcePermission[];
  readonly validators?: readonly IRInstructionValidator[];
}
