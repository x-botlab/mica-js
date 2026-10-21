export type SchedulerErrorCode =
  | 'invalid-options'
  | 'invalid-instance'
  | 'invalid-target'
  | 'invalid-argument'
  | 'invalid-event-id'
  | 'event-id-exhausted'
  | 'reentrant-execution'
  | 'executor-contract'
  | 'entry-budget-exhausted'
  | 'time-budget-exhausted'
  | 'execution-failed'
  | 'scheduler-faulted';

interface Details {
  readonly instanceId?: string;
  readonly targetName?: string;
  readonly timePs: number;
  readonly phase?: 'event' | 'control';
  readonly eventId?: number;
  readonly steps?: number;
  readonly entriesAtTime?: number;
  readonly cause?: unknown;
}

export class SchedulerError extends Error {
  override readonly name = 'SchedulerError';
  readonly instanceId: string | undefined;
  readonly targetName: string | undefined;
  readonly timePs: number;
  readonly phase: 'event' | 'control' | undefined;
  readonly eventId: number | undefined;
  readonly steps: number;
  readonly entriesAtTime: number;
  override readonly cause: unknown;

  constructor(
    readonly code: SchedulerErrorCode,
    message: string,
    details: Details,
  ) {
    super(message, { cause: details.cause });
    this.instanceId = details.instanceId;
    this.targetName = details.targetName;
    this.timePs = details.timePs;
    this.phase = details.phase;
    this.eventId = details.eventId;
    this.steps = details.steps ?? 0;
    this.entriesAtTime = details.entriesAtTime ?? 0;
    this.cause = details.cause;
  }
}
