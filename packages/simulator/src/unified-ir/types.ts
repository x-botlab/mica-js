import type {
  ArrayRef,
  FunctionRef,
  IRInterpreter,
  IRModule,
  IRValidationOptions,
} from '@mica-js/ir';

/**
 * Types for the unified IR module prototype (v0).
 *
 * @deprecated The v0 prototype is superseded by the production pipeline:
 * {@link compileCircuit} in `./compiler` compiles the circuit and `Circuit` in
 * `./runtime` executes it. The prototype is scheduled for removal in the next
 * minor release; see `docs/DEPRECATIONS.md`. Migrate to `Circuit.create()`.
 *
 * Every device of a circuit shares one global pin address space, so the device
 * logic, the electrical solve, and the device updates are all generated into a
 * single `@mica-js/ir` module. One `unified_tick` call then advances the whole
 * circuit without a host callback, a scheduler hop, or a module boundary.
 *
 * ```text
 * PIN_MODE[256]  u8   0 = high-z, 1 = push-pull, 2 = open-drain, 3 = analog
 * PIN_OUTPUT[256] bool device output values
 * PIN_INPUT[256]  bool net solve results (what a load pin sees)
 * LED_STATE[8]    bool per-device lamp state
 * ```
 */

/** Global pin addresses available to one circuit (8 devices x 32 pins). */
export const UNIFIED_PIN_CAPACITY = 256;

/** Global pin addresses reserved per device (one 32-pin port). */
export const DEVICE_PIN_STRIDE = 32;

/** Devices one unified module can host inside the prototype's pin space. */
export const MAX_UNIFIED_DEVICES = UNIFIED_PIN_CAPACITY / DEVICE_PIN_STRIDE;

/** Values stored in the global `pin_mode` array. */
export const PIN_MODE = Object.freeze({
  highZ: 0,
  pushPull: 1,
  openDrain: 2,
  analog: 3,
} as const);

export type PinMode = (typeof PIN_MODE)[keyof typeof PIN_MODE];

/** Local pin indices the prototype MCU drives. */
export const MCU_PIN = Object.freeze({ PA0: 0 } as const);

export type McuPinName = keyof typeof MCU_PIN;

/** Local pin indices the prototype LED reads. */
export const LED_PIN = Object.freeze({ anode: 0, cathode: 1 } as const);

export type LedPinName = keyof typeof LED_PIN;

/** Pin count each supported device occupies in the global address space. */
export const DEVICE_PIN_COUNT: Readonly<Record<DeviceType, number>> = Object.freeze({
  mcu: 1,
  led: 2,
});

interface DeviceConfigBase {
  /** Circuit-unique identity; also the prefix of the generated function names. */
  readonly deviceId: string;
  /** First global pin address of the device; a multiple of `DEVICE_PIN_STRIDE`. */
  readonly pinOffset: number;
}

/** Simplified microcontroller: one push-pull output pin (`PA0`) that toggles. */
export interface McuDeviceConfig extends DeviceConfigBase {
  readonly type: 'mcu';
}

/** Single LED: `anode` reads the net, `cathode` is expected to sit on ground. */
export interface LedDeviceConfig extends DeviceConfigBase {
  readonly type: 'led';
}

export type DeviceConfig = McuDeviceConfig | LedDeviceConfig;

export type DeviceType = DeviceConfig['type'];

/** Which side of a net a pin sits on. */
export type PinRole = 'driver' | 'load';

export interface PinConnection {
  readonly deviceId: string;
  readonly pinName: string;
  /** Global pin address the connection resolves to. */
  readonly globalPinId: number;
  readonly role: PinRole;
}

export interface Net {
  readonly netId: number;
  readonly connections: readonly PinConnection[];
}

export interface Netlist {
  readonly nets: readonly Net[];
}

/**
 * @deprecated Prototype input shape with explicit pin offsets. Use
 * `CircuitCompilationInput` (`devices` + `connections`) with `compileCircuit`
 * or `Circuit.create` instead.
 */
export interface UnifiedCircuitConfig {
  readonly devices: readonly DeviceConfig[];
  readonly netlist: Netlist;
}

/** Generated arrays every device and every net solver reads and writes. */
export interface UnifiedPinMemory {
  readonly mode: ArrayRef<'u8'>;
  readonly output: ArrayRef<'bool'>;
  readonly input: ArrayRef<'bool'>;
  readonly ledState: ArrayRef<'bool'>;
}

export interface McuRuntime {
  readonly config: McuDeviceConfig;
  /** Generated `mcu_tick`: toggles `PA0` and drives it push-pull. */
  readonly tick: FunctionRef<readonly [], readonly []>;
  /** Global pin address of `PA0`. */
  readonly outputPin: number;
}

export interface LedRuntime {
  readonly config: LedDeviceConfig;
  /** Generated `led_update`: samples the inputs and writes the lamp state. */
  readonly update: FunctionRef<readonly [], readonly []>;
  readonly anodePin: number;
  readonly cathodePin: number;
  /** Index into the generated `led_state` array. */
  readonly stateIndex: number;
}

export interface NetRuntime {
  readonly netId: number;
  /** Generated `solve_net_<id>`. */
  readonly solve: FunctionRef<readonly [], readonly []>;
  readonly drivers: readonly PinConnection[];
  readonly loads: readonly PinConnection[];
}

/** Everything `generateUnifiedIR` produced for one circuit. */
export interface UnifiedIRProgram {
  readonly module: IRModule;
  /** Generated `unified_step`: one device-tick / solve / update pass. */
  readonly step: FunctionRef<readonly [], readonly []>;
  /** Generated `unified_tick(steps)`: the step above, looped inside the IR. */
  readonly tick: FunctionRef<readonly ['u32'], readonly []>;
  readonly memory: UnifiedPinMemory;
  /** Devices in config order; the index is also the LED state slot. */
  readonly devices: readonly DeviceConfig[];
  readonly mcus: readonly McuRuntime[];
  readonly leds: readonly LedRuntime[];
  readonly nets: readonly NetRuntime[];
  /** Validation grants derived from the module's own memories and instructions. */
  readonly validation: IRValidationOptions;
}

/** Options for {@link createUnifiedCircuit}. */
export interface UnifiedCircuitOptions {
  /** Replace the derived validation grants; the default covers the generated module. */
  readonly validation?: (program: UnifiedIRProgram) => IRValidationOptions;
  /** Execution engine. Defaults to `'jit'`; `'reference'` runs the interpreter. */
  readonly engine?: 'jit' | 'reference';
  /**
   * Tier-1 entries before `unified_tick` is recompiled at Tier 2. Defaults to
   * `0` so the compiled body is used from the first tick.
   */
  readonly tierUpThreshold?: number;
  /** Instance id reported to the engine. Defaults to `'unified-circuit'`. */
  readonly instanceId?: string;
}

/**
 * Compiled circuit: one IR module, one `tick()` call per simulated step.
 *
 * @deprecated Superseded by the `Circuit` class in `./runtime`, which adds
 * typed device accessors, `runBatch`, `reset`, pin access and disposal.
 */
export interface UnifiedCircuit {
  readonly program: UnifiedIRProgram;
  readonly runtime: IRInterpreter;
  readonly validation: IRValidationOptions;
  /** Number of completed ticks. */
  readonly ticks: number;
  /** Advances every device and every net once, inside the generated IR. */
  tick(): void;
  /**
   * Runs `count` ticks inside one generated loop, i.e. one engine call for the
   * whole batch. This is the throughput path: the scheduler architecture needs
   * one host entry per device per tick, the unified module needs one per batch.
   */
  run(count: number): void;
  readPinMode(pin: number): PinMode;
  readPinOutput(pin: number): boolean;
  readPinInput(pin: number): boolean;
  /** Host override used by tests and diagnostics to force a pin into high-z. */
  writePinMode(pin: number, mode: PinMode): void;
  /** Host override used by tests and diagnostics to preload a solved pin. */
  writePinInput(pin: number, level: boolean): void;
  /** Lamp state of one LED device, as written by its generated update. */
  ledOn(deviceId: string): boolean;
  /** Global pin address of `deviceId`'s local pin. */
  pinOf(deviceId: string, pinName: string): number;
}

export type UnifiedCircuitErrorCode =
  | 'unified-invalid-config'
  | 'unified-duplicate-device'
  | 'unified-unknown-device'
  | 'unified-duplicate-net'
  | 'unified-invalid-pin'
  | 'unified-invalid-connection';

export interface UnifiedCircuitErrorOptions {
  readonly deviceId?: string;
  readonly pinId?: number;
  readonly cause?: unknown;
}

/** Error raised while planning or driving a unified circuit. */
export class UnifiedCircuitError extends Error {
  override readonly name = 'UnifiedCircuitError';
  readonly code: UnifiedCircuitErrorCode;
  readonly deviceId: string | undefined;
  readonly pinId: number | undefined;

  constructor(
    code: UnifiedCircuitErrorCode,
    message: string,
    options: UnifiedCircuitErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.deviceId = options.deviceId;
    this.pinId = options.pinId;
  }
}

/** Options for {@link createMcuLedCircuit}. */
export interface SimpleCircuitOptions {
  readonly mcuId?: string;
  readonly ledId?: string;
  readonly mcuPinOffset?: number;
  readonly ledPinOffset?: number;
}

/** A validated MCU + LED config plus the pin addresses it resolved to. */
export interface SimpleCircuitLayout {
  readonly config: UnifiedCircuitConfig;
  readonly mcuId: string;
  readonly ledId: string;
  readonly mcuPa0: number;
  readonly ledAnode: number;
  readonly ledCathode: number;
}

/**
 * Builds the prototype circuit: `mcu.PA0 -> led.anode`, `led.cathode -> ground`.
 *
 * The cathode sits on the ground rail, so it is wired to a net with no driver
 * and resolves low — exactly what the LED update expects.
 */
export function createMcuLedCircuit(options: SimpleCircuitOptions = {}): SimpleCircuitLayout {
  const mcuId = options.mcuId ?? 'mcu';
  const ledId = options.ledId ?? 'led';
  const mcuPinOffset = options.mcuPinOffset ?? 0;
  const ledPinOffset = options.ledPinOffset ?? DEVICE_PIN_STRIDE;

  const mcu = Object.freeze({ deviceId: mcuId, type: 'mcu' as const, pinOffset: mcuPinOffset });
  const led = Object.freeze({ deviceId: ledId, type: 'led' as const, pinOffset: ledPinOffset });
  const mcuPa0 = devicePinId(mcu, 'PA0');
  const ledAnode = devicePinId(led, 'anode');
  const ledCathode = devicePinId(led, 'cathode');

  return Object.freeze({
    config: Object.freeze({
      devices: Object.freeze([mcu, led]),
      netlist: Object.freeze({
        nets: Object.freeze([
          Object.freeze({
            netId: 0,
            connections: Object.freeze([
              Object.freeze({
                deviceId: mcuId,
                pinName: 'PA0',
                globalPinId: mcuPa0,
                role: 'driver' as const,
              }),
              Object.freeze({
                deviceId: ledId,
                pinName: 'anode',
                globalPinId: ledAnode,
                role: 'load' as const,
              }),
            ]),
          }),
          Object.freeze({
            netId: 1,
            connections: Object.freeze([
              Object.freeze({
                deviceId: ledId,
                pinName: 'cathode',
                globalPinId: ledCathode,
                role: 'load' as const,
              }),
            ]),
          }),
        ]),
      }),
    }),
    mcuId,
    ledId,
    mcuPa0,
    ledAnode,
    ledCathode,
  });
}

/**
 * Resolves the global pin address of one device pin.
 *
 * @throws {UnifiedCircuitError} when the pin name does not belong to the device type.
 */
export function devicePinId(
  device: Pick<DeviceConfig, 'deviceId' | 'type' | 'pinOffset'>,
  pinName: string,
): number {
  return device.pinOffset + localPinIndex(device.type, pinName, device.deviceId);
}

function localPinIndex(type: DeviceType, pinName: string, deviceId: string): number {
  if (type === 'mcu') {
    if (Object.hasOwn(MCU_PIN, pinName)) return MCU_PIN[pinName as McuPinName];
  } else if (Object.hasOwn(LED_PIN, pinName)) {
    return LED_PIN[pinName as LedPinName];
  }
  throw new UnifiedCircuitError(
    'unified-invalid-connection',
    `Device "${deviceId}" (${type}) has no pin named "${pinName}"`,
    { deviceId },
  );
}
