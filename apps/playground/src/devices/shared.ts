import type { DevicePinDescription, DevicePinDirection } from '@mica-js/simulator';

/** 3.3 V logic rail the playground peripherals declare as their supply domain. */
export const LOGIC_VOLTAGE = 3.3;

/**
 * Pins of one direction, keyed in declaration order.
 *
 * Declaration order is what the schematic compiler uses to lay a synthesized
 * symbol out, so every device lists its pins in the order a reader expects.
 */
export function pinMap(
  names: readonly string[],
  direction: DevicePinDirection,
  kind = 'signal',
): Readonly<Record<string, DevicePinDescription>> {
  return Object.freeze(
    Object.fromEntries(names.map((name) => [name, Object.freeze({ direction, kind })] as const)),
  );
}

/**
 * `pins` block of the device-package description.
 *
 * `@mica-js/device` stores the drawing side of every pin there; the unified-IR
 * description does not need it. Keeping both in one module means a generated
 * schematic symbol and the IR behaviour can never drift apart.
 */
export function packagePins(
  names: readonly string[],
  side: 'left' | 'right' | 'top' | 'bottom',
): Readonly<Record<string, { readonly kind: 'signal'; readonly side: string }>> {
  return Object.fromEntries(names.map((name) => [name, { kind: 'signal', side }] as const));
}
