import { INTEGER_TYPES, SCALAR_TYPES } from '@mica-js/ir';
import type { ArrayRef, IRModule, ScalarType } from '@mica-js/ir';
import { DEVICE_PIN_STRIDE, PIN_MODE, UNIFIED_PIN_CAPACITY } from '../pin-space';
import {
  UnifiedIRCompilerError,
  type CompiledCircuitMemory,
  type DeviceConfig,
  type DevicePinAllocation,
  type DevicePinDescription,
  type DevicePinDirection,
  type DeviceStateDescription,
  type DeviceStateSlot,
  type GlobalPinMap,
  type GlobalStateMap,
  type ResolvedDevicePin,
} from './types';

/** Generated device ids prefix IR function names, so they must be identifiers. */
const DEVICE_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Everything the compiler allocates before a single instruction is generated. */
export interface ResourceAllocation {
  readonly memory: CompiledCircuitMemory;
  readonly pins: GlobalPinMap;
  readonly states: GlobalStateMap;
}

/**
 * Allocates the circuit-wide pin and state address spaces.
 *
 * ```
 * ids:  0 = drive1.PA0   1 = drive1.PA1   2 = sink1.anode   3 = sink1.cathode
 *       |<-- drive1 -->|                |<----------- sink1 ----------->|
 *
 * pin_mode[256] u8   pin_output[256] bool   pin_input[256] bool
 * device_state_bool[n] / device_state_u32[m] / ...   (one array per used type)
 * ```
 *
 * Pins are packed in declaration order across devices — the addresses the
 * device IR and every net solver embed as constants. States are packed per
 * scalar type into one shared array, so a device's slot stays typed while all
 * devices share one storage region.
 */
export class GlobalResourceAllocator {
  private readonly module: IRModule;

  constructor(module: IRModule) {
    this.module = module;
  }

  /** Allocates the shared pin memories, the pin space and the state space. */
  allocate(devices: readonly DeviceConfig[]): ResourceAllocation {
    const memory = createPinMemory(this.module);
    return Object.freeze({
      memory,
      pins: this.allocatePins(devices),
      states: this.allocateStates(devices),
    });
  }

  /**
   * Packs every device pin into one contiguous global address space.
   *
   * @throws {UnifiedIRCompilerError} on invalid or duplicate device ids, more
   *   than {@link DEVICE_PIN_STRIDE} pins for one device, or more than
   *   {@link UNIFIED_PIN_CAPACITY} pins for the circuit.
   */
  allocatePins(devices: readonly DeviceConfig[]): GlobalPinMap {
    assertDeviceList(devices);

    let totalPins = 0;
    const pins = new Map<string, number>();
    const allocations = new Map<string, DevicePinAllocation>();

    for (const device of devices) {
      const entries = pinEntries(device);
      if (entries.length > DEVICE_PIN_STRIDE) {
        throw new UnifiedIRCompilerError(
          'capacity-exceeded',
          `Device "${device.id}" declares ${entries.length} pins; one device may own at most ${DEVICE_PIN_STRIDE}`,
          { deviceId: device.id },
        );
      }
      if (totalPins + entries.length > UNIFIED_PIN_CAPACITY) {
        throw new UnifiedIRCompilerError(
          'capacity-exceeded',
          `Device "${device.id}" does not fit: the circuit already uses ${totalPins} of ${UNIFIED_PIN_CAPACITY} global pins`,
          { deviceId: device.id },
        );
      }

      const offset = totalPins;
      const devicePins = new Map<string, number>();
      const resolved = new Map<string, ResolvedDevicePin>();

      for (const [name, descriptor] of entries) {
        const globalPinId = totalPins;
        totalPins += 1;
        const direction = resolvePinDirection(descriptor, device.id, name);
        const { role, senses } = resolvePinRole(direction, descriptor?.role, device.id, name);
        devicePins.set(name, globalPinId);
        resolved.set(
          name,
          Object.freeze({
            name,
            deviceId: device.id,
            globalPinId,
            direction,
            role,
            senses,
          }),
        );
        pins.set(`${device.id}.${name}`, globalPinId);
      }

      allocations.set(
        device.id,
        Object.freeze({ deviceId: device.id, offset, pins: devicePins, resolved }),
      );
    }

    return Object.freeze({
      pins,
      devices: allocations,
      totalPins,
      capacity: UNIFIED_PIN_CAPACITY,
    });
  }

  /**
   * Allocates one typed slot per declared device state and creates the backing
   * `device_state_<type>` arrays.
   *
   * @throws {UnifiedIRCompilerError} when a state declaration is malformed.
   */
  allocateStates(devices: readonly DeviceConfig[]): GlobalStateMap {
    assertDeviceList(devices);

    interface StatePlan {
      readonly deviceId: string;
      readonly name: string;
      readonly type: ScalarType;
      readonly initial: boolean | number;
      readonly slot: number;
    }

    const plans: StatePlan[] = [];
    const slotsByDevice = new Map<string, Map<string, DeviceStateSlot>>();
    const plansByType = new Map<ScalarType, StatePlan[]>();

    for (const device of devices) {
      // Every device owns a block in the state table, even when it is empty.
      const slots = new Map<string, DeviceStateSlot>();
      slotsByDevice.set(device.id, slots);
      for (const [name, declaration] of stateEntries(device)) {
        const plan: StatePlan = {
          deviceId: device.id,
          name,
          type: declaration.type,
          initial: declaration.initial,
          slot: plans.length,
        };
        plans.push(plan);
        const typePlans = plansByType.get(plan.type);
        if (typePlans === undefined) {
          plansByType.set(plan.type, [plan]);
        } else {
          typePlans.push(plan);
        }
      }
    }

    const arrays = new Map<ScalarType, ArrayRef>();
    const totals = new Map<ScalarType, number>();
    for (const [type, typePlans] of plansByType) {
      const array = this.module.array(
        `device_state_${type}`,
        type,
        typePlans.map((plan) => plan.initial),
      );
      arrays.set(type, array);
      totals.set(type, typePlans.length);
      typePlans.forEach((plan, index) => {
        const slot: DeviceStateSlot = Object.freeze({
          name: plan.name,
          deviceId: plan.deviceId,
          type,
          array,
          index,
          slot: plan.slot,
        });
        slotsByDevice.get(plan.deviceId)?.set(plan.name, slot);
      });
    }

    const devicesMap = new Map<string, ReadonlyMap<string, DeviceStateSlot>>();
    for (const [deviceId, slots] of slotsByDevice) devicesMap.set(deviceId, slots);

    return Object.freeze({
      devices: devicesMap,
      arrays,
      totals,
      totalStates: plans.length,
    });
  }
}

/** Declares the three pin memories shared by every device and net solver. */
export function createPinMemory(module: IRModule): CompiledCircuitMemory {
  return Object.freeze({
    mode: module.array(
      'pin_mode',
      'u8',
      Array.from({ length: UNIFIED_PIN_CAPACITY }, () => PIN_MODE.highZ),
    ),
    output: module.array(
      'pin_output',
      'bool',
      Array.from({ length: UNIFIED_PIN_CAPACITY }, () => false),
    ),
    input: module.array(
      'pin_input',
      'bool',
      Array.from({ length: UNIFIED_PIN_CAPACITY }, () => false),
    ),
  });
}

/** First state slot ordinal of every device; used for `DeviceMetadata.stateOffset`. */
export function stateOffsetOf(states: GlobalStateMap, deviceId: string): number {
  let offset = 0;
  for (const [id, slots] of states.devices) {
    if (id === deviceId) return offset;
    offset += slots.size;
  }
  return offset;
}

function assertDeviceList(devices: readonly DeviceConfig[]): void {
  if (!Array.isArray(devices) || devices.length === 0) {
    throw new UnifiedIRCompilerError(
      'invalid-input',
      'CircuitCompilationInput.devices must be a non-empty array',
    );
  }
  const ids = new Set<string>();
  for (const device of devices as readonly unknown[]) {
    if (device === null || typeof device !== 'object' || Array.isArray(device)) {
      throw new UnifiedIRCompilerError('invalid-input', 'Every device must be an object');
    }
    const { id, type, description } = device as Partial<DeviceConfig>;
    if (typeof id !== 'string' || !DEVICE_ID_PATTERN.test(id)) {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        `Device id ${JSON.stringify(id)} must be an identifier ([A-Za-z_][A-Za-z0-9_]*) because it prefixes generated IR function names`,
      );
    }
    if (ids.has(id)) {
      throw new UnifiedIRCompilerError(
        'duplicate-device',
        `Duplicate device id "${id}"; every device id must be unique`,
        { deviceId: id },
      );
    }
    ids.add(id);
    if (typeof type !== 'string' || type.length === 0) {
      throw new UnifiedIRCompilerError('invalid-input', `Device "${id}" needs a non-empty type`, {
        deviceId: id,
      });
    }
    if (description === null || typeof description !== 'object') {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        `Device "${id}" needs a description object with a pins map`,
        { deviceId: id },
      );
    }
  }
}

function pinEntries(
  device: DeviceConfig,
): readonly (readonly [string, DevicePinDescription | undefined])[] {
  const raw: unknown = device.description.pins;
  let entries: (readonly [string, DevicePinDescription | undefined])[];
  if (raw instanceof Map) {
    entries = [...(raw as ReadonlyMap<string, DevicePinDescription>).entries()];
  } else if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    entries = Object.entries(raw as Record<string, DevicePinDescription>) as (readonly [
      string,
      DevicePinDescription | undefined,
    ])[];
  } else {
    throw new UnifiedIRCompilerError(
      'invalid-input',
      `Device "${device.id}" needs description.pins as a Map or a plain object`,
      { deviceId: device.id },
    );
  }
  for (const [name, descriptor] of entries) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        `Device "${device.id}" declares a pin with an empty name`,
        { deviceId: device.id },
      );
    }
    if (name.includes('.')) {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        `Device "${device.id}" pin "${name}" may not contain ".": connection endpoints use "device.pin"`,
        { deviceId: device.id, pinName: name },
      );
    }
    if (descriptor !== undefined && (descriptor === null || typeof descriptor !== 'object')) {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        `Device "${device.id}" pin "${name}" description must be an object`,
        { deviceId: device.id, pinName: name },
      );
    }
  }
  return entries;
}

const PIN_DIRECTIONS: ReadonlySet<string> = new Set([
  'input',
  'output',
  'bidirectional',
  'passive',
]);

function resolvePinDirection(
  descriptor: DevicePinDescription | undefined,
  deviceId: string,
  pinName: string,
): DevicePinDirection {
  const direction = descriptor?.direction ?? 'passive';
  if (!PIN_DIRECTIONS.has(direction)) {
    throw new UnifiedIRCompilerError(
      'invalid-input',
      `Device "${deviceId}" pin "${pinName}" has direction ${JSON.stringify(direction)}; expected input, output, bidirectional or passive`,
      { deviceId, pinName },
    );
  }
  return direction;
}

/**
 * Derives the electrical role and the read behavior of a pin.
 *
 * `output` drives only, `input`/`passive` sense only, `bidirectional` drives and
 * senses. An explicit `role` overrides the derived drive role while
 * `bidirectional` keeps its sense side.
 */
function resolvePinRole(
  direction: DevicePinDirection,
  explicit: DevicePinDescription['role'],
  deviceId: string,
  pinName: string,
): { readonly role: 'driver' | 'load'; readonly senses: boolean } {
  if (explicit !== undefined && explicit !== 'driver' && explicit !== 'load') {
    throw new UnifiedIRCompilerError(
      'invalid-input',
      `Device "${deviceId}" pin "${pinName}" has role ${JSON.stringify(explicit)}; expected driver or load`,
      { deviceId, pinName },
    );
  }
  if (explicit === 'driver') return { role: 'driver', senses: direction === 'bidirectional' };
  if (explicit === 'load') return { role: 'load', senses: true };
  if (direction === 'output') return { role: 'driver', senses: false };
  if (direction === 'bidirectional') return { role: 'driver', senses: true };
  return { role: 'load', senses: true };
}

function stateEntries(
  device: DeviceConfig,
): readonly (readonly [string, DeviceStateDescription])[] {
  const raw: unknown = device.description.states;
  if (raw === undefined) return [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UnifiedIRCompilerError(
      'invalid-input',
      `Device "${device.id}" needs description.states as a plain object`,
      { deviceId: device.id },
    );
  }
  return Object.entries(raw as Record<string, DeviceStateDescription>).map(
    ([name, declaration]) => {
      if (typeof name !== 'string' || name.length === 0) {
        throw new UnifiedIRCompilerError(
          'invalid-input',
          `Device "${device.id}" declares a state with an empty name`,
          { deviceId: device.id },
        );
      }
      if (declaration === null || typeof declaration !== 'object') {
        throw new UnifiedIRCompilerError(
          'invalid-input',
          `Device "${device.id}" state "${name}" must be an object with type and initial`,
          { deviceId: device.id },
        );
      }
      const type: unknown = declaration.type;
      if (typeof type !== 'string' || !(SCALAR_TYPES as readonly string[]).includes(type)) {
        throw new UnifiedIRCompilerError(
          'invalid-input',
          `Device "${device.id}" state "${name}" has type ${JSON.stringify(type)}; expected one of ${SCALAR_TYPES.join(', ')}`,
          { deviceId: device.id },
        );
      }
      assertStateInitial(device.id, name, type as ScalarType, declaration.initial);
      return [name, declaration] as const;
    },
  );
}

function assertStateInitial(
  deviceId: string,
  name: string,
  type: ScalarType,
  initial: unknown,
): void {
  if (type === 'bool') {
    if (typeof initial !== 'boolean') {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        `Device "${deviceId}" state "${name}" (bool) needs a boolean initial value`,
        { deviceId },
      );
    }
    return;
  }
  if (typeof initial !== 'number' || !Number.isFinite(initial)) {
    throw new UnifiedIRCompilerError(
      'invalid-input',
      `Device "${deviceId}" state "${name}" (${type}) needs a finite numeric initial value`,
      { deviceId },
    );
  }
  if ((INTEGER_TYPES as readonly string[]).includes(type) && !Number.isInteger(initial)) {
    throw new UnifiedIRCompilerError(
      'invalid-input',
      `Device "${deviceId}" state "${name}" (${type}) needs an integer initial value`,
      { deviceId },
    );
  }
}
