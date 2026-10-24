/**
 * Typed accessor for the unified-IR LED (U04).
 *
 * The accessor is the only surface that knows the IR storage layout. Callers
 * speak in lamp state, intensity, colour and terminal names; state refs, pin
 * ids and memory offsets stay private.
 *
 * ```ts
 * const led = createLedIR('led1');
 * const accessor = led.buildAccessor(jit.storage, { update: () => ... });
 * accessor.setBrightness(128);
 * accessor.refresh();
 * expect(accessor.getBrightness()).toBe(0);  // still dark: the anode is low
 * ```
 */
import type { StateRef } from '@mica-js/ir';
import type { DeviceAccessor } from '../../runtime/types';
import {
  loadBool,
  loadNumber,
  type SimpleDeviceAccessorOptions,
  type StorageAccessor,
} from '../common';
import { LedError } from './led.errors';
import type { LedColor, LedLayout, LedPin } from './led';

/** Optional host services used by `step()` / `run()` / `refresh()`. */
export interface LedAccessorOptions extends SimpleDeviceAccessorOptions {
  /** Runs the LED's own update phase; used by standalone modules. */
  readonly update?: () => void;
}

/** Complete observable state of one LED. */
export interface LedSnapshot {
  readonly lamp: boolean;
  readonly level: number;
  readonly brightness: number;
  readonly anode: boolean;
  readonly cathode: boolean;
  readonly forwardBiased: boolean;
}

/**
 * High-level LED surface. Extends the generic `DeviceAccessor`, so code written
 * against `readPin`/`getState` keeps working.
 */
export interface LedAccessor extends DeviceAccessor {
  /** Name of the boolean lamp state (`'lamp'`). */
  readonly lampState: 'lamp';
  readonly color: LedColor;
  readonly forwardVoltage: number;
  readonly activeLow: boolean;
  readonly maxBrightness: number;
  readonly anodePin: string;
  readonly cathodePin: string;
  /** True while forward biased and the intensity cap is non-zero. */
  isOn(): boolean;
  /** True when the terminals are forward biased, regardless of intensity. */
  isForwardBiased(): boolean;
  /** Derived intensity, 0–`maxBrightness`; `0` while dark. */
  getBrightness(): number;
  /** Host-set intensity cap, 0–`maxBrightness`. */
  getLevel(): number;
  /** Sets the intensity cap; also refreshes the derived lamp/intensity. */
  setBrightness(value: number): void;
  /** Solved level on the anode. */
  readAnode(): boolean;
  /** Solved level on the cathode. */
  readCathode(): boolean;
  /** Solved level on one terminal. */
  readPinInput(pinName: string): boolean;
  /** Alias of {@link readPinInput}. */
  samplePin(pinName: string): boolean;
  /** Recomputes the derived state by running the device update phase. */
  refresh(): void;
  /** Advances the owning circuit (or the standalone module) by `count` ticks. */
  step(count?: number): void;
  /** Alias of {@link step}. */
  run(count: number): void;
  snapshot(): LedSnapshot;
}

/** Layout registry used by the three-argument `buildAccessor` form. */
const layouts = new Map<string, LedLayout>();

/** Registers the layout of one generated LED; used by `createLedIR`. */
export function registerLedLayout(deviceId: string, layout: LedLayout): void {
  layouts.set(deviceId, layout);
}

/** Drops one registered layout (or every layout when called without an id). */
export function unregisterLedLayout(deviceId?: string): void {
  if (deviceId === undefined) {
    layouts.clear();
    return;
  }
  layouts.delete(deviceId);
}

/**
 * Builds the typed accessor of one LED.
 *
 * @param deviceId Circuit-unique device id.
 * @param storage Live engine storage.
 * @param layout Layout produced by the IR factory. When omitted, the layout
 *   registered for `deviceId` is used.
 */
export function buildAccessor(
  deviceId: string,
  storage: StorageAccessor,
  layout?: LedLayout,
  options: LedAccessorOptions = {},
): LedAccessor {
  const resolved = layout ?? layouts.get(deviceId);
  if (resolved === undefined) {
    throw new LedError(
      'layout-not-found',
      `LED "${deviceId}" has no registered IR layout; pass the layout or call registerLedLayout first`,
      { deviceId },
    );
  }
  const target = resolved;
  const active = (): void => options.assertActive?.();

  const requirePin = (pinName: string): LedPin => {
    const pin = target.pins.get(pinName);
    if (pin === undefined) {
      throw new LedError(
        'unknown-pin',
        `LED "${deviceId}" has no pin "${pinName}". Pins: [${target.pinNames.join(', ')}]`,
        { deviceId, pinName },
      );
    }
    return pin;
  };

  const sample = (pin: LedPin): boolean =>
    storage.loadArray(target.pinMemory.input, pin.globalPinId) === true;

  const anodePin = requirePin(target.config.anode);
  const cathodePin = requirePin(target.config.cathode);

  const forwardBiased = (): boolean => {
    const anode = sample(anodePin);
    const cathode = sample(cathodePin);
    return target.config.activeLow ? !anode && cathode : anode && !cathode;
  };

  const storeU8 = (ref: StateRef<'u8'>, value: number): void => {
    storage.storeState(ref, value & 0xff);
  };

  const accessor: LedAccessor = {
    deviceId,
    type: target.type,
    pinNames: Object.freeze([...target.pinNames]),
    stateNames: Object.freeze(['lamp', 'level', 'brightness']),
    lampState: 'lamp',
    color: target.config.color,
    forwardVoltage: target.config.forwardVoltage,
    activeLow: target.config.activeLow,
    maxBrightness: target.config.maxBrightness,
    anodePin: target.config.anode,
    cathodePin: target.config.cathode,

    isOn(): boolean {
      active();
      return loadBool(storage, target.states.lamp);
    },

    isForwardBiased(): boolean {
      active();
      return forwardBiased();
    },

    getBrightness(): number {
      active();
      return loadNumber(storage, target.states.brightness);
    },

    getLevel(): number {
      active();
      return loadNumber(storage, target.states.level);
    },

    setBrightness(value: number): void {
      active();
      if (!Number.isInteger(value) || value < 0 || value > target.config.maxBrightness) {
        throw new LedError(
          'invalid-value',
          `LED "${deviceId}" brightness must be an integer in [0, ${target.config.maxBrightness}], received ${String(value)}`,
          { deviceId },
        );
      }
      storeU8(target.states.level, value);
      // Keep the derived states consistent right away, as if the electrical
      // inputs had not changed since the last update phase.
      const lit = forwardBiased() && value > 0;
      storage.storeState(target.states.lamp, lit);
      storeU8(target.states.brightness, lit ? value : 0);
    },

    readAnode(): boolean {
      active();
      return sample(anodePin);
    },

    readCathode(): boolean {
      active();
      return sample(cathodePin);
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
      throw new LedError(
        'pin-not-writable',
        `LED "${deviceId}" pin "${pinName}" is a load terminal; drive its net instead`,
        { deviceId, pinName },
      );
    },

    getState(name: string): unknown {
      active();
      switch (name) {
        case 'lamp':
          return loadBool(storage, target.states.lamp);
        case 'level':
          return loadNumber(storage, target.states.level);
        case 'brightness':
          return loadNumber(storage, target.states.brightness);
        default:
          throw unknownState(deviceId, name);
      }
    },

    setState(name: string, value: unknown): void {
      active();
      switch (name) {
        case 'lamp':
          if (typeof value !== 'boolean') {
            throw new LedError(
              'invalid-value',
              `LED "${deviceId}" state "lamp" needs a boolean, received ${typeof value}`,
              { deviceId, stateName: name },
            );
          }
          storage.storeState(target.states.lamp, value);
          return;
        case 'level':
          if (typeof value !== 'number') {
            throw new LedError(
              'invalid-value',
              `LED "${deviceId}" state "level" needs a number, received ${typeof value}`,
              { deviceId, stateName: name },
            );
          }
          accessor.setBrightness(value);
          return;
        case 'brightness':
          if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 255) {
            throw new LedError(
              'invalid-value',
              `LED "${deviceId}" state "brightness" needs an integer in [0, 255], received ${String(value)}`,
              { deviceId, stateName: name },
            );
          }
          storeU8(target.states.brightness, value as number);
          return;
        default:
          throw unknownState(deviceId, name);
      }
    },

    refresh(): void {
      active();
      if (options.update !== undefined) {
        options.update();
        return;
      }
      if (options.step !== undefined) {
        options.step();
        return;
      }
      throw new LedError(
        'no-runner',
        `LED "${deviceId}" was built without a runner; pass update or step to buildAccessor`,
        { deviceId },
      );
    },

    step(count = 1): void {
      active();
      if (!Number.isInteger(count) || count < 0) {
        throw new LedError(
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
        throw new LedError(
          'no-runner',
          `LED "${deviceId}" was built without a runner; pass step/runBatch to buildAccessor`,
          { deviceId },
        );
      }
      for (let index = 0; index < count; index += 1) options.step();
    },

    run(count: number): void {
      accessor.step(count);
    },

    snapshot(): LedSnapshot {
      active();
      const anode = sample(anodePin);
      const cathode = sample(cathodePin);
      const lamp = loadBool(storage, target.states.lamp);
      return Object.freeze({
        lamp,
        level: loadNumber(storage, target.states.level),
        brightness: loadNumber(storage, target.states.brightness),
        anode,
        cathode,
        forwardBiased: target.config.activeLow ? !anode && cathode : anode && !cathode,
      });
    },
  };
  return Object.freeze(accessor);
}

function unknownState(deviceId: string, name: string): LedError {
  return new LedError(
    'unknown-state',
    `LED "${deviceId}" has no state "${name}". States: [lamp, level, brightness]`,
    { deviceId, stateName: name },
  );
}
