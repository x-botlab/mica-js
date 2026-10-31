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
): ElectricalCompilation {
  const fail = (message: string): never => {
    throw new UnifiedIRCompilerError('invalid-input', message);
  };
  if ('rails' in options) fail('Unsupported boolean rails; declare explicit voltage sources');
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
      fail(`Device "${device.id}" needs a paired electrical factory`);
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
    const implementation = result.implementation;
    if (implementation !== undefined) {
      if (
        implementation === null ||
        typeof implementation !== 'object' ||
        Array.isArray(implementation)
      )
        fail(`Device "${device.id}" factory must return behavior hooks or undefined`);
      for (const [name, callback] of Object.entries(implementation)) {
        if (
          !['initialize', 'tick', 'update', 'kernel', 'applyInputs', 'flushOutputs'].includes(
            name,
          ) ||
          (callback !== undefined && typeof callback !== 'function')
        )
          fail(`Invalid factory behavior "${device.id}.${name}"`);
      }
    }
    const phases =
      implementation === undefined
        ? description.behaviors
        : {
            ...(implementation.initialize === undefined
              ? {}
              : { initialize: implementation.initialize }),
            ...(implementation.tick === undefined ? {} : { tick: implementation.tick }),
            ...(implementation.update === undefined ? {} : { update: implementation.update }),
          };
    if (phases !== undefined) {
      for (const [phase, callback] of Object.entries(phases)) {
        if (
          !['initialize', 'tick', 'update'].includes(phase) ||
          (callback !== undefined && typeof callback !== 'function')
        )
          fail(`Invalid factory behavior "${device.id}.${phase}"`);
      }
    }
    const hasPhases =
      phases !== undefined && Object.values(phases).some((value) => value !== undefined);
    if (implementation !== undefined && description.behaviors !== undefined)
      fail(`Device "${device.id}" declares both factory and static behaviors`);
    if (implementation?.kernel !== undefined && description.kernel !== undefined)
      fail(`Device "${device.id}" declares two kernels`);
    const kernel = implementation?.kernel ?? description.kernel;
    if (hasPhases && kernel !== undefined)
      fail(`Device "${device.id}" declares both behavior hooks and a kernel`);
    return {
      id: device.id,
      prepared: result,
      device: {
        ...device,
        properties: result.properties,
        description: {
          ...description,
          ...(phases === undefined || !hasPhases ? {} : { behaviors: phases }),
          ...(kernel === undefined ? {} : { kernel }),
          ...(implementation?.applyInputs === undefined
            ? {}
            : { applyInputs: implementation.applyInputs }),
          ...(implementation?.flushOutputs === undefined
            ? {}
            : { flushOutputs: implementation.flushOutputs }),
        },
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
