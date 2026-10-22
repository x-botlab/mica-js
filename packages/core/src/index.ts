export const MICA_CORE_VERSION = '0.0.0';

export { MAX_TIME_PS, timePs, toTimePs, addTime, subtractTime } from './scheduler/time';
export type { TimePs, TimeUnit } from './scheduler/time';
export { createScheduler } from './scheduler/runtime';
export { createIRSchedulerInstance } from './scheduler/ir-adapter';
export type { IRSchedulerInstance, IRSchedulerInstanceDefinition } from './scheduler/ir-adapter';
export { SchedulerError } from './scheduler/errors';
export type { SchedulerErrorCode } from './scheduler/errors';
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
} from './scheduler/types';

export type {
  ElectricalPinInput,
  ElectricalNetworkInput,
  ElectricalContribution,
  ElectricalNetworkResult,
  FloatingInputSample,
  FloatingInput,
} from './electrical/types';
export { ElectricalConflictError, resolveElectricalNetwork } from './electrical/network';
export { createFloatingInput } from './electrical/floating-input';

export { createTopologyRuntime } from './topology/runtime';
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
} from './topology/types';

export { createPowerRuntime, PowerFeedbackError } from './power/runtime';
export type {
  PowerDefinition,
  PowerDeviceDefinition,
  PowerDigitalPinChange,
  PowerDigitalPinObserver,
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
} from './power/types';
