/**
 * Redundant load elimination and store forwarding (J12 / O03, `loadElim`).
 *
 * The pass tracks, for every storage location, the SSA value that is currently
 * stored there. Availability is a two-level table
 *
 * ```text
 * AvailableLoads = Map<Resource, Map<Index, ValueId>>
 * ```
 *
 * where a resource is one `state` resource, one `array` resource, or one
 * `(bytes resource, access type, endianness)` triple, and the index is the
 * constant element index (or `0` for `state`, the constant byte offset for
 * `bytes`). A load whose location is available is replaced by
 * {@link Op.Forward}, a step-preserving copy of that value. The replacement
 * keeps the original `node`/`loc`, so diagnostics and step accounting are
 * unchanged; a load that could throw is only elided after a previous access to
 * the same location succeeded (the only way the location becomes available).
 *
 * ## Dominator scope
 *
 * Availability is *not* limited to one basic block. Blocks are visited in
 * dominator-tree preorder ({@link dominatorPreorder}) and each block starts
 * from the availability of its immediate dominator, so a load in a block `A`
 * is reused by every block `B` that `A` dominates. At a control-flow merge the
 * block entry keeps only the loads that every predecessor has available
 * (intersection of the predecessor out-states); a value is therefore only
 * forwarded when it is available on *all* paths that reach the use. Iterating
 * those rounds to a fixed point gives a loop body the availability of its
 * preheader while still intersecting with the back edge.
 *
 * Availability sources are loads (their result) and stores (the stored value).
 * It is invalidated by:
 *
 * - host instructions (`executor`, events, bridge, `call`, `checkpoint`),
 *   which may read and write anything;
 * - `store r[i]`: all loads of `r` (a possibly aliasing index invalidates the
 *   whole resource; a different constant index of the same `array` cannot
 *   alias and is kept);
 * - `spill`, which writes promoted locals back into storage;
 * - `return`, `dispatch` and `trap`, which leave the function.
 *
 * Promoted locations are locals after `scalarPromotion`, so they have no
 * remaining `state.load` / `array.load` for this pass to see; a load that
 * survives promotion is eliminated here across blocks.
 *
 * Float store forwarding is restricted to `D` values: storage canonicalizes
 * bit strings, so a `U` value (possibly uppercase) can change bit pattern on a
 * store/load round trip. Bytes entries are tracked only for constant offsets
 * and only forward between identical type/endian/width accesses.
 */
import { buildCFG, computeDominators, dominates } from '../cfg';
import type { CFG, Dominators } from '../cfg';
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

/** One value known to be stored in a location. */
interface Available {
  readonly value: ValueId;
  /** Byte offset inside a `bytes` resource (`0` for `state`/`array`). */
  readonly offset: number;
  /** Byte width of the access that produced the entry. */
  readonly width: number;
}

/** Index (element index, `0` for `state`, byte offset for `bytes`) → value. */
type Loads = Map<number, Available>;

/** Resource → per-index available loads. */
type AvailableLoads = Map<string, Loads>;

/**
 * Key of one independently tracked resource. `state` and `array` resources
 * never alias anything else; `bytes` resources are additionally split by the
 * access type and endianness because only identical accesses may forward.
 */
function stateResource(memory: number): string {
  return `s${memory}`;
}

function arrayResource(memory: number): string {
  return `a${memory}`;
}

function bytesResource(memory: number, type: string, endian: string): string {
  return `b${memory}:${type}:${endian}`;
}

function bytesPrefix(memory: number): string {
  return `b${memory}:`;
}

function emptyLoads(): AvailableLoads {
  return new Map();
}

function cloneLoads(loads: AvailableLoads): AvailableLoads {
  const copy: AvailableLoads = new Map();
  for (const [resource, entries] of loads) copy.set(resource, new Map(entries));
  return copy;
}

function sameLoads(left: AvailableLoads, right: AvailableLoads): boolean {
  if (left.size !== right.size) return false;
  for (const [resource, entries] of left) {
    const other = right.get(resource);
    if (other === undefined || other.size !== entries.size) return false;
    for (const [index, entry] of entries) {
      if (other.get(index)?.value !== entry.value) return false;
    }
  }
  return true;
}

/** Keep only entries that are identically available on both paths. */
function intersectLoads(left: AvailableLoads, right: AvailableLoads): AvailableLoads {
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  const result: AvailableLoads = new Map();
  for (const [resource, entries] of small) {
    const other = large.get(resource);
    if (other === undefined) continue;
    let kept: Loads | undefined;
    for (const [index, entry] of entries) {
      if (other.get(index)?.value !== entry.value) continue;
      if (kept === undefined) kept = new Map();
      kept.set(index, entry);
    }
    if (kept !== undefined) result.set(resource, kept);
  }
  return result;
}

function put(loads: AvailableLoads, resource: string, index: number, entry: Available): void {
  let entries = loads.get(resource);
  if (entries === undefined) {
    entries = new Map();
    loads.set(resource, entries);
  }
  entries.set(index, entry);
}

function killIndex(loads: AvailableLoads, resource: string, index: number): void {
  const entries = loads.get(resource);
  if (entries === undefined) return;
  entries.delete(index);
  if (entries.size === 0) loads.delete(resource);
}

/** Drop every tracked load of `resource` (all indices). */
function killResource(loads: AvailableLoads, resource: string): void {
  loads.delete(resource);
}

function killAll(loads: AvailableLoads): void {
  if (loads.size > 0) loads.clear();
}

function killArrayMemory(loads: AvailableLoads, memory: number): void {
  killResource(loads, arrayResource(memory));
}

function killBytesMemory(loads: AvailableLoads, memory: number): void {
  const prefix = bytesPrefix(memory);
  for (const key of [...loads.keys()]) {
    if (key.startsWith(prefix)) loads.delete(key);
  }
}

/** Drop every byte entry of `memory` whose interval may overlap `[offset, offset+width)`. */
function killBytesRange(
  loads: AvailableLoads,
  memory: number,
  offset: number,
  width: number,
): void {
  const prefix = bytesPrefix(memory);
  for (const [resource, entries] of [...loads]) {
    if (!resource.startsWith(prefix)) continue;
    for (const [index, entry] of [...entries]) {
      if (entry.offset < offset + width && offset < entry.offset + entry.width) {
        entries.delete(index);
      }
    }
    if (entries.size === 0) loads.delete(resource);
  }
}

/**
 * Apply one instruction to `loads` and return the value that replaces its
 * result, when the instruction is a forwarded load.
 */
function transfer(
  fn: MFunction,
  context: MemoryPassContext,
  inst: MInst,
  loads: AvailableLoads,
  forwardStores: boolean,
): ValueId | undefined {
  switch (inst.op) {
    case Op.StateLoad: {
      const memory = inst.refs[0]!;
      const resource = stateResource(memory);
      const available = loads.get(resource)?.get(0);
      if (available !== undefined) return available.value;
      const result = inst.results[0];
      const layout = scalarLayout(context, memory, 'state');
      if (result !== undefined && layout !== undefined) {
        put(loads, resource, 0, {
          value: result,
          offset: 0,
          width: NUMERIC_BYTES[layout.scalarType as NumericType] ?? 1,
        });
      }
      return undefined;
    }
    case Op.StateStore: {
      const memory = inst.refs[0]!;
      const layout = scalarLayout(context, memory, 'state');
      if (layout === undefined) return undefined;
      const resource = stateResource(memory);
      const value = inst.args[0];
      if (value !== undefined && forwardStores && canForwardStore(fn, value, layout.scalarType)) {
        put(loads, resource, 0, {
          value,
          offset: 0,
          width: NUMERIC_BYTES[layout.scalarType as NumericType] ?? 1,
        });
      } else {
        killIndex(loads, resource, 0);
      }
      return undefined;
    }
    case Op.ArrayLoad: {
      const memory = inst.refs[0]!;
      const index = constantNumber(fn, inst.args[0]!);
      if (index === undefined) return undefined;
      const resource = arrayResource(memory);
      const available = loads.get(resource)?.get(index);
      if (available !== undefined) return available.value;
      const result = inst.results[0];
      const layout = scalarLayout(context, memory, 'array');
      if (result !== undefined && layout !== undefined) {
        put(loads, resource, index, {
          value: result,
          offset: 0,
          width: NUMERIC_BYTES[layout.scalarType as NumericType] ?? 1,
        });
      }
      return undefined;
    }
    case Op.ArrayStore: {
      const memory = inst.refs[0]!;
      const index = constantNumber(fn, inst.args[0]!);
      const layout = scalarLayout(context, memory, 'array');
      if (layout === undefined) return undefined;
      // A store through an unknown index may hit any element of the resource.
      if (index === undefined) {
        killArrayMemory(loads, memory);
        return undefined;
      }
      const resource = arrayResource(memory);
      const value = inst.args[1];
      if (value !== undefined && forwardStores && canForwardStore(fn, value, layout.scalarType)) {
        put(loads, resource, index, {
          value,
          offset: 0,
          width: NUMERIC_BYTES[layout.scalarType as NumericType] ?? 1,
        });
      } else {
        killIndex(loads, resource, index);
      }
      return undefined;
    }
    case Op.BytesLoad: {
      const memory = inst.refs[0]!;
      const type = inst.imm[0] as NumericType;
      const endian = inst.imm[1] as Endian;
      const offset = constantNumber(fn, inst.args[0]!);
      if (offset === undefined || byteLength(context, memory) === undefined) return undefined;
      const resource = bytesResource(memory, type, endian);
      const available = loads.get(resource)?.get(offset);
      if (available !== undefined) return available.value;
      const result = inst.results[0];
      if (result !== undefined) {
        put(loads, resource, offset, {
          value: result,
          offset,
          width: NUMERIC_BYTES[type] ?? 1,
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
        killBytesMemory(loads, memory);
        return undefined;
      }
      const width = NUMERIC_BYTES[type] ?? 1;
      // A store may alias the bytes of any other tracked interval.
      killBytesRange(loads, memory, offset, width);
      const resource = bytesResource(memory, type, endian);
      const value = inst.args[1];
      if (value !== undefined && forwardStores && canForwardStore(fn, value, type)) {
        put(loads, resource, offset, { value, offset, width });
      } else {
        killIndex(loads, resource, offset);
      }
      return undefined;
    }
    case Op.BytesCopy:
    case Op.ResourceUpdateBytes: {
      const destination = inst.refs[0];
      if (destination !== undefined) killBytesMemory(loads, destination);
      return undefined;
    }
    case Op.ResourceFillBytes: {
      const memory = inst.refs[0];
      if (memory !== undefined) killBytesMemory(loads, memory);
      return undefined;
    }
    case Op.Spill:
      // A spill writes promoted locals back into the backing view and does not
      // name the written locations, so nothing may survive it.
      killAll(loads);
      return undefined;
    default:
      if (isFullBarrier(inst)) killAll(loads);
      return undefined;
  }
}

function runInstructions(
  fn: MFunction,
  context: MemoryPassContext,
  insts: readonly MInst[],
  loads: AvailableLoads,
  forwardStores: boolean,
): void {
  for (const inst of insts) transfer(fn, context, inst, loads, forwardStores);
}

interface DefinitionSite {
  readonly block: number;
  readonly index: number;
}

/** Conservative dominance guard for a forwarded value. */
function dominatesUse(
  fn: MFunction,
  dominators: Dominators,
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
 * Reachable blocks in dominator-tree preorder: every block appears after its
 * immediate dominator, which lets the analysis seed a block from
 * `outState(idom)` before looking at the remaining predecessors.
 */
function dominatorPreorder(cfg: CFG, dominators: Dominators): number[] {
  const children = new Map<number, number[]>();
  for (const id of cfg.order) {
    if (id === cfg.entry) continue;
    const parent = dominators.get(id);
    if (parent === undefined || parent === id) continue;
    const list = children.get(parent);
    if (list === undefined) children.set(parent, [id]);
    else list.push(id);
  }
  const order: number[] = [];
  const seen = new Set<number>();
  const stack = [cfg.entry];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    const list = children.get(id);
    if (list === undefined) continue;
    // Reverse so the first dominator-tree child is visited first.
    for (let index = list.length - 1; index >= 0; index -= 1) stack.push(list[index]!);
  }
  // Defensive: a block without an idom would only follow a malformed dominator
  // set; analyze it anyway instead of silently skipping its loads.
  for (const id of cfg.order) if (!seen.has(id)) order.push(id);
  return order;
}

/**
 * Entry availability of one block: inherit the immediate dominator's out-state
 * and keep only what every other predecessor also has available (intersection
 * at a control-flow merge).
 */
function mergePredecessors(
  id: number,
  cfg: CFG,
  dominators: Dominators,
  reachable: ReadonlySet<number>,
  outState: ReadonlyMap<number, AvailableLoads>,
): AvailableLoads {
  if (id === cfg.entry) return emptyLoads();
  const preds = (cfg.preds.get(id) ?? []).filter((pred) => reachable.has(pred));
  if (preds.length === 0) return emptyLoads();
  const idom = dominators.get(id);
  const first = idom !== undefined && preds.includes(idom) ? idom : preds[0]!;
  let loads = cloneLoads(outState.get(first)!);
  for (const pred of preds) {
    if (pred === first || loads.size === 0) continue;
    loads = intersectLoads(loads, outState.get(pred)!);
  }
  return loads;
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
  const order = dominatorPreorder(cfg, dominators);
  const reachable = new Set(cfg.order);
  const sites = new Map<MInst, DefinitionSite>();
  for (const block of fn.blocks) {
    block.insts.forEach((inst, index) => sites.set(inst, { block: block.id, index }));
  }

  const inState = new Map<number, AvailableLoads>();
  const outState = new Map<number, AvailableLoads>();
  for (const id of cfg.order) {
    inState.set(id, emptyLoads());
    outState.set(id, emptyLoads());
  }

  const blockById = new Map(fn.blocks.map((block) => [block.id, block]));
  let changed = true;
  let rounds = 0;
  while (changed && rounds < 10_000) {
    changed = false;
    rounds += 1;
    for (const id of order) {
      const block = blockById.get(id)!;
      const input = mergePredecessors(id, cfg, dominators, reachable, outState);
      inState.set(id, input);
      const output = cloneLoads(input);
      runInstructions(fn, context, block.insts, output, forwardStores);
      if (!sameLoads(output, outState.get(id)!)) {
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
  for (const id of order) {
    const block = blockById.get(id)!;
    const loads = cloneLoads(inState.get(id)!);
    block.insts.forEach((inst, index) => {
      const replacement = transfer(fn, context, inst, loads, forwardStores);
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
