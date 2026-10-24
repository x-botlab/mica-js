/**
 * Unified-IR push button (U04).
 *
 * ```text
 * button_ir_tick:                     // runs before the electrical solve
 *   raw      = pressed                // host-asserted position
 *   differed = raw ^ closed
 *   ticks    = differed ? counter + 1 : 0
 *   reached  = ticks >= debounceTicks
 *   closed  <- reached ? raw : closed
 *   counter <- reached ? 0 : ticks
 *   pressCount <- (differed && reached && raw) ? pressCount + 1 : pressCount
 *   holdTicks  <- closed ? holdTicks + 1 : 0
 *   PIN_MODE[A]   = closed ? PUSH_PULL : HIGH-Z
 *   PIN_OUTPUT[A] = closed ? !activeLow : false
 *
 * button_ir_update:                   // runs after the electrical solve
 *   line      <- PIN_INPUT[A]
 *   reference <- PIN_INPUT[B]
 * ```
 *
 * A and B mirror the two terminals of `packages/device/examples/ideal-button`.
 * The unified compiler resolves nets statically, so a switch cannot join two
 * nets at runtime; the button therefore asserts `A` as an ideal push-button
 * source (`B` is the reference/return terminal the host wires to a rail).
 * Releasing the button leaves `A` high-Z, which the v1 solver reads as low, so
 * a high-side button (`B` -> GND, `A` -> load) and a low-side button
 * (`activeLow`, `A` -> load cathode, load anode -> VCC) both work.
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
  registerButtonLayout,
  type ButtonAccessor,
  type ButtonAccessorOptions,
} from './button.ac';
import { ButtonError } from './button.errors';

export { ButtonError } from './button.errors';
export type { ButtonErrorCode, ButtonErrorOptions } from './button.errors';

/** Device type used by `Circuit.create` for the unified button. */
export const BUTTON_IR_TYPE = 'button-ir';

/** One terminal of the two-terminal device. */
export type ButtonTerminal = 'a' | 'b';

/** Author-facing configuration of one button instance. */
export interface ButtonConfig {
  /** Switched terminal name. Defaults to `'A'`. */
  readonly a?: string;
  /** Reference/return terminal name. Defaults to `'B'`. */
  readonly b?: string;
  /** Initial host-asserted position. Defaults to `false`. */
  readonly initialPressed?: boolean;
  /** Ticks the raw input must stay stable before it is published. Defaults to `0`. */
  readonly debounceTicks?: number;
  /** Pressed pulls `A` low instead of high. Defaults to `false`. */
  readonly activeLow?: boolean;
}

/** Fully resolved configuration returned by {@link resolveButtonConfig}. */
export interface ResolvedButtonConfig {
  readonly a: string;
  readonly b: string;
  readonly initialPressed: boolean;
  readonly debounceTicks: number;
  readonly activeLow: boolean;
}

/** One button terminal mapped into the global pin space. */
export interface ButtonPin extends SimpleDevicePin {
  readonly terminal: ButtonTerminal;
}

/** Pin memories the device reads and writes; equal to `CompiledCircuitMemory`. */
export type ButtonPinMemory = SimplePinMemory;

/** Ref/layout description the accessor needs; produced during IR generation. */
export interface ButtonLayout {
  readonly deviceId: string;
  readonly type: typeof BUTTON_IR_TYPE;
  readonly config: ResolvedButtonConfig;
  readonly pins: ReadonlyMap<string, ButtonPin>;
  readonly pinNames: readonly string[];
  readonly pinMemory: ButtonPinMemory;
  readonly states: {
    /** Host-asserted position (raw input). */
    readonly pressed: StateRef<'bool'>;
    /** Debounced position that drives the switched terminal. */
    readonly closed: StateRef<'bool'>;
    /** Consecutive ticks the raw input has differed from `closed`. */
    readonly counter: StateRef<'u32'>;
    /** Completed press edges since creation/reset. */
    readonly pressCount: StateRef<'u32'>;
    /** Consecutive ticks the debounced contact stayed closed. */
    readonly holdTicks: StateRef<'u32'>;
    /** Solved level on the switched terminal after the last update. */
    readonly line: StateRef<'bool'>;
    /** Solved level on the reference terminal after the last update. */
    readonly reference: StateRef<'bool'>;
  };
  readonly entries: {
    readonly initialize: FunctionRef<readonly [], readonly []>;
    readonly tick: FunctionRef<readonly [], readonly []>;
    readonly update: FunctionRef<readonly [], readonly []>;
  };
}

/** Mutable holder the description kernel fills during circuit compilation. */
export interface ButtonLayoutHolder {
  layout: ButtonLayout | undefined;
}

/** A generated unified button: standalone module plus circuit template. */
export interface ButtonIRDevice {
  readonly id: string;
  readonly type: typeof BUTTON_IR_TYPE;
  readonly config: ResolvedButtonConfig;
  /** Standalone module containing initialize/tick/update. */
  readonly module: IRModule;
  /** Layout of the standalone module. */
  readonly layout: ButtonLayout;
  /** Device config for `Circuit.create`. */
  readonly device: DeviceConfig;
  /** Validation grants for the standalone module. */
  readonly validation: IRValidationOptions;
  /** Builds an accessor over storage holding this device's module. */
  buildAccessor(storage: StorageAccessor, options?: ButtonAccessorOptions): ButtonAccessor;
}

const DEFAULT_TERMINAL_A = 'A';
const DEFAULT_TERMINAL_B = 'B';
const MAX_DEBOUNCE_TICKS = 0xffff_ffff;

/**
 * Resolves and validates one button configuration.
 *
 * @throws {ButtonError} with code `invalid-config` for any malformed field.
 */
export function resolveButtonConfig(config: ButtonConfig = {}): ResolvedButtonConfig {
  if (config === null || typeof config !== 'object') {
    throw new ButtonError('invalid-config', 'ButtonConfig must be an object');
  }
  const a = pinName(config.a ?? DEFAULT_TERMINAL_A, 'a');
  const b = pinName(config.b ?? DEFAULT_TERMINAL_B, 'b');
  if (a === b) {
    throw new ButtonError(
      'invalid-config',
      `ButtonConfig.a and ButtonConfig.b must differ, received ${JSON.stringify(a)} twice`,
    );
  }
  const initialPressed = config.initialPressed ?? false;
  if (typeof initialPressed !== 'boolean') {
    throw new ButtonError(
      'invalid-config',
      `ButtonConfig.initialPressed must be a boolean, received ${String(initialPressed)}`,
    );
  }
  const debounceTicks = config.debounceTicks ?? 0;
  if (!Number.isInteger(debounceTicks) || debounceTicks < 0 || debounceTicks > MAX_DEBOUNCE_TICKS) {
    throw new ButtonError(
      'invalid-config',
      `ButtonConfig.debounceTicks must be an integer in [0, ${MAX_DEBOUNCE_TICKS}], received ${String(debounceTicks)}`,
    );
  }
  const activeLow = config.activeLow ?? false;
  if (typeof activeLow !== 'boolean') {
    throw new ButtonError(
      'invalid-config',
      `ButtonConfig.activeLow must be a boolean, received ${String(activeLow)}`,
    );
  }
  return Object.freeze({ a, b, initialPressed, debounceTicks, activeLow });
}

function pinName(value: unknown, field: 'a' | 'b'): string {
  if (typeof value !== 'string' || value.length === 0 || /\s/.test(value)) {
    throw new ButtonError(
      'invalid-config',
      `ButtonConfig.${field} must be a non-empty string without whitespace, received ${String(value)}`,
    );
  }
  return value;
}

function assertDeviceId(id: string): void {
  if (!isDeviceIdentifier(id)) {
    throw new ButtonError(
      'invalid-device-id',
      `Button id must be an identifier (letters, digits and "_", not starting with a digit), received ${JSON.stringify(id)}`,
      { deviceId: id },
    );
  }
}

/* -------------------------------------------------------------------------
 * IR generation
 * ---------------------------------------------------------------------- */

interface ButtonGenerateOptions {
  readonly module: IRModule;
  readonly deviceId: string;
  readonly config: ResolvedButtonConfig;
  /** Existing global pin memory when generating into a circuit. */
  readonly pinMemory?: ButtonPinMemory;
  /** Pin name -> global pin id when generating into a circuit. */
  readonly pinIds?: ReadonlyMap<string, number>;
}

interface GeneratedButtonKernel {
  readonly layout: ButtonLayout;
  readonly entries: ButtonLayout['entries'];
}

function generateButtonKernel(options: ButtonGenerateOptions): GeneratedButtonKernel {
  const { module, deviceId, config } = options;
  const pinNames = [config.a, config.b] as const;
  const pinIds = resolvePinIds(deviceId, pinNames, options.pinIds, unknownPin);
  const pins = new Map<string, ButtonPin>();
  pins.set(
    config.a,
    Object.freeze({
      name: config.a,
      terminal: 'a',
      globalPinId: pinIds.get(config.a) as number,
    }),
  );
  pins.set(
    config.b,
    Object.freeze({
      name: config.b,
      terminal: 'b',
      globalPinId: pinIds.get(config.b) as number,
    }),
  );
  const pinMemory =
    options.pinMemory === undefined
      ? createStandalonePinMemory(module, deviceId, pinNames.length)
      : options.pinMemory;
  const terminalA = pins.get(config.a) as ButtonPin;
  const terminalB = pins.get(config.b) as ButtonPin;

  const pressed = module.state(`${deviceId}_pressed`, 'bool', config.initialPressed);
  const closed = module.state(`${deviceId}_closed`, 'bool', config.initialPressed);
  const counter = module.state(`${deviceId}_counter`, 'u32', 0);
  const pressCount = module.state(`${deviceId}_press_count`, 'u32', 0);
  const holdTicks = module.state(`${deviceId}_hold_ticks`, 'u32', 0);
  const line = module.state(`${deviceId}_line`, 'bool', false);
  const reference = module.state(`${deviceId}_reference`, 'bool', false);

  const initialize = module.func(`${deviceId}_ir_initialize`, { params: [], results: [] });
  initialize.body((b) => {
    b.state.store(pressed, b.const('bool', config.initialPressed));
    b.state.store(closed, b.const('bool', config.initialPressed));
    b.state.store(counter, b.const('u32', 0));
    b.state.store(pressCount, b.const('u32', 0));
    b.state.store(holdTicks, b.const('u32', 0));
    b.state.store(line, b.const('bool', false));
    b.state.store(reference, b.const('bool', false));
    for (const pin of pins.values()) {
      const index = b.const('u32', pin.globalPinId);
      b.array.store(pinMemory.mode, index, b.const('u8', PIN_MODE.highZ));
      b.array.store(pinMemory.output, index, b.const('bool', false));
    }
    b.array.store(
      pinMemory.mode,
      b.const('u32', terminalA.globalPinId),
      b.const('u8', config.initialPressed ? PIN_MODE.pushPull : PIN_MODE.highZ),
    );
    b.array.store(
      pinMemory.output,
      b.const('u32', terminalA.globalPinId),
      b.const('bool', config.initialPressed && !config.activeLow),
    );
    b.return([]);
  });

  const tick = module.func(`${deviceId}_ir_tick`, { params: [], results: [] });
  tick.body((b) => {
    const one = b.const('u32', 1);
    const zero = b.const('u32', 0);
    const raw = b.state.load(pressed);
    const stable = b.state.load(closed);
    const currentCounter = b.state.load(counter);
    const currentPressCount = b.state.load(pressCount);
    const currentHoldTicks = b.state.load(holdTicks);

    const differed = b.bool.xor(raw, stable);
    const nextCounter = b.select(differed, b.int.add(currentCounter, one), zero);
    const reached = b.int.cmp('ge', nextCounter, b.const('u32', config.debounceTicks));
    const nextClosed = b.select(reached, raw, stable);
    const edge = b.bool.and(b.bool.and(differed, reached), raw);
    b.state.store(closed, nextClosed);
    b.state.store(counter, b.select(reached, zero, nextCounter));
    b.state.store(pressCount, b.select(edge, b.int.add(currentPressCount, one), currentPressCount));
    b.state.store(holdTicks, b.select(nextClosed, b.int.add(currentHoldTicks, one), zero));

    const index = b.const('u32', terminalA.globalPinId);
    b.array.store(
      pinMemory.mode,
      index,
      b.select(nextClosed, b.const('u8', PIN_MODE.pushPull), b.const('u8', PIN_MODE.highZ)),
    );
    b.array.store(
      pinMemory.output,
      index,
      b.select(nextClosed, b.const('bool', !config.activeLow), b.const('bool', false)),
    );
    b.return([]);
  });

  const update = module.func(`${deviceId}_ir_update`, { params: [], results: [] });
  update.body((b) => {
    b.state.store(line, b.array.load(pinMemory.input, b.const('u32', terminalA.globalPinId)));
    b.state.store(reference, b.array.load(pinMemory.input, b.const('u32', terminalB.globalPinId)));
    b.return([]);
  });

  const layout: ButtonLayout = Object.freeze({
    deviceId,
    type: BUTTON_IR_TYPE,
    config,
    pins,
    pinNames: Object.freeze(pinNames),
    pinMemory,
    states: Object.freeze({
      pressed,
      closed,
      counter,
      pressCount,
      holdTicks,
      line,
      reference,
    }),
    entries: Object.freeze({ initialize, tick, update }),
  });
  return Object.freeze({ layout, entries: layout.entries });
}

function unknownPin(deviceId: string, pinName: string): ButtonError {
  return new ButtonError(
    'unknown-pin',
    `Device "${deviceId}" declared button pin "${pinName}", which is not one of the configured terminals`,
    { deviceId, pinName },
  );
}

/* -------------------------------------------------------------------------
 * Public factories
 * ---------------------------------------------------------------------- */

/**
 * Creates the unified-IR button.
 *
 * ```ts
 * const button = createButtonIR('sw1', { debounceTicks: 2 });
 * const circuit = await Circuit.create({
 *   devices: [button.device],
 *   connections: [{ from: 'sw1.A', to: 'led1.anode' }],
 * });
 * circuit.devices.sw1.press();
 * circuit.step();
 * expect(circuit.devices.sw1.isClosed()).toBe(true);
 * ```
 */
export function createButtonIR(id: string, config: ButtonConfig = {}): ButtonIRDevice {
  assertDeviceId(id);
  const resolved = resolveButtonConfig(config);
  const module = createIRModule();
  const generated = generateButtonKernel({ module, deviceId: id, config: resolved });
  const validation = createModuleValidation(module);
  const holder: ButtonLayoutHolder = { layout: undefined };
  const description = createButtonIRDescription(id, resolved, holder);
  registerButtonLayout(id, generated.layout);
  const device: DeviceConfig = Object.freeze({
    id,
    type: BUTTON_IR_TYPE,
    description,
    config: resolved as unknown as Readonly<Record<string, unknown>>,
  });
  const irDevice: ButtonIRDevice = {
    id,
    type: BUTTON_IR_TYPE,
    config: resolved,
    module,
    layout: generated.layout,
    device,
    validation,
    buildAccessor(storage: StorageAccessor, options: ButtonAccessorOptions = {}): ButtonAccessor {
      return buildAccessor(id, storage, generated.layout, options);
    },
  };
  return Object.freeze(irDevice);
}

/**
 * Builds the device description used by `Circuit.create`.
 *
 * `A` is bidirectional so the device can both drive and observe the switched
 * net; `B` is a passive reference terminal.
 */
export function createButtonIRDescription(
  id: string,
  config: ButtonConfig = {},
  holder: ButtonLayoutHolder = { layout: undefined },
): DeviceDescription {
  assertDeviceId(id);
  const resolved = resolveButtonConfig(config);
  const description: DeviceDescription = {
    name: 'button',
    pins: Object.freeze({
      [resolved.a]: Object.freeze({ direction: 'bidirectional' as const }),
      [resolved.b]: Object.freeze({ direction: 'input' as const }),
    }),
    kernel: (context) => {
      const generated = generateButtonKernel({
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
        throw new ButtonError(
          'layout-not-found',
          `Button "${context.deviceId}" has no generated layout; compile the circuit before building its accessor`,
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
