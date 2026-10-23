// Compile-only public validation contract checks; run by the package typecheck.
import {
  validateIR,
  type DomainDeclaration,
  type FunctionDefinition,
  type IRDiagnostic,
  type IRDiagnosticCode,
  type IRDiagnosticLocation,
  type IRInstructionValidationContext,
  type IRInstructionValidator,
  type IRModule,
  type IRResourcePermission,
  type IRValidationOptions,
  type IRValidationResult,
  type StaticRef,
} from './index';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

function expectType<T>(value: T): void {
  void value;
}

type ValidationSignature = Assert<
  Equal<typeof validateIR, (input: unknown, options: IRValidationOptions) => IRValidationResult>
>;
type DiagnosticCodes = Assert<
  Equal<
    IRDiagnosticCode,
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
    | 'provider-import-violation'
    | 'invalid-checkpoint'
  >
>;
declare const checkedSignature: ValidationSignature;
declare const checkedCodes: DiagnosticCodes;
expectType<true>(checkedSignature);
expectType<true>(checkedCodes);

declare const input: unknown;
declare const module: IRModule;
declare const domain: StaticRef<'led'>;
declare const configuration: IRValidationOptions;
declare const result: IRValidationResult;
declare const diagnostic: IRDiagnostic;
declare const location: IRDiagnosticLocation;
declare const context: IRInstructionValidationContext;
declare const definition: FunctionDefinition;
declare const declaration: DomainDeclaration;

const immutableConfiguration = {
  supportedInstructions: ['led.set', 'return'],
  authorizedInstructions: ['led.set', 'return'],
  resources: [{ ref: domain, access: 'write' }],
  validators: [
    {
      op: 'led.set',
      validate(current) {
        expectType<IRInstructionValidationContext>(current);
        expectType<readonly IRResourcePermission[]>(current.resources);
        expectType<
          Pick<IRModule, 'memories' | 'functions' | 'domainDeclarations' | 'instructions'>
        >(current.module);
        expectType<FunctionDefinition>(current.fn);
        expectType<IRDiagnosticLocation>(current.location);
        return ['backend declined'] as const;
      },
    },
  ],
} as const satisfies IRValidationOptions;
expectType<IRValidationResult>(validateIR(input, immutableConfiguration));
expectType<IRValidationResult>(validateIR(module, configuration));
expectType<IRValidationResult>(validateIR(null, configuration));
expectType<IRValidationResult>(validateIR({ unrelated: true }, configuration));
expectType<boolean>(result.ok);
expectType<readonly IRDiagnostic[]>(result.diagnostics);
expectType<IRDiagnosticCode>(diagnostic.code);
expectType<string>(diagnostic.message);
expectType<string>(diagnostic.location.path);
expectType<number | undefined>(location.functionIndex);
expectType<string | undefined>(location.functionName);
expectType<number | undefined>(location.blockIndex);
expectType<number | undefined>(location.blockId);
expectType<number | undefined>(location.instructionIndex);
expectType<true | undefined>(location.terminator);
expectType<StaticRef>(definition.ref);
expectType<StaticRef>(declaration.ref);
expectType<readonly string[]>(immutableConfiguration.validators[0].validate(context));

// @ts-expect-error Options are mandatory, with no implicit backend or permissions.
validateIR(input);
// @ts-expect-error Backend support is mandatory.
validateIR(input, { authorizedInstructions: [], resources: [] });
// @ts-expect-error Instruction authorization is mandatory.
validateIR(input, { supportedInstructions: [], resources: [] });
// @ts-expect-error Resource grants are mandatory even when the list is empty.
validateIR(input, { supportedInstructions: [], authorizedInstructions: [] });
const invalidNames: IRValidationOptions = {
  // @ts-expect-error Instruction names are strings, not instruction objects.
  supportedInstructions: [1],
  authorizedInstructions: [],
  resources: [],
};
void invalidNames;
// @ts-expect-error Grants only permit read, write, or read-write.
const invalidAccess: IRResourcePermission = { ref: domain, access: 'execute' };
void invalidAccess;
// @ts-expect-error Grants require static handles, not arbitrary names.
const invalidReference: IRResourcePermission = { ref: 'status', access: 'read' };
void invalidReference;
// @ts-expect-error Extension validators return messages, not a boolean.
const booleanValidator: IRInstructionValidator = { op: 'led.set', validate: () => true };
void booleanValidator;
// @ts-expect-error Extension validators are synchronous.
const asyncValidator: IRInstructionValidator = { op: 'led.set', validate: async () => [] };
void asyncValidator;
// @ts-expect-error Extension validators may not return non-string diagnostics.
const invalidMessages: IRInstructionValidator = { op: 'led.set', validate: () => [1] };
void invalidMessages;
// @ts-expect-error Extensions identify operations explicitly.
const unnamedValidator: IRInstructionValidator = { validate: () => [] };
void unnamedValidator;
// @ts-expect-error Diagnostic codes are a closed union.
const invalidCode: IRDiagnosticCode = 'unknown-error';
void invalidCode;
// @ts-expect-error The terminator marker is true or absent, not a general boolean.
const invalidLocation: IRDiagnosticLocation = { path: '$', terminator: false };
void invalidLocation;

// Results, diagnostics, configuration, and the extension context expose readonly data.
// @ts-expect-error The result status is readonly.
result.ok = true;
// @ts-expect-error The diagnostic collection is readonly.
result.diagnostics.push(diagnostic);
// @ts-expect-error Diagnostic codes are readonly.
diagnostic.code = 'malformed-input';
// @ts-expect-error Diagnostic messages are readonly.
diagnostic.message = 'changed';
// @ts-expect-error Diagnostic locations are readonly.
diagnostic.location = { path: 'changed' };
// @ts-expect-error Nested diagnostic locations are readonly.
diagnostic.location.path = 'changed';
// @ts-expect-error Configuration arrays are readonly.
configuration.supportedInstructions.push('new.op');
// @ts-expect-error Resource grants are readonly.
configuration.resources.push({ ref: domain, access: 'read' });
// @ts-expect-error Grant entries are readonly.
context.resources[0]!.access = 'write';
// @ts-expect-error The context module property is readonly.
context.module = module;
// @ts-expect-error The module model only exposes readonly function collections.
context.module.functions.push(definition);
// @ts-expect-error The context function property is readonly.
context.fn = definition;
// @ts-expect-error Function bodies are readonly.
context.fn.body = undefined;
// @ts-expect-error Instruction operand arrays are readonly.
context.instruction.operands.push({ kind: 'static', ref: domain });
// @ts-expect-error Block instruction collections are readonly.
context.block.instructions.push(context.instruction);
// @ts-expect-error Context locations are readonly.
context.location.path = 'changed';
// @ts-expect-error Context resource collections are readonly.
context.resources = [];
// @ts-expect-error Function reference identities are readonly.
definition.ref = context.fn.ref;
// @ts-expect-error Domain reference identities are readonly.
declaration.ref = domain;
