import {
  createPowerRuntime,
  type ElectricalPinInput,
  type PowerDefinition,
  type PowerDeviceDefinition,
  type TopologyConnectionDeclaration,
  type TopologyDefinition,
  type TopologyExternalWire,
  type TopologyPinDeclaration,
} from '@mica-js/core';
import {
  deriveSchematicTopology,
  synthesizeDeviceSymbol,
  type DeviceSymbolProvider,
  type SchematicDocument,
} from '@mica-js/core/schematic';
import type { LoadedDeviceModule } from '@mica-js/device';
import type { DeviceSimHost, DeviceSimHostFactory } from './types';

/** Synthetic pin owner for the supplies the schematic's power/ground symbols name. */
export const SUPPLY_INSTANCE = 'power';

/** Scheduler identity of the electrical network; distinct from every symbol id. */
const POWER_INSTANCE_ID = 'simulator/power';

/** Every pin uses the same digital interpretation; module pins override mode and pull. */
const PIN_MODEL = Object.freeze({
  kind: 'ideal-voltage' as const,
  minVoltage: 0,
  maxVoltage: 5,
  lowVoltage: 0.8,
  highVoltage: 2,
});

/** Everything `createPowerRuntime` and the device instances need for one schematic. */
export interface CircuitLayout {
  readonly topology: TopologyDefinition;
  readonly power: PowerDefinition;
  /** Complete held-intent snapshot: one entry per declared pin. */
  readonly pinStates: readonly ElectricalPinInput[];
}

export interface CircuitOptions {
  /** Voltage the schematic's power symbols hold, in volts. Defaults to 5. */
  readonly supplyVoltage?: number;
}

/**
 * Wiring host for schemes that are drawn, not described.
 *
 * Pass it as `DeviceSimExecutorOptions.host` and the executor mounts one electrical network per
 * runtime: the sheet's wires become nets, power/ground symbols become the supply rails, and every
 * device instance reads real pin voltages and connection states instead of host-recorded values.
 *
 * @example
 * createDeviceSimExecutor({ devices, host: createCircuitHost() });
 */
export function createCircuitHost(options: CircuitOptions = {}): DeviceSimHostFactory {
  return ({ scheduler, schematic, modules }) => {
    const circuit = buildCircuit(schematic, modules, options);
    if (circuit === undefined) {
      return {} satisfies DeviceSimHost;
    }
    const runtime = createPowerRuntime(scheduler, circuit.power, {
      instanceId: POWER_INSTANCE_ID,
      pinStates: circuit.pinStates,
      floating: { seed: 1 },
    });
    return {
      pinHost: runtime,
      topology: runtime,
      dispose: () => {
        runtime.destroy();
      },
    };
  };
}

/**
 * Turns a schematic into a topology plus power definition.
 *
 * Wire geometry is resolved by `deriveSchematicTopology` against synthesized symbols, so the
 * simulator never has to know pin coordinates. Every device pin becomes a topology pin, each net
 * becomes one external wire, and the device descriptions' connections become the switchable pairs.
 *
 * @returns `undefined` when the schematic declares no pins at all (nothing to solve).
 */
export function buildCircuit(
  document: SchematicDocument,
  modules: ReadonlyMap<string, LoadedDeviceModule>,
  options: CircuitOptions = {},
): CircuitLayout | undefined {
  const supplyVoltage = options.supplyVoltage ?? 5;
  const derived = deriveSchematicTopology(document, { devices: createSymbolProvider(modules) });
  if (derived.pins.length === 0) {
    return undefined;
  }

  const kinds = pinKinds(document, modules);
  const pins: TopologyPinDeclaration[] = derived.pins.map((pin) => ({
    instanceId: pin.symbolId,
    pinName: pin.pinId,
    kind: kinds.get(`${pin.symbolId}\u0000${pin.pinId}`) ?? 'signal',
  }));

  const wires: TopologyExternalWire[] = [];
  let supplyPin: string | undefined;
  let groundPin: string | undefined;

  for (const [index, net] of derived.nets.entries()) {
    const members = net.members
      .filter((member) => member.kind === 'pin')
      .map((member) => ({ instanceId: member.symbolId, pinName: member.pinId }));
    const ground = net.members.some((member) => member.kind === 'ground');
    const power = net.members.some((member) => member.kind === 'power');
    const name = net.name ?? `net-${index}`;

    if (power) {
      supplyPin ??= name;
      pins.push({ instanceId: SUPPLY_INSTANCE, pinName: name, kind: 'power' });
      members.push({ instanceId: SUPPLY_INSTANCE, pinName: name });
    }
    if (ground) {
      groundPin ??= name;
      pins.push({ instanceId: SUPPLY_INSTANCE, pinName: name, kind: 'gnd' });
      members.push({ instanceId: SUPPLY_INSTANCE, pinName: name });
    }
    if (members.length > 0) {
      wires.push({
        wireId: `net-${index}`,
        pins: members,
        ...(ground ? { globalGnd: true } : {}),
      });
    }
  }

  // A domain needs both rails; without them the network still resolves from the pin intents.
  const devices: PowerDeviceDefinition[] = [];
  if (supplyPin !== undefined && groundPin !== undefined) {
    devices.push({
      instanceId: SUPPLY_INSTANCE,
      powerDomains: {
        board: { supply: supplyPin, ground: groundPin, voltage: { turnOn: 3, turnOff: 2 } },
      },
    });
  }

  const topology: TopologyDefinition = {
    pins,
    wires,
    connections: deviceConnections(document, modules),
  };

  return {
    topology,
    power: { topology, devices },
    pinStates: pins.map((pin) => {
      const rail = pin.instanceId === SUPPLY_INSTANCE;
      if (rail && pin.kind === 'power') {
        // The supply rail is the schematic's only voltage source.
        return {
          instanceId: pin.instanceId,
          pinName: pin.pinName,
          powerReady: true,
          mode: 'analog' as const,
          outputEnabled: true,
          pull: 'none' as const,
          voltageIntent: supplyVoltage,
          model: PIN_MODEL,
        };
      }
      if (rail) {
        // Ground is the 0 V reference, so a contact to it really pulls a pin low.
        return {
          instanceId: pin.instanceId,
          pinName: pin.pinName,
          powerReady: true,
          mode: 'push-pull' as const,
          outputEnabled: true,
          pull: 'none' as const,
          digitalIntent: false,
          model: PIN_MODEL,
        };
      }
      return {
        instanceId: pin.instanceId,
        pinName: pin.pinName,
        powerReady: true,
        mode: 'high-z' as const,
        outputEnabled: false,
        pull: 'none' as const,
        model: PIN_MODEL,
      };
    }),
  };
}

/**
 * Symbols for every device the schematic names.
 *
 * The synthesized geometry must be the same one the `.sch` was authored against, so the name is
 * the full device id and pins keep their declared side; that is what the playground generator uses.
 */
function createSymbolProvider(
  modules: ReadonlyMap<string, LoadedDeviceModule>,
): DeviceSymbolProvider {
  const cache = new Map<string, ReturnType<typeof synthesizeDeviceSymbol> | undefined>();
  const symbolOf = (deviceId: string) => {
    if (!cache.has(deviceId)) {
      const module = modules.get(deviceId);
      cache.set(
        deviceId,
        module === undefined
          ? undefined
          : synthesizeDeviceSymbol({
              name: deviceId,
              pins: Object.fromEntries(
                [...module.description.pins.values()].map((pin) => [pin.key, { side: pin.side }]),
              ),
            }),
      );
    }
    return cache.get(deviceId);
  };
  return {
    getDeviceSymbol: (reference) => symbolOf(`${reference.packageId}:${reference.deviceId}`),
    getDeviceName: (reference) => `${reference.packageId}:${reference.deviceId}`,
  };
}

function pinKinds(
  document: SchematicDocument,
  modules: ReadonlyMap<string, LoadedDeviceModule>,
): Map<string, TopologyPinDeclaration['kind']> {
  const kinds = new Map<string, TopologyPinDeclaration['kind']>();
  for (const symbol of document.sheet.symbols) {
    const module = modules.get(symbol.device);
    if (module === undefined) continue;
    for (const pin of module.description.pins.values()) {
      kinds.set(`${symbol.id}\u0000${pin.key}`, pin.kind);
    }
  }
  return kinds;
}

function deviceConnections(
  document: SchematicDocument,
  modules: ReadonlyMap<string, LoadedDeviceModule>,
): TopologyConnectionDeclaration[] {
  const connections: TopologyConnectionDeclaration[] = [];
  for (const symbol of document.sheet.symbols) {
    const module = modules.get(symbol.device);
    if (module === undefined) continue;
    for (const [connectionId, descriptor] of module.description.connections) {
      const [first, second] = descriptor.pins;
      if (first === undefined || second === undefined) continue;
      connections.push({
        instanceId: symbol.id,
        connectionId,
        pins: [first, second],
        initial: descriptor.initial,
      });
    }
  }
  return connections;
}
