export function invalidType(path: string, value: unknown, constraint: string): never {
  let display: string;
  try {
    display = String(value);
  } catch {
    display = '<unprintable>';
  }
  throw new TypeError(`${path}: ${display} must ${constraint}`);
}

export function checkIdentity(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    invalidType(path, value, 'be a nonempty string');
  }
}

export function checkFinite(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalidType(path, value, 'be a finite number');
  }
}

export function checkRange(value: number, min: number, max: number, path: string): void {
  if (value < min || value > max) {
    throw new RangeError(`${path}: ${value} must be within [${min}, ${max}]`);
  }
}

export function checkInteger(value: unknown, min: number, max: number, path: string): void {
  checkFinite(value, path);
  if (!Number.isInteger(value)) invalidType(path, value, 'be an integer');
  checkRange(value, min, max, path);
}

export function checkSupply(value: unknown): asserts value is number {
  checkFinite(value, 'supplyVoltage');
  if (value < 0) {
    throw new RangeError(`supplyVoltage: ${value} must be nonnegative`);
  }
}

export function checkRecord(
  value: unknown,
  path: string,
  fields: readonly string[],
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalidType(path, value, 'be an object');
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !fields.includes(key)) {
      invalidType(`${path}.${String(key)}`, Reflect.get(value, key), 'be a supported field');
    }
  }
}

export function checkBoolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== 'boolean') invalidType(path, value, 'be a boolean');
}

export function checkChoice<T extends string>(
  value: unknown,
  choices: readonly T[],
  path: string,
): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) {
    invalidType(path, value, `be one of ${choices.join(', ')}`);
  }
  return value as T;
}
