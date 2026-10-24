/**
 * `@mica-js/simulator` public surface.
 *
 * Two execution paths are exported:
 *
 * - **Unified IR** (recommended for new code): `Circuit` compiles the whole
 *   circuit — devices, electrical solve and main loop — into one
 *   `@mica-js/ir` module. See `docs/MIGRATION.md` and `docs/API.md`.
 * - **Scheduler path** (maintenance mode): `createDeviceSimExecutor` loads
 *   schematic device modules and routes widget topics. Deprecated in TSDoc;
 *   see `docs/DEPRECATIONS.md`.
 */

/* -------------------------------------------------------------------------
 * Unified IR: runtime
 * ---------------------------------------------------------------------- */
export { Circuit, CircuitError } from './unified-ir/runtime';
export { createCircuitFromSchematic, createSingleDeviceCircuit } from './unified-ir/runtime';
export type {
  CircuitElectricalOptions,
  CircuitEngine,
  CircuitErrorCode,
  CircuitErrorOptions,
  CircuitRuntimeOptions,
  DeviceAccessor,
  DeviceAccessors,
  DeviceAccessorForType,
  DeviceAccessorsOf,
  LedAccessor,
  McuAccessor,
  SchematicCircuitOptions,
  SchematicDeviceBinding,
  SingleDeviceCircuitInput,
} from './unified-ir/runtime';

/* -------------------------------------------------------------------------
 * Unified IR: compiler
 * ---------------------------------------------------------------------- */
export {
  BUILTIN_DEVICE_TYPES,
  DEFAULT_RAILS,
  UnifiedIRCompilerError,
  compileCircuit,
  createLedDescription,
  createMcuDescription,
} from './unified-ir/compiler';
export type {
  CircuitCompilationInput,
  CircuitCompilationOptions,
  CompilationDiagnostic,
  CompilationDiagnosticCode,
  CompiledCircuit,
  Connection,
  DeviceAccessorFactory,
  DeviceAccessorFactoryContext,
  DeviceBehaviorApi,
  DeviceBehaviors,
  DeviceConfig,
  DeviceDescription,
  DeviceKernelContext,
  DeviceKernelFactory,
  DeviceKernelRuntime,
  DevicePinDescription,
  DevicePinDirection,
  DeviceStateDescription,
  UnifiedIRCompilerErrorCode,
  UnifiedIRCompilerErrorOptions,
} from './unified-ir/compiler';
export { DEVICE_PIN_STRIDE, PIN_MODE, UNIFIED_PIN_CAPACITY } from './unified-ir/pin-space';
export type { PinMode } from './unified-ir/pin-space';

/* -------------------------------------------------------------------------
 * Unified IR: devices
 * ---------------------------------------------------------------------- */
export {
  BUTTON_IR_TYPE,
  ButtonError,
  LED_COLORS,
  LED_IR_TYPE,
  LedError,
  createButtonIR,
  createLedIR,
} from './unified-ir/devices';
export type {
  ButtonAccessor as ButtonIRAccessor,
  ButtonAccessorOptions,
  ButtonConfig,
  ButtonErrorCode,
  ButtonErrorOptions,
  ButtonIRDevice,
  ButtonSnapshot,
  ButtonTerminal,
  LedAccessor as LedIRAccessor,
  LedAccessorOptions,
  LedColor,
  LedConfig,
  LedErrorCode,
  LedErrorOptions,
  LedIRDevice,
  LedSnapshot,
  LedTerminal,
  ResolvedButtonConfig,
  ResolvedLedConfig,
  SimpleDeviceAccessorOptions,
  SimpleDevicePin,
  SimplePinMemory,
  StorageAccessor,
} from './unified-ir/devices';

/* -------------------------------------------------------------------------
 * Scheduler path (maintenance mode, see docs/DEPRECATIONS.md)
 * ---------------------------------------------------------------------- */
export { SimulatorError } from './errors';
export type { SimulatorErrorCode, SimulatorErrorOptions } from './errors';
export { createCircuitHost } from './circuit';
export type { CircuitLayout, CircuitOptions } from './circuit';
export { createDeviceSimExecutor } from './create-device-sim-executor';
export type {
  AdvanceReason,
  AdvanceReport,
  DevicePublish,
  DeviceSimExecutor,
  DeviceSimExecutorOptions,
  DeviceSimHost,
  DeviceSimHostContext,
  DeviceSimHostFactory,
  DeviceSimInstanceOptions,
  DeviceTopic,
  DeviceTopicTarget,
  SimulationDiagnostic,
  SimulationDiagnosticCode,
  SimulationState,
} from './types';
