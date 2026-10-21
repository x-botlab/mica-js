import type { SchematicDocument } from '../format/types';
import { designatorOf } from './reference';

/** Prefix used when the host does not provide a device-specific one. */
export const DEFAULT_DESIGNATOR_PREFIX = 'U';

/**
 * Picks the reference designator of a newly placed component. Hosts replace this when their
 * device library knows the right prefix (`R`, `C`, `Q`, …).
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

/** Default policy: `U1`, `U2`, … regardless of the device. */
export const defaultDesignatorFactory: DesignatorFactory = (device, document) =>
  nextDesignator(document);
