/**
 * Type surface of the unified-IR button (U04).
 *
 * The implementation lives in `button.ts` (IR factory) and `button.ac.ts`
 * (accessor). This declaration file is the stable import target for consumers
 * that only need the types.
 */
export type { StorageAccessor, SimpleDeviceAccessorOptions } from '../common';

export type { ButtonAccessor, ButtonAccessorOptions, ButtonSnapshot } from './button.ac';

export type {
  ButtonConfig,
  ButtonErrorCode,
  ButtonErrorOptions,
  ButtonIRDevice,
  ButtonLayout,
  ButtonLayoutHolder,
  ButtonPin,
  ButtonPinMemory,
  ButtonTerminal,
  ResolvedButtonConfig,
} from './button';
