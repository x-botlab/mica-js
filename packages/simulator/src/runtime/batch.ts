import type {
  BatchEffect,
  BatchLimit,
  BatchPlan,
  BatchScalar,
  ProcessBatchPlan,
} from '@mica-js/compiler';
import type { JitBatchMark } from '../types';
import { dataObject } from '../values';
import type { Instance } from './instance';
import type { Channel, ResourceSlot } from './state';
import { MAX_TIME } from './execution';

export type { ProcessBatchRegistration, ProcessBatchTarget } from '../types';
export type {
  BatchEffect,
  BatchLimit,
  BatchPlan,
  BatchStateWrite,
  ProcessBatchPlan,
} from '@mica-js/compiler';

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
  readonly stepPs: number;
  readonly pc: string | undefined;
  readonly writes: ReadonlySet<ResourceSlot>;
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
  ): PreparedBatch | BatchDecline;
}

export type BatchKind = 'process' | 'jit';
export type BatchStage =
  'candidates' | 'registered' | 'attempts' | 'admitted' | 'executed' | 'committed' | 'published';
export type BatchDecline =
  | 'window'
  | 'bounds'
  | 'overlap'
  | 'observed'
  | 'binding'
  | 'state'
  | 'scheduler'
  | 'ready'
  | 'waiter'
  | 'publication'
  | 'mark'
  | 'proof'
  | 'route'
  | 'hook'
  | 'capacity';

export type BatchStats = Record<BatchStage, number> & {
  readonly declines: Partial<Record<BatchDecline, number>>;
};

export function batchStats(): BatchStats {
  return {
    candidates: 0,
    registered: 0,
    attempts: 0,
    admitted: 0,
    executed: 0,
    committed: 0,
    published: 0,
    declines: {},
  };
}

export interface PreparedBatch {
  readonly rounds: number;
  /** Exact time of the next real wake. */
  readonly due: number;
  /** Last folded round; the board time to publish at. */
  readonly lastAt: number;
  /** Commit the folded rounds once. */
  apply(): void;
}

function scalarAt(value: BatchScalar, cursor: number): number | boolean {
  if (typeof value !== 'object') return value;
  return value.subtractCursor ? value.cursorOffset - cursor : cursor + value.cursorOffset;
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

  const stateWrites = (plan.stateWrites ?? []).map((write) => {
    const declaration = instance.declarations.get(write.name);
    const slot = instance.stateResources.get(write.name);
    const type = typeof write.value === 'boolean' ? 'bool' : 'number';
    if (
      slot === undefined ||
      declaration?.kind !== 'state' ||
      declaration.type.kind !== type ||
      write.name === pc?.name ||
      write.name === stop?.name
    )
      return undefined;
    return { ...write, slot };
  });
  if (stateWrites.some((write) => write === undefined)) return undefined;
  const updates = stateWrites.filter((write) => write !== undefined);
  const outputs = plan.outputs ?? [];
  const outputCounts = new Map<Channel, number>();
  for (const output of outputs) {
    const channel = instance.channels.get(output.channel);
    const type = typeof output.value === 'boolean' ? 'bool' : 'number';
    if (channel?.declaration.direction !== 'output' || channel.declaration.type.kind !== type)
      return undefined;
    outputCounts.set(channel, (outputCounts.get(channel) ?? 0) + 1);
  }
  const writtenSlots = new Set([cursor.slot, ...updates.map((write) => write.slot)]);
  if (pc !== undefined) writtenSlots.add(pc.slot);
  if (destination !== undefined) writtenSlots.add(destination.slot);
  const word = effect.kind === 'advance' ? undefined : effect.word;
  const width = word === undefined ? 1 : 2;
  const destinationView =
    word !== undefined && effect.kind === 'fill'
      ? new DataView(
          destination!.bytes.buffer,
          destination!.bytes.byteOffset,
          destination!.bytes.length,
        )
      : undefined;

  const resumeBlock = 'resumeBlock' in plan ? plan.resumeBlock : undefined;
  if (resumeBlock !== undefined && (!safeInteger(resumeBlock) || resumeBlock < 0)) return undefined;

  const bound: BoundBatch = {
    instance,
    stepPs: plan.stepPs,
    pc: pc?.name,
    resumeBlock,
    writes: writtenSlots,
    prepare: (now, executionEnd, nextEventAt, schedulerYieldAt) => {
      if (!instance.valid || (destination !== undefined && instance.isCodeMemory(destination.name)))
        return 'binding';
      const states = instance.states;
      const cursorValue = states.get(cursor.name);
      // A cursor-valued output can expose signed zero in the first round.
      if (!safeInteger(cursorValue) || cursorValue < 0 || Object.is(cursorValue, -0))
        return 'state';
      const limitValue = limit.kind === 'constant' ? limit.value : states.get(limit.name);
      if (!safeInteger(limitValue) || limitValue <= cursorValue) return 'state';

      let stopValue = Infinity;
      if (stop !== undefined) {
        const value = states.get(stop.name);
        if (!validTime(value)) return 'state';
        stopValue = value;
      }
      const stopAt = Math.min(executionEnd, nextEventAt, schedulerYieldAt ?? Infinity, stopValue);
      if (!(stopAt === Infinity || validTime(stopAt))) return 'window';
      if (!validTime(now) || !(stopAt > now)) return 'window';

      const window = stopAt - now;
      let rounds = Math.min(
        Math.ceil((limitValue - cursorValue) / width),
        Math.floor((window - 1) / bound.stepPs),
      );
      if (!safeInteger(rounds) || rounds < 2) return 'window';
      for (const [channel, count] of outputCounts)
        rounds = Math.min(rounds, Math.floor((channel.capacity - channel.outgoing.length) / count));
      if (rounds < 2) return 'capacity';
      const elapsed = rounds * bound.stepPs;
      const byteLength = rounds * width;
      const due = now + elapsed;
      const lastAt = due - bound.stepPs;
      const nextCursor = cursorValue + byteLength;
      if (!safeInteger(elapsed) || !validTime(due) || due >= stopAt || !safeInteger(nextCursor))
        return 'window';

      for (const slot of writtenSlots)
        if (slot.subscribers.size !== 0 || (slot.waiters?.size ?? 0) !== 0) return 'observed';

      if (instance.activeJitPcCount(cursor.name) !== 0) return 'binding';
      if (pc !== undefined && instance.activeJitPcCount(pc.name) > 1) return 'binding';
      for (const update of updates)
        if (instance.activeJitPcCount(update.name) !== 0) return 'binding';

      let sourceView: Uint8Array | undefined;
      let destinationStart = 0;
      if (effect.kind === 'fill') {
        destinationStart = effect.destinationBase + cursorValue;
        if (
          !safeInteger(destinationStart) ||
          destinationStart < 0 ||
          destinationStart > destination!.bytes.length ||
          byteLength > destination!.bytes.length - destinationStart
        )
          return 'bounds';
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
          byteLength > destination!.bytes.length - destinationStart ||
          byteLength > source!.bytes.length - sourceStart
        )
          return 'bounds';
        if (source!.bytes.buffer === destination!.bytes.buffer) {
          const sourceOffset = source!.bytes.byteOffset + sourceStart;
          const destinationOffset = destination!.bytes.byteOffset + destinationStart;
          if (
            sourceOffset < destinationOffset + byteLength &&
            destinationOffset < sourceOffset + byteLength
          )
            return 'overlap';
        }
        sourceView = source!.bytes.subarray(sourceStart, sourceStart + byteLength);
      }

      const lastCursor = nextCursor - width;
      const applyUpdates = (position: (typeof updates)[number]['position']): void => {
        for (const update of updates) {
          if (update.position !== position) continue;
          instance.host.write(update.name, scalarAt(update.value, lastCursor));
        }
      };
      let applied = false;
      return Object.freeze({
        due,
        lastAt,
        rounds,
        apply: () => {
          if (applied) return;
          applied = true;
          if (updates.length !== 0) applyUpdates('beforeMemory');
          if (effect.kind === 'fill') {
            const end = destinationStart + byteLength;
            if (destinationView === undefined) {
              destination!.bytes.fill(effect.value & 0xff, destinationStart, end);
            } else {
              for (let at = destinationStart; at < end; at += 2)
                destinationView.setUint16(at, effect.value, word === 'le');
            }
          } else if (effect.kind === 'copy') {
            destination!.bytes.set(sourceView!, destinationStart);
          }
          if (destination !== undefined)
            instance.memoryChanged(destination.name, destinationStart, byteLength);
          if (updates.length !== 0) applyUpdates('beforeCursor');
          instance.host.write(cursor.name, nextCursor);
          if (updates.length !== 0) applyUpdates('afterCursor');
          if (outputs.length !== 0) {
            for (let round = 0; round < rounds; round++) {
              const at = now + round * bound.stepPs;
              const cursor = cursorValue + round * width;
              for (const output of outputs)
                instance.send(output.channel, scalarAt(output.value, cursor), false, at);
            }
          }
        },
      });
    },
  };
  return Object.freeze(bound);
}

type Fill16 = NonNullable<JitBatchMark['fill16']>;

export function captureFill16(value: unknown): Fill16 {
  dataObject(value, ['memory', 'stepPs', 'summarize', 'transientWrites']);
  const { memory, stepPs, summarize, transientWrites } = value;
  if (
    typeof memory !== 'string' ||
    !memory ||
    !safeInteger(stepPs) ||
    stepPs <= 0 ||
    typeof summarize !== 'string' ||
    !summarize
  )
    throw new TypeError('Invalid fill16 batch mark');
  const names: string[] = [];
  if (Object.hasOwn(value, 'transientWrites')) {
    if (!Array.isArray(transientWrites)) throw new TypeError('Expected batch resource names');
    for (let index = 0; index < transientWrites.length; index++) {
      const item = Object.getOwnPropertyDescriptor(transientWrites, String(index));
      if (typeof item?.value !== 'string' || !item.value)
        throw new TypeError('Expected a batch resource name');
      names.push(item.value);
    }
  }
  return { memory, stepPs, summarize, transientWrites: names };
}

const nativeLittleEndian = new Uint8Array(Uint16Array.of(1).buffer)[0] === 1;
const fillFields = ['byteOffset', 'rounds', 'value'] as const;

/** Bind a model's closed-form loop summary to the normal batch scheduler and resource guards. */
export function bindFill16(
  instance: Instance,
  fill: Fill16,
  stopBefore: string | undefined,
  pcState: string,
): BoundBatch | undefined {
  const destination = memoryBinding(instance, fill.memory);
  const pc = stateBinding(instance, pcState);
  const stop = stopBefore === undefined ? undefined : stateBinding(instance, stopBefore);
  const fn = instance.declarations.get(fill.summarize);
  if (
    destination === undefined ||
    instance.isCodeMemory(fill.memory) ||
    pc === undefined ||
    (stopBefore !== undefined && (stop === undefined || stop.name === pc.name)) ||
    fn?.kind !== 'function' ||
    !fn.pure ||
    fn.params.length !== 1 ||
    fn.params[0]?.type.kind !== 'number' ||
    fn.returns?.kind !== 'optional' ||
    fn.returns.inner.kind !== 'record'
  )
    return undefined;
  const record = instance.declarations.get(fn.returns.inner.name);
  if (
    record?.kind !== 'record' ||
    fillFields.some(
      (name) => !record.fields.some((field) => field.name === name && field.type === 'number'),
    )
  )
    return undefined;

  const writes = new Set<ResourceSlot>([destination.slot, pc.slot]);
  const updates = new Map<string, 'number' | 'bool'>();
  for (const { name, type } of record.fields) {
    if (name === 'byteOffset' || name === 'rounds' || name === 'value') continue;
    const state = instance.declarations.get(name);
    const slot = instance.stateResources.get(name);
    if (
      state?.kind !== 'state' ||
      state.type.kind !== type ||
      slot === undefined ||
      name === pc.name ||
      name === stop?.name
    )
      return undefined;
    writes.add(slot);
    updates.set(name, type);
  }
  for (const name of fill.transientWrites ?? []) {
    const slot = instance.stateResources.get(name) ?? instance.memoryResources.get(name);
    if (slot === undefined || name === stop?.name || instance.isCodeMemory(name)) return undefined;
    writes.add(slot);
  }
  const otherStates = [...new Set([...updates.keys(), ...(fill.transientWrites ?? [])])].filter(
    (name) => name !== pc.name,
  );

  const bytes = destination.bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const words =
    nativeLittleEndian && bytes.byteOffset % 2 === 0
      ? new Uint16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2))
      : undefined;
  return Object.freeze<BoundBatch>({
    instance,
    stepPs: fill.stepPs,
    pc: pc.name,
    resumeBlock: undefined,
    writes,
    prepare(now, executionEnd, nextEventAt, schedulerYieldAt) {
      if (!instance.valid || instance.isCodeMemory(fill.memory)) return 'binding';
      if (instance.activeJitPcCount(pc.name) > 1) return 'binding';
      for (const slot of writes)
        if (slot.subscribers.size !== 0 || (slot.waiters?.size ?? 0) !== 0) return 'observed';
      for (const name of otherStates) if (instance.activeJitPcCount(name) !== 0) return 'binding';

      const stopValue = stop === undefined ? Infinity : instance.states.get(stop.name);
      if (stop !== undefined && !validTime(stopValue)) return 'state';
      const upper = Math.min(
        executionEnd,
        nextEventAt,
        schedulerYieldAt ?? Infinity,
        stopValue as number,
      );
      const window = upper - now;
      if (window <= 2 * fill.stepPs) return 'window';
      let result: unknown;
      try {
        result = instance.syncCall(fill.summarize, [window]);
        if (result == null) return 'state';
        dataObject(result);
      } catch {
        return 'state';
      }
      const { byteOffset, rounds, value } = result;
      if (
        !safeInteger(rounds) ||
        rounds < 2 ||
        !safeInteger(byteOffset) ||
        byteOffset < 0 ||
        byteOffset % 2 !== 0 ||
        !safeInteger(value) ||
        value < 0 ||
        value > 0xffff
      )
        return 'state';
      const length = rounds * 2;
      const due = now + rounds * fill.stepPs;
      if (!validTime(due) || due >= upper) return 'window';
      if (length > bytes.length - byteOffset) return 'bounds';
      const stateValues: [string, unknown][] = [];
      for (const [name, type] of updates) {
        const next = result[name];
        if (
          type === 'number'
            ? typeof next !== 'number' || !Number.isFinite(next)
            : typeof next !== 'boolean'
        )
          return 'state';
        stateValues.push([name, next]);
      }
      let applied = false;
      return {
        due,
        lastAt: due - fill.stepPs,
        rounds,
        apply() {
          if (applied) return;
          applied = true;
          const end = byteOffset + length;
          if (words !== undefined) words.fill(value, byteOffset / 2, end / 2);
          else for (let at = byteOffset; at < end; at += 2) view.setUint16(at, value, true);
          instance.memoryChanged(fill.memory, byteOffset, length);
          for (const [name, next] of stateValues) instance.host.write(name, next);
        },
      };
    },
  });
}
