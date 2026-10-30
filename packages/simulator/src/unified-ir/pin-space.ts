/**
 * Shared memory-layout constants of the unified IR compiler and devices.
 *
 * Every device of a circuit shares one global pin address space, so the
 * compiler and every device kernel must agree on the capacity, the per-device
 * stride and the meaning of a `pin_mode` slot. Capacity and stride are limits
 * checked at allocation time; the shared pin memories are sized to the pins a
 * circuit actually declares, so a larger ceiling costs no runtime memory.
 */

/** Global pin addresses available to one circuit (8 devices x 512 pins). */
export const UNIFIED_PIN_CAPACITY = 4096;

/** Global pin addresses one device may own; enough for the largest packages. */
export const DEVICE_PIN_STRIDE = 512;

/** Values stored in the global `pin_mode` array. */
export const PIN_MODE = Object.freeze({
  highZ: 0,
  pushPull: 1,
  openDrain: 2,
  analog: 3,
} as const);

/** One value of the global `pin_mode` array. */
export type PinMode = (typeof PIN_MODE)[keyof typeof PIN_MODE];
