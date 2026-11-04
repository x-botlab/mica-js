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
  /** The caller establishes the initial observation baseline after the first solve. */
  solve(): readonly ElectricalPin[];
  readonly stats: ElectricalStats;
}

interface Node {
  readonly pins: readonly ElectricalPin[];
  readonly networks: readonly string[];
  reference: number | undefined;
}

interface Edge {
  readonly from: number;
  readonly to: number;
  readonly resistance: number;
  readonly conductance: number;
}

interface Component {
  readonly nodes: number[];
  readonly edges: Edge[];
}

interface Factorization {
  readonly matrix: Float64Array;
  readonly anchors: Float64Array;
  readonly pivots: Float64Array;
  readonly weights: Float64Array;
}

interface CachedComponent {
  readonly nodes: readonly number[];
  readonly edges: readonly Edge[];
  readonly voltages: readonly (number | null)[];
  readonly factorization: Factorization | undefined;
}

const cleanZero = (value: number): number => (value === 0 ? 0 : value);

function pinLocation(pin: ElectricalPin): ElectricalErrorLocation {
  return { instanceId: pin.instance, resource: pin.name };
}

class DisjointSet {
  private readonly parents: number[];

  constructor(count: number) {
    this.parents = Array.from({ length: count }, (_, index) => index);
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
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function sameConfiguration(previous: CachedComponent, component: Component): boolean {
  return (
    previous.nodes.length === component.nodes.length &&
    previous.nodes.every((node, index) => node === component.nodes[index]) &&
    previous.edges.length === component.edges.length &&
    previous.edges.every((edge, index) => {
      const other = component.edges[index]!;
      return (
        edge.from === other.from && edge.to === other.to && edge.resistance === other.resistance
      );
    })
  );
}

function factorize(
  matrix: Float64Array,
  anchors: Float64Array,
  fail: (reason: string) => never,
): Factorization {
  const count = anchors.length;
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
  const forward = new Float64Array(count);
  for (let row = 0; row < count; row++) {
    const terms = [right[row]!];
    for (let column = 0; column < row; column++) {
      terms.push(weights[column * count + row]! * forward[column]!);
    }
    forward[row] = sum(terms);
    if (!Number.isFinite(forward[row])) fail('Non-finite forward substitution.');
  }
  const solution = new Float64Array(count);
  for (let row = count - 1; row >= 0; row--) {
    const terms = [forward[row]! / pivots[row]!];
    for (let column = row + 1; column < count; column++) {
      terms.push(weights[row * count + column]! * solution[column]!);
    }
    solution[row] = sum(terms);
    if (!Number.isFinite(solution[row])) fail('Non-finite backward substitution.');
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
    solve(): readonly ElectricalPin[] {
      const topology = new DisjointSet(nodes.length);
      const edges: Edge[] = [];
      for (let index = 0; index < pins.length; index++) {
        const pin = pins[index]!;
        const from = pinNodes[index]!;
        for (const branch of pin.intent) {
          validateResistance(branch.resistance, pinLocation(pin));
          const to = pinNodes[requirePin(branch.to, pinLocation(pin))]!;
          if (from === to) continue;
          edges.push({
            from,
            to,
            resistance: branch.resistance,
            conductance: 1 / branch.resistance,
          });
          topology.join(from, to);
        }
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
      for (const edge of edges) groups.get(topology.find(edge.from))!.edges.push(edge);
      const nextCache = new Map<string, CachedComponent>();
      const voltages: (number | null)[] = Array(nodes.length).fill(null);
      let floatingComponents = 0;
      let factorizations = 0;
      let factorizationReuses = 0;
      let cacheHits = 0;
      for (const component of groups.values()) {
        const key = component.nodes.join(',');
        const previous = cache.get(key);
        const references = component.nodes.filter((node) => nodes[node]!.reference !== undefined);
        if (references.length === 0) floatingComponents++;
        if (previous !== undefined && sameConfiguration(previous, component)) {
          cacheHits++;
          component.nodes.forEach((node, index) => {
            voltages[node] = previous.voltages[index]!;
          });
          nextCache.set(key, previous);
          continue;
        }
        const networkIds = component.nodes.flatMap((node) => [...nodes[node]!.networks]);
        const resources = component.nodes.flatMap((node) => nodes[node]!.pins.map((pin) => pin.id));
        const firstPin = nodes[component.nodes[0]!]!.pins[0]!;
        const fail = (reason: string): never => {
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
          for (const node of references) voltages[node] = nodes[node]!.reference!;
          const firstReference = nodes[references[0]!]!.reference!;
          if (references.every((node) => nodes[node]!.reference === firstReference)) {
            for (const node of unknown) voltages[node] = firstReference;
          } else if (unknown.length !== 0) {
            const count = unknown.length;
            const slots = new Map(unknown.map((node, index) => [node, index]));
            let conductanceScale = 0;
            let voltageScale = 0;
            for (const node of references) {
              voltageScale = Math.max(voltageScale, Math.abs(nodes[node]!.reference!));
            }
            for (const edge of component.edges) {
              if (slots.has(edge.from) || slots.has(edge.to)) {
                conductanceScale = Math.max(conductanceScale, edge.conductance);
              }
            }
            if (!(conductanceScale > 0) || !(voltageScale > 0)) fail('Invalid equation scaling.');
            const matrix = new Float64Array(count * count);
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
              voltages[node] = voltage;
            });
          }
          // Check the original, uneliminated equations, scaled in voltage only.
          for (const node of unknown) {
            const incident = component.edges.filter(
              (edge) => edge.from === node || edge.to === node,
            );
            const diagonal = sum(incident.map((edge) => edge.conductance));
            if (!(diagonal > 0) || !Number.isFinite(diagonal))
              fail('Invalid original node equation.');
            const voltage = voltages[node]!;
            if (voltage === null || !Number.isFinite(voltage)) fail('Missing candidate voltage.');
            let scale = Math.abs(voltage);
            for (const edge of incident) {
              scale = Math.max(
                scale,
                Math.abs(voltages[edge.from === node ? edge.to : edge.from]!),
              );
            }
            if (scale === 0) continue;
            const weighted: number[] = [];
            const absolute: number[] = [];
            for (const edge of incident) {
              const neighbor = voltages[edge.from === node ? edge.to : edge.from]! / scale;
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
          nodes: component.nodes,
          edges: component.edges,
          voltages: component.nodes.map((node) => voltages[node]!),
          factorization,
        });
      }
      const pending = pins.map((pin, index): PinSample => {
        const voltage = voltages[pinNodes[index]!]!;
        if (voltage === null)
          return Object.freeze({ voltage: null, level: 'unknown', status: 'floating' });
        const level =
          pin.low === undefined
            ? 'unknown'
            : voltage <= pin.low
              ? 'low'
              : voltage >= pin.high!
                ? 'high'
                : 'unknown';
        return Object.freeze({ voltage: cleanZero(voltage), level, status: 'valid' });
      });
      const changed = pins.filter((pin, index) => {
        const candidate = pending[index]!;
        return (
          pin.sample.voltage !== candidate.voltage ||
          pin.sample.level !== candidate.level ||
          pin.sample.status !== candidate.status
        );
      });
      // No pin or cache is modified until every component has passed acceptance.
      pins.forEach((pin, index) => {
        pin.sample = pending[index]!;
      });
      cache = nextCache;
      statistics.solves++;
      statistics.components = groups.size;
      statistics.floatingComponents = floatingComponents;
      statistics.factorizations += factorizations;
      statistics.factorizationReuses += factorizationReuses;
      statistics.cacheHits += cacheHits;
      return Object.freeze(changed);
    },
  };
}
