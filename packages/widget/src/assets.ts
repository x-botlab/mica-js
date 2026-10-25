import {
  isAssetError,
  resolveAsset,
  type AssetError,
  type AssetResolverOptions,
} from '@mica-js/core/assets';
import type { WidgetAssetProvider } from './host/types';

/**
 * Node-only asset helpers for hosts that serve `file` references from a project directory
 * (RFC 0009 §3).
 *
 * Kept out of the package root so browser bundles that import `@mica-js/widget` never pull in
 * `node:fs`; import it from `@mica-js/widget/assets` instead.
 */
export class WidgetAssetError extends Error {
  readonly code: AssetError['code'];
  readonly src: string;

  constructor(error: AssetError) {
    super(`${error.code}: ${error.message}`);
    this.name = 'WidgetAssetError';
    this.code = error.code;
    this.src = error.src;
  }
}

export type AssetReadOptions = Omit<AssetResolverOptions, 'rootDir'>;

/**
 * Reads one project-relative asset.
 *
 * @throws {WidgetAssetError} carrying the stable `asset/*` code, e.g. `asset/out-of-root`.
 */
export async function readBinary(
  src: string,
  rootDir: string,
  options: AssetReadOptions = {},
): Promise<Uint8Array> {
  const result = await resolveAsset(src, { rootDir, ...options });
  if (isAssetError(result)) {
    throw new WidgetAssetError(result);
  }
  return result;
}

/**
 * Creates a {@link WidgetAssetProvider} for `file` references under `rootDir`.
 *
 * `inline` and `store` references need host-specific handling (base64 decoding or a resource
 * library), so this provider rejects them instead of guessing.
 */
export function createFileWidgetAssetProvider(options: AssetResolverOptions): WidgetAssetProvider {
  return {
    async resolve(ref) {
      if (ref.mode !== 'file') {
        throw new Error(
          `Widget asset "${ref.src}" uses mode "${ref.mode}"; the project file provider only resolves "file" references`,
        );
      }
      return readBinary(ref.src, options.rootDir, options);
    },
  };
}
