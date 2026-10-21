import {
  createIRInterpreter,
  IRExecutionError,
  type EntryRef,
  type FunctionRef,
  type IRExecutionContext,
  type IRExecutionErrorCode,
  type IRExecutionErrorDetails,
  type IRExecutionLocation,
  type IRExecutionResult,
  type IRInterpreter,
  type IRInterpreterOptions,
  type IRModule,
  type IRStorage,
  type IRValidationOptions,
  type LifecycleRef,
  type RuntimeScalar,
  type StateRef,
} from './index';

declare const module: IRModule;
declare const validation: IRValidationOptions;
declare const fn: FunctionRef;
declare const entry: EntryRef;
declare const lifecycle: LifecycleRef;
declare const state: StateRef;
declare const location: IRExecutionLocation;

const options: IRInterpreterOptions = { validation, maxSteps: 0 };
const runtime: IRInterpreter = createIRInterpreter(module, options);
const context: IRExecutionContext = { instanceId: 'test', virtualTime: 0 };
const args: readonly RuntimeScalar[] = [true, 7, { type: 'f32', bits: '0x7fa12345' }];
const results: readonly IRExecutionResult[] = [
  runtime.execute(fn, args, context),
  runtime.execute(entry, [], context),
  runtime.execute(lifecycle, [], context),
];
const storage: IRStorage = runtime.storage;
const scalars: readonly RuntimeScalar[] = results[0]!.values;
const steps: number = results[0]!.steps;
const details: IRExecutionErrorDetails = {
  context,
  location,
  callStack: [location],
  steps,
  diagnostics: [],
  cause: new Error('cause'),
};
const error = new IRExecutionError('evaluation-failed', 'failed', details);
const code: IRExecutionErrorCode = error.code;
const cause: unknown = error.cause;
void [storage, scalars, code, cause];

// @ts-expect-error explicit validation policy is mandatory
createIRInterpreter(module, {});
// @ts-expect-error storage injection is not part of the interpreter contract
createIRInterpreter(module, { validation, storage });
// @ts-expect-error execution context is mandatory
runtime.execute(fn, []);
// @ts-expect-error resource handles are not executable targets
runtime.execute(state, [], context);
// @ts-expect-error bigint is not a runtime scalar
runtime.execute(fn, [1n], context);
// @ts-expect-error FloatBits only represents f32/f64, not integer bits
runtime.execute(fn, [{ type: 'u32', bits: '0x00000001' }], context);
// @ts-expect-error results are readonly
results[0]!.values.push(1);
// @ts-expect-error storage identity is readonly
runtime.storage = storage;
// @ts-expect-error no resume/reset contract
runtime.reset();
// @ts-expect-error existing evaluator error codes are not interpreter error codes
new IRExecutionError('division-by-zero', 'failed');
// @ts-expect-error call stack locations are readonly
error.callStack.push(location);
// @ts-expect-error cause is a readonly interpreter diagnostic
error.cause = undefined;
