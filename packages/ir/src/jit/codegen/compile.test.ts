import { describe, expect, it } from 'vitest';
import { CORE_INSTRUCTION_NAMES } from '../../builder';
import { createIRInterpreter, createIRModule, IRExecutionError } from '../../index';
import type {
  BytesRef,
  IntegerType,
  IRInterpreter,
  IRModule,
  IRStorage,
  IRValidationOptions,
  RuntimeScalar,
  ScalarType,
  Value,
} from '../../index';
import { compileModule } from '../testing/compile-module';
import type { CompiledModule } from '../testing/compile-module';
import { compileFunctionWithSource } from './compile';

/* -------------------------------------------------------------------------
 * Harness
 * ---------------------------------------------------------------------- */

function policy(module: IRModule): IRValidationOptions {
  return {
    supportedInstructions: CORE_INSTRUCTION_NAMES,
    authorizedInstructions: CORE_INSTRUCTION_NAMES,
    resources: module.memories.map((memory) => ({
      ref: memory.ref,
      access: memory.writable ? ('read-write' as const) : ('read' as const),
    })),
  };
}

const context = { instanceId: 'jit-test', virtualTime: 7 };

type Target = Parameters<CompiledModule['execute']>[0];

type Outcome =
  | { readonly ok: true; readonly values: readonly RuntimeScalar[]; readonly steps: number }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly steps: number;
      readonly location: unknown;
      readonly causeName: string | undefined;
    };

function capture(action: () => { values: readonly RuntimeScalar[]; steps: number }): Outcome {
  try {
    const result = action();
    return { ok: true, values: result.values, steps: result.steps };
  } catch (error) {
    if (!(error instanceof IRExecutionError)) throw error;
    return {
      ok: false,
      code: error.code,
      message: error.message,
      steps: error.steps,
      location: error.location,
      causeName: error.cause instanceof Error ? error.cause.name : undefined,
    };
  }
}

/** The reference interpreter faults after an error, so recreate it on failure. */
function referenceRunner(module: IRModule, options: { readonly maxSteps?: number } = {}) {
  const make = (): IRInterpreter =>
    createIRInterpreter(module, {
      validation: policy(module),
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    });
  let interpreter = make();
  return (target: Target, args: readonly RuntimeScalar[]): Outcome => {
    const outcome = capture(() => interpreter.execute(target, args, context));
    if (!outcome.ok) interpreter = make();
    return outcome;
  };
}

function compile(module: IRModule, options: { readonly maxSteps?: number } = {}): CompiledModule {
  return compileModule(module, {
    validation: policy(module),
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
  });
}

/** Compare every input against the reference; returns the compiled module. */
function compare(
  module: IRModule,
  target: Target,
  inputs: readonly (readonly RuntimeScalar[])[],
): CompiledModule {
  const jit = compile(module);
  const reference = referenceRunner(module);
  for (const args of inputs) {
    const expected = reference(target, args);
    const actual = capture(() => jit.execute(target, args, context));
    expect({ args, actual }).toEqual({ args, actual: expected });
  }
  return jit;
}

function sample(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function integerValues(type: IntegerType): number[] {
  switch (type) {
    case 'u8':
      return [0, 1, 2, 127, 128, 254, 255];
    case 'i8':
      return [0, 1, -1, 2, -2, 126, -127, -128];
    case 'u16':
      return [0, 1, 255, 256, 32767, 32768, 65534, 65535];
    case 'i16':
      return [0, 1, -1, 255, -255, 32766, -32767, -32768];
    case 'u32':
      return [0, 1, 2, 255, 65535, 65536, 0x7fffffff, 0xfffffffe, 0xffffffff];
    case 'i32':
      return [0, 1, -1, 255, -255, 65535, -65536, 0x7fffffff, -0x7fffffff, -0x80000000];
  }
}

function randomInteger(range: () => number, type: IntegerType): number {
  const value = range();
  switch (type) {
    case 'u8':
      return value & 0xff;
    case 'i8':
      return (value << 24) >> 24;
    case 'u16':
      return value & 0xffff;
    case 'i16':
      return (value << 16) >> 16;
    case 'u32':
      return value >>> 0;
    case 'i32':
      return value | 0;
  }
}

/**
 * The dynamic operation table mixes scalar types; the builder's generic
 * signatures cannot express that, so the table uses this permissive view.
 */
interface DynamicIntOps {
  add(left: Value, right: Value): Value;
  sub(left: Value, right: Value): Value;
  mul(left: Value, right: Value): Value;
  div(left: Value, right: Value): Value;
  rem(left: Value, right: Value): Value;
  and(left: Value, right: Value): Value;
  or(left: Value, right: Value): Value;
  xor(left: Value, right: Value): Value;
  shl(value: Value, count: Value): Value;
  lshr(value: Value, count: Value): Value;
  ashr(value: Value, count: Value): Value;
  not(value: Value): Value;
  cmp(predicate: string, left: Value, right: Value): Value;
  zext(target: string, value: Value): Value;
  sext(target: string, value: Value): Value;
  trunc(target: string, value: Value): Value;
  reinterpret(target: string, value: Value): Value;
}

interface DynamicFloatOps {
  add(left: Value, right: Value): Value;
  sub(left: Value, right: Value): Value;
  mul(left: Value, right: Value): Value;
  div(left: Value, right: Value): Value;
  fma(a: Value, b: Value, c: Value): Value;
  cmp(predicate: string, left: Value, right: Value): Value;
  isNaN(value: Value): Value;
  isFinite(value: Value): Value;
}

interface DynamicBuilder {
  readonly int: DynamicIntOps;
  readonly float: DynamicFloatOps;
  readonly convert: {
    intToFloat(type: string, value: Value): Value;
    floatToInt(type: string, value: Value): Value;
    float(type: string, value: Value): Value;
  };
  bitcast(type: string, value: Value): Value;
}

type BinaryBuilder = (b: DynamicBuilder, left: Value, right: Value) => Value;

function binaryFunction(
  module: IRModule,
  name: string,
  type: ScalarType,
  right: ScalarType,
  build: BinaryBuilder,
): Target {
  const fn = module.func(name, { params: [type, right], results: [type] });
  fn.body((b, [left, operand]) => {
    b.return([build(b as unknown as DynamicBuilder, left!, operand!) as never]);
  });
  return fn;
}

function unaryFunction(
  module: IRModule,
  name: string,
  type: ScalarType,
  result: ScalarType,
  build: (b: DynamicBuilder, value: Value) => Value,
): Target {
  const fn = module.func(name, { params: [type], results: [result] });
  fn.body((b, [value]) => {
    b.return([build(b as unknown as DynamicBuilder, value!) as never]);
  });
  return fn;
}

function countedLoopFixture() {
  const module = createIRModule();
  const sum = module.func('sum', { params: ['u32'], results: ['u32'] });
  sum.body((b, [n]) => {
    const zero = b.const('u32', 0);
    const one = b.const('u32', 1);
    const loop = b.block(['u32', 'u32']);
    const body = b.block(['u32', 'u32']);
    const done = b.block(['u32']);
    b.jump(loop, [zero, zero]);
    b.at(loop, (inner, [index, total]) =>
      inner.branch(
        inner.int.cmp('lt', index, n),
        { target: body, args: [index, total] },
        { target: done, args: [total] },
      ),
    );
    b.at(body, (inner, [index, total]) => {
      const next = inner.int.add(index, one);
      inner.jump(loop, [next, inner.int.add(total, next)]);
    });
    b.at(done, (inner, [total]) => inner.return([total]));
  });
  return { module, sum };
}

/* -------------------------------------------------------------------------
 * Baseline
 * ---------------------------------------------------------------------- */

describe('JIT baseline codegen', () => {
  it('evaluates straight-line integer arithmetic like the reference interpreter', () => {
    const module = createIRModule();
    const run = module.func('run', { params: ['i32', 'i32'], results: ['i32'] });
    run.body((b, [left, right]) => {
      const sum = b.int.add(left, right);
      const product = b.int.mul(sum, b.const('i32', 3));
      const difference = b.int.sub(product, b.int.div(left, b.const('i32', 2)));
      b.return([b.int.rem(difference, b.const('i32', 7))]);
    });

    compare(module, run, [
      [17, -5],
      [0, 0],
      [-1, 1],
      [0x7fffffff, 1],
    ]);
    const jit = compile(module);
    const source = jit.source(0);
    expect(source).toContain('function f0');
    expect(source).toContain('Math.imul');
    expect(source).not.toMatch(/\beval\b/);
    expect(source).not.toMatch(/\barguments\b/);
    expect(source).not.toMatch(/\bwith\b/);
    expect(source.match(/function /g)).toHaveLength(1);
    expect(source).not.toContain('=>');
  });

  it('counts steps exactly on a counted loop', () => {
    const { module, sum } = countedLoopFixture();
    const jit = compile(module);
    const reference = referenceRunner(module);
    for (const n of [0, 1, 2, 5, 17]) {
      const expected = reference(sum, [n]);
      const actual = capture(() => jit.execute(sum, [n], context));
      expect({ n, actual }).toEqual({ n, actual: expected });
    }
    expect(jit.functions[0]!.structured).toBe(true);
    expect(jit.source(0)).toContain('for (;;)');
    expect(capture(() => jit.execute(sum, [5], context))).toMatchObject({
      ok: true,
      steps: 31,
      values: [15],
    });
  });

  it('generates source once per function and environment', () => {
    const { module } = countedLoopFixture();
    const jit = compile(module);
    const first = compileFunctionWithSource(jit.mir[0]!, jit.env);
    const second = compileFunctionWithSource(jit.mir[0]!, jit.env);
    expect(second.source).toBe(first.source);
    // The cached emission shares its constant table.
    expect(second.constants).toBe(first.constants);
    // A different environment re-emits.
    const other = compile(module);
    expect(compileFunctionWithSource(other.mir[0]!, other.env).constants).not.toBe(first.constants);
  });

  it('matches the reference for every maxSteps boundary', () => {
    const { module, sum } = countedLoopFixture();
    for (let maxSteps = 0; maxSteps <= 40; maxSteps += 1) {
      const jit = compile(module, { maxSteps });
      const reference = referenceRunner(module, { maxSteps });
      const expected = reference(sum, [2]);
      const actual = capture(() => jit.execute(sum, [2], context));
      expect({ maxSteps, actual }).toEqual({ maxSteps, actual: expected });
    }
  });
});

/* -------------------------------------------------------------------------
 * Integer operation table
 * ---------------------------------------------------------------------- */

describe('JIT integer operation table', () => {
  const integerTypes: readonly IntegerType[] = ['u8', 'i8', 'u16', 'i16', 'u32', 'i32'];

  for (const type of integerTypes) {
    it(`matches the reference for every ${type} operation`, () => {
      const module = createIRModule();
      const targets = new Map<string, { fn: Target; right: ScalarType }>();
      const operations: ReadonlyArray<readonly [string, BinaryBuilder]> = [
        ['add', (b, x, y) => b.int.add(x, y)],
        ['sub', (b, x, y) => b.int.sub(x, y)],
        ['mul', (b, x, y) => b.int.mul(x, y)],
        ['div', (b, x, y) => b.int.div(x, y)],
        ['rem', (b, x, y) => b.int.rem(x, y)],
        ['and', (b, x, y) => b.int.and(x, y)],
        ['or', (b, x, y) => b.int.or(x, y)],
        ['xor', (b, x, y) => b.int.xor(x, y)],
        ['shl', (b, x, y) => b.int.shl(x, y)],
        ['lshr', (b, x, y) => b.int.lshr(x, y)],
      ];
      for (const [name, build] of operations) {
        const right: ScalarType = name === 'shl' || name === 'lshr' ? 'u32' : type;
        targets.set(name, { fn: binaryFunction(module, name, type, right, build), right });
      }
      if (type !== 'u8' && type !== 'u16' && type !== 'u32') {
        targets.set('ashr', {
          fn: binaryFunction(module, 'ashr', type, 'u32', (b, x, y) => b.int.ashr(x, y)),
          right: 'u32',
        });
      }
      for (const predicate of ['eq', 'ne', 'lt', 'le', 'gt', 'ge'] as const) {
        const name = `cmp_${predicate}`;
        const fn = module.func(name, { params: [type, type], results: ['bool'] });
        fn.body((b, [x, y]) => {
          b.return([b.int.cmp(predicate, x!, y!)]);
        });
        targets.set(name, { fn, right: type });
      }
      targets.set('not', {
        fn: unaryFunction(module, 'not', type, type, (b, x) => b.int.not(x)),
        right: type,
      });

      const jit = compile(module);
      const reference = referenceRunner(module);
      const range = sample(0x51ed + type.length * 977);

      for (const [name, { fn, right }] of targets) {
        const leftValues = integerValues(type);
        const rightValues = integerValues(right as IntegerType);
        const pairs: [number, number][] = [];
        for (const left of leftValues) {
          for (const value of rightValues) pairs.push([left, value]);
        }
        for (let index = 0; index < 40; index += 1) {
          pairs.push([randomInteger(range, type), randomInteger(range, right as IntegerType)]);
        }
        for (const [left, value] of pairs) {
          const expected = reference(fn, [left, value]);
          const actual = capture(() => jit.execute(fn, [left, value], context));
          expect({ name, type, left, value, actual }).toEqual({
            name,
            type,
            left,
            value,
            actual: expected,
          });
        }
      }
    });
  }

  it('reports errors at every segment position with reference steps and location', () => {
    // One block, one segment: `add`, `div` (throws on zero), `add`, `return`.
    const module = createIRModule();
    const run = module.func('run', { params: ['i32', 'i32'], results: ['i32'] });
    run.body((b, [left, right]) => {
      const sum = b.int.add(left, b.const('i32', 1));
      const quotient = b.int.div(sum, right);
      b.return([b.int.add(quotient, b.const('i32', 1))]);
    });
    for (const maxSteps of [0, 1, 2, 3, 4, 100]) {
      const boundedJit = compile(module, { maxSteps });
      const boundedReference = referenceRunner(module, { maxSteps });
      const expectedBounded = boundedReference(run, [10, 0]);
      const actualBounded = capture(() => boundedJit.execute(run, [10, 0], context));
      expect({ maxSteps, actual: actualBounded }).toEqual({ maxSteps, actual: expectedBounded });
    }
    const jit = compile(module);
    const reference = referenceRunner(module);
    const expected = reference(run, [10, 0]);
    expect(expected).toMatchObject({ ok: false, steps: 3 });
    expect(capture(() => jit.execute(run, [10, 0], context))).toEqual(expected);
  });

  it('matches conversion operations across widths', () => {
    const module = createIRModule();
    const cases: ReadonlyArray<{
      source: IntegerType;
      target: IntegerType;
      op: 'int.zext' | 'int.sext' | 'int.trunc' | 'int.reinterpret';
      values: number[];
    }> = [
      { source: 'u8', target: 'u32', op: 'int.zext', values: [0, 1, 127, 128, 255] },
      { source: 'i8', target: 'i32', op: 'int.zext', values: [-128, -1, 0, 127] },
      { source: 'u16', target: 'u32', op: 'int.zext', values: [0, 255, 32768, 65535] },
      { source: 'i8', target: 'i32', op: 'int.sext', values: [-128, -1, 0, 127] },
      { source: 'i16', target: 'i32', op: 'int.sext', values: [-32768, -1, 0, 32767] },
      { source: 'i32', target: 'i8', op: 'int.trunc', values: [0, 127, 128, -1, -129] },
      { source: 'i32', target: 'i16', op: 'int.trunc', values: [0, 32767, 32768, -32769] },
      { source: 'u32', target: 'u8', op: 'int.trunc', values: [0, 255, 256, 0xffffffff] },
      { source: 'u32', target: 'u16', op: 'int.trunc', values: [0, 65535, 65536, 0xffffffff] },
      { source: 'i32', target: 'u32', op: 'int.reinterpret', values: [-1, 0, 0x7fffffff] },
      { source: 'u32', target: 'i32', op: 'int.reinterpret', values: [0, 1, 0xffffffff] },
      { source: 'u8', target: 'i8', op: 'int.reinterpret', values: [0, 127, 128, 255] },
      { source: 'i16', target: 'u16', op: 'int.reinterpret', values: [-1, 0, 32767] },
    ];

    const targets = cases.map((entry, index) => {
      const fn = module.func(`convert${index}`, {
        params: [entry.source],
        results: [entry.target],
      });
      fn.body((b, [value]) => {
        const int = (b as unknown as DynamicBuilder).int;
        const converted =
          entry.op === 'int.zext'
            ? int.zext(entry.target, value!)
            : entry.op === 'int.sext'
              ? int.sext(entry.target, value!)
              : entry.op === 'int.trunc'
                ? int.trunc(entry.target, value!)
                : int.reinterpret(entry.target, value!);
        b.return([converted as never]);
      });
      return { ...entry, fn };
    });

    const jit = compile(module);
    const reference = referenceRunner(module);
    for (const target of targets) {
      for (const value of target.values) {
        const expected = reference(target.fn, [value]);
        const actual = capture(() => jit.execute(target.fn, [value], context));
        expect({ op: target.op, value, actual }).toEqual({
          op: target.op,
          value,
          actual: expected,
        });
      }
    }
  });

  it('reports division by zero exactly like the reference', () => {
    const module = createIRModule();
    const div = module.func('div', { params: ['i32', 'i32'], results: ['i32'] });
    div.body((b, [left, right]) => b.return([b.int.div(left, right)]));
    const rem = module.func('rem', { params: ['i32', 'i32'], results: ['i32'] });
    rem.body((b, [left, right]) => b.return([b.int.rem(left, right)]));
    const jit = compile(module);
    for (const target of [div, rem]) {
      const reference = referenceRunner(module);
      const expected = reference(target, [7, 0]);
      expect(expected).toMatchObject({ ok: false, code: 'evaluation-failed', steps: 1 });
      expect(capture(() => jit.execute(target, [7, 0], context))).toEqual(expected);
    }
    // `MIN / -1` wraps instead of trapping.
    compare(module, div, [[-0x80000000, -1]]);
  });
});

/* -------------------------------------------------------------------------
 * Floating-point operation table
 * ---------------------------------------------------------------------- */

describe('JIT floating-point operation table', () => {
  const floatValues: Readonly<Record<'f32' | 'f64', number[]>> = {
    f32: [0, -0, 1.5, -2.25, 3.5, Infinity, -Infinity, NaN, 3.4028234663852886e38, 1.4e-45],
    f64: [0, -0, 1.5, -2.25, 3.5, Infinity, -Infinity, NaN, 1e308, 5e-324],
  };

  for (const type of ['f32', 'f64'] as const) {
    it(`matches the reference for every ${type} operation`, () => {
      const module = createIRModule();
      const targets = new Map<string, { fn: Target; arity: number }>();
      for (const [name, build] of [
        ['add', (b: DynamicBuilder, x: Value, y: Value) => b.float.add(x, y)],
        ['sub', (b: DynamicBuilder, x: Value, y: Value) => b.float.sub(x, y)],
        ['mul', (b: DynamicBuilder, x: Value, y: Value) => b.float.mul(x, y)],
        ['div', (b: DynamicBuilder, x: Value, y: Value) => b.float.div(x, y)],
      ] as const) {
        targets.set(name, { fn: binaryFunction(module, name, type, type, build), arity: 2 });
      }
      for (const predicate of ['eq', 'ne', 'lt', 'le', 'gt', 'ge'] as const) {
        const name = `cmp_${predicate}`;
        const fn = module.func(name, { params: [type, type], results: ['bool'] });
        fn.body((b, [x, y]) => {
          b.return([b.float.cmp(predicate, x!, y!)]);
        });
        targets.set(name, { fn, arity: 2 });
      }
      targets.set('isNaN', {
        fn: unaryFunction(module, 'isNaN', type, 'bool', (b, x) => b.float.isNaN(x)),
        arity: 1,
      });
      targets.set('isFinite', {
        fn: unaryFunction(module, 'isFinite', type, 'bool', (b, x) => b.float.isFinite(x)),
        arity: 1,
      });
      const fma = module.func('fma', { params: [type, type, type], results: [type] });
      fma.body((b, [a, c, d]) => b.return([b.float.fma(a!, c!, d!)]));
      targets.set('fma', { fn: fma, arity: 3 });

      const jit = compile(module);
      const reference = referenceRunner(module);
      const values = floatValues[type];
      for (const [name, { fn, arity }] of targets) {
        const inputs: number[][] = [];
        if (arity === 1) {
          for (const value of values) inputs.push([value]);
        } else if (arity === 2) {
          for (const left of values) for (const right of values) inputs.push([left, right]);
        } else {
          const samples = [0, 1.5, -2.25, Infinity, NaN];
          for (const a of samples)
            for (const c of samples)
              for (const d of samples) {
                inputs.push([a, c, d]);
              }
        }
        for (const args of inputs) {
          const expected = reference(fn, args);
          const actual = capture(() => jit.execute(fn, args, context));
          expect({ name, type, args, actual }).toEqual({ name, type, args, actual: expected });
        }
      }
    });
  }

  it('matches float conversion and bitcast operations', () => {
    const module = createIRModule();
    const intToF32 = unaryFunction(module, 'intToF32', 'i32', 'f32', (b, x) =>
      b.convert.intToFloat('f32', x),
    );
    const intToF64 = unaryFunction(module, 'intToF64', 'i32', 'f64', (b, x) =>
      b.convert.intToFloat('f64', x),
    );
    const f64ToF32 = unaryFunction(module, 'f64ToF32', 'f64', 'f32', (b, x) =>
      b.convert.float('f32', x),
    );
    const f32ToF64 = unaryFunction(module, 'f32ToF64', 'f32', 'f64', (b, x) =>
      b.convert.float('f64', x),
    );
    const f64ToInt = unaryFunction(module, 'f64ToInt', 'f64', 'i32', (b, x) =>
      b.convert.floatToInt('i32', x),
    );
    const f32ToU32 = unaryFunction(module, 'f32ToU32', 'f32', 'u32', (b, x) => b.bitcast('u32', x));
    const u32ToF32 = unaryFunction(module, 'u32ToF32', 'u32', 'f32', (b, x) => b.bitcast('f32', x));

    const jit = compile(module);
    const reference = referenceRunner(module);
    const cases: ReadonlyArray<readonly [Target, readonly number[]]> = [
      [intToF32, [0, 1, -1, 0x7fffffff, 16777217]],
      [intToF64, [0, 1, -1, 0x7fffffff, -0x80000000]],
      [f64ToF32, [0, 1.5, 1e300, 5e-324, Infinity, NaN]],
      [f32ToF64, [0, 1.5, 3.4028234663852886e38, 1.4e-45, NaN]],
      [f64ToInt, [0, 1.5, -1.5, 2147483647, -2147483648, 2147483648, NaN, Infinity]],
      [f32ToU32, [0, 1.5, -1.5, NaN, Infinity]],
      [u32ToF32, [0, 1, 0x3f800000, 0x7fc00000, 0xffffffff]],
    ];
    for (const [target, values] of cases) {
      for (const value of values) {
        const expected = reference(target, [value]);
        const actual = capture(() => jit.execute(target, [value], context));
        expect({ value, actual }).toEqual({ value, actual: expected });
      }
    }
  });

  it('evaluates select on floats without altering representations', () => {
    const module = createIRModule();
    const select = module.func('pick', { params: ['bool', 'f64', 'f64'], results: ['f64'] });
    select.body((b, [flag, yes, no]) => b.return([b.select(flag, yes, no)]));
    compare(module, select, [
      [true, 1.5, 2.5],
      [false, 1.5, 2.5],
      [true, NaN, 0],
      [false, Infinity, -Infinity],
    ]);
  });
});

/* -------------------------------------------------------------------------
 * Storage fast paths
 * ---------------------------------------------------------------------- */

describe('JIT storage fast paths', () => {
  function fixture() {
    const module = createIRModule();
    const count = module.state('count', 'u32', 5);
    const flags = module.array('flags', 'i16', [1, -2, 3, -4]);
    const ratio = module.state('ratio', 'f64', 0);
    const data = module.bytes('data', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), {
      readonly: false,
    });
    const run = module.entry('run', ['u32', 'i16', 'u32']);
    run.body((b, [index, value, offset]) => {
      b.state.store(count, b.int.add(b.state.load(count), b.const('u32', 1)));
      b.array.store(flags, index, value);
      const loaded = b.bytes.load('u16', 'little', data, offset);
      b.bytes.store('u16', 'big', data, offset, loaded);
      b.return([]);
    });
    const floats = module.entry('floats', ['f64']);
    floats.body((b, [value]) => {
      b.state.store(ratio, value);
      b.return([]);
    });
    return { module, count, flags, ratio, data, run, floats };
  }

  function pair() {
    const fixture_ = fixture();
    const jit = compile(fixture_.module);
    const reference = createIRInterpreter(fixture_.module, {
      validation: policy(fixture_.module),
    });
    return { ...fixture_, jit, reference };
  }

  it('writes state, arrays and bytes exactly like the reference', () => {
    const { jit, reference, count, flags, data, run } = pair();
    jit.execute(run, [2, -7, 1], context);
    reference.execute(run, [2, -7, 1], context);
    expect(jit.setup.storage.loadState(count)).toBe(reference.storage.loadState(count));
    for (let index = 0; index < 4; index += 1) {
      expect(jit.setup.storage.loadArray(flags, index)).toBe(
        reference.storage.loadArray(flags, index),
      );
    }
    expect(Array.from(jit.setup.storage.readVersionedBytes(data, 0, 8).bytes)).toEqual(
      Array.from(reference.storage.readVersionedBytes(data, 0, 8).bytes),
    );
  });

  it('stores float NaN with canonical bits', () => {
    const { jit, reference, ratio, floats } = pair();
    for (const value of [NaN, -0, 1.5, Infinity]) {
      jit.execute(floats, [value], context);
      reference.execute(floats, [value], context);
      expect(jit.setup.storage.loadState(ratio)).toEqual(reference.storage.loadState(ratio));
    }
  });

  it('propagates out-of-bounds errors with the reference location and steps', () => {
    const arrayCase = pair();
    const expectedArray = capture(() =>
      arrayCase.reference.execute(arrayCase.run, [9, 1, 0], context),
    );
    expect(expectedArray).toMatchObject({ ok: false, code: 'storage-failed' });
    expect(capture(() => arrayCase.jit.execute(arrayCase.run, [9, 1, 0], context))).toEqual(
      expectedArray,
    );

    const byteCase = pair();
    const expectedBytes = capture(() =>
      byteCase.reference.execute(byteCase.run, [0, 1, 7], context),
    );
    expect(expectedBytes).toMatchObject({ ok: false, code: 'storage-failed' });
    expect(capture(() => byteCase.jit.execute(byteCase.run, [0, 1, 7], context))).toEqual(
      expectedBytes,
    );
  });

  it('matches bytes.copy, updateBytes and fillBytes', () => {
    const module = createIRModule();
    const target = module.bytes('target', new Uint8Array(8), { readonly: false });
    const source = module.bytes('source', new Uint8Array([9, 8, 7, 6]), { readonly: true });
    const run = module.entry('run', []);
    run.body((b) => {
      b.bytes.copy(target, b.const('u32', 1), source, b.const('u32', 0), b.const('u32', 3));
      b.resource.updateBytes(
        target,
        b.const('u32', 6),
        source,
        b.const('u32', 1),
        b.const('u32', 2),
      );
      b.resource.fillBytes(target, b.const('u32', 0), b.const('u32', 1), b.const('u8', 0xfe));
      b.return([]);
    });
    const validation: IRValidationOptions = {
      supportedInstructions: CORE_INSTRUCTION_NAMES,
      authorizedInstructions: CORE_INSTRUCTION_NAMES,
      resources: [
        { ref: target, access: 'read-write' },
        { ref: target, access: 'update' },
        { ref: source, access: 'read' },
      ],
    };
    const jit = compileModule(module, { validation });
    const reference = createIRInterpreter(module, { validation });
    jit.execute(run, [], context);
    reference.execute(run, [], context);
    const read = (storage: IRStorage, ref: BytesRef) =>
      Array.from(storage.readVersionedBytes(ref, 0, 8).bytes);
    expect(read(jit.setup.storage, target)).toEqual(read(reference.storage, target));
  });
});
/* -------------------------------------------------------------------------
 * Control flow
 * ---------------------------------------------------------------------- */

describe('JIT control flow', () => {
  it('structures if/else diamonds', () => {
    const module = createIRModule();
    const run = module.func('run', { params: ['bool', 'i32'], results: ['i32'] });
    run.body((b, [flag, value]) => {
      const yes = b.block([]);
      const no = b.block([]);
      const join = b.block(['i32']);
      b.branch(flag, { target: yes, args: [] }, { target: no, args: [] });
      b.at(yes, (inner) => inner.jump(join, [inner.int.add(value, inner.const('i32', 1))]));
      b.at(no, (inner) => inner.jump(join, [inner.int.sub(value, inner.const('i32', 1))]));
      b.at(join, (inner, [result]) => inner.return([result]));
    });
    const jit = compare(module, run, [
      [true, 10],
      [false, 10],
      [true, -0x80000000],
    ]);
    expect(jit.functions[0]!.structured).toBe(true);
  });

  it('structures nested loops', () => {
    const module = createIRModule();
    const sum = module.func('sum', { params: ['u32', 'u32'], results: ['u32'] });
    sum.body((b, [outerCount, innerCount]) => {
      const zero = b.const('u32', 0);
      const one = b.const('u32', 1);
      const outer = b.block(['u32', 'u32']);
      const innerHead = b.block(['u32', 'u32', 'u32']);
      const innerBody = b.block(['u32', 'u32', 'u32']);
      const done = b.block(['u32']);
      b.jump(outer, [zero, zero]);
      b.at(outer, (c, [o, total]) =>
        c.branch(
          c.int.cmp('lt', o, outerCount),
          { target: innerHead, args: [zero, total, o] },
          { target: done, args: [total] },
        ),
      );
      b.at(innerHead, (c, [i, total, o]) =>
        c.branch(
          c.int.cmp('lt', i, innerCount),
          { target: innerBody, args: [i, total, o] },
          { target: outer, args: [c.int.add(o, one), total] },
        ),
      );
      b.at(innerBody, (c, [i, total, o]) =>
        c.jump(innerHead, [c.int.add(i, one), c.int.add(total, i), o]),
      );
      b.at(done, (c, [total]) => c.return([total]));
    });
    const jit = compare(module, sum, [
      [0, 0],
      [1, 3],
      [4, 5],
    ]);
    if (!jit.functions[0]!.structured) throw new Error(`fallback: ${jit.functions[0]!.fallback}`);
    expect(jit.source(0).match(/for \(;;\)/g)).toHaveLength(2);
  });
  it('structures a loop nested inside a conditional', () => {
    const module = createIRModule();
    const run = module.func('run', { params: ['bool', 'u32'], results: ['u32'] });
    run.body((b, [flag, n]) => {
      const zero = b.const('u32', 0);
      const one = b.const('u32', 1);
      const head = b.block(['u32', 'u32']);
      const body = b.block(['u32', 'u32']);
      const join = b.block(['u32']);
      b.branch(flag, { target: head, args: [zero, zero] }, { target: join, args: [zero] });
      b.at(head, (c, [index, total]) =>
        c.branch(
          c.int.cmp('lt', index, n),
          { target: body, args: [index, total] },
          { target: join, args: [total] },
        ),
      );
      b.at(body, (c, [index, total]) =>
        c.jump(head, [c.int.add(index, one), c.int.add(total, index)]),
      );
      b.at(join, (c, [total]) => c.return([total]));
    });
    const jit = compare(module, run, [
      [true, 0],
      [true, 4],
      [false, 4],
    ]);
    expect(jit.functions[0]!.structured).toBe(true);
  });

  it('handles self-backedges that swap block parameters', () => {
    const module = createIRModule();
    const run = module.func('run', { params: ['u32', 'u32'], results: ['u32'] });
    run.body((b, [first, second]) => {
      const loop = b.block(['u32', 'u32']);
      const done = b.block(['u32']);
      b.jump(loop, [first, second]);
      b.at(loop, (c, [left, right]) =>
        c.branch(
          c.int.cmp('eq', left, c.const('u32', 0)),
          { target: done, args: [right] },
          { target: loop, args: [right, c.int.sub(left, c.const('u32', 1))] },
        ),
      );
      b.at(done, (c, [value]) => c.return([value]));
    });
    const jit = compare(module, run, [
      [0, 9],
      [1, 9],
      [5, 3],
      [12, 4],
    ]);
    expect(jit.source(0)).toContain('continue L1;');
  });

  it('structures a diamond inside a loop body', () => {
    const module = createIRModule();
    const run = module.func('run', { params: ['u32'], results: ['u32'] });
    run.body((b, [n]) => {
      const zero = b.const('u32', 0);
      const one = b.const('u32', 1);
      const head = b.block(['u32', 'u32']);
      const body = b.block(['u32', 'u32']);
      const even = b.block(['u32', 'u32']);
      const odd = b.block(['u32', 'u32']);
      const cont = b.block(['u32', 'u32']);
      const done = b.block(['u32']);
      b.jump(head, [zero, zero]);
      b.at(head, (c, [index, total]) =>
        c.branch(
          c.int.cmp('lt', index, n),
          { target: body, args: [index, total] },
          { target: done, args: [total] },
        ),
      );
      b.at(body, (c, [index, total]) =>
        c.branch(
          c.int.cmp('eq', c.int.and(index, c.const('u32', 1)), zero),
          { target: even, args: [index, total] },
          { target: odd, args: [index, total] },
        ),
      );
      b.at(even, (c, [index, total]) => c.jump(cont, [index, c.int.add(total, index)]));
      b.at(odd, (c, [index, total]) => c.jump(cont, [index, c.int.add(total, one)]));
      b.at(cont, (c, [index, total]) => c.jump(head, [c.int.add(index, one), total]));
      b.at(done, (c, [total]) => c.return([total]));
    });
    const jit = compare(module, run, [[0], [1], [5], [10]]);
    expect(jit.functions[0]!.structured).toBe(true);
  });

  it('supports loops with several exit edges to one target', () => {
    const module = createIRModule();
    const run = module.func('run', { params: ['u32', 'u32'], results: ['u32'] });
    run.body((b, [limit, stopAt]) => {
      const zero = b.const('u32', 0);
      const one = b.const('u32', 1);
      const head = b.block(['u32']);
      const body = b.block(['u32']);
      const done = b.block(['u32']);
      b.jump(head, [zero]);
      b.at(head, (c, [index]) =>
        c.branch(
          c.int.cmp('lt', index, limit),
          { target: body, args: [index] },
          { target: done, args: [index] },
        ),
      );
      b.at(body, (c, [index]) =>
        c.branch(
          c.int.cmp('eq', index, stopAt),
          { target: done, args: [index] },
          { target: head, args: [c.int.add(index, one)] },
        ),
      );
      b.at(done, (c, [index]) => c.return([index]));
    });
    compare(module, run, [
      [10, 3],
      [10, 20],
      [0, 0],
      [10, 0],
    ]);
  });

  it('falls back to switch dispatch for loops with distinct exit targets', () => {
    const module = createIRModule();
    const run = module.func('run', { params: ['bool', 'u32'], results: ['u32'] });
    run.body((b, [flag, limit]) => {
      const zero = b.const('u32', 0);
      const one = b.const('u32', 1);
      const head = b.block(['u32']);
      const body = b.block(['u32']);
      const left = b.block(['u32']);
      const right = b.block(['u32']);
      b.jump(head, [zero]);
      b.at(head, (c, [index]) =>
        c.branch(
          c.int.cmp('lt', index, limit),
          { target: body, args: [index] },
          { target: left, args: [index] },
        ),
      );
      b.at(body, (c, [index]) =>
        c.branch(flag, { target: left, args: [index] }, { target: right, args: [index] }),
      );
      b.at(left, (c, [index]) => c.return([c.int.add(index, one)]));
      b.at(right, (c, [index]) => c.return([c.int.mul(index, c.const('u32', 2))]));
    });
    const jit = compare(module, run, [
      [true, 4],
      [false, 4],
      [false, 0],
    ]);
    expect(jit.functions[0]!.structured).toBe(false);
    expect(jit.source(0)).toContain('switch (pc)');
  });

  it('falls back to switch dispatch for irreducible graphs', () => {
    const module = createIRModule();
    const run = module.func('run', { params: ['bool', 'bool'], results: ['u32'] });
    run.body((b, [first, second]) => {
      const a = b.block([]);
      const c = b.block([]);
      const d = b.block([]);
      const done = b.block([]);
      b.branch(first, { target: a, args: [] }, { target: c, args: [] });
      b.at(a, (inner) => inner.jump(c, []));
      b.at(c, (inner) => inner.branch(second, { target: a, args: [] }, { target: done, args: [] }));
      b.at(done, (inner) => inner.return([inner.const('u32', 99)]));
      b.at(d, (inner) => inner.return([inner.const('u32', 123456789)]));
    });
    const jit = compare(module, run, [
      [true, true],
      [false, true],
      [true, false],
      [false, false],
    ]);
    expect(jit.mir[0]!.reducible).toBe(false);
    expect(jit.functions[0]!.structured).toBe(false);
    // The unreachable block's marker never reaches generated source.
    expect(jit.source(0)).toContain('switch (pc)');
    expect(jit.source(0)).not.toContain('123456789');
  });
});

/* -------------------------------------------------------------------------
 * Calls and the calling convention
 * ---------------------------------------------------------------------- */

describe('JIT calling convention', () => {
  it('calls functions with zero, one and several results', () => {
    const module = createIRModule();
    const out = module.state('out', 'u32', 0);
    const touch = module.func('touch', { params: ['u32'], results: [] });
    touch.body((b, [value]) => {
      b.state.store(out, value);
      b.return([]);
    });
    const split = module.func('split', { params: ['u32'], results: ['u32', 'i32'] });
    split.body((b, [value]) =>
      b.return([
        b.int.add(value, b.const('u32', 1)),
        b.int.sub(b.const('i32', 0), b.int.reinterpret('i32', value)),
      ]),
    );
    const run = module.entry('run', ['u32']);
    run.body((b, [value]) => {
      b.call(touch, [value]);
      const [quotient, negated] = b.call(split, [value]);
      b.state.store(
        out,
        b.int.add(b.state.load(out), b.int.add(quotient, b.int.reinterpret('u32', negated))),
      );
      b.return([]);
    });
    const jit = compile(module);
    const reference = createIRInterpreter(module, { validation: policy(module) });
    for (const value of [0, 1, 21, 0xffffffff]) {
      const expected = capture(() => reference.execute(run, [value], context));
      const actual = capture(() => jit.execute(run, [value], context));
      expect({ value, actual }).toEqual({ value, actual: expected });
    }
    expect(jit.setup.storage.loadState(out)).toBe(reference.storage.loadState(out));
  });
  it('supports nested (non-recursive) call chains', () => {
    // Ordinary IR calls may not be recursive (`recursive-call`), so the depth
    // test uses an acyclic chain instead.
    const module = createIRModule();
    const third = module.func('third', { params: ['u32'], results: ['u32'] });
    third.body((b, [value]) => b.return([b.int.add(value, b.const('u32', 1))]));
    const second = module.func('second', { params: ['u32'], results: ['u32'] });
    second.body((b, [value]) => {
      const [first] = b.call(third, [value]);
      const [again] = b.call(third, [first]);
      b.return([b.int.add(first, again)]);
    });
    const first = module.func('first', { params: ['u32'], results: ['u32'] });
    first.body((b, [value]) => {
      const [left] = b.call(second, [value]);
      const [right] = b.call(second, [left]);
      b.return([b.int.add(left, right)]);
    });
    compare(module, first, [[0], [1], [5], [0xffffffff]]);
  });
});

/* -------------------------------------------------------------------------
 * Provider dispatch (TAIL transfers)
 * ---------------------------------------------------------------------- */

describe('JIT provider dispatch', () => {
  it('tail-transfers to a materialized artifact and returns its result', () => {
    const module = createIRModule();
    const scale = module.provider(
      'scale',
      { keyTypes: ['u32'], params: ['u32'], results: ['u32'], reads: [], imports: [] },
      (gen, [factor]) =>
        gen.function((b, [value]) => b.return([b.int.mul(value, b.const('u32', factor))])),
    );
    const run = module.func('run', { params: ['u32', 'u32'], results: ['u32'] });
    run.body((b, [value, factor]) => b.dispatch(scale, [factor], [value]));

    const jit = compile(module);
    const reference = createIRInterpreter(module, { validation: policy(module) });
    for (const args of [
      [7, 3],
      [0, 5],
      [0xffffffff, 2],
    ] as const) {
      const expected = capture(() => reference.execute(run, args, context));
      const actual = capture(() => jit.execute(run, args, context));
      expect({ args, actual }).toEqual({ args, actual: expected });
    }
    // The tail target was consumed by the driver.
    expect(jit.runtime.tailFn).toBeUndefined();
  });

  it('returns TAIL through a call site inside a loop', () => {
    const module = createIRModule();
    const scale = module.provider(
      'scale',
      { keyTypes: ['u32'], params: ['u32'], results: ['u32'], reads: [], imports: [] },
      (gen, [factor]) =>
        gen.function((b, [value]) => b.return([b.int.add(value, b.const('u32', factor))])),
    );
    const helper = module.func('helper', { params: ['u32', 'u32'], results: ['u32'] });
    helper.body((b, [value, factor]) => b.dispatch(scale, [factor], [value]));
    const run = module.func('run', { params: ['u32'], results: ['u32'] });
    run.body((b, [n]) => {
      const zero = b.const('u32', 0);
      const one = b.const('u32', 1);
      const head = b.block(['u32', 'u32']);
      const body = b.block(['u32', 'u32']);
      const done = b.block(['u32']);
      b.jump(head, [zero, zero]);
      b.at(head, (c, [index, total]) =>
        c.branch(
          c.int.cmp('lt', index, n),
          { target: body, args: [index, total] },
          { target: done, args: [total] },
        ),
      );
      b.at(body, (c, [inside, sum]) => {
        const [next] = c.call(helper, [inside, one]);
        c.jump(head, [c.int.add(inside, one), c.int.add(sum, next)]);
      });
      b.at(done, (c, [total]) => c.return([total]));
    });

    const jit = compile(module);
    expect(jit.mir.some((fn) => fn.name === 'helper')).toBe(true);
    const reference = createIRInterpreter(module, { validation: policy(module) });
    for (const n of [0, 1, 4]) {
      const expected = capture(() => reference.execute(run, [n], context));
      const actual = capture(() => jit.execute(run, [n], context));
      expect({ n, actual }).toEqual({ n, actual: expected });
    }
  });
});

/* -------------------------------------------------------------------------
 * Step budget
 * ---------------------------------------------------------------------- */

describe('JIT step budget', () => {
  it('consumes exactly the reference number of steps at host boundaries', () => {
    const build = () => {
      const module = createIRModule();
      const boundarySteps: number[] = [];
      let consumed = 0;
      const budget = {
        remaining: () => 1_000,
        consume: (_context: unknown, steps: number) => {
          consumed += steps;
        },
      };
      const eventHost = {
        now: () => {
          boundarySteps.push(consumed);
          return 100;
        },
        at: () => 1,
        cancel: () => undefined,
      };
      const run = module.entry('run', ['u32']);
      run.body((b, [n]) => {
        const zero = b.const('u32', 0);
        const one = b.const('u32', 1);
        const head = b.block(['u32']);
        const body = b.block(['u32']);
        const done = b.block(['u32']);
        b.jump(head, [zero]);
        b.at(head, (c, [index]) =>
          c.branch(
            c.int.cmp('lt', index, n),
            { target: body, args: [index] },
            { target: done, args: [index] },
          ),
        );
        b.at(body, (c, [index]) => {
          c.event.now();
          c.jump(head, [c.int.add(index, one)]);
        });
        b.at(done, (c) => c.return([]));
      });
      return { module, run, budget, eventHost, boundarySteps };
    };

    const jitFixture = build();
    const refFixture = build();
    const jit = compileModule(jitFixture.module, {
      validation: policy(jitFixture.module),
      stepBudget: jitFixture.budget,
      eventHost: jitFixture.eventHost,
    });
    const reference = createIRInterpreter(refFixture.module, {
      validation: policy(refFixture.module),
      stepBudget: refFixture.budget,
      eventHost: refFixture.eventHost,
    });
    const expected = capture(() => reference.execute(refFixture.run, [4], context));
    const actual = capture(() => jit.execute(jitFixture.run, [4], context));
    expect(actual).toEqual(expected);
    // At each host call both engines have committed exactly the steps that
    // completed so far (R3), even though the JIT batches them.
    expect(jitFixture.boundarySteps).toEqual(refFixture.boundarySteps);
    expect(jitFixture.boundarySteps).toHaveLength(4);
  });

  it('honours invalid remaining() values without changing results', () => {
    const { module, sum } = countedLoopFixture();
    const jit = compile(module);
    const reference = referenceRunner(module);
    const expected = reference(sum, [3]);
    for (const remaining of [0, 1, 3, Number.MAX_SAFE_INTEGER, -1, NaN, 1.5]) {
      const budget = { remaining: () => remaining, consume: () => undefined };
      const jitBudget = compileModule(module, {
        validation: policy(module),
        stepBudget: budget,
      });
      const actual = capture(() => jitBudget.execute(sum, [3], context));
      expect({ remaining: String(remaining), actual }).toEqual({
        remaining: String(remaining),
        actual: expected,
      });
      void jit;
    }
  });
  it('matches the reference when consume() throws', () => {
    const { module, sum } = countedLoopFixture();
    const createBudget = () => {
      const cause = new Error('host accounting failed');
      let calls = 0;
      return {
        budget: {
          // Exhausted remaining forces the exact path, so the very first
          // consume call throws before any step runs in both engines.
          remaining: () => 0,
          consume: () => {
            calls += 1;
            throw cause;
          },
        },
        calls: () => calls,
      };
    };
    const jitBudget = createBudget();
    const refBudget = createBudget();
    const jit = compileModule(module, {
      validation: policy(module),
      stepBudget: jitBudget.budget,
    });
    const reference = createIRInterpreter(module, {
      validation: policy(module),
      stepBudget: refBudget.budget,
    });
    const expected = capture(() => reference.execute(sum, [2], context));
    const actual = capture(() => jit.execute(sum, [2], context));
    expect(actual).toEqual(expected);
    expect(jitBudget.calls()).toBe(1);
    expect(refBudget.calls()).toBe(1);
  });

  it('invokes beforeStep once per step in observer mode', () => {
    const { module, sum } = countedLoopFixture();
    const seen: number[] = [];
    const jit = compileModule(module, {
      validation: policy(module),
      stepObserver: { beforeStep: () => seen.push(seen.length) },
    });
    const reference = createIRInterpreter(module, {
      validation: policy(module),
      stepObserver: { beforeStep: () => seen.push(seen.length) },
    });
    const expected = capture(() => reference.execute(sum, [2], context));
    const referenceObserved = seen.length;
    seen.length = 0;
    const actual = capture(() => jit.execute(sum, [2], context));
    expect(actual).toEqual(expected);
    expect(seen.length).toBe(referenceObserved);
  });
});

/* -------------------------------------------------------------------------
 * Domain executors (host instructions)
 * ---------------------------------------------------------------------- */

describe('JIT executor instructions', () => {
  it('passes captured operands and captures results like the reference', () => {
    const module = createIRModule();
    const probe = module.domainInstruction('probe.mix', {
      operands: [
        { kind: 'value', type: 'u32' },
        { kind: 'value', type: 'f64' },
      ],
      results: ['u32', 'f64'],
    });
    const run = module.func('run', { params: ['u32', 'f64'], results: ['u32', 'f64'] });
    run.body((b, [count, value]) => {
      const [next, doubled] = b.invoke(probe, [count, value]);
      b.return([next, doubled]);
    });
    const validation: IRValidationOptions = {
      supportedInstructions: [...CORE_INSTRUCTION_NAMES, 'probe.mix'],
      authorizedInstructions: [...CORE_INSTRUCTION_NAMES, 'probe.mix'],
      resources: [],
      validators: [{ op: 'probe.mix', validate: () => [] }],
    };
    const observed: unknown[][] = [];
    const executor = {
      op: 'probe.mix',
      execute(request: { operands: readonly RuntimeScalar[] }): readonly RuntimeScalar[] {
        observed.push([...request.operands]);
        return [Number(request.operands[0]) + 1, request.operands[1]!];
      },
    };

    const jit = compileModule(module, { validation, executors: [executor] });
    const referenceObserved: unknown[][] = [];
    const reference = createIRInterpreter(module, {
      validation,
      executors: [
        {
          op: 'probe.mix',
          execute(request): readonly RuntimeScalar[] {
            referenceObserved.push([...request.operands]);
            return [Number(request.operands[0]) + 1, request.operands[1]!];
          },
        },
      ],
    });

    for (const args of [
      [1, 1.5],
      [0, NaN],
    ] as const) {
      const expected = capture(() => reference.execute(run, args, context));
      const actual = capture(() => jit.execute(run, args, context));
      expect({ args, actual }).toEqual({ args, actual: expected });
    }
    expect(observed).toEqual(referenceObserved);
    expect(observed[0]).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------
 * Security
 * ---------------------------------------------------------------------- */

describe('JIT source safety', () => {
  it('never interpolates user strings into generated source', () => {
    const hostile = 'evil`${x}*/</script>\u2028\u2029';
    const module = createIRModule();
    const fn = module.func(hostile, { params: ['u32'], results: ['u32'] });
    fn.body((b) => {
      b.trap(hostile);
    });
    const jit = compile(module);
    const source = jit.source(0);
    for (const needle of ['*/', '`', '${', '</script>', '\u2028', '\u2029']) {
      expect(source).not.toContain(needle);
    }
    const outcome = capture(() => jit.execute(fn, [0], context));
    expect(outcome).toMatchObject({ ok: false, code: 'trap' });
    if (!outcome.ok) expect(outcome.message).toBe(`IR trap: ${hostile}`);

    const reference = createIRInterpreter(module, { validation: policy(module) });
    const expected = capture(() => reference.execute(fn, [0], context));
    expect(outcome).toEqual(expected);
  });

  it('formats numeric literals without losing -0, NaN or infinities', () => {
    const module = createIRModule();
    const literal = module.func('literal', { params: [], results: ['f64', 'f64', 'f64'] });
    literal.body((b) =>
      b.return([b.const('f64', -0), b.const('f64', NaN), b.const('f64', -Infinity)]),
    );
    const jit = compare(module, literal, [[]]);
    const source = jit.source(0);
    expect(source).toContain('-0');
    expect(source).toContain('NaN');
    expect(source).toContain('-Infinity');
  });
});

/* -------------------------------------------------------------------------
 * Snapshots
 * ---------------------------------------------------------------------- */

describe('JIT source snapshots', () => {
  it('keeps representative functions readable', () => {
    const module = createIRModule();
    const add = module.func('add', { params: ['u32', 'u32'], results: ['u32'] });
    add.body((b, [x, y]) => b.return([b.int.add(x, y)]));
    const branch = module.func('pick', { params: ['bool', 'u32'], results: ['u32'] });
    branch.body((b, [flag, value]) => {
      const yes = b.block([]);
      const no = b.block([]);
      const join = b.block(['u32']);
      b.branch(flag, { target: yes, args: [] }, { target: no, args: [] });
      b.at(yes, (inner) => inner.jump(join, [inner.const('u32', 1)]));
      b.at(no, (inner) => inner.jump(join, [inner.const('u32', 2)]));
      b.at(join, (inner, [result]) => inner.return([inner.int.add(result, value)]));
    });
    const jit = compile(module);
    expect(jit.source(0)).toMatchInlineSnapshot(`
      "'use strict';
      const F = k[0];
      return function f0(p0, p1) {
        const d = rt.depth;
        if (d >= rt.maxDepth) return rt.deep(0, p0, p1);
        rt.depth = d + 1;
        let L = -1;
        let v0 = 0, v1 = 0, v2 = 0;
        v0 = p0;
        v1 = p1;
        try {
        if (rt.steps + 2 > rt.limit) {
          L = 2;
          if (rt.steps >= rt.limit) rt.limitReached(F.locations[2]);
          rt.steps += 1;
          v2 = ((v0 + v1) >>> 0);
          L = 1;
          if (rt.steps >= rt.limit) rt.limitReached(F.locations[1]);
          rt.steps += 1;
        } else {
          rt.steps += 2;
          v2 = ((v0 + v1) >>> 0);
          L = 1;
        }
        rt.depth = d;
        return v2;
        } catch (e) {
          rt.depth = d;
          throw rt.unwind(e, L, F);
        }
      };
      //# sourceURL=mica-ir-jit/f0.js"
    `);
    expect(jit.source(1)).toMatchInlineSnapshot(`
      "'use strict';
      const F = k[0];
      return function f1(p0, p1) {
        const d = rt.depth;
        if (d >= rt.maxDepth) return rt.deep(1, p0, p1);
        rt.depth = d + 1;
        let L = -1;
        let v0 = false, v1 = 0, v4 = 0, v5 = 0;
        v0 = p0;
        v1 = p1;
        try {
        L = 0;
        if (rt.steps + 1 > rt.limit) {
          if (rt.steps >= rt.limit) rt.limitReached(F.locations[0]);
          rt.steps += 1;
        } else {
          rt.steps += 1;
        }
        if (v0) {
          if (rt.steps + 2 > rt.limit) {
            L = 8;
            if (rt.steps >= rt.limit) rt.limitReached(F.locations[8]);
            rt.steps += 1;
            L = 2;
            if (rt.steps >= rt.limit) rt.limitReached(F.locations[2]);
            rt.steps += 1;
          } else {
            rt.steps += 2;
            L = 2;
          }
          v4 = 1;
        } else {
          if (rt.steps + 2 > rt.limit) {
            L = 10;
            if (rt.steps >= rt.limit) rt.limitReached(F.locations[10]);
            rt.steps += 1;
            L = 4;
            if (rt.steps >= rt.limit) rt.limitReached(F.locations[4]);
            rt.steps += 1;
          } else {
            rt.steps += 2;
            L = 4;
          }
          v4 = 2;
        }
        if (rt.steps + 2 > rt.limit) {
          L = 12;
          if (rt.steps >= rt.limit) rt.limitReached(F.locations[12]);
          rt.steps += 1;
          v5 = ((v4 + v1) >>> 0);
          L = 6;
          if (rt.steps >= rt.limit) rt.limitReached(F.locations[6]);
          rt.steps += 1;
        } else {
          rt.steps += 2;
          v5 = ((v4 + v1) >>> 0);
          L = 6;
        }
        rt.depth = d;
        return v5;
        } catch (e) {
          rt.depth = d;
          throw rt.unwind(e, L, F);
        }
      };
      //# sourceURL=mica-ir-jit/f1.js"
    `);

    // Third representative function: a counted loop (structured form).
    const { module: loopModule } = countedLoopFixture();
    expect(compile(loopModule).source(0)).toMatchInlineSnapshot(`
      "'use strict';
      const F = k[0];
      return function f0(p0) {
        const d = rt.depth;
        if (d >= rt.maxDepth) return rt.deep(0, p0);
        rt.depth = d + 1;
        let L = -1;
        let v0 = 0, v3 = 0, v4 = 0, v5 = false, v6 = 0, v7 = 0, v8 = 0, v9 = 0, v10 = 0;
        v0 = p0;
        try {
        if (rt.steps + 3 > rt.limit) {
          L = 9;
          if (rt.steps >= rt.limit) rt.limitReached(F.locations[9]);
          rt.steps += 1;
          L = 10;
          if (rt.steps >= rt.limit) rt.limitReached(F.locations[10]);
          rt.steps += 1;
          L = 2;
          if (rt.steps >= rt.limit) rt.limitReached(F.locations[2]);
          rt.steps += 1;
        } else {
          rt.steps += 3;
          L = 2;
        }
        v3 = 0;
        v4 = 0;
        L1: for (;;) {
          if (rt.steps + 2 > rt.limit) {
            L = 12;
            if (rt.steps >= rt.limit) rt.limitReached(F.locations[12]);
            rt.steps += 1;
            v5 = v3 < v0;
            L = 4;
            if (rt.steps >= rt.limit) rt.limitReached(F.locations[4]);
            rt.steps += 1;
          } else {
            rt.steps += 2;
            v5 = v3 < v0;
            L = 4;
          }
          if (v5) {
            v6 = v3;
            v7 = v4;
            if (rt.steps + 3 > rt.limit) {
              L = 14;
              if (rt.steps >= rt.limit) rt.limitReached(F.locations[14]);
              rt.steps += 1;
              v8 = ((v6 + 1) >>> 0);
              L = 15;
              if (rt.steps >= rt.limit) rt.limitReached(F.locations[15]);
              rt.steps += 1;
              v9 = ((v7 + v8) >>> 0);
              L = 7;
              if (rt.steps >= rt.limit) rt.limitReached(F.locations[7]);
              rt.steps += 1;
            } else {
              rt.steps += 3;
              v8 = ((v6 + 1) >>> 0);
              v9 = ((v7 + v8) >>> 0);
              L = 7;
            }
            v3 = v8;
            v4 = v9;
            continue L1;
          } else {
            v10 = v4;
            break L1;
          }
        }
        L = 8;
        if (rt.steps + 1 > rt.limit) {
          if (rt.steps >= rt.limit) rt.limitReached(F.locations[8]);
          rt.steps += 1;
        } else {
          rt.steps += 1;
        }
        rt.depth = d;
        return v10;
        } catch (e) {
          rt.depth = d;
          throw rt.unwind(e, L, F);
        }
      };
      //# sourceURL=mica-ir-jit/f0.js"
    `);
  });
});
