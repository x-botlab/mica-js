import type { IRModule } from '@mica-js/ir';
import { prepareElectricalDevice } from '../../electrical-authoring';
import { allocateElectricalNetwork } from './electrical-network';
import type { AllocatedElectricalNetwork } from './electrical-network';
import { createElectricalOperations } from './electrical-operations';
import type { ElectricalOperations } from './electrical-operations';
import { UnifiedIRCompilerError } from './types';
import type { CircuitCompilationOptions, CompiledCircuit, Connection, DeviceConfig } from './types';

export interface ElectricalCompilation {
  readonly devices: readonly DeviceConfig[];
  readonly allocation: AllocatedElectricalNetwork;
  readonly operations: ElectricalOperations;
}

const circuits = new WeakMap<CompiledCircuit, ElectricalCompilation>();
export const electricalCompilationOf = (
  circuit: CompiledCircuit,
): ElectricalCompilation | undefined => circuits.get(circuit);
export function retainElectricalCompilation(
  circuit: CompiledCircuit,
  electrical: ElectricalCompilation,
): void {
  circuits.set(circuit, electrical);
}

/** Keeps prepared resources and solver storage out of the public compiled description. */
export function prepareElectricalCompilation(
  module: IRModule,
  devices: readonly DeviceConfig[],
  connections: readonly Connection[],
  options: CircuitCompilationOptions,
): ElectricalCompilation | undefined {
  const requested =
    options.sources !== undefined ||
    options.interpretation !== undefined ||
    devices.some(
      ({ description }) =>
        description.factory !== undefined ||
        description.resistors !== undefined ||
        description.connections !== undefined,
    );
  if (!requested) return undefined;
  const fail = (message: string): never => {
    throw new UnifiedIRCompilerError('invalid-input', message);
  };
  if (options.rails !== undefined)
    fail('Resistive circuits require explicit voltage sources, not boolean rails');
  if (options.interpretation !== 'two-state' && options.interpretation !== 'retain-in-band')
    fail('Resistive circuits require an explicit digital interpretation');
  if (
    options.floatingSeed !== undefined &&
    (!Number.isInteger(options.floatingSeed) ||
      options.floatingSeed < 0 ||
      options.floatingSeed > 0xffff_ffff)
  )
    fail('floatingSeed must be a u32');
  const sources = options.sources ?? {};
  if (sources === null || typeof sources !== 'object' || Array.isArray(sources))
    fail('Voltage sources must be an object');
  for (const [id, source] of Object.entries(sources)) {
    if (
      !id ||
      id === 'GND' ||
      source === null ||
      typeof source !== 'object' ||
      !Number.isFinite(source.voltage)
    )
      fail(`Invalid voltage source "${id}"`);
  }
  const prepared = devices.map((device) => {
    const { description } = device;
    if (typeof description.factory !== 'function')
      fail(
        `Device "${device.id}" needs a paired electrical factory; mixed legacy circuits are unsupported`,
      );
    const properties = device.properties === undefined ? {} : device.properties;
    if (properties === null || typeof properties !== 'object' || Array.isArray(properties))
      fail(`Invalid properties for device "${device.id}"`);
    const result = prepareElectricalDevice(
      {
        ...description,
        pins:
          description.pins instanceof Map ? Object.fromEntries(description.pins) : description.pins,
      },
      properties,
      description.factory!,
    );
    if (result.implementation !== undefined && description.behaviors !== undefined)
      fail(`Device "${device.id}" declares both factory and static behaviors`);
    const behaviors =
      result.implementation === undefined ? description.behaviors : result.implementation;
    if (behaviors !== undefined) {
      if (behaviors === null || typeof behaviors !== 'object' || Array.isArray(behaviors))
        fail(`Device "${device.id}" factory must return behavior hooks or undefined`);
      for (const [phase, callback] of Object.entries(behaviors)) {
        if (
          !['initialize', 'tick', 'update'].includes(phase) ||
          (callback !== undefined && typeof callback !== 'function')
        )
          fail(`Invalid factory behavior "${device.id}.${phase}"`);
      }
      if (description.kernel !== undefined)
        fail(`Device "${device.id}" declares both behavior hooks and a kernel`);
    }
    return {
      id: device.id,
      prepared: result,
      device: {
        ...device,
        properties: result.properties,
        description: { ...description, ...(behaviors === undefined ? {} : { behaviors }) },
      },
    };
  });
  const endpoint = (name: string) => {
    if (name === 'GND' || Object.hasOwn(sources, name)) return { source: name };
    const dot = name.indexOf('.');
    if (dot <= 0 || dot === name.length - 1) return fail(`Unknown electrical endpoint "${name}"`);
    return { device: name.slice(0, dot), pin: name.slice(dot + 1) };
  };
  const allocation = allocateElectricalNetwork(
    prepared,
    sources,
    connections.map(({ from, to }) => [endpoint(from), endpoint(to)] as const),
  );
  return {
    devices: prepared.map(({ device }) => device),
    allocation,
    operations: createElectricalOperations(
      module,
      allocation,
      options.interpretation!,
      'electrical',
      options.floatingSeed,
    ),
  };
}
