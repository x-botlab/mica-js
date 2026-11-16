/**
 * Locked device package loading of the headless runtime (RFC 0020).
 *
 * The registry owns the bytes; this module proves that a package matches its lock before any of
 * its code is loaded: identity, version, host API range, declared paths, file sizes and SHA-256
 * digests. The lock, the file list and every byte buffer are copied before the first `await`, so a
 * registry that mutates its own objects cannot change what was verified.
 */
import { sha256 as packagedSha256 } from '@noble/hashes/sha2.js';
import { packagePathProblem, parseUnifiedManifest } from '@mica-js/document/fused';
import type {
  DeviceLock,
  DeviceRegistry,
  PackageFile,
  PackageFiles,
  UnifiedDeviceManifest,
} from '@mica-js/document/fused';
import { satisfies, valid } from 'semver';
import { asPreparation, PreparationError, problem } from './diagnostics.js';
import type { PreparationProblem } from './diagnostics.js';

/**
 * Host API version this runtime implements.
 *
 * `engines.mica` names the host API, not the npm version of this package: the fused device runtime
 * implements API `1.0.0`, so manifests declare ranges such as `^1.0.0`. A package outside the range
 * is rejected before anything is loaded.
 */
export const MICA_HOST_API_VERSION = '1.0.0';

const INTEGRITY = /^sha256:[0-9a-f]{64}$/;
const MANIFEST_PATH = 'package.json';

/** One locked package whose identity and files were verified against the lock. */
export interface VerifiedPackage {
  readonly lock: DeviceLock;
  readonly manifest: UnifiedDeviceManifest;
  /** Verified read interface handed to the caller-supplied module loader. */
  readonly source: PackageFiles;
  /** Snapshot of the declared release file list, keyed by package-root relative path. */
  readonly files: Readonly<Record<string, PackageFile>>;
  /** Reads and verifies one declared file; every call returns independent bytes. */
  read(path: string, maxBytes?: number): Promise<Uint8Array>;
}

/** Whether `path` is a normalized package-root relative POSIX path (RFC 0020). */
export function isPackagePath(path: string): boolean {
  return packagePathProblem(path) === undefined;
}

/**
 * Opens one locked package and verifies everything that does not need code execution.
 *
 * @throws {PreparationError} with the RFC 0020 diagnostic codes of every problem found.
 */
export async function openDevicePackage(
  registry: DeviceRegistry,
  lock: DeviceLock,
  hostApiVersion: string = MICA_HOST_API_VERSION,
): Promise<VerifiedPackage> {
  const requested = snapshotLock(lock);

  let opened: PackageFiles;
  try {
    opened = await registry.open(requested);
  } catch (cause) {
    throw new PreparationError([
      problem(
        'package/not-found',
        `Cannot open ${requested.id}@${requested.version}: ${errorMessage(cause)}`,
      ),
    ]);
  }
  // Capture the reader and the file table before the next `await`: later mutation of the registry
  // object must not reach the verification that follows.
  const readFile = opened.read;
  const table = snapshotFileTable(opened, requested);

  await verifyReleaseIdentity(table, requested);

  const read = async (path: string, maxBytes?: number): Promise<Uint8Array> => {
    const record = table[path];
    if (record === undefined) {
      throw new PreparationError([
        problem('package/missing-entry', `Package ${requested.id} does not declare ${path}.`),
      ]);
    }
    if (maxBytes !== undefined && record.size > maxBytes) {
      throw new PreparationError([
        problem(
          'package/resource-limit',
          `${requested.id}/${path} is ${record.size} bytes, above the declared limit of ${maxBytes}.`,
        ),
      ]);
    }
    const returned = await readFile.call(opened, path);
    if (!(returned instanceof Uint8Array)) {
      throw new PreparationError([
        problem('package/not-found', `Package ${requested.id} returned no bytes for ${path}.`),
      ]);
    }
    // Copy first: the digest and the caller must never share storage with the registry.
    const owned = returned.slice();
    if (owned.length !== record.size) {
      throw new PreparationError([
        problem(
          'package/integrity-mismatch',
          `${requested.id}/${path} is ${owned.length} bytes but the release declares ${record.size}.`,
        ),
      ]);
    }
    const digest = await sha256(owned);
    if (digest !== record.integrity) {
      throw new PreparationError([
        problem(
          'package/integrity-mismatch',
          `${requested.id}/${path} does not match the released digest.`,
        ),
      ]);
    }
    return owned.slice();
  };

  // The text goes straight to the contract parser, which also rejects duplicate JSON keys.
  const manifestText = new TextDecoder().decode(await read(MANIFEST_PATH)).replace(/^\uFEFF/, '');
  const manifest = parseManifestText(manifestText);
  verifyIdentity(manifest, requested);
  if (!satisfiesRange(hostApiVersion, manifest.engines.mica)) {
    throw new PreparationError([
      problem(
        'package/unsupported-engine',
        `${requested.id}@${requested.version} requires mica "${manifest.engines.mica}" ` +
          `but this runtime implements ${hostApiVersion}.`,
        '/engines/mica',
      ),
    ]);
  }

  const source: PackageFiles = Object.freeze({
    lock: requested,
    files: table,
    read: (path: string) => read(path),
  });
  return Object.freeze({ lock: requested, manifest, source, files: table, read });
}

function snapshotLock(lock: DeviceLock): DeviceLock {
  if (
    lock === null ||
    typeof lock !== 'object' ||
    typeof lock.id !== 'string' ||
    typeof lock.version !== 'string'
  ) {
    throw new PreparationError([
      problem('package/invalid-manifest', 'A device lock needs "id" and "version" strings.'),
    ]);
  }
  if (!INTEGRITY.test(lock.integrity)) {
    throw new PreparationError([
      problem(
        'package/integrity-mismatch',
        `Lock of "${lock.id}" does not carry a sha256 release identity.`,
      ),
    ]);
  }
  return Object.freeze({ id: lock.id, version: lock.version, integrity: lock.integrity });
}

/** Copies and validates the opened file list; the returned table is frozen. */
function snapshotFileTable(
  opened: PackageFiles,
  lock: DeviceLock,
): Readonly<Record<string, PackageFile>> {
  if (opened === null || typeof opened !== 'object') {
    throw new PreparationError([
      problem('package/not-found', `Registry returned no package for ${lock.id}.`),
    ]);
  }
  if (
    opened.lock?.id !== lock.id ||
    opened.lock.version !== lock.version ||
    opened.lock.integrity !== lock.integrity
  ) {
    throw new PreparationError([
      problem(
        'package/integrity-mismatch',
        `Registry opened a release that does not match the lock of "${lock.id}".`,
      ),
    ]);
  }
  if (
    typeof opened.read !== 'function' ||
    opened.files === null ||
    typeof opened.files !== 'object'
  ) {
    throw new PreparationError([
      problem('package/not-found', `Registry returned an unreadable release for "${lock.id}".`),
    ]);
  }
  const problems: PreparationProblem[] = [];
  const table: Record<string, PackageFile> = Object.create(null) as Record<string, PackageFile>;
  for (const [path, record] of Object.entries(opened.files)) {
    if (!isPackagePath(path)) {
      problems.push(
        problem(
          'package/invalid-path',
          `Package ${lock.id} declares the non-normalized path ${JSON.stringify(path)}.`,
        ),
      );
      continue;
    }
    if (
      record === null ||
      typeof record !== 'object' ||
      !Number.isSafeInteger(record.size) ||
      record.size < 0 ||
      !INTEGRITY.test(record.integrity)
    ) {
      problems.push(
        problem(
          'package/invalid-path',
          `Package ${lock.id} declares an invalid entry for ${path}.`,
        ),
      );
      continue;
    }
    table[path] = Object.freeze({ size: record.size, integrity: record.integrity });
  }
  if (!Object.hasOwn(table, MANIFEST_PATH)) {
    problems.push(
      problem('package/missing-entry', `Package ${lock.id} does not declare ${MANIFEST_PATH}.`),
    );
  }
  if (problems.length > 0) {
    throw new PreparationError(problems);
  }
  return Object.freeze(table);
}

/**
 * Verifies the release identity of RFC 0020: the SHA-256 of the JSON Canonicalization Scheme bytes
 * of `{ id, version, files }`, which is exactly the information a `PackageFiles` view exposes.
 */
async function verifyReleaseIdentity(
  table: Readonly<Record<string, PackageFile>>,
  lock: DeviceLock,
): Promise<void> {
  const identity = await releaseIntegrity({ id: lock.id, version: lock.version, files: table });
  if (identity !== lock.integrity) {
    throw new PreparationError([
      problem(
        'package/integrity-mismatch',
        `The file list of ${lock.id}@${lock.version} derives the release identity ${identity}, ` +
          `but the document locks ${lock.integrity}.`,
      ),
    ]);
  }
}

export async function releaseIntegrity(release: {
  readonly id: string;
  readonly version: string;
  readonly files: Readonly<Record<string, PackageFile>>;
}): Promise<string> {
  return sha256(new TextEncoder().encode(canonicalJson(release)));
}

/** JSON Canonicalization Scheme subset for release manifests: sorted keys, no extra whitespace. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${members.join(',')}}`;
}

function parseManifestText(text: string): UnifiedDeviceManifest {
  try {
    return parseUnifiedManifest(text);
  } catch (cause) {
    throw new PreparationError(asPreparation(cause, 'package/invalid-manifest'));
  }
}

function verifyIdentity(manifest: UnifiedDeviceManifest, lock: DeviceLock): void {
  const id = `${manifest.publisher}:${manifest.name}`;
  if (id !== lock.id) {
    throw new PreparationError([
      problem(
        'package/invalid-manifest',
        `package.json declares ${id} but the document locks ${lock.id}.`,
        '/name',
      ),
    ]);
  }
  if (manifest.version !== lock.version) {
    throw new PreparationError([
      problem(
        'package/invalid-manifest',
        `package.json declares version ${manifest.version} but the document locks ${lock.version}.`,
        '/version',
      ),
    ]);
  }
}

/**
 * SHA-256 of one byte sequence, formatted as the RFC 0020 release digest.
 *
 * WebCrypto is preferred because it is native, but an opaque-origin sandbox worker has no
 * `crypto.subtle` at all. There the packaged implementation hashes instead: verification must keep
 * working inside the sandbox and is never skipped or weakened. When the host does expose WebCrypto,
 * a failing digest is a real failure and is reported as such instead of being retried elsewhere.
 *
 * @throws {PreparationError} `package/integrity-mismatch` when the digest cannot be computed.
 */
async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return `sha256:${toHex(await digestSha256(copy))}`;
}

async function digestSha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    // An opaque-origin sandbox worker has no WebCrypto at all; the packaged SHA-256 hashes there.
    return packagedSha256(bytes);
  }
  try {
    const digest = await subtle.digest('SHA-256', bytes);
    return new Uint8Array(digest);
  } catch (cause) {
    throw new PreparationError([
      problem(
        'package/integrity-mismatch',
        `The host WebCrypto refused to compute a SHA-256 digest: ${errorMessage(cause)}`,
      ),
    ]);
  }
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Whether `version` satisfies the SemVer range of `engines.mica`.
 *
 * Delegates to the `semver` package, so prereleases, X-ranges, hyphen ranges and partial versions
 * follow the standard semantics instead of an approximation.
 */
export function satisfiesRange(version: string, range: string): boolean {
  if (typeof version !== 'string' || typeof range !== 'string') {
    return false;
  }
  if (valid(version) === null) {
    return false;
  }
  try {
    return satisfies(version, range);
  } catch {
    return false;
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
