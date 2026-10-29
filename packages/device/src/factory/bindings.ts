import type { FunctionDefinition, IRModule, LifecycleRef } from '@mica-js/ir';
import { DeviceError } from '../errors';
import { isSynchronousFunction } from '../internal/functions';
import { isPlainRecord } from '../internal/records';
import type { DeviceInputIO, DeviceOutputIO } from '../types';

export interface ValidatedLifecycle {
  readonly ref: LifecycleRef<readonly []>;
  readonly name: string;
}

export interface ValidatedBindings {
  readonly initialize?: ValidatedLifecycle;
  readonly reset?: ValidatedLifecycle;
  readonly onDispose?: () => void;
  readonly applyInputs?: (io: DeviceInputIO) => void;
  readonly flushOutputs?: (io: DeviceOutputIO) => void;
}

const BINDING_FIELDS = new Set(['initialize', 'reset', 'onDispose', 'applyInputs', 'flushOutputs']);

/**
 * Validates the synchronous factory result. The returned refs are the module's own declaration
 * identities; all lifecycle roles require zero parameters.
 */
export function readDeviceBindings(
  value: unknown,
  module: IRModule,
  deviceId: string,
): ValidatedBindings {
  const bindingError = (message: string, cause?: unknown): DeviceError =>
    new DeviceError('device/lifecycle-binding', `Device ${JSON.stringify(deviceId)} ${message}`, {
      deviceId,
      ...(cause === undefined ? {} : { cause }),
    });
  let record: Record<string, unknown>;
  try {
    if (!isPlainRecord(value)) {
      throw bindingError('factory must return a plain lifecycle binding object.');
    }
    record = value;
  } catch (cause) {
    if (cause instanceof DeviceError) {
      throw cause;
    }
    throw bindingError('factory lifecycle bindings could not be read.', cause);
  }

  let keys: string[];
  try {
    keys = Object.keys(record);
  } catch (cause) {
    throw bindingError('factory lifecycle bindings could not be read.', cause);
  }
  for (const key of keys) {
    if (!BINDING_FIELDS.has(key)) {
      throw bindingError(`factory returned unknown lifecycle field ${JSON.stringify(key)}.`);
    }
  }

  const functions = functionIndex(module, deviceId);
  let initializeValue: unknown;
  let resetValue: unknown;
  let onDisposeValue: unknown;
  try {
    initializeValue = record['initialize'];
    resetValue = record['reset'];
    onDisposeValue = record['onDispose'];
  } catch (cause) {
    throw bindingError('factory lifecycle bindings could not be read.', cause);
  }
  const initialize = readLifecycle(initializeValue, 'initialize', functions, bindingError);
  const reset = readLifecycle(resetValue, 'reset', functions, bindingError);
  if (initialize !== undefined && reset !== undefined && initialize.ref === reset.ref) {
    throw bindingError('factory bound the same lifecycle reference to initialize and reset.');
  }

  if (onDisposeValue !== undefined && !isSynchronousFunction(onDisposeValue)) {
    throw bindingError('onDispose must be a synchronous non-generator function.');
  }

  let applyInputsValue: unknown;
  let flushOutputsValue: unknown;
  try {
    applyInputsValue = record['applyInputs'];
    flushOutputsValue = record['flushOutputs'];
  } catch (cause) {
    throw bindingError('factory step hooks could not be read.', cause);
  }
  if (applyInputsValue !== undefined && !isSynchronousFunction(applyInputsValue)) {
    throw bindingError('applyInputs must be a synchronous non-generator function.');
  }
  if (flushOutputsValue !== undefined && !isSynchronousFunction(flushOutputsValue)) {
    throw bindingError('flushOutputs must be a synchronous non-generator function.');
  }

  const bindings: {
    initialize?: ValidatedLifecycle;
    reset?: ValidatedLifecycle;
    onDispose?: () => void;
    applyInputs?: (io: DeviceInputIO) => void;
    flushOutputs?: (io: DeviceOutputIO) => void;
  } = {};
  if (initialize !== undefined) {
    bindings.initialize = initialize;
  }
  if (reset !== undefined) {
    bindings.reset = reset;
  }
  if (onDisposeValue !== undefined) {
    bindings.onDispose = onDisposeValue as () => void;
  }
  if (applyInputsValue !== undefined) {
    bindings.applyInputs = applyInputsValue as (io: DeviceInputIO) => void;
  }
  if (flushOutputsValue !== undefined) {
    bindings.flushOutputs = flushOutputsValue as (io: DeviceOutputIO) => void;
  }
  return Object.freeze(bindings);
}

function functionIndex(
  module: IRModule,
  deviceId: string,
): ReadonlyMap<object, FunctionDefinition> {
  try {
    const index = new Map<object, FunctionDefinition>();
    for (const definition of module.functions) {
      index.set(definition.ref, definition);
    }
    return index;
  } catch (cause) {
    throw new DeviceError(
      'device/lifecycle-binding',
      `Device ${JSON.stringify(deviceId)} lifecycle declarations could not be read.`,
      { deviceId, cause },
    );
  }
}

function readLifecycle(
  value: unknown,
  slot: 'initialize' | 'reset',
  functions: ReadonlyMap<object, FunctionDefinition>,
  bindingError: (message: string, cause?: unknown) => DeviceError,
): ValidatedLifecycle | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) {
    throw bindingError(`${slot} must be a lifecycle reference declared by this factory.`);
  }
  const definition = functions.get(value);
  if (definition === undefined) {
    throw bindingError(`${slot} must be a lifecycle reference declared by this factory.`);
  }
  if (definition.category !== 'lifecycle') {
    throw bindingError(`${slot} must reference a lifecycle, not a ${definition.category}.`);
  }
  if (definition.params.length !== 0) {
    throw bindingError(`${slot} lifecycle must not declare parameters.`);
  }
  return Object.freeze({
    ref: definition.ref as LifecycleRef<readonly []>,
    name: definition.name,
  });
}
