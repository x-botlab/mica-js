import { INTEGER_TYPES } from '@mica-js/ir';
import type { FloatBits, IRInterpreter, RuntimeScalar } from '@mica-js/ir';
import type {
  CompiledCircuit,
  DeviceMetadata,
  DeviceStateSlot,
  ResolvedDevicePin,
} from '../compiler';
import {
  CircuitError,
  type DeviceAccessor,
  type DeviceAccessors,
  type LedAccessor,
  type McuAccessor,
} from './types';

/** Device types whose accessor reports a lamp state. */
const LED_TYPES: ReadonlySet<string> = new Set(['led', 'ideal-led']);

/** Device types whose accessor exposes registers. */
const MCU_TYPES: ReadonlySet<string> = new Set(['mcu', 'teaching-mcu']);

/** State names `isOn()` prefers, in order, before falling back to the only bool state. */
const LAMP_STATE_NAMES: readonly string[] = Object.freeze(['lamp', 'lit', 'on']);

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

/** Everything the accessor builders read from one live circuit. */
export interface DeviceAccessorContext {
  readonly compiled: CompiledCircuit;
  readonly jit: IRInterpreter;
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
 * The shape follows the device type: `led`/`ideal-led` gain `isOn()`,
 * `mcu`/`teaching-mcu` gain `readRegister`/`writeRegister`, and every other
 * type keeps the generic state/pin surface. The returned record is frozen and
 * keyed by device id.
 */
export function buildDeviceAccessors(context: DeviceAccessorContext): DeviceAccessors {
  const entries: [string, DeviceAccessor][] = [];
  for (const device of context.compiled.deviceMap.values()) {
    const base = createBaseAccessor(context, device);
    if (device.accessor !== undefined) {
      // A custom kernel owns its accessor: the factory closes over the layout
      // its IR factory allocated in this module.
      entries.push([
        device.deviceId,
        device.accessor({
          deviceId: device.deviceId,
          storage: context.jit.storage,
          assertActive: context.assertActive,
          step: context.step,
          runBatch: context.runBatch,
        }) as unknown as DeviceAccessor,
      ]);
    } else if (LED_TYPES.has(device.type)) {
      entries.push([device.deviceId, createLedAccessor(context, device, base)]);
    } else if (MCU_TYPES.has(device.type)) {
      entries.push([device.deviceId, createMcuAccessor(context, device, base)]);
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
  const memory = context.compiled.memory;
  const resolved = context.compiled.pins.devices.get(device.deviceId)?.resolved;

  const accessor: DeviceAccessor = {
    deviceId: device.deviceId,
    type: device.type,
    pinNames: Object.freeze([...device.pins.keys()]),
    stateNames: Object.freeze([...device.states.keys()]),
    readPin(pinName: string): boolean {
      context.assertActive();
      const pin = pinOf(device, resolved, pinName);
      return storage.loadArray(memory.output, pin.globalPinId) === true;
    },
    writePin(pinName: string, value: boolean): void {
      context.assertActive();
      const pin = pinOf(device, resolved, pinName);
      if (pin.role !== 'driver') {
        throw new CircuitError(
          'pin-not-writable',
          `Pin "${device.deviceId}.${pinName}" has role "${pin.role}"; only driver pins can be written. Use Circuit.setPin to override a sensed level`,
          { deviceId: device.deviceId, pinName },
        );
      }
      assertBoolean(device.deviceId, pinName, value);
      storage.storeArray(memory.output, pin.globalPinId, value);
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
  };
  return Object.freeze(accessor);
}

function createLedAccessor(
  context: DeviceAccessorContext,
  device: DeviceMetadata,
  base: DeviceAccessor,
): LedAccessor {
  const lamp = lampStateOf(device);

  const requireLamp = (): DeviceStateSlot => {
    if (lamp === undefined) {
      throw new CircuitError(
        'state-not-found',
        `LED "${device.deviceId}" (${device.type}) declares no boolean lamp state. Available: ${formatNames(device.states.keys())}`,
        { deviceId: device.deviceId },
      );
    }
    return lamp;
  };

  const accessor: LedAccessor = {
    ...base,
    get lampState(): string {
      return requireLamp().name;
    },
    isOn(): boolean {
      context.assertActive();
      const slot = requireLamp();
      return context.jit.storage.loadArray(slot.array, slot.index) === true;
    },
  };
  return Object.freeze(accessor);
}

function createMcuAccessor(
  context: DeviceAccessorContext,
  device: DeviceMetadata,
  base: DeviceAccessor,
): McuAccessor {
  const registers = Object.freeze(
    [...device.states.entries()]
      .filter(([, slot]) => isRegisterType(slot.type))
      .map(([name]) => name),
  );

  const registerSlot = (name: string): DeviceStateSlot => {
    const slot = device.states.get(name);
    if (slot === undefined || !isRegisterType(slot.type)) {
      const detail =
        slot === undefined
          ? `has no state "${name}"`
          : `declares "${name}" as ${slot.type}; registers must be bool or integer states`;
      throw new CircuitError(
        'register-not-found',
        `MCU "${device.deviceId}" ${detail}. Registers: ${formatNames(registers)}`,
        { deviceId: device.deviceId, stateName: name },
      );
    }
    return slot;
  };

  const accessor: McuAccessor = {
    ...base,
    registerNames: registers,
    readRegister(name: string): bigint {
      context.assertActive();
      const slot = registerSlot(name);
      const value = context.jit.storage.loadArray(slot.array, slot.index);
      if (slot.type === 'bool') return value === true ? 1n : 0n;
      return BigInt(value as number);
    },
    writeRegister(name: string, value: bigint): void {
      context.assertActive();
      const slot = registerSlot(name);
      if (typeof value !== 'bigint') {
        throw new CircuitError(
          'invalid-register-value',
          `Register "${device.deviceId}.${name}" needs a bigint value, received ${typeof value}`,
          { deviceId: device.deviceId, stateName: name },
        );
      }
      const accepted =
        slot.type === 'bool' ? value !== 0n : safeRegisterNumber(device, slot, value);
      try {
        context.jit.storage.storeArray(slot.array, slot.index, accepted);
      } catch (cause) {
        throw new CircuitError(
          'invalid-register-value',
          `Register "${device.deviceId}.${name}" (${slot.type}) rejected ${value}`,
          { deviceId: device.deviceId, stateName: name, cause },
        );
      }
    },
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
 * Picks the state `isOn()` reports: `lamp`, then `lit`, then `on`, then the
 * only boolean state the description declares.
 */
function lampStateOf(device: DeviceMetadata): DeviceStateSlot | undefined {
  for (const name of LAMP_STATE_NAMES) {
    const slot = device.states.get(name);
    if (slot?.type === 'bool') return slot;
  }
  const bools = [...device.states.values()].filter((slot) => slot.type === 'bool');
  return bools.length === 1 ? bools[0] : undefined;
}

function isRegisterType(type: DeviceStateSlot['type']): boolean {
  return type === 'bool' || (INTEGER_TYPES as readonly string[]).includes(type);
}

function assertBoolean(
  deviceId: string,
  pinName: string,
  value: unknown,
): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new CircuitError(
      'invalid-state-value',
      `Pin "${deviceId}.${pinName}" needs a boolean level, received ${typeof value}`,
      { deviceId, pinName },
    );
  }
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

function safeRegisterNumber(device: DeviceMetadata, slot: DeviceStateSlot, value: bigint): number {
  if (value > MAX_SAFE_BIGINT || value < MIN_SAFE_BIGINT) {
    throw new CircuitError(
      'invalid-register-value',
      `Register "${device.deviceId}.${slot.name}" received ${value}, which is outside the exact integer range`,
      { deviceId: device.deviceId, stateName: slot.name },
    );
  }
  return Number(value);
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
