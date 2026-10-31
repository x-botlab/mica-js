import {
  toNumber,
  type EntryRef,
  type FloatBits,
  type IRInterpreter,
  type RuntimeScalar,
} from '@mica-js/ir';
import { electricalCompilationOf } from '../compiler/electrical-compilation';
import type {
  CompiledCircuit,
  DeviceMetadata,
  DeviceStateSlot,
  ResolvedDevicePin,
} from '../compiler';
import { CircuitError, type DeviceAccessor, type DeviceAccessors } from './types';

const bridges = new WeakMap<DeviceAccessor, DeviceAccessor>();
export const deviceBridgeOf = (accessor: DeviceAccessor): DeviceAccessor =>
  bridges.get(accessor) ?? accessor;

/** Everything the accessor builders read from one live circuit. */
export interface DeviceAccessorContext {
  readonly compiled: CompiledCircuit;
  readonly jit: IRInterpreter;
  readonly execute: (entry: EntryRef, args: readonly RuntimeScalar[]) => void;
  /** Invoked before every read or write; throws once the circuit is disposed. */
  readonly assertActive: () => void;
  /** Advances the circuit by one tick; used by custom accessors. */
  readonly step: () => void;
  /** Advances the circuit by `count` ticks; used by custom accessors. */
  readonly runBatch: (count: number) => void;
}

/**
 * Builds one accessor per compiled device.
 *
 * A description that declares `accessor` owns its surface; every other device
 * keeps the generic state/pin accessor. The returned record is frozen and keyed
 * by device id.
 */
export function buildDeviceAccessors(context: DeviceAccessorContext): DeviceAccessors {
  const entries: [string, DeviceAccessor][] = [];
  for (const device of context.compiled.deviceMap.values()) {
    const base = createBaseAccessor(context, device);
    if (device.accessor !== undefined) {
      // A custom kernel owns its accessor: the factory closes over the layout
      // its IR factory allocated in this module.
      const custom = device.accessor({
        deviceId: device.deviceId,
        storage: context.jit.storage,
        assertActive: context.assertActive,
        step: context.step,
        runBatch: context.runBatch,
      }) as unknown as DeviceAccessor;
      bridges.set(custom, base);
      entries.push([device.deviceId, custom]);
    } else {
      entries.push([device.deviceId, base]);
    }
  }
  // `Object.fromEntries` defines own data properties, so ids such as
  // `__proto__` stay ordinary keys instead of reaching the prototype chain.
  return Object.freeze(Object.fromEntries(entries));
}

function createBaseAccessor(
  context: DeviceAccessorContext,
  device: DeviceMetadata,
): DeviceAccessor {
  const { jit } = context;
  const storage = jit.storage;
  const electrical = electricalCompilationOf(context.compiled)!;
  const resolved = context.compiled.pins.devices.get(device.deviceId)?.resolved;
  const entries = new Set(device.entries);

  const accessor: DeviceAccessor = {
    deviceId: device.deviceId,
    type: device.type,
    pinNames: Object.freeze([...device.pins.keys()]),
    stateNames: Object.freeze([...device.states.keys()]),
    readPin(pinName: string): boolean {
      context.assertActive();
      pinOf(device, resolved, pinName);
      return (
        storage.loadArray(
          electrical.operations.digitalIntent,
          electrical.operations.pinIndices.get(`${device.deviceId}.${pinName}`)!,
        ) === true
      );
    },
    getState(name: string): unknown {
      context.assertActive();
      const slot = stateOf(device, name);
      return storage.loadArray(slot.array, slot.index);
    },
    setState(name: string, value: unknown): void {
      context.assertActive();
      const slot = stateOf(device, name);
      const accepted = coerceStateValue(device, slot, value);
      try {
        storage.storeArray(slot.array, slot.index, accepted);
      } catch (cause) {
        throw new CircuitError(
          'invalid-state-value',
          `State "${device.deviceId}.${name}" (${slot.type}) rejected ${String(value)}`,
          { deviceId: device.deviceId, stateName: name, cause },
        );
      }
    },
    ...(device.applyInputs === undefined
      ? {}
      : {
          applyInputs(inputs) {
            context.assertActive();
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
              device.applyInputs!({
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
                  accessor.setState(name, value);
                },
                call(entry, args) {
                  active();
                  if (!entries.has(entry))
                    throw new TypeError('Input entry must belong to this device');
                  context.execute(entry, args);
                },
              });
            } finally {
              open = false;
            }
          },
        }),
    ...(device.flushOutputs === undefined
      ? {}
      : {
          flushOutputs(publish) {
            context.assertActive();
            let open = true;
            const active = () => {
              context.assertActive();
              if (!open) throw new TypeError('Output IO is only valid during flushOutputs');
            };
            try {
              device.flushOutputs!({
                readState(name) {
                  active();
                  const value = accessor.getState(name);
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
        }),
  };
  return Object.freeze(accessor);
}

/** Resolves one pin of `device`, or throws with every pin the device declares. */
function pinOf(
  device: DeviceMetadata,
  resolved: ReadonlyMap<string, ResolvedDevicePin> | undefined,
  pinName: string,
): ResolvedDevicePin {
  const pin = resolved?.get(pinName);
  if (pin === undefined) {
    throw new CircuitError(
      'pin-not-found',
      `Device "${device.deviceId}" (${device.type}) has no pin "${pinName}". Available: ${formatNames(device.pins.keys())}`,
      { deviceId: device.deviceId, pinName },
    );
  }
  return pin;
}

/** Resolves one state slot of `device`, or throws with every state it declares. */
function stateOf(device: DeviceMetadata, name: string): DeviceStateSlot {
  const slot = device.states.get(name);
  if (slot === undefined) {
    throw new CircuitError(
      'state-not-found',
      `Device "${device.deviceId}" (${device.type}) has no state "${name}". Available: ${formatNames(device.states.keys())}`,
      { deviceId: device.deviceId, stateName: name },
    );
  }
  return slot;
}

/**
 * Validates a host-written state value against the declared scalar type.
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

function formatNames(names: Iterable<string>): string {
  const list = [...names];
  return list.length === 0 ? '(none)' : `[${list.join(', ')}]`;
}
