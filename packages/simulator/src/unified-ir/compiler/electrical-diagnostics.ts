import type { IRStorage } from '@mica-js/ir';
import type { ElectricalCurrentTarget } from '../runtime/types';
import type { AllocatedElectricalNetwork } from './electrical-network';
import { RESISTIVE_FAULT, type ResistiveSolver } from './resistive-solver';

/** Resolves a latched solver origin against the attempted topology, not the last good snapshot. */
export function electricalFaultContext(
  allocation: AllocatedElectricalNetwork,
  solver: ResistiveSolver,
  storage: IRStorage,
): {
  readonly target?: ElectricalCurrentTarget;
  readonly resources: readonly ElectricalCurrentTarget[];
  readonly pins: readonly string[];
} {
  const { network } = allocation;
  const resistors = new Map<number, ElectricalCurrentTarget>();
  const contacts = new Map<number, ElectricalCurrentTarget>();
  const sources = new Map<number, ElectricalCurrentTarget>();
  for (const [name, index] of allocation.sources) sources.set(index, { kind: 'source', name });
  for (const [device, entries] of allocation.resistors)
    for (const [name, index] of entries) resistors.set(index, { kind: 'resistor', device, name });
  for (const [device, entries] of allocation.contacts)
    for (const [name, index] of entries) contacts.set(index, { kind: 'contact', device, name });
  for (const [device, entries] of allocation.pins) {
    for (const [pin, config] of entries) {
      if (config.drive !== undefined) {
        const target = { kind: 'drive', device, pin } as const;
        resistors.set(config.drive.high, target);
        resistors.set(config.drive.low, target);
        if (config.drive.analog !== undefined) {
          resistors.set(config.drive.analog.resistor, target);
          sources.set(config.drive.analog.source, target);
        }
      }
      if (config.bias !== undefined) {
        resistors.set(config.bias.up, { kind: 'pull-up', device, pin });
        resistors.set(config.bias.down, { kind: 'pull-down', device, pin });
      }
    }
  }
  const kind = storage.loadState(solver.faultTargetKind);
  const index = storage.loadState(solver.faultTargetIndex);
  const target = (
    kind === 1 ? resistors : kind === 2 ? sources : kind === 3 ? contacts : undefined
  )?.get(index);
  const origin =
    kind === 1 ? network.resistors[index] : kind === 3 ? network.contacts[index] : undefined;
  const seeds =
    origin !== undefined
      ? [origin.a, origin.b]
      : kind === 2 && network.sources[index] !== undefined
        ? [network.sources[index]!.node]
        : kind === 4
          ? [index]
          : [];
  const conflict = storage.loadState(solver.fault) === RESISTIVE_FAULT.sourceConflict;
  const edges: { readonly a: number; readonly b: number; readonly ideal: boolean }[] =
    network.contacts.flatMap((edge, i) =>
      storage.loadArray(solver.contactClosed, i) ? [{ ...edge, ideal: true }] : [],
    );
  if (!conflict) {
    for (const [i, edge] of network.resistors.entries())
      if (storage.loadArray(solver.resistorEnabled, i)) edges.push({ ...edge, ideal: false });
  }
  const anchors = new Set(
    network.sources.flatMap((source, i) =>
      storage.loadArray(solver.sourceEnabled, i) ? [source.node] : [],
    ),
  );
  const anchorQueue = [...anchors];
  for (let i = 0; i < anchorQueue.length; i++) {
    const node = anchorQueue[i]!;
    for (const edge of edges) {
      if (!edge.ideal) continue;
      const next = edge.a === node ? edge.b : edge.b === node ? edge.a : undefined;
      if (next !== undefined && !anchors.has(next)) {
        anchors.add(next);
        anchorQueue.push(next);
      }
    }
  }
  const nodes = new Set(seeds);
  const queue = [...seeds];
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i]!;
    // Known-voltage nodes bound an unknown-node solve group. A source-current failure
    // starts at its source and includes every incident branch contributing to the sum.
    for (const edge of edges) {
      if (!edge.ideal && anchors.has(node) && !seeds.includes(node)) continue;
      const next = edge.a === node ? edge.b : edge.b === node ? edge.a : undefined;
      if (next !== undefined && !nodes.has(next)) {
        nodes.add(next);
        queue.push(next);
      }
    }
  }
  const resources = new Map<string, ElectricalCurrentTarget>();
  const add = (resource: ElectricalCurrentTarget | undefined) => {
    if (resource !== undefined) resources.set(JSON.stringify(resource), Object.freeze(resource));
  };
  add(target);
  for (const [i, source] of network.sources.entries())
    if (nodes.has(source.node) && storage.loadArray(solver.sourceEnabled, i)) add(sources.get(i));
  for (const [i, edge] of network.contacts.entries())
    if (nodes.has(edge.a) && nodes.has(edge.b) && storage.loadArray(solver.contactClosed, i))
      add(contacts.get(i));
  if (!conflict) {
    for (const [i, edge] of network.resistors.entries())
      if (nodes.has(edge.a) && nodes.has(edge.b) && storage.loadArray(solver.resistorEnabled, i))
        add(resistors.get(i));
  }
  const pins: string[] = [];
  for (const [device, entries] of allocation.pins)
    for (const [name, pin] of entries) if (nodes.has(pin.node)) pins.push(`${device}.${name}`);
  return Object.freeze({
    ...(target === undefined ? {} : { target: Object.freeze(target) }),
    resources: Object.freeze([...resources.values()]),
    pins: Object.freeze(pins),
  });
}
