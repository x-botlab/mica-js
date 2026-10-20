import type { Diagnostic } from '../format/diagnostics';
import { throwIfErrors } from '../format/errors';
import type { Point, Rect, SchematicDocument } from '../format/types';
import { isLabelDevice, parseDeviceReference } from '../device/reference';
import type { DeviceSymbolProvider } from '../device/symbol';
import {
  boundsOfPoints,
  pointOnPolyline,
  pointsEqual,
  unionBounds,
  DEFAULT_TOLERANCE,
} from '../geometry/point';
import { symbolBounds, symbolPinPosition } from '../geometry/transform';

export interface SchematicPinInstance {
  readonly symbolId: string;
  readonly pinId: string;
  readonly position: Point;
  /** True when the pin is not connected to any wire, label or other pin. */
  readonly open: boolean;
  /** Name of the net the pin belongs to; `null` for anonymous nets. */
  readonly netName: string | null;
}

export type SchematicNetMember =
  | { readonly kind: 'pin'; readonly symbolId: string; readonly pinId: string }
  | { readonly kind: 'label'; readonly symbolId: string };

export interface SchematicNet {
  /** Label id when the net has exactly one label; `null` when anonymous. */
  readonly name: string | null;
  readonly wireIds: readonly string[];
  readonly members: readonly SchematicNetMember[];
}

export interface DanglingWireEnd {
  readonly wireId: string;
  readonly end: 'start' | 'end';
  readonly point: Point;
}

export interface TopologyOptions {
  readonly devices?: DeviceSymbolProvider;
  /** Coordinate comparison tolerance in page units; defaults to exact matching. */
  readonly tolerance?: number;
}

export interface SchematicTopology {
  readonly nets: readonly SchematicNet[];
  readonly pins: readonly SchematicPinInstance[];
  readonly danglingWireEnds: readonly DanglingWireEnd[];
  /** Bounding box of all wires, pins and symbol outlines. */
  readonly bounds: Rect | undefined;
}

type Connection =
  | {
      readonly kind: 'pin';
      readonly symbolId: string;
      readonly pinId: string;
      readonly point: Point;
    }
  | { readonly kind: 'label'; readonly symbolId: string; readonly point: Point };

/**
 * Derives nets from wires, explicit junctions and symbol connection points (#6).
 *
 * @throws {SchematicError} when a device cannot be resolved or a net has conflicting labels.
 */
export function deriveSchematicTopology(
  document: SchematicDocument,
  options: TopologyOptions = {},
): SchematicTopology {
  const diagnostics: Diagnostic[] = [];
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const { devices } = options;
  const { symbols, wires, junctions } = document.sheet;

  const connections: Connection[] = [];
  let bounds: Rect | undefined;

  for (const symbol of symbols) {
    bounds = unionBounds(bounds, { x: symbol.x, y: symbol.y, width: 0, height: 0 });
    if (isLabelDevice(symbol.device)) {
      connections.push({ kind: 'label', symbolId: symbol.id, point: { x: symbol.x, y: symbol.y } });
      continue;
    }

    const reference = parseDeviceReference(symbol.device);
    if (reference === undefined) {
      if (devices !== undefined) {
        diagnostics.push({
          severity: 'error',
          code: 'device/invalid-reference',
          message: `Symbol "${symbol.id}" has an invalid device reference ${JSON.stringify(symbol.device)}.`,
          entity: { kind: 'symbol', id: symbol.id },
        });
      }
      continue;
    }
    if (devices === undefined) {
      continue;
    }

    const definition = devices.getDeviceSymbol(reference);
    const name = devices.getDeviceName(reference);
    if (name === undefined) {
      diagnostics.push({
        severity: 'error',
        code: 'device/unresolved',
        message: `Symbol "${symbol.id}" references unresolved device ${JSON.stringify(symbol.device)}.`,
        entity: { kind: 'symbol', id: symbol.id },
      });
      continue;
    }
    if (definition === undefined) {
      continue;
    }

    bounds = unionBounds(bounds, symbolBounds(symbol, definition.bounds, definition.pins));
    for (const [pinId, anchor] of Object.entries(definition.pins)) {
      const position = symbolPinPosition(symbol, anchor);
      connections.push({ kind: 'pin', symbolId: symbol.id, pinId, point: position });
      bounds = unionBounds(bounds, { x: position.x, y: position.y, width: 0, height: 0 });
    }
  }

  for (const wire of wires) {
    bounds = unionBounds(bounds, boundsOfPoints(wire.points));
  }

  const wireIndex = new Map<string, number>();
  wires.forEach((wire, index) => wireIndex.set(wire.id, index));
  const wireCount = wires.length;
  const parent = new Array<number>(wireCount + connections.length);
  for (let index = 0; index < parent.length; index += 1) {
    parent[index] = index;
  }

  const find = (node: number): number => {
    let root = node;
    while (parent[root] !== root) {
      const next = parent[root] as number;
      parent[root] = parent[next] as number;
      root = next;
    }
    return root;
  };

  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent[rootB] = rootA;
    }
  };

  for (const junction of junctions) {
    const targets = junction.wires
      .map((wireId) => wireIndex.get(wireId))
      .filter((index): index is number => index !== undefined);
    const [first, ...rest] = targets;
    if (first === undefined) {
      continue;
    }
    for (const target of rest) {
      union(first, target);
    }
  }

  /** Wire index → connection indexes attached to it. */
  const wireAttachments = new Map<number, number[]>();
  connections.forEach((connection, connectionIndex) => {
    wires.forEach((wire, index) => {
      if (!pointOnPolyline(wire.points, connection.point, tolerance)) {
        return;
      }
      union(index, wireCount + connectionIndex);
      const attached = wireAttachments.get(index);
      if (attached === undefined) {
        wireAttachments.set(index, [connectionIndex]);
      } else {
        attached.push(connectionIndex);
      }
    });
  });

  const groups = new Map<number, { wires: number[]; connections: number[] }>();
  const groupOf = (root: number): { wires: number[]; connections: number[] } => {
    const existing = groups.get(root);
    if (existing !== undefined) {
      return existing;
    }
    const created = { wires: [], connections: [] };
    groups.set(root, created);
    return created;
  };
  wires.forEach((_, index) => {
    groupOf(find(index)).wires.push(index);
  });
  connections.forEach((_, connectionIndex) => {
    groupOf(find(wireCount + connectionIndex)).connections.push(connectionIndex);
  });

  const netOfConnection = new Map<number, SchematicNet>();
  const nets: SchematicNet[] = [];
  for (const group of groups.values()) {
    const connected = group.wires.length > 0 || group.connections.length >= 2;
    if (group.connections.length === 0 || !connected) {
      continue;
    }
    const labels = group.connections
      .map((index) => connections[index])
      .filter(
        (connection): connection is Extract<Connection, { kind: 'label' }> =>
          connection?.kind === 'label',
      )
      .map((connection) => connection.symbolId)
      .sort();
    let name: string | null = null;
    if (labels.length === 1) {
      name = labels[0] as string;
    } else if (labels.length > 1) {
      diagnostics.push({
        severity: 'error',
        code: 'net/naming-conflict',
        message: `Net has conflicting labels: ${labels.map((label) => JSON.stringify(label)).join(', ')}.`,
      });
    }

    const members: SchematicNetMember[] = group.connections
      .map((index) => connections[index])
      .map((connection): SchematicNetMember | undefined => {
        if (connection === undefined) {
          return undefined;
        }
        return connection.kind === 'pin'
          ? { kind: 'pin', symbolId: connection.symbolId, pinId: connection.pinId }
          : { kind: 'label', symbolId: connection.symbolId };
      })
      .filter((member): member is SchematicNetMember => member !== undefined)
      .sort(compareMembers);

    const net: SchematicNet = {
      name,
      wireIds: group.wires
        .map((index) => wires[index]?.id)
        .filter((id): id is string => id !== undefined)
        .sort(),
      members,
    };
    nets.push(net);
    for (const index of group.connections) {
      netOfConnection.set(index, net);
    }
  }

  const pins: SchematicPinInstance[] = [];
  connections.forEach((connection, index) => {
    if (connection.kind !== 'pin') {
      return;
    }
    const net = netOfConnection.get(index);
    pins.push({
      symbolId: connection.symbolId,
      pinId: connection.pinId,
      position: connection.point,
      open: net === undefined,
      netName: net?.name ?? null,
    });
  });
  pins.sort((a, b) => a.symbolId.localeCompare(b.symbolId) || a.pinId.localeCompare(b.pinId));

  const danglingWireEnds: DanglingWireEnd[] = [];
  wires.forEach((wire, index) => {
    const endpoints: readonly { end: 'start' | 'end'; point: Point | undefined }[] = [
      { end: 'start', point: wire.points[0] },
      { end: 'end', point: wire.points[wire.points.length - 1] },
    ];
    for (const { end, point } of endpoints) {
      if (point === undefined) {
        continue;
      }
      const attached = (wireAttachments.get(index) ?? []).some((connectionIndex) => {
        const connection = connections[connectionIndex];
        return connection !== undefined && pointsEqual(connection.point, point, tolerance);
      });
      const junctioned = junctions.some(
        (junction) =>
          junction.wires.includes(wire.id) &&
          pointsEqual({ x: junction.x, y: junction.y }, point, tolerance),
      );
      if (!attached && !junctioned) {
        danglingWireEnds.push({ wireId: wire.id, end, point });
      }
    }
  });
  danglingWireEnds.sort((a, b) => a.wireId.localeCompare(b.wireId) || a.end.localeCompare(b.end));

  throwIfErrors(diagnostics);

  return {
    nets: nets.sort(
      (a, b) => compareNetNames(a.name, b.name) || compareMembers(a.members[0], b.members[0]),
    ),
    pins,
    danglingWireEnds,
    bounds,
  };
}

function compareMembers(
  a: SchematicNetMember | undefined,
  b: SchematicNetMember | undefined,
): number {
  if (a === undefined || b === undefined) {
    return a === undefined ? (b === undefined ? 0 : 1) : -1;
  }
  if (a.kind !== b.kind) {
    return a.kind === 'label' ? -1 : 1;
  }
  const bySymbol = a.symbolId.localeCompare(b.symbolId);
  if (bySymbol !== 0) {
    return bySymbol;
  }
  const pinA = a.kind === 'pin' ? a.pinId : '';
  const pinB = b.kind === 'pin' ? b.pinId : '';
  return pinA.localeCompare(pinB);
}

function compareNetNames(a: string | null, b: string | null): number {
  if (a === null || b === null) {
    return a === null ? (b === null ? 0 : 1) : -1;
  }
  return a.localeCompare(b);
}
