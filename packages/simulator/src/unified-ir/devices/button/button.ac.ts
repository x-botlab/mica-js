/**
 * Typed accessor for the unified-IR button (U04).
 *
 * The accessor is the only surface that knows the IR storage layout. Callers
 * speak in button positions, press counts, hold time and terminal names; state
 * refs, pin ids and memory offsets stay private.
 *
 * ```ts
 * const button = createButtonIR('sw1', { debounceTicks: 2 });
 * const accessor = button.buildAccessor(jit.storage, { step: () => ... });
 * accessor.press();
 * accessor.step(2);
 * expect(accessor.isClosed()).toBe(true);
 * ```
 */
import type { StateRef } from '@mica-js/ir';
import type { DeviceAccessor } from '../../runtime/types';
import { PIN_MODE } from '../../pin-space';
import {
  loadBool,
  loadNumber,
  type SimpleDeviceAccessorOptions,
  type StorageAccessor,
} from '../common';
import { ButtonError } from './button.errors';
import type { ButtonLayout, ButtonPin } from './button';

/** Optional host services used by `step()` / `run()`. */
export type ButtonAccessorOptions = SimpleDeviceAccessorOptions;

/** Complete observable state of one button. */
export interface ButtonSnapshot {
  /** Host-asserted position. */
  readonly pressed: boolean;
  /** Debounced position that drives the switched terminal. */
  readonly closed: boolean;
  /** True while the raw input has not settled to the debounced position. */
  readonly bouncing: boolean;
  readonly pressCount: number;
  readonly holdTicks: number;
  /** Solved level on the switched terminal. */
  readonly line: boolean;
  /** Solved level on the reference terminal. */
  readonly reference: boolean;
  /** Level the device currently drives onto the switched terminal. */
  readonly driven: boolean;
  /** True while the switched terminal is high-Z. */
  readonly highZ: boolean;
}

/**
 * High-level button surface. Extends the generic `DeviceAccessor`, so code
 * written against `readPin`/`getState` keeps working.
 */
export interface ButtonAccessor extends DeviceAccessor {
  /** Name of the boolean raw-position state (`'pressed'`). */
  readonly pressedState: 'pressed';
  readonly terminalA: string;
  readonly terminalB: string;
  readonly activeLow: boolean;
  readonly debounceTicks: number;
  /** Host-asserted position (raw input). */
  isPressed(): boolean;
  /** Debounced position that drives the switched terminal. */
  isClosed(): boolean;
  /** True while the raw input differs from the debounced position. */
  isBouncing(): boolean;
  /** Asserts the button (equivalent to a pointer/touch down). */
  press(): void;
  /** Releases the button (equivalent to a pointer/touch up). */
  release(): void;
  /** Flips the host-asserted position. */
  toggle(): void;
  /** Sets the raw position. */
  setPressed(value: boolean): void;
  /** Completed press edges since creation/reset. */
  getPressCount(): number;
  /** Clears the press counter. */
  resetPressCount(): void;
  /** Consecutive ticks the debounced contact stayed closed. */
  getHoldTicks(): number;
  /** Solved level on the switched terminal after the last update. */
  getLineLevel(): boolean;
  /** Solved level on the reference terminal after the last update. */
  getReferenceLevel(): boolean;
  /** Solved level on one terminal. */
  readPinInput(pinName: string): boolean;
  /** Alias of {@link readPinInput}. */
  samplePin(pinName: string): boolean;
  /** Advances the owning circuit (or the standalone module) by `count` ticks. */
  step(count?: number): void;
  /** Alias of {@link step}. */
  run(count: number): void;
  snapshot(): ButtonSnapshot;
}

/** Layout registry used by the three-argument `buildAccessor` form. */
const layouts = new Map<string, ButtonLayout>();

/** Registers the layout of one generated button; used by `createButtonIR`. */
export function registerButtonLayout(deviceId: string, layout: ButtonLayout): void {
  layouts.set(deviceId, layout);
}

/** Drops one registered layout (or every layout when called without an id). */
export function unregisterButtonLayout(deviceId?: string): void {
  if (deviceId === undefined) {
    layouts.clear();
    return;
  }
  layouts.delete(deviceId);
}

/**
 * Builds the typed accessor of one button.
 *
 * @param deviceId Circuit-unique device id.
 * @param storage Live engine storage.
 * @param layout Layout produced by the IR factory. When omitted, the layout
 *   registered for `deviceId` is used.
 */
export function buildAccessor(
  deviceId: string,
  storage: StorageAccessor,
  layout?: ButtonLayout,
  options: ButtonAccessorOptions = {},
): ButtonAccessor {
  const resolved = layout ?? layouts.get(deviceId);
  if (resolved === undefined) {
    throw new ButtonError(
      'layout-not-found',
      `Button "${deviceId}" has no registered IR layout; pass the layout or call registerButtonLayout first`,
      { deviceId },
    );
  }
  const target = resolved;
  const active = (): void => options.assertActive?.();

  const requirePin = (pinName: string): ButtonPin => {
    const pin = target.pins.get(pinName);
    if (pin === undefined) {
      throw new ButtonError(
        'unknown-pin',
        `Button "${deviceId}" has no pin "${pinName}". Pins: [${target.pinNames.join(', ')}]`,
        { deviceId, pinName },
      );
    }
    return pin;
  };

  const sample = (pin: ButtonPin): boolean =>
    storage.loadArray(target.pinMemory.input, pin.globalPinId) === true;

  const terminalA = requirePin(target.config.a);

  const storeBool = (ref: StateRef<'bool'>, value: boolean): void => {
    storage.storeState(ref, value);
  };
  const storeU32 = (ref: StateRef<'u32'>, value: number): void => {
    storage.storeState(ref, value >>> 0);
  };

  const setPressed = (value: boolean): void => {
    active();
    if (typeof value !== 'boolean') {
      throw new ButtonError(
        'invalid-value',
        `Button "${deviceId}" pressed state needs a boolean, received ${typeof value}`,
        { deviceId },
      );
    }
    storeBool(target.states.pressed, value);
  };

  const accessor: ButtonAccessor = {
    deviceId,
    type: target.type,
    pinNames: Object.freeze([...target.pinNames]),
    stateNames: Object.freeze([
      'pressed',
      'closed',
      'counter',
      'pressCount',
      'holdTicks',
      'line',
      'reference',
    ]),
    pressedState: 'pressed',
    terminalA: target.config.a,
    terminalB: target.config.b,
    activeLow: target.config.activeLow,
    debounceTicks: target.config.debounceTicks,

    isPressed(): boolean {
      active();
      return loadBool(storage, target.states.pressed);
    },

    isClosed(): boolean {
      active();
      return loadBool(storage, target.states.closed);
    },

    isBouncing(): boolean {
      active();
      return loadBool(storage, target.states.pressed) !== loadBool(storage, target.states.closed);
    },

    press(): void {
      setPressed(true);
    },

    release(): void {
      setPressed(false);
    },

    toggle(): void {
      setPressed(!loadBool(storage, target.states.pressed));
    },

    setPressed,

    getPressCount(): number {
      active();
      return loadNumber(storage, target.states.pressCount);
    },

    resetPressCount(): void {
      active();
      storeU32(target.states.pressCount, 0);
    },

    getHoldTicks(): number {
      active();
      return loadNumber(storage, target.states.holdTicks);
    },

    getLineLevel(): boolean {
      active();
      return loadBool(storage, target.states.line);
    },

    getReferenceLevel(): boolean {
      active();
      return loadBool(storage, target.states.reference);
    },

    readPinInput(pinName: string): boolean {
      active();
      return sample(requirePin(pinName));
    },

    samplePin(pinName: string): boolean {
      return accessor.readPinInput(pinName);
    },

    readPin(pinName: string): boolean {
      active();
      const pin = requirePin(pinName);
      return storage.loadArray(target.pinMemory.output, pin.globalPinId) === true;
    },

    writePin(pinName: string, value: boolean): void {
      active();
      requirePin(pinName);
      void value;
      throw new ButtonError(
        'pin-not-writable',
        `Button "${deviceId}" pin "${pinName}" is driven by the device; call press()/release() instead`,
        { deviceId, pinName },
      );
    },

    getState(name: string): unknown {
      active();
      switch (name) {
        case 'pressed':
          return loadBool(storage, target.states.pressed);
        case 'closed':
          return loadBool(storage, target.states.closed);
        case 'counter':
          return loadNumber(storage, target.states.counter);
        case 'pressCount':
          return loadNumber(storage, target.states.pressCount);
        case 'holdTicks':
          return loadNumber(storage, target.states.holdTicks);
        case 'line':
          return loadBool(storage, target.states.line);
        case 'reference':
          return loadBool(storage, target.states.reference);
        default:
          throw unknownState(deviceId, name);
      }
    },

    setState(name: string, value: unknown): void {
      active();
      switch (name) {
        case 'pressed':
          if (typeof value !== 'boolean') {
            throw invalidStateValue(deviceId, name, 'a boolean', value);
          }
          storeBool(target.states.pressed, value);
          return;
        case 'closed':
          if (typeof value !== 'boolean') {
            throw invalidStateValue(deviceId, name, 'a boolean', value);
          }
          storeBool(target.states.closed, value);
          return;
        case 'counter':
          storeU32(target.states.counter, requireU32(deviceId, name, value));
          return;
        case 'pressCount':
          storeU32(target.states.pressCount, requireU32(deviceId, name, value));
          return;
        case 'holdTicks':
          storeU32(target.states.holdTicks, requireU32(deviceId, name, value));
          return;
        case 'line':
          if (typeof value !== 'boolean') {
            throw invalidStateValue(deviceId, name, 'a boolean', value);
          }
          storeBool(target.states.line, value);
          return;
        case 'reference':
          if (typeof value !== 'boolean') {
            throw invalidStateValue(deviceId, name, 'a boolean', value);
          }
          storeBool(target.states.reference, value);
          return;
        default:
          throw unknownState(deviceId, name);
      }
    },

    step(count = 1): void {
      active();
      if (!Number.isInteger(count) || count < 0) {
        throw new ButtonError(
          'invalid-value',
          `step(count) needs a non-negative integer, received ${String(count)}`,
          { deviceId },
        );
      }
      if (count === 0) return;
      if (count > 1 && options.runBatch !== undefined) {
        options.runBatch(count);
        return;
      }
      if (options.step === undefined) {
        throw new ButtonError(
          'no-runner',
          `Button "${deviceId}" was built without a runner; pass step/runBatch to buildAccessor`,
          { deviceId },
        );
      }
      for (let index = 0; index < count; index += 1) options.step();
    },

    run(count: number): void {
      accessor.step(count);
    },

    snapshot(): ButtonSnapshot {
      active();
      const pressed = loadBool(storage, target.states.pressed);
      const closed = loadBool(storage, target.states.closed);
      const mode = storage.loadArray(target.pinMemory.mode, terminalA.globalPinId);
      const driven = storage.loadArray(target.pinMemory.output, terminalA.globalPinId) === true;
      return Object.freeze({
        pressed,
        closed,
        bouncing: pressed !== closed,
        pressCount: loadNumber(storage, target.states.pressCount),
        holdTicks: loadNumber(storage, target.states.holdTicks),
        line: loadBool(storage, target.states.line),
        reference: loadBool(storage, target.states.reference),
        driven,
        highZ: Number(mode) === PIN_MODE.highZ,
      });
    },
  };
  return Object.freeze(accessor);
}

function unknownState(deviceId: string, name: string): ButtonError {
  return new ButtonError(
    'unknown-state',
    `Button "${deviceId}" has no state "${name}". States: [pressed, closed, counter, pressCount, holdTicks, line, reference]`,
    { deviceId, stateName: name },
  );
}

function invalidStateValue(
  deviceId: string,
  name: string,
  expected: string,
  value: unknown,
): ButtonError {
  return new ButtonError(
    'invalid-value',
    `Button "${deviceId}" state "${name}" needs ${expected}, received ${String(value)}`,
    { deviceId, stateName: name },
  );
}

function requireU32(deviceId: string, name: string, value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0xffff_ffff) {
    throw new ButtonError(
      'invalid-value',
      `Button "${deviceId}" state "${name}" needs a u32 integer, received ${String(value)}`,
      { deviceId, stateName: name },
    );
  }
  return value as number;
}
