/**
 * Type surface of the unified-IR teaching MCU (U03).
 *
 * The implementation lives in `teaching-mcu.ts` (IR factory) and
 * `teaching-mcu.ac.ts` (accessor). This declaration file is the stable
 * import target for consumers that only need the types:
 *
 * ```ts
 * import type { TeachingMCUAccessor } from '@mica-js/simulator';
 * ```
 */
export type {
  StorageAccessor,
  TeachingMCUAccessor,
  TeachingMCUAccessorOptions,
  TeachingMCUFlags,
  TeachingMCUGpioState,
  TeachingMCUNvicSnapshot,
  TeachingMCUSnapshot,
} from './teaching-mcu.ac';

export type {
  IRDevice,
  ResolvedTeachingMCUConfig,
  TeachingMCUConfig,
  TeachingMCUCircuitInput,
  TeachingMCUInterruptConfig,
  TeachingMCUISAType,
  TeachingMCULayout,
  TeachingMCUPin,
  TeachingMCUPinMemory,
  TeachingMCUErrorCode,
  TeachingMCUErrorOptions,
} from './teaching-mcu';
