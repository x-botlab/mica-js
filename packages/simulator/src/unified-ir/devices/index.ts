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
 *
 * The same symbols are also exported flat so the package entry point can
 * forward them without a namespace:
 *
 * ```ts
 * import { createButtonIR, createLedIR } from '@mica-js/simulator';
 * ```
 */
export * as button from './button';
export * as led from './led';

export { BUTTON_IR_TYPE, ButtonError, createButtonIR, resolveButtonConfig } from './button';
export type {
  ButtonAccessor,
  ButtonAccessorOptions,
  ButtonConfig,
  ButtonErrorCode,
  ButtonErrorOptions,
  ButtonIRDevice,
  ButtonSnapshot,
  ButtonTerminal,
  ResolvedButtonConfig,
} from './button';

export { LED_COLORS, LED_IR_TYPE, LedError, createLedIR, resolveLedConfig } from './led';
export type {
  LedAccessor,
  LedAccessorOptions,
  LedColor,
  LedConfig,
  LedErrorCode,
  LedErrorOptions,
  LedIRDevice,
  LedSnapshot,
  LedTerminal,
  ResolvedLedConfig,
} from './led';

export { buildAccessor as buildButtonAccessor } from './button';
export { buildAccessor as buildLedAccessor } from './led';
export type { SimpleDeviceAccessorOptions, SimpleDevicePin, SimplePinMemory } from './common';
export type { StorageAccessor } from './common';
