import type {
  Scheduler,
  SchedulerExecutionContext,
  SchedulerInstance,
  SchedulerInstanceDefinition,
  SchedulerRunOptions,
  SchedulerRunResult,
  SchedulerTarget,
} from '@mica-js/core';
import type { RuntimeScalar } from '@mica-js/ir';

export interface LifecycleEntryHooks {
  beforeEntry(context: SchedulerExecutionContext): void;
  afterEntry(context: SchedulerExecutionContext, failure: unknown): void;
  onInitializeComplete(): void;
}

export interface LifecycleScheduler {
  readonly scheduler: Scheduler;
  isInitialized(): boolean;
}

/**
 * Wraps the real scheduler only to observe successful completion of the bound initialize entry.
 * All scheduling, ordering, budgets, IDs and destruction remain the existing core scheduler's.
 */
export function createLifecycleScheduler(
  inner: Scheduler,
  initializeName: string | undefined,
  hooks?: LifecycleEntryHooks,
): LifecycleScheduler {
  let initialized = initializeName === undefined;
  const scheduler: Scheduler = {
    get now() {
      return inner.now;
    },
    get state() {
      return inner.state;
    },
    get error() {
      return inner.error;
    },
    addInstance(definition: SchedulerInstanceDefinition): SchedulerInstance {
      return inner.addInstance({
        instanceId: definition.instanceId,
        targets: definition.targets,
        executor: {
          execute(
            target: SchedulerTarget,
            args: readonly RuntimeScalar[],
            context: Parameters<SchedulerInstanceDefinition['executor']['execute']>[2],
          ): void {
            let failure: unknown;
            try {
              hooks?.beforeEntry(context);
              Reflect.apply(definition.executor.execute, definition.executor, [
                target,
                args,
                context,
              ]);
              if (target.name === initializeName) {
                initialized = true;
                hooks?.onInitializeComplete();
              }
            } catch (cause) {
              failure = cause;
            }
            try {
              hooks?.afterEntry(context, failure);
            } catch (cause) {
              failure ??= cause;
            }
            if (failure !== undefined) {
              throw failure;
            }
          },
        },
      });
    },
    enqueueControl(
      instance: SchedulerInstance,
      target: SchedulerTarget,
      args: readonly RuntimeScalar[],
    ): void {
      inner.enqueueControl(instance, target, args);
    },
    enqueueMessage(
      instance: SchedulerInstance,
      target: SchedulerTarget,
      args: readonly RuntimeScalar[],
    ): number {
      return inner.enqueueMessage(instance, target, args);
    },
    destroyInstance(instance: SchedulerInstance): void {
      inner.destroyInstance(instance);
    },
    start(options?: SchedulerRunOptions): SchedulerRunResult {
      return options === undefined ? inner.start() : inner.start(options);
    },
    pause(): void {
      inner.pause();
    },
    step(): SchedulerRunResult {
      return inner.step();
    },
  };
  return {
    scheduler,
    isInitialized: () => initialized,
  };
}
