import { ElectricalDefinitionError } from '../../electrical-authoring';
import type {
  PinElectricalDescription,
  PreparedElectricalDevice,
} from '../../electrical-authoring';
import type { ResistiveNetwork } from './resistive-solver';

type Endpoint = { readonly device: string; readonly pin: string } | { readonly source: string };

export interface AllocatedElectricalPin {
  readonly node: number;
  readonly drive?: {
    readonly high: number;
    readonly low: number;
    readonly reference: number;
    readonly analog?: { readonly resistor: number; readonly source: number };
    readonly maxAbsCurrent?: number;
  };
  readonly bias?: { readonly up: number; readonly down: number };
  readonly input?: { readonly reference: number; readonly low: number; readonly high: number };
}

export interface AllocatedElectricalNetwork {
  readonly network: ResistiveNetwork;
  readonly pins: ReadonlyMap<string, ReadonlyMap<string, AllocatedElectricalPin>>;
  readonly resistors: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly contacts: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly sources: ReadonlyMap<string, number>;
  readonly currentLimits: ReadonlyMap<number, number>;
}

/** Links prepared authoring resources. Only wires union nodes; resistors never do. */
export function allocateElectricalNetwork(
  devices: readonly { readonly id: string; readonly prepared: PreparedElectricalDevice<unknown> }[],
  sources: Readonly<Record<string, { readonly voltage: number }>>,
  wires: readonly (readonly [Endpoint, Endpoint])[],
): AllocatedElectricalNetwork {
  const fail = (message: string): never => {
    throw new ElectricalDefinitionError('electrical/invalid-definition', message);
  };
  const parent: number[] = [];
  const makeNode = () => {
    const node = parent.length;
    parent.push(node);
    return node;
  };
  const root = (node: number): number => {
    let current = node;
    while (parent[current] !== current) current = parent[current]!;
    while (node !== current) {
      const next = parent[node]!;
      parent[node] = current;
      node = next;
    }
    return current;
  };
  const sourceIndices = new Map<string, number>([['GND', 0]]);
  const initialSources: { node: number; voltage: number; enabled: boolean }[] = [
    { node: makeNode(), voltage: 0, enabled: true },
  ];
  for (const [id, source] of Object.entries(sources)) {
    if (!id || sourceIndices.has(id) || !Number.isFinite(source.voltage))
      fail(`Invalid or duplicate voltage source "${id}"`);
    sourceIndices.set(id, initialSources.length);
    initialSources.push({ node: makeNode(), voltage: source.voltage, enabled: true });
  }
  const pinNodes = new Map<string, Map<string, number>>();
  for (const device of devices) {
    if (!device.id || pinNodes.has(device.id)) fail(`Invalid or duplicate device "${device.id}"`);
    pinNodes.set(
      device.id,
      new Map(Object.keys(device.prepared.pinDeclarations).map((id) => [id, makeNode()])),
    );
  }
  const reference = (name: string): number =>
    sourceIndices.get(name) ?? fail(`Unknown voltage source "${name}"`);
  const endpoint = (item: Endpoint): number => {
    if ('source' in item) return initialSources[reference(item.source)]!.node;
    return (
      pinNodes.get(item.device)?.get(item.pin) ?? fail(`Unknown pin "${item.device}.${item.pin}"`)
    );
  };
  for (const [a, b] of wires) {
    const left = root(endpoint(a));
    const right = root(endpoint(b));
    if (left !== right) parent[Math.max(left, right)] = Math.min(left, right);
  }
  const nodes = new Map<number, number>();
  const compact = (node: number) => {
    const representative = root(node);
    let index = nodes.get(representative);
    if (index === undefined) {
      index = nodes.size;
      nodes.set(representative, index);
    }
    return index;
  };
  for (let node = 0; node < parent.length; node++) compact(node);
  const compiledSources = initialSources.map((source) => ({
    ...source,
    node: compact(source.node),
  }));
  const compiledResistors: { a: number; b: number; resistance: number; enabled: boolean }[] = [];
  const compiledContacts: { a: number; b: number; closed: boolean }[] = [];
  const pins = new Map<string, ReadonlyMap<string, AllocatedElectricalPin>>();
  const resistors = new Map<string, ReadonlyMap<string, number>>();
  const contacts = new Map<string, ReadonlyMap<string, number>>();
  const currentLimits = new Map<number, number>();
  const branch = (a: number, b: number, resistance: number, enabled: boolean, limit?: number) => {
    const index = compiledResistors.length;
    compiledResistors.push({ a, b, resistance, enabled });
    if (limit !== undefined) currentLimits.set(index, limit);
    return index;
  };
  const ground = compiledSources[0]!.node;
  let nodeCount = nodes.size;
  for (const device of devices) {
    const rawPins = pinNodes.get(device.id)!;
    const pin = (id: string): number =>
      compact(rawPins.get(id) ?? fail(`Unknown pin "${device.id}.${id}"`));
    const deviceResistors = new Map<string, number>();
    for (const [id, resistor] of Object.entries(device.prepared.resistors)) {
      deviceResistors.set(
        id,
        branch(
          pin(resistor.pins[0]),
          pin(resistor.pins[1]),
          resistor.resistance,
          resistor.enabled,
          resistor.maxAbsCurrent,
        ),
      );
    }
    resistors.set(device.id, deviceResistors);
    const deviceContacts = new Map<string, number>();
    for (const [id, contact] of Object.entries(device.prepared.connections)) {
      deviceContacts.set(id, compiledContacts.length);
      compiledContacts.push({
        a: pin(contact.pins[0]),
        b: pin(contact.pins[1]),
        closed: contact.initial === 'closed',
      });
    }
    contacts.set(device.id, deviceContacts);
    const devicePins = new Map<string, AllocatedElectricalPin>();
    for (const id of rawPins.keys()) {
      const node = pin(id);
      const description: PinElectricalDescription = Object.hasOwn(device.prepared.pins, id)
        ? device.prepared.pins[id]!
        : {};
      let drive: AllocatedElectricalPin['drive'];
      let bias: AllocatedElectricalPin['bias'];
      let input: AllocatedElectricalPin['input'];
      if (description.drive !== undefined) {
        const config = description.drive;
        const supply = reference(config.reference.source);
        const high = branch(
          node,
          compiledSources[supply]!.node,
          config.highResistance,
          false,
          config.maxAbsCurrent,
        );
        const low = branch(node, ground, config.lowResistance, false, config.maxAbsCurrent);
        let analog: NonNullable<AllocatedElectricalPin['drive']>['analog'];
        if (config.analogResistance !== undefined) {
          const source = compiledSources.length;
          // Analog setpoints are known GND-referenced sources behind a finite output resistance.
          const sourceNode = nodeCount++;
          compiledSources.push({ node: sourceNode, voltage: 0, enabled: true });
          analog = Object.freeze({
            source,
            resistor: branch(
              node,
              sourceNode,
              config.analogResistance,
              false,
              config.maxAbsCurrent,
            ),
          });
        }
        drive = Object.freeze({
          high,
          low,
          reference: supply,
          ...(analog === undefined ? {} : { analog }),
          ...(config.maxAbsCurrent === undefined ? {} : { maxAbsCurrent: config.maxAbsCurrent }),
        });
      }
      if (description.bias !== undefined) {
        const config = description.bias;
        const supply = reference(config.reference.source);
        bias = Object.freeze({
          up: branch(node, compiledSources[supply]!.node, config.upResistance, false),
          down: branch(node, ground, config.downResistance, false),
        });
      }
      if (description.input !== undefined) {
        const config = description.input;
        input = Object.freeze({
          reference: reference(config.reference.source),
          low: config.low,
          high: config.high,
        });
      }
      devicePins.set(
        id,
        Object.freeze({
          node,
          ...(drive === undefined ? {} : { drive }),
          ...(bias === undefined ? {} : { bias }),
          ...(input === undefined ? {} : { input }),
        }),
      );
    }
    pins.set(device.id, devicePins);
  }
  const network: ResistiveNetwork = Object.freeze({
    nodes: nodeCount,
    sources: Object.freeze(compiledSources.map((source) => Object.freeze(source))),
    resistors: Object.freeze(compiledResistors.map((resistor) => Object.freeze(resistor))),
    contacts: Object.freeze(compiledContacts.map((contact) => Object.freeze(contact))),
  });
  return Object.freeze({
    network,
    pins,
    resistors,
    contacts,
    sources: sourceIndices,
    currentLimits,
  });
}
