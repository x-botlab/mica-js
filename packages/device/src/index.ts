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
  DeviceIRDeclarations,
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
  DevicePortDescriptor,
  DevicePropertySnapshot,
  IDeviceProvider,
  LoadedDeviceModule,
  TopicPayloadType,
} from './types';
