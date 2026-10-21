import type { RuntimeScalar } from '@mica-js/ir';
import { SchedulerError } from './scheduler-error';
import type { SchedulerErrorCode } from './scheduler-error';
import { EventIdPool, MinHeap } from './scheduler-queue';
import { captureArgs, returnedSynchronously, scalarType, synchronous } from './scheduler-values';
import type {
  Scheduler,
  SchedulerExecutionContext,
  SchedulerInstance,
  SchedulerInstanceDefinition,
  SchedulerOptions,
  SchedulerRunOptions,
  SchedulerRunResult,
  SchedulerTarget,
} from './scheduler-types';
import { MAX_TIME_PS, timePs } from './time';
import type { TimePs } from './time';

interface InstanceState {
  readonly handle: SchedulerInstance;
  readonly targets: ReadonlyMap<SchedulerTarget, SchedulerTarget>;
  readonly execute: SchedulerInstanceDefinition['executor']['execute'];
  readonly receiver: SchedulerInstanceDefinition['executor'];
  readonly ids: EventIdPool;
  readonly active: Map<number, Work>;
  destroyRequested: boolean;
  destroyed: boolean;
}

interface Work {
  readonly instance: InstanceState;
  readonly target: SchedulerTarget;
  readonly args: readonly RuntimeScalar[];
  readonly time: TimePs;
  readonly round: bigint;
  readonly sequence: bigint;
  readonly id: number;
  status: 'pending' | 'running' | 'cancelled' | 'completed' | 'failed';
}

function compare(left: Work, right: Work): number {
  if (left.time !== right.time) return left.time < right.time ? -1 : 1;
  if (left.target.kind !== right.target.kind) return left.target.kind === 'control' ? -1 : 1;
  if (left.round !== right.round) return left.round < right.round ? -1 : 1;
  return left.sequence < right.sequence ? -1 : left.sequence === right.sequence ? 0 : 1;
}

function limit(value: number | undefined, fallback: number, name: string): number {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new SchedulerError(
      'invalid-options',
      `${name}=${String(result)} must be a non-negative safe integer`,
      { timePs: 0 },
    );
  }
  return result;
}

export function createScheduler(options: SchedulerOptions = {}): Scheduler {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new SchedulerError('invalid-options', 'Expected scheduler options', { timePs: 0 });
  }
  return new DeterministicScheduler(
    limit(options.maxStepsPerEntry, 1_000_000, 'maxStepsPerEntry'),
    limit(options.maxEntriesPerTime, 1_000_000, 'maxEntriesPerTime'),
  );
}

class DeterministicScheduler implements Scheduler {
  readonly #queue = new MinHeap<Work>(compare);
  readonly #instances = new Map<SchedulerInstance, InstanceState>();
  readonly #identities = new Set<string>();
  readonly #destruction = new Set<InstanceState>();
  readonly #maxSteps: number;
  readonly #maxEntries: number;
  #now = timePs(0);
  #state: Scheduler['state'] = 'paused';
  #error: SchedulerError | undefined;
  #sequence = 0n;
  #ordinaryRound = 0n;
  #controlRound = 0n;
  #ordinaryStarted = false;
  #controlStarted = false;
  #entries = 0;
  #steps = 0;
  #current: Work | undefined;
  #pauseRequested = false;

  constructor(maxSteps: number, maxEntries: number) {
    this.#maxSteps = maxSteps;
    this.#maxEntries = maxEntries;
    Object.freeze(this);
  }

  get now(): TimePs {
    return this.#now;
  }
  get state(): Scheduler['state'] {
    return this.#state;
  }
  get error(): SchedulerError | undefined {
    return this.#error;
  }

  addInstance(definition: SchedulerInstanceDefinition): SchedulerInstance {
    return this.#boundary(() => {
      if (definition === null || typeof definition !== 'object') {
        throw this.#problem('invalid-instance', 'Expected instance definition');
      }
      const { instanceId, targets, executor } = definition;
      if (
        typeof instanceId !== 'string' ||
        instanceId.length === 0 ||
        this.#identities.has(instanceId)
      ) {
        throw this.#problem(
          'invalid-instance',
          `instanceId=${String(instanceId)} must be nonempty and never reused`,
        );
      }
      if (!Array.isArray(targets))
        throw this.#problem('invalid-target', 'Expected target declarations');
      const captured = new Map<SchedulerTarget, SchedulerTarget>();
      for (const target of targets) {
        if (target === null || typeof target !== 'object' || captured.has(target)) {
          throw this.#problem('invalid-target', 'Expected distinct target declaration objects');
        }
        const { name, kind, params } = target;
        if (
          typeof name !== 'string' ||
          name.length === 0 ||
          (kind !== 'event' && kind !== 'control') ||
          !Array.isArray(params) ||
          !Array.from(params).every(scalarType)
        ) {
          throw this.#problem(
            'invalid-target',
            'Target requires name, event/control kind, and scalar params',
          );
        }
        const snapshot = Object.freeze({ name, kind, params: Object.freeze([...params]) });
        captured.set(target, snapshot);
        captured.set(snapshot, snapshot);
      }
      if (executor === null || typeof executor !== 'object' || !synchronous(executor.execute)) {
        throw this.#problem(
          'executor-contract',
          'Executor.execute must be a synchronous non-generator method',
        );
      }
      const execute = executor.execute;
      const handle: SchedulerInstance = Object.freeze({
        instanceId,
        at: (target: SchedulerTarget, deadline: number, args: readonly RuntimeScalar[]) =>
          this.#boundary(() => this.#at(this.#instance(handle), target, deadline, args)),
        cancel: (id: number) => this.#boundary(() => this.#cancel(this.#instance(handle), id)),
      });
      const instance: InstanceState = {
        handle,
        targets: captured,
        execute,
        receiver: executor,
        ids: new EventIdPool(),
        active: new Map(),
        destroyRequested: false,
        destroyed: false,
      };
      this.#identities.add(instanceId);
      this.#instances.set(handle, instance);
      return handle;
    });
  }

  enqueueControl(
    handle: SchedulerInstance,
    target: SchedulerTarget,
    args: readonly RuntimeScalar[],
  ): void {
    this.#boundary(() => {
      const instance = this.#instance(handle);
      const captured = this.#target(instance, target, 'control');
      const inputs = this.#arguments(captured, args);
      this.#queue.push({
        instance,
        target: captured,
        args: inputs,
        time: this.#now,
        round: this.#controlStarted ? this.#controlRound + 1n : 0n,
        sequence: this.#sequence++,
        id: 0,
        status: 'pending',
      });
    });
  }

  destroyInstance(handle: SchedulerInstance): void {
    this.#boundary(() => {
      const instance = this.#instance(handle);
      instance.destroyRequested = true;
      this.#destruction.add(instance);
      if (this.#current === undefined) this.#flushDestruction();
    });
  }

  start(options: SchedulerRunOptions = {}): SchedulerRunResult {
    return this.#boundary(() => {
      if (this.#state === 'running')
        throw this.#problem(
          'reentrant-execution',
          'Cannot recursively start or step the scheduler',
        );
      if (options === null || typeof options !== 'object' || Array.isArray(options)) {
        throw this.#problem('invalid-options', 'Expected run options');
      }
      const until = options.until === undefined ? undefined : this.#deadline(options.until);
      const maxEntries = limit(options.maxEntries, Number.MAX_SAFE_INTEGER, 'maxEntries');
      this.#state = 'running';
      this.#pauseRequested = false;
      let executed = 0;
      const result = (reason: SchedulerRunResult['reason']): SchedulerRunResult =>
        Object.freeze({ timePs: this.#now, executed, reason });
      try {
        for (;;) {
          if (this.#pauseRequested) return result('paused');
          if (executed >= maxEntries) return result('entry-limit');
          const work = this.#next();
          if (work === undefined || (until !== undefined && work.time > until)) {
            if (until !== undefined) {
              this.#setTime(until);
              return result('until');
            }
            return result('empty');
          }
          this.#setTime(work.time);
          this.#execute(work);
          executed += 1;
        }
      } finally {
        if (this.#error === undefined) this.#state = 'paused';
      }
    });
  }

  pause(): void {
    if (this.#state === 'running') this.#pauseRequested = true;
  }

  step(): SchedulerRunResult {
    return this.start({ maxEntries: 1 });
  }

  #at(
    instance: InstanceState,
    target: SchedulerTarget,
    deadline: number,
    args: readonly RuntimeScalar[],
  ): number {
    const captured = this.#target(instance, target, 'event');
    const time = this.#deadline(deadline);
    const inputs = this.#arguments(captured, args);
    const id = instance.ids.take();
    if (id === undefined)
      throw this.#problem('event-id-exhausted', 'All nonzero u32 event IDs are occupied');
    const work: Work = {
      instance,
      target: captured,
      args: inputs,
      time,
      round: time === this.#now && this.#ordinaryStarted ? this.#ordinaryRound + 1n : 0n,
      sequence: this.#sequence++,
      id,
      status: 'pending',
    };
    instance.active.set(id, work);
    this.#queue.push(work);
    return id;
  }

  #cancel(instance: InstanceState, id: number): void {
    if (
      typeof id !== 'number' ||
      !Number.isInteger(id) ||
      id < 0 ||
      id > 0xffff_ffff ||
      !instance.ids.allocated(id)
    ) {
      throw this.#problem(
        'invalid-event-id',
        `eventId=${String(id)} must be 0 or a previously allocated u32 in this instance`,
      );
    }
    if (id === 0) return;
    const work = instance.active.get(id);
    if (work === undefined || work.status !== 'pending') return;
    work.status = 'cancelled';
    instance.active.delete(id);
    instance.ids.release(id);
  }

  #target(
    instance: InstanceState,
    target: SchedulerTarget,
    kind: SchedulerTarget['kind'],
  ): SchedulerTarget {
    const captured = instance.targets.get(target);
    if (captured === undefined || captured.kind !== kind) {
      throw this.#problem('invalid-target', `Expected this instance's registered ${kind} target`);
    }
    return captured;
  }

  #arguments(target: SchedulerTarget, args: readonly RuntimeScalar[]): readonly RuntimeScalar[] {
    try {
      return captureArgs(target.params, args);
    } catch (cause) {
      throw this.#problem(
        'invalid-argument',
        `Arguments for ${target.name} must match its scalar signature`,
        cause,
      );
    }
  }

  #instance(handle: SchedulerInstance): InstanceState {
    const instance = this.#instances.get(handle);
    if (instance === undefined || instance.destroyed || instance.destroyRequested) {
      throw this.#problem('invalid-instance', 'Instance is foreign, destroyed, or stopping');
    }
    return instance;
  }

  #deadline(value: number): TimePs {
    const deadline = timePs(value);
    if (deadline < this.#now) {
      throw new RangeError(
        `deadline=${deadline} ps must be in [${this.#now}, ${MAX_TIME_PS}] ps (not in the past)`,
      );
    }
    return deadline;
  }

  #next(): Work | undefined {
    for (;;) {
      const work = this.#queue.peek();
      if (work === undefined) return undefined;
      if (work.status === 'pending' && !work.instance.destroyed) return work;
      this.#queue.pop();
    }
  }

  #setTime(time: TimePs): void {
    if (time === this.#now) return;
    this.#now = time;
    this.#entries = 0;
    this.#ordinaryRound = 0n;
    this.#controlRound = 0n;
    this.#ordinaryStarted = false;
    this.#controlStarted = false;
  }

  #execute(work: Work): void {
    this.#current = work;
    this.#steps = 0;
    try {
      if (this.#entries >= this.#maxEntries) {
        throw this.#problem(
          'time-budget-exhausted',
          `Exceeded ${this.#maxEntries} entries at ${this.#now} ps`,
        );
      }
      if (this.#maxSteps === 0)
        throw this.#problem('entry-budget-exhausted', 'Entry reference step budget is 0');
      this.#queue.pop();
      work.status = 'running';
      this.#entries += 1;
      if (work.target.kind === 'event') {
        this.#ordinaryRound = work.round;
        this.#ordinaryStarted = true;
      } else {
        this.#controlRound = work.round;
        this.#controlStarted = true;
      }
      const remainingSteps = () => this.#maxSteps - this.#steps;
      const context: SchedulerExecutionContext = Object.freeze({
        instanceId: work.instance.handle.instanceId,
        timePs: this.#now,
        phase: work.target.kind,
        eventId: work.id,
        get remainingSteps() {
          return remainingSteps();
        },
        consumeSteps: (count = 1) =>
          this.#boundary(() => {
            if (this.#current !== work || work.status !== 'running') {
              throw this.#problem(
                'executor-contract',
                'Execution context is only valid during its entry',
              );
            }
            if (!Number.isSafeInteger(count) || count < 0) {
              throw this.#problem(
                'executor-contract',
                'Step count must be a non-negative safe integer',
              );
            }
            if (count > this.#maxSteps - this.#steps) {
              throw this.#problem(
                'entry-budget-exhausted',
                `Exceeded ${this.#maxSteps} reference steps`,
              );
            }
            this.#steps += count;
          }),
      });
      const returned: unknown = work.instance.execute.call(
        work.instance.receiver,
        work.target,
        work.args,
        context,
      );
      if (!returnedSynchronously(returned))
        throw this.#problem(
          'executor-contract',
          'Executor must return synchronously with no result',
        );
      if (this.#error !== undefined) throw this.#error;
      work.status = 'completed';
      if (work.id !== 0) {
        work.instance.active.delete(work.id);
        work.instance.ids.release(work.id);
      }
    } catch (cause) {
      if (work.status === 'running') work.status = 'failed';
      this.#fault(cause);
      throw this.#error;
    } finally {
      this.#current = undefined;
      this.#flushDestruction();
    }
  }

  #flushDestruction(): void {
    for (const instance of this.#destruction) {
      for (const work of instance.active.values()) {
        if (work.status === 'pending') work.status = 'cancelled';
      }
      instance.active.clear();
      instance.destroyed = true;
      this.#instances.delete(instance.handle);
    }
    this.#destruction.clear();
    // Purge cancelled and destroyed-instance records now; control work has no ID and is
    // not in `active`, so the destroyed flag is the authoritative filter. Otherwise a
    // queue that is never driven again would keep targets, executors, and interpreter
    // or topology state reachable.
    this.#queue.retain((work) => work.status === 'pending' && !work.instance.destroyed);
  }

  #problem(code: SchedulerErrorCode, message: string, cause?: unknown): SchedulerError {
    const current = this.#current;
    return new SchedulerError(code, message, {
      timePs: this.#now,
      // Boundary failures outside an entry must not inherit the previous entry's count.
      steps: current === undefined ? 0 : this.#steps,
      entriesAtTime: this.#entries,
      cause,
      ...(current === undefined
        ? {}
        : {
            instanceId: current.instance.handle.instanceId,
            targetName: current.target.name,
            phase: current.target.kind,
            eventId: current.id,
          }),
    });
  }

  #fault(cause: unknown): void {
    if (cause === this.#error && this.#error !== undefined) return;
    const previous = this.#error;
    const code =
      previous?.code ?? (cause instanceof SchedulerError ? cause.code : 'execution-failed');
    const message =
      previous?.message ?? (cause instanceof Error ? cause.message : 'Entry execution failed');
    this.#error = this.#problem(code, message, cause);
    this.#state = 'faulted';
  }

  #boundary<T>(action: () => T): T {
    if (this.#error !== undefined)
      throw this.#problem(
        'scheduler-faulted',
        'Scheduler faulted; rebuild instead of resuming',
        this.#error,
      );
    try {
      return action();
    } catch (cause) {
      if (this.#current !== undefined) this.#fault(cause);
      throw cause;
    }
  }
}
