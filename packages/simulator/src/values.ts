import type { DeclarationIR, ValueTypeIR } from '@mica-js/device-model';
import type { BorrowedBytes, ReadonlyBytes } from './types';

export function dataObject(
  value: unknown,
  fields?: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    throw new TypeError('Expected a plain data object');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) throw new TypeError('Accessor properties are not allowed');
    if (typeof key !== 'string' || (fields && !fields.includes(key)))
      throw new TypeError(`Unknown field ${String(key)}`);
  }
}
export function finite(value: unknown, name = 'value'): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new TypeError(`${name} must be finite`);
  return value;
}
export function integer(value: unknown, name = 'value'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new TypeError(`${name} must be a safe integer`);
  return value;
}
export function nonnegative(value: unknown, name = 'value'): number {
  const n = integer(value, name);
  if (n < 0) throw new RangeError(`${name} must be nonnegative`);
  return n;
}
export function identity(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new TypeError('Expected a nonempty identifier');
  return value;
}
export function range(memory: Uint8Array, offset: unknown, length: unknown): number {
  const at = nonnegative(offset, 'offset');
  const size = nonnegative(length, 'length');
  if (at > memory.length || size > memory.length - at)
    throw new RangeError('Memory range is out of bounds');
  return at;
}
export function same(a: unknown, b: unknown): boolean {
  if (
    a === b ||
    (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b))
  )
    return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = Object.keys(a),
    right = Object.keys(b);
  return (
    left.length === right.length &&
    left.every(
      (key) =>
        Object.hasOwn(b, key) &&
        same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}
export function snapshot(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Uint8Array) return value.slice();
  if (Array.isArray(value)) return Object.freeze(value.map(snapshot));
  return Object.freeze(
    Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item)])),
  );
}
export function bytesView(
  bytes: Uint8Array,
  check: () => void = () => {},
): ReadonlyBytes | BorrowedBytes {
  const target = Object.freeze({
    get length() {
      check();
      return bytes.length;
    },
    get byteLength() {
      check();
      return bytes.length;
    },
    slice(start?: number, end?: number) {
      check();
      return bytes.slice(start, end);
    },
    *[Symbol.iterator]() {
      for (let i = 0; i < bytes.length; i++) {
        check();
        yield bytes[i]!;
      }
      check();
    },
  });
  return new Proxy(target, {
    get(object, key, receiver) {
      check();
      if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) return bytes[Number(key)];
      return Reflect.get(object, key, receiver);
    },
    set() {
      throw new TypeError('Bytes are read-only');
    },
    defineProperty() {
      throw new TypeError('Bytes are read-only');
    },
  }) as unknown as ReadonlyBytes;
}
export function captureValue(
  type: ValueTypeIR,
  value: unknown,
  declarations: ReadonlyMap<string, DeclarationIR>,
  property = false,
): unknown {
  if (type.kind === 'optional') {
    if (value === null) return null;
    return captureValue(type.inner, value, declarations, property);
  }
  switch (type.kind) {
    case 'number':
      if (typeof value !== 'number') throw new TypeError('Expected number');
      if (property && !Number.isFinite(value)) throw new TypeError('Property must be finite');
      return value;
    case 'bool':
      if (typeof value !== 'boolean') throw new TypeError('Expected boolean');
      return value;
    case 'string':
      if (typeof value !== 'string') throw new TypeError('Expected string');
      return value;
    case 'bytes':
      if (!(value instanceof Uint8Array)) throw new TypeError('Expected Uint8Array');
      return value.slice();
    case 'enum': {
      const members =
        type.name === 'Logic'
          ? ['low', 'high', 'unknown']
          : type.name === 'SampleStatus'
            ? ['valid', 'floating']
            : type.name === 'Overflow'
              ? ['drop_new', 'drop_oldest', 'error']
              : (declarations.get(type.name) as Extract<DeclarationIR, { kind: 'enum' }>)?.members;
      if (typeof value !== 'string' || !members?.includes(value))
        throw new TypeError(`Invalid ${type.name} member`);
      return value;
    }
    case 'record': {
      dataObject(value);
      const declaration = declarations.get(type.name) as Extract<DeclarationIR, { kind: 'record' }>;
      return Object.freeze(
        Object.fromEntries(
          declaration.fields.map((field) => [
            field.name,
            captureValue({ kind: field.type }, value[field.name], declarations),
          ]),
        ),
      );
    }
    case 'sample':
    case 'intent':
      return value;
  }
}
export function externalValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return bytesView(value.slice());
  return snapshot(value);
}
export function randomState(seed: number, id: string, override?: readonly number[]): Uint32Array {
  if (override !== undefined) {
    if (!Array.isArray(override) || override.length !== 4)
      throw new TypeError('randomState must contain four words');
    for (const word of override) {
      integer(word);
      if (word < 0 || word > 0xffffffff) throw new RangeError('randomState word out of range');
    }
    if (!override.some(Boolean)) throw new RangeError('randomState cannot be zero');
    return Uint32Array.from(override);
  }
  let h = 2166136261;
  const encoded = new TextEncoder().encode(id);
  const source = new Uint8Array(4 + encoded.length);
  new DataView(source.buffer).setUint32(0, seed, true);
  source.set(encoded, 4);
  for (const byte of source) h = Math.imul(h ^ byte, 16777619) >>> 0;
  const result = new Uint32Array(4);
  for (let i = 0; i < 4; i++) {
    h = (h + 0x9e3779b9) >>> 0;
    let z = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    result[i] = (z ^ (z >>> 16)) >>> 0;
  }
  if (!result.some(Boolean)) result[0] = 1;
  return result;
}
export function nextRandom(s: Uint32Array): number {
  const rot = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;
  const result = Math.imul(rot(Math.imul(s[1]!, 5), 7), 9) >>> 0;
  const t = s[1]! << 9;
  s[2] = s[2]! ^ s[0]!;
  s[3] = s[3]! ^ s[1]!;
  s[1] = s[1]! ^ s[2]!;
  s[0] = s[0]! ^ s[3]!;
  s[2] = s[2]! ^ t;
  s[3] = rot(s[3]!, 11);
  return result / 4294967296;
}
