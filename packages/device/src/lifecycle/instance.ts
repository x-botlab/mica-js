import { createIRModule, type IRModule, type IRStorage } from '@mica-js/ir';
import {
  createIRSchedulerInstance,
  SchedulerError,
  type IRSchedulerInstance,
  type Scheduler,
} from '@mica-js/core';
import { DeviceError } from '../errors';
import { readDeviceBindings, type ValidatedBindings } from '../factory/bindings';
import { createFactoryContext } from '../factory/context';
import { callableKind, consumeThenable, isThenable } from '../internal/functions';
import { isObjectLike, isPlainRecord } from '../internal/records';
import { PinDomain } from '../pins/domain';
import type { PinRuntime } from '../pins/runtime';
import { resolveDeviceProperties } from '../properties';
import type {
  DeviceAPI,
  DeviceDescription,
  DeviceInstance,
  DeviceInstanceOptions,
  DeviceInstanceState,
  DeviceFactory,
  DevicePinHost,
  DevicePropertySnapshot,
  LoadedDeviceModule,
} from '../types';
import { createValidationPolicy } from './policy';
import { createLifecycleScheduler } from './scheduler';
import { LifecycleStorage } from './storage';

/**
 * Invokes one synchronous device factory, validates its lifecycle bindings, links the real IR
 * module and installs the scheduler instance. The initialize entry is only queued: the caller's
 * scheduler drives it at the public control phase.
 *
 * @throws {DeviceError} when the factory, bindings or linking violate the contract.
 */
export function createDeviceInstance(
  loaded: LoadedDeviceModule,
  scheduler: Scheduler,
  options: DeviceInstanceOptions,
): DeviceInstance {
  const definition = readLoadedModule(loaded);
  validateScheduler(scheduler);
  const instanceId = readInstanceId(options);
  const props = resolveDeviceProperties(
    definition.description,
    isPlainRecord(options) && options.properties !== undefined ? options.properties : {},
  );
  const pinHost = readPinHost(options);

  const moduleRef: { current?: IRModule } = {};
  const pins = new PinDomain(
    definition.description.pins,
    () => {
      if (moduleRef.current === undefined) {
        throw new Error('Pin domain used before the IR module was created');
      }
      return moduleRef.current;
    },
    definition.deviceId,
  );
  const module = createIRModule({ builderExtensions: [pins.extension] });
  moduleRef.current = module;
  pins.instructions();
  const context = createFactoryContext(props, module, definition.deviceId, pins);
  let rawBindings: unknown;
  try {
    rawBindings = invokeFactory(definition.factory, context.api, definition.deviceId);
  } finally {
    context.close();
  }

  const bindings = readDeviceBindings(rawBindings, module, definition.deviceId);
  const policy = createValidationPolicy(module, pins.validators());
  const pinRuntime = pins.createRuntime(instanceId, pinHost);
  const references = pins.references(module);
  pinRuntime.assertReady(references);
  const tracking = createLifecycleScheduler(scheduler, bindings.initialize?.name);
  let core: IRSchedulerInstance;
  try {
    core = createIRSchedulerInstance(tracking.scheduler, {
      instanceId,
      module,
      validation: policy,
      instructionExecutors: pinRuntime.executors(),
    });
  } catch (cause) {
    throw linkError(definition.deviceId, cause);
  }

  try {
    pinRuntime.prepare(references);
  } catch (cause) {
    pinRuntime.release();
    try {
      scheduler.destroyInstance(core.instance);
    } catch {
      // The pin-host diagnostic is the useful failure.
    }
    throw cause;
  }

  if (bindings.initialize !== undefined) {
    try {
      core.enqueueControl(bindings.initialize.ref, []);
    } catch (cause) {
      pinRuntime.release();
      try {
        scheduler.destroyInstance(core.instance);
      } catch {
        // The original enqueue failure is the useful diagnostic.
      }
      throw new DeviceError(
        'device/instance-invalid',
        `Device ${JSON.stringify(definition.deviceId)} could not enqueue initialize.`,
        { deviceId: definition.deviceId, cause },
      );
    }
  }

  return createHandle(
    definition,
    instanceId,
    props,
    core,
    scheduler,
    bindings,
    pinRuntime,
    tracking.isInitialized,
  );
}

interface LoadedModule {
  readonly deviceId: string;
  readonly description: DeviceDescription;
  readonly factory: DeviceFactory;
}

function readLoadedModule(value: unknown): LoadedModule {
  if (!isPlainRecord(value)) {
    throw instanceError('Device instance definition must be a loaded device module.');
  }
  const deviceId = value['deviceId'];
  const description = value['description'];
  const factory = value['factory'];
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    throw instanceError('Device instance requires a non-empty device id.');
  }
  if (
    !isPlainRecord(description) ||
    typeof description['name'] !== 'string' ||
    !(description['properties'] instanceof Map) ||
    !(description['ports'] instanceof Map) ||
    !(description['pins'] instanceof Map) ||
    !(description['pinGroups'] instanceof Map)
  ) {
    throw instanceError(
      `Device ${JSON.stringify(deviceId)} instance requires a parsed device description.`,
    );
  }
  if (typeof factory !== 'function') {
    throw instanceError(`Device ${JSON.stringify(deviceId)} factory must be a function.`);
  }
  return {
    deviceId,
    description: description as unknown as DeviceDescription,
    factory: factory as DeviceFactory,
  };
}

function validateScheduler(value: unknown): asserts value is Scheduler {
  if (!isObjectLike(value)) {
    throw instanceError('Device instance requires a scheduler.');
  }
  for (const method of ['addInstance', 'enqueueControl', 'destroyInstance', 'start', 'step']) {
    if (typeof value[method] !== 'function') {
      throw instanceError(`Device instance scheduler must implement ${method}().`);
    }
  }
}

function readInstanceId(options: unknown): string {
  if (!isPlainRecord(options)) {
    throw instanceError('Device instance options must be an object.');
  }
  const instanceId = options['instanceId'];
  if (typeof instanceId !== 'string' || instanceId.length === 0) {
    throw instanceError('Device instance id must be a non-empty string.');
  }
  return instanceId;
}

function readPinHost(options: unknown): DevicePinHost | undefined {
  const value = isPlainRecord(options) ? options['pinHost'] : undefined;
  if (value === undefined) {
    return undefined;
  }
  if (!isObjectLike(value)) {
    throw new DeviceError(
      'device/pin-io-unavailable',
      'Device instance pinHost must be an object.',
    );
  }
  for (const method of ['pinIntent', 'updatePinStates', 'sampleDigital'] as const) {
    if (typeof value[method] !== 'function') {
      throw new DeviceError(
        'device/pin-io-unavailable',
        `Device instance pinHost must implement ${method}().`,
      );
    }
  }
  return value as unknown as DevicePinHost;
}

function invokeFactory(factory: DeviceFactory, api: DeviceAPI, deviceId: string): unknown {
  const kind = callableKind(factory);
  if (kind === 'async' || kind === 'async-generator') {
    throw new DeviceError(
      'device/factory-async',
      `Device ${JSON.stringify(deviceId)} factory must be synchronous, but it is ${kind}.`,
      { deviceId },
    );
  }
  if (kind !== 'function') {
    throw new DeviceError(
      'device/factory-failed',
      `Device ${JSON.stringify(deviceId)} factory must be an ordinary function.`,
      { deviceId },
    );
  }
  let result: unknown;
  try {
    result = factory(api);
  } catch (cause) {
    if (cause instanceof DeviceError) {
      throw cause;
    }
    throw new DeviceError(
      'device/factory-failed',
      `Device ${JSON.stringify(deviceId)} factory failed.`,
      { deviceId, cause },
    );
  }
  if (isThenable(result)) {
    consumeThenable(result);
    throw new DeviceError(
      'device/factory-async',
      `Device ${JSON.stringify(deviceId)} factory must not return a Promise or thenable.`,
      { deviceId },
    );
  }
  return result;
}

function linkError(deviceId: string, cause: unknown): DeviceError {
  if (cause instanceof SchedulerError) {
    return new DeviceError(
      'device/instance-invalid',
      `Device ${JSON.stringify(deviceId)} could not be installed in the scheduler: ${cause.message}`,
      { deviceId, cause },
    );
  }
  return new DeviceError(
    'device/link-failed',
    `Device ${JSON.stringify(deviceId)} IR validation or linking failed.`,
    { deviceId, cause },
  );
}

function createHandle(
  definition: LoadedModule,
  instanceId: string,
  props: DevicePropertySnapshot,
  core: IRSchedulerInstance,
  scheduler: Scheduler,
  bindings: ValidatedBindings,
  pinRuntime: PinRuntime,
  isInitialized: () => boolean,
): DeviceInstance {
  const guardedStorage = new LifecycleStorage(core.storage, definition.deviceId);
  let destroyed = false;
  let destroying = false;

  const state = (): DeviceInstanceState => {
    if (destroying) return 'destroying';
    if (destroyed) return 'destroyed';
    if (scheduler.error !== undefined) return 'faulted';
    if (bindings.initialize !== undefined && !isInitialized()) return 'initializing';
    return 'ready';
  };

  const reset = (): void => {
    if (destroying) {
      throw busyError(definition.deviceId, 'reset', 'the instance is being destroyed');
    }
    if (destroyed) {
      throw destroyedError(definition.deviceId, 'reset');
    }
    const current = state();
    if (current === 'initializing') {
      throw busyError(definition.deviceId, 'reset', 'initialize has not completed');
    }
    if (current === 'faulted') {
      throw busyError(definition.deviceId, 'reset', 'the instance is faulted');
    }
    if (bindings.reset === undefined) {
      throw new DeviceError(
        'device/lifecycle-unsupported',
        `Device ${JSON.stringify(definition.deviceId)} does not support reset.`,
        { deviceId: definition.deviceId },
      );
    }
    try {
      core.enqueueControl(bindings.reset.ref, []);
    } catch (cause) {
      throw busyError(definition.deviceId, 'reset', 'the scheduler rejected control work', cause);
    }
  };

  const destroy = (): void => {
    if (destroyed || destroying) {
      return;
    }
    if (scheduler.state === 'running') {
      throw busyError(
        definition.deviceId,
        'destroy',
        'the scheduler is running an entry; destroy at an entry boundary',
      );
    }
    destroying = true;
    pinRuntime.release();
    try {
      scheduler.destroyInstance(core.instance);
    } catch (cause) {
      destroying = false;
      throw new DeviceError(
        'device/instance-invalid',
        `Device ${JSON.stringify(definition.deviceId)} could not be destroyed.`,
        { deviceId: definition.deviceId, cause },
      );
    }
    destroyed = true;
    guardedStorage.release();
    const onDispose = bindings.onDispose;
    if (onDispose === undefined) {
      destroying = false;
      return;
    }
    try {
      const result: unknown = onDispose();
      if (isThenable(result)) {
        consumeThenable(result);
        throw new TypeError('onDispose must not return a Promise or thenable');
      }
      if (result !== undefined) {
        throw new TypeError('onDispose must not return a value');
      }
    } catch (cause) {
      throw new DeviceError(
        'device/dispose-failed',
        `Device ${JSON.stringify(definition.deviceId)} onDispose failed after cleanup.`,
        { deviceId: definition.deviceId, cause },
      );
    } finally {
      destroying = false;
    }
  };

  return Object.freeze({
    instanceId,
    deviceId: definition.deviceId,
    description: definition.description,
    props,
    get state(): DeviceInstanceState {
      return state();
    },
    get storage(): IRStorage {
      if (destroyed) {
        throw destroyedError(definition.deviceId, 'storage');
      }
      return guardedStorage;
    },
    reset,
    destroy,
  });
}

function instanceError(message: string): DeviceError {
  return new DeviceError('device/instance-invalid', message);
}

function busyError(
  deviceId: string,
  operation: string,
  reason: string,
  cause?: unknown,
): DeviceError {
  return new DeviceError(
    'device/instance-busy',
    `Device ${JSON.stringify(deviceId)} cannot ${operation}: ${reason}.`,
    { deviceId, ...(cause === undefined ? {} : { cause }) },
  );
}

function destroyedError(deviceId: string, operation: string): DeviceError {
  return new DeviceError(
    'device/instance-destroyed',
    `Device ${JSON.stringify(deviceId)} ${operation} is unavailable after destroy.`,
    { deviceId },
  );
}
