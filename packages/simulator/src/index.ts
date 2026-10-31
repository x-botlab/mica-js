/**
 * `@mica-js/simulator` public surface.
 *
 * The package exposes one execution model: unified IR. `Circuit` compiles devices, electrical
 * solving and the main loop into one `@mica-js/ir` module.
 *
 * It ships no device models: a caller supplies every description (pins, states,
 * behaviours or kernel), so device packages stay the only place that knows what
 * an LED, a button or an MCU is.
 */

/* -------------------------------------------------------------------------
 * Unified IR: runtime
 * ---------------------------------------------------------------------- */
export { Circuit, CircuitError } from './unified-ir/runtime';
export { createCircuitFromSchematic, createSchematicCircuit } from './unified-ir/runtime';
export type {
  CircuitElectricalOptions,
  CircuitEngine,
  CircuitErrorCode,
  CircuitErrorOptions,
  CircuitRuntimeOptions,
  SchematicCircuitBinding,
  SchematicCircuitOptions,
  SchematicDeviceBinding,
  SchematicDeviceTopic,
} from './unified-ir/runtime';

/* -------------------------------------------------------------------------
 * Unified IR: compiler
 * ---------------------------------------------------------------------- */
export { UnifiedIRCompilerError, compileCircuit } from './unified-ir/compiler';
export type {
  CircuitCompilationInput,
  CircuitCompilationOptions,
  CompiledCircuit,
  Connection,
  DeviceBehaviorApi,
  DeviceBehaviors,
  DeviceImplementation,
  DeviceInput,
  DeviceInputIo,
  DeviceOutputIo,
  DeviceBridgeHooks,
  DeviceConfig,
  DeviceDescription,
  DeviceKernelContext,
  DeviceKernelFactory,
  DeviceKernelRuntime,
  DevicePinDescription,
  DeviceStateDescription,
  UnifiedIRCompilerErrorCode,
  UnifiedIRCompilerErrorOptions,
} from './unified-ir/compiler';
export { DEVICE_PIN_STRIDE, PIN_MODE, UNIFIED_PIN_CAPACITY } from './unified-ir/pin-space';
export type { PinMode } from './unified-ir/pin-space';

/* -------------------------------------------------------------------------
 * DeviceSimulationHost: RFC 0018 contract and same-thread implementations
 * (the browser/sandbox factory lives in the `./sandbox` entry)
 * ---------------------------------------------------------------------- */
export type {
  DeviceSimulationHost,
  DeviceSimTickReport,
  DeviceTopic,
  SimulationPublish,
} from './host/types';
export type { Disposable, Event } from '@mica-js/core/lifecycle';
export { createSchematicDeviceSimulationHost } from './host/runtime';
export type { SchematicDeviceSimulationHostOptions } from './host/runtime';
export { startDeviceSimulationHostGuest } from './host/guest';
export type { DeviceSimulationHostGuest, DeviceSimulationHostGuestOptions } from './host/guest';

/* -------------------------------------------------------------------------
 * Device authoring: helpers a caller-supplied device package needs
 * ---------------------------------------------------------------------- */
export { createModuleValidation } from './unified-ir/validation';
export { ElectricalDefinitionError } from './electrical-authoring';
export type {
  ContactDeclaration,
  DeviceElectricalInitialization,
  ElectricalDefinitionErrorCode,
  ElectricalFactoryContext,
  ElectricalReference,
  ElectricalPinDeclaration,
  PinElectricalDescription,
  ResistorDeclaration,
  ResistorInitialState,
} from './electrical-authoring';
