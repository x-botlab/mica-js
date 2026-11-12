export type PinSample = {
  voltage: number | null;
  level: 'low' | 'high' | 'unknown';
  status: 'valid' | 'floating';
};

export interface ElectricalPin {
  readonly id: string;
  readonly instance: string;
  readonly name: string;
  readonly low?: number;
  readonly high?: number;
  intent: readonly ResistorBranch[];
  sample: PinSample;
}

export interface ResistorBranch {
  readonly to: ElectricalPin;
  readonly resistance: number;
}

export interface NetInput {
  readonly id: string;
  readonly pins: readonly ElectricalPin[];
  readonly voltage?: number;
}

export type ElectricalErrorCode =
  'INVALID_ELECTRICAL_PARAMETER' | 'CONFLICTING_REFERENCE' | 'ELECTRICAL_SOLVE_FAILED';

export interface ElectricalErrorLocation {
  readonly instanceId?: string;
  readonly resource?: string;
  readonly network?: string;
  readonly networks?: readonly string[];
  readonly component?: readonly string[];
}

export class ElectricalError extends Error {
  readonly code: ElectricalErrorCode;
  readonly instanceId: string | undefined;
  readonly resource: string | undefined;
  readonly network: string | undefined;
  readonly networks: readonly string[] | undefined;
  readonly component: readonly string[] | undefined;
  readonly reason: string;

  constructor(code: ElectricalErrorCode, reason: string, location: ElectricalErrorLocation = {}) {
    super(reason);
    this.name = 'ElectricalError';
    this.code = code;
    this.reason = reason;
    this.instanceId = location.instanceId;
    this.resource = location.resource;
    this.network = location.network;
    this.networks = location.networks;
    this.component = location.component;
  }
}

/** Invoke at resistor construction, including branches never assigned to an intent. */
export function validateResistance(
  resistance: number,
  location: ElectricalErrorLocation = {},
): void {
  if (!Number.isFinite(resistance) || resistance < 0.001 || resistance > 1_000_000_000) {
    throw new ElectricalError(
      'INVALID_ELECTRICAL_PARAMETER',
      'Resistance must be finite and in [0.001, 1000000000] ohms.',
      location,
    );
  }
}

export interface ElectricalStats {
  /** Successful, atomically published solves, including the initial baseline. */
  readonly solves: number;
  readonly components: number;
  readonly floatingComponents: number;
  readonly factorizations: number;
  readonly factorizationReuses: number;
  readonly cacheHits: number;
  /** Distinct `(pin, target, resistance)` leaf shapes admitted for reuse. */
  readonly leafPlans: number;
  /** Solves served by replaying an admitted leaf plan instead of rebuilding edges. */
  readonly leafPropagations: number;
  /** Whole-graph rebuilds (`prepareTopology`); a bucket hit restores instead. */
  readonly topologyPrepares: number;
}

export interface ElectricalNetwork {
  /**
   * The caller establishes the initial observation baseline after the first solve.
   * Omit changedPins to detect intent identity changes automatically. When supplied,
   * it must include every pin assigned since the last successful solve; intents are immutable.
   * The first solve always reads all pins, regardless of this hint.
   */
  solve(changedPins?: Iterable<ElectricalPin>): readonly ElectricalPin[];
  /**
   * Slot-addressed form of :func:`solve` for callers that already know board pin slots.
   * Returns the changed slots in ascending board order; the array is valid until the next
   * solve call, so consumers must publish from it immediately.
   */
  solveSlots(changedSlots?: Iterable<number>): readonly number[];
  readonly stats: ElectricalStats;
}

interface Node {
  readonly pins: readonly ElectricalPin[];
  readonly networks: readonly string[];
  reference: number | undefined;
}

/**
 * A pin that keeps exactly one branch onto a node with a fixed potential. A node with one
 * incident branch carries no current by KCL, so its voltage equals the target's reference
 * voltage whatever else the target's component contains. Replaying an admitted shape
 * therefore needs no edge rebuild, no partition check and no matrix work.
 */
interface LeafPropagation {
  readonly targetPin: ElectricalPin;
  readonly resistance: number;
  readonly target: number;
  readonly edges: readonly Edge[];
  /** Node of the switching pin and the sample every pin on it takes for this target. */
  readonly node: number;
  readonly voltage: number;
  readonly slots: readonly number[];
  readonly pins: readonly ElectricalPin[];
  readonly samples: readonly PinSample[];
}

interface Edge {
  readonly pin: number;
  readonly index: number;
  readonly from: number;
  readonly to: number;
  readonly resistance: number;
  readonly conductance: number;
}

interface Component {
  readonly nodes: number[];
  readonly edges: Edge[];
  readonly physical?: Component;
}

interface Factorization {
  readonly matrix: Float64Array;
  readonly anchors: Float64Array;
  readonly pivots: Float64Array;
  readonly weights: Float64Array;
}

interface CachedComponent {
  readonly edges: readonly Edge[];
  readonly voltages: readonly (number | null)[];
  readonly factorization: Factorization | undefined;
}

interface PreparedBlock {
  readonly component: Component;
  readonly key: string;
}

interface PreparedTopology {
  readonly blocks: PreparedBlock[];
  /** Stable pin/branch slots allow equivalent older Edge objects to be shared. */
  readonly edgeBlocks: readonly (readonly (number | undefined)[] | undefined)[];
  readonly components: number;
  readonly floatingComponents: number;
  /** Component index per node; reference nodes never migrate, so it survives local updates. */
  readonly nodeComponents: number[];
  /** 1 when every fixed potential inside the node's component is the same value. */
  readonly nodeUniform: number[];
}

interface PinUpdate {
  readonly intent: readonly ResistorBranch[];
  readonly edges: readonly Edge[];
}

/** Dirty pin edges indexed by slot; `undefined` means the pin kept its committed edges. */
type PinUpdates = readonly (readonly Edge[] | undefined)[];

interface TopologySnapshot {
  readonly id: number;
  readonly cost: number;
  readonly topology: PreparedTopology;
  /** Per-pin endpoint hashes the graph was built from; confirms a bucket hit exactly. */
  readonly hashes: Uint32Array;
}

/**
 * Descriptors and admitted graphs share these buckets. The budget covers a whole-board
 * working set: a 288-pin board steps through roughly 1.2k distinct shapes in 300 ms, so
 * the former limit of eight discarded every descriptor before its second observation could
 * ever admit a graph.
 */
const topologyTransitionLimit = 4096;
/** Compiled reference programs cost far more per entry than a graph descriptor. */
const referenceProgramLimit = 8;
const topologySnapshotLimit = 65_536;

/** FNV-1a over the pin slot and its ordered endpoints: the key without the 288 strings. */
function hashEdges(slot: number, edges: readonly Edge[]): number {
  let hash = Math.imul(0x811c9dc5 ^ slot, 0x01000193);
  for (let index = 0; index < edges.length; index++) {
    hash = Math.imul(hash ^ edges[index]!.to, 0x01000193);
  }
  return Math.imul(hash ^ edges.length, 0x01000193) >>> 0;
}

function topologyCost(topology: PreparedTopology): number {
  let cost = 0;
  const physicals = new Set<Component>();
  for (const block of topology.blocks) {
    cost += block.component.nodes.length + 2 * block.component.edges.length;
    const physical = block.component.physical;
    if (physical !== undefined && !physicals.has(physical)) {
      physicals.add(physical);
      cost += physical.nodes.length + physical.edges.length;
    }
    if (cost > topologySnapshotLimit) break;
  }
  return cost;
}

function rebindBlock(
  block: PreparedBlock,
  pinEdges: readonly (readonly Edge[])[],
  updates: PinUpdates,
): PreparedBlock {
  let edges: Edge[] | undefined;
  for (let index = 0; index < block.component.edges.length; index++) {
    const edge = block.component.edges[index]!;
    const next = (updates[edge.pin] ?? pinEdges[edge.pin]!)[edge.index]!;
    if (edge.from === next.from && edge.to === next.to && edge.resistance === next.resistance)
      continue;
    edges ??= block.component.edges.slice();
    edges[index] = next;
  }
  if (edges === undefined) return block;
  return { ...block, component: { ...block.component, edges } };
}

/**
 * Every block edge is re-read from the committed pin edges. A bucket key records
 * connectivity only, so a resistance-only change keeps its key and still has to be
 * repaired in blocks that no pin of this solve touches.
 */
function restoreTopology(
  topology: PreparedTopology,
  pinEdges: readonly (readonly Edge[])[],
  updates: PinUpdates,
): PreparedTopology {
  let blocks: PreparedBlock[] | undefined;
  for (let index = 0; index < topology.blocks.length; index++) {
    const previous = topology.blocks[index]!;
    const block = rebindBlock(previous, pinEdges, updates);
    if (block === previous) continue;
    blocks ??= topology.blocks.slice();
    blocks[index] = block;
  }
  return blocks === undefined ? topology : { ...topology, blocks };
}

function prepareBlock(component: Component): PreparedBlock {
  return { component, key: component.nodes.join(',') };
}

function prepareTopology(
  nodes: readonly Node[],
  pinEdges: readonly (readonly Edge[])[],
): PreparedTopology {
  const topology = new DisjointSet(nodes.length);
  for (const edges of pinEdges) {
    for (const edge of edges) topology.join(edge.from, edge.to);
  }
  const groups = new Map<number, Component>();
  for (let node = 0; node < nodes.length; node++) {
    const root = topology.find(node);
    let group = groups.get(root);
    if (group === undefined) {
      group = { nodes: [], edges: [] };
      groups.set(root, group);
    }
    group.nodes.push(node);
  }
  for (const edges of pinEdges) {
    for (const edge of edges) groups.get(topology.find(edge.from))!.edges.push(edge);
  }
  let floatingComponents = 0;
  const blocks: PreparedBlock[] = [];
  const edgeBlocks: (number | undefined)[][] = [];
  const nodeComponents: number[] = new Array<number>(nodes.length);
  const nodeUniform: number[] = new Array<number>(nodes.length);
  let componentIndex = 0;
  for (const component of groups.values()) {
    let reference: number | undefined;
    let floating = true;
    let uniform = 1;
    for (const node of component.nodes) {
      const potential = nodes[node]!.reference;
      if (potential === undefined) continue;
      floating = false;
      if (reference === undefined) reference = potential;
      else if (potential !== reference) uniform = 0;
    }
    if (floating) floatingComponents++;
    for (const node of component.nodes) {
      nodeComponents[node] = componentIndex;
      nodeUniform[node] = uniform;
    }
    componentIndex++;
    for (const block of solveBlocks(component, nodes)) {
      const index = blocks.length;
      blocks.push(prepareBlock(block));
      for (const edge of block.edges) (edgeBlocks[edge.pin] ??= [])[edge.index] = index;
    }
  }
  return {
    blocks,
    edgeBlocks,
    components: groups.size,
    floatingComponents,
    nodeComponents,
    nodeUniform,
  };
}

const cleanZero = (value: number): number => (value === 0 ? 0 : value);

function pinLocation(pin: ElectricalPin): ElectricalErrorLocation {
  return { instanceId: pin.instance, resource: pin.name };
}

class DisjointSet {
  private readonly parents: number[];

  constructor(count: number) {
    this.parents = new Array<number>(count);
    for (let index = 0; index < count; index++) this.parents[index] = index;
  }

  find(index: number): number {
    let root = index;
    while (this.parents[root] !== root) root = this.parents[root]!;
    while (index !== root) {
      const next = this.parents[index]!;
      this.parents[index] = root;
      index = next;
    }
    return root;
  }

  join(first: number, second: number): void {
    const a = this.find(first);
    const b = this.find(second);
    if (a !== b) this.parents[Math.max(a, b)] = Math.min(a, b);
  }
}

function solveBlocks(component: Component, nodes: readonly Node[]): Component[] {
  let unknownCount = 0;
  let reference: number | undefined;
  let mixedReferences = false;
  for (const node of component.nodes) {
    const potential = nodes[node]!.reference;
    if (potential === undefined) unknownCount++;
    else if (reference === undefined) reference = potential;
    else if (potential !== reference) mixedReferences = true;
  }
  if (unknownCount < 2 || !mixedReferences) return [component];
  const slots = new Map<number, number>();
  for (const node of component.nodes) {
    if (nodes[node]!.reference === undefined) slots.set(node, slots.size);
  }
  const topology = new DisjointSet(unknownCount);
  let coupled = false;
  for (const edge of component.edges) {
    const from = slots.get(edge.from);
    const to = slots.get(edge.to);
    if (from !== undefined && to !== undefined) {
      topology.join(from, to);
      coupled = true;
    }
  }
  // Tiny independent systems cost less as one matrix than as individual blocks.
  if (!coupled && unknownCount <= 32) return [component];
  const groups = new Array<Component | undefined>(unknownCount);
  const blocks: Component[] = [];
  for (let index = 0; index < unknownCount; index++) {
    const root = topology.find(index);
    let group = groups[root];
    if (group === undefined) {
      group = { nodes: [], edges: [], physical: component };
      blocks.push(group);
    }
    // Union roots are minimum slots, so their groups are initialized first.
    groups[index] = group;
  }
  if (blocks.length === 1) return [component];
  const boundaries = new Map<number, Component[]>();
  // Fixed potentials are boundary values, not couplings between unknowns.
  for (const edge of component.edges) {
    const from = slots.get(edge.from);
    const to = slots.get(edge.to);
    const unknownSlot = from ?? to;
    if (unknownSlot === undefined) continue;
    const group = groups[unknownSlot]!;
    group.edges.push(edge);
    const boundary = from === undefined ? edge.from : to === undefined ? edge.to : undefined;
    if (boundary === undefined) continue;
    let adjacent = boundaries.get(boundary);
    if (adjacent === undefined) {
      adjacent = [];
      boundaries.set(boundary, adjacent);
    }
    adjacent.push(group);
  }
  // Physical nodes are already sorted; append each boundary once per block.
  for (const node of component.nodes) {
    const slot = slots.get(node);
    if (slot !== undefined) groups[slot]!.nodes.push(node);
    else {
      const adjacent = boundaries.get(node);
      if (adjacent === undefined) continue;
      for (const group of adjacent) {
        if (group.nodes[group.nodes.length - 1] !== node) group.nodes.push(node);
      }
    }
  }
  return blocks;
}

/** Compensated summation also preserves small positive grounding contributions. */
function sum(values: Iterable<number>): number {
  let total = 0;
  let correction = 0;
  for (const value of values) {
    const next = total + value;
    correction += Math.abs(total) >= Math.abs(value) ? total - next + value : value - next + total;
    total = next;
  }
  return total + correction;
}

function arraysEqual(first: Float64Array, second: Float64Array): boolean {
  if (first === second) return true;
  if (first.length !== second.length) return false;
  for (let index = 0; index < first.length; index++) {
    if (first[index] !== second[index]) return false;
  }
  return true;
}

function sameConfiguration(previous: CachedComponent, component: Component): boolean {
  if (previous.edges.length !== component.edges.length) return false;
  for (let index = 0; index < previous.edges.length; index++) {
    const edge = previous.edges[index]!;
    const other = component.edges[index]!;
    if (edge.from !== other.from || edge.to !== other.to || edge.resistance !== other.resistance)
      return false;
  }
  return true;
}

function factorize(
  matrix: Float64Array,
  anchors: Float64Array,
  fail: (reason: string) => never,
): Factorization {
  const count = anchors.length;
  if (matrix.length === 0) {
    for (const pivot of anchors) {
      if (!(pivot > 0) || !Number.isFinite(pivot)) fail('Invalid LDL pivot.');
    }
    return { matrix, anchors, pivots: anchors, weights: new Float64Array(0) };
  }
  const work = matrix.slice();
  const grounding = anchors.slice();
  const pivots = new Float64Array(count);
  const weights = new Float64Array(count * count);
  for (let row = 0; row < count; row++) {
    const offset = row * count;
    const terms = [grounding[row]!];
    for (let column = row + 1; column < count; column++) terms.push(work[offset + column]!);
    const pivot = sum(terms);
    if (!(pivot > 0) || !Number.isFinite(pivot)) fail('Invalid LDL pivot.');
    pivots[row] = pivot;
    for (let column = row + 1; column < count; column++) {
      const conductance = work[offset + column]!;
      if (conductance === 0) continue;
      const weight = conductance / pivot;
      if (!(weight > 0) || !Number.isFinite(weight)) fail('Unrepresentable LDL coefficient.');
      weights[offset + column] = weight;
    }
    // Positive star-mesh Schur updates avoid subtracting almost equal diagonals.
    // The retained grounding term keeps even very weak reference paths intact.
    for (let first = row + 1; first < count; first++) {
      const conductance = work[offset + first]!;
      if (conductance === 0) continue;
      const ground = conductance * (grounding[row]! / pivot);
      if (grounding[row]! > 0 && !(ground > 0)) fail('Reference coefficient underflow.');
      grounding[first] = grounding[first]! + ground;
      for (let second = first + 1; second < count; second++) {
        const weight = weights[offset + second]!;
        if (weight === 0) continue;
        const fill = conductance * weight;
        if (!(fill > 0)) fail('Schur coefficient underflow.');
        const slot = first * count + second;
        work[slot] = work[slot]! + fill;
      }
    }
  }
  return { matrix, anchors, pivots, weights };
}

function substitute(
  factorization: Factorization,
  right: Float64Array,
  fail: (reason: string) => never,
): Float64Array {
  const { weights, pivots } = factorization;
  const count = right.length;
  const solution = new Float64Array(count);
  if (weights.length === 0) {
    for (let row = 0; row < count; row++) {
      solution[row] = right[row]! / pivots[row]!;
      if (!Number.isFinite(solution[row])) fail('Non-finite backward substitution.');
    }
  } else {
    const forward = new Float64Array(count);
    for (let row = 0; row < count; row++) {
      const terms = [right[row]!];
      for (let column = 0; column < row; column++) {
        terms.push(weights[column * count + row]! * forward[column]!);
      }
      forward[row] = sum(terms);
      if (!Number.isFinite(forward[row])) fail('Non-finite forward substitution.');
    }
    for (let row = count - 1; row >= 0; row--) {
      const terms = [forward[row]! / pivots[row]!];
      for (let column = row + 1; column < count; column++) {
        terms.push(weights[row * count + column]! * solution[column]!);
      }
      solution[row] = sum(terms);
      if (!Number.isFinite(solution[row])) fail('Non-finite backward substitution.');
    }
  }
  return solution;
}

interface ReferenceProgram {
  matches(edges: readonly Edge[], unknown: readonly number[]): boolean;
  assemble(
    edges: readonly Edge[],
    conductanceScale: number,
    voltageScale: number,
  ): { anchors: Float64Array; right: Float64Array };
}

/** Changed pins publish in ascending board slot order; slots are already that order. */
function ascendingSlot(first: number, second: number): number {
  return first - second;
}

function sumPair(first: number, second: number): number {
  first = 0 + first;
  const total = first + second;
  const correction =
    Math.abs(first) >= Math.abs(second) ? first - total + second : second - total + first;
  return total + correction;
}

function compileReferenceProgram(
  unknown: readonly number[],
  edges: readonly Edge[],
  slots: ReadonlyMap<number, number>,
  nodes: readonly Node[],
): ReferenceProgram | undefined {
  if (unknown.length > 32 || edges.length > 128) return undefined;
  const rows: number[][] = Array.from({ length: unknown.length }, () => []);
  const guards = [`unknown.length === ${unknown.length}`, `edges.length === ${edges.length}`];
  const references: string[] = [];
  for (let index = 0; index < edges.length; index++) {
    const edge = edges[index]!;
    const from = slots.get(edge.from);
    const to = slots.get(edge.to);
    if (from !== undefined && to !== undefined) return undefined;
    if (from === undefined && to === undefined) {
      guards.push(
        `nodes[edges[${index}].from].reference !== undefined`,
        `nodes[edges[${index}].to].reference !== undefined`,
      );
      continue;
    }
    const row = from ?? to!;
    if (rows[row]!.length === 2) return undefined;
    rows[row]!.push(index);
    const fixed = from === undefined ? 'from' : 'to';
    const variable = from === undefined ? 'to' : 'from';
    references[index] = `nodes[edges[${index}].${fixed}].reference`;
    guards.push(
      `edges[${index}].${variable} === unknown[${row}]`,
      `${references[index]} !== undefined`,
    );
  }
  if (rows.some((row) => row.length === 0)) return undefined;
  const assembly: string[] = [];
  for (let row = 0; row < rows.length; row++) {
    const indices = rows[row]!;
    const reduce = (terms: readonly string[]): string =>
      terms.length === 1 ? `(0 + ${terms[0]})` : `pair(${terms.join(',')})`;
    for (const index of indices)
      assembly.push(`const g${index} = edges[${index}].conductance / gScale;`);
    assembly.push(
      `anchors[${row}] = ${reduce(indices.map((index) => `g${index}`))};`,
      `right[${row}] = ${reduce(indices.map((index) => `g${index} * (${references[index]} / vScale)`))};`,
    );
  }
  // Bind closed reference rows while retaining their original compensated summation order.
  const factory = new Function(
    'pair',
    'nodes',
    `"use strict"; return {
      matches(edges, unknown) { return ${guards.join(' && ')}; },
      assemble(edges, gScale, vScale) {
        const anchors = new Float64Array(${unknown.length});
        const right = new Float64Array(${unknown.length});
        ${assembly.join('\n')}
        return { anchors, right };
      }
    };`,
  ) as (pair: typeof sumPair, nodes: readonly Node[]) => ReferenceProgram;
  return factory(sumPair, nodes);
}

export function createElectricalNetwork(
  inputPins: readonly ElectricalPin[],
  inputNets: readonly NetInput[],
): ElectricalNetwork {
  const pins = [...inputPins];
  const pinSlots = new Map(pins.map((pin, index) => [pin, index]));
  const assembly = new DisjointSet(pins.length);
  const nets = inputNets.map((net) => ({ id: net.id, pins: [...net.pins], voltage: net.voltage }));
  for (const pin of pins) {
    if (
      (pin.low === undefined) !== (pin.high === undefined) ||
      (pin.low !== undefined &&
        (!Number.isFinite(pin.low) || !Number.isFinite(pin.high) || !(pin.low < pin.high!)))
    ) {
      throw new ElectricalError(
        'INVALID_ELECTRICAL_PARAMETER',
        'Pin thresholds must both be omitted or finite with low < high.',
        pinLocation(pin),
      );
    }
  }
  const requirePin = (pin: ElectricalPin, network?: string): number => {
    const slot = pinSlots.get(pin);
    if (slot === undefined) {
      throw new ElectricalError(
        'INVALID_ELECTRICAL_PARAMETER',
        'Electrical endpoint is not part of this board.',
        network === undefined ? pinLocation(pin) : { network },
      );
    }
    return slot;
  };
  const requireEndpoint = (pin: ElectricalPin, owner: ElectricalPin): number => {
    const slot = pinSlots.get(pin);
    if (slot === undefined)
      throw new ElectricalError(
        'INVALID_ELECTRICAL_PARAMETER',
        'Electrical endpoint is not part of this board.',
        pinLocation(owner),
      );
    return slot;
  };
  const validResistance = (resistance: number): boolean =>
    Number.isFinite(resistance) && resistance >= 0.001 && resistance <= 1_000_000_000;
  for (const net of nets) {
    if (net.voltage !== undefined && !Number.isFinite(net.voltage)) {
      throw new ElectricalError('INVALID_ELECTRICAL_PARAMETER', 'Reference must be finite.', {
        network: net.id,
      });
    }
    let first: number | undefined;
    for (const pin of net.pins) {
      const slot = requirePin(pin, net.id);
      if (first === undefined) first = slot;
      else assembly.join(first, slot);
    }
  }
  const nodes: Node[] = [];
  /** Pin slots per node in ascending board order, so samples publish without lookups. */
  const nodeSlots: number[][] = [];
  const rootNodes = new Map<number, number>();
  const pinNodes = pins.map((pin, index) => {
    const root = assembly.find(index);
    let node = rootNodes.get(root);
    if (node === undefined) {
      node = nodes.length;
      rootNodes.set(root, node);
      nodes.push({ pins: [], networks: [], reference: undefined });
      nodeSlots.push([]);
    }
    (nodes[node]!.pins as ElectricalPin[]).push(pin);
    nodeSlots[node]!.push(index);
    return node;
  });
  for (const net of nets) {
    if (net.pins.length === 0) continue;
    const node = nodes[pinNodes[requirePin(net.pins[0]!, net.id)]!]!;
    (node.networks as string[]).push(net.id);
    if (net.voltage === undefined) continue;
    const reference = cleanZero(net.voltage);
    if (node.reference !== undefined && node.reference !== reference) {
      throw new ElectricalError('CONFLICTING_REFERENCE', 'Conflicting fixed potentials on a net.', {
        network: net.id,
        networks: Object.freeze([...node.networks]),
      });
    }
    node.reference = reference;
  }
  let cache = new Map<string, CachedComponent>();
  const referencePrograms: ReferenceProgram[] = [];
  let prepared: PreparedTopology | undefined;
  let nextTopologyId = 0;
  const transitions = new Map<string, TopologySnapshot | undefined>();
  /**
   * Per-pin endpoint hash. Their exact integer summary is the bucket key, so a repeated
   * shape costs one hash per dirty pin instead of a 288-entry string join.
   */
  const pinHashes = new Uint32Array(pins.length);
  let topologyHash = 0;
  let topologySpread = 0;
  for (let slot = 0; slot < pins.length; slot++) {
    const hash = hashEdges(slot, []);
    pinHashes[slot] = hash;
    topologyHash += hash;
    topologySpread ^= hash;
  }
  const setPinHash = (slot: number, edges: readonly Edge[]): void => {
    const hash = hashEdges(slot, edges);
    const previous = pinHashes[slot]!;
    if (hash === previous) return;
    pinHashes[slot] = hash;
    topologyHash += hash - previous;
    topologySpread ^= previous ^ hash;
  };
  /** Confirms a bucket hit against the exact hashes the stored graph was built from. */
  const lookupTransition = (key: string, updated: PinUpdates): TopologySnapshot | undefined => {
    const candidate = transitions.get(key);
    if (candidate === undefined) return undefined;
    const hashes = candidate.hashes;
    if (hashes.length !== pinHashes.length) return undefined;
    for (let slot = 0; slot < hashes.length; slot++) {
      const edges = updated[slot];
      const hash = edges === undefined ? pinHashes[slot]! : hashEdges(slot, edges);
      if (hashes[slot] !== hash) return undefined;
    }
    return candidate;
  };
  const rememberTransition = (key: string, admitted: TopologySnapshot): void => {
    if (admitted.cost > topologySnapshotLimit) return;
    if (!transitions.has(key)) {
      // A first observation retains only its bucket, never the graph; a repeated
      // observation admits the graph.
      transitions.set(key, undefined);
    } else if (transitions.get(key) !== admitted) transitions.set(key, admitted);
    // Map insertion order is age order, so eviction needs no scan.
    while (transitions.size > topologyTransitionLimit) {
      const oldest = transitions.keys().next().value;
      if (oldest === undefined) break;
      transitions.delete(oldest);
    }
  };
  const publishedVoltages: (number | null | undefined)[] = new Array(nodes.length);
  const intents: (readonly ResistorBranch[] | undefined)[] = new Array(pins.length);
  const pinEdges: (readonly Edge[])[] = Array.from({ length: pins.length }, () => []);
  const unchangedPins: readonly ElectricalPin[] = Object.freeze([]);
  /** Undirected incidence count per node, used to prove a node has no other branches. */
  const nodeDegree = new Int32Array(nodes.length);
  const updatedSlots: number[] = [];
  const updatedIntents: (readonly ResistorBranch[])[] = [];
  const updatedEdges: (readonly Edge[])[] = [];
  /** Dirty edges indexed by slot, so rebinding avoids a Map lookup per block edge. */
  const updatedEdgeLists: (readonly Edge[] | undefined)[] = new Array(pins.length);
  const updatedEdgeSlots: number[] = [];
  const replacedEdges: Edge[] = [];
  const pendingPins: ElectricalPin[] = [];
  const pendingSamples: PinSample[] = [];
  const seenSlots = new Int32Array(pins.length);
  let seenStamp = 0;
  /** Only the matrix partition is out of date; component arrays and buckets stay valid. */
  let blocksStale = false;
  /** Component arrays are copied before a local update mutates them, because admitted
   * topology snapshots keep referencing the arrays they were created with. */
  let componentArraysOwned = false;
  const syncDegrees = (previous: readonly Edge[], next: readonly Edge[]): void => {
    for (const edge of previous) {
      if (next.indexOf(edge) === -1) {
        nodeDegree[edge.from] = nodeDegree[edge.from]! - 1;
        nodeDegree[edge.to] = nodeDegree[edge.to]! - 1;
      }
    }
    for (const edge of next) {
      if (previous.indexOf(edge) === -1) {
        nodeDegree[edge.from] = nodeDegree[edge.from]! + 1;
        nodeDegree[edge.to] = nodeDegree[edge.to]! + 1;
      }
    }
  };
  const statistics = {
    solves: 0,
    components: 0,
    floatingComponents: 0,
    factorizations: 0,
    factorizationReuses: 0,
    cacheHits: 0,
    leafPlans: 0,
    leafPropagations: 0,
    topologyPrepares: 0,
  };
  const emptySlots: readonly number[] = Object.freeze([]);
  /** Dirty slots supplied by the caller, deduplicated in place without an iterator per pin. */
  const inputSlots: number[] = [];
  /** Changed pin slots of the last solve in ascending board order. */
  const changedSlots: number[] = [];
  /** Admitted leaf shapes per pin slot; a pin normally alternates between two references. */
  const leafPlans: (LeafPropagation[] | undefined)[] = new Array(pins.length);
  const leafSlots: number[] = [];
  const leafIntents: (readonly ResistorBranch[])[] = [];
  const leafEdges: (readonly Edge[])[] = [];
  const leafTargets: number[] = [];
  /** Matched admitted shape per batch position, so publishing reuses its bound payload. */
  const leafPayloads: (LeafPropagation | undefined)[] = [];
  /** Shapes proven by the current solve; they are admitted only after it is accepted. */
  const pendingAdmissions: {
    readonly slot: number;
    readonly branch: ResistorBranch;
    readonly target: number;
    readonly edges: readonly Edge[];
  }[] = [];
  /** Canonical immutable samples; published samples never change once created. */
  const referenceSamples = new Map<number, Partial<Record<PinSample['level'], PinSample>>>();
  const nextStamp = (): number => {
    if (++seenStamp === 0x7fffffff) {
      seenSlots.fill(0);
      seenStamp = 1;
    }
    return seenStamp;
  };
  const sampleFor = (voltage: number, level: PinSample['level']): PinSample => {
    let entry = referenceSamples.get(voltage);
    if (entry === undefined) {
      if (referenceSamples.size >= 256) referenceSamples.clear();
      entry = {};
      referenceSamples.set(voltage, entry);
    }
    let sample = entry[level];
    if (sample === undefined) {
      sample = Object.freeze({ voltage: cleanZero(voltage), level, status: 'valid' as const });
      entry[level] = sample;
    }
    return sample;
  };
  /**
   * Records `(pin, target, resistance)` once the general path proved the shape: one branch
   * from a leaf node straight onto a fixed reference. Replays are only allowed while the
   * intent still names that branch, the pin still has one incident edge, the pin node is
   * still an unknown leaf and the target node still carries a fixed potential.
   */
  const pinLevel = (pin: ElectricalPin, voltage: number): PinSample['level'] =>
    pin.low === undefined
      ? 'unknown'
      : voltage <= pin.low
        ? 'low'
        : voltage >= pin.high!
          ? 'high'
          : 'unknown';
  /**
   * Bind the publish payload of one admitted shape: the switching pin's node, its pins in
   * board order, and the immutable sample each of them takes on the fixed target voltage.
   * A replay therefore commits precomputed samples instead of re-deriving voltages, levels
   * and canonical samples on every publication.
   */
  const leafPlan = (
    slot: number,
    branch: ResistorBranch,
    target: number,
    edges: readonly Edge[],
  ): LeafPropagation => {
    const node = pinNodes[slot]!;
    const nodePins = nodeSlots[node]!;
    const voltage = nodes[target]!.reference!;
    const slots: number[] = [];
    const planPins: ElectricalPin[] = [];
    const samples: PinSample[] = [];
    for (let at = 0; at < nodePins.length; at++) {
      const nodeSlot = nodePins[at]!;
      const pinned = pins[nodeSlot]!;
      slots.push(nodeSlot);
      planPins.push(pinned);
      samples.push(sampleFor(voltage, pinLevel(pinned, voltage)));
    }
    return Object.freeze({
      targetPin: branch.to,
      resistance: branch.resistance,
      target,
      edges,
      node,
      voltage,
      slots: Object.freeze(slots),
      pins: Object.freeze(planPins),
      samples: Object.freeze(samples),
    });
  };
  const admitLeaf = (
    slot: number,
    branch: ResistorBranch,
    target: number,
    edges: readonly Edge[],
  ): void => {
    const plan = leafPlan(slot, branch, target, edges);
    const plans = leafPlans[slot];
    if (plans === undefined) {
      leafPlans[slot] = [plan];
      statistics.leafPlans++;
      return;
    }
    for (const existing of plans)
      if (existing.targetPin === branch.to && existing.resistance === branch.resistance) return;
    if (plans.length < 2) plans.push(plan);
    else plans[plans.length - 1] = plan;
    statistics.leafPlans++;
  };
  const flushAdmissions = (): void => {
    for (let index = 0; index < pendingAdmissions.length; index++) {
      const admission = pendingAdmissions[index]!;
      admitLeaf(admission.slot, admission.branch, admission.target, admission.edges);
    }
    pendingAdmissions.length = 0;
  };
  const matchLeaf = (
    slot: number,
    intent: readonly ResistorBranch[],
  ): LeafPropagation | undefined => {
    if (prepared === undefined || intent.length !== 1) return undefined;
    const plans = leafPlans[slot];
    if (plans === undefined) return undefined;
    const previous = pinEdges[slot]!;
    if (previous.length !== 1 || nodes[previous[0]!.to]!.reference === undefined) return undefined;
    const from = pinNodes[slot]!;
    if (nodeDegree[from] !== 1 || nodes[from]!.reference !== undefined) return undefined;
    const branch = intent[0]!;
    for (let index = 0; index < plans.length; index++) {
      const plan = plans[index]!;
      if (plan.targetPin !== branch.to || plan.resistance !== branch.resistance) continue;
      // The leaf node KCL pins its voltage to the target reference; whether that
      // component also carries another rail is irrelevant to this pin.
      return nodes[plan.target]!.reference === undefined ? undefined : plan;
    }
    return undefined;
  };
  /**
   * Inserts into an ascending list. A touched batch holds a handful of pins, so an
   * in-place insertion beats a comparator sort of the published slot order.
   */
  const pushOrdered = (list: number[], slot: number): void => {
    let position = list.length;
    while (position > 0 && list[position - 1]! > slot) {
      list[position] = list[position - 1]!;
      position--;
    }
    list[position] = slot;
  };
  /**
   * Publishes the accepted leaf batch: every pin on a touched node gets the reference
   * voltage, samples are committed as one batch, then intents, edges and degrees follow.
   * No pin, sample, intent or degree changes before the whole batch is accepted.
   */
  const applyLeaf = (count: number): void => {
    if (!componentArraysOwned) {
      prepared = {
        ...prepared!,
        nodeComponents: prepared!.nodeComponents.slice(),
        nodeUniform: prepared!.nodeUniform.slice(),
      };
      componentArraysOwned = true;
    }
    const nodeComponents = prepared!.nodeComponents;
    const nodeUniform = prepared!.nodeUniform;
    changedSlots.length = 0;
    pendingPins.length = 0;
    pendingSamples.length = 0;
    for (let position = 0; position < count; position++) {
      const node = pinNodes[leafSlots[position]!]!;
      const target = leafTargets[position]!;
      nodeComponents[node] = nodeComponents[target]!;
      nodeUniform[node] = nodeUniform[target]!;
      const plan = leafPayloads[position];
      if (plan !== undefined) {
        // Admitted shape: the target voltage, every pin on the node and each pin's
        // immutable sample were bound once, so only the current sample identity is checked.
        if (publishedVoltages[node] === plan.voltage) continue;
        const planSlots = plan.slots;
        for (let at = 0; at < planSlots.length; at++) {
          const pinned = plan.pins[at]!;
          const sample = plan.samples[at]!;
          if (pinned.sample === sample) continue;
          pushOrdered(changedSlots, planSlots[at]!);
          pendingPins.push(pinned);
          pendingSamples.push(sample);
        }
        continue;
      }
      const voltage = nodes[target]!.reference!;
      if (publishedVoltages[node] === voltage) continue;
      const slots = nodeSlots[node]!;
      for (let at = 0; at < slots.length; at++) {
        const slot = slots[at]!;
        const pin = pins[slot]!;
        const level: PinSample['level'] =
          pin.low === undefined
            ? 'unknown'
            : voltage <= pin.low
              ? 'low'
              : voltage >= pin.high!
                ? 'high'
                : 'unknown';
        const previous = pin.sample;
        if (
          previous.voltage !== voltage ||
          previous.level !== level ||
          previous.status !== 'valid'
        ) {
          pushOrdered(changedSlots, slot);
          pendingPins.push(pin);
          pendingSamples.push(sampleFor(voltage, level));
        }
      }
    }
    // No pin sample changes before the whole batch is accepted.
    for (let position = 0; position < pendingPins.length; position++)
      pendingPins[position]!.sample = pendingSamples[position]!;
    for (let position = 0; position < count; position++) {
      const slot = leafSlots[position]!;
      const target = leafTargets[position]!;
      const previousTarget = pinEdges[slot]![0]!.to;
      publishedVoltages[pinNodes[slot]!] = nodes[target]!.reference!;
      if (previousTarget !== target) {
        nodeDegree[previousTarget] = nodeDegree[previousTarget]! - 1;
        nodeDegree[target] = nodeDegree[target]! + 1;
      }
      intents[slot] = leafIntents[position]!;
      const edges = leafEdges[position]!;
      pinEdges[slot] = edges;
      setPinHash(slot, edges);
    }
    // Only the matrix partition is bypassed. The component arrays above were updated in
    // place and the buckets follow the committed edges, so the next general solve rebuilds
    // blocks from pinEdges without discarding the admitted graphs.
    blocksStale = true;
    statistics.solves++;
    statistics.leafPropagations++;
  };

  return {
    get stats(): ElectricalStats {
      return Object.freeze({ ...statistics });
    },
    solve(changedPins?: Iterable<ElectricalPin>): readonly ElectricalPin[] {
      const changed = runSolve(gatherPins(changedPins));
      if (changed.length === 0) return unchangedPins;
      const published: ElectricalPin[] = [];
      for (let position = 0; position < changed.length; position++)
        published.push(pins[changed[position]!]!);
      return Object.freeze(published);
    },
    solveSlots(changedSlotNumbers?: Iterable<number>): readonly number[] {
      // Publish fast path: the dirty set is already deduplicated, so a complete batch of
      // admitted leaf shapes needs neither a gathered array nor the generic solve
      // bookkeeping. Anything else re-enters the full solver, which repeats the match and
      // therefore keeps every guard on the slow path.
      //
      // The signature stays `Iterable<number>`: only inputs that are known to iterate
      // repeatedly may be probed and then replayed. Any other iterable could be a
      // one-shot generator, so it is materialised exactly once and both the probe and the
      // fallback read that owned array; probing first would consume the caller's iterator
      // and silently drop the remaining dirty slots.
      if (changedSlotNumbers === undefined) return runSolve(undefined);
      const reusable =
        changedSlotNumbers instanceof Set ||
        Array.isArray(changedSlotNumbers) ||
        (ArrayBuffer.isView(changedSlotNumbers) && Symbol.iterator in changedSlotNumbers);
      if (!reusable) {
        inputSlots.length = 0;
        for (const slot of changedSlotNumbers) inputSlots.push(slot);
      }
      const probe: Iterable<number> = reusable ? changedSlotNumbers : inputSlots;
      // A reusable input is gathered again for the solver; a materialised one is already
      // the solver's input.
      const gathered = (): readonly number[] | undefined =>
        reusable ? gatherSlots(changedSlotNumbers) : inputSlots;
      if (prepared !== undefined) {
        const stamp = nextStamp();
        let count = 0;
        let complete = true;
        for (const slot of probe) {
          if (seenSlots[slot] === stamp) continue;
          seenSlots[slot] = stamp;
          const intent = pins[slot]!.intent;
          if (intent === intents[slot]) continue;
          const plan = matchLeaf(slot, intent);
          if (plan === undefined) {
            complete = false;
            break;
          }
          leafSlots[count] = slot;
          leafIntents[count] = intent;
          leafEdges[count] = plan.edges;
          leafTargets[count] = plan.target;
          leafPayloads[count] = plan;
          count++;
        }
        if (complete) {
          if (count === 0) return runSolve(gathered());
          applyLeaf(count);
          return changedSlots.length === 0 ? emptySlots : changedSlots;
        }
      }
      return runSolve(gathered());
    },
  };

  function gatherPins(changedPins: Iterable<ElectricalPin> | undefined): number[] | undefined {
    if (changedPins === undefined) return undefined;
    inputSlots.length = 0;
    for (const pin of changedPins) inputSlots.push(requirePin(pin));
    return inputSlots;
  }
  function gatherSlots(changedSlotNumbers: Iterable<number> | undefined): number[] | undefined {
    if (changedSlotNumbers === undefined) return undefined;
    inputSlots.length = 0;
    for (const slot of changedSlotNumbers) inputSlots.push(slot);
    return inputSlots;
  }
  /**
   * One atomically published solve over `input` (dirty slots) or, when it is omitted, over
   * every pin. Returns the changed slots in ascending board order.
   */
  function runSolve(input: readonly number[] | undefined): readonly number[] {
    const initial = prepared === undefined;
    pendingAdmissions.length = 0;
    if (prepared !== undefined && !blocksStale && input !== undefined && input.length === 0) {
      statistics.solves++;
      statistics.cacheHits += prepared.blocks.length;
      return emptySlots;
    }
    updatedSlots.length = 0;
    updatedIntents.length = 0;
    updatedEdges.length = 0;
    replacedEdges.length = 0;
    let stamp = nextStamp();
    let topologyChanged = initial;
    // Structurally safe local updates never need the block partition to be rebuilt.
    let leafSwitch = prepared !== undefined && input !== undefined;
    if (leafSwitch) {
      // Precomputed leaf plan: replay the admitted shapes for the whole dirty batch.
      let count = 0;
      for (let position = 0; position < input!.length; position++) {
        const slot = input![position]!;
        if (seenSlots[slot] === stamp) continue;
        seenSlots[slot] = stamp;
        const intent = pins[slot]!.intent;
        if (intent === intents[slot]) continue;
        const plan = matchLeaf(slot, intent);
        if (plan === undefined) {
          count = -1;
          break;
        }
        leafSlots[count] = slot;
        leafIntents[count] = intent;
        leafEdges[count] = plan.edges;
        leafTargets[count] = plan.target;
        leafPayloads[count] = plan;
        count++;
      }
      if (count > 0) {
        applyLeaf(count);
        return changedSlots.length === 0 ? emptySlots : changedSlots;
      }
      // The general path re-deduplicates, so it needs its own marks.
      stamp = nextStamp();
    }
    const scanAll = initial || input === undefined;
    for (let position = 0; position < (scanAll ? pins.length : input!.length); position++) {
      const index = scanAll ? position : input![position]!;
      if (!scanAll) {
        if (seenSlots[index] === stamp) continue;
        seenSlots[index] = stamp;
      }
      const pin = pins[index]!;
      const intent = pin.intent;
      if (intent === intents[index]) continue;
      const from = pinNodes[index]!;
      const previous = pinEdges[index]!;
      const edges: Edge[] = [];
      for (const branch of intent) {
        if (!validResistance(branch.resistance))
          validateResistance(branch.resistance, pinLocation(pin));
        const to = pinNodes[requireEndpoint(branch.to, pin)]!;
        if (from === to) continue;
        const old = previous[edges.length];
        if (old?.to === to && old.resistance === branch.resistance) edges.push(old);
        else {
          const edge = {
            pin: index,
            index: edges.length,
            from,
            to,
            resistance: branch.resistance,
            conductance: 1 / branch.resistance,
          };
          edges.push(edge);
          if (old?.to === to) replacedEdges.push(old);
          else topologyChanged = true;
        }
      }
      if (edges.length !== previous.length) topologyChanged = true;
      // The node must stay a leaf hanging off a fixed reference on both sides of the update.
      // With one incident branch on each side no unknown-unknown coupling exists, the old
      // component keeps its own pinned node, the new component keeps its own, and the
      // component and floating censuses provably cannot change. A branch that used to
      // reach an unknown node can remove a whole floating component when several such
      // leaves leave together, so that shape falls back to the general solver.
      const leafShape =
        previous.length === 1 &&
        edges.length === 1 &&
        nodeDegree[from] === 1 &&
        nodes[from]!.reference === undefined &&
        nodes[previous[0]!.to]!.reference !== undefined &&
        nodes[edges[0]!.to]!.reference !== undefined;
      if (leafSwitch && !leafShape) leafSwitch = false;
      // One branch from a leaf node onto a fixed reference: remember the shape so that the
      // next switch between the same references replays it instead of rebuilding edges.
      if (leafShape && intent.length === 1 && edges[0] !== previous[0])
        pendingAdmissions.push({ slot: index, branch: intent[0]!, target: edges[0]!.to, edges });
      updatedSlots.push(index);
      updatedIntents.push(intent);
      updatedEdges.push(edges);
    }
    if (leafSwitch && topologyChanged) {
      for (let position = 0; position < updatedSlots.length; position++) {
        leafSlots[position] = updatedSlots[position]!;
        leafIntents[position] = updatedIntents[position]!;
        leafEdges[position] = updatedEdges[position]!;
        leafTargets[position] = updatedEdges[position]![0]!.to;
        leafPayloads[position] = undefined;
      }
      flushAdmissions();
      applyLeaf(updatedSlots.length);
      return changedSlots.length === 0 ? emptySlots : changedSlots;
    }
    if (blocksStale) {
      // The partition is rebuilt from pinEdges, but the buckets survive: the pin hashes
      // already describe the committed leaf edges, so admitted graphs stay reusable.
      blocksStale = false;
      cache = new Map();
      topologyChanged = true;
    }
    const updates = new Map<number, PinUpdate>();
    for (let position = 0; position < updatedSlots.length; position++)
      updates.set(updatedSlots[position]!, {
        intent: updatedIntents[position]!,
        edges: updatedEdges[position]!,
      });
    if (prepared !== undefined && !topologyChanged && replacedEdges.length === 0) {
      for (const [index, update] of updates) {
        intents[index] = update.intent;
        pinEdges[index] = update.edges;
      }
      statistics.solves++;
      statistics.cacheHits += prepared.blocks.length;
      flushAdmissions();
      return emptySlots;
    }
    let topology = prepared;
    let bucket: string | undefined;
    let restored: TopologySnapshot | undefined;
    const dirtyBlocks = new Map<number, PreparedBlock>();
    // Dirty edges are also indexed by slot, so rebinding never hashes a pin number.
    for (let position = 0; position < updatedEdgeSlots.length; position++)
      updatedEdgeLists[updatedEdgeSlots[position]!] = undefined;
    updatedEdgeSlots.length = 0;
    for (const [index, update] of updates) {
      updatedEdgeLists[index] = update.edges;
      updatedEdgeSlots.push(index);
    }
    if (topologyChanged) {
      // Only dirty pins are hashed, and the aggregate stays prospective: a rejected solve
      // must not move the bucket a committed graph is filed under.
      let hash = topologyHash;
      let spread = topologySpread;
      for (const [index, update] of updates) {
        const next = hashEdges(index, update.edges);
        const previous = pinHashes[index]!;
        if (next === previous) continue;
        hash += next - previous;
        spread ^= previous ^ next;
      }
      bucket = `${hash}:${spread}`;
      restored = lookupTransition(bucket, updatedEdgeLists);
      if (restored !== undefined)
        topology = restoreTopology(restored.topology, pinEdges, updatedEdgeLists);
      else {
        const nextEdges = pinEdges.slice();
        for (const [index, update] of updates) nextEdges[index] = update.edges;
        topology = prepareTopology(nodes, nextEdges);
        statistics.topologyPrepares++;
      }
    } else {
      const dirty = new Set<number>();
      for (const edge of replacedEdges) {
        const index = topology!.edgeBlocks[edge.pin]?.[edge.index];
        if (index !== undefined) dirty.add(index);
      }
      for (const index of dirty) {
        dirtyBlocks.set(index, rebindBlock(topology!.blocks[index]!, pinEdges, updatedEdgeLists));
      }
    }
    let nextCache: Map<string, CachedComponent> | undefined;
    const pendingVoltages = new Map<number, number | null>();
    let factorizations = 0;
    let factorizationReuses = 0;
    let cacheHits = topologyChanged ? 0 : topology!.blocks.length - dirtyBlocks.size;
    for (const block of topologyChanged ? topology!.blocks : dirtyBlocks.values()) {
      const { component, key } = block;
      const previous = cache.get(key);
      if (previous !== undefined && sameConfiguration(previous, component)) {
        cacheHits++;
        (nextCache ??= new Map()).set(key, previous);
        continue;
      }
      const voltages = new Map(
        component.nodes.map((node) => [node, nodes[node]!.reference ?? null]),
      );
      const references = component.nodes.filter((node) => nodes[node]!.reference !== undefined);
      const physical = component.physical ?? component;
      const fail = (reason: string): never => {
        const networkIds = physical.nodes.flatMap((node) => [...nodes[node]!.networks]);
        const resources = physical.nodes.flatMap((node) => nodes[node]!.pins.map((pin) => pin.id));
        const firstPin = nodes[physical.nodes[0]!]!.pins[0]!;
        throw new ElectricalError('ELECTRICAL_SOLVE_FAILED', reason, {
          ...pinLocation(firstPin),
          ...(networkIds[0] === undefined ? {} : { network: networkIds[0] }),
          networks: Object.freeze(networkIds),
          component: Object.freeze(resources),
        });
      };
      let factorization: Factorization | undefined;
      let referenceProgram: ReferenceProgram | undefined;
      if (references.length !== 0) {
        const unknown = component.nodes.filter((node) => nodes[node]!.reference === undefined);
        for (const node of references) voltages.set(node, nodes[node]!.reference!);
        const firstReference = nodes[references[0]!]!.reference!;
        if (references.every((node) => nodes[node]!.reference === firstReference)) {
          for (const node of unknown) voltages.set(node, firstReference);
        } else if (unknown.length !== 0) {
          const count = unknown.length;
          const slots = new Map(unknown.map((node, index) => [node, index]));
          let conductanceScale = 0;
          let voltageScale = 0;
          let coupled = false;
          for (const node of references) {
            voltageScale = Math.max(voltageScale, Math.abs(nodes[node]!.reference!));
          }
          for (const edge of component.edges) {
            const from = slots.has(edge.from);
            const to = slots.has(edge.to);
            if (from || to) conductanceScale = Math.max(conductanceScale, edge.conductance);
            if (from && to) coupled = true;
          }
          if (!(conductanceScale > 0) || !(voltageScale > 0)) fail('Invalid equation scaling.');
          if (!coupled) {
            referenceProgram = referencePrograms.find((program) =>
              program.matches(component.edges, unknown),
            );
            if (referenceProgram === undefined) {
              referenceProgram = compileReferenceProgram(unknown, component.edges, slots, nodes);
              if (referenceProgram !== undefined) {
                referencePrograms.push(referenceProgram);
                if (referencePrograms.length > referenceProgramLimit) referencePrograms.shift();
              }
            }
          }
          const matrix = new Float64Array(coupled ? count * count : 0);
          let anchors: Float64Array;
          let right: Float64Array;
          if (referenceProgram !== undefined) {
            ({ anchors, right } = referenceProgram.assemble(
              component.edges,
              conductanceScale,
              voltageScale,
            ));
          } else {
            const anchorTerms: number[][] = Array.from({ length: count }, () => []);
            const rightTerms: number[][] = Array.from({ length: count }, () => []);
            for (const edge of component.edges) {
              const from = slots.get(edge.from);
              const to = slots.get(edge.to);
              const conductance = edge.conductance / conductanceScale;
              if (from !== undefined && to !== undefined) {
                const slot = Math.min(from, to) * count + Math.max(from, to);
                matrix[slot] = matrix[slot]! + conductance;
              } else if (from !== undefined || to !== undefined) {
                const slot = from ?? to!;
                const reference = nodes[from === undefined ? edge.from : edge.to]!.reference!;
                anchorTerms[slot]!.push(conductance);
                rightTerms[slot]!.push(conductance * (reference / voltageScale));
              }
            }
            anchors = Float64Array.from(anchorTerms, (terms) => sum(terms));
            right = Float64Array.from(rightTerms, (terms) => sum(terms));
          }
          if (
            previous?.factorization !== undefined &&
            arraysEqual(previous.factorization.matrix, matrix) &&
            arraysEqual(previous.factorization.anchors, anchors)
          ) {
            factorization = previous.factorization;
            factorizationReuses++;
          } else {
            factorization = factorize(matrix, anchors, fail);
            factorizations++;
          }
          const solution = substitute(factorization, right, fail);
          unknown.forEach((node, index) => {
            const voltage = cleanZero(solution[index]! * voltageScale);
            if (!Number.isFinite(voltage)) fail('Non-finite node voltage.');
            voltages.set(node, voltage);
          });
        }
      }
      const entry: CachedComponent = {
        edges: component.edges,
        voltages: component.nodes.map((node) => voltages.get(node)!),
        factorization,
      };
      (nextCache ??= new Map()).set(key, entry);
      for (const [node, voltage] of voltages) {
        if (publishedVoltages[node] !== voltage) pendingVoltages.set(node, voltage);
      }
    }
    const pending = new Map<ElectricalPin, PinSample>();
    changedSlots.length = 0;
    for (const [node, voltage] of pendingVoltages) {
      const slots = nodeSlots[node]!;
      for (let at = 0; at < slots.length; at++) {
        const slot = slots[at]!;
        const pin = pins[slot]!;
        const level =
          voltage === null || pin.low === undefined
            ? 'unknown'
            : voltage <= pin.low
              ? 'low'
              : voltage >= pin.high!
                ? 'high'
                : 'unknown';
        const status = voltage === null ? 'floating' : 'valid';
        const previous = pin.sample;
        const dirty =
          previous.voltage !== voltage || previous.level !== level || previous.status !== status;
        if (dirty) changedSlots.push(slot);
        if (dirty || statistics.solves === 0) {
          pending.set(
            pin,
            Object.freeze({
              voltage: voltage === null ? null : cleanZero(voltage),
              level,
              status,
            }),
          );
        }
      }
    }
    if (changedSlots.length > 1) changedSlots.sort(ascendingSlot);
    // No pin, intent snapshot, adjacency or factorization cache changes before acceptance.
    for (const [pin, sample] of pending) pin.sample = sample;
    for (const [node, voltage] of pendingVoltages) publishedVoltages[node] = voltage;
    for (const [index, update] of updates) {
      syncDegrees(pinEdges[index]!, update.edges);
      intents[index] = update.intent;
      pinEdges[index] = update.edges;
      setPinHash(index, update.edges);
    }
    if (topologyChanged) cache = nextCache ?? new Map();
    else {
      // Column-wise merge keeps a rejected solve from leaving a half-rebuilt cache.
      if (nextCache !== undefined) for (const [key, value] of nextCache) cache.set(key, value);
      for (const [index, block] of dirtyBlocks) topology!.blocks[index] = block;
    }
    prepared = topology!;
    componentArraysOwned = false;
    if (topologyChanged) {
      const admitted: TopologySnapshot =
        restored !== undefined && topology === restored.topology
          ? restored
          : {
              // Reusing the id keeps the bucket age stable while a graph is only re-bound.
              id: restored?.id ?? nextTopologyId++,
              cost: restored?.cost ?? topologyCost(topology!),
              topology: topology!,
              // A confirmed bucket hit already carries the exact hashes.
              hashes: restored?.hashes ?? pinHashes.slice(),
            };
      rememberTransition(bucket!, admitted);
    }
    statistics.solves++;
    statistics.components = topology!.components;
    statistics.floatingComponents = topology!.floatingComponents;
    statistics.factorizations += factorizations;
    statistics.factorizationReuses += factorizationReuses;
    statistics.cacheHits += cacheHits;
    flushAdmissions();
    return changedSlots.length === 0 ? emptySlots : changedSlots;
  }
}
