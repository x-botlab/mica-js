export const MICA_CORE_VERSION = '0.0.0';

export { MAX_TIME_PS, timePs, toTimePs, addTime, subtractTime } from './time';
export type { TimePs, TimeUnit } from './time';
export { createScheduler } from './scheduler';
export { createIRSchedulerInstance } from './ir-adapter';
export type { IRSchedulerInstance, IRSchedulerInstanceDefinition } from './ir-adapter';
export { SchedulerError } from './scheduler-error';
export type { SchedulerErrorCode } from './scheduler-error';
export type {
  Scheduler,
  SchedulerExecutionContext,
  SchedulerExecutor,
  SchedulerInstance,
  SchedulerInstanceDefinition,
  SchedulerOptions,
  SchedulerRunOptions,
  SchedulerRunResult,
  SchedulerTarget,
} from './scheduler-types';
