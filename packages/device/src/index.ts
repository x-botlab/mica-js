import './pins/augment';
import './observe/augment';

export { DeviceError } from './errors';
export type { DeviceErrorCode, DeviceErrorOptions } from './errors';
export { BackpressureError } from './messaging/errors';
export type { BackpressureOperation } from './messaging/errors';

export { parseDeviceDescription } from './description';
export { resolveDeviceProperties } from './properties';
export { loadDeviceModule } from './loader';
export { createDeviceInstance } from './lifecycle/instance';

export type {
  ConnectionOperations,
  ConnectionRef,
  DeviceConnectionDescriptor,
  DeviceConnectionOptions,
} from './connection/types';

export type {
  CapturedPinTypes,
  DeviceAPI,
  DeviceBindings,
  DeviceDefinition,
  DeviceDescription,
  DeviceDescriptionMetadata,
  DeviceDiagnostic,
  DeviceDiagnosticCode,
  DeviceFactory,
  DeviceInputIO,
  DeviceInstance,
  DeviceInstanceOptions,
  DeviceInstanceState,
  DeviceIRDeclarations,
  DeviceMessagingOptions,
  DeviceOutputIO,
  DevicePinDescriptor,
  DevicePinGroupDescriptor,
  DevicePinHost,
  DevicePortDescriptor,
  DevicePropertySnapshot,
  DeviceTopicMessage,
  FifoDescriptor,
  FifoRef,
  IDeviceProvider,
  IROutputMetadata,
  LoadedDeviceModule,
  MessageCallback,
  ObserveConfig,
  ObserveDigitalDescriptor,
  ObserveEdge,
  ObserveOperations,
  ObserverRef,
  PinConfig,
  PinKind,
  PinOperations,
  PinRef,
  PinSide,
  TopicMetadata,
  TopicPayload,
  TopicPayloadType,
  Unsubscribe,
  Vec2d,
  Vec3d,
} from './types';
