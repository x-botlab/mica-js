/**
 * Simple unified-IR devices (U04).
 *
 * `led` and `button` are the first production-shaped devices built on the
 * unified-IR contract: an IR factory that returns `{ module, layout, device }`,
 * an accessor builder (`*.ac.ts`) and a declaration file (`*.d.ts`).
 *
 * ```ts
 * import { button, led } from '@mica-js/simulator/unified-ir/devices';
 *
 * const sw = button.createButtonIR('sw1');
 * const lamp = led.createLedIR('led1');
 * ```
 */
export * as button from './button';
export * as led from './led';

export { buildAccessor as buildButtonAccessor } from './button';
export { buildAccessor as buildLedAccessor } from './led';
export type { SimpleDeviceAccessorOptions, SimpleDevicePin, SimplePinMemory } from './common';
export type { StorageAccessor } from './common';
