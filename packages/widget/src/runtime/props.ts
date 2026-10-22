import type { PropertyDefinition } from '../types';
import type { WidgetAssetRef } from './types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Deep-copies plain data and freezes every container on the way back up. Typed arrays and other
 * objects are returned untouched: they are not part of the JSON-shaped property format, and
 * freezing a typed array with elements throws.
 */
function cloneFrozen(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneFrozen(item)));
  }
  if (isPlainObject(value)) {
    const entries: [string, unknown][] = [];
    for (const key of Object.keys(value)) entries.push([key, cloneFrozen(value[key])]);
    return Object.freeze(Object.fromEntries(entries));
  }
  return value;
}

function isAssetMode(value: unknown): value is WidgetAssetRef['mode'] {
  return value === 'file' || value === 'inline' || value === 'store';
}

/**
 * Merges `definition.properties[*].default` under the props a document supplied.
 *
 * A key present in `props` wins, even when its value is `undefined`; a key is only filled from the
 * definition when the descriptor declares `default` itself, so `default: null` and "no default"
 * stay distinguishable. Defaults are cloned and deeply frozen per instance, so a widget cannot
 * mutate the definition or leak changes into another instance.
 */
export function mergeProperties(
  properties: Readonly<Record<string, PropertyDefinition>> | undefined,
  props: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  const merged = new Map<string, unknown>();

  for (const key of Object.keys(properties ?? {})) {
    const descriptor = properties?.[key];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'default')) continue;
    merged.set(key, cloneFrozen(descriptor.default));
  }
  for (const key of Object.keys(props ?? {})) {
    merged.set(key, props?.[key]);
  }

  return Object.freeze(Object.fromEntries(merged));
}

/**
 * Collects image / binary property values (`{ src, mode }`) from nested objects and arrays.
 * Results are keyed by `src`, so one resource referenced twice is only read once.
 */
export function collectAssetRefs(
  value: unknown,
  found: Map<string, WidgetAssetRef> = new Map(),
  seen: Set<object> = new Set(),
): Map<string, WidgetAssetRef> {
  if (typeof value !== 'object' || value === null) return found;
  if (seen.has(value)) return found;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) collectAssetRefs(item, found, seen);
    return found;
  }
  if (!isPlainObject(value)) return found;

  const candidate = value as { src?: unknown; mode?: unknown };
  if (typeof candidate.src === 'string' && isAssetMode(candidate.mode)) {
    if (!found.has(candidate.src)) {
      found.set(candidate.src, { src: candidate.src, mode: candidate.mode });
    }
  }
  for (const key of Object.keys(value)) collectAssetRefs(value[key], found, seen);
  return found;
}
