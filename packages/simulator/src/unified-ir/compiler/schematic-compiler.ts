import {
  GROUND_DEVICE,
  deriveSchematicTopology,
  parseDeviceReference,
  symbolRole,
  synthesizeDeviceSymbol,
} from '@mica-js/core/schematic';
import type {
  DeviceSymbolProvider,
  SchematicDocument,
  SchematicSymbol,
  SchematicTopology,
} from '@mica-js/core/schematic';
import type { TopologyDefinition } from '@mica-js/core';
import { resolveDeviceProperties } from '@mica-js/device';
import type {
  DeviceDefinition,
  DeviceDescription as DevicePackageDescription,
  DevicePortDescriptor,
  IDeviceProvider,
  TopicPayloadType,
} from '@mica-js/device';
import type {
  CircuitCompilationInput,
  CompilationDiagnostic,
  Connection,
  DeviceConfig,
  DeviceDescription,
  DevicePinDescription,
  DevicePortDescription,
  DeviceTopicDirection,
} from './types';

/**
 * Schematic-to-circuit compiler (U05).
 *
 * Folds a `.sch` sheet into a {@link CircuitCompilationInput} plus the rails the
 * sheet declares:
 *
 * ```text
 * symbols  ->  device configs    (builtin power/ground/label/text dropped)
 * wires    ->  nets              (deriveSchematicTopology: wires + junctions + labels)
 * nets     ->  connections       (a power/ground member ties every pin to that rail)
 * power    ->  rails             ('builtin:power' net -> true)
 * ground   ->  rails             ('builtin:ground' net -> false, always 'GND')
 * ```
 *
 * The function never throws for a sheet it cannot express: every unknown device,
 * invalid property and conflicting rail becomes part of `diagnostics` and the
 * caller decides whether to load the circuit.
 */

/** Provider-resolved device the schematic can bind to an IR type. */
export interface SchematicDeviceBinding {
  /** IR device type; selects a built-in kernel or the device's own behaviors. */
  readonly type: string;
  /** Overrides the derived IR description (pins, ports, states, behaviors). */
  readonly description?: DeviceDescription;
  /** Overrides the derived instance configuration. */
  readonly config?: Readonly<Record<string, unknown>>;
}

/** One component symbol of the sheet, resolved to the device it compiles into. */
export interface CompiledSchematicDevice {
  /** Symbol id inside the schematic. */
  readonly symbolId: string;
  /** Reference designator shown to users; the device id is derived from it. */
  readonly designator: string;
  /** Circuit-unique device id (`U1`, `D1`, …). */
  readonly deviceId: string;
  /** IR device type. */
  readonly type: string;
  /** Topic ports the device declares, in declaration order. */
  readonly ports: readonly {
    readonly port: string;
    readonly direction: DeviceTopicDirection;
    readonly type: TopicPayloadType;
    readonly title?: string;
  }[];
}

/** Options for {@link compileSchematicToCircuit}. */
export interface SchematicCompilationOptions {
  /** Coordinate tolerance used when matching pins to wires. */
  readonly tolerance?: number;
  /**
   * Binds a device reference to an IR device type and description.
   *
   * Without it the compiler derives a passive description from the device
   * package (its pins plus its topic ports) whose behaviour is a no-op: a
   * package description says nothing about IR logic.
   */
  readonly resolveDevice?: (
    reference: { readonly packageId: string; readonly deviceId: string },
    definition: DevicePackageDescription,
  ) => SchematicDeviceBinding | undefined;
}

/** Result of one schematic compilation. */
export interface SchematicCompilationResult {
  readonly input: CircuitCompilationInput;
  /** Rails the sheet declares: power nets high, ground nets low. */
  readonly rails: Readonly<Record<string, boolean>>;
  readonly diagnostics: readonly CompilationDiagnostic[];
  /** Component symbols the circuit was built from, in sheet order. */
  readonly devices: readonly CompiledSchematicDevice[];
}

/** Wiring a host-owned board fixture adds to a sheet. */
export interface BoardTopologyCompilation {
  /** Pin-to-pin or pin-to-rail wires the sheet does not draw. */
  readonly connections: readonly Connection[];
  /** `power` / `gnd` board pins as fixed-level rails. */
  readonly rails: Readonly<Record<string, boolean>>;
  /**
   * `instanceId.pinName` -> circuit endpoint of the same net.
   *
   * A board pin is not a device pin, so a probe that names one (for example
   * `board.SENSE`) is sampled through the first device pin of the same wire.
   * A wire with no device pin produces no alias: there is no pin slot to read.
   */
  readonly aliases: ReadonlyMap<string, string>;
}

/** Net name a ground symbol must use; any other name is a compile error. */
export const GROUND_NET = 'GND';

/**
 * Net name a power symbol gets when it names none.
 *
 * `3V3` is this compiler's own default; the schematic format's
 * `DEFAULT_POWER_LABEL` (`VCC`) only exists for legacy compatibility and is
 * deliberately not used here.
 */
export const DEFAULT_POWER_NET = '3V3';

/**
 * Behaviour of a device whose package declares no IR logic.
 *
 * An empty `initialize` keeps the generated phase count at one and keeps the
 * tick loop free of empty calls. A device bound through `resolveDevice`
 * replaces it with its own behaviours.
 */
const EMPTY_BEHAVIORS = Object.freeze({ initialize: (): void => {} });

/**
 * Compiles a schematic into the unified-IR compiler input.
 *
 * ```ts
 * const { input, rails, diagnostics } = await compileSchematicToCircuit(sheet, provider);
 * if (diagnostics.every((entry) => entry.severity !== 'error')) {
 *   const circuit = await Circuit.create(input, { electrical: { rails } });
 * }
 * ```
 *
 * @throws {TypeError} only for a malformed document or provider; everything the
 *   sheet itself gets wrong is reported through `diagnostics`.
 */
export async function compileSchematicToCircuit(
  document: SchematicDocument,
  provider: IDeviceProvider,
  options: SchematicCompilationOptions = {},
): Promise<SchematicCompilationResult> {
  assertDocument(document);
  assertProvider(provider);

  const diagnostics: CompilationDiagnostic[] = [];
  const rails = inferRails(document, diagnostics);
  const definitions = await loadDefinitions(document, provider, diagnostics);

  const symbols = document.sheet.symbols
    .filter((symbol) => isCompilableSymbol(symbol, definitions, diagnostics))
    .map(withDefaultNet);
  const filtered: SchematicDocument = Object.freeze({
    ...document,
    sheet: Object.freeze({ ...document.sheet, symbols: Object.freeze(symbols) }),
  });

  const symbolProvider = createSymbolProvider(definitions);
  const topology = deriveTopology(filtered, symbolProvider, options, diagnostics);

  const devices: CompiledSchematicDevice[] = [];
  const deviceConfigs: DeviceConfig[] = [];
  const deviceIdBySymbol = new Map<string, string>();
  const usedIds = new Set<string>();
  for (const symbol of symbols) {
    if (symbolRole(symbol.device) !== 'component') continue;
    const definition = definitions.get(symbol.device);
    const reference = parseDeviceReference(symbol.device);
    if (definition === undefined || reference === undefined) continue;
    const designator = symbol.designator ?? symbol.id;
    const deviceId = toDeviceId(designator, usedIds);
    usedIds.add(deviceId);
    deviceIdBySymbol.set(symbol.id, deviceId);
    const binding = options.resolveDevice?.(reference, definition.definition);
    const type = binding?.type ?? reference.deviceId;
    const description = binding?.description ?? toDeviceDescription(definition.definition);
    const config = binding?.config ?? toDeviceConfig(definition.definition, symbol, diagnostics);
    deviceConfigs.push(
      Object.freeze({
        id: deviceId,
        type,
        description,
        ...(config === undefined ? {} : { config }),
      }),
    );
    devices.push(
      Object.freeze({
        symbolId: symbol.id,
        designator,
        deviceId,
        type,
        ports: portsOf(definition.definition),
      }),
    );
  }

  const connections =
    topology === undefined ? [] : deriveConnections(topology, deviceIdBySymbol, rails);

  return Object.freeze({
    input: Object.freeze({
      devices: Object.freeze(deviceConfigs),
      connections: Object.freeze(connections),
    }),
    rails: Object.freeze(rails),
    diagnostics: Object.freeze(diagnostics),
    devices: Object.freeze(devices),
  });
}

/**
 * Folds a host-owned board fixture into the wiring a sheet would have drawn.
 *
 * A `TopologyDefinition` describes wires by pin reference instead of geometry,
 * so a host (the Playground's `board.ts`) can own the electrical definition while
 * the sheet only carries symbols. The result is mergeable with
 * {@link SchematicCompilationResult.input}:
 *
 * ```text
 * power pin  ->  rail named after the pin   (board.VCC   -> 'VCC' high)
 * ground pin ->  'GND' rail                 (globalGnd or kind 'gnd')
 * wire       ->  rail-to-pin / pin-to-pin connections between the device pins
 * signal pin ->  alias to a device pin on the same wire, for probe sampling
 * ```
 *
 * A wire that only joins board pins produces no connection: there is no device
 * to connect, and the alias still lets a probe read the device pin on that net.
 *
 * Device switch declarations (`topology.connections`) are not read here: a
 * switch is declared by the device description, so the binding that gives the
 * device its IR behaviour already owns it.
 *
 * @param topology Board wiring: pin kinds and the wires between them.
 * @param devices Component symbols of the sheet, as compiled.
 */
export function compileBoardTopology(
  topology: TopologyDefinition,
  devices: readonly CompiledSchematicDevice[],
): BoardTopologyCompilation {
  const deviceBySymbol = new Map(devices.map((device) => [device.symbolId, device] as const));
  const kindByPin = new Map(
    topology.pins.map((pin) => [`${pin.instanceId}\u0000${pin.pinName}`, pin.kind] as const),
  );
  const connections: Connection[] = [];
  const seen = new Set<string>();
  const rails: Record<string, boolean> = {};
  const aliases = new Map<string, string>();

  const connect = (from: string, to: string): void => {
    const key = from < to ? `${from}\u0000${to}` : `${to}\u0000${from}`;
    if (from === to || seen.has(key)) return;
    seen.add(key);
    connections.push(Object.freeze({ from, to }));
  };

  for (const wire of topology.wires) {
    const endpoints: string[] = [];
    let rail: string | undefined;
    let railLevel = false;
    for (const reference of wire.pins) {
      const kind = kindByPin.get(`${reference.instanceId}\u0000${reference.pinName}`) ?? 'signal';
      if (wire.globalGnd === true || kind === 'gnd') {
        rail = GROUND_NET;
        railLevel = false;
        continue;
      }
      if (kind === 'power') {
        rail ??= reference.pinName;
        railLevel = true;
        continue;
      }
      const device = deviceBySymbol.get(reference.instanceId);
      if (device !== undefined) endpoints.push(`${device.deviceId}.${reference.pinName}`);
    }
    if (rail !== undefined && !(rail in rails)) rails[rail] = railLevel;
    if (endpoints.length === 0) continue;
    if (rail !== undefined) {
      for (const endpoint of endpoints) connect(rail, endpoint);
    } else {
      const [first, ...rest] = endpoints;
      for (const endpoint of rest) connect(first as string, endpoint);
    }
    // Every pin of the wire is electrically the same node, so a probe that
    // names a board pin reads the first device pin of that wire. Device symbols
    // need no alias: the executor resolves their id to the device id already.
    const representative = endpoints[0] as string;
    for (const reference of wire.pins) {
      if (deviceBySymbol.has(reference.instanceId)) continue;
      aliases.set(`${reference.instanceId}.${reference.pinName}`, representative);
    }
  }

  return Object.freeze({
    connections: Object.freeze(connections),
    rails: Object.freeze(rails),
    aliases,
  });
}

/** Rails the sheet declares through `builtin:power` and `builtin:ground` symbols. */
function inferRails(
  document: SchematicDocument,
  diagnostics: CompilationDiagnostic[],
): Record<string, boolean> {
  const rails: Record<string, boolean> = {};
  const declared = new Map<string, boolean>();
  for (const symbol of document.sheet.symbols) {
    const role = symbolRole(symbol.device);
    if (role === 'power') {
      const name = symbol.net ?? DEFAULT_POWER_NET;
      if (name === GROUND_NET) {
        diagnostics.push({
          severity: 'error',
          code: 'invalid-power-net',
          message: `Power symbol '${symbol.id}' cannot use net '${GROUND_NET}'. Use ${JSON.stringify(GROUND_DEVICE)} instead.`,
          symbol: symbol.id,
        });
        continue;
      }
      declareRail(rails, declared, name, true, symbol, diagnostics);
      continue;
    }
    if (role === 'ground') {
      const name = symbol.net ?? GROUND_NET;
      if (name !== GROUND_NET) {
        diagnostics.push({
          severity: 'error',
          code: 'invalid-ground-net',
          message: `Ground symbol '${symbol.id}' has invalid net ${JSON.stringify(name)}. Ground symbols must use net '${GROUND_NET}'.`,
          symbol: symbol.id,
        });
        continue;
      }
      declareRail(rails, declared, name, false, symbol, diagnostics);
    }
  }
  return rails;
}

/** Records one rail and reports a net that is declared at both levels. */
function declareRail(
  rails: Record<string, boolean>,
  declared: Map<string, boolean>,
  name: string,
  level: boolean,
  symbol: SchematicSymbol,
  diagnostics: CompilationDiagnostic[],
): void {
  const existing = declared.get(name);
  if (existing !== undefined && existing !== level) {
    diagnostics.push({
      severity: 'error',
      code: 'rail-conflict',
      message: `Rail ${JSON.stringify(name)} is declared as both power and ground.`,
      symbol: symbol.id,
    });
    return;
  }
  declared.set(name, level);
  rails[name] = level;
}

/** Resolves every component device once; unresolvable references become diagnostics. */
async function loadDefinitions(
  document: SchematicDocument,
  provider: IDeviceProvider,
  diagnostics: CompilationDiagnostic[],
): Promise<ReadonlyMap<string, DeviceDefinition>> {
  const definitions = new Map<string, DeviceDefinition>();
  const reported = new Set<string>();
  for (const symbol of document.sheet.symbols) {
    if (symbolRole(symbol.device) !== 'component') continue;
    // An unparsable reference is reported by `isCompilableSymbol`, which knows
    // the symbol id; resolving it would only add a second diagnostic.
    if (parseDeviceReference(symbol.device) === undefined) continue;
    if (definitions.has(symbol.device) || reported.has(symbol.device)) continue;
    let resolved: DeviceDefinition | undefined;
    try {
      resolved = (await provider.resolve(symbol.device)) ?? undefined;
    } catch (cause) {
      reported.add(symbol.device);
      diagnostics.push({
        severity: 'error',
        code: 'unknown-device',
        message: `Device ${JSON.stringify(symbol.device)} of symbol '${symbol.id}' could not be resolved: ${messageOf(cause)}`,
        symbol: symbol.id,
      });
      continue;
    }
    if (resolved === undefined) {
      reported.add(symbol.device);
      diagnostics.push({
        severity: 'error',
        code: 'unknown-device',
        message: `Symbol '${symbol.id}' references unknown device ${JSON.stringify(symbol.device)}.`,
        symbol: symbol.id,
      });
      continue;
    }
    definitions.set(symbol.device, resolved);
  }
  return definitions;
}

/**
 * Keeps the symbols the compiler can place: builtin shapes plus components whose
 * device reference and description resolved.
 *
 * `deriveSchematicTopology` throws on an invalid reference or an unresolved
 * device, so those symbols are filtered out here and reported once.
 */
function isCompilableSymbol(
  symbol: SchematicSymbol,
  definitions: ReadonlyMap<string, DeviceDefinition>,
  diagnostics: CompilationDiagnostic[],
): boolean {
  if (symbolRole(symbol.device) !== 'component') return true;
  if (parseDeviceReference(symbol.device) === undefined) {
    diagnostics.push({
      severity: 'error',
      code: 'invalid-device-reference',
      message: `Symbol '${symbol.id}' has an invalid device reference ${JSON.stringify(symbol.device)}; expected "<package>:<device>".`,
      symbol: symbol.id,
    });
    return false;
  }
  return definitions.has(symbol.device);
}

/**
 * Fills in the default net of a power/ground symbol that names none.
 *
 * `deriveSchematicTopology` names nets through the schematic format's own
 * defaults (`VCC`), while the compiled circuit uses this module's defaults
 * (`3V3`). Normalizing the symbols first keeps the derived net names identical
 * to the inferred rails, so a net-less power symbol still ties its pins to
 * `3V3` instead of becoming an unnamed net.
 */
function withDefaultNet(symbol: SchematicSymbol): SchematicSymbol {
  if (symbol.net !== undefined) return symbol;
  const role = symbolRole(symbol.device);
  if (role === 'power') return { ...symbol, net: DEFAULT_POWER_NET };
  if (role === 'ground') return { ...symbol, net: GROUND_NET };
  return symbol;
}

/** Symbol geometry synthesized from the device package's pin sides. */
function createSymbolProvider(
  definitions: ReadonlyMap<string, DeviceDefinition>,
): DeviceSymbolProvider {
  const cache = new Map<string, ReturnType<typeof synthesizeDeviceSymbol>>();
  const symbolOf = (raw: string): ReturnType<typeof synthesizeDeviceSymbol> | undefined => {
    const cached = cache.get(raw);
    if (cached !== undefined) return cached;
    const definition = definitions.get(raw);
    if (definition === undefined) return undefined;
    const symbol = synthesizeDeviceSymbol({
      name: raw,
      pins: Object.fromEntries(
        [...definition.definition.pins.values()].map((pin) => [pin.key, { side: pin.side }]),
      ),
    });
    cache.set(raw, symbol);
    return symbol;
  };
  return {
    getDeviceSymbol: (reference) => symbolOf(reference.raw),
    getDeviceName: (reference) => (definitions.has(reference.raw) ? reference.raw : undefined),
  };
}

/** Derives nets; a malformed sheet becomes a diagnostic rather than a throw. */
function deriveTopology(
  document: SchematicDocument,
  devices: DeviceSymbolProvider,
  options: SchematicCompilationOptions,
  diagnostics: CompilationDiagnostic[],
): SchematicTopology | undefined {
  try {
    return deriveSchematicTopology(document, {
      devices,
      ...(options.tolerance === undefined ? {} : { tolerance: options.tolerance }),
    });
  } catch (cause) {
    diagnostics.push({
      severity: 'error',
      code: 'invalid-topology',
      message: `The schematic nets could not be derived: ${messageOf(cause)}`,
    });
    return undefined;
  }
}

/** Turns one derived net into point-to-point (or pin-to-rail) connections. */
function deriveConnections(
  topology: SchematicTopology,
  deviceIdBySymbol: ReadonlyMap<string, string>,
  rails: Readonly<Record<string, boolean>>,
): Connection[] {
  const connections: Connection[] = [];
  for (const net of topology.nets) {
    const endpoints: string[] = [];
    let railMember = false;
    for (const member of net.members) {
      if (member.kind === 'pin') {
        const deviceId = deviceIdBySymbol.get(member.symbolId);
        if (deviceId === undefined) continue;
        endpoints.push(`${deviceId}.${member.pinId}`);
        continue;
      }
      if (member.kind === 'power' || member.kind === 'ground') {
        railMember = true;
      }
    }
    if (endpoints.length === 0) continue;
    // Only a power/ground symbol declares a rail; a label that happens to be
    // named like one still needs such a symbol on its net.
    if (railMember && net.name !== null && rails[net.name] !== undefined) {
      for (const endpoint of endpoints) connections.push({ from: endpoint, to: net.name });
      continue;
    }
    // Nets without a rail join their pins pairwise; the compiler merges the
    // pairs transitively into one electrical net.
    const first = endpoints[0] as string;
    for (const endpoint of endpoints.slice(1)) connections.push({ from: first, to: endpoint });
  }
  return connections;
}

/** Converts one device package description into the IR-level description. */
function toDeviceDescription(definition: DevicePackageDescription): DeviceDescription {
  const pins: Record<string, DevicePinDescription> = {};
  for (const [key, pin] of definition.pins) {
    pins[key] = Object.freeze({
      direction: 'passive' as const,
      kind: pin.kind,
      ...(pin.powerDomain === undefined ? {} : { powerDomain: pin.powerDomain }),
    });
  }
  const ports: Record<string, DevicePortDescription> = {};
  for (const [key, port] of definition.ports) {
    ports[key] = Object.freeze({
      direction: port.direction,
      type: port.type,
      ...(port.title === undefined ? {} : { title: port.title }),
    });
  }
  // A hand-built description may omit the optional array even though the
  // parser always fills it in, so treat `undefined` as "no domains".
  const powerDomains = definition.powerDomains;
  return Object.freeze({
    name: definition.name,
    pins: Object.freeze(pins),
    ...(Object.keys(ports).length === 0 ? {} : { ports: Object.freeze(ports) }),
    ...(powerDomains === undefined || powerDomains.length === 0
      ? {}
      : { powerDomains: Object.freeze([...powerDomains]) }),
    // A package description carries no IR logic, so the derived device is
    // electrically passive and topic-only.
    behaviors: EMPTY_BEHAVIORS,
  });
}

/** Resolves the instance configuration of one symbol from its property overrides. */
function toDeviceConfig(
  definition: DevicePackageDescription,
  symbol: SchematicSymbol,
  diagnostics: CompilationDiagnostic[],
): Readonly<Record<string, unknown>> | undefined {
  if (definition.properties.size === 0) return undefined;
  try {
    const config = resolveDeviceProperties(definition, symbol.properties ?? {});
    return Object.keys(config).length === 0 ? undefined : config;
  } catch (cause) {
    diagnostics.push({
      severity: 'error',
      code: 'invalid-property',
      message: `Symbol '${symbol.id}' has invalid properties: ${messageOf(cause)}`,
      symbol: symbol.id,
    });
    return undefined;
  }
}

function portsOf(definition: DevicePackageDescription): CompiledSchematicDevice['ports'] {
  return Object.freeze(
    [...definition.ports.values()].map(
      (port: DevicePortDescriptor): CompiledSchematicDevice['ports'][number] =>
        Object.freeze({
          port: port.key,
          direction: port.direction,
          type: port.type,
          ...(port.title === undefined ? {} : { title: port.title }),
        }),
    ),
  );
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function assertDocument(document: SchematicDocument): void {
  const sheet: unknown = document?.sheet;
  const record = sheet as Record<string, unknown> | undefined;
  if (
    document === null ||
    typeof document !== 'object' ||
    record === undefined ||
    !Array.isArray(record['symbols']) ||
    !Array.isArray(record['wires']) ||
    !Array.isArray(record['junctions'])
  ) {
    throw new TypeError(
      'compileSchematicToCircuit needs a schematic with sheet.symbols, sheet.wires and sheet.junctions',
    );
  }
}

function assertProvider(provider: IDeviceProvider): void {
  if (provider === null || typeof provider !== 'object' || typeof provider.resolve !== 'function') {
    throw new TypeError('compileSchematicToCircuit needs an IDeviceProvider with resolve()');
  }
}

/**
 * Turns a designator or symbol id into a compiler-safe device id.
 *
 * Device ids prefix generated IR function names, so they must be identifiers.
 */
export function toDeviceId(preferred: string, used: ReadonlySet<string> = new Set()): string {
  const cleaned = preferred.replace(/[^A-Za-z0-9_]/g, '_');
  const base =
    cleaned.length === 0 ? 'device' : /^[A-Za-z_]/.test(cleaned) ? cleaned : `d_${cleaned}`;
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}
