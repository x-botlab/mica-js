/**
 * Clipboard of a fused subgraph (RFC 0024).
 *
 * A copy keeps only what stays inside the selection: instances and nodes that were selected, the
 * wires between them, and the labels and references attached to them. Edges to objects outside the
 * selection are neither copied nor retargeted; a paste allocates new ids and designators and maps
 * every internal reference onto the copy.
 */
import type {
  ConnectionNode,
  ConnectionWire,
  DeviceDependency,
  Endpoint,
  FusedDocument,
  FusedInstance,
  NetLabel,
  Point2D,
  VoltageReference,
} from '@mica-js/document/fused';
import type { IPreparedDevice } from '../devices';
import { FusedSessionError } from './errors';
import type { IFusedDocumentTarget } from './edits';
import {
  allocateDesignator,
  takeFreshId,
  takenIds,
  usedDesignators,
  withDependency,
} from './edits';
import type { IdFactory } from './edits';

/** Selected subgraph and the locks its devices need. */
export interface IFusedClipboard {
  readonly dependencies: Readonly<Record<string, DeviceDependency>>;
  readonly instances: readonly FusedInstance[];
  readonly nodes: readonly ConnectionNode[];
  readonly wires: readonly ConnectionWire[];
  readonly labels: readonly NetLabel[];
  readonly references: readonly VoltageReference[];
}

/**
 * Extracts the selected subgraph; a pure read that records no history.
 *
 * Unknown target ids are ignored. Returns `undefined` when the selection holds no instance or node.
 */
export function copyTargets(
  document: FusedDocument,
  targets: readonly IFusedDocumentTarget[],
): IFusedClipboard | undefined {
  const instanceIds = new Set(
    targets.filter((target) => target.kind === 'instance').map((target) => target.id),
  );
  const nodeIds = new Set(
    targets.filter((target) => target.kind === 'node').map((target) => target.id),
  );
  const instances = document.instances.filter((instance) => instanceIds.has(instance.id));
  const nodes = document.nodes.filter((node) => nodeIds.has(node.id));
  if (instances.length === 0 && nodes.length === 0) {
    return undefined;
  }
  const selectedInstances = new Set(instances.map((instance) => instance.id));
  const selectedNodes = new Set(nodes.map((node) => node.id));
  const inside = (endpoint: Endpoint): boolean =>
    endpoint.kind === 'pin'
      ? selectedInstances.has(endpoint.instance)
      : selectedNodes.has(endpoint.node);

  const dependencies: Record<string, DeviceDependency> = {};
  for (const instance of instances) {
    const dependency = document.dependencies[instance.device];
    if (dependency !== undefined) {
      dependencies[instance.device] = dependency;
    }
  }

  return {
    dependencies,
    instances,
    nodes,
    wires: document.wires.filter((wire) => inside(wire.from) && inside(wire.to)),
    labels: document.labels.filter((label) => inside(label.target)),
    references: document.references.filter((reference) => inside(reference.target)),
  };
}

/**
 * Inserts a copied subgraph at `offset` with new ids, designators and internal references.
 *
 * @throws {FusedSessionError} when a copied device is not locked by the clipboard, its release
 * conflicts with the document lock, or it has not been prepared.
 */
export function pasteClipboard(
  document: FusedDocument,
  clipboard: IFusedClipboard,
  offset: Point2D,
  prepared: ReadonlyMap<string, IPreparedDevice>,
  createId: IdFactory,
): FusedDocument {
  const dx = requireFinite(offset?.x, 'offset.x');
  const dy = requireFinite(offset?.y, 'offset.y');
  if (clipboard.instances.length === 0) {
    return document;
  }

  let dependencies = document.dependencies;
  for (const instance of clipboard.instances) {
    const device = prepared.get(instance.device);
    if (device === undefined) {
      throw new FusedSessionError(
        'device/unavailable',
        `Cannot paste ${instance.device}: its release has not been prepared.`,
      );
    }
    dependencies = withDependency(dependencies, device.lock);
  }

  const taken = takenIds(document);
  const designators = usedDesignators(document);
  const instanceIds = new Map<string, string>();
  const instances = clipboard.instances.map((instance) => {
    const id = takeFreshId(taken, createId);
    instanceIds.set(instance.id, id);
    const prefix = prepared.get(instance.device)?.manifest.designatorPrefix ?? 'U';
    const designator = allocateDesignator(prefix, designators);
    designators.add(designator);
    return {
      ...instance,
      id,
      designator,
      placement: {
        ...instance.placement,
        x: instance.placement.x + dx,
        y: instance.placement.y + dy,
      },
    };
  });

  const nodeIds = new Map<string, string>();
  const nodes = clipboard.nodes.map((node) => {
    const id = takeFreshId(taken, createId);
    nodeIds.set(node.id, id);
    return { ...node, id, x: node.x + dx, y: node.y + dy };
  });

  const remap = (endpoint: Endpoint): Endpoint | undefined => {
    if (endpoint.kind === 'pin') {
      const instance = instanceIds.get(endpoint.instance);
      return instance === undefined ? undefined : { kind: 'pin', instance, pin: endpoint.pin };
    }
    const node = nodeIds.get(endpoint.node);
    return node === undefined ? undefined : { kind: 'node', node };
  };

  const wires: ConnectionWire[] = [];
  for (const wire of clipboard.wires) {
    const from = remap(wire.from);
    const to = remap(wire.to);
    if (from === undefined || to === undefined) {
      continue;
    }
    wires.push({
      id: takeFreshId(taken, createId),
      from,
      to,
      bends: wire.bends.map((bend) => ({ x: bend.x + dx, y: bend.y + dy })),
    });
  }

  const labels: NetLabel[] = [];
  for (const label of clipboard.labels) {
    const target = remap(label.target);
    if (target === undefined) {
      continue;
    }
    labels.push({ ...label, id: takeFreshId(taken, createId), target });
  }

  const references: VoltageReference[] = [];
  for (const reference of clipboard.references) {
    const target = remap(reference.target);
    if (target === undefined) {
      continue;
    }
    references.push({ ...reference, id: takeFreshId(taken, createId), target });
  }

  return {
    ...document,
    dependencies,
    instances: [...document.instances, ...instances],
    nodes: [...document.nodes, ...nodes],
    wires: [...document.wires, ...wires],
    labels: [...document.labels, ...labels],
    references: [...document.references, ...references],
  };
}

function requireFinite(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new FusedSessionError('edit/invalid-request', `"${label}" must be a finite number.`);
  }
  return value;
}
