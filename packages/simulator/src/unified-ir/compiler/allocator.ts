import { INTEGER_TYPES, SCALAR_TYPES } from '@mica-js/ir';
import type { ArrayRef, IRModule, ScalarType } from '@mica-js/ir';
import {
  DEVICE_PIN_STRIDE,
  ELECTRICAL_FAULT,
  PIN_MODE,
  PIN_PULL,
  UNIFIED_PIN_CAPACITY,
} from '../pin-space';
import { DEFAULT_SUPPLY_VOLTAGE, thresholdsForSupply } from './voltage-solver';
import {
  UnifiedIRCompilerError,
  type CompiledCircuitMemory,
  type DeviceConfig,
  type DeviceConnectionDescription,
  type DeviceConnectionSlot,
  type DeviceObserverDescription,
  type DeviceObserverSlot,
  type DevicePinAllocation,
  type DevicePinDescription,
  type DevicePinDirection,
  type DevicePowerDomainSlot,
  type DeviceStateDescription,
  type DeviceStateSlot,
  type GlobalConnectionMap,
  type GlobalObserverMap,
  type GlobalPinMap,
  type GlobalPowerDomainMap,
  type GlobalStateMap,
  type PowerDomainDescription,
  type ResolvedDevicePin,
} from './types';

/** Generated device ids prefix IR function names, so they must be identifiers. */
const DEVICE_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Everything the compiler allocates before a single instruction is generated. */
export interface ResourceAllocation {
  readonly memory: CompiledCircuitMemory;
  readonly pins: GlobalPinMap;
  readonly states: GlobalStateMap;
  readonly connections: GlobalConnectionMap;
  readonly observers: GlobalObserverMap;
  readonly powerDomains: GlobalPowerDomainMap;
}

/** Options of the shared pin-memory allocation (RFC 0002). */
export interface PinMemoryOptions {
  /** Nominal supply of pins without a declared power domain. Defaults to 3.3 V. */
  readonly supplyVoltage?: number;
  /** Global pin id -> nominal high-level voltage of its power domain. */
  readonly pinVoltages?: ReadonlyMap<number, number>;
}

/**
 * Allocates the circuit-wide pin and state address spaces.
 *
 * ```
 * ids:  0 = mcu1.PA0   1 = mcu1.PA1   2 = led1.anode   3 = led1.cathode
 *       |<-- mcu1 -->|                |<----------- led1 ----------->|
 *
 * pin_mode[256] u8   pin_output[256] bool   pin_input[256] bool   pin_pull[256] u8
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
  private readonly supplyVoltage: number;

  constructor(module: IRModule, options: { readonly supplyVoltage?: number } = {}) {
    this.module = module;
    this.supplyVoltage = options.supplyVoltage ?? DEFAULT_SUPPLY_VOLTAGE;
  }

  /** Allocates the shared pin memories, the pin space and the state space. */
  allocate(devices: readonly DeviceConfig[]): ResourceAllocation {
    // Pins and domains come first so the pin memories can seed every pin's
    // thresholds from its own domain voltage. None of those steps declares a
    // memory, so the declaration order of the module stays unchanged.
    const pins = this.allocatePins(devices);
    const powerDomains = this.allocatePowerDomains(devices, pins);
    const memory = createPinMemory(this.module, {
      supplyVoltage: this.supplyVoltage,
      pinVoltages: pinVoltagesOf(powerDomains),
    });
    const states = this.allocateStates(devices);
    const connections = this.allocateConnections(devices, pins);
    const observers = this.allocateObservers(devices, pins);
    return Object.freeze({
      memory: Object.freeze({
        ...memory,
        ...(connections.totalConnections === 0
          ? {}
          : {
              connectionStates: this.module.array(
                'connection_states',
                'bool',
                connections.slots.map((slot) => slot.initialClosed),
              ),
            }),
        ...(observers.totalObservers === 0
          ? {}
          : {
              observeBaselines: this.module.array(
                'observe_baselines',
                'bool',
                observers.slots.map(() => false),
              ),
            }),
        ...(powerDomains.totalDomains === 0
          ? {}
          : {
              // Every domain starts powered; `Circuit.turnOff` is the only way
              // to clear a slot, and `reset()` replays this seed.
              powerReady: this.module.array(
                'power_ready',
                'bool',
                powerDomains.slots.map(() => true),
              ),
            }),
      }) as CompiledCircuitMemory,
      pins,
      states,
      connections,
      observers,
      powerDomains,
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

  /**
   * Resolves every declared switch into the global `connection_states` space.
   *
   * Allocation is declaration-order across devices, so a slot index is stable
   * for a given circuit — the constant the lowering embeds in the generated IR.
   *
   * @throws {UnifiedIRCompilerError} when a connection names a pin the device
   *   does not declare, or repeats a name.
   */
  allocateConnections(devices: readonly DeviceConfig[], pins: GlobalPinMap): GlobalConnectionMap {
    const byDevice = new Map<string, ReadonlyMap<string, DeviceConnectionSlot>>();
    const slots: DeviceConnectionSlot[] = [];
    for (const device of devices) {
      const allocation = pins.devices.get(device.id);
      if (allocation === undefined) {
        throw new UnifiedIRCompilerError(
          'invalid-input',
          `Device "${device.id}" has no pin allocation; allocate pins before connections`,
          { deviceId: device.id },
        );
      }
      const deviceSlots = new Map<string, DeviceConnectionSlot>();
      for (const [name, descriptor] of connectionEntries(device)) {
        if (deviceSlots.has(name)) {
          throw new UnifiedIRCompilerError(
            'invalid-input',
            `Device "${device.id}" declares connection "${name}" twice`,
            { deviceId: device.id },
          );
        }
        const fromPinId = requireConnectionPin(device.id, name, descriptor.pins[0], allocation);
        const toPinId = requireConnectionPin(device.id, name, descriptor.pins[1], allocation);
        if (fromPinId === toPinId) {
          throw new UnifiedIRCompilerError(
            'invalid-input',
            `Device "${device.id}" connection "${name}" joins pin "${descriptor.pins[0]}" to itself`,
            { deviceId: device.id },
          );
        }
        const slot: DeviceConnectionSlot = Object.freeze({
          name,
          deviceId: device.id,
          index: slots.length,
          fromPinId,
          toPinId,
          initialClosed: descriptor.initial === 'closed',
        });
        slots.push(slot);
        deviceSlots.set(name, slot);
      }
      byDevice.set(device.id, deviceSlots);
    }
    return Object.freeze({
      devices: byDevice,
      slots: Object.freeze(slots),
      totalConnections: slots.length,
    });
  }

  /**
   * Resolves every declared observation into the global `observe_baselines`
   * space and validates its trigger and capture pins.
   */
  allocateObservers(devices: readonly DeviceConfig[], pins: GlobalPinMap): GlobalObserverMap {
    const byDevice = new Map<string, ReadonlyMap<string, DeviceObserverSlot>>();
    const slots: DeviceObserverSlot[] = [];
    for (const device of devices) {
      const allocation = pins.devices.get(device.id);
      if (allocation === undefined) {
        throw new UnifiedIRCompilerError(
          'invalid-input',
          `Device "${device.id}" has no pin allocation; allocate pins before observers`,
          { deviceId: device.id },
        );
      }
      const deviceSlots = new Map<string, DeviceObserverSlot>();
      for (const [name, descriptor] of observerEntries(device)) {
        if (deviceSlots.has(name)) {
          throw new UnifiedIRCompilerError(
            'invalid-input',
            `Device "${device.id}" declares observer "${name}" twice`,
            { deviceId: device.id },
          );
        }
        const edges = descriptor.edges ?? 'both';
        if (edges !== 'rising' && edges !== 'falling' && edges !== 'both') {
          throw new UnifiedIRCompilerError(
            'invalid-input',
            `Device "${device.id}" observer "${name}" has edges ${JSON.stringify(edges)}; expected rising, falling or both`,
            { deviceId: device.id },
          );
        }
        const triggerPinId = requireConnectionPin(
          device.id,
          `observer "${name}" trigger`,
          descriptor.trigger,
          allocation,
        );
        const captures = descriptor.captures ?? [descriptor.trigger];
        if (!Array.isArray(captures) || captures.length === 0) {
          throw new UnifiedIRCompilerError(
            'invalid-input',
            `Device "${device.id}" observer "${name}" needs at least one capture pin`,
            { deviceId: device.id },
          );
        }
        const capturePinIds = captures.map((pinName) =>
          requireConnectionPin(device.id, `observer "${name}" capture`, pinName, allocation),
        );
        const slot: DeviceObserverSlot = Object.freeze({
          name,
          deviceId: device.id,
          index: slots.length,
          triggerPinId,
          capturePinIds: Object.freeze(capturePinIds),
          edges,
        });
        slots.push(slot);
        deviceSlots.set(name, slot);
      }
      byDevice.set(device.id, deviceSlots);
    }
    return Object.freeze({
      devices: byDevice,
      slots: Object.freeze(slots),
      totalObservers: slots.length,
    });
  }

  /**
   * Resolves every declared power domain into the global `power_ready` space
   * (RFC 0007).
   *
   * Domains are packed in declaration order across devices, so a slot index is
   * stable for a given circuit — the constant the solvers, the pin handles and
   * the main loop embed in the generated IR. Every pin of a device that declares
   * domains binds to one: its explicit `powerDomain`, else the primary (first)
   * domain.
   *
   * @throws {UnifiedIRCompilerError} when a declaration is malformed, repeats a
   *   name, or a pin names a domain the device does not declare.
   */
  allocatePowerDomains(devices: readonly DeviceConfig[], pins: GlobalPinMap): GlobalPowerDomainMap {
    const byDevice = new Map<string, ReadonlyMap<string, DevicePowerDomainSlot>>();
    const slots: DevicePowerDomainSlot[] = [];
    const pinDomains = new Map<number, number>();
    const primary = new Map<string, number>();

    for (const device of devices) {
      const deviceSlots = new Map<string, DevicePowerDomainSlot>();
      for (const declaration of powerDomainEntries(device)) {
        const slot: DevicePowerDomainSlot = Object.freeze({
          name: declaration.name,
          deviceId: device.id,
          index: slots.length,
          voltage: declaration.voltage,
        });
        slots.push(slot);
        deviceSlots.set(declaration.name, slot);
      }
      byDevice.set(device.id, deviceSlots);
      if (deviceSlots.size === 0) continue;

      const allocation = pins.devices.get(device.id);
      if (allocation === undefined) {
        throw new UnifiedIRCompilerError(
          'invalid-input',
          `Device "${device.id}" has no pin allocation; allocate pins before power domains`,
          { deviceId: device.id },
        );
      }
      const primarySlot = deviceSlots.values().next().value as DevicePowerDomainSlot;
      primary.set(device.id, primarySlot.index);

      for (const [name, descriptor] of pinEntries(device)) {
        const declared = descriptor?.powerDomain;
        const slot = declared === undefined ? primarySlot : deviceSlots.get(declared);
        if (slot === undefined) {
          throw new UnifiedIRCompilerError(
            'invalid-input',
            `Device "${device.id}" pin "${name}" binds undeclared power domain ${JSON.stringify(declared)}. Available: [${[...deviceSlots.keys()].join(', ')}]`,
            { deviceId: device.id, pinName: name },
          );
        }
        const globalPinId = allocation.pins.get(name);
        if (globalPinId === undefined) {
          throw new UnifiedIRCompilerError(
            'pin-not-found',
            `Device "${device.id}" pin "${name}" has no global pin id`,
            { deviceId: device.id, pinName: name },
          );
        }
        pinDomains.set(globalPinId, slot.index);
      }
    }

    return Object.freeze({
      devices: byDevice,
      slots: Object.freeze(slots),
      totalDomains: slots.length,
      pinDomains,
      primary,
    });
  }
}

/** Declares the pin memories shared by every device and net solver (RFC 0002). */
export function createPinMemory(
  module: IRModule,
  options: PinMemoryOptions = {},
): CompiledCircuitMemory {
  const supplyVoltage = options.supplyVoltage ?? DEFAULT_SUPPLY_VOLTAGE;
  if (!Number.isFinite(supplyVoltage) || supplyVoltage <= 0) {
    throw new UnifiedIRCompilerError(
      'invalid-input',
      `supplyVoltage must be a finite positive number, received ${String(supplyVoltage)}`,
    );
  }
  const pinVoltages = options.pinVoltages;
  // Thresholds are seeded per pin: a pin of a 1.8 V domain must classify its
  // own drive levels, not those of the circuit's nominal 3.3 V supply.
  const thresholds = Array.from({ length: UNIFIED_PIN_CAPACITY }, (_, index) =>
    thresholdsForSupply(pinVoltages?.get(index) ?? supplyVoltage),
  );
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
    pull: module.array(
      'pin_pull',
      'u8',
      Array.from({ length: UNIFIED_PIN_CAPACITY }, () => PIN_PULL.none),
    ),
    voltage: module.array(
      'pin_voltage',
      'f32',
      Array.from({ length: UNIFIED_PIN_CAPACITY }, () => 0),
    ),
    voltageIntent: module.array(
      'pin_voltage_intent',
      'f32',
      Array.from({ length: UNIFIED_PIN_CAPACITY }, () => 0),
    ),
    lowThreshold: module.array(
      'pin_low_threshold',
      'f32',
      thresholds.map((threshold) => threshold.low),
    ),
    highThreshold: module.array(
      'pin_high_threshold',
      'f32',
      thresholds.map((threshold) => threshold.high),
    ),
    electricalFault: module.array('electrical_fault', 'u8', [ELECTRICAL_FAULT.none]),
  });
}

/** Global pin id -> high-level voltage, derived from the declared domains. */
function pinVoltagesOf(domains: GlobalPowerDomainMap): ReadonlyMap<number, number> {
  const voltages = new Map<number, number>();
  for (const [globalPinId, domainIndex] of domains.pinDomains) {
    const slot = domains.slots[domainIndex];
    if (slot !== undefined) voltages.set(globalPinId, slot.voltage);
  }
  return voltages;
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

/**
 * Validates the RFC 0007 `powerDomains` declaration of one device.
 *
 * @throws {UnifiedIRCompilerError} when the field is not an array, an entry is
 *   not an object with a non-empty `name` and a finite positive `voltage`, or a
 *   name repeats.
 */
function powerDomainEntries(device: DeviceConfig): readonly PowerDomainDescription[] {
  const raw: unknown = device.description.powerDomains;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new UnifiedIRCompilerError(
      'invalid-input',
      `Device "${device.id}" needs description.powerDomains as an array`,
      { deviceId: device.id },
    );
  }
  const seen = new Set<string>();
  return raw.map((entry: unknown, index: number) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        `Device "${device.id}" power domain ${index} must be an object with name and voltage`,
        { deviceId: device.id },
      );
    }
    const { name, voltage } = entry as Partial<PowerDomainDescription>;
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        `Device "${device.id}" power domain ${index} needs a non-empty name`,
        { deviceId: device.id },
      );
    }
    if (seen.has(name)) {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        `Device "${device.id}" declares power domain "${name}" twice`,
        { deviceId: device.id },
      );
    }
    if (typeof voltage !== 'number' || !Number.isFinite(voltage) || voltage <= 0) {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        `Device "${device.id}" power domain "${name}" needs a finite positive voltage`,
        { deviceId: device.id },
      );
    }
    seen.add(name);
    return Object.freeze({ name, voltage });
  });
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

function connectionEntries(
  device: DeviceConfig,
): readonly (readonly [string, DeviceConnectionDescription])[] {
  return mapEntries(device.id, 'connections', device.description.connections, (name, raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        `Device "${device.id}" connection "${name}" must be an object with a pins pair`,
        { deviceId: device.id },
      );
    }
    const pins = (raw as DeviceConnectionDescription).pins;
    if (!Array.isArray(pins) || pins.length !== 2) {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        `Device "${device.id}" connection "${name}" needs exactly two pins`,
        { deviceId: device.id },
      );
    }
    for (const pin of pins) {
      if (typeof pin !== 'string' || pin.length === 0) {
        throw new UnifiedIRCompilerError(
          'invalid-input',
          `Device "${device.id}" connection "${name}" pins must be non-empty names`,
          { deviceId: device.id },
        );
      }
    }
    const initial = (raw as DeviceConnectionDescription).initial;
    if (initial !== undefined && initial !== 'open' && initial !== 'closed') {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        `Device "${device.id}" connection "${name}" initial must be "open" or "closed"`,
        { deviceId: device.id },
      );
    }
    return raw as DeviceConnectionDescription;
  });
}

function observerEntries(
  device: DeviceConfig,
): readonly (readonly [string, DeviceObserverDescription])[] {
  return mapEntries(device.id, 'observers', device.description.observers, (name, raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        `Device "${device.id}" observer "${name}" must be an object with a trigger pin`,
        { deviceId: device.id },
      );
    }
    const trigger = (raw as DeviceObserverDescription).trigger;
    if (typeof trigger !== 'string' || trigger.length === 0) {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        `Device "${device.id}" observer "${name}" needs a non-empty trigger pin name`,
        { deviceId: device.id },
      );
    }
    const captures = (raw as DeviceObserverDescription).captures;
    if (
      captures !== undefined &&
      (!Array.isArray(captures) ||
        captures.some((pin) => typeof pin !== 'string' || pin.length === 0))
    ) {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        `Device "${device.id}" observer "${name}" captures must be an array of pin names`,
        { deviceId: device.id },
      );
    }
    return raw as DeviceObserverDescription;
  });
}

function mapEntries<T>(
  deviceId: string,
  field: 'connections' | 'observers',
  raw: ReadonlyMap<string, T> | Readonly<Record<string, T>> | undefined,
  check: (name: string, value: T) => T,
): readonly (readonly [string, T])[] {
  if (raw === undefined) return [];
  if (raw instanceof Map) {
    return [...raw.entries()].map(
      ([name, value]) => [assertEntryName(deviceId, field, name), check(name, value)] as const,
    );
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UnifiedIRCompilerError(
      'invalid-input',
      `Device "${deviceId}" needs description.${field} as a Map or a plain object`,
      { deviceId },
    );
  }
  return Object.entries(raw as Record<string, T>).map(
    ([name, value]) => [assertEntryName(deviceId, field, name), check(name, value)] as const,
  );
}

function assertEntryName(
  deviceId: string,
  field: 'connections' | 'observers',
  name: string,
): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new UnifiedIRCompilerError(
      'invalid-input',
      `Device "${deviceId}" declares a ${field.slice(0, -1)} with an empty name`,
      { deviceId },
    );
  }
  return name;
}

function requireConnectionPin(
  deviceId: string,
  label: string,
  pinName: string,
  allocation: DevicePinAllocation,
): number {
  const globalPinId = allocation.pins.get(pinName);
  if (globalPinId === undefined) {
    const available = [...allocation.pins.keys()].map((entry) => `${deviceId}.${entry}`);
    throw new UnifiedIRCompilerError(
      'pin-not-found',
      `Device "${deviceId}" ${label} references unknown pin "${pinName}". Available: [${available.join(', ')}]`,
      { deviceId, pinName },
    );
  }
  return globalPinId;
}
