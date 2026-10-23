import { createIRInterpreter, createIRJIT } from '@mica-js/ir';
import type {
  EntryRef,
  IRBridgeHost,
  IRInstructionExecutor,
  IRModule,
  IRStepBudget,
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
  readonly bridge?: IRBridgeHost;
  /** Trusted synchronous executors for declared domain instructions. */
  readonly executors?: readonly IRInstructionExecutor[];
  /** IR 执行引擎。默认 'jit'；'reference' 使用参考解释器（用于调试或对照）。 */
  readonly engine?: 'jit' | 'reference';
}

export interface IRSchedulerInstance {
  readonly instance: SchedulerInstance;
  readonly storage: IRStorage;
  at(target: EntryRef, deadline: number, args: readonly RuntimeScalar[]): number;
  cancel(id: number): void;
  enqueueControl(target: LifecycleRef, args: readonly RuntimeScalar[]): void;
  enqueueMessage(target: EntryRef, args: readonly RuntimeScalar[]): number;
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
  const { instanceId, module, validation, executors } = definition;
  const engine = definition.engine;
  if (engine !== undefined && engine !== 'jit' && engine !== 'reference') {
    throw new SchedulerError('invalid-instance', 'IR engine must be "jit" or "reference"', {
      timePs: scheduler.now,
    });
  }
  const captured = {
    memories: module.memories,
    functions: module.functions,
    providers: module.providers ?? [],
    domainDeclarations: module.domainDeclarations,
    instructions: module.instructions,
    outputs: module.outputs,
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
  // The scheduler's per-entry counters satisfy the `@mica-js/ir` step-budget protocol:
  // - H1: `consumeSteps(n)` is all-or-nothing, while the JIT only batches steps that already
  //   ran (`n` never exceeds the last `remainingSteps` it read) or consumes one step at a
  //   time, so the batch/serial difference is never observable;
  // - H2: `remainingSteps` is exactly `maxSteps - steps` and never over-reports;
  // - H3: both methods only adjust that counter behind `#boundary`; neither touches IR
  //   storage nor re-enters execution;
  // - H4: the scheduler rejects re-entrant execution, so one entry has one consumer.
  const stepBudget: IRStepBudget = {
    remaining: () => context().remainingSteps,
    consume: (_ctx, count) => context().consumeSteps(count),
  };
  const create = engine === 'reference' ? createIRInterpreter : createIRJIT;
  const interpreter = create(captured, {
    validation,
    maxSteps: Number.MAX_SAFE_INTEGER,
    ...(definition.bridge === undefined ? {} : { bridge: definition.bridge }),
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
    stepBudget,
    ...(executors === undefined ? {} : { executors }),
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
    enqueueMessage: (target: EntryRef, args: readonly RuntimeScalar[]) =>
      scheduler.enqueueMessage(instance, targets.get(target) ?? unknownTarget, args),
  });
}
