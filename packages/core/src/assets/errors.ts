/**
 * Stable error codes for project resource references (RFC 0009 §3, "图片与二进制").
 *
 * The codes are the host-facing contract: a consumer can switch on `code` and ignore the English
 * `message`, which is meant for logs and diagnostics only.
 */
export const ASSET_ERROR_CODES = {
  'asset/missing': 'The referenced asset file does not exist',
  'asset/out-of-root': 'The asset path escapes the project root directory',
  'asset/too-large': 'The asset file exceeds the size limit',
  'asset/undecodable': 'The asset file cannot be decoded',
} as const;

export type AssetErrorCode = keyof typeof ASSET_ERROR_CODES;

/** A resource reference that could not be resolved to bytes. */
export interface AssetError {
  readonly code: AssetErrorCode;
  readonly message: string;
  /** The `src` of the rejected reference, retained verbatim for host diagnostics. */
  readonly src: string;
  readonly details?: unknown;
}

/** Builds an {@link AssetError}; `details` stays absent instead of becoming `undefined`. */
export function createAssetError(
  code: AssetErrorCode,
  message: string,
  src: string,
  details?: unknown,
): AssetError {
  return details === undefined ? { code, message, src } : { code, message, src, details };
}

/**
 * Narrows a resolution result to {@link AssetError}.
 *
 * Any `asset/*` code is accepted, so a host can forward an error produced by a newer resolver
 * without losing the discriminant.
 */
export function isAssetError(value: unknown): value is AssetError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const code = (value as { readonly code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('asset/');
}
