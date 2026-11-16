/**
 * Read interfaces of locked device packages and resolved firmware images (RFC 0020 / RFC 0026).
 *
 * These are pure data contracts: the host implements them, the document package only consumes
 * their shape.
 */

/** Release a document locks (RFC 0020). */
export interface DeviceLock {
  /** Full `publisher:name` device id. */
  readonly id: string;
  readonly version: string;
  /** `sha256:` plus 64 lowercase hexadecimal digits of the release identity. */
  readonly integrity: string;
}

/** One file of a release file list (RFC 0020). */
export interface PackageFile {
  /** Original byte length. */
  readonly size: number;
  /** `sha256:` plus 64 lowercase hexadecimal digits of the file bytes. */
  readonly integrity: string;
}

/** Read-only view of one locked package (RFC 0020). */
export interface PackageFiles {
  readonly lock: DeviceLock;
  /** Package-root relative path to declared size and digest. */
  readonly files: Readonly<Record<string, PackageFile>>;
  /** Returns independent bytes; `path` is a normalized package-root relative path. */
  read(path: string): Promise<Uint8Array>;
}

/** Resolves a lock to the package bytes hosted by the current mode (RFC 0020). */
export interface DeviceRegistry {
  open(lock: DeviceLock): Promise<PackageFiles>;
}

/**
 * Structural read-only byte snapshot: read-only access plus a `slice` that returns an independent
 * mutable copy (see `docs/spec/javascript/interfaces.rst`).
 */
export interface ReadonlyBytes {
  readonly length: number;
  readonly byteLength: number;
  readonly [index: number]: number | undefined;
  [Symbol.iterator](): IterableIterator<number>;
  slice(start?: number, end?: number): Uint8Array;
}

/** One contiguous firmware load into a declared address space (RFC 0026). */
export interface FirmwareSegment {
  /** Address space id declared by the firmware property. */
  readonly addressSpace: string;
  /** Absolute byte address inside that space. */
  readonly address: number;
  readonly data: ReadonlyBytes;
}

/** Resolved firmware program handed to a model factory (RFC 0026). */
export interface FirmwareImage {
  readonly segments: readonly FirmwareSegment[];
}
