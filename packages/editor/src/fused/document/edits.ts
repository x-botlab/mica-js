/**
 * Pure document edits of the fused workbench (RFC 0024).
 *
 * Every function takes the current immutable document and returns the next one; nothing here
 * verifies packages or notifies listeners. `FusedDocumentSession` gates permission, verifies the
 * result and commits one transaction, so these functions stay testable on their own.
 */
import type {
  ConnectionNode,
  ConnectionWire,
  DeviceDependency,
  Endpoint,
  FusedDocument,
  FusedInstance,
  InstanceViewLayout,
  NetLabel,
  Placement2D,
  Point2D,
  PropertyValue,
  VoltageReference,
} from '@mica-js/document/fused';
import type { IPreparedDevice } from '../devices';
import { FusedSessionError } from './errors';

/** Element reference the canvas selects and edits. */
export interface IFusedDocumentTarget {
  readonly kind: 'instance' | 'wire' | 'node' | 'label' | 'reference';
  readonly id: string;
}

export interface IFusedTextTarget {
  readonly kind: 'designator' | 'label' | 'reference';
  readonly id: string;
}

/** Changes only the position of the selected text, preserving its owning electrical object. */
export function setTextOffset(
  document: FusedDocument,
  target: IFusedTextTarget,
  offset: Point2D,
): FusedDocument {
  const point = { x: requireFinite(offset.x, 'offset.x'), y: requireFinite(offset.y, 'offset.y') };
  if (target.kind === 'designator')
    return mapInstances(document, [target.id], (instance) => ({
      ...instance,
      designatorOffset: point,
    }));
  if (target.kind === 'label') {
    if (!document.labels.some((value) => value.id === target.id))
      throw new FusedSessionError('edit/invalid-request', `Unknown label: ${target.id}`);
    return {
      ...document,
      labels: document.labels.map((value) =>
        value.id === target.id ? { ...value, offset: point } : value,
      ),
    };
  }
  const reference = document.references.find((value) => value.id === target.id);
  const label = reference?.label;
  if (reference === undefined || label === undefined)
    throw new FusedSessionError(
      'edit/invalid-request',
      `Reference has no movable net label: ${target.id}`,
    );
  return {
    ...document,
    references: document.references.map((value) =>
      value === reference ? { ...value, label: { ...label, offset: point } } : value,
    ),
  };
}

/** Renames the net one label declares; the anchor and display offset stay as they are. */
export function setLabelName(
  document: FusedDocument,
  labelId: string,
  name: string,
): FusedDocument {
  const label = document.labels.find((value) => value.id === labelId);
  if (label === undefined)
    throw new FusedSessionError('edit/unknown-target', `Unknown label ${JSON.stringify(labelId)}.`);
  const next = requireNetName(name);
  if (next === label.name) return document;
  return {
    ...document,
    labels: document.labels.map((value) =>
      value.id === labelId ? { ...value, name: next } : value,
    ),
  };
}

/** Sets the ideal voltage of one reference; a ground symbol stays at 0 V. */
export function setReferenceVoltage(
  document: FusedDocument,
  referenceId: string,
  voltage: number,
): FusedDocument {
  const reference = requireReference(document, referenceId);
  const next = requireFinite(voltage, 'voltage');
  if (reference.symbol === 'ground' && next !== 0)
    throw new FusedSessionError('edit/invalid-request', 'A ground symbol keeps 0 V.');
  if (next === reference.voltage) return document;
  return {
    ...document,
    references: document.references.map((value) =>
      value.id === referenceId ? { ...value, voltage: next } : value,
    ),
  };
}

/** Renames or removes the net name a power symbol owns. */
export function setReferenceLabelName(
  document: FusedDocument,
  referenceId: string,
  name: string | undefined,
): FusedDocument {
  const reference = requireReference(document, referenceId);
  if (reference.symbol === undefined)
    throw new FusedSessionError('edit/invalid-request', 'Only a reference symbol owns a net name.');
  if (reference.symbol === 'ground')
    throw new FusedSessionError('edit/invalid-request', 'A ground symbol is always GND.');
  const label =
    name === undefined
      ? undefined
      : {
          name: requireNetName(name),
          ...(reference.label?.offset === undefined ? {} : { offset: reference.label.offset }),
        };
  if (label?.name === reference.label?.name) return document;
  const { id, target, voltage, symbol, rotation } = reference;
  const next: VoltageReference = {
    id,
    target,
    voltage,
    ...(symbol === undefined ? {} : { symbol }),
    ...(rotation === undefined ? {} : { rotation }),
    ...(label === undefined ? {} : { label }),
  };
  return {
    ...document,
    references: document.references.map((value) => (value.id === referenceId ? next : value)),
  };
}

/** Allocates one element id; the session defaults to `crypto.randomUUID`. */
export type IdFactory = () => string;
export interface IAddInstanceResult {
  readonly document: FusedDocument;
  readonly instanceId: string;
}

export interface IFusedLabelOptions {
  readonly offset?: Point2D;
}

export interface IFusedReferenceOptions {
  /** Clockwise rotation in degrees around the anchor; defaults to `0`. */
  readonly rotation?: number;
  /** Net name owned by the symbol together with its display offset. */
  readonly label?: { readonly name: string; readonly offset?: Point2D };
}

/**
 * Adds one placed instance and locks the release it needs.
 *
 * Physical devices drop `width`/`height` (the package geometry sizes them); flexible devices
 * require both as finite positive numbers.
 *
 * @throws {FusedSessionError} when the placement is unusable or the device id is locked to another
 * release; the dependency table is never rewritten for a new version.
 */
export function addInstance(
  document: FusedDocument,
  device: IPreparedDevice,
  placement: Placement2D,
  createId: IdFactory,
): IAddInstanceResult {
  const dependencies = withDependency(document.dependencies, device.lock);
  const normalized = normalizePlacement(placement, device.geometry.sizing);
  const designator = allocateDesignator(
    device.manifest.designatorPrefix ?? 'U',
    usedDesignators(document),
  );
  const instanceId = takeFreshId(takenIds(document), createId);
  const instance: FusedInstance = {
    id: instanceId,
    device: device.lock.id,
    designator,
    placement: normalized,
  };
  return {
    document: { ...document, dependencies, instances: [...document.instances, instance] },
    instanceId,
  };
}

/**
 * Removes instances, wires, nodes, labels and references as one change.
 *
 * Removing an instance also removes its labels, references and attached wires; removing a node
 * removes what hangs on it; removing a reference drops its node anchor once nothing else uses it.
 */
export function removeTargets(
  document: FusedDocument,
  targets: readonly IFusedDocumentTarget[],
): FusedDocument {
  const instances = new Map(document.instances.map((instance) => [instance.id, instance]));
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  const wires = new Map(document.wires.map((wire) => [wire.id, wire]));
  const labels = new Map(document.labels.map((label) => [label.id, label]));
  const references = new Map(document.references.map((reference) => [reference.id, reference]));

  const removedInstances = new Set<string>();
  const removedNodes = new Set<string>();
  const removedWires = new Set<string>();
  const removedLabels = new Set<string>();
  const removedReferences = new Set<string>();
  const prunedAnchors = new Set<string>();

  for (const target of targets) {
    switch (target.kind) {
      case 'instance':
        removedInstances.add(requireEntry(instances, target).id);
        break;
      case 'node':
        removedNodes.add(requireEntry(nodes, target).id);
        break;
      case 'wire':
        removedWires.add(requireEntry(wires, target).id);
        break;
      case 'label':
        removedLabels.add(requireEntry(labels, target).id);
        break;
      case 'reference': {
        const reference = requireEntry(references, target);
        removedReferences.add(reference.id);
        if (reference.target.kind === 'node') {
          prunedAnchors.add(reference.target.node);
        }
        break;
      }
      default:
        throw new FusedSessionError(
          'edit/invalid-request',
          `Unknown target kind ${JSON.stringify((target as { kind?: unknown }).kind)}.`,
        );
    }
  }

  const endpointRemoved = (endpoint: Endpoint): boolean =>
    endpoint.kind === 'pin'
      ? removedInstances.has(endpoint.instance)
      : removedNodes.has(endpoint.node);

  for (const wire of document.wires) {
    if (endpointRemoved(wire.from) || endpointRemoved(wire.to)) {
      removedWires.add(wire.id);
    }
  }
  for (const label of document.labels) {
    if (endpointRemoved(label.target)) {
      removedLabels.add(label.id);
    }
  }
  for (const reference of document.references) {
    if (endpointRemoved(reference.target)) {
      removedReferences.add(reference.id);
    }
  }

  if (
    removedInstances.size === 0 &&
    removedNodes.size === 0 &&
    removedWires.size === 0 &&
    removedLabels.size === 0 &&
    removedReferences.size === 0
  ) {
    return document;
  }

  const keptWires = document.wires.filter((wire) => !removedWires.has(wire.id));
  const keptLabels = document.labels.filter((label) => !removedLabels.has(label.id));
  const keptReferences = document.references.filter(
    (reference) => !removedReferences.has(reference.id),
  );

  // RFC 0024: deleting a symbol drops its anchor node once no wire, label or other reference uses it.
  for (const nodeId of prunedAnchors) {
    if (removedNodes.has(nodeId)) {
      continue;
    }
    const used =
      keptWires.some((wire) => touchesNode(wire, nodeId)) ||
      keptLabels.some((label) => label.target.kind === 'node' && label.target.node === nodeId) ||
      keptReferences.some(
        (reference) => reference.target.kind === 'node' && reference.target.node === nodeId,
      );
    if (!used) {
      removedNodes.add(nodeId);
    }
  }

  return {
    ...document,
    instances: document.instances.filter((instance) => !removedInstances.has(instance.id)),
    nodes: document.nodes.filter((node) => !removedNodes.has(node.id)),
    wires: keptWires,
    labels: keptLabels,
    references: keptReferences,
  };
}

/** Offsets instances by a scene-space delta; connections and rotation stay untouched. */
export function moveInstances(
  document: FusedDocument,
  instanceIds: readonly string[],
  delta: Point2D,
): FusedDocument {
  const dx = requireFinite(delta?.x, 'delta.x');
  const dy = requireFinite(delta?.y, 'delta.y');
  return mapInstances(document, instanceIds, (instance) => ({
    ...instance,
    placement: {
      ...instance.placement,
      x: instance.placement.x + dx,
      y: instance.placement.y + dy,
    },
  }));
}

/** Moves one instance so its origin lands on `position`. */
export function setInstancePosition(
  document: FusedDocument,
  instanceId: string,
  position: Point2D,
): FusedDocument {
  const x = requireFinite(position?.x, 'position.x');
  const y = requireFinite(position?.y, 'position.y');
  return mapInstances(document, [instanceId], (instance) => ({
    ...instance,
    placement: { ...instance.placement, x, y },
  }));
}

/** Rotates instances clockwise by `degrees`, normalized to `[0, 360)`. */
export function rotateInstances(
  document: FusedDocument,
  instanceIds: readonly string[],
  degrees: number,
): FusedDocument {
  const delta = requireFinite(degrees, 'degrees');
  return mapInstances(document, instanceIds, (instance) => ({
    ...instance,
    placement: {
      ...instance.placement,
      rotation: normalizeDegrees(instance.placement.rotation + delta),
    },
  }));
}

/** Sets the clockwise rotation of one reference symbol around its anchor. */
export function setReferenceRotation(
  document: FusedDocument,
  referenceId: string,
  rotation: number,
): FusedDocument {
  const reference = requireReference(document, referenceId);
  const next = normalizeDegrees(requireFinite(rotation, 'rotation'));
  if (next === (reference.rotation ?? 0)) return document;
  return {
    ...document,
    references: document.references.map((value) =>
      value.id === referenceId ? { ...value, rotation: next } : value,
    ),
  };
}

/** Rotates selected devices and reference symbols around their own electrical anchors. */ export function rotateTargets(
  document: FusedDocument,
  targets: readonly IFusedDocumentTarget[],
  degrees: number,
): FusedDocument {
  const delta = requireFinite(degrees, 'degrees');
  const rotated = rotateInstances(
    document,
    targets.filter((value) => value.kind === 'instance').map((value) => value.id),
    delta,
  );
  const ids = new Set(
    targets.filter((value) => value.kind === 'reference').map((value) => value.id),
  );
  for (const id of ids) {
    if (!document.references.some((value) => value.id === id))
      throw new FusedSessionError('edit/invalid-request', `Unknown reference: ${id}`);
  }
  if (ids.size === 0) return rotated;
  return {
    ...rotated,
    references: rotated.references.map((value) =>
      ids.has(value.id)
        ? { ...value, rotation: normalizeDegrees((value.rotation ?? 0) + delta) }
        : value,
    ),
  };
}

/**
 * Renames one instance designator.
 *
 * A saved designator must be a non-empty string that no other instance uses; the value is validated
 * before the commit, so the document never carries a duplicate.
 *
 * @throws {FusedSessionError} (`edit/duplicate-designator`) when another instance owns the name.
 */
export function renameDesignator(
  document: FusedDocument,
  instanceId: string,
  designator: string,
): FusedDocument {
  if (typeof designator !== 'string' || designator.length === 0) {
    throw new FusedSessionError('edit/invalid-request', 'A designator must be a non-empty string.');
  }
  const instance = requireInstance(document, instanceId);
  if (instance.designator === designator) {
    return document;
  }
  const clash = document.instances.some(
    (entry) => entry.id !== instanceId && entry.designator === designator,
  );
  if (clash) {
    throw new FusedSessionError(
      'edit/duplicate-designator',
      `Designator "${designator}" is already used by another instance.`,
    );
  }
  return replaceInstance(document, { ...instance, designator });
}

/** Stores one property override; `null` is a valid value when the device declares it nullable. */
export function setInstanceProperty(
  document: FusedDocument,
  instanceId: string,
  key: string,
  value: PropertyValue,
): FusedDocument {
  if (typeof key !== 'string' || key.length === 0) {
    throw new FusedSessionError(
      'edit/invalid-request',
      'A property key must be a non-empty string.',
    );
  }
  const instance = requireInstance(document, instanceId);
  return replaceInstance(document, {
    ...instance,
    properties: { ...(instance.properties ?? {}), [key]: value },
  });
}

/** Drops one property override; an unknown key is a no-op. */
export function removeInstanceProperty(
  document: FusedDocument,
  instanceId: string,
  key: string,
): FusedDocument {
  const instance = requireInstance(document, instanceId);
  const properties = instance.properties;
  if (properties === undefined || !Object.hasOwn(properties, key)) {
    return document;
  }
  const next: Record<string, PropertyValue> = {};
  for (const [name, value] of Object.entries(properties)) {
    if (name !== key) {
      next[name] = value;
    }
  }
  return replaceInstance(
    document,
    Object.keys(next).length === 0
      ? omitKeys(instance, 'properties')
      : { ...instance, properties: next },
  );
}

/** Adds a free or junction node at `point`. */
export function addNode(
  document: FusedDocument,
  point: Point2D,
  kind: ConnectionNode['kind'],
  createId: IdFactory,
): { readonly document: FusedDocument; readonly nodeId: string } {
  const x = requireFinite(point?.x, 'point.x');
  const y = requireFinite(point?.y, 'point.y');
  if (kind !== 'junction' && kind !== 'free') {
    throw new FusedSessionError(
      'edit/invalid-request',
      'A node kind must be "junction" or "free".',
    );
  }
  const nodeId = takeFreshId(takenIds(document), createId);
  const node: ConnectionNode = { id: nodeId, kind, x, y };
  return { document: { ...document, nodes: [...document.nodes, node] }, nodeId };
}

/** Adds one wire between two existing endpoints; `bends` are the intermediate points only. */
export function addWire(
  document: FusedDocument,
  from: Endpoint,
  to: Endpoint,
  bends: readonly Point2D[],
  createId: IdFactory,
): { readonly document: FusedDocument; readonly wireId: string } {
  requireEndpoint(document, from, 'from');
  requireEndpoint(document, to, 'to');
  if (sameEndpoint(from, to)) {
    throw new FusedSessionError(
      'edit/invalid-request',
      'A wire must connect two different endpoints.',
    );
  }
  const points = (bends ?? []).map((bend, index) => ({
    x: requireFinite(bend?.x, `bends[${String(index)}].x`),
    y: requireFinite(bend?.y, `bends[${String(index)}].y`),
  }));
  const wireId = takeFreshId(takenIds(document), createId);
  const wire: ConnectionWire = { id: wireId, from, to, bends: points };
  return { document: { ...document, wires: [...document.wires, wire] }, wireId };
}

/** Declares a net name on one endpoint. */
export function addLabel(
  document: FusedDocument,
  target: Endpoint,
  name: string,
  options: IFusedLabelOptions = {},
  createId: IdFactory,
): { readonly document: FusedDocument; readonly labelId: string } {
  requireEndpoint(document, target, 'target');
  if (typeof name !== 'string' || name.length === 0) {
    throw new FusedSessionError('edit/invalid-request', 'A net name must be a non-empty string.');
  }
  const offset = readOffset(options.offset, 'options.offset');
  const labelId = takeFreshId(takenIds(document), createId);
  const label: NetLabel = {
    id: labelId,
    target,
    name,
    ...(offset === undefined ? {} : { offset }),
  };
  return { document: { ...document, labels: [...document.labels, label] }, labelId };
}

/** Attaches an ideal voltage reference, optionally with the built-in power or ground symbol. */
export function addReference(
  document: FusedDocument,
  target: Endpoint,
  voltage: number,
  symbol: VoltageReference['symbol'],
  options: IFusedReferenceOptions = {},
  createId: IdFactory,
): { readonly document: FusedDocument; readonly referenceId: string } {
  requireEndpoint(document, target, 'target');
  const value = requireFinite(voltage, 'voltage');
  if (symbol !== undefined && symbol !== 'power' && symbol !== 'ground') {
    throw new FusedSessionError(
      'edit/invalid-request',
      'A reference symbol must be "power", "ground" or omitted.',
    );
  }
  if (symbol === 'ground' && value !== 0) {
    throw new FusedSessionError(
      'edit/invalid-request',
      'The ground symbol requires a reference voltage of 0.',
    );
  }
  const rotation =
    options.rotation === undefined
      ? undefined
      : requireFinite(options.rotation, 'options.rotation');
  const label = readReferenceLabel(options.label);
  const referenceId = takeFreshId(takenIds(document), createId);
  const reference: VoltageReference = {
    id: referenceId,
    target,
    voltage: value,
    ...(symbol === undefined ? {} : { symbol }),
    ...(rotation === undefined || rotation === 0 ? {} : { rotation }),
    ...(label === undefined ? {} : { label }),
  };
  return {
    document: { ...document, references: [...document.references, reference] },
    referenceId,
  };
}

/** Stores the per-instance sidebar and HTML view layout; `undefined` restores the defaults. */
export function setViewLayout(
  document: FusedDocument,
  instanceId: string,
  layout: InstanceViewLayout | undefined,
): FusedDocument {
  const instance = requireInstance(document, instanceId);
  return replaceInstance(
    document,
    layout === undefined ? omitViewLayout(instance) : { ...instance, viewLayout: layout },
  );
}

/** Finds one instance. */
export function findInstance(
  document: FusedDocument,
  instanceId: string,
): FusedInstance | undefined {
  return document.instances.find((instance) => instance.id === instanceId);
}

/** Locks `lock` in the dependency table, refusing to replace a different release. */
export function withDependency(
  dependencies: Readonly<Record<string, DeviceDependency>>,
  lock: { readonly id: string; readonly version: string; readonly integrity: string },
): Readonly<Record<string, DeviceDependency>> {
  const existing = dependencies[lock.id];
  if (existing !== undefined) {
    if (existing.version !== lock.version || existing.integrity !== lock.integrity) {
      throw new FusedSessionError(
        'document/locked-conflict',
        `"${lock.id}" is already locked to ${existing.version}; replace the dependency explicitly instead of overwriting it.`,
      );
    }
    return dependencies;
  }
  return { ...dependencies, [lock.id]: { version: lock.version, integrity: lock.integrity } };
}

/** Smallest unused `<prefix><n>` designator, starting at 1 (RFC 0024). */
export function allocateDesignator(prefix: string, used: ReadonlySet<string>): string {
  for (let index = 1; ; index += 1) {
    const candidate = `${prefix}${String(index)}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

export function usedDesignators(document: FusedDocument): Set<string> {
  const used = new Set<string>();
  for (const instance of document.instances) {
    if (instance.designator !== undefined) {
      used.add(instance.designator);
    }
  }
  return used;
}

/** Every element id the document already uses; new ids must not collide with any of them. */
export function takenIds(document: FusedDocument): Set<string> {
  return new Set<string>([
    ...document.instances.map((entry) => entry.id),
    ...document.nodes.map((entry) => entry.id),
    ...document.wires.map((entry) => entry.id),
    ...document.labels.map((entry) => entry.id),
    ...document.references.map((entry) => entry.id),
  ]);
}

/** Allocates an id that `taken` does not contain and records it. */
export function takeFreshId(taken: Set<string>, createId: IdFactory): string {
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const id = createId();
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
  throw new FusedSessionError('edit/invalid-request', 'Could not allocate a unique element id.');
}

/** Validates that an endpoint names an object of this document. */
export function requireEndpoint(document: FusedDocument, endpoint: Endpoint, label: string): void {
  if (endpoint === null || typeof endpoint !== 'object') {
    throw new FusedSessionError(
      'edit/invalid-request',
      `"${label}" must be a pin or node endpoint.`,
    );
  }
  if (endpoint.kind === 'pin') {
    if (
      typeof endpoint.instance !== 'string' ||
      !document.instances.some((instance) => instance.id === endpoint.instance)
    ) {
      throw new FusedSessionError(
        'edit/unknown-target',
        `"${label}" references the unknown instance ${JSON.stringify(endpoint.instance)}.`,
      );
    }
    if (typeof endpoint.pin !== 'string' || endpoint.pin.length === 0) {
      throw new FusedSessionError('edit/invalid-request', `"${label}" needs a pin id.`);
    }
    return;
  }
  if (endpoint.kind === 'node') {
    if (
      typeof endpoint.node !== 'string' ||
      !document.nodes.some((node) => node.id === endpoint.node)
    ) {
      throw new FusedSessionError(
        'edit/unknown-target',
        `"${label}" references the unknown node ${JSON.stringify(endpoint.node)}.`,
      );
    }
    return;
  }
  throw new FusedSessionError('edit/invalid-request', `"${label}" has an unknown endpoint kind.`);
}

function normalizePlacement(placement: Placement2D, sizing: 'physical' | 'flexible'): Placement2D {
  if (placement === null || typeof placement !== 'object') {
    throw new FusedSessionError('edit/invalid-request', 'A placement object is required.');
  }
  const x = requireFinite(placement.x, 'placement.x');
  const y = requireFinite(placement.y, 'placement.y');
  const rotation = requireFinite(placement.rotation ?? 0, 'placement.rotation');
  if (sizing === 'physical') {
    return { x, y, rotation };
  }
  return {
    x,
    y,
    rotation,
    width: requirePositive(placement.width, 'placement.width'),
    height: requirePositive(placement.height, 'placement.height'),
  };
}

function mapInstances(
  document: FusedDocument,
  instanceIds: readonly string[],
  update: (instance: FusedInstance) => FusedInstance,
): FusedDocument {
  const ids = new Set(instanceIds);
  for (const id of ids) {
    requireInstance(document, id);
  }
  if (ids.size === 0) {
    return document;
  }
  return {
    ...document,
    instances: document.instances.map((instance) =>
      ids.has(instance.id) ? update(instance) : instance,
    ),
  };
}

function replaceInstance(document: FusedDocument, instance: FusedInstance): FusedDocument {
  return {
    ...document,
    instances: document.instances.map((entry) => (entry.id === instance.id ? instance : entry)),
  };
}

function requireInstance(document: FusedDocument, instanceId: string): FusedInstance {
  const instance = findInstance(document, instanceId);
  if (instance === undefined) {
    throw new FusedSessionError(
      'edit/unknown-target',
      `Unknown instance ${JSON.stringify(instanceId)}.`,
    );
  }
  return instance;
}

function requireReference(document: FusedDocument, referenceId: string): VoltageReference {
  const reference = document.references.find((value) => value.id === referenceId);
  if (reference === undefined) {
    throw new FusedSessionError(
      'edit/unknown-target',
      `Unknown reference ${JSON.stringify(referenceId)}.`,
    );
  }
  return reference;
}

function requireNetName(name: string): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length === 0) {
    throw new FusedSessionError('edit/invalid-request', 'A net name must be a non-empty string.');
  }
  return trimmed;
}

function requireEntry<T extends { readonly id: string }>(
  entries: ReadonlyMap<string, T>,
  target: IFusedDocumentTarget,
): T {
  const entry = entries.get(target.id);
  if (entry === undefined) {
    throw new FusedSessionError(
      'edit/unknown-target',
      `Unknown ${target.kind} ${JSON.stringify(target.id)}.`,
    );
  }
  return entry;
}

function touchesNode(wire: ConnectionWire, nodeId: string): boolean {
  return (
    (wire.from.kind === 'node' && wire.from.node === nodeId) ||
    (wire.to.kind === 'node' && wire.to.node === nodeId)
  );
}

export function sameEndpoint(a: Endpoint, b: Endpoint): boolean {
  if (a.kind === 'pin' && b.kind === 'pin') {
    return a.instance === b.instance && a.pin === b.pin;
  }
  if (a.kind === 'node' && b.kind === 'node') {
    return a.node === b.node;
  }
  return false;
}

function normalizeDegrees(value: number): number {
  const normalized = value % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function readOffset(value: Point2D | undefined, label: string): Point2D | undefined {
  if (value === undefined) {
    return undefined;
  }
  return { x: requireFinite(value.x, `${label}.x`), y: requireFinite(value.y, `${label}.y`) };
}

function readReferenceLabel(
  value: IFusedReferenceOptions['label'],
): { readonly name: string; readonly offset?: Point2D } | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value.name !== 'string' || value.name.length === 0) {
    throw new FusedSessionError(
      'edit/invalid-request',
      'A reference label needs a non-empty net name.',
    );
  }
  const offset = readOffset(value.offset, 'options.label.offset');
  return { name: value.name, ...(offset === undefined ? {} : { offset }) };
}

function omitViewLayout(instance: FusedInstance): FusedInstance {
  return omitKeys(instance, 'viewLayout');
}

function omitKeys(
  instance: FusedInstance,
  ...keys: readonly (keyof FusedInstance)[]
): FusedInstance {
  const next: Record<string, unknown> = { ...instance };
  for (const key of keys) {
    delete next[key];
  }
  return next as unknown as FusedInstance;
}

function requireFinite(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new FusedSessionError('edit/invalid-request', `"${label}" must be a finite number.`);
  }
  return value;
}

function requirePositive(value: number | undefined, label: string): number {
  const number = requireFinite(value as number, label);
  if (number <= 0) {
    throw new FusedSessionError('edit/invalid-request', `"${label}" must be a positive number.`);
  }
  return number;
}
