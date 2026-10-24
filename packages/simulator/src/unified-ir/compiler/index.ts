import { createIRModule, validateIR } from '@mica-js/ir';
import type { IRModule, IRValidationOptions } from '@mica-js/ir';
import { createModuleValidation } from '../validation';
import { GlobalResourceAllocator } from './allocator';
import { DeviceIRGenerator, resolveDeviceDescription } from './device-gen';
import { DEFAULT_ENTRY_POINT_NAMES, MainLoopGenerator, type MainLoopNames } from './mainloop-gen';
import { ElectricalSolverGenerator } from './solver-gen';
import {
  NetworkTopologyAnalyzer,
  assertNoElectricalErrors,
  type TopologyOptions,
} from './topology';
import {
  UnifiedIRCompilerError,
  type CircuitCompilationInput,
  type CircuitCompilationOptions,
  type CompiledCircuit,
  type Connection,
  type DeviceConfig,
} from './types';

/**
 * Compiles several devices and their wiring into one unified IR module (U01).
 *
 * ```ts
 * const circuit = compileCircuit({
 *   devices: [
 *     { id: 'mcu1', type: 'teaching-mcu', description: createMcuDescription() },
 *     { id: 'led1', type: 'ideal-led', description: createLedDescription() },
 *   ],
 *   connections: [
 *     { from: 'mcu1.PA0', to: 'led1.anode' },
 *     { from: 'led1.cathode', to: 'GND' },
 *   ],
 * });
 *
 * const jit = createIRJIT(circuit.module, { validation: circuit.validation });
 * jit.execute(circuit.entryPoints.refs.initialize, []);
 * jit.execute(circuit.entryPoints.refs.tick, []);          // mcu1 + nets + led1
 * ```
 *
 * The pipeline is: validate the input, allocate the global pin and state
 * spaces, analyse the electrical topology, generate one function per device
 * phase, generate one solver per net, generate the main loop, then validate the
 * resulting module with `validateIR`.
 *
 * @throws {UnifiedIRCompilerError} for malformed input, duplicate ids, unknown
 *   pins, electrical conflicts, or when the generated module fails validation.
 */
export function compileCircuit(
  input: CircuitCompilationInput,
  options: CircuitCompilationOptions = {},
): CompiledCircuit {
  const { devices: rawDevices, connections } = validateInput(input);
  const resolvedOptions = validateOptions(options);
  const devices = rawDevices.map(resolveDeviceDescription);
  const names = resolveEntryNames(resolvedOptions);

  const module = createIRModule();
  const allocation = new GlobalResourceAllocator(module).allocate(devices);

  const topologyOptions: TopologyOptions = {
    ...(resolvedOptions.rails === undefined ? {} : { rails: resolvedOptions.rails }),
    ...(resolvedOptions.allowMultiDriver === undefined
      ? {}
      : { allowMultiDriver: resolvedOptions.allowMultiDriver }),
  };
  const netlist = new NetworkTopologyAnalyzer(topologyOptions).analyze(
    connections,
    allocation.pins,
  );
  assertNoElectricalErrors(netlist);

  const generator = new DeviceIRGenerator({
    module,
    memory: allocation.memory,
    pins: allocation.pins,
    states: allocation.states,
  });
  const generated = devices.map((device) => generator.generate(device));

  const solvers = new ElectricalSolverGenerator({
    module,
    memory: allocation.memory,
  }).generate(netlist);

  assertNoNameCollisions(
    devices,
    solvers.map((solver) => solver.name),
    names,
  );

  const loop = new MainLoopGenerator(module).generate(
    generated.map((device) => device.entry),
    solvers,
    netlist,
    names,
  );

  const validation = createModuleValidation(
    module,
    devices.flatMap((device) => device.description.updateResources ?? []),
  );
  if (resolvedOptions.validate !== false) validateModule(module, validation);

  const deviceMap = new Map(generated.map((device) => [device.metadata.deviceId, device.metadata]));

  return Object.freeze({
    module,
    entryPoints: Object.freeze({
      tick: loop.names.tick,
      initialize: loop.names.initialize,
      batch: loop.names.batch,
      refs: Object.freeze({
        tick: loop.tick,
        initialize: loop.initialize,
        batch: loop.batch,
      }),
    }),
    pinMap: allocation.pins.pins,
    deviceMap,
    netlist,
    pins: allocation.pins,
    states: allocation.states,
    memory: allocation.memory,
    validation,
    executionOrder: loop.order,
    functions: Object.freeze(module.functions.map((fn) => fn.name)),
  });
}

function validateInput(input: unknown): {
  readonly devices: readonly DeviceConfig[];
  readonly connections: readonly Connection[];
} {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new UnifiedIRCompilerError(
      'invalid-input',
      'CircuitCompilationInput must be an object with devices and connections',
    );
  }
  const { devices, connections } = input as Partial<CircuitCompilationInput>;
  if (!Array.isArray(devices) || devices.length === 0) {
    throw new UnifiedIRCompilerError(
      'invalid-input',
      'CircuitCompilationInput.devices must be a non-empty array',
    );
  }
  if (!Array.isArray(connections)) {
    throw new UnifiedIRCompilerError(
      'invalid-input',
      'CircuitCompilationInput.connections must be an array',
    );
  }
  return { devices, connections };
}

function validateOptions(options: unknown): CircuitCompilationOptions {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new UnifiedIRCompilerError('invalid-input', 'Compile options must be an object');
  }
  const resolved = options as CircuitCompilationOptions;
  if (resolved.validate !== undefined && typeof resolved.validate !== 'boolean') {
    throw new UnifiedIRCompilerError('invalid-input', 'options.validate must be a boolean');
  }
  if (resolved.allowMultiDriver !== undefined && typeof resolved.allowMultiDriver !== 'boolean') {
    throw new UnifiedIRCompilerError('invalid-input', 'options.allowMultiDriver must be a boolean');
  }
  if (resolved.rails !== undefined) {
    if (
      resolved.rails === null ||
      typeof resolved.rails !== 'object' ||
      Array.isArray(resolved.rails)
    ) {
      throw new UnifiedIRCompilerError('invalid-input', 'options.rails must be a plain object');
    }
    for (const [name, level] of Object.entries(resolved.rails)) {
      if (name.length === 0 || typeof level !== 'boolean') {
        throw new UnifiedIRCompilerError(
          'invalid-input',
          `options.rails["${name}"] must be a boolean`,
        );
      }
    }
  }
  return resolved;
}

function resolveEntryNames(options: CircuitCompilationOptions): MainLoopNames {
  const names: MainLoopNames = {
    tick: options.entryPointNames?.tick ?? DEFAULT_ENTRY_POINT_NAMES.tick,
    initialize: options.entryPointNames?.initialize ?? DEFAULT_ENTRY_POINT_NAMES.initialize,
    batch: options.entryPointNames?.batch ?? DEFAULT_ENTRY_POINT_NAMES.batch,
  };
  for (const [role, name] of Object.entries(names)) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        `Entry point names.${role} must be a non-empty string`,
      );
    }
  }
  if (new Set(Object.values(names)).size !== 3) {
    throw new UnifiedIRCompilerError(
      'invalid-input',
      `Entry point names must be distinct: ${JSON.stringify(names)}`,
    );
  }
  return Object.freeze(names);
}

function assertNoNameCollisions(
  devices: readonly DeviceConfig[],
  solverNames: readonly string[],
  names: MainLoopNames,
): void {
  const reserved = new Set<string>([names.tick, names.initialize, names.batch, ...solverNames]);
  for (const device of devices) {
    for (const phase of ['initialize', 'tick', 'update'] as const) {
      const generated = `${device.id}_${phase}`;
      if (reserved.has(generated)) {
        throw new UnifiedIRCompilerError(
          'invalid-input',
          `Device "${device.id}" generates "${generated}", which collides with another generated function; rename the device or the entry point`,
          { deviceId: device.id },
        );
      }
    }
  }
}

function validateModule(module: IRModule, validation: IRValidationOptions): void {
  const result = validateIR(module, validation);
  if (result.ok) return;
  const details = result.diagnostics
    .map((entry) => `- [${entry.code}] ${entry.message} at ${entry.location.path}`)
    .join('\n');
  throw new UnifiedIRCompilerError(
    'invalid-ir',
    `Generated IR failed validateIR (${result.diagnostics.length} diagnostic(s)):\n${details}`,
  );
}

export * from './types';
export { GlobalResourceAllocator, createPinMemory, stateOffsetOf } from './allocator';
export type { ResourceAllocation } from './allocator';
export { DEFAULT_RAILS, NetworkTopologyAnalyzer, assertNoElectricalErrors } from './topology';
export type { TopologyOptions } from './topology';
export {
  BUILTIN_DEVICE_KERNELS,
  BUILTIN_DEVICE_TYPES,
  DeviceIRGenerator,
  builtinDeviceKernel,
  createLedDescription,
  createMcuDescription,
  resolveDeviceDescription,
} from './device-gen';
export type {
  BuiltinDeviceKernel,
  DeviceGenerationContext,
  DeviceLoopEntry,
  GeneratedDevice,
} from './device-gen';
export { ElectricalSolverGenerator } from './solver-gen';
export type { NetSolverRuntime, SolverGenerationContext } from './solver-gen';
export { DEFAULT_ENTRY_POINT_NAMES, MainLoopGenerator } from './mainloop-gen';
export type { MainLoopNames, MainLoopOutput } from './mainloop-gen';
