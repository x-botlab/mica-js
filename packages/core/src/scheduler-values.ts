import { evaluateFloatInstruction, evaluateScalarInstruction, SCALAR_TYPES } from '@mica/ir';
import type { RuntimeScalar, ScalarType, Value } from '@mica/ir';

export function scalarType(value: unknown): value is ScalarType {
  return typeof value === 'string' && (SCALAR_TYPES as readonly string[]).includes(value);
}

export function captureArgs(
  types: readonly ScalarType[],
  args: readonly RuntimeScalar[],
): readonly RuntimeScalar[] {
  if (!Array.isArray(args) || args.length !== types.length) {
    throw new TypeError(`Expected ${types.length} scalar arguments`);
  }
  return Object.freeze(
    types.map((type, index) => {
      const input = { type } as Value;
      const node = {
        op: 'select',
        operands: [
          { kind: 'ssa' as const, value: { type: 'bool' } as Value<'bool'> },
          { kind: 'ssa' as const, value: input },
          { kind: 'ssa' as const, value: input },
        ],
        results: [input],
      };
      const value = args[index]!;
      const result =
        type === 'f32' || type === 'f64'
          ? evaluateFloatInstruction(node, [true, value, value])
          : evaluateScalarInstruction(node, [true, value, value] as readonly (boolean | number)[]);
      return typeof result === 'object'
        ? Object.freeze({ type: result.type, bits: result.bits })
        : result;
    }),
  );
}

export function synchronous(fn: unknown): fn is (...args: never[]) => unknown {
  return typeof fn === 'function' && Object.prototype.toString.call(fn) === '[object Function]';
}

export function returnedSynchronously(value: unknown): boolean {
  if (value === undefined) return true;
  if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
    if (typeof (value as { then?: unknown }).then === 'function') {
      void Promise.resolve(value).catch(() => undefined);
    }
  }
  return false;
}
