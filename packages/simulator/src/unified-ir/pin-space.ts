/**
 * Shared memory-layout constants of the unified IR compiler and devices.
 *
 * Every device of a circuit shares one global pin address space, so the
 * compiler and every device kernel must agree on the capacity, the per-device
 * stride and the meaning of a `pin_mode` slot. The values are part of the
 * generated module's memory layout and must stay stable across releases.
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
