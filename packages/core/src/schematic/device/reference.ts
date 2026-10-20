export const LABEL_DEVICE = 'builtin:label';
export const POWER_DEVICE = 'builtin:power';
export const GROUND_DEVICE = 'builtin:ground';
/** Free-standing annotation; it is not a connection point and never joins a net. */
export const TEXT_DEVICE = 'builtin:text';
export const RESERVED_PACKAGE_NAMESPACE = 'builtin';

/** Builtin symbols recognised by the loader instead of the device registry. */
export type BuiltinSymbolKind = 'label' | 'power' | 'ground';

const BUILTIN_DEVICES: Readonly<Record<string, BuiltinSymbolKind>> = {
  [LABEL_DEVICE]: 'label',
  [POWER_DEVICE]: 'power',
  [GROUND_DEVICE]: 'ground',
};

export const DEFAULT_POWER_LABEL = 'VCC';
export const DEFAULT_GROUND_LABEL = 'GND';
export const DEFAULT_TEXT_CONTENT = '文本';

export interface DeviceReference {
  readonly raw: string;
  readonly packageId: string;
  readonly deviceId: string;
}

const PACKAGE_NAMESPACE_PATTERN = /^@[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const PACKAGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/**
 * Splits `<packageId>:<deviceId>`. Package ids follow npm conventions and may be scoped
 * (`@scope/name`); the device id uses a conservative identifier charset until #3 / #11 finalize it.
 */
export function parseDeviceReference(raw: string): DeviceReference | undefined {
  const separator = raw.indexOf(':');
  if (separator <= 0 || separator === raw.length - 1) {
    return undefined;
  }
  if (raw.indexOf(':', separator + 1) !== -1) {
    return undefined;
  }
  const packageId = raw.slice(0, separator);
  const deviceId = raw.slice(separator + 1);
  if (!isValidPackageId(packageId) || !DEVICE_ID_PATTERN.test(deviceId)) {
    return undefined;
  }
  return { raw, packageId, deviceId };
}

export function isValidPackageId(packageId: string): boolean {
  if (packageId.startsWith('@')) {
    const parts = packageId.split('/');
    if (parts.length !== 2) {
      return false;
    }
    const [scope, name] = parts;
    return (
      scope !== undefined &&
      name !== undefined &&
      PACKAGE_NAMESPACE_PATTERN.test(scope) &&
      PACKAGE_NAME_PATTERN.test(name)
    );
  }
  return PACKAGE_NAME_PATTERN.test(packageId);
}

/** `builtin` is reserved for loader-provided symbols such as `builtin:label`. */
export function isReservedPackageId(packageId: string): boolean {
  return (
    packageId === RESERVED_PACKAGE_NAMESPACE ||
    packageId.startsWith(`${RESERVED_PACKAGE_NAMESPACE}/`)
  );
}

export function isLabelDevice(raw: string): boolean {
  return raw === LABEL_DEVICE;
}

/** True for the free-standing text annotation (`builtin:text`). */
export function isTextDevice(raw: string): boolean {
  return raw === TEXT_DEVICE;
}

/** Text of a `builtin:text` symbol, falling back to a placeholder. */
export function textDeviceContent(symbol: {
  readonly properties?: Readonly<Record<string, unknown>>;
}): string {
  const text = symbol.properties?.['text'];
  return typeof text === 'string' && text.length > 0 ? text : DEFAULT_TEXT_CONTENT;
}

/** Returns the builtin kind for `builtin:label` / `builtin:power` / `builtin:ground`. */
export function builtinSymbolKind(raw: string): BuiltinSymbolKind | undefined {
  return BUILTIN_DEVICES[raw];
}

export function isBuiltinDevice(raw: string): boolean {
  return builtinSymbolKind(raw) !== undefined;
}

export function formatDeviceReference(packageId: string, deviceId: string): string {
  return `${packageId}:${deviceId}`;
}
