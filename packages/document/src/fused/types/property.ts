/**
 * Persistent instance property values of the fused document (RFC 0024) with the resource and
 * firmware extensions of RFC 0020 / RFC 0026.
 */

/** Where an `image` / `binary` / `firmware` value lives (RFC 0020). */
export type ResourceMode = 'file' | 'package' | 'inline' | 'store';

/**
 * Reference to a resource instead of inline bytes (RFC 0024).
 *
 * `file` is a project-root relative POSIX path, `package` a package-root relative POSIX path,
 * `inline` is base64 text and `store` is a host resource-library identifier.
 */
export interface ResourceReference {
  readonly src: string;
  readonly mode: ResourceMode;
}

/**
 * `firmware` value that names a fixed file (RFC 0026). `addressSpace` and `loadAddress` override
 * the attribute defaults for the address space and, for BIN, the load address.
 */
export interface FirmwareFileReference extends ResourceReference {
  readonly mode: 'file' | 'package';
  readonly addressSpace?: string;
  readonly loadAddress?: number;
}

/** `firmware` value that names a host project; the artifact is resolved at run preparation. */
export interface FirmwareProjectReference {
  readonly mode: 'project';
  readonly projectId: string;
  readonly addressSpace?: string;
  readonly loadAddress?: number;
}

/** Persistent `firmware` property value (RFC 0026). */
export type FirmwareReference = FirmwareFileReference | FirmwareProjectReference;

/**
 * Instance property value stored in `FusedInstance.properties` (RFC 0024): a scalar, a resource
 * reference, a firmware reference, or `null` for an explicitly cleared nullable property.
 */
export type PropertyValue =
  string | number | boolean | null | ResourceReference | FirmwareReference;
