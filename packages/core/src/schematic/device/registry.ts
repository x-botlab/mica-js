import type { Diagnostic } from '../format/diagnostics';
import { SchematicError, throwIfErrors } from '../format/errors';
import type { Rect } from '../format/types';
import { isRecord } from '../format/validate';
import {
  formatDeviceReference,
  isReservedPackageId,
  isValidPackageId,
  parseDeviceReference,
  type DeviceReference,
} from './reference';
import type {
  DeviceSymbolDefinition,
  DeviceSymbolGeometry,
  DeviceSymbolProvider,
  PinAnchor,
} from './symbol';

export interface DeviceRegistrationEntry {
  /** Device id, unique within the package. */
  readonly id: string;
  /** Display name; defaults to the device id. */
  readonly displayName?: string;
  readonly description?: string;
  /** Schematic symbol; omitted when the device has no geometry yet. */
  readonly symbol?: DeviceSymbolGeometry;
  /** Remaining device description fields (#5 pins, #7 properties, #10 ports, ...), kept as-is. */
  readonly raw?: Readonly<Record<string, unknown>>;
}

/** Package data prepared by the host from the #11 `devices` index and device descriptions. */
export interface DevicePackageRegistration {
  readonly packageId: string;
  readonly devices: readonly DeviceRegistrationEntry[];
}

export interface ResolvedDevice {
  readonly reference: DeviceReference;
  readonly packageId: string;
  readonly deviceId: string;
  readonly displayName: string;
  readonly description: string | undefined;
  readonly symbol: DeviceSymbolDefinition | undefined;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface DeviceRegisterOptions {
  readonly replace?: boolean;
}

export interface DeviceRegistry extends DeviceSymbolProvider {
  /** @throws {SchematicError} when the package data is invalid; nothing is registered then. */
  registerPackage(registration: DevicePackageRegistration, options?: DeviceRegisterOptions): void;
  resolve(reference: DeviceReference | string): ResolvedDevice | undefined;
  listDevices(packageId?: string): readonly ResolvedDevice[];
  /** Non-fatal diagnostics collected while registering packages (currently `device/no-symbol`). */
  readonly diagnostics: readonly Diagnostic[];
}

interface StoredPackage {
  readonly packageId: string;
  readonly devices: ReadonlyMap<string, ResolvedDevice>;
}

export function createDeviceRegistry(
  packages: readonly DevicePackageRegistration[] = [],
): DeviceRegistry {
  const stored = new Map<string, StoredPackage>();
  const registrationDiagnostics: Diagnostic[] = [];

  const getDeviceName = (reference: DeviceReference): string | undefined => {
    const device = lookup(reference);
    // `symbol.name` already resolves to displayName or device id when the description omits it.
    return device?.symbol?.name ?? device?.displayName;
  };

  const lookup = (reference: DeviceReference): ResolvedDevice | undefined => {
    const pkg = stored.get(reference.packageId);
    return pkg?.devices.get(reference.deviceId);
  };

  const registry: DeviceRegistry = {
    registerPackage(registration, options) {
      const diagnostics: Diagnostic[] = [];
      const packageId = registration.packageId;
      if (!isValidPackageId(packageId)) {
        throw new SchematicError([
          {
            severity: 'error',
            code: 'device/invalid-package',
            message: `Invalid package id ${JSON.stringify(packageId)}.`,
          },
        ]);
      }
      if (isReservedPackageId(packageId)) {
        throw new SchematicError([
          {
            severity: 'error',
            code: 'device/reserved-namespace',
            message: `Package id ${JSON.stringify(packageId)} uses the reserved "builtin" namespace.`,
          },
        ]);
      }
      if (stored.has(packageId) && options?.replace !== true) {
        throw new SchematicError([
          {
            severity: 'error',
            code: 'device/duplicate-package',
            message: `Package ${JSON.stringify(packageId)} is already registered.`,
          },
        ]);
      }

      const devices = new Map<string, ResolvedDevice>();
      const reportedUnknownPins = new Set<string>();
      for (const entry of registration.devices) {
        const deviceId = typeof entry.id === 'string' ? entry.id : '';
        if (deviceId.length === 0) {
          diagnostics.push({
            severity: 'error',
            code: 'device/invalid-description',
            message: `Package ${JSON.stringify(packageId)} contains a device without an id.`,
          });
          continue;
        }
        const devicePath = `${packageId}:${deviceId}`;
        if (devices.has(deviceId)) {
          diagnostics.push({
            severity: 'error',
            code: 'device/duplicate-device',
            message: `Device ${JSON.stringify(devicePath)} is declared more than once.`,
          });
          continue;
        }

        const raw = isRecord(entry.raw) ? entry.raw : Object.create(null);
        const displayName =
          typeof entry.displayName === 'string' && entry.displayName.length > 0
            ? entry.displayName
            : deviceId;
        const symbol = readSymbolGeometry(entry, raw, devicePath, diagnostics, reportedUnknownPins);

        devices.set(deviceId, {
          reference: {
            raw: formatDeviceReference(packageId, deviceId),
            packageId,
            deviceId,
          },
          packageId,
          deviceId,
          displayName,
          description: typeof entry.description === 'string' ? entry.description : undefined,
          symbol,
          raw,
        });
      }

      registrationDiagnostics.push(...diagnostics);
      throwIfErrors(diagnostics);
      stored.set(packageId, { packageId, devices });
    },

    resolve(reference) {
      const parsed = typeof reference === 'string' ? parseDeviceReference(reference) : reference;
      if (parsed === undefined) {
        return undefined;
      }
      return lookup(parsed);
    },

    listDevices(packageId) {
      const packages = packageId === undefined ? [...stored.values()] : [stored.get(packageId)];
      const devices: ResolvedDevice[] = [];
      for (const pkg of packages) {
        if (pkg === undefined) {
          continue;
        }
        devices.push(...pkg.devices.values());
      }
      return devices.sort(
        (a, b) => a.packageId.localeCompare(b.packageId) || a.deviceId.localeCompare(b.deviceId),
      );
    },

    getDeviceSymbol(reference) {
      return lookup(reference)?.symbol;
    },

    getDeviceName,

    get diagnostics() {
      return registrationDiagnostics;
    },
  };

  for (const registration of packages) {
    registry.registerPackage(registration);
  }

  return registry;
}

function readSymbolGeometry(
  entry: DeviceRegistrationEntry,
  raw: Readonly<Record<string, unknown>>,
  devicePath: string,
  diagnostics: Diagnostic[],
  reportedUnknownPins: Set<string>,
): DeviceSymbolDefinition | undefined {
  const symbol = entry.symbol;
  if (symbol === undefined) {
    diagnostics.push({
      severity: 'warning',
      code: 'device/no-symbol',
      message: `Device ${JSON.stringify(devicePath)} has no symbol geometry.`,
    });
    return undefined;
  }
  if (!isRecord(symbol)) {
    diagnostics.push({
      severity: 'error',
      code: 'device/invalid-description',
      message: `Device ${JSON.stringify(devicePath)} has an invalid symbol definition.`,
    });
    return undefined;
  }

  const pins = readPins(symbol.pins, devicePath, diagnostics);
  if (pins === undefined) {
    return undefined;
  }

  const declaredPins = readDeclaredPinIds(raw.pins);
  if (declaredPins !== undefined) {
    for (const pinId of Object.keys(pins)) {
      if (!declaredPins.has(pinId) && !reportedUnknownPins.has(`${devicePath}\u0000${pinId}`)) {
        reportedUnknownPins.add(`${devicePath}\u0000${pinId}`);
        diagnostics.push({
          severity: 'error',
          code: 'device/unknown-pin',
          message: `Device ${JSON.stringify(devicePath)} symbol declares pin ${JSON.stringify(pinId)} which is absent from the pin declaration.`,
        });
      }
    }
  }

  const bounds = readBounds(symbol.bounds, devicePath, diagnostics);
  const declaredName =
    typeof symbol.name === 'string' && symbol.name.length > 0 ? symbol.name : undefined;
  const displayName =
    typeof entry.displayName === 'string' && entry.displayName.length > 0
      ? entry.displayName
      : entry.id;
  const name = declaredName ?? displayName;

  return bounds === undefined ? { name, pins } : { name, pins, bounds };
}

function readPins(
  value: unknown,
  devicePath: string,
  diagnostics: Diagnostic[],
): Record<string, PinAnchor> | undefined {
  if (!isRecord(value)) {
    diagnostics.push({
      severity: 'error',
      code: 'device/invalid-description',
      message: `Device ${JSON.stringify(devicePath)} symbol must declare a pins object.`,
    });
    return undefined;
  }
  const pins: Record<string, PinAnchor> = Object.create(null);
  let failed = false;
  for (const [pinId, anchor] of Object.entries(value)) {
    if (pinId.length === 0) {
      diagnostics.push({
        severity: 'error',
        code: 'device/invalid-description',
        message: `Device ${JSON.stringify(devicePath)} symbol declares an empty pin id.`,
      });
      failed = true;
      continue;
    }
    if (!isRecord(anchor) || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) {
      diagnostics.push({
        severity: 'error',
        code: 'device/invalid-description',
        message: `Device ${JSON.stringify(devicePath)} pin ${JSON.stringify(pinId)} must have finite x and y anchors.`,
      });
      failed = true;
      continue;
    }
    pins[pinId] = { x: anchor.x as number, y: anchor.y as number };
  }
  return failed ? undefined : pins;
}

function readBounds(
  value: unknown,
  devicePath: string,
  diagnostics: Diagnostic[],
): Rect | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y) ||
    !Number.isFinite(value.width) ||
    !Number.isFinite(value.height)
  ) {
    diagnostics.push({
      severity: 'error',
      code: 'device/invalid-description',
      message: `Device ${JSON.stringify(devicePath)} symbol bounds must have finite x, y, width and height.`,
    });
    return undefined;
  }
  return {
    x: value.x as number,
    y: value.y as number,
    width: value.width as number,
    height: value.height as number,
  };
}

function readDeclaredPinIds(value: unknown): Set<string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return new Set(Object.keys(value));
}
