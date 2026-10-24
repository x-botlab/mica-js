import { createIRModule } from '@mica-js/ir';
import type {
  BytesRef,
  FunctionBuilder,
  IRModule,
  IRResourcePermission,
  IRValidationOptions,
} from '@mica-js/ir';
import { generateLed } from './fixtures/simple-led';
import { generateMcu } from './fixtures/simple-mcu';
import { generateNetSolver, type PlannedNet } from './fixtures/test-netlist';
import {
  DEVICE_PIN_COUNT,
  DEVICE_PIN_STRIDE,
  MAX_UNIFIED_DEVICES,
  PIN_MODE,
  UNIFIED_PIN_CAPACITY,
  UnifiedCircuitError,
  devicePinId,
  type DeviceConfig,
  type LedRuntime,
  type McuRuntime,
  type NetRuntime,
  type PinConnection,
  type UnifiedCircuitConfig,
  type UnifiedIRProgram,
  type UnifiedPinMemory,
} from './types';

/** A config that passed every structural and pin-address check. */
export interface CircuitPlan {
  readonly devices: readonly DeviceConfig[];
  readonly nets: readonly PlannedNet[];
}

/**
 * Generates one IR module that contains the whole circuit.
 *
 * ```text
 * unify_circuit(config):
 *   pin_mode[256], pin_output[256], pin_input[256], led_state[8]
 *
 *   unified_step():
 *     mcu_tick()        // every driving device, config order
 *     solve_net_0()     // every net, net order
 *     solve_net_1()
 *     led_update()      // every sensing device, config order
 *
 *   unified_tick(steps):  // the same body, looped inside the IR
 *     for i in 0 .. steps { <unified_step body> }
 * ```
 *
 * The ordering is what makes a single pass a complete simulation step: drivers
 * publish their outputs, the electrical network resolves, and only then do the
 * loads observe the solved inputs. Looping inside the module is what removes
 * the per-tick host entry: a batch of `steps` ticks costs one engine call.
 *
 * @throws {UnifiedCircuitError} when the config is malformed or the netlist
 *   disagrees with a device's pin layout.
 */
export function generateUnifiedIR(config: UnifiedCircuitConfig): UnifiedIRProgram {
  const plan = planUnifiedCircuit(config);
  const module = createIRModule();
  const memory = allocatePinMemory(module);

  const mcus: McuRuntime[] = [];
  const leds: LedRuntime[] = [];
  for (const [index, device] of plan.devices.entries()) {
    if (device.type === 'mcu') {
      mcus.push(generateMcu(module, device, memory));
    } else {
      leds.push(generateLed(module, device, memory, index));
    }
  }

  const nets: NetRuntime[] = plan.nets.map((net) => generateNetSolver(module, net, memory));

  /** Emits one dependency-ordered pass over every device and every net. */
  const emitStep = (b: FunctionBuilder): void => {
    for (const mcu of mcus) b.call(mcu.tick, []);
    for (const net of nets) b.call(net.solve, []);
    for (const led of leds) b.call(led.update, []);
  };

  const step = module.func('unified_step', { params: [], results: [] });
  step.body((b) => {
    emitStep(b);
    b.return([]);
  });

  const tick = module.func('unified_tick', { params: ['u32'], results: [] });
  tick.body((b, [steps]) => {
    const header = b.block(['u32']);
    const body = b.block(['u32']);
    const done = b.block([]);
    b.jump(header, [b.const('u32', 0)]);
    b.at(header, (ib, [index]) =>
      ib.branch(
        ib.int.cmp('lt', index, steps),
        { target: body, args: [index] },
        { target: done, args: [] },
      ),
    );
    b.at(body, (ib, [index]) => {
      emitStep(ib);
      ib.jump(header, [ib.int.add(index, ib.const('u32', 1))]);
    });
    b.at(done, (ib) => ib.return([]));
  });

  return Object.freeze({
    module,
    step,
    tick,
    memory,
    devices: plan.devices,
    mcus: Object.freeze(mcus),
    leds: Object.freeze(leds),
    nets: Object.freeze(nets),
    validation: createModuleValidation(module),
  });
}

function allocatePinMemory(module: IRModule): UnifiedPinMemory {
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
    ledState: module.array(
      'led_state',
      'bool',
      Array.from({ length: MAX_UNIFIED_DEVICES }, () => false),
    ),
  });
}

/**
 * Builds the validation grants a module needs to run on the reference engine or
 * the JIT: every instruction the model uses, authorized once, plus a grant for
 * each declared memory.
 *
 * `@mica-js/ir` deliberately keeps its core instruction list internal, so the
 * names are collected from the generated bodies instead of being restated here.
 */
export function createModuleValidation(
  module: IRModule,
  updateResources: readonly BytesRef[] = [],
): IRValidationOptions {
  const names = new Set<string>();
  for (const fn of module.functions) {
    const body = fn.body;
    if (body === undefined) continue;
    // `body.blocks` already contains the entry block.
    for (const block of body.blocks) {
      for (const instruction of block.instructions) names.add(instruction.op);
      if (block.terminator !== undefined) names.add(block.terminator.kind);
    }
  }
  const instructions = Object.freeze([...names]);
  const resources: IRResourcePermission[] = module.memories.map((memory) =>
    Object.freeze({
      ref: memory.ref,
      access: memory.writable ? ('read-write' as const) : ('read' as const),
    }),
  );
  // Read-only byte regions such as firmware stay unreadable to guest stores but
  // can opt into the host-only versioned update path (`patchFirmware`).
  const memories = new Set(module.memories.map((memory) => memory.ref));
  for (const ref of new Set(updateResources)) {
    if (!memories.has(ref)) continue;
    resources.push(Object.freeze({ ref, access: 'update' as const }));
  }
  return Object.freeze({
    supportedInstructions: instructions,
    authorizedInstructions: instructions,
    resources: Object.freeze(resources),
  });
}

/**
 * Validates a config and resolves its device and net layout.
 *
 * The netlist is checked against the device pin maps, so a connection that
 * names an unknown device, an unknown pin, or the wrong global address fails
 * here — before a single instruction is generated.
 *
 * @throws {UnifiedCircuitError} for any structural or pin-address violation.
 */
export function planUnifiedCircuit(config: UnifiedCircuitConfig): CircuitPlan {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    invalid('Expected a unified circuit config object');
  }
  const rawDevices: unknown = config.devices;
  if (!Array.isArray(rawDevices) || rawDevices.length === 0) {
    invalid('UnifiedCircuitConfig.devices must be a non-empty array');
  }
  if (rawDevices.length > MAX_UNIFIED_DEVICES) {
    invalid(
      `UnifiedCircuitConfig.devices holds ${rawDevices.length} devices; the pin space fits ${MAX_UNIFIED_DEVICES}`,
    );
  }

  const names = new Set<string>(['unified_step', 'unified_tick']);
  const devices: DeviceConfig[] = [];
  const byId = new Map<string, DeviceConfig>();
  for (const raw of rawDevices as readonly unknown[]) {
    const device = planDevice(raw, byId, names);
    devices.push(device);
    byId.set(device.deviceId, device);
  }

  const rawNetlist: unknown = config.netlist;
  if (rawNetlist === null || typeof rawNetlist !== 'object' || Array.isArray(rawNetlist)) {
    invalid('UnifiedCircuitConfig.netlist must be an object');
  }
  const rawNets: unknown = (rawNetlist as { nets?: unknown }).nets;
  if (!Array.isArray(rawNets)) {
    invalid('UnifiedCircuitConfig.netlist.nets must be an array');
  }

  const netIds = new Set<number>();
  const connected = new Map<number, string>();
  const nets: PlannedNet[] = [];
  for (const raw of rawNets as readonly unknown[]) {
    const net = planNet(raw, byId, netIds, connected);
    reserveName(names, `solve_net_${net.netId}`);
    nets.push(net);
  }

  return Object.freeze({ devices: Object.freeze(devices), nets: Object.freeze(nets) });
}

function planDevice(
  raw: unknown,
  byId: ReadonlyMap<string, DeviceConfig>,
  names: Set<string>,
): DeviceConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    invalid('Every device config must be an object');
  }
  const record = raw as Record<string, unknown>;
  const deviceId = record.deviceId;
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    invalid('Device deviceId must be a non-empty string');
  }
  if (byId.has(deviceId)) {
    throw new UnifiedCircuitError(
      'unified-duplicate-device',
      `Device "${deviceId}" is declared more than once`,
      { deviceId },
    );
  }
  const type = record.type;
  if (type !== 'mcu' && type !== 'led') {
    invalid(`Device "${deviceId}" has unsupported type ${String(type)}`, { deviceId });
  }
  const pinOffset = record.pinOffset;
  if (
    typeof pinOffset !== 'number' ||
    !Number.isSafeInteger(pinOffset) ||
    pinOffset < 0 ||
    pinOffset % DEVICE_PIN_STRIDE !== 0
  ) {
    throw new UnifiedCircuitError(
      'unified-invalid-pin',
      `Device "${deviceId}" pinOffset must be a non-negative multiple of ${DEVICE_PIN_STRIDE}`,
      { deviceId },
    );
  }
  const pinCount = DEVICE_PIN_COUNT[type];
  if (pinOffset + pinCount > UNIFIED_PIN_CAPACITY) {
    throw new UnifiedCircuitError(
      'unified-invalid-pin',
      `Device "${deviceId}" needs ${pinCount} pins at offset ${pinOffset}; the pin space ends at ${UNIFIED_PIN_CAPACITY}`,
      { deviceId, pinId: pinOffset },
    );
  }
  for (const other of byId.values()) {
    if (other.pinOffset === pinOffset) {
      throw new UnifiedCircuitError(
        'unified-invalid-pin',
        `Device "${deviceId}" pinOffset ${pinOffset} is already used by "${other.deviceId}"`,
        { deviceId, pinId: pinOffset },
      );
    }
  }
  const device: DeviceConfig =
    type === 'mcu'
      ? Object.freeze({ deviceId, type: 'mcu', pinOffset })
      : Object.freeze({ deviceId, type: 'led', pinOffset });
  reserveName(names, `${deviceId}_${type === 'mcu' ? 'tick' : 'update'}`);
  return device;
}

function planNet(
  raw: unknown,
  devices: ReadonlyMap<string, DeviceConfig>,
  netIds: Set<number>,
  connected: Map<number, string>,
): PlannedNet {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    invalid('Every net config must be an object');
  }
  const record = raw as Record<string, unknown>;
  const netId = record.netId;
  if (typeof netId !== 'number' || !Number.isSafeInteger(netId) || netId < 0) {
    invalid('Net netId must be a non-negative safe integer');
  }
  if (netIds.has(netId)) {
    throw new UnifiedCircuitError(
      'unified-duplicate-net',
      `Net ${netId} is declared more than once`,
    );
  }
  const rawConnections = record.connections;
  if (!Array.isArray(rawConnections) || rawConnections.length === 0) {
    invalid(`Net ${netId} needs at least one connection`);
  }

  const drivers: PinConnection[] = [];
  const loads: PinConnection[] = [];
  for (const rawConnection of rawConnections as readonly unknown[]) {
    const connection = planConnection(rawConnection, netId, devices, connected);
    if (connection.role === 'driver') drivers.push(connection);
    else loads.push(connection);
  }
  netIds.add(netId);

  return Object.freeze({
    netId,
    drivers: Object.freeze(drivers),
    loads: Object.freeze(loads),
  });
}

function planConnection(
  raw: unknown,
  netId: number,
  devices: ReadonlyMap<string, DeviceConfig>,
  connected: Map<number, string>,
): PinConnection {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    invalid(`Net ${netId} has a connection that is not an object`);
  }
  const record = raw as Record<string, unknown>;
  const deviceId = record.deviceId;
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    invalid(`Net ${netId} has a connection without a device id`);
  }
  const device = devices.get(deviceId);
  if (device === undefined) {
    throw new UnifiedCircuitError(
      'unified-unknown-device',
      `Net ${netId} connects unknown device "${deviceId}"`,
      { deviceId },
    );
  }
  const pinName = record.pinName;
  if (typeof pinName !== 'string' || pinName.length === 0) {
    invalid(`Net ${netId} has a connection without a pin name`, { deviceId });
  }
  const expected = devicePinId(device, pinName);
  const globalPinId = record.globalPinId;
  if (typeof globalPinId !== 'number' || !Number.isSafeInteger(globalPinId)) {
    invalid(`Net ${netId} has a connection without a global pin id`, { deviceId });
  }
  if (globalPinId < 0 || globalPinId >= UNIFIED_PIN_CAPACITY) {
    throw new UnifiedCircuitError(
      'unified-invalid-pin',
      `Net ${netId} pin ${globalPinId} is outside the global pin space [0, ${UNIFIED_PIN_CAPACITY})`,
      { deviceId, pinId: globalPinId },
    );
  }
  if (globalPinId !== expected) {
    throw new UnifiedCircuitError(
      'unified-invalid-connection',
      `Net ${netId} wires "${deviceId}.${pinName}" to ${globalPinId}; the device layout puts it at ${expected}`,
      { deviceId, pinId: globalPinId },
    );
  }
  const role = record.role;
  if (role !== 'driver' && role !== 'load') {
    invalid(`Net ${netId} connection "${deviceId}.${pinName}" needs role "driver" or "load"`, {
      deviceId,
      pinId: globalPinId,
    });
  }
  const owner = connected.get(globalPinId);
  if (owner !== undefined) {
    throw new UnifiedCircuitError(
      'unified-invalid-connection',
      `Pin "${deviceId}.${pinName}" (${globalPinId}) is already connected by ${owner}`,
      { deviceId, pinId: globalPinId },
    );
  }
  connected.set(globalPinId, `net ${netId}`);

  return Object.freeze({ deviceId, pinName, globalPinId, role });
}

function reserveName(names: Set<string>, name: string): void {
  if (names.has(name)) {
    invalid(`Generated function name "${name}" collides with another declaration`);
  }
  names.add(name);
}

function invalid(message: string, options?: { deviceId?: string; pinId?: number }): never {
  throw new UnifiedCircuitError('unified-invalid-config', message, options ?? {});
}
