/**
 * Persistent instance property values of the fused document (RFC 0024) with the resource and
 * firmware extensions of RFC 0020 / RFC 0026.
 */

/** Where an `image` / `binary` / `firmware` value lives (RFC 0020). */
export type ResourceMode = 'asset' | 'package';

/**
 * Reference to a resource instead of inline bytes (RFC 0024).
 *
 * `package` uses a package-root relative POSIX path; `asset` uses a host library identity.
 */
export type ResourceReference =
  | { readonly mode: 'package'; readonly src: string }
  | { readonly mode: 'asset'; readonly assetId: string; readonly name: string };

/**
 * `firmware` value that names a fixed file (RFC 0026). `addressSpace` and `loadAddress` override
 * the attribute defaults for the address space and, for BIN, the load address.
 */
export type FirmwareFileReference = ResourceReference & {
  readonly addressSpace?: string;
  readonly loadAddress?: number;
};

/** Program project resolved by the host at run preparation; the name is display metadata. */
export interface ProgramProjectReference {
  readonly mode: 'project';
  readonly projectId: string;
  readonly name?: string;
  readonly addressSpace?: string;
  readonly loadAddress?: number;
}

/** Persistent `firmware` property value (RFC 0026). */
export type FirmwareReference = FirmwareFileReference;

export type ProgramFileReference = FirmwareFileReference;
export type ProgramReference = ProgramFileReference | ProgramProjectReference;

/**
 * Instance property value stored in `FusedInstance.properties` (RFC 0024): a scalar, a resource
 * reference, a firmware reference, or `null` for an explicitly cleared nullable property.
 */
export type PropertyValue = string | number | boolean | null | ResourceReference | ProgramReference;
