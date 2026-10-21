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

/** What a placed symbol is for: the single question the rest of the code asks about it. */
export type SymbolRole = 'component' | 'net-label' | 'power' | 'ground' | 'text';

/** Role of a symbol, derived from its device reference; unknown devices are components. */
export function symbolRole(device: string): SymbolRole {
  switch (builtinSymbolKind(device)) {
    case 'label':
      return 'net-label';
    case 'power':
      return 'power';
    case 'ground':
      return 'ground';
    default:
      return isTextDevice(device) ? 'text' : 'component';
  }
}

/** Only components are annotated with a reference designator. */
export function hasDesignator(role: SymbolRole): boolean {
  return role === 'component';
}

/** Net labels, power and ground ports name the net they attach to. */
export function namesNet(role: SymbolRole): boolean {
  return role === 'net-label' || role === 'power' || role === 'ground';
}

/** Reference designator of a component; `undefined` for symbols that have none. */
export function designatorOf(symbol: {
  readonly id: string;
  readonly device: string;
  readonly designator?: string;
}): string | undefined {
  return hasDesignator(symbolRole(symbol.device)) ? (symbol.designator ?? symbol.id) : undefined;
}

/** Net name of a label / power / ground symbol; `undefined` when the symbol names no net. */
export function netNameOf(symbol: {
  readonly device: string;
  readonly net?: string;
}): string | undefined {
  switch (symbolRole(symbol.device)) {
    case 'power':
      return symbol.net ?? DEFAULT_POWER_LABEL;
    case 'ground':
      return symbol.net ?? DEFAULT_GROUND_LABEL;
    case 'net-label':
      return symbol.net;
    default:
      return undefined;
  }
}

/** Net name a freshly placed symbol of `role` gets when none is given. */
export function defaultNetName(role: SymbolRole): string | undefined {
  switch (role) {
    case 'power':
      return DEFAULT_POWER_LABEL;
    case 'ground':
      return DEFAULT_GROUND_LABEL;
    default:
      return undefined;
  }
}

export function formatDeviceReference(packageId: string, deviceId: string): string {
  return `${packageId}:${deviceId}`;
}
