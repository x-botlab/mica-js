import { parsePayloadType, type PayloadType } from '@mica-js/core/canvas';
import {
  createDeviceRegistry,
  parseDeviceReference,
  synthesizeDeviceSymbol,
} from '@mica-js/core/schematic';
import type { DeviceSymbolProvider, PinSide } from '@mica-js/core/schematic';

/**
 * Playground device package: **contracts only**.
 *
 * The committed JSON files describe what a device *is* — reference, unified-IR type, pins, topic
 * ports, electrical resources and reset support. Metadata loading does not execute the paired JS:
 * the schematic editor and canvas catalog use JSON alone. The simulation worker separately loads
 * factories through the same file system.
 */

/** Folder `public/devices` is served from, relative to the page (and to the guest's host file system). */
export const DEVICE_LIBRARY_ROOT = 'devices';
export const PLAYGROUND_DEVICE_EXTENSIONS = ['teaching-i2c.package.json'] as const;

/** Read-only view of the files that make up one device package. */
export interface DeviceLibraryFiles {
  /** Human-readable label used in diagnostics. */
  readonly label: string;
  /** Reads a package-relative POSIX path and resolves to its bytes. */
  read(path: string): Promise<Uint8Array>;
}

/** Pin identity and geometry; capabilities are initialized by the paired factory. */
export interface DevicePinContract {
  readonly side: PinSide;
  readonly kind: 'signal' | 'power' | 'gnd';
}

/**
 * One host-facing endpoint declared by the contract.
 *
 * A port names the payload a factory hook consumes or publishes: `applyInputs` receives it at the
 * step boundary and `flushOutputs` publishes it. The contract never names a device state slot.
 */
export interface DeviceTopicContract {
  readonly port: string;
  readonly direction: 'input' | 'output';
  readonly type: PayloadType;
  readonly title?: string;
}

/** Whether the device declares a reset lifecycle of its own. */
export type DeviceResetState = 'supported' | 'unsupported';

/** One loaded device contract. */
export interface DeviceLibraryEntry {
  /** Library-local id, e.g. `ideal-button`. */
  readonly id: string;
  readonly path: string;
  readonly definition: Readonly<Record<string, unknown>>;
  /** Full `<packageId>:<deviceId>` reference schematics use. */
  readonly reference: string;
  /** Unified-IR device type the contract names. */
  readonly type: string;
  readonly displayName: string;
  readonly designatorPrefix: string;
  readonly pins: Readonly<Record<string, DevicePinContract>>;
  readonly topics: readonly DeviceTopicContract[];
  /** Connections the capability panel lists; a runtime model owns the electrical meaning. */
  readonly connections: readonly string[];
  readonly reset: { readonly state: DeviceResetState; readonly detail: string };
  /** Per-instance configuration from the definition, passed to a runtime model when one exists. */
  readonly config: Readonly<Record<string, unknown>>;
}

/** Loaded device package; the Playground analogue of `WidgetPackage`. */
export interface DeviceLibrary {
  readonly id: string;
  readonly version: string;
  readonly entries: readonly DeviceLibraryEntry[];
  /** Symbol geometry of every declared device, ready for the schematic editor and canvas catalog. */
  readonly symbols: DeviceSymbolProvider;
  find(reference: string): DeviceLibraryEntry | undefined;
  /** Devices that name `type`, in declaration order. */
  withType(type: string): readonly DeviceLibraryEntry[];
}

const PACKAGE_JSON = 'package.json';
const DEFINITION_EXTENSION = '.json';
/** Package and device ids are stable kebab-case identifiers. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const PIN_SIDES: readonly PinSide[] = ['left', 'right', 'top', 'bottom'];

interface DeviceManifestEntry {
  readonly id: string;
  readonly path: string;
}

interface DeviceManifest {
  readonly id: string;
  readonly version: string;
  readonly devices: readonly DeviceManifestEntry[];
}

interface DeviceDefinition {
  readonly definition: Readonly<Record<string, unknown>>;
  readonly reference: string;
  readonly type: string;
  readonly displayName: string;
  readonly designatorPrefix: string;
  readonly pins: Readonly<Record<string, DevicePinContract>>;
  readonly config: Readonly<Record<string, unknown>>;
  readonly topics: readonly DeviceTopicContract[];
  readonly connections: readonly string[];
  readonly reset: { readonly state: DeviceResetState; readonly detail: string };
}

/**
 * Reads `package.json`, optional same-package extension manifests, and their definitions.
 *
 * Only the declared paths are read; the package is never enumerated. Nothing here imports a
 * device model: a definition that names a runtime type this package does not ship still loads,
 * because the contract is useful to the schematic editor and the canvas catalog on its own.
 *
 * @throws {Error} with a message naming the package and path when the contract is inconsistent.
 */
export async function loadDeviceLibrary(
  files: DeviceLibraryFiles,
  extensions: readonly string[] = [],
): Promise<DeviceLibrary> {
  const manifest = await readManifest(files);
  const declarations = [...manifest.devices];
  for (const path of extensions) {
    const extension = await readManifest(files, path);
    if (extension.id !== manifest.id || extension.version !== manifest.version) {
      throw new Error(`${files.label}/${path}: extension must match the base package name/version`);
    }
    declarations.push(...extension.devices);
  }
  const entries: DeviceLibraryEntry[] = [];
  const seen = new Set<string>();

  for (const declared of declarations) {
    const definition = await readDefinition(files, manifest.id, declared);
    if (seen.has(definition.reference)) {
      throw new Error(`${files.label}: duplicate device reference ${definition.reference}`);
    }
    seen.add(definition.reference);
    entries.push(Object.freeze({ id: declared.id, path: declared.path, ...definition }));
  }

  const byReference = new Map(entries.map((entry) => [entry.reference, entry]));
  const symbols = createDeviceRegistry([
    {
      packageId: manifest.id,
      devices: entries.map((entry) => ({
        id: entry.id,
        displayName: entry.displayName,
        designatorPrefix: entry.designatorPrefix,
        symbol: synthesizeDeviceSymbol({
          name: entry.displayName,
          pins: Object.fromEntries(
            Object.entries(entry.pins).map(([name, pin]) => [name, { side: pin.side }]),
          ),
        }),
      })),
    },
  ]);

  return Object.freeze({
    id: manifest.id,
    version: manifest.version,
    entries: Object.freeze(entries),
    symbols,
    find: (reference: string) => byReference.get(reference),
    withType: (type: string) => entries.filter((entry) => entry.type === type),
  });
}

async function readManifest(
  files: DeviceLibraryFiles,
  path = PACKAGE_JSON,
): Promise<DeviceManifest> {
  const text = await readText(files, path);
  const value = parseObject(text, files.label, path);
  const id = value['name'];
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error(`${files.label}/${path}: "name" must be a kebab-case package id`);
  }
  const version = value['version'];
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`${files.label}/${path}: "version" must be a non-empty string`);
  }
  const devices = value['devices'];
  if (devices === undefined) {
    return { id, version, devices: [] };
  }
  const record = parseObjectValue(devices, files.label, path, '"devices" must be an object');
  const entries = Object.keys(record)
    .sort()
    .map((deviceId) => {
      if (!ID_PATTERN.test(deviceId)) {
        throw new Error(
          `${files.label}/${path}: device id ${JSON.stringify(deviceId)} must be kebab-case`,
        );
      }
      const entry = parseObjectValue(
        record[deviceId],
        files.label,
        path,
        `device "${deviceId}" must be an object`,
      );
      const definitionPath = entry['path'];
      if (typeof definitionPath !== 'string' || !definitionPath.endsWith(DEFINITION_EXTENSION)) {
        throw new Error(
          `${files.label}/${path}: device "${deviceId}" must declare a "${DEFINITION_EXTENSION}" path`,
        );
      }
      return { id: deviceId, path: definitionPath };
    });
  return { id, version, devices: entries };
}

async function readDefinition(
  files: DeviceLibraryFiles,
  packageId: string,
  declared: DeviceManifestEntry,
): Promise<DeviceDefinition> {
  const text = await readText(files, declared.path);
  const value = parseObject(text, files.label, declared.path);

  const reference = requireString(value, 'reference', files.label, declared.path);
  const type = requireString(value, 'type', files.label, declared.path);
  const displayName = requireString(value, 'displayName', files.label, declared.path);
  const designatorPrefix = requireString(value, 'designatorPrefix', files.label, declared.path);

  const config =
    value['config'] === undefined
      ? Object.freeze({})
      : Object.freeze(
          parseObjectValue(
            value['config'],
            files.label,
            declared.path,
            '"config" must be an object',
          ),
        );

  const pins = readPins(files, declared.path, value['pins']);
  const topics = readTopics(files, declared.path, value['topics']);
  const connections = Object.freeze(
    Object.keys(
      value['connections'] === undefined
        ? {}
        : parseObjectValue(
            value['connections'],
            files.label,
            declared.path,
            '"connections" must be a resource object',
          ),
    ),
  );
  const reset = parseObjectValue(
    value['reset'],
    files.label,
    declared.path,
    '"reset" must be an object with "state" and "detail"',
  );
  const state = reset['state'];
  if (state !== 'supported' && state !== 'unsupported') {
    throw new Error(
      `${files.label}/${declared.path}: "reset.state" must be "supported" or "unsupported"`,
    );
  }
  const detail = requireString(reset, 'detail', files.label, declared.path);

  return Object.freeze({
    definition: Object.freeze({ ...value, pins }),
    reference: assertPackage(reference, packageId, files.label, declared.path),
    type,
    displayName,
    designatorPrefix,
    pins,
    config,
    topics,
    connections,
    reset: Object.freeze({ state, detail }),
  });
}

function readPins(
  files: DeviceLibraryFiles,
  path: string,
  raw: unknown,
): Readonly<Record<string, DevicePinContract>> {
  const record = parseObjectValue(raw, files.label, path, '"pins" must be an object');
  const entries = Object.keys(record);
  if (entries.length === 0) {
    throw new Error(`${files.label}/${path}: "pins" must declare at least one pin`);
  }
  const pins: Record<string, DevicePinContract> = {};
  for (const name of entries) {
    const pin = parseObjectValue(
      record[name],
      files.label,
      path,
      `pin "${name}" must be an object`,
    );
    if (Object.hasOwn(pin, 'direction') || Object.hasOwn(pin, 'role'))
      throw new Error(
        `${files.label}/${path}: pin "${name}" uses obsolete electrical direction/role`,
      );
    const side = pin['side'] ?? 'left';
    if (typeof side !== 'string' || !PIN_SIDES.includes(side as PinSide)) {
      throw new Error(
        `${files.label}/${path}: pin "${name}" side must be one of ${PIN_SIDES.join(', ')}`,
      );
    }
    const kind = pin['kind'];
    if (kind !== 'signal' && kind !== 'power' && kind !== 'gnd') {
      throw new Error(`${files.label}/${path}: pin "${name}" kind must be signal, power or gnd`);
    }
    pins[name] = Object.freeze({ side: side as PinSide, kind });
  }
  return Object.freeze(pins);
}

function readTopics(
  files: DeviceLibraryFiles,
  path: string,
  raw: unknown,
): readonly DeviceTopicContract[] {
  if (raw === undefined) {
    return Object.freeze([]);
  }
  const record = parseObjectValue(raw, files.label, path, '"topics" must be an object');
  return Object.freeze(
    Object.keys(record).map((port) => {
      const topic = parseObjectValue(
        record[port],
        files.label,
        path,
        `topic "${port}" must be an object`,
      );
      const direction = topic['direction'];
      if (direction !== 'input' && direction !== 'output') {
        throw new Error(
          `${files.label}/${path}: topic "${port}" must declare direction "input" or "output"`,
        );
      }
      const rawType = requireString(topic, 'type', files.label, path);
      const parsed = parsePayloadType(rawType);
      if (parsed === undefined) {
        throw new Error(
          `${files.label}/${path}: topic "${port}" declares unknown payload type ${JSON.stringify(rawType)}`,
        );
      }
      const title = topic['title'];
      if (title !== undefined && typeof title !== 'string') {
        throw new Error(`${files.label}/${path}: topic "${port}" "title" must be a string`);
      }
      if (Object.hasOwn(topic, 'state'))
        throw new Error(
          `${files.label}/${path}: topic "${port}" must not map a device state; implement applyInputs/flushOutputs in the paired factory`,
        );
      return Object.freeze({
        port,
        direction,
        type: parsed,
        ...(title === undefined ? {} : { title }),
      }) satisfies DeviceTopicContract;
    }),
  );
}

function assertPackage(reference: string, packageId: string, label: string, path: string): string {
  const parsed = parseDeviceReference(reference);
  if (parsed === undefined || parsed.packageId !== packageId) {
    throw new Error(
      `${label}/${path}: reference ${JSON.stringify(reference)} must be a "${packageId}:" device`,
    );
  }
  return reference;
}

async function readText(files: DeviceLibraryFiles, path: string): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = await files.read(path);
  } catch (cause) {
    throw new Error(`${files.label}: cannot read ${path}`, { cause });
  }
  return new TextDecoder().decode(bytes);
}

function parseObject(text: string, label: string, path: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${label}/${path}: invalid JSON`, { cause });
  }
  return parseObjectValue(value, label, path, `${path} must contain a JSON object`);
}

function parseObjectValue(
  value: unknown,
  label: string,
  path: string,
  message: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label}/${path}: ${message}`);
  }
  return value as Record<string, unknown>;
}

function requireString(
  value: Record<string, unknown>,
  key: string,
  label: string,
  path: string,
): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) {
    throw new Error(`${label}/${path}: "${key}" must be a non-empty string`);
  }
  return field;
}
