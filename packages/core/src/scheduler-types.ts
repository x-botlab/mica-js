import type { RuntimeScalar, ScalarType } from '@mica-js/ir';
import type { SchedulerError } from './scheduler-error';
import type { TimePs } from './time';

export interface SchedulerTarget {
  readonly name: string;
  readonly kind: 'event' | 'control';
  readonly params: readonly ScalarType[];
}

export interface SchedulerExecutionContext {
  readonly instanceId: string;
  readonly timePs: TimePs;
  readonly phase: 'event' | 'control';
  readonly eventId: number;
  readonly remainingSteps: number;
  consumeSteps(count?: number): void;
}

export interface SchedulerExecutor {
  execute(
    target: SchedulerTarget,
    args: readonly RuntimeScalar[],
    context: SchedulerExecutionContext,
  ): void;
}

export interface SchedulerInstanceDefinition {
  readonly instanceId: string;
  readonly targets: readonly SchedulerTarget[];
  readonly executor: SchedulerExecutor;
}

export interface SchedulerInstance {
  readonly instanceId: string;
  at(target: SchedulerTarget, deadline: number, args: readonly RuntimeScalar[]): number;
  cancel(id: number): void;
}

export interface SchedulerOptions {
  readonly maxStepsPerEntry?: number;
  readonly maxEntriesPerTime?: number;
}

export interface SchedulerRunOptions {
  readonly until?: number;
  readonly maxEntries?: number;
}

export interface SchedulerRunResult {
  readonly timePs: TimePs;
  readonly executed: number;
  readonly reason: 'empty' | 'until' | 'entry-limit' | 'paused';
}

export interface Scheduler {
  readonly now: TimePs;
  readonly state: 'paused' | 'running' | 'faulted';
  readonly error: SchedulerError | undefined;
  addInstance(definition: SchedulerInstanceDefinition): SchedulerInstance;
  enqueueControl(
    instance: SchedulerInstance,
    target: SchedulerTarget,
    args: readonly RuntimeScalar[],
  ): void;
  destroyInstance(instance: SchedulerInstance): void;
  start(options?: SchedulerRunOptions): SchedulerRunResult;
  pause(): void;
  step(): SchedulerRunResult;
}
