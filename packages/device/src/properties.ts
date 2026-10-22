import {
  normalizePropertyValue,
  propertyValueProblem,
  type PropertyValue,
} from '@mica-js/core/schematic';
import { DeviceError } from './errors';
import { isPlainRecord } from './internal/records';
import type { DeviceDescription, DevicePropertySnapshot } from './types';

/**
 * Resolves the fixed property snapshot of one device instance (#7 / #8).
 *
 * Declared defaults are applied, instance overrides are validated and colors are normalized.
 * Undeclared override keys are ignored. A declaration without a usable default and without an
 * override contributes no entry. Every call returns a fresh, deeply frozen tree, so callers'
 * mutable aliases cannot change the snapshot and runtime writes are rejected.
 *
 * @throws {DeviceError} when an override violates its property descriptor.
 */
export function resolveDeviceProperties(
  description: DeviceDescription,
  overrides: Readonly<Record<string, PropertyValue>> = {},
): DevicePropertySnapshot {
  if (!isPlainRecord(overrides)) {
    throw new DeviceError('schema/invalid-type', 'Property overrides must be an object.', {
      deviceId: description.name,
      pointer: '/overrides',
    });
  }
  const snapshot: Record<string, PropertyValue> = Object.create(null);
  for (const [key, descriptor] of description.properties) {
    const override = Object.prototype.hasOwnProperty.call(overrides, key)
      ? overrides[key]
      : undefined;
    const candidate = override === undefined ? descriptor.default : override;
    if (candidate === undefined) {
      continue;
    }
    const problem = propertyValueProblem(descriptor, candidate);
    if (problem !== undefined) {
      throw new DeviceError(problem.code, problem.message, {
        deviceId: description.name,
        pointer:
          override === undefined
            ? `/properties/${escapePointer(key)}`
            : `/overrides/${escapePointer(key)}`,
      });
    }
    snapshot[key] = deepFreezeClone(normalizePropertyValue(descriptor, candidate)) as PropertyValue;
  }
  return Object.freeze(snapshot);
}

/**
 * Clones a property value tree and freezes every object and array in it.
 * Exported for focused structural tests; the package root only exposes the snapshot API.
 */
export function deepFreezeClone(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => deepFreezeClone(entry)));
  }
  const copy: Record<string, unknown> = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    copy[key] = deepFreezeClone(entry);
  }
  return Object.freeze(copy);
}

function escapePointer(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}
