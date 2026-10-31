import { toNumber, type EntryRef, type FloatBits, type RuntimeScalar } from '@mica-js/ir';
import type { CompiledCircuit, DeviceInput, DeviceMetadata, DeviceStateSlot } from '../compiler';
import type { IRInterpreter } from '@mica-js/ir';
import { CircuitError } from './types';

/**
 * Step-boundary hook plumbing shared by the runtime and the RFC 0018 host.
 *
 * RFC 0017 runs `applyInputs` before a step and `flushOutputs` after it. The io
 * objects exist only for that call: they read and write the owning device's IR
 * memory, never arbitrary circuit storage, and they close as soon as the hook
 * returns. This module is package-internal; no accessor object is exposed.
 */
export interface DeviceBoundary {
  /** Whether the device declared an input hook in its paired factory. */
  hasInputHook(deviceId: string): boolean;
  /** Runs the device's `applyInputs` hook against this step's deliveries. */
  deliverInputs(deviceId: string, inputs: readonly DeviceInput[]): void;
  /** Runs the device's `flushOutputs` hook; each `publish` call leaves the device. */
  publishOutputs(deviceId: string, publish: (port: string, payload: unknown) => void): void;
}

export interface DeviceBoundaryContext {
  readonly compiled: CompiledCircuit;
  readonly jit: IRInterpreter;
  readonly execute: (entry: EntryRef, args: readonly RuntimeScalar[]) => void;
  /** Throws once the owning circuit is disposed. */
  readonly assertActive: () => void;
}

export function createDeviceBoundary(context: DeviceBoundaryContext): DeviceBoundary {
  const metadataOf = (deviceId: string): DeviceMetadata => {
    const device = context.compiled.deviceMap.get(deviceId);
    if (device === undefined) {
      throw new CircuitError('unresolved-device', `Circuit has no device "${deviceId}"`, {
        deviceId,
      });
    }
    return device;
  };

  return {
    hasInputHook: (deviceId) => metadataOf(deviceId).applyInputs !== undefined,

    deliverInputs(deviceId, inputs) {
      context.assertActive();
      const device = metadataOf(deviceId);
      const hook = device.applyInputs;
      if (hook === undefined) {
        if (inputs.length === 0) return;
        throw new CircuitError(
          'unsupported-operation',
          `Device "${device.deviceId}" (${device.type}) declares no applyInputs hook`,
          { deviceId },
        );
      }
      const entries = new Set(device.entries ?? []);
      const pending = new Map<string, unknown[]>();
      for (const input of inputs) {
        const values = pending.get(input.port) ?? [];
        values.push(input.payload);
        pending.set(input.port, values);
      }
      let open = true;
      const active = () => {
        context.assertActive();
        if (!open) throw new TypeError('Input IO is only valid during applyInputs');
      };
      try {
        hook({
          takeInput(port) {
            active();
            const values = pending.get(port);
            pending.delete(port);
            return values?.at(-1);
          },
          takeInputs(port) {
            active();
            const values = pending.get(port) ?? [];
            pending.delete(port);
            return Object.freeze(values);
          },
          writeState(name, value) {
            active();
            const slot = stateSlotOf(device, name);
            const accepted = coerceStateValue(device, slot, value);
            try {
              context.jit.storage.storeArray(slot.array, slot.index, accepted);
            } catch (cause) {
              throw new CircuitError(
                'invalid-state-value',
                `State "${device.deviceId}.${name}" (${slot.type}) rejected ${String(value)}`,
                { deviceId: device.deviceId, stateName: name, cause },
              );
            }
          },
          call(entry, args) {
            active();
            if (!entries.has(entry)) throw new TypeError('Input entry must belong to this device');
            context.execute(entry, args);
          },
        });
      } finally {
        open = false;
      }
    },

    publishOutputs(deviceId, publish) {
      context.assertActive();
      const device = metadataOf(deviceId);
      const hook = device.flushOutputs;
      if (hook === undefined) return;
      let open = true;
      const active = () => {
        context.assertActive();
        if (!open) throw new TypeError('Output IO is only valid during flushOutputs');
      };
      try {
        hook({
          readState(name) {
            active();
            const slot = stateSlotOf(device, name);
            const value = context.jit.storage.loadArray(slot.array, slot.index);
            return typeof value === 'object' && value !== null && 'bits' in value
              ? toNumber(value as FloatBits)
              : value;
          },
          publish(port, payload) {
            active();
            publish(port, payload);
          },
        });
      } finally {
        open = false;
      }
    },
  };
}

/** Resolves one declared state slot of `device`, or throws with every state it declares. */
function stateSlotOf(device: DeviceMetadata, name: string): DeviceStateSlot {
  const slot = device.states.get(name);
  if (slot === undefined) {
    const available = [...device.states.keys()];
    throw new CircuitError(
      'state-not-found',
      `Device "${device.deviceId}" (${device.type}) has no state "${name}". Available: ${available.length === 0 ? '(none)' : `[${available.join(', ')}]`}`,
      { deviceId: device.deviceId, stateName: name },
    );
  }
  return slot;
}

/**
 * Validates a hook-written state value against the declared scalar type.
 * Range checks stay in storage, which owns the encoding.
 */
function coerceStateValue(
  device: DeviceMetadata,
  slot: DeviceStateSlot,
  value: unknown,
): RuntimeScalar {
  if (slot.type === 'bool') {
    if (typeof value !== 'boolean') {
      throw new CircuitError(
        'invalid-state-value',
        `State "${device.deviceId}.${slot.name}" is bool and needs true or false, received ${String(value)}`,
        { deviceId: device.deviceId, stateName: slot.name },
      );
    }
    return value;
  }
  if (slot.type === 'f32' || slot.type === 'f64') {
    if (typeof value === 'number' || isFloatBits(value)) return value;
    throw new CircuitError(
      'invalid-state-value',
      `State "${device.deviceId}.${slot.name}" is ${slot.type} and needs a number or FloatBits`,
      { deviceId: device.deviceId, stateName: slot.name },
    );
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new CircuitError(
      'invalid-state-value',
      `State "${device.deviceId}.${slot.name}" is ${slot.type} and needs an integer, received ${String(value)}`,
      { deviceId: device.deviceId, stateName: slot.name },
    );
  }
  return value;
}

function isFloatBits(value: unknown): value is FloatBits {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { readonly type?: unknown; readonly bits?: unknown };
  return (
    (candidate.type === 'f32' || candidate.type === 'f64') && typeof candidate.bits === 'string'
  );
}
