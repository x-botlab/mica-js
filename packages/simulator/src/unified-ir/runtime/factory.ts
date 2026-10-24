import { deriveSchematicTopology, parseDeviceReference, symbolRole } from '@mica-js/core/schematic';
import type {
  DeviceReference,
  DeviceSymbolProvider,
  SchematicDocument,
} from '@mica-js/core/schematic';
import { DEFAULT_RAILS } from '../compiler';
import type {
  CircuitCompilationInput,
  Connection,
  DeviceConfig,
  DeviceDescription,
} from '../compiler';
import { Circuit } from './circuit';
import { CircuitError, type CircuitRuntimeOptions, type SingleDeviceCircuitInput } from './types';

/** Runtime behaviour of one schematic device package. */
export interface SchematicDeviceBinding {
  /** Device type, e.g. `'teaching-mcu'`. */
  readonly type: string;
  /** IR description: pins, states and behaviours. */
  readonly description: DeviceDescription;
  /** Instance configuration reserved for device kernels. */
  readonly config?: Readonly<Record<string, unknown>>;
}

/** Options for {@link createCircuitFromSchematic}. */
export interface SchematicCircuitOptions extends CircuitRuntimeOptions {
  /**
   * Symbol geometry provider — pass the same provider that authored the
   * schematic. Without it the derived topology contains no pins.
   */
  readonly devices?: DeviceSymbolProvider;
  /** Resolves a schematic device reference to its runtime description. */
  readonly resolveDevice: (reference: DeviceReference) => SchematicDeviceBinding | undefined;
  /** Coordinate tolerance used when matching pins to wires. */
  readonly tolerance?: number;
}

/**
 * Creates a circuit from one device type's built-in kernel.
 *
 * ```ts
 * const mcu = await createSingleDeviceCircuit('teaching-mcu');
 * mcu.runBatch(10);
 * ```
 *
 * The description is intentionally empty: the compiler fills in the built-in
 * pins, states and behaviours of `deviceType`, and rejects a type that ships no
 * kernel with a `unsupported-device` compiler error.
 *
 * @throws {UnifiedIRCompilerError} when `deviceType` has no built-in kernel.
 */
export async function createSingleDeviceCircuit<const T extends string>(
  deviceType: T,
  config?: Readonly<Record<string, unknown>>,
  options?: CircuitRuntimeOptions,
): Promise<Circuit<SingleDeviceCircuitInput<T>>> {
  if (typeof deviceType !== 'string' || deviceType.length === 0) {
    throw new CircuitError('invalid-options', 'deviceType must be a non-empty string');
  }
  const device: DeviceConfig = {
    id: 'device',
    type: deviceType,
    description: Object.freeze({ pins: Object.freeze({}) }),
    ...(config === undefined ? {} : { config }),
  };
  const input = Object.freeze({
    devices: Object.freeze([device]),
    connections: Object.freeze([]),
  }) as SingleDeviceCircuitInput<T>;
  return Circuit.create(input, options);
}

/**
 * Compiles a schematic sheet into a circuit.
 *
 * Nets come from `deriveSchematicTopology`, so wires, junctions, labels and
 * power symbols keep their usual meaning: a net that names a rail connects
 * every member to that rail, and any other net joins its pins pairwise (the
 * compiler merges transitively).
 *
 * ```ts
 * const circuit = await createCircuitFromSchematic(schematic, {
 *   devices: symbolProvider,
 *   resolveDevice: (reference) => bindings.get(reference.deviceId),
 * });
 * ```
 *
 * @throws {CircuitError} with code `unresolved-device` when a component symbol
 *   has no binding; `SchematicError` for malformed sheets.
 */
export async function createCircuitFromSchematic(
  schematic: SchematicDocument,
  options: SchematicCircuitOptions,
): Promise<Circuit> {
  if (
    schematic === null ||
    typeof schematic !== 'object' ||
    schematic.sheet === null ||
    typeof schematic.sheet !== 'object' ||
    !Array.isArray(schematic.sheet.symbols) ||
    !Array.isArray(schematic.sheet.wires) ||
    !Array.isArray(schematic.sheet.junctions)
  ) {
    throw new CircuitError(
      'invalid-options',
      'createCircuitFromSchematic needs a schematic with sheet.symbols, sheet.wires and sheet.junctions',
    );
  }
  if (options === null || typeof options !== 'object') {
    throw new CircuitError('invalid-options', 'createCircuitFromSchematic needs options');
  }
  const { resolveDevice, devices, tolerance, ...runtime } = options;
  if (typeof resolveDevice !== 'function') {
    throw new CircuitError('invalid-options', 'resolveDevice must be a function');
  }

  const usedIds = new Set<string>();
  const deviceIdBySymbol = new Map<string, string>();
  const deviceConfigs: DeviceConfig[] = [];
  let componentCount = 0;

  for (const symbol of schematic.sheet.symbols) {
    if (symbolRole(symbol.device) !== 'component') continue;
    componentCount += 1;
    const reference = parseDeviceReference(symbol.device);
    const binding = reference === undefined ? undefined : resolveDevice(reference);
    if (binding === undefined) {
      throw new CircuitError(
        'unresolved-device',
        `Symbol "${symbol.id}" (${symbol.device}) has no runtime device binding; resolve it in resolveDevice`,
        { deviceId: symbol.id },
      );
    }
    const deviceId = uniqueDeviceId(symbol.designator ?? symbol.id, usedIds);
    usedIds.add(deviceId);
    deviceIdBySymbol.set(symbol.id, deviceId);
    deviceConfigs.push({
      id: deviceId,
      type: binding.type,
      description: binding.description,
      ...(binding.config === undefined ? {} : { config: binding.config }),
    });
  }

  const topology = deriveSchematicTopology(schematic, {
    ...(devices === undefined ? {} : { devices }),
    ...(tolerance === undefined ? {} : { tolerance }),
  });
  if (componentCount > 0 && topology.pins.length === 0) {
    throw new CircuitError(
      'invalid-options',
      'The derived topology has no pins; pass the DeviceSymbolProvider that authored the schematic so pins can be located',
    );
  }

  const railNames = new Set([
    ...Object.keys(DEFAULT_RAILS),
    ...Object.keys(options.electrical?.rails ?? {}),
  ]);
  const connections: Connection[] = [];

  for (const net of topology.nets) {
    const endpoints: string[] = [];
    let rail: string | undefined;
    for (const member of net.members) {
      if (member.kind === 'pin') {
        const deviceId = deviceIdBySymbol.get(member.symbolId);
        if (deviceId === undefined) {
          throw new CircuitError(
            'unresolved-device',
            `Net "${net.name ?? 'anonymous'}" references pin "${member.pinId}" of symbol "${member.symbolId}", which has no runtime device`,
            { deviceId: member.symbolId },
          );
        }
        endpoints.push(`${deviceId}.${member.pinId}`);
        continue;
      }
      if (member.kind === 'power' || member.kind === 'ground') {
        rail = net.name ?? rail;
      }
    }
    if (endpoints.length === 0) continue;
    // A named net that matches a rail ties its pins to that rail; everything
    // else is joined to the first pin, which the compiler merges transitively.
    const railName = rail ?? (net.name !== null && railNames.has(net.name) ? net.name : undefined);
    if (railName !== undefined) {
      for (const endpoint of endpoints) connections.push({ from: endpoint, to: railName });
      continue;
    }
    const first = endpoints[0] as string;
    for (const endpoint of endpoints.slice(1)) connections.push({ from: first, to: endpoint });
  }

  const input: CircuitCompilationInput = {
    devices: Object.freeze(deviceConfigs),
    connections: Object.freeze(connections),
  };
  return Circuit.create(input, runtime);
}

/**
 * Turns a designator or symbol id into a compiler-safe device id.
 *
 * Device ids prefix generated IR function names, so they must be identifiers.
 */
function uniqueDeviceId(preferred: string, used: ReadonlySet<string>): string {
  const base = sanitizeDeviceId(preferred);
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

function sanitizeDeviceId(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_]/g, '_');
  if (cleaned.length === 0) return 'device';
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `d_${cleaned}`;
}
