/**
 * Unified-IR LED (U04).
 *
 * A two-terminal indicator compiled straight into the circuit module:
 *
 * ```text
 * led_ir_initialize:
 *   PIN_MODE[anode] = PIN_MODE[cathode] = HIGH-Z
 *   lamp = false, brightness = 0
 *
 * led_ir_update:                      // runs after the electrical solve
 *   forward = PIN_INPUT[anode] && !PIN_INPUT[cathode]   // flipped for activeLow
 *   lamp    = forward && level > 0
 *   brightness = lamp ? level : 0
 * ```
 *
 * `level` is the host-set intensity cap (0–255). It defaults to
 * `maxBrightness`, so an unconfigured LED is functionally identical to the
 * built-in `ideal-led` kernel (`lamp = anode && !cathode`); calling
 * `setBrightness(0)` dims it without touching the electrical model.
 *
 * The factory mirrors `examples/teaching-mcu/teaching-mcu.ts`: it returns a
 * standalone `@mica-js/ir` module, the layout its accessor reads, and a
 * `DeviceConfig` whose kernel emits the very same IR into any unified circuit
 * module.
 */
import { createIRModule } from '@mica-js/ir';
import type { FunctionRef, IRModule, IRValidationOptions, StateRef } from '@mica-js/ir';
import type { DeviceConfig, DeviceDescription } from '../../compiler';
import { createModuleValidation } from '../../validation';
import { PIN_MODE } from '../../pin-space';
import {
  createStandalonePinMemory,
  isDeviceIdentifier,
  resolvePinIds,
  type SimpleDevicePin,
  type SimplePinMemory,
  type StorageAccessor,
} from '../common';
import {
  buildAccessor,
  registerLedLayout,
  type LedAccessor,
  type LedAccessorOptions,
} from './led.ac';
import { LedError } from './led.errors';

export { LedError } from './led.errors';
export type { LedErrorCode, LedErrorOptions } from './led.errors';

/** Device type used by `Circuit.create` for the unified LED. */
export const LED_IR_TYPE = 'led-ir';

/** Colour labels accepted by {@link LedConfig.color}. */
export const LED_COLORS = Object.freeze([
  'red',
  'green',
  'blue',
  'yellow',
  'amber',
  'white',
] as const);

export type LedColor = (typeof LED_COLORS)[number];

/** One terminal of the two-terminal device. */
export type LedTerminal = 'anode' | 'cathode';

/** Author-facing configuration of one LED instance. */
export interface LedConfig {
  /** Anode pin name. Defaults to `'anode'`. */
  readonly anode?: string;
  /** Cathode pin name. Defaults to `'cathode'`. */
  readonly cathode?: string;
  /** Colour label; informational. Defaults to `'red'`. */
  readonly color?: LedColor;
  /** Forward voltage in volts; informational. Defaults to `2`. */
  readonly forwardVoltage?: number;
  /**
   * Reverse-mounted LED: lights when the anode is low and the cathode high.
   * Defaults to `false` (anode high, cathode low).
   */
  readonly activeLow?: boolean;
  /** Highest intensity `setBrightness` accepts, 1–255. Defaults to `255`. */
  readonly maxBrightness?: number;
  /** Initial intensity cap, 0–`maxBrightness`. Defaults to `maxBrightness`. */
  readonly initialBrightness?: number;
}

/** Fully resolved configuration returned by {@link resolveLedConfig}. */
export interface ResolvedLedConfig {
  readonly anode: string;
  readonly cathode: string;
  readonly color: LedColor;
  readonly forwardVoltage: number;
  readonly activeLow: boolean;
  readonly maxBrightness: number;
  readonly initialBrightness: number;
}

/** One LED terminal mapped into the global pin space. */
export interface LedPin extends SimpleDevicePin {
  readonly terminal: LedTerminal;
}

/** Pin memories the device reads; structurally equal to `CompiledCircuitMemory`. */
export type LedPinMemory = SimplePinMemory;

/** Ref/layout description the accessor needs; produced during IR generation. */
export interface LedLayout {
  readonly deviceId: string;
  readonly type: typeof LED_IR_TYPE;
  readonly config: ResolvedLedConfig;
  readonly pins: ReadonlyMap<string, LedPin>;
  readonly pinNames: readonly string[];
  readonly pinMemory: LedPinMemory;
  readonly states: {
    /** True while forward biased and the intensity cap is non-zero. */
    readonly lamp: StateRef<'bool'>;
    /** Host-set intensity cap, 0–`maxBrightness`. */
    readonly level: StateRef<'u8'>;
    /** Derived intensity: `lamp ? level : 0`. */
    readonly brightness: StateRef<'u8'>;
  };
  readonly entries: {
    readonly initialize: FunctionRef<readonly [], readonly []>;
    readonly update: FunctionRef<readonly [], readonly []>;
  };
}

/** Mutable holder the description kernel fills during circuit compilation. */
export interface LedLayoutHolder {
  layout: LedLayout | undefined;
}

/** A generated unified LED: standalone module plus circuit template. */
export interface LedIRDevice {
  readonly id: string;
  readonly type: typeof LED_IR_TYPE;
  readonly config: ResolvedLedConfig;
  /** Standalone module containing initialize/update. */
  readonly module: IRModule;
  /** Layout of the standalone module. */
  readonly layout: LedLayout;
  /** Device config for `Circuit.create`. */
  readonly device: DeviceConfig;
  /** Validation grants for the standalone module. */
  readonly validation: IRValidationOptions;
  /** Builds an accessor over storage holding this device's module. */
  buildAccessor(storage: StorageAccessor, options?: LedAccessorOptions): LedAccessor;
}

const DEFAULT_ANODE = 'anode';
const DEFAULT_CATHODE = 'cathode';

/**
 * Resolves and validates one LED configuration.
 *
 * @throws {LedError} with code `invalid-config` for any malformed field.
 */
export function resolveLedConfig(config: LedConfig = {}): ResolvedLedConfig {
  if (config === null || typeof config !== 'object') {
    throw new LedError('invalid-config', 'LedConfig must be an object');
  }
  const anode = pinName(config.anode ?? DEFAULT_ANODE, 'anode');
  const cathode = pinName(config.cathode ?? DEFAULT_CATHODE, 'cathode');
  if (anode === cathode) {
    throw new LedError(
      'invalid-config',
      `LedConfig.anode and LedConfig.cathode must differ, received ${JSON.stringify(anode)} twice`,
    );
  }
  const color = config.color ?? 'red';
  if (!(LED_COLORS as readonly string[]).includes(color)) {
    throw new LedError(
      'invalid-config',
      `LedConfig.color must be one of [${LED_COLORS.join(', ')}], received ${JSON.stringify(color)}`,
    );
  }
  const forwardVoltage = config.forwardVoltage ?? 2;
  if (
    typeof forwardVoltage !== 'number' ||
    !Number.isFinite(forwardVoltage) ||
    forwardVoltage < 0 ||
    forwardVoltage > 12
  ) {
    throw new LedError(
      'invalid-config',
      `LedConfig.forwardVoltage must be a number in [0, 12], received ${String(forwardVoltage)}`,
    );
  }
  const activeLow = config.activeLow ?? false;
  if (typeof activeLow !== 'boolean') {
    throw new LedError(
      'invalid-config',
      `LedConfig.activeLow must be a boolean, received ${String(activeLow)}`,
    );
  }
  const maxBrightness = config.maxBrightness ?? 255;
  if (!Number.isInteger(maxBrightness) || maxBrightness < 1 || maxBrightness > 255) {
    throw new LedError(
      'invalid-config',
      `LedConfig.maxBrightness must be an integer in [1, 255], received ${String(maxBrightness)}`,
    );
  }
  const initialBrightness = config.initialBrightness ?? maxBrightness;
  if (
    !Number.isInteger(initialBrightness) ||
    initialBrightness < 0 ||
    initialBrightness > maxBrightness
  ) {
    throw new LedError(
      'invalid-config',
      `LedConfig.initialBrightness must be an integer in [0, ${maxBrightness}], received ${String(initialBrightness)}`,
    );
  }
  return Object.freeze({
    anode,
    cathode,
    color,
    forwardVoltage,
    activeLow,
    maxBrightness,
    initialBrightness,
  });
}

function pinName(value: unknown, field: 'anode' | 'cathode'): string {
  if (typeof value !== 'string' || value.length === 0 || /\s/.test(value)) {
    throw new LedError(
      'invalid-config',
      `LedConfig.${field} must be a non-empty string without whitespace, received ${String(value)}`,
    );
  }
  return value;
}

function assertDeviceId(id: string): void {
  if (!isDeviceIdentifier(id)) {
    throw new LedError(
      'invalid-device-id',
      `LED id must be an identifier (letters, digits and "_", not starting with a digit), received ${JSON.stringify(id)}`,
      { deviceId: id },
    );
  }
}

/* -------------------------------------------------------------------------
 * IR generation
 * ---------------------------------------------------------------------- */

interface LedGenerateOptions {
  readonly module: IRModule;
  readonly deviceId: string;
  readonly config: ResolvedLedConfig;
  /** Existing global pin memory when generating into a circuit. */
  readonly pinMemory?: LedPinMemory;
  /** Pin name -> global pin id when generating into a circuit. */
  readonly pinIds?: ReadonlyMap<string, number>;
}

interface GeneratedLedKernel {
  readonly layout: LedLayout;
  readonly entries: LedLayout['entries'];
}

function generateLedKernel(options: LedGenerateOptions): GeneratedLedKernel {
  const { module, deviceId, config } = options;
  const pinNames = [config.anode, config.cathode] as const;
  const pinIds = resolvePinIds(deviceId, pinNames, options.pinIds, unknownPin);
  const pins = new Map<string, LedPin>();
  pins.set(
    config.anode,
    Object.freeze({
      name: config.anode,
      terminal: 'anode',
      globalPinId: pinIds.get(config.anode) as number,
    }),
  );
  pins.set(
    config.cathode,
    Object.freeze({
      name: config.cathode,
      terminal: 'cathode',
      globalPinId: pinIds.get(config.cathode) as number,
    }),
  );
  const pinMemory =
    options.pinMemory === undefined
      ? createStandalonePinMemory(module, deviceId, pinNames.length)
      : options.pinMemory;
  const anodePin = pins.get(config.anode) as LedPin;
  const cathodePin = pins.get(config.cathode) as LedPin;

  const lamp = module.state(`${deviceId}_lamp`, 'bool', false);
  const level = module.state(`${deviceId}_level`, 'u8', config.initialBrightness);
  const brightness = module.state(`${deviceId}_brightness`, 'u8', 0);

  const initialize = module.func(`${deviceId}_ir_initialize`, { params: [], results: [] });
  initialize.body((b) => {
    for (const pin of pins.values()) {
      const index = b.const('u32', pin.globalPinId);
      b.array.store(pinMemory.mode, index, b.const('u8', PIN_MODE.highZ));
      b.array.store(pinMemory.output, index, b.const('bool', false));
    }
    b.state.store(lamp, b.const('bool', false));
    b.state.store(brightness, b.const('u8', 0));
    b.return([]);
  });

  const update = module.func(`${deviceId}_ir_update`, { params: [], results: [] });
  update.body((b) => {
    const anode = b.array.load(pinMemory.input, b.const('u32', anodePin.globalPinId));
    const cathode = b.array.load(pinMemory.input, b.const('u32', cathodePin.globalPinId));
    const forward = config.activeLow
      ? b.bool.and(b.bool.not(anode), cathode)
      : b.bool.and(anode, b.bool.not(cathode));
    const currentLevel = b.state.load(level);
    const lit = b.bool.and(forward, b.int.cmp('ne', currentLevel, b.const('u8', 0)));
    b.state.store(lamp, lit);
    b.state.store(brightness, b.select(lit, currentLevel, b.const('u8', 0)));
    b.return([]);
  });

  const layout: LedLayout = Object.freeze({
    deviceId,
    type: LED_IR_TYPE,
    config,
    pins,
    pinNames: Object.freeze(pinNames),
    pinMemory,
    states: Object.freeze({ lamp, level, brightness }),
    entries: Object.freeze({ initialize, update }),
  });
  return Object.freeze({ layout, entries: layout.entries });
}

function unknownPin(deviceId: string, pinName: string): LedError {
  return new LedError(
    'unknown-pin',
    `Device "${deviceId}" declared LED pin "${pinName}", which is not one of the configured terminals`,
    { deviceId, pinName },
  );
}

/* -------------------------------------------------------------------------
 * Public factories
 * ---------------------------------------------------------------------- */

/**
 * Creates the unified-IR LED.
 *
 * ```ts
 * const led = createLedIR('led1', { color: 'green' });
 * const circuit = await Circuit.create({
 *   devices: [led.device],
 *   connections: [{ from: 'driver.out', to: 'led1.anode' }],
 * });
 * circuit.devices.led1.isOn();
 * ```
 */
export function createLedIR(id: string, config: LedConfig = {}): LedIRDevice {
  assertDeviceId(id);
  const resolved = resolveLedConfig(config);
  const module = createIRModule();
  const generated = generateLedKernel({ module, deviceId: id, config: resolved });
  const validation = createModuleValidation(module);
  const holder: LedLayoutHolder = { layout: undefined };
  const description = createLedIRDescription(id, resolved, holder);
  registerLedLayout(id, generated.layout);
  const device: DeviceConfig = Object.freeze({
    id,
    type: LED_IR_TYPE,
    description,
    config: resolved as unknown as Readonly<Record<string, unknown>>,
  });
  const irDevice: LedIRDevice = {
    id,
    type: LED_IR_TYPE,
    config: resolved,
    module,
    layout: generated.layout,
    device,
    validation,
    buildAccessor(storage: StorageAccessor, options: LedAccessorOptions = {}): LedAccessor {
      return buildAccessor(id, storage, generated.layout, options);
    },
  };
  return Object.freeze(irDevice);
}

/**
 * Builds the device description used by `Circuit.create`.
 *
 * The kernel allocates the device's states inside the circuit module and fills
 * `holder` with the layout the accessor factory closes over.
 */
export function createLedIRDescription(
  id: string,
  config: LedConfig = {},
  holder: LedLayoutHolder = { layout: undefined },
): DeviceDescription {
  assertDeviceId(id);
  const resolved = resolveLedConfig(config);
  const description: DeviceDescription = {
    name: 'led',
    pins: Object.freeze({
      [resolved.anode]: Object.freeze({ direction: 'passive' as const }),
      [resolved.cathode]: Object.freeze({ direction: 'passive' as const }),
    }),
    kernel: (context) => {
      const generated = generateLedKernel({
        module: context.module,
        deviceId: context.deviceId,
        config: resolved,
        pinMemory: context.memory,
        pinIds: new Map(context.pins.map((pin) => [pin.name, pin.globalPinId])),
      });
      holder.layout = generated.layout;
      return generated.entries;
    },
    accessor: (context) => {
      const layout = holder.layout;
      if (layout === undefined) {
        throw new LedError(
          'layout-not-found',
          `LED "${context.deviceId}" has no generated layout; compile the circuit before building its accessor`,
          { deviceId: context.deviceId },
        );
      }
      return buildAccessor(context.deviceId, context.storage as StorageAccessor, layout, {
        assertActive: context.assertActive,
        step: context.step,
        runBatch: context.runBatch,
      });
    },
  };
  return Object.freeze(description);
}
