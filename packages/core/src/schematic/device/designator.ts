import type { SchematicDocument } from '../../format/types';
import { designatorOf, parseDeviceReference } from './reference';
import type { DeviceSymbolProvider } from './symbol';

/** Prefix used when neither the host nor the device description provides one. */
export const DEFAULT_DESIGNATOR_PREFIX = 'U';

/**
 * Picks the reference designator of a newly placed component. Hosts replace this when their
 * naming rules go beyond the device's own prefix.
 */
export type DesignatorFactory = (device: string, document: SchematicDocument) => string;

/** Smallest unused `<prefix><n>` designator. */
export function nextDesignator(
  document: SchematicDocument,
  prefix: string = DEFAULT_DESIGNATOR_PREFIX,
): string {
  const used = new Set(
    document.sheet.symbols
      .map((symbol) => designatorOf(symbol))
      .filter((designator): designator is string => designator !== undefined),
  );
  for (let index = 1; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const candidate = `${prefix}${index}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  return prefix;
}

/**
 * Designator policy derived from the device descriptions: `<device prefix><n>`, falling back to
 * `U` for devices that declare none.
 */
export function createDesignatorFactory(
  devices: DeviceSymbolProvider | undefined,
): DesignatorFactory {
  return (device, document) => nextDesignator(document, designatorPrefixOf(devices, device));
}

/** Prefix the device declares, else {@link DEFAULT_DESIGNATOR_PREFIX}. */
export function designatorPrefixOf(
  devices: DeviceSymbolProvider | undefined,
  device: string,
): string {
  const reference = parseDeviceReference(device);
  const declared =
    reference === undefined ? undefined : devices?.getDeviceDesignatorPrefix?.(reference);
  return declared ?? DEFAULT_DESIGNATOR_PREFIX;
}

/** Default policy for providers without device data: `U1`, `U2`, … */
export const defaultDesignatorFactory: DesignatorFactory = (device, document) =>
  nextDesignator(document);
