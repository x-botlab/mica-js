/**
 * Host-side asset helper.
 *
 * This module is intentionally not imported by `worker-entry.ts`: the guest runtime is bundled
 * into the sandbox and must stay free of Node built-ins. Public consumers should import the
 * `@mica-js/widget/assets` subpath, which exposes the same helpers.
 */
export {
  createFileWidgetAssetProvider,
  readBinary,
  WidgetAssetError,
  type AssetReadOptions,
} from '../assets';
