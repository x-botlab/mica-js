import { describe, expect, it } from 'vitest';
import {
  createIRModule,
  evaluateScalarInstruction,
  IRConstructionError,
  IRScalarEvaluationError,
  validateIR,
  type FunctionBuilder,
  type InstructionNode,
  type InstructionOperand,
  type IntegerType,
  type IRScalarEvaluationErrorCode,
  type ScalarType,
  type Value,
} from './index';
import { valueKind } from './types';

type Vector = readonly [string, readonly number[], number | boolean];
const TYPES = [
  { type: 'u8', width: 8, min: 0, max: 255, high: 128 },
  { type: 'i8', width: 8, min: -128, max: 127, high: -128 },
  { type: 'u16', width: 16, min: 0, max: 65535, high: 32768 },
  { type: 'i16', width: 16, min: -32768, max: 32767, high: -32768 },
  { type: 'u32', width: 32, min: 0, max: 4294967295, high: 2147483648 },
  { type: 'i32', width: 32, min: -2147483648, max: 2147483647, high: -2147483648 },
] as const;

function ssa(type: ScalarType): InstructionOperand {
  return { kind: 'ssa', value: { [valueKind]: 'ssa-value', type } };
}
function literal(value: boolean | number | string): InstructionOperand {
  return { kind: 'literal', value };
}
function node(
  op: string,
  types: readonly ScalarType[],
  result: ScalarType = types[0]!,
  prefix: readonly InstructionOperand[] = [],
): InstructionNode {
  return {
    op,
    operands: [...prefix, ...types.map(ssa)],
    results: [{ [valueKind]: 'ssa-value', type: result }],
  };
}
function integer(op: string, type: IntegerType): InstructionNode {
  return node(`int.${op}`, op === 'not' ? [type] : [type, type]);
}
function shift(op: string, type: IntegerType): InstructionNode {
  return node(`int.${op}`, [type, 'u32']);
}
function convert(op: string, source: ScalarType, target: ScalarType): InstructionNode {
  return node(`int.${op}`, [source], target, [literal(target)]);
}
function expectError(
  instruction: InstructionNode,
  values: readonly (boolean | number)[],
  code: IRScalarEvaluationErrorCode,
): void {
  let caught: unknown;
  try {
    evaluateScalarInstruction(instruction, values);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(IRScalarEvaluationError);
  expect(caught).toMatchObject({ name: 'IRScalarEvaluationError', code });
  expect(caught).not.toBeInstanceOf(IRConstructionError);
}

describe.each(TYPES)('$type scalar semantics', ({ type, width, min, max, high }) => {
  const signed = min < 0;
  const all = signed ? -1 : max;
  const vectors: Vector[] = [
    ['add', [max, 1], min],
    ['add', [0, 0], 0],
    ['sub', [min, 1], max],
    ['sub', [max, max], 0],
    ['mul', [max, max], 1],
    ['mul', [max, 2], signed ? -2 : max - 1],
    ['mul', [max, 0], 0],
    ['div', [7, 3], 2],
    ['rem', [7, 3], 1],
    ['div', [max, max], 1],
    ['rem', [max, max], 0],
    ['div', [0, max], 0],
    ['rem', [0, max], 0],
    ['and', [all, 85], 85],
    ['and', [high, 1], 0],
    ['or', [80, 5], 85],
    ['or', [high, 1], high + 1],
    ['xor', [85, 15], 90],
    ['xor', [all, all], 0],
    ['not', [all], 0],
    ['not', [0], all],
    ['not', [high], signed ? max : high - 1],
  ];
  if (signed) {
    vectors.push(
      ['add', [min, -1], max],
      ['mul', [min, -1], min],
      ['mul', [-7, 3], -21],
      ['div', [min, -1], min],
      ['rem', [min, -1], 0],
      ['div', [-7, 3], -2],
      ['rem', [-7, 3], -1],
      ['div', [7, -3], -2],
      ['rem', [7, -3], 1],
      ['div', [-7, -3], 2],
      ['rem', [-7, -3], -1],
      ['div', [-1, 2], 0],
      ['rem', [-6, 3], 0],
      ['div', [min, 1], min],
    );
  }
  it.each(vectors)('%s %j -> %s', (op, args, expected) => {
    expect(evaluateScalarInstruction(integer(op, type), args)).toBe(expected);
  });
  it.each(['div', 'rem'])('%s rejects zero, including negative zero', (op) => {
    for (const a of [min, 0, max]) {
      for (const zero of [0, -0]) expectError(integer(op, type), [a, zero], 'division-by-zero');
    }
  });
  it.each(['eq', 'ne', 'lt', 'le', 'gt', 'ge'])(
    'compares with %s using signedness',
    (predicate) => {
      const pairs = [
        [min, max, [false, true, true, true, false, false]],
        [max, min, [false, true, false, false, true, true]],
        [max, max, [true, false, false, true, false, true]],
      ] as const;
      const index = ['eq', 'ne', 'lt', 'le', 'gt', 'ge'].indexOf(predicate);
      for (const [a, b, answers] of pairs) {
        expect(
          evaluateScalarInstruction(node('int.cmp', [type, type], 'bool', [literal(predicate)]), [
            a,
            b,
          ]),
        ).toBe(answers[index]);
      }
    },
  );
  it('shifts by explicit counts without modulo', () => {
    const cases: Vector[] = [
      ['shl', [1, 0], 1],
      ['shl', [1, 1], 2],
      ['shl', [1, width - 1], high],
      ['shl', [all, 1], signed ? -2 : max - 1],
      ['lshr', [high, 0], high],
      ['lshr', [high, width - 1], 1],
      ['lshr', [all, 1], signed ? max : high - 1],
    ];
    if (signed)
      cases.push(
        ['ashr', [min, 0], min],
        ['ashr', [min, width - 1], -1],
        ['ashr', [-7, 1], -4],
        ['ashr', [max, width - 1], 0],
      );
    for (const [op, args, expected] of cases)
      expect(evaluateScalarInstruction(shift(op, type), args)).toBe(expected);
    for (const count of [width, width + 1, 32, 64, 65536, 2147483648, 4294967295]) {
      for (const value of [min, 0, 1, max, high]) {
        expect(evaluateScalarInstruction(shift('shl', type), [value, count])).toBe(0);
        expect(evaluateScalarInstruction(shift('lshr', type), [value, count])).toBe(0);
        if (signed)
          expect(evaluateScalarInstruction(shift('ashr', type), [value, count])).toBe(
            value < 0 ? -1 : 0,
          );
      }
    }
  });
  it('accepts strict constants and canonicalizes integer zero', () => {
    for (const value of [min, max, 0, -0]) {
      expect(evaluateScalarInstruction(node('const', [], type, [literal(value)]), [])).toBe(
        value === 0 ? 0 : value,
      );
    }
  });
  it('rejects bad integer values before arithmetic or selection', () => {
    for (const value of [
      min - 1,
      max + 1,
      0.5,
      NaN,
      Infinity,
      -Infinity,
      true,
      false,
      '1',
      1n,
      undefined,
      null,
    ]) {
      expectError(integer('add', type), [1, value as number], 'invalid-operand');
      expectError(node('const', [], type, [literal(value as number)]), [], 'invalid-operand');
      expectError(
        node('select', ['bool', type, type], type),
        [true, 1, value as number],
        'invalid-operand',
      );
    }
  });
});

it.each([
  ['mul', [4294967295, 4294967295], 1],
  ['mul', [4294967294, 4294967293], 6],
  ['mul', [2147483649, 2147483649], 1],
  ['mul', [4294967295, 2147483649], 2147483647],
  ['div', [4294967295, 3], 1431655765],
  ['div', [4294967295, 65537], 65535],
  ['div', [4294967295, 2147483648], 1],
  ['rem', [4294967295, 2147483648], 2147483647],
  ['div', [4294967294, 4294967295], 0],
  ['rem', [4294967294, 4294967295], 4294967294],
] satisfies Vector[])('u32 precise %s %j -> %s', (op, args, expected) => {
  expect(evaluateScalarInstruction(integer(op, 'u32'), args)).toBe(expected);
});

describe('boolean truth tables and eager selection', () => {
  it.each([
    [false, false, false, false, false],
    [false, true, false, true, true],
    [true, false, false, true, true],
    [true, true, true, true, false],
  ])('truth table %s, %s', (a, b, and, or, xor) => {
    expect(evaluateScalarInstruction(node('bool.not', ['bool']), [a])).toBe(!a);
    expect(evaluateScalarInstruction(node('bool.and', ['bool', 'bool']), [a, b])).toBe(and);
    expect(evaluateScalarInstruction(node('bool.or', ['bool', 'bool']), [a, b])).toBe(or);
    expect(evaluateScalarInstruction(node('bool.xor', ['bool', 'bool']), [a, b])).toBe(xor);
    expect(
      evaluateScalarInstruction(node('select', ['bool', 'bool', 'bool']), [a, true, false]),
    ).toBe(a);
    expect(evaluateScalarInstruction(node('const', [], 'bool', [literal(a)]), [])).toBe(a);
  });
  it.each([0, 1, -1, NaN, 'true', null, undefined])('rejects nonboolean %s', (value) => {
    const invalid = value as unknown as boolean;
    expectError(node('bool.not', ['bool']), [invalid], 'invalid-operand');
    expectError(node('bool.and', ['bool', 'bool']), [false, invalid], 'invalid-operand');
    expectError(node('bool.or', ['bool', 'bool']), [true, invalid], 'invalid-operand');
    expectError(node('const', [], 'bool', [literal(invalid)]), [], 'invalid-operand');
    expectError(node('select', ['bool', 'u8', 'u8'], 'u8'), [invalid, 1, 2], 'invalid-operand');
  });
  it('requires both already-evaluated alternatives even for false conditions', () => {
    const select = node('select', ['bool', 'u8', 'u8'], 'u8');
    expect(evaluateScalarInstruction(select, [false, 1, 2])).toBe(2);
    expect(evaluateScalarInstruction(select, [true, 1, 2])).toBe(1);
    expectError(select, [false, 256, 2], 'invalid-operand');
    expectError(integer('div', 'u8'), [1, 0], 'division-by-zero');
  });
});

describe('integer conversion matrix', () => {
  for (const source of TYPES)
    for (const target of TYPES) {
      const widening = target.width > source.width;
      const narrowing = target.width < source.width;
      const reinterpret = target.width === source.width && source.type !== target.type;
      for (const op of ['zext', 'sext', 'trunc', 'reinterpret']) {
        const legal =
          op === 'zext'
            ? widening
            : op === 'sext'
              ? widening && source.min < 0
              : op === 'trunc'
                ? narrowing
                : reinterpret;
        it(`${op} ${source.type} -> ${target.type} ${legal ? 'accepts' : 'rejects'}`, () => {
          const instruction = convert(op, source.type, target.type);
          if (!legal) {
            expectError(instruction, [0], 'invalid-instruction');
            return;
          }
          expect(evaluateScalarInstruction(instruction, [0])).toBe(0);
          // All-ones patterns have explicit signed/unsigned meanings at every width.
          const all = source.min < 0 ? -1 : source.max;
          const expected =
            op === 'zext'
              ? source.width === 8
                ? 255
                : 65535
              : op === 'sext'
                ? target.min < 0
                  ? -1
                  : target.max
                : target.min < 0
                  ? -1
                  : target.max;
          expect(evaluateScalarInstruction(instruction, [all])).toBe(expected);
        });
      }
    }
  it.each([
    ['zext', 'i8', 'i16', -128, 128],
    ['zext', 'i16', 'i32', -32768, 32768],
    ['sext', 'i8', 'u32', -128, 4294967168],
    ['sext', 'i16', 'u32', -32768, 4294934528],
    ['trunc', 'u16', 'u8', 300, 44],
    ['trunc', 'u16', 'i8', 255, -1],
    ['trunc', 'i32', 'u8', -257, 255],
    ['trunc', 'u32', 'i16', 4294934528, -32768],
    ['trunc', 'i32', 'i8', 128, -128],
    ['reinterpret', 'u8', 'i8', 128, -128],
    ['reinterpret', 'i32', 'u32', -2147483648, 2147483648],
    ['reinterpret', 'u32', 'i32', 4294967295, -1],
  ] as const)('%s %s -> %s: %s -> %s', (op, source, target, value, expected) => {
    expect(evaluateScalarInstruction(convert(op, source, target), [value])).toBe(expected);
  });
});

describe('instruction boundary rejection', () => {
  it.each([
    node('int.add', ['u8', 'u16']),
    node('int.add', ['i8', 'u8']),
    node('int.add', ['u8', 'u8'], 'u16'),
    node('int.add', ['bool', 'bool']),
    node('int.not', ['f32']),
    node('bool.and', ['bool', 'u8']),
    node('int.ashr', ['u32', 'u32']),
    node('int.shl', ['u8', 'u8']),
    node('int.lshr', ['i8', 'i32']),
    node('int.shl', ['u8', 'u32'], 'i8'),
    node('int.cmp', ['u8', 'u16'], 'bool', [literal('eq')]),
    node('int.cmp', ['u8', 'u8'], 'u8', [literal('eq')]),
    node('int.cmp', ['u8', 'u8'], 'bool', [literal('bogus')]),
    node('select', ['u8', 'u8', 'u8']),
    node('select', ['bool', 'u8', 'i8'], 'u8'),
    convert('zext', 'bool', 'u32'),
    convert('trunc', 'f64', 'u8'),
    node('int.zext', ['u8'], 'i16', [literal('u16')]),
    node('int.add', ['u8']),
    node('int.not', ['u8', 'u8']),
    node('const', ['u8'], 'u8'),
    node('const', [], 'u8', [literal(1), literal(2)]),
    { ...integer('add', 'u8'), results: [] },
    { ...integer('add', 'u8'), operands: [literal(1), ssa('u8')] },
    {
      ...integer('add', 'u8'),
      operands: [{ kind: 'static', ref: {} } as InstructionOperand, ssa('u8')],
    },
    { ...integer('add', 'u8'), operands: [null, ssa('u8')] } as unknown as InstructionNode,
    { ...integer('add', 'u8'), results: [null] } as unknown as InstructionNode,
    {
      ...integer('add', 'u8'),
      operands: [{ kind: 'ssa', value: null }],
    } as unknown as InstructionNode,
    null as unknown as InstructionNode,
  ])('rejects incompatible or malformed node %#', (instruction) => {
    expectError(instruction, [], 'invalid-instruction');
  });
  it.each([
    'float.add',
    'float.fma',
    'convert.intToFloat',
    'convert.floatToInt',
    'convert.float',
    'const.bits',
    'bitcast',
    'call',
    'state.load',
    'bytes.store',
    'domain.custom',
    'return',
    'trap',
  ])('explicitly rejects unsupported %s', (op) => {
    expectError(node(op, ['u32']), [1], 'unsupported-instruction');
  });
  it.each(['f32', 'f64'] as const)(
    'does not silently implement floating const/select for %s',
    (type) => {
      expectError(node('const', [], type, [literal(1)]), [], 'unsupported-instruction');
      expectError(
        node('select', ['bool', type, type], type),
        [true, 1, 2],
        'unsupported-instruction',
      );
    },
  );
  it('requires exactly the SSA inputs, not literal operands', () => {
    expectError(integer('add', 'u8'), [1], 'invalid-operand');
    expectError(integer('add', 'u8'), [1, 2, 3], 'invalid-operand');
    expectError(node('const', [], 'u8', [literal(1)]), [1], 'invalid-operand');
    expectError(integer('add', 'u8'), null as unknown as number[], 'invalid-operand');
  });
  it.each([-1, 4294967296, 1.5, Infinity, true])('requires a strict u32 count: %s', (count) => {
    expectError(shift('shl', 'u8'), [1, count], 'invalid-operand');
  });
});

function buildScalar(emit: (b: FunctionBuilder) => Value): {
  module: ReturnType<typeof createIRModule>;
  instruction: InstructionNode;
} {
  const module = createIRModule();
  module.entry('test', []).body((b) => {
    emit(b);
    b.return([]);
  });
  const instructions = module.functions[0]!.body!.entry.instructions;
  return { module, instruction: instructions[instructions.length - 1]! };
}

describe('existing builder and validator integration', () => {
  it.each(TYPES)(
    'evaluates actual $type builder nodes, without hidden builder metadata',
    ({ type }) => {
      const operations = ['add', 'sub', 'mul', 'div', 'rem', 'and', 'or', 'xor'] as const;
      const expected = [10, 4, 21, 2, 1, 3, 7, 4];
      for (const [index, op] of operations.entries()) {
        const { module, instruction } = buildScalar((b) =>
          b.int[op](b.const(type, 7), b.const(type, 3)),
        );
        const names = ['const', instruction.op, 'return'];
        expect(
          validateIR(module, {
            supportedInstructions: names,
            authorizedInstructions: names,
            resources: [],
          }).ok,
        ).toBe(true);
        expect(evaluateScalarInstruction(instruction, [7, 3])).toBe(expected[index]);
        expect(evaluateScalarInstruction({ ...instruction }, [7, 3])).toBe(expected[index]);
      }
    },
  );
  it.each([
    [(b: FunctionBuilder) => b.int.cmp('lt', b.const('i8', -1), b.const('i8', 0)), [-1, 0], true],
    [(b: FunctionBuilder) => b.int.zext('u16', b.const('i8', -1)), [-1], 255],
    [(b: FunctionBuilder) => b.int.sext('u32', b.const('i8', -1)), [-1], 4294967295],
    [(b: FunctionBuilder) => b.int.trunc('i8', b.const('u16', 255)), [255], -1],
    [
      (b: FunctionBuilder) => b.int.reinterpret('i32', b.const('u32', 4294967295)),
      [4294967295],
      -1,
    ],
    [
      (b: FunctionBuilder) => b.int.ashr(b.const('i8', -128), b.const('u32', 4294967295)),
      [-128, 4294967295],
      -1,
    ],
    [
      (b: FunctionBuilder) => b.bool.xor(b.const('bool', true), b.const('bool', false)),
      [true, false],
      true,
    ],
    [
      (b: FunctionBuilder) => b.select(b.const('bool', false), b.const('u8', 1), b.const('u8', 2)),
      [false, 1, 2],
      2,
    ],
  ] as const)('uses builder operand encoding %#', (emit, args, expected) => {
    const { module, instruction } = buildScalar(emit);
    const names = ['const', instruction.op, 'return'];
    expect(
      validateIR(module, {
        supportedInstructions: names,
        authorizedInstructions: names,
        resources: [],
      }).ok,
    ).toBe(true);
    expect(evaluateScalarInstruction(instruction, args)).toBe(expected);
  });
  it.each([
    [
      (b: FunctionBuilder) => b.int.add(b.const('u8', 1), b.const('u8', 2)),
      (n: InstructionNode) => ({ ...n, results: [{ ...n.results[0]!, type: 'u16' as const }] }),
    ],
    [
      (b: FunctionBuilder) => b.int.shl(b.const('u8', 1), b.const('u32', 2)),
      (n: InstructionNode) => ({ ...n, operands: [n.operands[0]!, n.operands[0]!] }),
    ],
    [
      (b: FunctionBuilder) => b.int.zext('u16', b.const('u8', 1)),
      (n: InstructionNode) => ({ ...n, operands: [literal('u8'), n.operands[1]!] }),
    ],
  ] as const)(
    'static validation and evaluation both reject altered signatures %#',
    (emit, change) => {
      const { module, instruction } = buildScalar(emit);
      const body = module.functions[0]!.body!;
      const altered = change(instruction);
      const entry = {
        ...body.entry,
        instructions: [...body.entry.instructions.slice(0, -1), altered],
      };
      const model = {
        memories: module.memories,
        domainDeclarations: module.domainDeclarations,
        instructions: module.instructions,
        functions: [{ ...module.functions[0]!, body: { entry, blocks: [entry] } }],
      };
      const names = ['const', instruction.op, 'return'];
      const checked = validateIR(model, {
        supportedInstructions: names,
        authorizedInstructions: names,
        resources: [],
      });
      expect(checked.ok).toBe(false);
      expect(checked.diagnostics.some((d) => d.code === 'type-mismatch')).toBe(true);
      expectError(altered, [], 'invalid-instruction');
    },
  );
});
