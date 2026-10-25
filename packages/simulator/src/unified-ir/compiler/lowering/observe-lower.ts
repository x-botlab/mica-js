import type { FunctionBuilder, FunctionRef, ScalarType, Value } from '@mica-js/ir';
import { emitDevicePowered, type PowerGating } from '../power';
import {
  UnifiedIRCompilerError,
  type CompiledCircuitMemory,
  type DeviceObserveEdge,
  type DeviceObserverSlot,
  type GlobalObserverMap,
} from '../types';

/**
 * `observe.configure` lowering.
 *
 * An observation is not a runtime object: it becomes three instructions folded
 * into the main loop, plus one `observe_baselines` slot.
 *
 * ```text
 * observe.configure @control { enabled: true, edges: 'both' }   // in initialize
 *   -> observe_baselines[i] = PIN_INPUT[trigger]                // seed the baseline
 *
 * unified_tick:                                                 // end of every step
 *   %current = array.load @pin_input, trigger
 *   %last    = array.load @observe_baselines, i
 *   %edge    = bool.xor %last, %current                         // rising/falling/both
 *   branch %edge, detect, after
 * detect:
 *   call @<device>_observe_<name>, [captured...]
 *   jump after
 * after:
 *   array.store @observe_baselines, i, %current
 * ```
 *
 * The handler is a real IR function, so V8 can inline it; the baseline write is
 * unconditional, exactly like the legacy edge detector, so a handler that is
 * missed once does not replay on the next tick.
 */

/** One activated observation, ready for insertion into the main loop. */
export interface LoweredObserver {
  readonly slot: DeviceObserverSlot;
  readonly edges: DeviceObserveEdge;
  /** Generated `<deviceId>_observe_<name>` handler. */
  readonly target: FunctionRef;
}

/** One `observe.configure` occurrence recorded during device generation. */
export interface ObserverActivation {
  readonly slot: DeviceObserverSlot;
  readonly edges: DeviceObserveEdge;
  readonly target: FunctionRef;
}

/** Lowering surface used by device generation. */
export interface ObserverLowering {
  /** Resolves one declared observation of a device. */
  slotOf(deviceId: string, name: string): DeviceObserverSlot | undefined;
  /** Seeds the baseline from the trigger level; runs where `configure` runs. */
  emitBaseline(builder: FunctionBuilder<readonly []>, slot: DeviceObserverSlot): void;
  /** Activates (or replaces) the handler of one observation. */
  activate(activation: ObserverActivation): void;
  /** Activated observations in declaration order. */
  readonly programs: readonly LoweredObserver[];
}

/** Everything observe lowering reads from the earlier stages. */
export interface ObserverLoweringContext {
  readonly memory: CompiledCircuitMemory;
  readonly observers: GlobalObserverMap;
}

/** Builds the observer registry and its main-loop programs. */
export function createObserverLowering(context: ObserverLoweringContext): ObserverLowering {
  const slots = new Map<string, DeviceObserverSlot>();
  for (const slot of context.observers.slots) {
    slots.set(`${slot.deviceId}.${slot.name}`, slot);
  }
  const active = new Map<number, LoweredObserver>();
  const lowering: ObserverLowering = {
    slotOf(deviceId: string, name: string): DeviceObserverSlot | undefined {
      return slots.get(`${deviceId}.${name}`);
    },
    emitBaseline(builder: FunctionBuilder<readonly []>, slot: DeviceObserverSlot): void {
      const baselines = requireBaselines(context.memory, slot.deviceId);
      const current = builder.array.load(
        context.memory.input,
        builder.const('u32', slot.triggerPinId),
      );
      builder.array.store(baselines, builder.const('u32', slot.index), current);
    },
    activate(activation: ObserverActivation): void {
      active.set(
        activation.slot.index,
        Object.freeze({
          slot: activation.slot,
          edges: activation.edges,
          target: activation.target,
        }),
      );
    },
    get programs(): readonly LoweredObserver[] {
      return Object.freeze(
        [...active.values()].sort((left, right) => left.slot.index - right.slot.index),
      );
    },
  };
  return lowering;
}

/**
 * Emits the edge detection of `programs[index]`, then hands the builder of the
 * follow-up block to `continuation`.
 *
 * The IR builder has no "insert after this block" operation, so the remaining
 * work is chained through the callback: that keeps one straight-line block per
 * observer and avoids a nested tree of branches.
 */
export function emitObserverDetection(
  builder: FunctionBuilder<readonly []>,
  memory: CompiledCircuitMemory,
  programs: readonly LoweredObserver[],
  index: number,
  continuation: (builder: FunctionBuilder<readonly []>) => void,
  power?: PowerGating,
): void {
  const program = programs[index];
  if (program === undefined) {
    continuation(builder);
    return;
  }
  const baselines = requireBaselines(memory, program.slot.deviceId);
  const current = builder.array.load(memory.input, builder.const('u32', program.slot.triggerPinId));
  const last = builder.array.load(baselines, builder.const('u32', program.slot.index));
  const edge = emitEdgeCheck(builder, program.edges, last, current);
  // RFC 0007: an unpowered device observes nothing, but the baseline still
  // follows the trigger so a missed edge is not replayed after power returns.
  const powered = emitDevicePowered(builder, power, program.slot.deviceId);
  const fire = powered === undefined ? edge : builder.bool.and(edge, powered);

  const detect = builder.block([]);
  const after = builder.block([]);
  builder.branch(fire, { target: detect, args: [] }, { target: after, args: [] });
  builder.at(detect, (then) => {
    const captured: Value<ScalarType>[] = program.slot.capturePinIds.map((pinId) =>
      then.array.load(memory.input, then.const('u32', pinId)),
    );
    then.call(program.target, captured);
    then.jump(after, []);
  });
  builder.at(after, (next) => {
    next.array.store(baselines, next.const('u32', program.slot.index), current);
    emitObserverDetection(next, memory, programs, index + 1, continuation, power);
  });
}

/** One edge predicate: `both` is XOR, rising/falling are gated levels. */
function emitEdgeCheck(
  builder: FunctionBuilder<readonly []>,
  edges: DeviceObserveEdge,
  last: Value<'bool'>,
  current: Value<'bool'>,
): Value<'bool'> {
  switch (edges) {
    case 'rising':
      return builder.bool.and(builder.bool.not(last), current);
    case 'falling':
      return builder.bool.and(last, builder.bool.not(current));
    default:
      return builder.bool.xor(last, current);
  }
}

function requireBaselines(
  memory: CompiledCircuitMemory,
  deviceId: string,
): NonNullable<CompiledCircuitMemory['observeBaselines']> {
  const baselines = memory.observeBaselines;
  if (baselines === undefined) {
    throw new UnifiedIRCompilerError(
      'invalid-input',
      `Device "${deviceId}" configures an observation but the circuit has no \`observe_baselines\` array`,
      { deviceId },
    );
  }
  return baselines;
}
