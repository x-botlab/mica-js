/**
 * Redundant load elimination and store forwarding (J12, `loadElim`).
 *
 * A forward dataflow tracks, for every storage location, the SSA value that is
 * currently stored there. A load whose location is available is replaced by
 * {@link Op.Forward}, a step-preserving copy of that value. The replacement
 * keeps the original `node`/`loc`, so diagnostics and step accounting are
 * unchanged; a load that could throw is only elided after a previous access to
 * the same location succeeded (the only way the location becomes available).
 *
 * Availability sources are loads (their result) and stores (the stored value).
 * It is invalidated by:
 *
 * - host instructions (`executor`, events, bridge, `call`, `checkpoint`),
 *   which may read and write anything;
 * - stores / copies to a possibly aliasing location;
 * - `return`, `dispatch` and `trap` leave the function, so nothing survives.
 *
 * Float store forwarding is restricted to `D` values: storage canonicalizes
 * bit strings, so a `U` value (possibly uppercase) can change bit pattern on a
 * store/load round trip. Bytes entries are tracked only for constant offsets
 * and only forward between identical type/endian/width accesses.
 */
import { buildCFG, computeDominators, dominates } from '../cfg';
import type { CFG } from '../cfg';
import { Op } from '../mir';
import type { MFunction, MInst, ValueId } from '../mir';
import { analyzeRepresentation } from '../repr';
import {
  NUMERIC_BYTES,
  byteLength,
  canForwardStore,
  constantNumber,
  isFullBarrier,
  scalarLayout,
} from './memory-model';
import type { MemoryPassContext } from './memory-model';
import type { NumericType } from '../../types';

type Endian = 'little' | 'big';

interface Availability {
  readonly kind: 'state' | 'array' | 'bytes';
  readonly memory: number;
  readonly index: number | undefined;
  readonly offset: number | undefined;
  readonly width: number;
  readonly value: ValueId;
}

type State = Map<string, Availability>;

function stateKey(memory: number): string {
  return `s:${memory}`;
}

function arrayKey(memory: number, index: number): string {
  return `a:${memory}:${index}`;
}

function bytesKey(memory: number, offset: number, type: string, endian: string): string {
  return `b:${memory}:${offset}:${type}:${endian}`;
}

function clone(state: State): State {
  return new Map(state);
}

function sameState(left: State, right: State): boolean {
  if (left.size !== right.size) return false;
  for (const [key, entry] of left) {
    if (right.get(key)?.value !== entry.value) return false;
  }
  return true;
}

/** Keep only entries that are identically available on both paths. */
function intersect(left: State, right: State): State {
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  const result: State = new Map();
  for (const [key, entry] of small) {
    if (large.get(key)?.value === entry.value) result.set(key, entry);
  }
  return result;
}

function deleteArrayMemory(state: State, memory: number): void {
  for (const [key, entry] of state) {
    if (entry.kind === 'array' && entry.memory === memory) state.delete(key);
  }
}

function deleteBytesMemory(state: State, memory: number): void {
  for (const [key, entry] of state) {
    if (entry.kind === 'bytes' && entry.memory === memory) state.delete(key);
  }
}

function deleteBytesRange(state: State, memory: number, offset: number, width: number): void {
  for (const [key, entry] of state) {
    if (entry.kind !== 'bytes' || entry.memory !== memory || entry.offset === undefined) continue;
    if (entry.offset < offset + width && offset < entry.offset + entry.width) state.delete(key);
  }
}

/**
 * Apply one instruction to `state` and return the value that replaces its
 * result, when the instruction is a forwarded load.
 */
function transfer(
  fn: MFunction,
  context: MemoryPassContext,
  inst: MInst,
  state: State,
  forwardStores: boolean,
): ValueId | undefined {
  switch (inst.op) {
    case Op.StateLoad: {
      const memory = inst.refs[0]!;
      const key = stateKey(memory);
      const available = state.get(key);
      if (available !== undefined) return available.value;
      const result = inst.results[0];
      const layout = scalarLayout(context, memory, 'state');
      if (result !== undefined && layout !== undefined) {
        state.set(key, {
          kind: 'state',
          memory,
          index: undefined,
          offset: undefined,
          width: NUMERIC_BYTES[layout.scalarType as NumericType] ?? 1,
          value: result,
        });
      }
      return undefined;
    }
    case Op.StateStore: {
      const memory = inst.refs[0]!;
      const layout = scalarLayout(context, memory, 'state');
      if (layout === undefined) return undefined;
      const key = stateKey(memory);
      const value = inst.args[0];
      if (value !== undefined && forwardStores && canForwardStore(fn, value, layout.scalarType)) {
        state.set(key, {
          kind: 'state',
          memory,
          index: undefined,
          offset: undefined,
          width: NUMERIC_BYTES[layout.scalarType as NumericType] ?? 1,
          value,
        });
      } else {
        state.delete(key);
      }
      return undefined;
    }
    case Op.ArrayLoad: {
      const memory = inst.refs[0]!;
      const index = constantNumber(fn, inst.args[0]!);
      if (index === undefined) return undefined;
      const key = arrayKey(memory, index);
      const available = state.get(key);
      if (available !== undefined) return available.value;
      const result = inst.results[0];
      const layout = scalarLayout(context, memory, 'array');
      if (result !== undefined && layout !== undefined) {
        state.set(key, {
          kind: 'array',
          memory,
          index,
          offset: undefined,
          width: NUMERIC_BYTES[layout.scalarType as NumericType] ?? 1,
          value: result,
        });
      }
      return undefined;
    }
    case Op.ArrayStore: {
      const memory = inst.refs[0]!;
      const index = constantNumber(fn, inst.args[0]!);
      const layout = scalarLayout(context, memory, 'array');
      if (layout === undefined) return undefined;
      if (index === undefined) {
        deleteArrayMemory(state, memory);
        return undefined;
      }
      const key = arrayKey(memory, index);
      const value = inst.args[1];
      if (value !== undefined && forwardStores && canForwardStore(fn, value, layout.scalarType)) {
        state.set(key, {
          kind: 'array',
          memory,
          index,
          offset: undefined,
          width: NUMERIC_BYTES[layout.scalarType as NumericType] ?? 1,
          value,
        });
      } else {
        state.delete(key);
      }
      return undefined;
    }
    case Op.BytesLoad: {
      const memory = inst.refs[0]!;
      const type = inst.imm[0] as NumericType;
      const endian = inst.imm[1] as Endian;
      const offset = constantNumber(fn, inst.args[0]!);
      if (offset === undefined || byteLength(context, memory) === undefined) return undefined;
      const key = bytesKey(memory, offset, type, endian);
      const available = state.get(key);
      if (available !== undefined) return available.value;
      const result = inst.results[0];
      if (result !== undefined) {
        state.set(key, {
          kind: 'bytes',
          memory,
          index: undefined,
          offset,
          width: NUMERIC_BYTES[type] ?? 1,
          value: result,
        });
      }
      return undefined;
    }
    case Op.BytesStore: {
      const memory = inst.refs[0]!;
      const type = inst.imm[0] as NumericType;
      const endian = inst.imm[1] as Endian;
      const offset = constantNumber(fn, inst.args[0]!);
      if (byteLength(context, memory) === undefined) return undefined;
      if (offset === undefined) {
        deleteBytesMemory(state, memory);
        return undefined;
      }
      const width = NUMERIC_BYTES[type] ?? 1;
      // A store may alias the bytes of any other tracked interval.
      deleteBytesRange(state, memory, offset, width);
      const key = bytesKey(memory, offset, type, endian);
      const value = inst.args[1];
      if (value !== undefined && forwardStores && canForwardStore(fn, value, type)) {
        state.set(key, {
          kind: 'bytes',
          memory,
          index: undefined,
          offset,
          width,
          value,
        });
      } else {
        state.delete(key);
      }
      return undefined;
    }
    case Op.BytesCopy:
    case Op.ResourceUpdateBytes: {
      const destination = inst.refs[0];
      if (destination !== undefined) deleteBytesMemory(state, destination);
      return undefined;
    }
    case Op.ResourceFillBytes: {
      const memory = inst.refs[0];
      if (memory !== undefined) deleteBytesMemory(state, memory);
      return undefined;
    }
    default:
      if (isFullBarrier(inst)) state.clear();
      return undefined;
  }
}

function runInstructions(
  fn: MFunction,
  context: MemoryPassContext,
  insts: readonly MInst[],
  state: State,
  forwardStores: boolean,
): void {
  for (const inst of insts) transfer(fn, context, inst, state, forwardStores);
}

interface DefinitionSite {
  readonly block: number;
  readonly index: number;
}

/** Conservative dominance guard for a forwarded value. */
function dominatesUse(
  fn: MFunction,
  dominators: ReadonlyMap<number, number>,
  sites: ReadonlyMap<MInst, DefinitionSite>,
  value: ValueId,
  useBlock: number,
  useIndex: number,
): boolean {
  const definition = fn.values[value]?.def;
  if (definition === undefined) return false;
  if ('insts' in definition) {
    return definition.id === useBlock
      ? definition.params.includes(value)
      : dominates(dominators, definition.id, useBlock);
  }
  const site = sites.get(definition);
  if (site === undefined) return false;
  if (site.block === useBlock) return site.index < useIndex;
  return dominates(dominators, site.block, useBlock);
}

/**
 * Run load elimination on one function. Returns the number of replaced loads.
 *
 * `options.storeForwarding` defaults to `true`; the step-observer mode of J7
 * passes `false` because `beforeStep` may observe storage at any step.
 */
export function runLoadElim(
  fn: MFunction,
  context: MemoryPassContext,
  options: { readonly storeForwarding?: boolean } = {},
): number {
  const forwardStores = options.storeForwarding !== false;
  // Representation analysis is needed to reject `U` float store values.
  analyzeRepresentation(fn);
  const cfg: CFG = buildCFG(fn);
  const dominators = computeDominators(cfg);
  const reachable = new Set(cfg.order);
  const sites = new Map<MInst, DefinitionSite>();
  for (const block of fn.blocks) {
    block.insts.forEach((inst, index) => sites.set(inst, { block: block.id, index }));
  }

  const inState = new Map<number, State>();
  const outState = new Map<number, State>();
  for (const id of cfg.order) {
    inState.set(id, new Map());
    outState.set(id, new Map());
  }

  const blockById = new Map(fn.blocks.map((block) => [block.id, block]));
  let changed = true;
  let rounds = 0;
  while (changed && rounds < 10_000) {
    changed = false;
    rounds += 1;
    for (const id of cfg.order) {
      const block = blockById.get(id)!;
      let input: State;
      if (id === cfg.entry) {
        input = new Map();
      } else {
        const preds = (cfg.preds.get(id) ?? []).filter((pred) => reachable.has(pred));
        if (preds.length === 0) {
          input = new Map();
        } else {
          input = clone(outState.get(preds[0]!)!);
          for (let index = 1; index < preds.length; index += 1) {
            input = intersect(input, outState.get(preds[index]!)!);
          }
        }
      }
      inState.set(id, input);
      const output = clone(input);
      runInstructions(fn, context, block.insts, output, forwardStores);
      if (!sameState(output, outState.get(id)!)) {
        outState.set(id, output);
        changed = true;
      }
    }
  }
  if (changed) {
    // The availability lattice only grows; failing to converge would mean the
    // transfer function is not monotone, and continuing would be unsound.
    throw new Error('MIR load elimination failed: dataflow did not converge');
  }

  let replaced = 0;
  for (const id of cfg.order) {
    const block = blockById.get(id)!;
    const state = clone(inState.get(id)!);
    block.insts.forEach((inst, index) => {
      const replacement = transfer(fn, context, inst, state, forwardStores);
      if (replacement === undefined || inst.results.length !== 1) return;
      if (!dominatesUse(fn, dominators, sites, replacement, id, index)) return;
      const next: MInst = {
        op: Op.Forward,
        args: [replacement],
        results: [...inst.results],
        imm: [],
        refs: [],
        node: inst.node,
        loc: inst.loc,
        step: 1,
      };
      block.insts[index] = next;
      for (const result of next.results) fn.values[result]!.def = next;
      sites.delete(inst);
      sites.set(next, { block: id, index });
      replaced += 1;
    });
  }
  return replaced;
}
