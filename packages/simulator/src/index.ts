/**
 * `@mica-js/simulator` public surface.
 *
 * Two execution paths are exported:
 *
 * - **Unified IR** (recommended for new code): `Circuit` compiles the whole
 *   circuit — devices, electrical solve and main loop — into one
 *   `@mica-js/ir` module. See `docs/API.md`.
 * - **Scheduler path** (maintenance mode): `createDeviceSimExecutor` loads
 *   schematic device modules and routes widget topics. Deprecated in TSDoc;
 *   kept for existing schematic and widget integrations.
 */

/* -------------------------------------------------------------------------
 * Unified IR: runtime
 * ---------------------------------------------------------------------- */
export { Circuit, CircuitError } from './unified-ir/runtime';
export { createCircuitFromSchematic, createSingleDeviceCircuit } from './unified-ir/runtime';
export {
  FLOATING_ALGORITHM,
  FNV_OFFSET_BASIS,
  FNV_PRIME,
  TICK_PS,
  createCircuitExecutor,
  fromIRArgs,
  hashFloatingState,
  hashTopology,
  isTopicPayload,
  sampleFloating,
  toIRArgs,
} from './unified-ir/runtime';
export type {
  CircuitElectricalOptions,
  CircuitEngine,
  CircuitErrorCode,
  CircuitErrorOptions,
  CircuitExecutorOptions,
  CircuitRuntimeOptions,
  CircuitTopic,
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
  DEFAULT_HIGH_THRESHOLD,
  DEFAULT_LOW_THRESHOLD,
  DEFAULT_RAILS,
  DEFAULT_SUPPLY_VOLTAGE,
  DEFAULT_TOPIC_CAPACITY,
  DomainInstructionLowering,
  FLOATING_CLOCK_MEMORY,
  FLOATING_TICK_PS,
  LOWERED_DOMAIN_INSTRUCTIONS,
  THRESHOLD_HIGH_RATIO,
  THRESHOLD_LOW_RATIO,
  TOPIC_BYTES_MAX_BYTES,
  TOPIC_STRING_MAX_BYTES,
  UnifiedIRCompilerError,
  VOLTAGE_CONFLICT_TOLERANCE,
  compileBoardTopology,
  compileCircuit,
  compileSchematicToCircuit,
  createLedDescription,
  createMcuDescription,
  findDomainInstructions,
  isFloating,
  planFloating,
  thresholdsForSupply,
  topicPayloadParams,
} from './unified-ir/compiler';
export type {
  BoardTopologyCompilation,
  CircuitCompilationInput,
  CircuitCompilationOptions,
  CompilationDiagnostic,
  CompilationDiagnosticCode,
  CompiledCircuit,
  CompiledFloating,
  CompiledSchematicDevice,
  CompiledTopicPort,
  CompiledTopics,
  Connection,
  ConnectionLowering,
  ConnectionPatchEntry,
  ConnectionSolverRuntime,
  DeviceAccessorFactory,
  DeviceAccessorFactoryContext,
  DeviceBehaviorApi,
  DeviceBehaviors,
  DeviceConfig,
  DeviceConnectionApi,
  DeviceConnectionDescription,
  DeviceConnectionEntry,
  DeviceConnectionMap,
  DeviceConnectionSlot,
  DeviceDescription,
  DeviceKernelContext,
  DeviceKernelFactory,
  DeviceKernelRuntime,
  DeviceObserveApi,
  DeviceObserveEdge,
  DeviceObserveOptions,
  DeviceObserverDescription,
  DeviceObserverHandler,
  DeviceObserverMap,
  DeviceObserverSlot,
  DevicePinDescription,
  DevicePinDirection,
  DevicePortDescription,
  DevicePortMap,
  DevicePortPayloadType,
  DeviceStateDescription,
  DeviceTopicApi,
  DeviceTopicDirection,
  DeviceTopicHandler,
  DomainLoweringPass,
  DomainLoweringSurface,
  GlobalConnectionMap,
  GlobalObserverMap,
  LoweredDomainProgram,
  LoweredObserver,
  LoweringContext,
  ObserverActivation,
  ObserverLowering,
  SchematicCompilationOptions,
  SchematicCompilationResult,
  UnifiedIRCompilerErrorCode,
  UnifiedIRCompilerErrorOptions,
  VoltageContribution,
  VoltageNetworkResult,
  VoltagePinState,
  VoltagePlan,
  VoltageThresholds,
} from './unified-ir/compiler';
export {
  DEVICE_PIN_STRIDE,
  ELECTRICAL_FAULT,
  PIN_MODE,
  PIN_MODE_BY_NAME,
  PIN_PULL,
  PIN_PULL_BY_NAME,
  UNIFIED_PIN_CAPACITY,
} from './unified-ir/pin-space';
export type {
  ElectricalFault,
  PinMode,
  PinModeName,
  PinPull,
  PinPullName,
} from './unified-ir/pin-space';

/* -------------------------------------------------------------------------
 * Unified IR: devices
 * ---------------------------------------------------------------------- */
export {
  BUTTON_IR_TYPE,
  ButtonError,
  IDEAL_BUTTON_DEVICE,
  IDEAL_BUTTON_PINS,
  IDEAL_RELAY_DEVICE,
  IDEAL_RELAY_PINS,
  LED_COLORS,
  LED_IR_TYPE,
  LedError,
  createButtonIR,
  createIdealButtonDescription,
  createIdealRelayDescription,
  createLedIR,
  resolveExampleDevice,
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
  ExampleDeviceReference,
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
 * Scheduler path (maintenance mode)
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
