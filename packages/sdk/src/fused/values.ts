/** Value-domain helpers of the fused model API (RFC 0021). */
import type { Value } from '@mica-js/document/fused';

/** Whether `value` is a thenable; model hooks must stay synchronous. */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export function valuePath(path: readonly string[]): string {
  return path.length === 0 ? '$' : `$${path.map((key) => `[${JSON.stringify(key)}]`).join('')}`;
}

export function describeValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (value instanceof Uint8Array) {
    return 'Uint8Array';
  }
  return typeof value;
}

/**
 * Captures an independent immutable snapshot of one model value.
 *
 * Bytes are copied, arrays and objects are re-created and frozen, so later changes of the source
 * cannot reach the returned value. Non-value shapes (functions, `undefined`, class instances,
 * cycles, non-finite numbers) are rejected with the value path that violated the domain.
 */
export function snapshotValue(value: unknown, path: readonly string[] = []): Value {
  return clone(value, path, new Set<object>());
}

/** Copies an already captured value so every receiver owns independent bytes. */
export function copyValue(value: Value): Value {
  return clone(value, [], new Set<object>());
}

function clone(value: unknown, path: readonly string[], stack: Set<object>): Value {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`${valuePath(path)}: a model value number must be finite`);
      }
      return value;
    case 'object':
      break;
    default:
      throw new TypeError(
        `${valuePath(path)}: ${typeof value} is not part of the model value domain`,
      );
  }
  if (value === null) {
    return null;
  }
  if (value instanceof Uint8Array) {
    return value.slice();
  }
  if (stack.has(value)) {
    throw new TypeError(`${valuePath(path)}: a model value must not contain a cycle`);
  }
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(
        value.map((item, index) => clone(item, [...path, String(index)], stack)),
      );
    }
    if (!isPlainObject(value)) {
      throw new TypeError(
        `${valuePath(path)}: only plain objects are part of the model value domain`,
      );
    }
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, clone(item, [...path, key], stack)]),
      ),
    );
  } finally {
    stack.delete(value);
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** One `Uint8Array` member of a captured value together with its index path. */
export interface ByteView {
  readonly view: Uint8Array;
  readonly path: readonly string[];
}

/**
 * Collects every `Uint8Array` member of a captured value.
 *
 * `fireTransferred` uses it to prove that the caller handed over complete buffers.
 */
export function byteViews(
  value: unknown,
  path: readonly string[] = [],
  found: ByteView[] = [],
): ByteView[] {
  if (value instanceof Uint8Array) {
    found.push({ view: value, path });
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => byteViews(item, [...path, String(index)], found));
    return found;
  }
  if (typeof value === 'object' && value !== null && isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      byteViews(item, [...path, key], found);
    }
  }
  return found;
}
