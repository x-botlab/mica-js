/**
 * Guest-side argument checks for `api.audio` (RFC 0016, 校验).
 *
 * The guest checks exist for author feedback only: the host and the worklet re-validate every
 * instruction they receive. Nothing here mutates its input.
 */

const EMPTY: Readonly<Record<string, unknown>> = Object.freeze({});

export const OSCILLATOR_TYPES = ['sine', 'square', 'triangle', 'sawtooth'] as const;
export const AUDIO_FORMATS = ['s16', 'f32'] as const;
export const SAMPLE_RATES = { min: 8000, max: 96000 } as const;
export const BUFFER_MS = { min: 50, max: 2000 } as const;
export const VOLUME_RANGE = { min: 0, max: 1 } as const;
export const FREQUENCY_RANGE = { min: 0, max: 24000 } as const;
export const RAMP_MS = { min: 0, max: 10000 } as const;

/**
 * Reads an options object: missing is fine, anything that is not a plain object, an unknown key or
 * a key explicitly set to `undefined` is a `TypeError`.
 */
export function readOptions(
  value: unknown,
  keys: readonly string[],
  path: string,
): Readonly<Record<string, unknown>> {
  if (value === undefined) return EMPTY;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    throw new TypeError(`${path} must be a plain object`);
  }

  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${path} does not accept the option "${key}"`);
    }
    if (record[key] === undefined) {
      throw new TypeError(`${path}.${key} must not be undefined`);
    }
  }
  return record;
}

/** Number check shared by every numeric option: wrong type is a `TypeError`, NaN is out of range. */
export function readNumber(value: unknown, path: string, fallback: number): number;
export function readNumber(value: unknown, path: string): number;
export function readNumber(value: unknown, path: string, fallback?: number): number {
  if (value === undefined) {
    if (fallback === undefined) throw new TypeError(`${path} is required`);
    return fallback;
  }
  if (typeof value !== 'number') throw new TypeError(`${path} must be a number`);
  if (!Number.isFinite(value)) throw new RangeError(`${path} must be a finite number`);
  return value;
}

export interface NumberRange {
  readonly min: number;
  readonly max: number;
  /** Defaults to inclusive lower bound; use it for `frequency`, which excludes `0`. */
  readonly exclusiveMin?: boolean;
  readonly integer?: boolean;
}

/** Range check; both bounds are inclusive unless `exclusiveMin` is set. */
export function assertInRange(value: number, range: NumberRange, path: string): number {
  if (range.integer === true && !Number.isInteger(value)) {
    throw new RangeError(`${path} must be an integer`);
  }
  const belowMin = range.exclusiveMin === true ? value <= range.min : value < range.min;
  if (belowMin || value > range.max) {
    const bounds =
      range.exclusiveMin === true ? `(${range.min}, ${range.max}]` : `[${range.min}, ${range.max}]`;
    throw new RangeError(`${path} must be in ${bounds}`);
  }
  return value;
}

/** Reads one numeric option and checks its range. */
export function readRangedNumber(
  source: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
  range: NumberRange,
  fallback?: number,
): number {
  const value =
    fallback === undefined
      ? readNumber(source[key], `${path}.${key}`)
      : readNumber(source[key], `${path}.${key}`, fallback);
  return assertInRange(value, range, `${path}.${key}`);
}

/** Reads an optional numeric option; returns `undefined` when the key is absent. */
export function readOptionalRangedNumber(
  source: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
  range: NumberRange,
): number | undefined {
  if (source[key] === undefined) return undefined;
  return readRangedNumber(source, key, path, range);
}

/** Enum check: anything outside `allowed` is a `RangeError`. */
export function readEnum<T extends string | number>(
  source: Readonly<Record<string, unknown>>,
  key: string,
  allowed: readonly T[],
  path: string,
  fallback: T,
): T {
  const value = source[key];
  if (value === undefined) return fallback;
  if (!allowed.includes(value as T)) {
    throw new RangeError(`${path}.${key} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

/** Listener arguments are functions or nothing. */
export function requireListener(value: unknown, path: string): void {
  if (typeof value !== 'function') {
    throw new TypeError(`${path} must be a function`);
  }
}
