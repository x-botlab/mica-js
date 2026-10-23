/**
 * Shared observation model for the memory optimization passes (J12).
 *
 * The three passes agree on three notions:
 *
 * - **location**: a `state` resource, one constant-indexed `array` element, or
 *   a constant `bytes` interval. Different resources never alias; inside one
 *   resource, disjoint constant indices/intervals never alias, everything else
 *   is treated as a potential alias.
 * - **barrier**: a point where host code can observe or change storage. Every
 *   barrier writes back the promoted dirty values before it runs and reloads
 *   the promoted locals afterwards.
 * - **forwardability**: a store's value may be reused by a later load only when
 *   the store/load round trip is the identity. For floats that means the value
 *   is `D` (canonical bits); `U` values are never forwarded because storage
 *   lowercases the bit string.
 *
 * The reference model is deliberately conservative: any instruction that
 * enters host code, calls a function, transfers control or may write an
 * unknown location is a full barrier.
 */
import type { MemoryDefinition, NumericType, ScalarType } from '../../types';
import { EFFECT_INFO } from '../effects';
import { Op } from '../mir';
import type { MBlock, MFunction, MInst, ValueId } from '../mir';

/** What every memory pass needs from the lowered module. */
export interface MemoryPassContext {
  /** Model memories in lowered-index order. */
  readonly memories: readonly MemoryDefinition[];
}

/** Byte width of one numeric scalar type. */
export const NUMERIC_BYTES: Readonly<Record<NumericType, number>> = Object.freeze({
  u8: 1,
  i8: 1,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  f32: 4,
  f64: 8,
});

export function memoryAt(context: MemoryPassContext, memory: number): MemoryDefinition | undefined {
  return context.memories[memory];
}

/** The scalar layout of `state` / `array` memory, or `undefined` otherwise. */
export function scalarLayout(
  context: MemoryPassContext,
  memory: number,
  kind: 'state' | 'array',
): { readonly scalarType: ScalarType; readonly length: number } | undefined {
  const definition = memoryAt(context, memory);
  if (definition === undefined || definition.kind !== kind) return undefined;
  const layout = definition.layout;
  if (layout.kind !== 'scalar') return undefined;
  return layout;
}

/** Byte length of a `bytes`/`inbox` memory. */
export function byteLength(context: MemoryPassContext, memory: number): number | undefined {
  const definition = memoryAt(context, memory);
  if (definition === undefined || definition.layout.kind !== 'bytes') return undefined;
  return definition.layout.length;
}

export function isWritable(context: MemoryPassContext, memory: number): boolean {
  return memoryAt(context, memory)?.writable === true;
}

/** Definition instruction of an SSA value, when it is an instruction result. */
export function instructionOf(fn: MFunction, id: ValueId): MInst | undefined {
  const value = fn.values[id];
  if (value === undefined) return undefined;
  const definition = value.def;
  return 'insts' in definition ? undefined : definition;
}

/** Defining block of an SSA value (a block for parameters, else its containing block). */
export function definingBlock(fn: MFunction, id: ValueId): MBlock | undefined {
  const value = fn.values[id];
  if (value === undefined) return undefined;
  const definition = value.def;
  if ('insts' in definition) return definition;
  return fn.blocks.find((block) => block.insts.includes(definition));
}

/** Integer constant carried by a value, or `undefined`. */
export function constantNumber(fn: MFunction, id: ValueId): number | undefined {
  const definition = instructionOf(fn, id);
  if (definition === undefined || definition.op !== Op.Const) return undefined;
  const literal = definition.imm[0];
  return typeof literal === 'number' ? literal : undefined;
}

/**
 * The stored value survives a storage round trip unchanged?
 *
 * Float `U` values may hold uppercase (non-canonical) bit strings; storage
 * normalizes them, so forwarding would change the loaded value. `D` values are
 * canonical and f32-representable, so they round-trip exactly.
 */
export function canForwardStore(fn: MFunction, value: ValueId, type: ScalarType): boolean {
  if (type !== 'f32' && type !== 'f64') return true;
  return fn.values[value]?.rep !== 'U';
}

/** True when an instruction enters host code. */
export function isHostInstruction(inst: MInst): boolean {
  return EFFECT_INFO[inst.op]?.host === true;
}

/**
 * True when the instruction may observe or change any storage location:
 * host code, `call` (an un-inlined callee may do anything), `checkpoint`, or
 * an opcode with unknown effect information.
 */
export function isFullBarrier(inst: MInst): boolean {
  const info = EFFECT_INFO[inst.op];
  if (info === undefined) return true;
  return info.host || info.transfer || inst.op === Op.Call;
}

/** Every promotion id as a plain number list, preserving declaration order. */
export function promotionIds(fn: MFunction): number[] {
  return fn.promotions.map((promotion) => promotion.id);
}
