export const MICA_CORE_VERSION = '0.0.0';

export { MAX_TIME_PS, timePs, toTimePs, addTime, subtractTime } from './scheduler/time';
export type { TimePs, TimeUnit } from './scheduler/time';
export { createScheduler } from './scheduler/scheduler';
export { createIRSchedulerInstance } from './scheduler/ir-adapter';
export type { IRSchedulerInstance, IRSchedulerInstanceDefinition } from './scheduler/ir-adapter';
export { SchedulerError } from './scheduler/scheduler-error';
export type { SchedulerErrorCode } from './scheduler/scheduler-error';
export type {
  Scheduler,
  SchedulerExecutionContext,
  SchedulerExecutor,
  SchedulerInstance,
  SchedulerInstanceDefinition,
  SchedulerOptions,
  SchedulerRunOptions,
  SchedulerRunResult,
  SchedulerTarget,
} from './scheduler/scheduler-types';

export type {
  ElectricalPinInput,
  ElectricalNetworkInput,
  ElectricalContribution,
  ElectricalNetworkResult,
  FloatingInputSample,
  FloatingInput,
} from './electrical/electrical-types';
export { ElectricalConflictError, resolveElectricalNetwork } from './electrical/electrical';
export { createFloatingInput } from './electrical/floating-input';

export { createTopologyRuntime } from './topology/topology';
export type {
  ConnectionState,
  TopologyConnectionDeclaration,
  TopologyConnectionPatch,
  TopologyConnectionUpdate,
  TopologyDefinition,
  TopologyExternalWire,
  TopologyFloatingOptions,
  TopologyNetwork,
  TopologyOptions,
  TopologyPinDeclaration,
  TopologyPinRef,
  TopologyRuntime,
} from './topology/topology-types';

export { createPowerRuntime, PowerFeedbackError } from './power/power';
export type {
  PowerDefinition,
  PowerDeviceDefinition,
  PowerDigitalSample,
  PowerDigitalSource,
  PowerDomainChange,
  PowerDomainDeclaration,
  PowerDomainObserver,
  PowerDomainSnapshot,
  PowerDomainState,
  PowerDownReason,
  PowerFloatingOptions,
  PowerInputMode,
  PowerLevels,
  PowerOptions,
  PowerPinBinding,
  PowerPinGate,
  PowerPinGateReason,
  PowerRuntime,
  PowerVoltageSample,
  PowerVoltageSource,
} from './power/power-types';
