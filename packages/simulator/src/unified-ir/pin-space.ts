/**
 * Shared memory-layout constants of the unified IR compiler and devices.
 *
 * Every device of a circuit shares one global pin address space, so the
 * compiler and every device kernel must agree on the capacity, the per-device
 * stride and the meaning of a `pin_mode` / `pin_pull` slot. The values are part
 * of the generated module's memory layout and must stay stable across releases.
 */

/** Global pin addresses available to one circuit (8 devices x 32 pins). */
export const UNIFIED_PIN_CAPACITY = 256;

/** Global pin addresses reserved per device (one 32-pin port). */
export const DEVICE_PIN_STRIDE = 32;

/** Values stored in the global `pin_mode` array. */
export const PIN_MODE = Object.freeze({
  highZ: 0,
  pushPull: 1,
  openDrain: 2,
  analog: 3,
} as const);

/** One value of the global `pin_mode` array. */
export type PinMode = (typeof PIN_MODE)[keyof typeof PIN_MODE];

/**
 * Values stored in the global `pin_pull` array.
 *
 * A weak pull is an internal bias of the pin, independent of its drive mode,
 * its output latch and its digital intent: it only decides what a net reads
 * when no pin actually drives it (RFC 0002).
 */
export const PIN_PULL = Object.freeze({
  none: 0,
  up: 1,
  down: 2,
} as const);

/** One value of the global `pin_pull` array. */
export type PinPull = (typeof PIN_PULL)[keyof typeof PIN_PULL];

/**
 * Values stored in the global `electrical_fault` array (RFC 0002 §4.4).
 *
 * The array holds one `u8`: `none` while the electrical model is consistent,
 * `conflict` once two strong drivers of one node disagree by more than the
 * solver tolerance. A latched conflict pauses the main loop until the host
 * clears the slot or resets the circuit.
 */
export const ELECTRICAL_FAULT = Object.freeze({
  none: 0,
  conflict: 1,
} as const);

/** One value of the global `electrical_fault` array. */
export type ElectricalFault = (typeof ELECTRICAL_FAULT)[keyof typeof ELECTRICAL_FAULT];

/** Authored names of the digital drive modes (`pin.configure`). */
export type PinModeName = 'high-z' | 'push-pull' | 'open-drain' | 'analog';

/** Authored names of the weak biases (`pin.pull`). */
export type PinPullName = 'none' | 'up' | 'down';

/** Maps an authored drive-mode name to its `pin_mode` value. */
export const PIN_MODE_BY_NAME: Readonly<Record<PinModeName, PinMode>> = Object.freeze({
  'high-z': PIN_MODE.highZ,
  'push-pull': PIN_MODE.pushPull,
  'open-drain': PIN_MODE.openDrain,
  analog: PIN_MODE.analog,
});

/** Maps an authored pull name to its `pin_pull` value. */
export const PIN_PULL_BY_NAME: Readonly<Record<PinPullName, PinPull>> = Object.freeze({
  none: PIN_PULL.none,
  up: PIN_PULL.up,
  down: PIN_PULL.down,
});
