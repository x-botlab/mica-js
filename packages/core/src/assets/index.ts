/**
 * Node-only entry for project resource references (RFC 0009 §3).
 *
 * It is intentionally not re-exported from `@mica-js/core`: browser consumers must not pull
 * `node:fs` into their bundles just by importing the simulator core.
 */
export {
  ASSET_ERROR_CODES,
  createAssetError,
  isAssetError,
  type AssetError,
  type AssetErrorCode,
} from './errors';
export {
  DEFAULT_ASSET_MAX_SIZE,
  resolveAsset,
  type AssetDecoder,
  type AssetResolverOptions,
} from './resolver';
export { parseSchematicWithAssets, validateSchematicAssets } from './schematic';
