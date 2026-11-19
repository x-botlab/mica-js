import * as mcuPackage from '../../../devices/dist/iap15f2k61s2/model.js';

export type {
  McuAdapter,
  McuContext,
  McuSerialChunk,
  McuSerialStatus,
} from '../../../devices/dist/iap15f2k61s2/model.js';

/**
 * Typed bridge to the standalone IAP15F2K61S2 build artifact. The fused build bundles
 * this module; the declaration in `mcu-package.d.ts` owns the external factory contract.
 */
export function createMcu(
  context: import('../../../devices/dist/iap15f2k61s2/model.js').McuContext,
) {
  if (typeof mcuPackage.create !== 'function')
    throw new Error('IAP15F2K61S2 package has no create export');
  return mcuPackage.create(context);
}
