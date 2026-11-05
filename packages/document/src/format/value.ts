/** 2D point shared by the `.sch` and `.cnv` contracts. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Where an image / binary property value lives (#7). */
export type AssetMode = 'file' | 'inline' | 'store';

/**
 * Reference to a project asset instead of inline bytes (#7): `file` is a project-root relative
 * POSIX path, `inline` is base64 text and `store` is a host resource identifier.
 */
export interface AssetReference {
  readonly src: string;
  readonly mode: AssetMode;
}

/**
 * Instance property value stored in `symbol.properties` (see #6 / #7): a scalar, a resource
 * reference for `image` / `binary` properties, or `null` for an explicitly cleared nullable one.
 */
export type PropertyValue = string | number | boolean | AssetReference | null;

/** Where an image / binary property value lives (#7). */
export const ASSET_MODES = ['file', 'inline', 'store'] as const;

export function isAssetMode(value: unknown): value is AssetMode {
  return typeof value === 'string' && (ASSET_MODES as readonly string[]).includes(value);
}

export function isAssetReference(value: unknown): value is AssetReference {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record['src'] === 'string' && isAssetMode(record['mode']);
}

/**
 * `file` mode payload rules (#7): a project-root relative POSIX path that never escapes the
 * project root and never turns into a URL.
 */
export function assetPathError(src: string): string | undefined {
  if (src.startsWith('/')) {
    return 'must be relative to the project root, not absolute';
  }
  if (/^[A-Za-z]:/.test(src)) {
    return 'must not carry a drive letter';
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(src)) {
    return 'must not be a URL';
  }
  if (src.includes('\\')) {
    return 'must use POSIX separators';
  }
  const escaping = src.split('/').find((segment) => segment === '..' || segment.startsWith('~'));
  if (escaping !== undefined) {
    return `must stay inside the project root (segment "${escaping}")`;
  }
  return undefined;
}

/** `inline` mode payload: base64 text, so hosts decode without guessing the encoding. */
export function base64Error(src: string): string | undefined {
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(src)
    ? undefined
    : 'must be base64 text';
}

/** Payload problem for a resource reference `src`, or `undefined` when it is well formed. */
export function assetSrcError(mode: AssetMode, src: string): string | undefined {
  if (mode === 'inline') {
    return base64Error(src);
  }
  return mode === 'file' ? assetPathError(src) : undefined;
}
