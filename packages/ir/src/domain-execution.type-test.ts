import {
  createIRInterpreter,
  createIRModule,
  type IRBuilderExtension,
  type IRInstructionExecutor,
  type IRInstructionExecutorContext,
  type IRInterpreterOptions,
  type IRModuleOptions,
  type IRValidationOptions,
  type RuntimeScalar,
} from './index';

declare const validation: IRValidationOptions;

const extension: IRBuilderExtension = {
  namespace: 'pin',
  create: (builder) => ({
    sample: () => builder.const('u32', 1),
  }),
};
const moduleOptions: IRModuleOptions = { builderExtensions: [extension] };
const module = createIRModule(moduleOptions);

const executor: IRInstructionExecutor = {
  op: 'pin.sample',
  execute: (context: IRInstructionExecutorContext): readonly RuntimeScalar[] => context.operands,
};
const options: IRInterpreterOptions = {
  validation,
  instructionExecutors: [executor],
};
createIRInterpreter(module, options);

// @ts-expect-error a builder extension namespace is required
const missingNamespace: IRBuilderExtension = { create: () => ({}) };
// @ts-expect-error create must return a namespace object
const invalidCreate: IRBuilderExtension = { namespace: 'pin', create: () => 1 };
// @ts-expect-error an executor must return scalar results
const invalidExecutor: IRInstructionExecutor = { op: 'pin.sample', execute: () => 'nope' };
// @ts-expect-error instructionExecutors accepts only executors
createIRInterpreter(module, { validation, instructionExecutors: [{}] });
void [missingNamespace, invalidCreate, invalidExecutor];
