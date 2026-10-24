/**
 * Type surface of the unified-IR LED (U04).
 *
 * The implementation lives in `led.ts` (IR factory) and `led.ac.ts`
 * (accessor). This declaration file is the stable import target for consumers
 * that only need the types.
 */
export type { StorageAccessor, SimpleDeviceAccessorOptions } from '../common';

export type { LedAccessor, LedAccessorOptions, LedSnapshot } from './led.ac';

export type {
  LedColor,
  LedConfig,
  LedErrorCode,
  LedErrorOptions,
  LedIRDevice,
  LedLayout,
  LedLayoutHolder,
  LedPin,
  LedPinMemory,
  LedTerminal,
  ResolvedLedConfig,
} from './led';
