import { createScheduler, type Scheduler } from '@mica-js/core';
import { parseDeviceDescription } from '../description';
import { DeviceError, type DeviceErrorCode } from '../errors';
import type {
  DeviceAPI,
  DeviceDescription,
  DeviceFactory,
  DeviceInstance,
  DeviceInstanceOptions,
  LoadedDeviceModule,
} from '../types';
import { createDeviceInstance } from './instance';

/** Contextually types a test factory whose runtime result deliberately violates the contract. */
export function asFactory(factory: (api: DeviceAPI) => unknown): DeviceFactory {
  return factory as DeviceFactory;
}

export function testDescription(
  raw: Readonly<Record<string, unknown>> = {},
  name = 'acme:test',
): DeviceDescription {
  return parseDeviceDescription(raw, { name });
}

export function loadedModule(
  factory: DeviceFactory,
  description: DeviceDescription = testDescription(),
): LoadedDeviceModule {
  return { deviceId: description.name, description, factory };
}

export interface TestInstance {
  readonly instance: DeviceInstance;
  readonly scheduler: Scheduler;
  readonly description: DeviceDescription;
}

export function createForTest(
  factory: DeviceFactory,
  options: Partial<DeviceInstanceOptions> = {},
  scheduler: Scheduler = createScheduler(),
  description: DeviceDescription = testDescription(),
): TestInstance {
  const instance = createDeviceInstance(loadedModule(factory, description), scheduler, {
    instanceId: options.instanceId ?? 'device-instance',
    ...(options.properties === undefined ? {} : { properties: options.properties }),
    ...(options.messaging === undefined ? {} : { messaging: options.messaging }),
    ...(options.updateResources === undefined ? {} : { updateResources: options.updateResources }),
    ...(options.onTopic === undefined ? {} : { onTopic: options.onTopic }),
    ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
    ...(options.pinHost === undefined ? {} : { pinHost: options.pinHost }),
    ...(options.connections === undefined ? {} : { connections: options.connections }),
  });
  return { instance, scheduler, description };
}

export function captureDeviceError(run: () => unknown): DeviceError {
  try {
    run();
  } catch (error) {
    if (error instanceof DeviceError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected DeviceError.');
}

export function expectDeviceError(run: () => unknown, code: DeviceErrorCode): DeviceError {
  const error = captureDeviceError(run);
  if (error.code !== code) {
    throw new Error(`Expected ${code}, received ${error.code}: ${error.message}`);
  }
  return error;
}
