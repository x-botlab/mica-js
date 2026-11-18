/**
 * Derivation of the electrical nets of a fused document (RFC 0024).
 *
 * Nets come from the explicit connection graph: wires and shared endpoints first, then the
 * equality rules of net names (including names owned by power and ground symbols), and finally
 * the ideal voltage constraints. Model-internal conduction never merges document nets.
 */
import { FusedDocumentError } from './diagnostics';
import type { FusedDiagnostic } from './diagnostics';
import type { Endpoint, FusedDocument } from './types/document';
import type { UnifiedDeviceManifest } from './types/manifest';
import { compareStrings, hasErrors, report } from './read';

/** One device pin inside a derived net (RFC 0024). */
export interface FusedNetPin {
  readonly instance: string;
  readonly pin: string;
}

/** One derived electrical net: its stable id, deduplicated pins and ideal voltage. */
export interface FusedNet {
  /** Derived from the sorted connection endpoint identities of the net. */
  readonly id: string;
  readonly pins: readonly FusedNetPin[];
  /** Ideal voltage attached to the net; absent when the net has no voltage reference. */
  readonly voltage?: number;
}

export interface FusedTopology {
  readonly nets: readonly FusedNet[];
}

interface NamedEndpoint {
  readonly name: string;
  readonly path: readonly string[];
  /** Declaration index, so conflicts are reported in document order. */
  readonly order: number;
}

interface VoltageConstraint {
  readonly voltage: number;
  readonly path: readonly string[];
  /** Declaration index, so conflicts are reported in document order. */
  readonly order: number;
}

/**
 * Derives the nets of `document` using the pinned pins of `manifests`.
 *
 * @throws {FusedDocumentError} when an instance has no manifest, a pin endpoint is not declared,
 * a connection endpoint is missing, or a net has conflicting names or ideal voltages.
 */
export function deriveFusedTopology(
  document: FusedDocument,
  manifests: ReadonlyMap<string, UnifiedDeviceManifest>,
): FusedTopology {
  const diagnostics: FusedDiagnostic[] = [];
  const pinsByInstance = readInstancePins(document, manifests, diagnostics);

  const parent = new Map<string, string>();
  const endpoints = new Map<string, Endpoint>();
  const names = new Map<string, NamedEndpoint[]>();
  const voltages = new Map<string, VoltageConstraint[]>();

  const find = (key: string): string => {
    let root = key;
    for (;;) {
      const next = parent.get(root);
      if (next === undefined || next === root) {
        return root;
      }
      root = next;
    }
  };
  const add = (key: string): void => {
    if (!parent.has(key)) {
      parent.set(key, key);
    }
  };
  const union = (a: string, b: string): void => {
    add(a);
    add(b);
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent.set(rootB, rootA);
    }
  };

  const knownNodes = new Set(document.nodes.map((node) => node.id));

  const register = (endpoint: Endpoint, path: readonly string[]): string => {
    const key = endpointKey(endpoint);
    if (!endpoints.has(key)) {
      endpoints.set(key, endpoint);
    }
    add(key);
    if (endpoint.kind === 'pin') {
      if (!pinsByInstance.has(endpoint.instance)) {
        report(
          diagnostics,
          'connection/unknown-endpoint',
          `Pin endpoint references unknown instance "${endpoint.instance}".`,
          [...path, 'instance'],
        );
        return key;
      }
      const pins = pinsByInstance.get(endpoint.instance);
      if (pins !== undefined && !pins.has(endpoint.pin)) {
        report(
          diagnostics,
          'device/unknown-pin',
          `Instance "${endpoint.instance}" does not declare pin "${endpoint.pin}".`,
          [...path, 'pin'],
        );
      }
      return key;
    }
    if (!knownNodes.has(endpoint.node)) {
      report(
        diagnostics,
        'connection/unknown-endpoint',
        `Endpoint references unknown node "${endpoint.node}".`,
        [...path, 'node'],
      );
    }
    return key;
  };

  document.wires.forEach((wire, index) => {
    const path = ['wires', String(index)];
    const fromKey = register(wire.from, [...path, 'from']);
    const toKey = register(wire.to, [...path, 'to']);
    if (fromKey === toKey) {
      report(
        diagnostics,
        'connection/self-edge',
        'A wire must not connect an endpoint to itself.',
        [...path, 'to'],
      );
      return;
    }
    union(fromKey, toKey);
  });

  document.labels.forEach((label, index) => {
    const path = ['labels', String(index)];
    const key = register(label.target, [...path, 'target']);
    push(names, key, { name: label.name, path: [...path, 'name'], order: index });
  });

  document.references.forEach((reference, index) => {
    const path = ['references', String(index)];
    const key = register(reference.target, [...path, 'target']);
    push(voltages, key, {
      voltage: reference.voltage,
      path: [...path, 'voltage'],
      order: index,
    });
    if (reference.label !== undefined) {
      push(names, key, {
        name: reference.label.name,
        path: [...path, 'label', 'name'],
        order: index,
      });
    }
  });

  if (hasErrors(diagnostics)) {
    throw new FusedDocumentError(diagnostics);
  }

  let groups = collectGroups(parent, find);
  reportNamingConflicts(groups, names, diagnostics);
  mergeGroupsByName(groups, names, union);

  groups = collectGroups(parent, find);
  for (const keys of groups.values()) {
    reportVoltageConflicts(keys, voltages, diagnostics);
  }
  if (hasErrors(diagnostics)) {
    throw new FusedDocumentError(diagnostics);
  }

  const nets: FusedNet[] = [];
  for (const keys of groups.values()) {
    const sortedKeys = [...keys].sort(compareStrings);
    const pins: FusedNetPin[] = [];
    let voltage: number | undefined;
    let named = false;
    for (const key of sortedKeys) {
      const endpoint = endpoints.get(key);
      if (endpoint !== undefined && endpoint.kind === 'pin') {
        pins.push({ instance: endpoint.instance, pin: endpoint.pin });
      }
      if (names.has(key)) {
        named = true;
      }
      const constraint = voltages.get(key)?.[0];
      if (constraint !== undefined) {
        voltage = constraint.voltage;
      }
    }
    if (pins.length === 0) {
      continue;
    }
    if (!named && voltage === undefined && sortedKeys.length < 2) {
      continue;
    }
    pins.sort((a, b) => compareStrings(a.instance, b.instance) || compareStrings(a.pin, b.pin));
    nets.push({
      id: sortedKeys.join('|'),
      pins,
      ...(voltage === undefined ? {} : { voltage }),
    });
  }

  return { nets: nets.sort((a, b) => compareStrings(a.id, b.id)) };
}

function endpointKey(endpoint: Endpoint): string {
  return endpoint.kind === 'pin'
    ? `pin:${endpoint.instance}/${endpoint.pin}`
    : `node:${endpoint.node}`;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key);
  if (bucket === undefined) {
    map.set(key, [value]);
    return;
  }
  bucket.push(value);
}

function readInstancePins(
  document: FusedDocument,
  manifests: ReadonlyMap<string, UnifiedDeviceManifest>,
  diagnostics: FusedDiagnostic[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const pins = new Map<string, ReadonlySet<string>>();
  document.instances.forEach((instance, index) => {
    const manifest = manifests.get(instance.device);
    if (manifest === undefined) {
      report(
        diagnostics,
        'device/unresolved',
        `Instance "${instance.id}" references device "${instance.device}", which has no manifest.`,
        ['instances', String(index), 'device'],
      );
      return;
    }
    pins.set(instance.id, new Set(Object.keys(manifest.pins ?? {})));
  });
  return pins;
}

function collectGroups(
  parent: ReadonlyMap<string, string>,
  find: (key: string) => string,
): Map<string, Set<string>> {
  const groups = new Map<string, Set<string>>();
  for (const key of parent.keys()) {
    const root = find(key);
    const bucket = groups.get(root);
    if (bucket === undefined) {
      groups.set(root, new Set([key]));
      continue;
    }
    bucket.add(key);
  }
  return groups;
}

function reportNamingConflicts(
  groups: ReadonlyMap<string, Set<string>>,
  names: ReadonlyMap<string, NamedEndpoint[]>,
  diagnostics: FusedDiagnostic[],
): void {
  for (const keys of groups.values()) {
    const entries: NamedEndpoint[] = [];
    for (const key of keys) {
      entries.push(...(names.get(key) ?? []));
    }
    entries.sort((a, b) => a.order - b.order);
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.name)) {
        continue;
      }
      seen.add(entry.name);
      if (seen.size > 1) {
        report(
          diagnostics,
          'net/naming-conflict',
          `Net has conflicting names: ${[...seen].map((name) => JSON.stringify(name)).join(', ')}.`,
          entry.path,
        );
        break;
      }
    }
  }
}

function mergeGroupsByName(
  groups: ReadonlyMap<string, Set<string>>,
  names: ReadonlyMap<string, NamedEndpoint[]>,
  union: (a: string, b: string) => void,
): void {
  const byName = new Map<string, string>();
  for (const [root, keys] of groups) {
    const name = componentName(keys, names);
    if (name === undefined) {
      continue;
    }
    const existing = byName.get(name);
    if (existing === undefined) {
      byName.set(name, root);
      continue;
    }
    union(existing, root);
  }
}

function componentName(
  keys: ReadonlySet<string>,
  names: ReadonlyMap<string, NamedEndpoint[]>,
): string | undefined {
  const seen = new Set<string>();
  for (const key of keys) {
    for (const entry of names.get(key) ?? []) {
      seen.add(entry.name);
    }
  }
  return seen.size === 1 ? [...seen][0] : undefined;
}

function reportVoltageConflicts(
  keys: ReadonlySet<string>,
  voltages: ReadonlyMap<string, VoltageConstraint[]>,
  diagnostics: FusedDiagnostic[],
): void {
  const constraints: VoltageConstraint[] = [];
  for (const key of keys) {
    constraints.push(...(voltages.get(key) ?? []));
  }
  constraints.sort((a, b) => a.order - b.order);
  const [first, ...rest] = constraints;
  if (first === undefined) {
    return;
  }
  const conflict = rest.find((constraint) => constraint.voltage !== first.voltage);
  if (conflict !== undefined) {
    report(
      diagnostics,
      'net/reference-conflict',
      `Net has conflicting ideal voltages ${String(first.voltage)} and ${String(conflict.voltage)}.`,
      conflict.path,
    );
  }
}
