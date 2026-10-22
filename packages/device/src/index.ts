import './pins/augment';

export { DeviceError } from './errors';
export type { DeviceErrorCode, DeviceErrorOptions } from './errors';

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
  DeviceAPI,
  DeviceBindings,
  DeviceDefinition,
  DeviceDescription,
  DeviceDescriptionMetadata,
  DeviceFactory,
  DeviceInstance,
  DeviceInstanceOptions,
  DeviceInstanceState,
  DeviceIRDeclarations,
  DevicePinDescriptor,
  DevicePinGroupDescriptor,
  DevicePinHost,
  DevicePortDescriptor,
  DevicePropertySnapshot,
  IDeviceProvider,
  LoadedDeviceModule,
  PinConfig,
  PinKind,
  PinOperations,
  PinRef,
  PinSide,
  TopicPayloadType,
} from './types';
