import type { ReactionFrame, ExecutionSignal } from './types.js';

/** Nominal enum identity is validated statically; runtime values are member names. */
export type EnumValue = string;

export function createEnum(_name: string, member: string): EnumValue {
  return member;
}

export function createRecord(
  fields: readonly (readonly [string, unknown])[],
): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(fields));
}

export function createBytes(elements: readonly unknown[]): Uint8Array {
  const bytes = new Uint8Array(elements.length);
  for (let index = 0; index < elements.length; index++) {
    const value = elements[index];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new TypeError('Byte value must be an integer number');
    }
    if (value < 0 || value > 255) throw new RangeError('Byte value must be in [0, 255]');
    bytes[index] = value;
  }
  return bytes;
}

/** Shared empty intent: the same array is the "no contribution" value for every pin. */
const noBranches: readonly unknown[] = Object.freeze([]);

export function combineIntents(values: readonly unknown[]): readonly unknown[] {
  // A single array already is a frozen branch list, and the empty case is a singleton:
  // both keep identity stable, which the host uses to skip unchanged intent writes.
  if (values.length === 0) return noBranches;
  if (values.length === 1 && Array.isArray(values[0])) return values[0] as readonly unknown[];
  const branches: unknown[] = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const branch of value) branches.push(branch);
    } else branches.push(value);
  }
  return Object.freeze(branches);
}

/** Structural comparison deliberately does not shortcut identical objects containing NaN. */
export function equalValues(left: unknown, right: unknown): boolean {
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return left === right;
  }
  if (isByteSequence(left) || isByteSequence(right)) {
    if (!isByteSequence(left) || !isByteSequence(right) || left.length !== right.length)
      return false;
    for (let i = 0; i < left.length; i++) {
      if (left[i] !== right[i]) return false;
    }
    return true;
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(b, key) || !equalValues(a[key], b[key])) return false;
  }
  return true;
}

function isByteSequence(
  value: object,
): value is { readonly length: number; readonly [index: number]: number } {
  return (
    Array.isArray(value) ||
    ArrayBuffer.isView(value) ||
    ('length' in value && Symbol.iterator in value)
  );
}

export function readIndex(value: string | ArrayLike<number>, index: unknown): string | number {
  if (typeof index !== 'number' || !Number.isSafeInteger(index)) {
    throw new TypeError('Index must be a safe integer number');
  }
  if (index < 0 || index >= value.length) throw new RangeError('Index is outside the value');
  return value[index]!;
}

export function nonNull(value: unknown): unknown {
  if (value === null) throw new TypeError('Expected a non-null value');
  return value;
}

export function checkBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError('Condition must be a boolean');
  return value;
}

export function checkDuration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new TypeError('Duration must be a finite integer number');
  }
  if (value < 0 || value > 7_200_000_000_000_000) {
    throw new RangeError('Duration must be in [0, 7200000000000000] picoseconds');
  }
  return value;
}

export function checkPc(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('Redirect target must be a finite number');
  }
  return value;
}

export function reactionValue(
  frame: ReactionFrame | undefined,
  binding: 'previous' | 'current',
): unknown {
  if (!frame) throw new TypeError('Reaction value requires a reaction frame');
  return frame[binding];
}

export function reactionCapture(frame: ReactionFrame | undefined, index: number): unknown {
  if (!frame || index >= frame.captures.length) {
    throw new RangeError('Reaction capture is not available');
  }
  return frame.captures[index];
}

const terminated = Symbol('terminated call');

/** Propagate terminal control across yield* even if a driver mistakenly resumes it. */
function* delegate(
  generator: Generator<ExecutionSignal, unknown, unknown>,
): Generator<ExecutionSignal, unknown, unknown> {
  let done = false;
  try {
    let step = generator.next();
    while (!step.done) {
      const signal = step.value;
      const input: unknown = yield signal;
      if (signal.kind === 'stop' || signal.kind === 'redirect') return terminated;
      step = generator.next(input);
    }
    done = true;
    return step.value;
  } finally {
    if (!done) generator.return(undefined);
  }
}

export const runtimeHelpers = Object.freeze({
  createEnum,
  createRecord,
  createBytes,
  combineIntents,
  equalValues,
  readIndex,
  nonNull,
  checkBoolean,
  checkDuration,
  checkPc,
  reactionValue,
  reactionCapture,
  delegate,
  terminated,
});
