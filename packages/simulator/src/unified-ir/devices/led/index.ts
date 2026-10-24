export { LedError } from './led.errors';
export type { LedErrorCode, LedErrorOptions } from './led.errors';
export {
  createLedIR,
  createLedIRDescription,
  LED_COLORS,
  LED_IR_TYPE,
  resolveLedConfig,
} from './led';
export type {
  LedColor,
  LedConfig,
  LedIRDevice,
  LedLayout,
  LedLayoutHolder,
  LedPin,
  LedPinMemory,
  LedTerminal,
  ResolvedLedConfig,
} from './led';
export { buildAccessor, registerLedLayout, unregisterLedLayout } from './led.ac';
export type { LedAccessor, LedAccessorOptions, LedSnapshot } from './led.ac';
export type { SimpleDeviceAccessorOptions, StorageAccessor } from '../common';
