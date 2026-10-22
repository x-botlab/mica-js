/**
 * A plain JSON-like record: a non-array object whose prototype is `Object.prototype` (any realm)
 * or `null`. Map, Set, Date, class instances and module namespaces are rejected.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    if (Object.prototype.toString.call(value) !== '[object Object]') {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || Object.getPrototypeOf(prototype) === null;
  } catch {
    return false;
  }
}

/** Any non-array object, including an ES module namespace. */
export function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
