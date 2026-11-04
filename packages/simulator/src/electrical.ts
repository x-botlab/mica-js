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
}

export interface ElectricalNetwork {
  /**
   * The caller establishes the initial observation baseline after the first solve.
   * Omit changedPins to detect intent identity changes automatically. When supplied,
   * it must include every pin assigned since the last successful solve; intents are immutable.
   * The first solve always reads all pins, regardless of this hint.
   */
  solve(changedPins?: Iterable<ElectricalPin>): readonly ElectricalPin[];
  readonly stats: ElectricalStats;
}

interface Node {
  readonly pins: readonly ElectricalPin[];
  readonly networks: readonly string[];
  reference: number | undefined;
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
  readonly incident: ReadonlyMap<number, readonly number[]>;
}

interface PreparedTopology {
  readonly blocks: PreparedBlock[];
  /** Stable pin/branch slots allow equivalent older Edge objects to be shared. */
  readonly edgeBlocks: readonly (readonly (number | undefined)[] | undefined)[];
  readonly components: number;
  readonly floatingComponents: number;
}

interface PinUpdate {
  readonly intent: readonly ResistorBranch[];
  readonly edges: readonly Edge[];
}

interface TopologySnapshot {
  readonly id: number;
  readonly cost: number;
  readonly topology: PreparedTopology;
}

// Descriptors and admitted graphs share eight slots; each graph also has a slot budget.
const topologyTransitionLimit = 8;
const topologySnapshotLimit = 65_536;

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
  updates: ReadonlyMap<number, PinUpdate>,
): PreparedBlock {
  let edges: Edge[] | undefined;
  for (let index = 0; index < block.component.edges.length; index++) {
    const edge = block.component.edges[index]!;
    const next = (updates.get(edge.pin)?.edges ?? pinEdges[edge.pin]!)[edge.index]!;
    if (edge.from === next.from && edge.to === next.to && edge.resistance === next.resistance)
      continue;
    edges ??= block.component.edges.slice();
    edges[index] = next;
  }
  if (edges === undefined) return block;
  return { ...block, component: { ...block.component, edges } };
}

function restoreTopology(
  topology: PreparedTopology,
  pinEdges: readonly (readonly Edge[])[],
  updates: ReadonlyMap<number, PinUpdate>,
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
  const incident = new Map<number, number[]>();
  for (const node of component.nodes) incident.set(node, []);
  component.edges.forEach((edge, index) => {
    incident.get(edge.from)!.push(index);
    incident.get(edge.to)!.push(index);
  });
  return { component, key: component.nodes.join(','), incident };
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
  for (const component of groups.values()) {
    if (component.nodes.every((node) => nodes[node]!.reference === undefined)) floatingComponents++;
    for (const block of solveBlocks(component, nodes)) {
      const index = blocks.length;
      blocks.push(prepareBlock(block));
      for (const edge of block.edges) (edgeBlocks[edge.pin] ??= [])[edge.index] = index;
    }
  }
  return { blocks, edgeBlocks, components: groups.size, floatingComponents };
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
  const unknown: number[] = [];
  let reference: number | undefined;
  let mixedReferences = false;
  for (const node of component.nodes) {
    const potential = nodes[node]!.reference;
    if (potential === undefined) unknown.push(node);
    else if (reference === undefined) reference = potential;
    else if (potential !== reference) mixedReferences = true;
  }
  if (unknown.length < 2 || !mixedReferences) return [component];
  const slots = new Map(unknown.map((node, index) => [node, index]));
  const topology = new DisjointSet(unknown.length);
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
  if (!coupled && unknown.length <= 32) return [component];
  const groups = new Map<number, { nodes: Set<number>; edges: Edge[] }>();
  for (let index = 0; index < unknown.length; index++) {
    const root = topology.find(index);
    let group = groups.get(root);
    if (group === undefined) {
      group = { nodes: new Set(), edges: [] };
      groups.set(root, group);
    }
    group.nodes.add(unknown[index]!);
  }
  if (groups.size === 1) return [component];
  // Fixed potentials are boundary values, not couplings between unknowns.
  for (const edge of component.edges) {
    const unknownSlot = slots.get(edge.from) ?? slots.get(edge.to);
    if (unknownSlot === undefined) continue;
    const group = groups.get(topology.find(unknownSlot))!;
    group.nodes.add(edge.from);
    group.nodes.add(edge.to);
    group.edges.push(edge);
  }
  return [...groups.values()].map((group) => ({
    nodes: [...group.nodes].sort((a, b) => a - b),
    edges: group.edges,
    physical: component,
  }));
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
  const requirePin = (pin: ElectricalPin, location: ElectricalErrorLocation): number => {
    const slot = pinSlots.get(pin);
    if (slot === undefined) {
      throw new ElectricalError(
        'INVALID_ELECTRICAL_PARAMETER',
        'Electrical endpoint is not part of this board.',
        location,
      );
    }
    return slot;
  };
  for (const net of nets) {
    if (net.voltage !== undefined && !Number.isFinite(net.voltage)) {
      throw new ElectricalError('INVALID_ELECTRICAL_PARAMETER', 'Reference must be finite.', {
        network: net.id,
      });
    }
    let first: number | undefined;
    for (const pin of net.pins) {
      const slot = requirePin(pin, { network: net.id });
      if (first === undefined) first = slot;
      else assembly.join(first, slot);
    }
  }
  const nodes: Node[] = [];
  const rootNodes = new Map<number, number>();
  const pinNodes = pins.map((pin, index) => {
    const root = assembly.find(index);
    let node = rootNodes.get(root);
    if (node === undefined) {
      node = nodes.length;
      rootNodes.set(root, node);
      nodes.push({ pins: [], networks: [], reference: undefined });
    }
    (nodes[node]!.pins as ElectricalPin[]).push(pin);
    return node;
  });
  for (const net of nets) {
    if (net.pins.length === 0) continue;
    const node = nodes[pinNodes[requirePin(net.pins[0]!, { network: net.id })]!]!;
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
  let prepared: PreparedTopology | undefined;
  let snapshot: TopologySnapshot | undefined;
  let nextTopologyId = 0;
  const transitionAges = new Map<string, number>();
  let transitionClock = 0;
  const transitions = new Map<string, TopologySnapshot | undefined>();
  let pinDescriptions = new Array<string>(pins.length).fill('');
  const rememberTransition = (key: string, target: TopologySnapshot): void => {
    if (target.cost > topologySnapshotLimit) return;
    const repeated = transitions.has(key);
    transitionAges.set(key, ++transitionClock);
    // A first observation retains only its descriptor, never the graph.
    // Repeated successful observations admit the graph into the same eight slots.
    if (!repeated) transitions.set(key, undefined);
    else if (transitions.get(key) !== target) transitions.set(key, target);
    if (transitions.size > topologyTransitionLimit) {
      let oldest: string | undefined;
      let oldestAge = Infinity;
      for (const candidate of transitionAges.keys()) {
        const age = transitionAges.get(candidate)!;
        if (age < oldestAge) {
          oldest = candidate;
          oldestAge = age;
        }
      }
      transitions.delete(oldest!);
      transitionAges.delete(oldest!);
    }
  };
  const publishedVoltages: (number | null | undefined)[] = new Array(nodes.length);
  const intents: (readonly ResistorBranch[] | undefined)[] = new Array(pins.length);
  const pinEdges: (readonly Edge[])[] = Array.from({ length: pins.length }, () => []);
  const unchangedPins: readonly ElectricalPin[] = Object.freeze([]);
  const statistics = {
    solves: 0,
    components: 0,
    floatingComponents: 0,
    factorizations: 0,
    factorizationReuses: 0,
    cacheHits: 0,
  };

  return {
    get stats(): ElectricalStats {
      return Object.freeze({ ...statistics });
    },
    solve(changedPins?: Iterable<ElectricalPin>): readonly ElectricalPin[] {
      if (
        prepared !== undefined &&
        (changedPins instanceof Set
          ? changedPins.size === 0
          : Array.isArray(changedPins) && changedPins.length === 0)
      ) {
        statistics.solves++;
        statistics.cacheHits += prepared.blocks.length;
        return unchangedPins;
      }
      const updates = new Map<number, PinUpdate>();
      const replacements = new Map<Edge, Edge>();
      let topologyChanged = prepared === undefined;
      for (const pin of prepared === undefined || changedPins === undefined ? pins : changedPins) {
        const index = requirePin(pin, pinLocation(pin));
        if (updates.has(index)) continue;
        const intent = pin.intent;
        if (intent === intents[index]) continue;
        const from = pinNodes[index]!;
        const previous = pinEdges[index]!;
        const edges: Edge[] = [];
        for (const branch of intent) {
          validateResistance(branch.resistance, pinLocation(pin));
          const to = pinNodes[requirePin(branch.to, pinLocation(pin))]!;
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
            if (old?.to === to) replacements.set(old, edge);
            else topologyChanged = true;
          }
        }
        if (edges.length !== previous.length) topologyChanged = true;
        updates.set(index, { intent, edges });
      }
      if (prepared !== undefined && !topologyChanged && replacements.size === 0) {
        for (const [index, update] of updates) {
          intents[index] = update.intent;
          pinEdges[index] = update.edges;
        }
        statistics.solves++;
        statistics.cacheHits += prepared.blocks.length;
        return unchangedPins;
      }
      let topology = prepared;
      let transitionKey: string | undefined;
      let nextDescriptions: string[] | undefined;
      let restored: TopologySnapshot | undefined;
      const dirtyBlocks = new Map<number, PreparedBlock>();
      if (topologyChanged) {
        nextDescriptions = pinDescriptions.slice();
        for (const [index, update] of updates) {
          nextDescriptions[index] = update.edges.map((edge) => edge.to).join(',');
        }
        // Exact pin-slot and ordered endpoint lists retain multiplicity without hashing.
        transitionKey = nextDescriptions.join(';');
        restored = transitions.get(transitionKey);
        if (restored !== undefined)
          topology = restoreTopology(restored.topology, pinEdges, updates);
        else {
          const nextEdges = pinEdges.slice();
          for (const [index, update] of updates) nextEdges[index] = update.edges;
          topology = prepareTopology(nodes, nextEdges);
        }
      } else {
        const dirty = new Set<number>();
        for (const edge of replacements.keys()) {
          const index = topology!.edgeBlocks[edge.pin]?.[edge.index];
          if (index !== undefined) dirty.add(index);
        }
        for (const index of dirty) {
          dirtyBlocks.set(index, rebindBlock(topology!.blocks[index]!, pinEdges, updates));
        }
      }
      const nextCache = new Map<string, CachedComponent>();
      const pendingVoltages = new Map<number, number | null>();
      let factorizations = 0;
      let factorizationReuses = 0;
      let cacheHits = topologyChanged ? 0 : topology!.blocks.length - dirtyBlocks.size;
      for (const block of topologyChanged ? topology!.blocks : dirtyBlocks.values()) {
        const { component, key } = block;
        const previous = cache.get(key);
        if (previous !== undefined && sameConfiguration(previous, component)) {
          cacheHits++;
          nextCache.set(key, previous);
          continue;
        }
        const voltages = new Map(
          component.nodes.map((node) => [node, nodes[node]!.reference ?? null]),
        );
        const references = component.nodes.filter((node) => nodes[node]!.reference !== undefined);
        const physical = component.physical ?? component;
        const fail = (reason: string): never => {
          const networkIds = physical.nodes.flatMap((node) => [...nodes[node]!.networks]);
          const resources = physical.nodes.flatMap((node) =>
            nodes[node]!.pins.map((pin) => pin.id),
          );
          const firstPin = nodes[physical.nodes[0]!]!.pins[0]!;
          throw new ElectricalError('ELECTRICAL_SOLVE_FAILED', reason, {
            ...pinLocation(firstPin),
            ...(networkIds[0] === undefined ? {} : { network: networkIds[0] }),
            networks: Object.freeze(networkIds),
            component: Object.freeze(resources),
          });
        };
        let factorization: Factorization | undefined;
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
            const matrix = new Float64Array(coupled ? count * count : 0);
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
            const anchors = Float64Array.from(anchorTerms, (terms) => sum(terms));
            const right = Float64Array.from(rightTerms, (terms) => sum(terms));
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
          // Check the original, uneliminated equations, scaled in voltage only.
          for (const node of unknown) {
            const incident = block.incident.get(node)!;
            const diagonal = sum(incident.map((index) => component.edges[index]!.conductance));
            if (!(diagonal > 0) || !Number.isFinite(diagonal))
              fail('Invalid original node equation.');
            const voltage = voltages.get(node)!;
            if (voltage === null || !Number.isFinite(voltage)) fail('Missing candidate voltage.');
            let scale = Math.abs(voltage);
            for (const index of incident) {
              const edge = component.edges[index]!;
              scale = Math.max(
                scale,
                Math.abs(voltages.get(edge.from === node ? edge.to : edge.from)!),
              );
            }
            if (scale === 0) continue;
            const weighted: number[] = [];
            const absolute: number[] = [];
            for (const index of incident) {
              const edge = component.edges[index]!;
              const neighbor = voltages.get(edge.from === node ? edge.to : edge.from)! / scale;
              const weight = edge.conductance / diagonal;
              weighted.push(weight * neighbor);
              absolute.push(weight * Math.abs(neighbor));
            }
            const scaledVoltage = voltage / scale;
            const residual = Math.abs(scaledVoltage - sum(weighted));
            const bound = 1e-12 * (Math.abs(scaledVoltage) + sum(absolute));
            if (!Number.isFinite(residual) || !Number.isFinite(bound) || !(residual <= bound)) {
              fail('Unknown-node normalized residual exceeds 1e-12.');
            }
          }
        }
        nextCache.set(key, {
          edges: component.edges,
          voltages: component.nodes.map((node) => voltages.get(node)!),
          factorization,
        });
        for (const [node, voltage] of voltages) {
          if (publishedVoltages[node] !== voltage) pendingVoltages.set(node, voltage);
        }
      }
      const pending = new Map<ElectricalPin, PinSample>();
      const changed: ElectricalPin[] = [];
      for (const [node, voltage] of pendingVoltages) {
        for (const pin of nodes[node]!.pins) {
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
          if (dirty) changed.push(pin);
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
      changed.sort((first, second) => pinSlots.get(first)! - pinSlots.get(second)!);
      // No pin, intent snapshot, adjacency or factorization cache changes before acceptance.
      for (const [pin, sample] of pending) pin.sample = sample;
      for (const [node, voltage] of pendingVoltages) publishedVoltages[node] = voltage;
      for (const [index, update] of updates) {
        intents[index] = update.intent;
        pinEdges[index] = update.edges;
      }
      if (topologyChanged) cache = nextCache;
      else {
        for (const [key, value] of nextCache) cache.set(key, value);
        for (const [index, block] of dirtyBlocks) topology!.blocks[index] = block;
      }
      prepared = topology!;
      if (topologyChanged) {
        pinDescriptions = nextDescriptions!;
        snapshot =
          restored !== undefined && topology === restored.topology
            ? restored
            : {
                id: restored?.id ?? nextTopologyId++,
                cost: restored?.cost ?? topologyCost(topology!),
                topology: topology!,
              };
        rememberTransition(transitionKey!, snapshot);
      }
      statistics.solves++;
      statistics.components = topology!.components;
      statistics.floatingComponents = topology!.floatingComponents;
      statistics.factorizations += factorizations;
      statistics.factorizationReuses += factorizationReuses;
      statistics.cacheHits += cacheHits;
      return changed.length === 0 ? unchangedPins : Object.freeze(changed);
    },
  };
}
