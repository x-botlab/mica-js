import { validateDeviceIR } from '@mica-js/device-model';
import type { DeviceIR } from '@mica-js/device-model';
import { assetSrcError } from '@mica-js/document';
import {
  deriveSchematicTopology,
  deviceMetadataSymbol,
  isAssetReference,
  parseDeviceMetadata,
  parseDeviceReference,
  parseSchematic,
  symbolRole,
} from '@mica-js/document/schematic';
import type {
  DeviceMetadata,
  DeviceSymbolProvider,
  SchematicSymbol,
} from '@mica-js/document/schematic';
import { resolveDelivery } from '@mica-js/document/canvas';
import type { DeliveryKind, PayloadType } from '@mica-js/document/canvas';
import type { BoardDescription, DeviceLibraryEntry, PropertyInput } from '../types';
import { errorMessage, SimulationRuntimeError } from './errors';
import type { IPreparedSimulation, SimulationModuleImporter } from './types';

export interface IPreparedDeviceTopic {
  readonly port: string;
  readonly direction: 'input' | 'output';
  readonly type: PayloadType;
  readonly delivery: DeliveryKind;
}

export interface IPreparedDevice {
  readonly id: string;
  readonly definition: DeviceMetadata;
  readonly model: DeviceIR;
  readonly create: DeviceLibraryEntry['create'];
  readonly topics: ReadonlyMap<string, IPreparedDeviceTopic>;
}

export interface IPreparedInstance {
  readonly symbol: string;
  readonly device: IPreparedDevice;
}

export interface IResolvedSimulation {
  readonly instances: readonly IPreparedInstance[];
  readonly description: BoardDescription;
}

/** Imports only referenced SDK modules and captures all inputs before any factory runs. */
export async function prepareSimulation(
  input: IPreparedSimulation,
  importer: SimulationModuleImporter,
  assertActive: () => void,
): Promise<IResolvedSimulation> {
  if (!isRecord(input) || !Array.isArray(input.devices)) {
    throw new SimulationRuntimeError('invalid-input', 'Expected schematic and devices');
  }
  const schematic = parseSchematic(input.schematic);
  const assets = readAssets(input.assets);
  const candidates = new Map<
    string,
    { readonly definition: DeviceMetadata; readonly code: string }
  >();
  for (const candidate of input.devices) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== 'string' ||
      parseDeviceReference(candidate.id) === undefined ||
      candidates.has(candidate.id) ||
      typeof candidate.code !== 'string' ||
      candidate.code.trim().length === 0
    ) {
      throw new SimulationRuntimeError(
        'invalid-input',
        'Expected unique device ids and self-contained ESM code',
      );
    }
    let definition: DeviceMetadata;
    try {
      definition = structuredClone(parseDeviceMetadata(candidate.definition));
    } catch (cause) {
      throw new SimulationRuntimeError(
        'invalid-device',
        `Invalid metadata for "${candidate.id}": ${errorMessage(cause)}`,
        { cause },
      );
    }
    if (definition.id !== parseDeviceReference(candidate.id)!.deviceId) {
      throw new SimulationRuntimeError(
        'invalid-device',
        `Metadata id does not match "${candidate.id}"`,
        { deviceId: candidate.id },
      );
    }
    candidates.set(candidate.id, { definition, code: candidate.code });
  }
  const devices = new Map<string, IPreparedDevice>();
  const symbols = schematic.sheet.symbols.filter(
    (symbol) => symbolRole(symbol.device) === 'component',
  );
  for (const symbol of symbols) {
    if (devices.has(symbol.device)) continue;
    const candidate = candidates.get(symbol.device);
    if (candidate === undefined) {
      throw new SimulationRuntimeError(
        'unresolved-device',
        `Missing prepared device "${symbol.device}"`,
        { deviceId: symbol.device },
      );
    }
    assertActive();
    try {
      const namespace = await importer(candidate.code, symbol.device);
      assertActive();
      if (
        !isRecord(namespace) ||
        !Object.hasOwn(namespace, 'model') ||
        !Object.hasOwn(namespace, 'create') ||
        typeof namespace.create !== 'function'
      ) {
        throw new TypeError('SDK device modules must export named model and synchronous create');
      }
      const model = validateDeviceIR(namespace.model);
      const pinNames = model.declarations
        .filter((declaration) => declaration.kind === 'pin')
        .map((pin) => pin.name);
      const metadataPins = candidate.definition.pins;
      if (metadataPins !== undefined && !sameNames(Object.keys(metadataPins), pinNames)) {
        throw new TypeError('Metadata pins do not match model pins');
      }
      const definition: DeviceMetadata = {
        ...candidate.definition,
        pins: metadataPins ?? Object.fromEntries(pinNames.map((name) => [name, {}])),
      };
      const geometry = deviceMetadataSymbol(definition);
      if (!sameNames(Object.keys(geometry.pins), pinNames)) {
        throw new TypeError('Symbol pins do not match model pins');
      }
      devices.set(symbol.device, {
        id: symbol.device,
        definition,
        model,
        create: namespace.create as DeviceLibraryEntry['create'],
        topics: new Map(
          Object.entries(definition.ports ?? {}).map(([port, topic]) => [
            port,
            { port, ...topic, delivery: resolveDelivery(topic.delivery, topic.type) },
          ]),
        ),
      });
    } catch (cause) {
      assertActive();
      throw new SimulationRuntimeError(
        'invalid-device',
        `Device "${symbol.device}" failed to load: ${errorMessage(cause)}`,
        { deviceId: symbol.device, cause },
      );
    }
  }
  const provider: DeviceSymbolProvider = {
    getDeviceName: (reference) => devices.get(reference.raw)?.definition.displayName,
    getDeviceSymbol: (reference) => {
      const device = devices.get(reference.raw);
      return device === undefined ? undefined : deviceMetadataSymbol(device.definition);
    },
  };
  const topology = deriveSchematicTopology(schematic, { devices: provider });
  return {
    instances: symbols.map((symbol) => ({
      symbol: symbol.id,
      device: devices.get(symbol.device)!,
    })),
    description: {
      instances: symbols.map((symbol) => ({
        id: symbol.id,
        type: symbol.id,
        props: resolveProperties(symbol, devices.get(symbol.device)!, assets.get(symbol.id)),
      })),
      nets: topology.nets.map((net, index) => ({
        id: `net:${index}`,
        pins: net.members.flatMap((member) =>
          member.kind === 'pin' ? [{ instance: member.symbolId, pin: member.pinId }] : [],
        ),
        // A power label names a net; only a ground symbol declares an ideal reference.
        ...(net.members.some((member) => member.kind === 'ground') ? { voltage: 0 } : {}),
      })),
    },
  };
}

function resolveProperties(
  symbol: SchematicSymbol,
  device: IPreparedDevice,
  assets: ReadonlyMap<string, Uint8Array> | undefined,
): Readonly<Record<string, PropertyInput>> {
  const values: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(device.definition.properties ?? {})) {
    if (Object.hasOwn(descriptor, 'default')) values[key] = descriptor.default;
  }
  Object.assign(values, symbol.properties);
  const props: Record<string, PropertyInput> = Object.create(null);
  for (const [key, value] of Object.entries(values)) {
    if (isAssetReference(value)) {
      const problem = assetSrcError(value.mode, value.src);
      if (problem !== undefined)
        throw new SimulationRuntimeError('invalid-input', problem, { deviceId: device.id });
      const bytes = assets?.get(value.src);
      if (bytes === undefined) {
        throw new SimulationRuntimeError(
          'unresolved-asset',
          `Symbol "${symbol.id}" is missing resource "${value.src}"`,
          { deviceId: device.id },
        );
      }
      props[key] = new Uint8Array(bytes);
    } else if (value instanceof Uint8Array) props[key] = new Uint8Array(value);
    else if (
      value === null ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'string'
    )
      props[key] = value;
    else
      throw new SimulationRuntimeError(
        'invalid-input',
        `Unsupported property "${symbol.id}.${key}"`,
        { deviceId: device.id },
      );
  }
  return props;
}

function readAssets(value: unknown): ReadonlyMap<string, ReadonlyMap<string, Uint8Array>> {
  const result = new Map<string, ReadonlyMap<string, Uint8Array>>();
  if (value === undefined) return result;
  if (!isRecord(value))
    throw new SimulationRuntimeError('invalid-input', 'Expected assets keyed by symbol id');
  for (const [symbol, entries] of Object.entries(value)) {
    if (!isRecord(entries))
      throw new SimulationRuntimeError('invalid-input', 'Expected asset entries keyed by src');
    const assets = new Map<string, Uint8Array>();
    for (const [src, bytes] of Object.entries(entries)) {
      if (!src || !(bytes instanceof Uint8Array))
        throw new SimulationRuntimeError('invalid-input', 'Resource bytes must be Uint8Array');
      assets.set(src, new Uint8Array(bytes));
    }
    result.set(symbol, assets);
  }
  return result;
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name) => right.includes(name));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
