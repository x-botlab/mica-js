/**
 * Verified device packages of the fused workbench (RFC 0020 / RFC 0022).
 *
 * Editing needs more than the raw registry: before a device may be placed, its locked release has
 * to prove its identity and file digests, its `view2d.geometry` (inline or a declared file) has to
 * parse against the manifest pins, and the referenced body image has to exist in the release file
 * list. This cache performs exactly that and hands the renderer the verified manifest, the parsed
 * geometry and the verified file table, so no view script and no package bytes are ever guessed.
 */
import type { IDisposable } from '@mica-js/core/lifecycle';
import { parseGeometry2D } from '@mica-js/document/fused';
import type {
  DeviceLock,
  FusedDocument,
  Geometry2D,
  PackageFiles,
  UnifiedDeviceManifest,
} from '@mica-js/document/fused';
import { openDevicePackage, PreparationError } from '@mica-js/sdk/fused';
import type { VerifiedPackage } from '@mica-js/sdk/fused';
import type { IDeviceProvider } from './providers';

/** Upper bound for a declared geometry file; a release entry above it is treated as hostile. */
const MAX_GEOMETRY_BYTES = 4 * 1024 * 1024;

/** One locked device release, verified and ready to be placed and drawn. */
export interface IPreparedDevice {
  readonly lock: DeviceLock;
  readonly manifest: UnifiedDeviceManifest;
  readonly geometry: Geometry2D;
  /** Verified release file table and reader; body images and other assets are read from here. */
  readonly files: PackageFiles;
}

export interface IDeviceCache extends IDisposable {
  /** Opens, verifies and caches one locked release; concurrent calls share one read. */
  get(lock: DeviceLock): Promise<IPreparedDevice>;
  /** Prepared release of a device id that was opened before, keyed by the full device id. */
  getLoaded(id: string): IPreparedDevice | undefined;
  /**
   * Every prepared device keyed by the full device id.
   *
   * The map identity survives edits and only changes when a release is opened, so a renderer can
   * iterate it and keep per-device caches.
   */
  getLoadedDevices(): ReadonlyMap<string, IPreparedDevice>;
  /** @throws when the device id has not been prepared yet. */
  requireLoaded(id: string): IPreparedDevice;
  /** Prepares every device an instance references; unlocked devices are rejected. */
  prepareDocument(document: FusedDocument): Promise<ReadonlyMap<string, IPreparedDevice>>;
}

/**
 * Verified package cache shared by the document session and the canvas renderer.
 *
 * Failures are not cached: a release that cannot be verified is reported to the caller and may be
 * opened again once the registry can serve it.
 */
export class DeviceCache implements IDeviceCache {
  readonly #registry: IDeviceProvider;
  readonly #loaded = new Map<string, IPreparedDevice>();
  readonly #byId = new Map<string, IPreparedDevice>();
  readonly #pending = new Map<string, Promise<IPreparedDevice>>();
  #snapshot: ReadonlyMap<string, IPreparedDevice> = new Map();
  #snapshotStale = false;
  #disposed = false;

  constructor(registry: IDeviceProvider) {
    this.#registry = registry;
  }

  get(lock: DeviceLock): Promise<IPreparedDevice> {
    this.#assertActive();
    const key = lockKey(lock);
    const loaded = this.#loaded.get(key);
    if (loaded !== undefined) {
      return Promise.resolve(loaded);
    }
    const pending = this.#pending.get(key);
    if (pending !== undefined) {
      return pending;
    }
    const request = this.#open(lock).finally(() => {
      this.#pending.delete(key);
    });
    this.#pending.set(key, request);
    return request;
  }

  getLoaded(id: string): IPreparedDevice | undefined {
    return this.#byId.get(id);
  }

  getLoadedDevices(): ReadonlyMap<string, IPreparedDevice> {
    if (this.#snapshotStale) {
      this.#snapshot = new Map(this.#byId);
      this.#snapshotStale = false;
    }
    return this.#snapshot;
  }

  requireLoaded(id: string): IPreparedDevice {
    const device = this.#byId.get(id);
    if (device === undefined) {
      throw new Error(`Device ${JSON.stringify(id)} has not been prepared.`);
    }
    return device;
  }

  async prepareDocument(document: FusedDocument): Promise<ReadonlyMap<string, IPreparedDevice>> {
    this.#assertActive();
    const prepared = new Map<string, IPreparedDevice>();
    await Promise.all(
      [...new Set(document.instances.map((instance) => instance.device))].map(async (deviceId) => {
        const dependency = document.dependencies[deviceId];
        if (dependency === undefined) {
          throw new PreparationError([
            problem(
              'document/unlocked-device',
              `Instance device "${deviceId}" is not locked by "dependencies".`,
            ),
          ]);
        }
        const device = await this.get({
          id: deviceId,
          version: dependency.version,
          integrity: dependency.integrity,
        });
        prepared.set(deviceId, device);
      }),
    );
    return prepared;
  }

  /** Drops every cached release; late opens finish but do not repopulate the cache. */
  dispose(): void {
    this.#disposed = true;
    this.#loaded.clear();
    this.#byId.clear();
    this.#pending.clear();
    this.#snapshot = new Map();
    this.#snapshotStale = false;
  }

  async #open(lock: DeviceLock): Promise<IPreparedDevice> {
    const verified = await openDevicePackage(this.#registry, lock);
    const geometry = await readGeometry(verified);
    this.#assertActive();
    const device: IPreparedDevice = Object.freeze({
      lock: verified.lock,
      manifest: verified.manifest,
      geometry,
      files: verified.source,
    });
    this.#loaded.set(lockKey(verified.lock), device);
    this.#byId.set(verified.lock.id, device);
    this.#snapshotStale = true;
    return device;
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error('Device cache is disposed.');
    }
  }
}

function lockKey(lock: DeviceLock): string {
  return `${lock.id}@${lock.version}#${lock.integrity}`;
}

async function readGeometry(verified: VerifiedPackage): Promise<Geometry2D> {
  const id = verified.lock.id;
  const declared = verified.manifest.view2d?.geometry;
  if (declared === undefined) {
    throw new PreparationError([
      problem(
        'view2d/invalid-geometry',
        `${id} declares no "view2d.geometry", so it cannot be placed on the schematic.`,
        '/view2d',
      ),
    ]);
  }
  const pins = Object.keys(verified.manifest.pins ?? {});
  let geometry: Geometry2D;
  if (typeof declared === 'string') {
    const bytes = await verified.read(declared, MAX_GEOMETRY_BYTES);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new PreparationError([
        problem(
          'view2d/invalid-geometry',
          `${id}/${declared} is not valid UTF-8 text.`,
          '/view2d/geometry',
        ),
      ]);
    }
    geometry = parseGeometry2D(text, pins);
  } else {
    geometry = parseGeometry2D(declared, pins);
  }
  if (geometry.bodyImage !== undefined && !Object.hasOwn(verified.files, geometry.bodyImage)) {
    throw new PreparationError([
      problem(
        'package/missing-entry',
        `${id} declares the body image ${geometry.bodyImage}, which the release does not list.`,
        '/view2d/geometry/bodyImage',
      ),
    ]);
  }
  return geometry;
}

function problem(
  code: string,
  message: string,
  pointer = '',
): {
  readonly code: string;
  readonly message: string;
  readonly pointer: string;
} {
  return { code, message, pointer };
}
