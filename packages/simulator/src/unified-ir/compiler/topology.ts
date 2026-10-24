import {
  UnifiedIRCompilerError,
  type CompilationDiagnostic,
  type CompiledNet,
  type CompiledNetlist,
  type CompiledPinConnection,
  type CompiledRail,
  type Connection,
  type GlobalPinMap,
  type ResolvedDevicePin,
} from './types';

/** Rails every circuit understands without declaring them. */
export const DEFAULT_RAILS: Readonly<Record<string, boolean>> = Object.freeze({
  GND: false,
  VCC: true,
  VDD: true,
});

/** Options for {@link NetworkTopologyAnalyzer}. */
export interface TopologyOptions {
  /** Extra or overriding rails; merged over {@link DEFAULT_RAILS}. */
  readonly rails?: Readonly<Record<string, boolean>>;
  /** Treat several drivers on one net as a wired-OR instead of a conflict. */
  readonly allowMultiDriver?: boolean;
}

interface ResolvedPinEndpoint {
  readonly kind: 'pin';
  readonly nodeId: number;
  readonly pin: ResolvedDevicePin;
}

interface ResolvedRailEndpoint {
  readonly kind: 'rail';
  readonly nodeId: number;
  readonly name: string;
  readonly level: boolean;
}

type ResolvedEndpoint = ResolvedPinEndpoint | ResolvedRailEndpoint;

interface ComponentPins {
  readonly pins: CompiledPinConnection[];
  readonly rails: CompiledRail[];
  readonly endpoints: string[];
}

/**
 * Analyses the pin-to-pin connections of a circuit.
 *
 * 1. every connection edge joins two nodes (pins and rails);
 * 2. a union-find pass collapses them into electrical nets (connected components);
 * 3. each net gets an id in first-appearance order and is split into drivers,
 *    loads and sinks;
 * 4. electrical conflicts (several drivers, a driver against a rail, two rails
 *    of opposite level) become diagnostics instead of silently wrong IR.
 *
 * The v1 electrical model supports one driver per net. `allowMultiDriver`
 * accepts more and the solver then emits a wired-OR instead of failing.
 */
export class NetworkTopologyAnalyzer {
  private readonly rails: ReadonlyMap<string, boolean>;
  private readonly allowMultiDriver: boolean;

  constructor(options: TopologyOptions = {}) {
    this.rails = new Map([
      ...Object.entries(DEFAULT_RAILS),
      ...Object.entries(options.rails ?? {}),
    ]);
    this.allowMultiDriver = options.allowMultiDriver ?? false;
  }

  /**
   * @throws {UnifiedIRCompilerError} when a connection is malformed, names an
   *   unknown device, or names a pin the device does not declare.
   */
  analyze(connections: readonly Connection[], pins: GlobalPinMap): CompiledNetlist {
    if (!Array.isArray(connections)) {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        'CircuitCompilationInput.connections must be an array',
      );
    }

    const set = new DisjointSet();
    const pinNodes = new Map<number, CompiledPinConnection>();
    const railNodes = new Map<number, CompiledRail>();
    const railNodeIds = new Map<string, number>();
    const connectionOrder: number[] = [];

    for (const [index, connection] of connections.entries()) {
      if (connection === null || typeof connection !== 'object') {
        throw new UnifiedIRCompilerError(
          'invalid-connection',
          `Connection[${index}] must be an object with "from" and "to"`,
        );
      }
      const from = this.resolveEndpoint(connection.from, pins, railNodeIds, index);
      const to = this.resolveEndpoint(connection.to, pins, railNodeIds, index);
      set.union(from.nodeId, to.nodeId);
      connectionOrder.push(from.nodeId);
      if (from.kind === 'pin') pinNodes.set(from.pin.globalPinId, toConnection(from.pin));
      else railNodes.set(from.nodeId, Object.freeze({ name: from.name, level: from.level }));
      if (to.kind === 'pin') pinNodes.set(to.pin.globalPinId, toConnection(to.pin));
      else railNodes.set(to.nodeId, Object.freeze({ name: to.name, level: to.level }));
    }

    // Component identity is the union-find root; the first connection that
    // touches a component decides its net id, which keeps ids stable.
    const components = new Map<number, ComponentPins>();
    const componentOf = (nodeId: number): ComponentPins => {
      const root = set.find(nodeId);
      let component = components.get(root);
      if (component === undefined) {
        component = { pins: [], rails: [], endpoints: [] };
        components.set(root, component);
      }
      return component;
    };

    for (const [pinId, connection] of pinNodes) componentOf(pinId).pins.push(connection);
    for (const [nodeId, rail] of railNodes) {
      const component = componentOf(nodeId);
      component.rails.push(rail);
      component.endpoints.push(rail.name);
    }

    const orderedRoots: number[] = [];
    const seen = new Set<number>();
    for (const nodeId of connectionOrder) {
      const root = set.find(nodeId);
      if (seen.has(root)) continue;
      seen.add(root);
      orderedRoots.push(root);
    }

    const diagnostics: CompilationDiagnostic[] = [];
    const nets: CompiledNet[] = [];
    for (const root of orderedRoots) {
      const component = components.get(root);
      if (component === undefined) continue;
      component.pins.sort((left, right) => left.globalPinId - right.globalPinId);
      component.rails.sort((left, right) => left.name.localeCompare(right.name));
      const endpoints = [...component.endpoints, ...component.pins.map((pin) => pin.endpoint)];

      if (component.pins.length === 0) {
        // Rail-to-rail wiring only: report a short, never emit a net.
        const levels = new Set(component.rails.map((rail) => rail.level));
        if (levels.size > 1) {
          diagnostics.push(
            diagnostic(
              'rail-conflict',
              'error',
              `Rails ${component.rails.map((rail) => rail.name).join(' and ')} are wired together with opposite levels`,
              undefined,
              endpoints,
            ),
          );
        }
        continue;
      }

      const netId = nets.length;
      const net = this.classify(netId, component.pins, component.rails, diagnostics);
      nets.push(net);
    }

    return Object.freeze({ nets: Object.freeze(nets), diagnostics: Object.freeze(diagnostics) });
  }

  private classify(
    netId: number,
    pins: readonly CompiledPinConnection[],
    rails: readonly CompiledRail[],
    diagnostics: CompilationDiagnostic[],
  ): CompiledNet {
    const drivers = pins.filter((pin) => pin.role === 'driver');
    const loads = pins.filter((pin) => pin.role === 'load');
    const sinks = pins.filter((pin) => pin.senses);
    const endpoints = [...rails.map((rail) => rail.name), ...pins.map((pin) => pin.endpoint)];
    const levels = new Set(rails.map((rail) => rail.level));

    if (rails.length > 1 && levels.size > 1) {
      diagnostics.push(
        diagnostic(
          'rail-conflict',
          'error',
          `Net ${netId} ties rails ${rails.map((rail) => rail.name).join(' and ')} with opposite levels`,
          netId,
          endpoints,
        ),
      );
    }
    if (drivers.length > 1) {
      const names = drivers.map((driver) => driver.endpoint).join(', ');
      diagnostics.push(
        diagnostic(
          'driver-conflict',
          this.allowMultiDriver ? 'warning' : 'error',
          this.allowMultiDriver
            ? `Net ${netId} has ${drivers.length} drivers (${names}); solving them as a wired-OR`
            : `Net ${netId} has ${drivers.length} drivers (${names}); v1 supports one driver per net (set allowMultiDriver to solve them as a wired-OR)`,
          netId,
          endpoints,
        ),
      );
    }
    if (drivers.length > 0 && rails.length > 0) {
      diagnostics.push(
        diagnostic(
          'power-short',
          'error',
          `Net ${netId} shorts rail ${rails[0]?.name ?? '?'} against driver ${drivers[0]?.endpoint ?? '?'}`,
          netId,
          endpoints,
        ),
      );
    }
    if (drivers.length === 0 && rails.length === 0) {
      diagnostics.push(
        diagnostic(
          'floating-net',
          'warning',
          `Net ${netId} has no driver and no rail; its loads read a constant low`,
          netId,
          endpoints,
        ),
      );
    }

    const source = drivers.length > 0 ? 'driver' : rails.length > 0 ? 'rail' : 'floating';
    const level = rails[0]?.level ?? false;

    return Object.freeze({
      netId,
      pins: Object.freeze([...pins]),
      rails: Object.freeze([...rails]),
      drivers: Object.freeze(drivers),
      loads: Object.freeze(loads),
      sinks: Object.freeze(sinks),
      source,
      level,
    });
  }

  private resolveEndpoint(
    raw: unknown,
    pins: GlobalPinMap,
    railNodeIds: Map<string, number>,
    index: number,
  ): ResolvedEndpoint {
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new UnifiedIRCompilerError(
        'invalid-connection',
        `Connection[${index}] endpoint must be a non-empty "device.pin" string or a rail name`,
      );
    }
    const railLevel = this.rails.get(raw);
    if (railLevel !== undefined) {
      let nodeId = railNodeIds.get(raw);
      if (nodeId === undefined) {
        nodeId = pins.totalPins + railNodeIds.size;
        railNodeIds.set(raw, nodeId);
      }
      return { kind: 'rail', nodeId, name: raw, level: railLevel };
    }

    const dot = raw.indexOf('.');
    if (dot <= 0 || dot === raw.length - 1) {
      throw new UnifiedIRCompilerError(
        'invalid-connection',
        `Connection endpoint "${raw}" must be "device.pin" or a known rail (${[...this.rails.keys()].join(', ')})`,
      );
    }
    const deviceId = raw.slice(0, dot);
    const pinName = raw.slice(dot + 1);
    const allocation = pins.devices.get(deviceId);
    if (allocation === undefined) {
      throw new UnifiedIRCompilerError(
        'unknown-device',
        `Connection endpoint "${raw}" references unknown device "${deviceId}". Available: [${[...pins.devices.keys()].join(', ')}]`,
        { deviceId },
      );
    }
    const pin = allocation.resolved.get(pinName);
    if (pin === undefined) {
      const available = [...allocation.resolved.keys()].map((name) => `${deviceId}.${name}`);
      throw new UnifiedIRCompilerError(
        'pin-not-found',
        `Pin '${raw}' not found. Available: [${available.join(', ')}]`,
        { deviceId, pinName },
      );
    }
    return { kind: 'pin', nodeId: pin.globalPinId, pin };
  }
}

/**
 * Throws the first error diagnostic of a netlist, or returns it unchanged.
 *
 * @throws {UnifiedIRCompilerError} carrying every diagnostic for inspection.
 */
export function assertNoElectricalErrors(netlist: CompiledNetlist): CompiledNetlist {
  const errors = netlist.diagnostics.filter((entry) => entry.severity === 'error');
  const first = errors[0];
  if (first === undefined) return netlist;
  throw new UnifiedIRCompilerError(mapErrorCode(first.code), first.message, {
    ...(first.netId === undefined ? {} : { netId: first.netId }),
    diagnostics: netlist.diagnostics,
  });
}

function mapErrorCode(
  code: CompilationDiagnostic['code'],
): 'driver-conflict' | 'power-short' | 'rail-conflict' {
  if (code === 'driver-conflict') return 'driver-conflict';
  if (code === 'rail-conflict') return 'rail-conflict';
  return 'power-short';
}

function diagnostic(
  code: CompilationDiagnostic['code'],
  severity: CompilationDiagnostic['severity'],
  message: string,
  netId: number | undefined,
  endpoints: readonly string[],
): CompilationDiagnostic {
  return Object.freeze({
    code,
    severity,
    message,
    netId,
    endpoints: Object.freeze([...endpoints]),
  });
}

function toConnection(pin: ResolvedDevicePin): CompiledPinConnection {
  return Object.freeze({
    endpoint: `${pin.deviceId}.${pin.name}`,
    deviceId: pin.deviceId,
    pinName: pin.name,
    globalPinId: pin.globalPinId,
    role: pin.role,
    senses: pin.senses,
  });
}

/** Union-find over pin ids and rail node ids. */
class DisjointSet {
  private readonly parent = new Map<number, number>();
  private readonly rank = new Map<number, number>();

  find(id: number): number {
    const parent = this.parent.get(id);
    if (parent === undefined) {
      this.parent.set(id, id);
      this.rank.set(id, 0);
      return id;
    }
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    const leftRank = this.rank.get(leftRoot) ?? 0;
    const rightRank = this.rank.get(rightRoot) ?? 0;
    if (leftRank < rightRank) {
      this.parent.set(leftRoot, rightRoot);
      return;
    }
    this.parent.set(rightRoot, leftRoot);
    if (leftRank === rightRank) this.rank.set(leftRoot, leftRank + 1);
  }
}
