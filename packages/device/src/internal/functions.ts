export type CallableKind =
  'function' | 'async' | 'generator' | 'async-generator' | 'class' | 'other';

/**
 * Classifies a callable without trusting `constructor.name`.
 *
 * `Object.prototype.toString` distinguishes ordinary, async and generator functions across
 * realms. Class detection uses the function source because classes are still tagged
 * `[object Function]`; bound classes cannot be detected statically and fail on call instead.
 */
export function callableKind(value: unknown): CallableKind {
  if (typeof value !== 'function') {
    return 'other';
  }
  const tag = Object.prototype.toString.call(value);
  switch (tag) {
    case '[object AsyncFunction]':
      return 'async';
    case '[object GeneratorFunction]':
      return 'generator';
    case '[object AsyncGeneratorFunction]':
      return 'async-generator';
    case '[object Function]':
      break;
    default:
      return 'other';
  }
  let source: string;
  try {
    source = Function.prototype.toString.call(value).trimStart();
  } catch {
    return 'function';
  }
  return /^class\b/.test(source) ? 'class' : 'function';
}

/** A synchronous non-generator, non-class function. */
export function isSynchronousFunction(value: unknown): value is (...args: never[]) => unknown {
  return callableKind(value) === 'function';
}

export function isThenable(value: unknown): boolean {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return false;
  }
  try {
    return typeof (value as { readonly then?: unknown }).then === 'function';
  } catch {
    return false;
  }
}

/** Consumes a rejected thenable so a rejected factory result cannot become unhandled. */
export function consumeThenable(value: unknown): void {
  try {
    void Promise.resolve(value).catch(() => undefined);
  } catch {
    // A hostile thenable must not replace the synchronous contract error.
  }
}
