import type { BatchEffect, BatchLimit, BatchPlan, ProcessBatchPlan } from '@mica-js/compiler';
import type { Instance } from './instance';
import type { ResourceSlot } from './state';
import { MAX_TIME } from './execution';

export type { ProcessBatchRegistration, ProcessBatchTarget } from '../types';
export type { BatchEffect, BatchLimit, BatchPlan, ProcessBatchPlan } from '@mica-js/compiler';

interface StateBinding {
  readonly name: string;
  readonly slot: ResourceSlot;
}

interface MemoryBinding {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly slot: ResourceSlot;
}

export interface BoundBatch {
  readonly instance: Instance;
  readonly cursor: string;
  readonly limit: BatchLimit;
  readonly stepPs: number;
  readonly effect: BatchEffect;
  readonly stopBefore: string | undefined;
  readonly pc: string | undefined;
  /** Real ticks resume block for processes; `undefined` for a JIT plan. */
  readonly resumeBlock: number | undefined;
  /**
   * Internal admission entry. It only reads state and versions; every write happens
   * inside the returned `apply` after the board commits the window.
   */
  prepare(
    now: number,
    executionEnd: number,
    nextEventAt: number,
    schedulerYieldAt: number | undefined,
  ): PreparedBatch | undefined;
}

export interface PreparedBatch {
  /** Exact time of the next real wake. */
  readonly due: number;
  /** Last folded round; the board time to publish at. */
  readonly lastAt: number;
  /** Commit the folded rounds once. */
  apply(): void;
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function validTime(value: unknown): value is number {
  return safeInteger(value) && value >= 0 && value <= MAX_TIME;
}

function stateBinding(instance: Instance, name: unknown): StateBinding | undefined {
  if (typeof name !== 'string' || name.length === 0) return undefined;
  const declaration = instance.declarations.get(name);
  if (declaration?.kind !== 'state' || declaration.type.kind !== 'number') return undefined;
  const slot = instance.stateResources.get(name);
  return slot === undefined ? undefined : { name, slot };
}

function memoryBinding(instance: Instance, name: unknown): MemoryBinding | undefined {
  if (typeof name !== 'string' || name.length === 0) return undefined;
  const bytes = instance.memories.get(name);
  const slot = instance.memoryResources.get(name);
  return bytes === undefined || slot === undefined ? undefined : { name, bytes, slot };
}

function validLimit(limit: BatchLimit): boolean {
  if (limit.kind === 'constant') return safeInteger(limit.value) && limit.value >= 0;
  return limit.kind === 'state' && typeof limit.name === 'string' && limit.name.length > 0;
}

function validEffect(effect: BatchEffect): boolean {
  if (effect.kind === 'advance') return true;
  if (effect.kind === 'fill')
    return (
      typeof effect.destination === 'string' &&
      effect.destination.length > 0 &&
      safeInteger(effect.destinationBase) &&
      effect.destinationBase >= 0 &&
      safeInteger(effect.value)
    );
  return (
    effect.kind === 'copy' &&
    typeof effect.source === 'string' &&
    effect.source.length > 0 &&
    typeof effect.destination === 'string' &&
    effect.destination.length > 0 &&
    safeInteger(effect.sourceBase) &&
    effect.sourceBase >= 0 &&
    safeInteger(effect.destinationBase) &&
    effect.destinationBase >= 0
  );
}

/**
 * Resolve one compiler plan against the current instance. `undefined` means the loop
 * stays on the ordinary path; the registration itself remains valid.
 */
export function bindBatch(
  instance: Instance,
  plan: BatchPlan | ProcessBatchPlan,
  stopBefore?: string,
  pcState?: string,
): BoundBatch | undefined {
  if (
    plan === null ||
    typeof plan !== 'object' ||
    typeof plan.cursor !== 'string' ||
    !safeInteger(plan.stepPs) ||
    plan.stepPs <= 0 ||
    !validLimit(plan.limit) ||
    !validEffect(plan.effect)
  )
    return undefined;
  const cursor = stateBinding(instance, plan.cursor);
  const limit = plan.limit;
  const effect = plan.effect;
  if (cursor === undefined) return undefined;

  let limitBinding: StateBinding | undefined;
  if (limit.kind === 'state') {
    limitBinding = stateBinding(instance, limit.name);
    if (limitBinding === undefined) return undefined;
  }

  let stop: StateBinding | undefined;
  if (stopBefore !== undefined) {
    stop = stateBinding(instance, stopBefore);
    if (stop === undefined) return undefined;
  }

  let pc: StateBinding | undefined;
  if (pcState !== undefined) {
    pc = stateBinding(instance, pcState);
    if (pc === undefined) return undefined;
  }

  // The batch writes the cursor and, for JIT, the caller writes the head PC. A state
  // used as the budget, limit or the other entry's PC must stay untouched.
  if (
    (stop !== undefined && stop.name === cursor.name) ||
    (pc !== undefined &&
      (pc.name === cursor.name ||
        (limit.kind === 'state' && pc.name === limit.name) ||
        (stop !== undefined && stop.name === pc.name))) ||
    (limit.kind === 'state' && limit.name === cursor.name)
  )
    return undefined;

  let destination: MemoryBinding | undefined;
  let source: MemoryBinding | undefined;
  if (effect.kind === 'fill') {
    destination = memoryBinding(instance, effect.destination);
    if (destination === undefined || instance.isCodeMemory(destination.name)) return undefined;
  } else if (effect.kind === 'copy') {
    destination = memoryBinding(instance, effect.destination);
    source = memoryBinding(instance, effect.source);
    if (
      destination === undefined ||
      source === undefined ||
      instance.isCodeMemory(destination.name)
    )
      return undefined;
  }

  const resumeBlock = 'resumeBlock' in plan ? plan.resumeBlock : undefined;
  if (resumeBlock !== undefined && (!safeInteger(resumeBlock) || resumeBlock < 0)) return undefined;

  const bound: BoundBatch = {
    instance,
    cursor: cursor.name,
    limit,
    stepPs: plan.stepPs,
    effect,
    stopBefore: stop?.name,
    pc: pc?.name,
    resumeBlock,
    prepare: (now, executionEnd, nextEventAt, schedulerYieldAt) => {
      if (!instance.valid) return undefined;
      // Code ownership can appear after registration (attachJit in the same factory) or
      // change later, so the destination is rechecked on every admission.
      if (destination !== undefined && instance.isCodeMemory(destination.name)) return undefined;
      const states = instance.states;
      const cursorValue = states.get(cursor.name);
      if (!safeInteger(cursorValue) || cursorValue < 0) return undefined;
      const limitValue = limit.kind === 'constant' ? limit.value : states.get(limit.name);
      if (!safeInteger(limitValue) || limitValue <= cursorValue) return undefined;

      let stopValue = Infinity;
      if (stop !== undefined) {
        const value = states.get(stop.name);
        if (!validTime(value)) return undefined;
        stopValue = value;
      }
      const stopAt = Math.min(executionEnd, nextEventAt, schedulerYieldAt ?? Infinity, stopValue);
      if (!(stopAt === Infinity || validTime(stopAt))) return undefined;
      if (!validTime(now) || !(stopAt > now)) return undefined;

      const window = stopAt - now;
      const rounds = Math.min(limitValue - cursorValue, Math.floor((window - 1) / bound.stepPs));
      if (!safeInteger(rounds) || rounds < 2) return undefined;
      // Recheck the multiplied span before adding it to the current time.
      const elapsed = rounds * bound.stepPs;
      if (!safeInteger(elapsed) || elapsed > window - 1) return undefined;
      const due = now + elapsed;
      const lastAt = due - bound.stepPs;
      const nextCursor = cursorValue + rounds;
      if (
        !validTime(due) ||
        !validTime(lastAt) ||
        lastAt < now ||
        due >= stopAt ||
        !safeInteger(nextCursor) ||
        nextCursor > limitValue
      )
        return undefined;

      // Every written slot must be quiet for the whole commit. Sources are read-only;
      // waiting JITs were already excluded by the board gate.
      if (cursor.slot.subscribers.size !== 0 || (cursor.slot.waiters?.size ?? 0) !== 0)
        return undefined;
      if (
        pc !== undefined &&
        (pc.slot.subscribers.size !== 0 || (pc.slot.waiters?.size ?? 0) !== 0)
      )
        return undefined;
      if (
        destination !== undefined &&
        (destination.slot.subscribers.size !== 0 || (destination.slot.waiters?.size ?? 0) !== 0)
      )
        return undefined;

      // A process write must not race an active JIT's PC. A JIT may write its own PC only
      // when no other active registration shares that state.
      if (instance.activeJitPcCount(cursor.name) !== 0) return undefined;
      if (pc !== undefined && instance.activeJitPcCount(pc.name) > 1) return undefined;

      let sourceView: Uint8Array | undefined;
      let destinationStart = 0;
      if (effect.kind === 'fill') {
        destinationStart = effect.destinationBase + cursorValue;
        if (
          !safeInteger(destinationStart) ||
          destinationStart < 0 ||
          destinationStart > destination!.bytes.length ||
          rounds > destination!.bytes.length - destinationStart
        )
          return undefined;
      } else if (effect.kind === 'copy') {
        destinationStart = effect.destinationBase + cursorValue;
        const sourceStart = effect.sourceBase + cursorValue;
        if (
          !safeInteger(destinationStart) ||
          !safeInteger(sourceStart) ||
          destinationStart < 0 ||
          sourceStart < 0 ||
          destinationStart > destination!.bytes.length ||
          sourceStart > source!.bytes.length ||
          rounds > destination!.bytes.length - destinationStart ||
          rounds > source!.bytes.length - sourceStart
        )
          return undefined;
        if (source!.bytes.buffer === destination!.bytes.buffer) {
          const sourceOffset = source!.bytes.byteOffset + sourceStart;
          const destinationOffset = destination!.bytes.byteOffset + destinationStart;
          if (
            sourceOffset < destinationOffset + rounds &&
            destinationOffset < sourceOffset + rounds
          )
            return undefined;
        }
        sourceView = source!.bytes.subarray(sourceStart, sourceStart + rounds);
      }

      let applied = false;
      return Object.freeze({
        due,
        lastAt,
        apply: () => {
          if (applied) return;
          applied = true;
          if (effect.kind === 'fill') {
            // `store8` keeps the low eight bits of the proven value.
            destination!.bytes.fill(
              effect.value & 0xff,
              destinationStart,
              destinationStart + rounds,
            );
          } else if (effect.kind === 'copy') {
            destination!.bytes.set(sourceView!, destinationStart);
          }
          // Ordinary effect order: byte writes, their memory publication, then the
          // folded counter state write. JIT writes its head PC after this commit.
          if (destination !== undefined)
            instance.memoryChanged(destination.name, destinationStart, rounds);
          instance.host.write(cursor.name, nextCursor);
        },
      });
    },
  };
  return Object.freeze(bound);
}
