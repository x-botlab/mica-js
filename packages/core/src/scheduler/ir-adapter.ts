import { createIRInterpreter } from '@mica-js/ir';
import type {
  EntryRef,
  IRInstructionExecutor,
  IRModule,
  IRStorage,
  IRValidationOptions,
  LifecycleRef,
  RuntimeScalar,
} from '@mica-js/ir';
import { SchedulerError } from './errors';
import type {
  Scheduler,
  SchedulerExecutionContext,
  SchedulerInstance,
  SchedulerTarget,
} from './types';

export interface IRSchedulerInstanceDefinition {
  readonly instanceId: string;
  readonly module: IRModule;
  readonly validation: IRValidationOptions;
  /** Trusted domain instruction executors passed to the same reference interpreter. */
  readonly instructionExecutors?: readonly IRInstructionExecutor[];
}

export interface IRSchedulerInstance {
  readonly instance: SchedulerInstance;
  readonly storage: IRStorage;
  at(target: EntryRef, deadline: number, args: readonly RuntimeScalar[]): number;
  cancel(id: number): void;
  enqueueControl(target: LifecycleRef, args: readonly RuntimeScalar[]): void;
}

const unknownTarget: SchedulerTarget = Object.freeze({
  name: 'unregistered',
  kind: 'event',
  params: [],
});

export function createIRSchedulerInstance(
  scheduler: Scheduler,
  definition: IRSchedulerInstanceDefinition,
): IRSchedulerInstance {
  if (definition === null || typeof definition !== 'object') {
    throw new SchedulerError('invalid-instance', 'Expected IR instance definition', {
      timePs: scheduler.now,
    });
  }
  const { instanceId, module, validation, instructionExecutors } = definition;
  const captured = {
    memories: module.memories,
    functions: module.functions,
    domainDeclarations: module.domainDeclarations,
    instructions: module.instructions,
  } as IRModule;
  const targets = new Map<EntryRef | LifecycleRef, SchedulerTarget>();
  const entries = new Map<string, EntryRef | LifecycleRef>();
  for (const fn of captured.functions) {
    if (fn.category !== 'entry' && fn.category !== 'lifecycle') continue;
    const target: SchedulerTarget = Object.freeze({
      name: fn.name,
      kind: fn.category === 'entry' ? 'event' : 'control',
      params: Object.freeze([...fn.params]),
    });
    targets.set(fn.ref as EntryRef | LifecycleRef, target);
    entries.set(fn.name, fn.ref as EntryRef | LifecycleRef);
  }
  let active: SchedulerExecutionContext | undefined;
  const context = (): SchedulerExecutionContext => {
    if (active === undefined) {
      throw new SchedulerError(
        'executor-contract',
        'IR kernel bridge requires an active scheduler entry',
        { timePs: scheduler.now },
      );
    }
    return active;
  };
  const interpreter = createIRInterpreter(captured, {
    validation,
    maxSteps: Number.MAX_SAFE_INTEGER,
    ...(instructionExecutors === undefined ? {} : { instructionExecutors }),
    eventHost: {
      now: () => context().timePs,
      at: (target, deadline, args) => {
        context();
        return instance.at(targets.get(target) ?? unknownTarget, deadline, args);
      },
      cancel: (id) => {
        context();
        instance.cancel(id);
      },
    },
    stepObserver: { beforeStep: () => context().consumeSteps() },
  });
  const instance = scheduler.addInstance({
    instanceId,
    targets: [...targets.values()],
    executor: {
      execute(target, args, executionContext) {
        active = executionContext;
        try {
          interpreter.execute(entries.get(target.name)!, args, {
            instanceId: executionContext.instanceId,
            virtualTime: executionContext.timePs,
          });
        } finally {
          active = undefined;
        }
      },
    },
  });
  return Object.freeze({
    instance,
    storage: interpreter.storage,
    at: (target: EntryRef, deadline: number, args: readonly RuntimeScalar[]) =>
      instance.at(targets.get(target) ?? unknownTarget, deadline, args),
    cancel: (id: number) => instance.cancel(id),
    enqueueControl: (target: LifecycleRef, args: readonly RuntimeScalar[]) =>
      scheduler.enqueueControl(instance, targets.get(target) ?? unknownTarget, args),
  });
}
