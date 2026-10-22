import type {
  Scheduler,
  SchedulerInstance,
  SchedulerInstanceDefinition,
  SchedulerRunOptions,
  SchedulerRunResult,
  SchedulerTarget,
} from '@mica-js/core';
import type { RuntimeScalar } from '@mica-js/ir';

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
            Reflect.apply(definition.executor.execute, definition.executor, [
              target,
              args,
              context,
            ]);
            if (target.name === initializeName) {
              initialized = true;
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
