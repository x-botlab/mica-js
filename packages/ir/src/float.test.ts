import { describe, expect, it } from 'vitest';
import {
  createIRModule,
  evaluateFloatInstruction,
  IRFloatEvaluationError,
  validateIR,
  type FloatBits,
  type FloatType,
  type HexBits,
  type InstructionNode,
  type IntegerType,
  type RuntimeScalar,
  type ScalarType,
} from './index';
import { valueKind } from './types';

function node(
  op: string,
  types: readonly ScalarType[],
  target: ScalarType,
  literal?: string | number,
): InstructionNode {
  const operands: InstructionNode['operands'][number][] = types.map((type) => ({
    kind: 'ssa',
    value: { [valueKind]: 'ssa-value', type },
  }));
  if (literal !== undefined) operands.unshift({ kind: 'literal', value: literal });
  return { op, operands, results: [{ [valueKind]: 'ssa-value', type: target }] };
}

function bits(type: FloatType, raw: HexBits): FloatBits {
  return { type, bits: raw };
}

function encoding(type: FloatType, value: number): FloatBits {
  const view = new DataView(new ArrayBuffer(8));
  if (type === 'f32') {
    view.setFloat32(0, value);
    return bits(type, `0x${view.getUint32(0).toString(16).padStart(8, '0')}`);
  }
  view.setFloat64(0, value);
  return bits(type, `0x${view.getBigUint64(0).toString(16).padStart(16, '0')}`);
}

function numeric(value: RuntimeScalar): number {
  if (typeof value !== 'object') throw new Error('Expected FloatBits');
  const view = new DataView(new ArrayBuffer(8));
  if (value.type === 'f32') {
    view.setUint32(0, Number(BigInt(value.bits)));
    return view.getFloat32(0);
  }
  view.setBigUint64(0, BigInt(value.bits));
  return view.getFloat64(0);
}

function operation(type: FloatType, op: string, ...operands: RuntimeScalar[]): RuntimeScalar {
  return evaluateFloatInstruction(
    node(
      `float.${op}`,
      operands.map(() => type),
      type,
    ),
    operands,
  );
}

function convert(
  source: ScalarType,
  target: ScalarType,
  op: string,
  value: RuntimeScalar,
): RuntimeScalar {
  return evaluateFloatInstruction(node(op, [source], target, target), [value]);
}

function error(action: () => unknown, code: IRFloatEvaluationError['code']) {
  expect(action).toThrow(IRFloatEvaluationError);
  try {
    action();
  } catch (caught) {
    expect((caught as IRFloatEvaluationError).code).toBe(code);
  }
}

describe.each(['f32', 'f64'] as const)('%s exact floating arithmetic', (type) => {
  it.each([
    ['add', 1.5, 2.25, 3.75],
    ['sub', 1.5, 2.25, -0.75],
    ['mul', -1.5, 2.25, -3.375],
    ['div', 3, 2, 1.5],
    ['add', -0, -0, -0],
    ['add', -0, 0, 0],
    ['sub', -0, 0, -0],
    ['sub', -0, -0, 0],
    ['mul', -0, -2, 0],
    ['mul', 0, -2, -0],
    ['div', -0, 2, -0],
    ['div', 1, -0, -Infinity],
    ['div', -1, -0, Infinity],
    ['div', -0, -Infinity, 0],
    ['div', 1, -Infinity, -0],
    ['add', Infinity, 1, Infinity],
    ['sub', -Infinity, 1, -Infinity],
    ['mul', -Infinity, -2, Infinity],
    ['div', -Infinity, 2, -Infinity],
  ] as const)('%s(%s, %s)', (op, a, b, result) => {
    expect(operation(type, op, a, b)).toEqual(encoding(type, result));
  });

  it.each([
    ['add', Infinity, -Infinity],
    ['sub', Infinity, Infinity],
    ['mul', Infinity, 0],
    ['div', 0, 0],
    ['div', Infinity, Infinity],
    ['div', -Infinity, -Infinity],
    ['add', NaN, 1],
  ] as const)('canonicalizes NaN from %s(%s, %s)', (op, a, b) => {
    expect(operation(type, op, a, b)).toEqual(
      bits(type, type === 'f32' ? '0x7fc00000' : '0x7ff8000000000000'),
    );
  });

  it('distinguishes genuinely fused from separate multiplication and addition', () => {
    const epsilon = type === 'f32' ? 2 ** -23 : 2 ** -52;
    const product = operation(type, 'mul', 1 + epsilon, 1 - epsilon);
    expect(operation(type, 'add', product, -1)).toEqual(encoding(type, 0));
    expect(operation(type, 'fma', 1 + epsilon, 1 - epsilon, -1)).toEqual(
      encoding(type, -(epsilon ** 2)),
    );
  });

  it('does not overflow or underflow an intermediate FMA product', () => {
    const maximum = bits(type, type === 'f32' ? '0x7f7fffff' : '0x7fefffffffffffff');
    const negativeMaximum = bits(type, type === 'f32' ? '0xff7fffff' : '0xffefffffffffffff');
    const minimum = bits(type, type === 'f32' ? '0x00000001' : '0x0000000000000001');
    expect(operation(type, 'fma', maximum, 2, negativeMaximum)).toEqual(maximum);
    expect(operation(type, 'mul', maximum, 2)).toEqual(encoding(type, Infinity));
    expect(operation(type, 'fma', minimum, 0.5, minimum)).toEqual(
      bits(type, type === 'f32' ? '0x00000002' : '0x0000000000000002'),
    );
    expect(operation(type, 'add', operation(type, 'mul', minimum, 0.5), minimum)).toEqual(minimum);
  });

  it.each([
    [Infinity, 0, 1, NaN],
    [0, -Infinity, Infinity, NaN],
    [Infinity, 1, -Infinity, NaN],
    [-Infinity, 1, Infinity, NaN],
    [Infinity, 2, Infinity, Infinity],
    [1, 2, -Infinity, -Infinity],
    [NaN, 1, 2, NaN],
    [1, NaN, 2, NaN],
    [1, 2, NaN, NaN],
    [-0, 2, -0, -0],
    [-0, 2, 0, 0],
    [0, -2, -0, -0],
    [1, 1, -1, 0],
  ])('FMA special values (%s, %s, %s)', (a, b, c, expected) => {
    const result = operation(type, 'fma', a, b, c);
    if (Number.isNaN(expected)) {
      expect(result).toEqual(bits(type, type === 'f32' ? '0x7fc00000' : '0x7ff8000000000000'));
    } else expect(result).toEqual(encoding(type, expected));
  });

  it('rounds subnormals with ties to even, signed underflow and no flushing', () => {
    const smallest = type === 'f32' ? 2 ** -149 : Number.MIN_VALUE;
    expect(operation(type, 'mul', smallest, 0.5)).toEqual(encoding(type, 0));
    expect(operation(type, 'mul', -smallest, 0.5)).toEqual(encoding(type, -0));
    expect(operation(type, 'mul', smallest * 3, 0.5)).toEqual(encoding(type, smallest * 2));
    expect(operation(type, 'add', smallest, smallest)).toEqual(encoding(type, smallest * 2));
    expect(operation(type, 'div', smallest, 2)).toEqual(encoding(type, 0));
    const normal = type === 'f32' ? 2 ** -126 : 2 ** -1022;
    expect(operation(type, 'add', normal - smallest, smallest)).toEqual(encoding(type, normal));
  });

  it.each(['eq', 'ne', 'lt', 'le', 'gt', 'ge'])(
    'comparison %s obeys NaN and zero rules',
    (predicate) => {
      const instruction = node('float.cmp', [type, type], 'bool', predicate);
      expect(evaluateFloatInstruction(instruction, [NaN, 1])).toBe(predicate === 'ne');
      expect(evaluateFloatInstruction(instruction, [1, NaN])).toBe(predicate === 'ne');
      expect(evaluateFloatInstruction(instruction, [-0, 0])).toBe(
        ['eq', 'le', 'ge'].includes(predicate),
      );
      expect(evaluateFloatInstruction(instruction, [-1, 2])).toBe(
        ['ne', 'lt', 'le'].includes(predicate),
      );
      expect(evaluateFloatInstruction(instruction, [Infinity, -Infinity])).toBe(
        ['ne', 'gt', 'ge'].includes(predicate),
      );
    },
  );

  it.each([0, -0, 1, -1, Infinity, -Infinity, NaN])('classifies %s', (value) => {
    expect(evaluateFloatInstruction(node('float.isNaN', [type], 'bool'), [value])).toBe(
      Number.isNaN(value),
    );
    expect(evaluateFloatInstruction(node('float.isFinite', [type], 'bool'), [value])).toBe(
      Number.isFinite(value),
    );
  });

  it('matches IEEE binary64 basic operations on deterministic varied raw-bit inputs', () => {
    let seed = 0x12345678;
    const word = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const input = () =>
      bits(
        type,
        `0x${(type === 'f32' ? BigInt(word()) : (BigInt(word()) << 32n) | BigInt(word()))
          .toString(16)
          .padStart(type === 'f32' ? 8 : 16, '0')}`,
      );
    for (let index = 0; index < 192; index += 1) {
      const a = input();
      const b = input();
      const x = numeric(a);
      const y = numeric(b);
      for (const [op, expected] of [
        ['add', x + y],
        ['sub', x - y],
        ['mul', x * y],
        ['div', x / y],
      ] as const) {
        const actual = operation(type, op, a, b);
        if (Number.isNaN(expected)) {
          expect(actual).toEqual(bits(type, type === 'f32' ? '0x7fc00000' : '0x7ff8000000000000'));
        } else expect(actual).toEqual(encoding(type, expected));
      }
    }
  });
});

describe('f32 precision boundaries', () => {
  it('rounds every instruction rather than the end of a chain', () => {
    expect(operation('f32', 'add', operation('f32', 'add', 16777216, 1), -16777216)).toEqual(
      bits('f32', '0x00000000'),
    );
    expect(Math.fround(16777216 + 1 - 16777216)).toBe(1);
  });

  it('avoids f64 intermediate double rounding in FMA', () => {
    const a = 8 + 2 ** -20;
    const b = 8 - 2 ** -20;
    const c = 2 ** 30 + 128;
    expect(operation('f32', 'fma', a, b, c)).toEqual(bits('f32', '0x4e800001'));
    expect(encoding('f32', a * b + c)).toEqual(bits('f32', '0x4e800002'));
  });

  it('rounds numeric inputs to the source precision, including overflow', () => {
    expect(operation('f32', 'sub', 16777217, 16777216)).toEqual(encoding('f32', 0));
    expect(operation('f32', 'add', Number.MAX_VALUE, 0)).toEqual(encoding('f32', Infinity));
    expect(operation('f32', 'add', 1, 2 ** -24)).toEqual(encoding('f32', 1));
    expect(operation('f32', 'add', 1 + 2 ** -23, 2 ** -24)).toEqual(encoding('f32', 1 + 2 ** -22));
  });
});

describe('strict numeric conversion', () => {
  it.each(['u8', 'i8', 'u16', 'i16', 'u32', 'i32'] as const)(
    '%s conversion bounds',
    (integerType) => {
      const width = Number(integerType.slice(1));
      const signed = integerType.startsWith('i');
      const minimum = signed ? -(2 ** (width - 1)) : 0;
      const maximum = 2 ** (width - Number(signed)) - 1;
      for (const floatType of ['f32', 'f64'] as const) {
        for (const value of [minimum, 0, maximum]) {
          expect(convert(integerType, floatType, 'convert.intToFloat', value)).toEqual(
            encoding(floatType, value),
          );
        }
        expect(convert(floatType, integerType, 'convert.floatToInt', -0.9)).toBe(0);
        expect(convert(floatType, integerType, 'convert.floatToInt', 1.9)).toBe(1);
        const belowMinimum = minimum - (floatType === 'f32' && width === 32 ? 256 : 1);
        for (const value of [NaN, Infinity, -Infinity, belowMinimum, maximum + 1]) {
          error(
            () => convert(floatType, integerType, 'convert.floatToInt', value),
            'integer-overflow',
          );
        }
      }
      expect(convert('f64', integerType, 'convert.floatToInt', maximum + 0.9)).toBe(maximum);
      expect(convert('f64', integerType, 'convert.floatToInt', minimum - 0.9)).toBe(minimum);
      error(
        () => convert(integerType, 'f64', 'convert.intToFloat', maximum + 1),
        'invalid-operand',
      );
      error(() => convert(integerType, 'f64', 'convert.intToFloat', 0.5), 'invalid-operand');
    },
  );

  it('uses the quantized source value before checking integer bounds', () => {
    expect(convert('f32', 'u32', 'convert.floatToInt', 4294967040)).toBe(4294967040);
    error(() => convert('f32', 'u32', 'convert.floatToInt', 4294967295), 'integer-overflow');
    expect(convert('f64', 'u32', 'convert.floatToInt', 4294967295.9)).toBe(4294967295);
    expect(convert('f32', 'i32', 'convert.floatToInt', -2147483648)).toBe(-2147483648);
    expect(convert('f32', 'i32', 'convert.floatToInt', 2147483520)).toBe(2147483520);
    error(() => convert('f32', 'i32', 'convert.floatToInt', 2147483647), 'integer-overflow');
  });

  it.each([16777217, 16777219, 4294967295])('rounds integer %s directly to f32', (value) => {
    expect(convert('u32', 'f32', 'convert.intToFloat', value)).toEqual(encoding('f32', value));
  });

  it.each([0, -0, 1.5, Infinity, -Infinity, 2 ** -149, 2 ** -126])(
    'widens f32 %s exactly',
    (value) => {
      expect(convert('f32', 'f64', 'convert.float', value)).toEqual(encoding('f64', value));
    },
  );

  it.each([
    [1 + 2 ** -24, '0x3f800000'],
    [1 + 3 * 2 ** -24, '0x3f800002'],
    [2 ** -150, '0x00000000'],
    [-(2 ** -150), '0x80000000'],
    [3 * 2 ** -150, '0x00000002'],
    [Number.MAX_VALUE, '0x7f800000'],
    [-Number.MAX_VALUE, '0xff800000'],
    [2 ** 128 - 2 ** 103, '0x7f800000'],
    [2 ** 128 - 2 ** 104, '0x7f7fffff'],
    [2 ** -126 - 2 ** -150, '0x00800000'],
  ] as const)('narrows f64 %s with correct boundary rounding', (value, expected) => {
    expect(convert('f64', 'f32', 'convert.float', value)).toEqual(bits('f32', expected));
  });
});

describe('raw data movement is distinct from arithmetic', () => {
  it.each([
    ['f32', '0x7f801234'],
    ['f32', '0xffc01234'],
    ['f64', '0x7ff0000000001234'],
    ['f64', '0xfff812345678abcd'],
  ] as const)('preserves %s NaN bits %s through constants and selection', (type, raw) => {
    const value = evaluateFloatInstruction(node('const.bits', [], type, raw), []);
    const selected = evaluateFloatInstruction(node('select', ['bool', type, type], type), [
      true,
      value,
      0,
    ]);
    expect(selected).toEqual(bits(type, raw));
    expect(
      evaluateFloatInstruction(node('select', ['bool', type, type], type), [false, 0, selected]),
    ).toBe(selected);
    expect(evaluateFloatInstruction(node('float.isNaN', [type], 'bool'), [selected])).toBe(true);
    expect(operation(type, 'add', selected, 0)).toEqual(
      bits(type, type === 'f32' ? '0x7fc00000' : '0x7ff8000000000000'),
    );
    for (const target of ['f32', 'f64'] as const) {
      expect(convert(type, target, 'convert.float', selected)).toEqual(
        bits(target, target === 'f32' ? '0x7fc00000' : '0x7ff8000000000000'),
      );
    }
    expect(value).toEqual(bits(type, raw));
  });

  it.each([0, 0x80000000, 0x3f800000, 0x00000001, 0x7f800000, 0x7f801234, 0xffc01234])(
    'roundtrips f32 bit pattern %s via both integer types',
    (raw) => {
      for (const integerType of ['u32', 'i32'] as const) {
        const number = integerType === 'i32' ? raw | 0 : raw;
        const value = convert(integerType, 'f32', 'bitcast', number);
        expect(convert('f32', integerType, 'bitcast', value)).toBe(number);
        expect(value).toEqual(bits('f32', `0x${raw.toString(16).padStart(8, '0')}`));
      }
    },
  );

  it.each(['f32', 'f64'] as const)('canonicalizes numeric NaN const for %s', (type) => {
    expect(evaluateFloatInstruction(node('const', [], type, NaN), [])).toEqual(
      bits(type, type === 'f32' ? '0x7fc00000' : '0x7ff8000000000000'),
    );
    expect(evaluateFloatInstruction(node('const', [], type, -0), [])).toEqual(encoding(type, -0));
  });
});

describe('model integration and explicit rejection', () => {
  it('consumes real builder nodes accepted by #42 validation without running a function', () => {
    const module = createIRModule();
    const fn = module.func('example', { params: ['u32', 'f32'], results: ['u32'] });
    fn.body((b, [integer, value]) => {
      const converted = b.convert.intToFloat('f32', integer);
      const fused = b.float.fma(converted, value, b.bits('f32', '0x7f801234'));
      const selected = b.select(b.float.isNaN(fused), fused, value);
      b.convert.floatToInt('i32', b.const('f64', 3.9));
      b.convert.float('f64', selected);
      b.float.cmp('ne', fused, selected);
      b.return([b.bitcast('u32', selected)]);
    });
    const instructions = module.functions[0]!.body!.entry.instructions;
    const supportedInstructions = [
      ...new Set(instructions.map((instruction) => instruction.op)),
      'return',
    ];
    expect(
      validateIR(module, {
        supportedInstructions,
        authorizedInstructions: supportedInstructions,
        resources: [],
      }),
    ).toEqual({ ok: true, diagnostics: [] });
    expect(evaluateFloatInstruction(instructions[0]!, [16777217])).toEqual(
      bits('f32', '0x4b800000'),
    );
    expect(evaluateFloatInstruction(instructions[1]!, [])).toEqual(bits('f32', '0x7f801234'));
    const last = instructions.at(-1)!;
    expect(evaluateFloatInstruction(last, [bits('f32', '0x7f801234')])).toBe(0x7f801234);
  });

  it.each([
    node('float.add', ['f32', 'f64'], 'f32'),
    node('float.add', ['f32', 'f32'], 'f64'),
    node('float.fma', ['f32', 'f32'], 'f32'),
    node('float.isNaN', ['u32'], 'bool'),
    node('float.cmp', ['f32', 'f32'], 'bool', 'nope'),
    node('convert.float', ['f32'], 'u32', 'u32'),
    node('convert.intToFloat', ['bool'], 'f32', 'f32'),
    node('convert.floatToInt', ['f32'], 'bool', 'bool'),
    node('bitcast', ['f64'], 'u32', 'u32'),
    node('bitcast', ['u32'], 'i32', 'i32'),
    node('bitcast', ['u8'], 'f32', 'f32'),
    node('bitcast', ['u32'], 'f32', 'f64'),
    node('select', ['bool', 'f32', 'f64'], 'f32'),
    node('const.bits', [], 'f64', '0x1234'),
    node('const', [], 'f32', '1'),
  ])('rejects invalid instruction $op', (instruction) => {
    error(
      () =>
        evaluateFloatInstruction(
          instruction,
          instruction.operands.filter((op) => op.kind === 'ssa').map(() => 0),
        ),
      'invalid-instruction',
    );
  });

  it('rejects unsupported execution and malformed data instead of returning a dummy result', () => {
    error(
      () => evaluateFloatInstruction(node('state.load', [], 'f32'), []),
      'unsupported-operation',
    );
    error(
      () => evaluateFloatInstruction(node('float.add', ['f32', 'f32'], 'f32'), [1]),
      'invalid-operand',
    );
    error(() => operation('f32', 'add', bits('f64', '0x0000000000000000'), 0), 'invalid-operand');
    error(() => operation('f32', 'add', bits('f32', '0x100000000'), 0), 'invalid-operand');
    error(() => operation('f32', 'add', bits('f32', '0xzzzzzzzz'), 0), 'invalid-operand');
    error(() => operation('f32', 'add', bits('f32', '0x12345678\n'), 0), 'invalid-operand');
    error(() => operation('f32', 'add', true, 0), 'invalid-operand');
    error(
      () =>
        evaluateFloatInstruction(node('float.add', ['f32', 'f32'], 'f32'), Array<RuntimeScalar>(2)),
      'invalid-operand',
    );
    error(
      () => evaluateFloatInstruction(node('select', ['bool', 'f32', 'f32'], 'f32'), [0, 1, 2]),
      'invalid-operand',
    );
    error(() => convert('u32' as IntegerType, 'f32', 'bitcast', -1), 'invalid-operand');
  });
});
