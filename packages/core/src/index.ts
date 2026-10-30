export const MICA_CORE_VERSION = '0.0.0';

export { MAX_TIME_PS, timePs, toTimePs, addTime, subtractTime } from './time';
export type { TimePs, TimeUnit } from './time';

export {
  DEFAULT_TOPIC_CAPACITY,
  DELIVERY_KINDS,
  TopicInbox,
  defaultDelivery,
  parseDeliveryKind,
  resolveDelivery,
} from './topic/delivery';
export type {
  DeliveryKind,
  TopicDeliveryDiagnostic,
  TopicDeliveryDiagnosticCode,
  TopicEnvelope,
  TopicInboxOptions,
} from './topic/delivery';

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
