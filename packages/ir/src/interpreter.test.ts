import { describe, expect, it } from 'vitest';
import { CORE_INSTRUCTION_NAMES } from './builder';
import {
  createIRInterpreter,
  createIRModule,
  createIRStorage,
  IRExecutionError,
  IRFloatEvaluationError,
  IRScalarEvaluationError,
  IRStorageError,
  validateIR,
  type FloatBits,
  type FunctionRef,
  type IRExecutionErrorCode,
  type IRModule,
  type IRValidationOptions,
  type RuntimeScalar,
} from './index';

const context = { instanceId: 'device-46', virtualTime: 1234 };

function policy(module: IRModule, changes: Partial<IRValidationOptions> = {}): IRValidationOptions {
  return {
    supportedInstructions: CORE_INSTRUCTION_NAMES,
    authorizedInstructions: CORE_INSTRUCTION_NAMES,
    resources: module.memories.map((memory) => ({
      ref: memory.ref,
      access: memory.writable ? 'read-write' : 'read',
    })),
    ...changes,
  };
}

function interpreter(module: IRModule, maxSteps?: number) {
  const validation = policy(module);
  expect(validateIR(module, validation)).toEqual({ ok: true, diagnostics: [] });
  return createIRInterpreter(module, {
    validation,
    ...(maxSteps === undefined ? {} : { maxSteps }),
  });
}

function error(run: () => unknown, code: IRExecutionErrorCode): IRExecutionError {
  let caught: unknown;
  try {
    run();
  } catch (cause) {
    caught = cause;
  }
  expect(caught).toBeInstanceOf(IRExecutionError);
  const failure = caught as IRExecutionError;
  expect(failure.code).toBe(code);
  expect(failure.name).toBe('IRExecutionError');
  return failure;
}

function sumFixture() {
  const module = createIRModule();
  const sum = module.func('sum', { params: ['u32'], results: ['u32'] });
  sum.body((b, [n]) => {
    const zero = b.const('u32', 0);
    const one = b.const('u32', 1);
    const loop = b.block(['u32', 'u32']);
    const body = b.block(['u32', 'u32']);
    const done = b.block(['u32']);
    b.jump(loop, [zero, zero]);
    b.at(loop, (b, [index, total]) =>
      b.branch(
        b.int.cmp('lt', index, n),
        { target: body, args: [index, total] },
        { target: done, args: [total] },
      ),
    );
    b.at(body, (b, [index, total]) => {
      const next = b.int.add(index, one);
      b.jump(loop, [next, b.int.add(total, next)]);
    });
    b.at(done, (b, [total]) => b.return([total]));
  });
  return { module, sum };
}

function identityFixture() {
  const module = createIRModule();
  const identity = module.func('identity', { params: ['u32'], results: ['u32'] });
  identity.body((b, [value]) => b.return([value]));
  return { module, identity };
}

describe('reference interpreter control flow', () => {
  it('executes real IR identity and captures context without changing time', () => {
    const { module, identity } = identityFixture();
    const runtime = interpreter(module);
    expect(runtime.execute(identity, [42], context)).toEqual({ values: [42], steps: 1 });
    expect(runtime.execute(identity, [0xffffffff], context)).toEqual({
      values: [0xffffffff],
      steps: 1,
    });
    expect(context).toEqual({ instanceId: 'device-46', virtualTime: 1234 });
  });

  it.each([true, false])(
    'executes only the chosen branch and merges its block arguments (%s)',
    (condition) => {
      const module = createIRModule();
      const choose = module.func('choose', { params: ['bool', 'u32'], results: ['u32'] });
      choose.body((b, [test, value]) => {
        const yes = b.block([]);
        const no = b.block([]);
        const join = b.block(['u32']);
        b.branch(test, { target: yes, args: [] }, { target: no, args: [] });
        b.at(yes, (b) => b.jump(join, [b.int.add(value, b.const('u32', 3))]));
        b.at(no, (b) => b.jump(join, [b.int.sub(value, b.const('u32', 2))]));
        b.at(join, (b, [value]) => b.return([value]));
      });
      expect(interpreter(module).execute(choose, [condition, 10], context)).toEqual({
        values: [condition ? 13 : 8],
        steps: 5,
      });
    },
  );

  it('does not execute traps or expensive code in unselected branches', () => {
    const module = createIRModule();
    const choose = module.func('choose', { params: ['bool'], results: [] });
    choose.body((b, [test]) => {
      const yes = b.block([]);
      const no = b.block([]);
      b.branch(test, { target: yes, args: [] }, { target: no, args: [] });
      b.at(yes, (b) => b.return([]));
      b.at(no, (b) => b.trap('unselected'));
    });
    expect(interpreter(module, 2).execute(choose, [true], context)).toEqual({
      values: [],
      steps: 2,
    });
  });

  it.each([
    [0, 0, 6],
    [1, 1, 11],
    [10, 55, 56],
    [20_000, 200_010_000, 100_006],
  ])('executes the sum loop for %i with exact normalized IR cost', (n, expected, steps) => {
    const { module, sum } = sumFixture();
    expect(interpreter(module).execute(sum, [n], context)).toEqual({ values: [expected], steps });
  });

  it('binds backedge parameters simultaneously and preserves dominating function inputs', () => {
    const module = createIRModule();
    const swap = module.func('swap', { params: ['u32'], results: ['u32', 'u32'] });
    swap.body((b, [limit]) => {
      const loop = b.block(['u32', 'u32', 'u32']);
      const again = b.block([]);
      const done = b.block([]);
      const one = b.const('u32', 1);
      b.jump(loop, [b.const('u32', 10), b.const('u32', 20), b.const('u32', 0)]);
      b.at(loop, (b, [left, right, iteration]) => {
        b.branch(
          b.int.cmp('lt', iteration, limit),
          { target: again, args: [] },
          { target: done, args: [] },
        );
        b.at(again, (b) => b.jump(loop, [right, left, b.int.add(iteration, one)]));
        b.at(done, (b) => b.return([left, right]));
      });
    });
    const runtime = interpreter(module);
    expect(runtime.execute(swap, [3], context).values).toEqual([20, 10]);
    expect(runtime.execute(swap, [4], context).values).toEqual([10, 20]);
  });

  it('executes nested zero/one/multiple-result ordinary calls with independent SSA frames', () => {
    const module = createIRModule();
    const counter = module.state('counter', 'u32', 0);
    const notify = module.func('notify', { params: [], results: [] });
    notify.body((b) => {
      b.state.store(counter, b.int.add(b.state.load(counter), b.const('u32', 1)));
      b.return([]);
    });
    const divmod = module.func('divmod', { params: ['u32', 'u32'], results: ['u32', 'u32'] });
    divmod.body((b, [n, d]) => {
      b.call(notify, []);
      b.return([b.int.div(n, d), b.int.rem(n, d)]);
    });
    const middle = module.func('middle', { params: ['u32'], results: ['u32', 'u32', 'u32'] });
    middle.body((b, [n]) => {
      const [q, r] = b.call(divmod, [n, b.const('u32', 3)]);
      b.return([n, q, r]);
    });
    const outer = module.func('outer', { params: ['u32'], results: ['u32', 'u32', 'u32', 'u32'] });
    outer.body((b, [n]) => {
      const [original, q, r] = b.call(middle, [n]);
      const [q2] = b.call(divmod, [q, b.const('u32', 2)]);
      b.return([original, q, r, q2]);
    });
    const runtime = interpreter(module);
    expect(runtime.execute(outer, [20], context).values).toEqual([20, 6, 2, 3]);
    expect(runtime.storage.loadState(counter)).toBe(2);
  });

  it('executes a deep acyclic call graph without consuming the JavaScript call stack', () => {
    const { module, identity } = identityFixture();
    let target: FunctionRef<readonly ['u32'], readonly ['u32']> = identity;
    for (let index = 1; index < 4096; index += 1) {
      const previous = target;
      target = module.func(`level${index}`, { params: ['u32'], results: ['u32'] });
      target.body((b, [n]) => b.return(b.call(previous, [n])));
    }
    const runtime = interpreter(module, 8191);
    expect(runtime.execute(target, [91], context)).toEqual({ values: [91], steps: 8191 });
  }, 30_000);

  it('allows trusted host entry/lifecycle execution but uses the same instance storage', () => {
    const module = createIRModule();
    const state = module.state('state', 'u32', 0);
    const initialize = module.lifecycle('initialize', []);
    initialize.body((b) => {
      b.state.store(state, b.const('u32', 10));
      b.return([]);
    });
    const update = module.entry('update', ['u32']);
    update.body((b, [n]) => {
      b.state.store(state, b.int.add(b.state.load(state), n));
      b.return([]);
    });
    const runtime = interpreter(module);
    expect(runtime.execute(initialize, [], context).values).toEqual([]);
    expect(runtime.execute(update, [5], context).values).toEqual([]);
    expect(runtime.storage.loadState(state)).toBe(15);
  });
});

describe('deterministic execution budget', () => {
  it.each([0, 1, 2, 17, 10_000])(
    'halts a real infinite backedge at exactly %i steps',
    (maxSteps) => {
      const module = createIRModule();
      const spin = module.func('spin', { params: [], results: [] });
      spin.body((b) => {
        const loop = b.block([]);
        b.jump(loop, []);
        b.at(loop, (b) => b.jump(loop, []));
      });
      const runtime = interpreter(module, maxSteps);
      const failure = error(() => runtime.execute(spin, [], context), 'budget-exhausted');
      expect(failure.steps).toBe(maxSteps);
      expect(failure.context).toEqual(context);
      expect(failure.location).toMatchObject({
        functionName: 'spin',
        blockId: maxSteps === 0 ? 0 : 1,
        terminator: true,
      });
      error(() => runtime.execute(spin, [], context), 'instance-faulted');
    },
  );

  it('defaults to one million steps and stops without relying on a timer or stack overflow', () => {
    const module = createIRModule();
    const spin = module.func('spin', { params: [], results: [] });
    spin.body((b) => {
      const loop = b.block([]);
      b.jump(loop, []);
      b.at(loop, (b) => b.jump(loop, []));
    });
    const failure = error(() => interpreter(module).execute(spin, [], context), 'budget-exhausted');
    expect(failure.steps).toBe(1_000_000);
  });

  it('shares cost across nested call boundaries and counts call and both returns', () => {
    const { module, identity } = identityFixture();
    const outer = module.func('outer', { params: ['u32'], results: ['u32'] });
    outer.body((b, [n]) => b.return(b.call(identity, [n])));
    expect(interpreter(module, 3).execute(outer, [7], context)).toEqual({ values: [7], steps: 3 });
    const inCall = error(
      () => interpreter(module, 1).execute(outer, [7], context),
      'budget-exhausted',
    );
    expect(inCall.callStack.map((at) => at.functionName)).toEqual(['outer', 'identity']);
    expect(inCall.steps).toBe(1);
    const afterCall = error(
      () => interpreter(module, 2).execute(outer, [7], context),
      'budget-exhausted',
    );
    expect(afterCall.callStack.map((at) => at.functionName)).toEqual(['outer']);
    expect(afterCall.location).toMatchObject({ terminator: true });
  });

  it('does not commit the next store after the budget is exhausted', () => {
    const module = createIRModule();
    const state = module.state('state', 'u32', 0);
    const run = module.func('run', { params: [], results: [] });
    run.body((b) => {
      b.state.store(state, b.const('u32', 1));
      b.state.store(state, b.const('u32', 2));
      b.return([]);
    });
    const runtime = interpreter(module, 3);
    const failure = error(() => runtime.execute(run, [], context), 'budget-exhausted');
    expect(failure.steps).toBe(3);
    expect(failure.location).toMatchObject({ instructionIndex: 3 });
    expect(runtime.storage.loadState(state)).toBe(1);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid maxSteps %s',
    (maxSteps) => {
      const { module } = identityFixture();
      error(
        () => createIRInterpreter(module, { validation: policy(module), maxSteps }),
        'invalid-options',
      );
    },
  );
});

describe('execution errors and effect commit boundaries', () => {
  it('exposes the approved empty diagnostic defaults', () => {
    const failure = new IRExecutionError('trap', 'model trap');
    expect(failure).toMatchObject({ code: 'trap', steps: 0, callStack: [], diagnostics: [] });
    expect(failure.context).toBeUndefined();
    expect(failure.location).toBeUndefined();
    expect(failure.cause).toBeUndefined();
  });

  it('does not use select to suppress a failure in an already evaluated operand', () => {
    const module = createIRModule();
    const run = module.func('run', { params: ['u32'], results: ['u32'] });
    run.body((b, [divisor]) => {
      const good = b.const('u32', 8);
      const bad = b.int.div(good, divisor);
      b.return([b.select(b.const('bool', true), good, bad)]);
    });
    expect(
      error(() => interpreter(module).execute(run, [0], context), 'evaluation-failed').cause,
    ).toMatchObject({ code: 'division-by-zero' });
  });

  it('locates nested division by zero, retains its typed cause and committed effects', () => {
    const module = createIRModule();
    const state = module.state('state', 'u32', 0);
    const divide = module.func('divide', { params: ['u32'], results: ['u32'] });
    divide.body((b, [d]) => b.return([b.int.div(b.const('u32', 8), d)]));
    const middle = module.func('middle', { params: ['u32'], results: ['u32'] });
    middle.body((b, [d]) => b.return(b.call(divide, [d])));
    const outer = module.func('outer', { params: ['u32'], results: [] });
    outer.body((b, [d]) => {
      b.state.store(state, b.const('u32', 1));
      b.call(middle, [d]);
      b.state.store(state, b.const('u32', 2));
      b.return([]);
    });
    const runtime = interpreter(module);
    const failure = error(() => runtime.execute(outer, [0], context), 'evaluation-failed');
    expect(failure.steps).toBe(6);
    expect(failure.cause).toBeInstanceOf(IRScalarEvaluationError);
    expect(failure.cause).toMatchObject({ code: 'division-by-zero' });
    expect(failure.context).toEqual(context);
    expect(failure.callStack).toEqual([
      { functionIndex: 2, functionName: 'outer', blockIndex: 0, blockId: 0, instructionIndex: 2 },
      { functionIndex: 1, functionName: 'middle', blockIndex: 0, blockId: 0, instructionIndex: 0 },
      { functionIndex: 0, functionName: 'divide', blockIndex: 0, blockId: 0, instructionIndex: 1 },
    ]);
    expect(failure.location).toEqual(failure.callStack[2]);
    expect(runtime.storage.loadState(state)).toBe(1);
    expect(error(() => runtime.execute(outer, [1], context), 'instance-faulted').steps).toBe(0);
  });

  it.each(['bytes.store', 'bytes.copy'] as const)(
    'makes failed %s atomic without rolling back earlier stores',
    (operation) => {
      const module = createIRModule();
      const state = module.state('state', 'u32', 0);
      const ram = module.bytes('ram', new Uint8Array([1, 2, 3, 4]), { readonly: false });
      const run = module.func('run', { params: ['u32'], results: [] });
      run.body((b, [offset]) => {
        b.state.store(state, b.const('u32', 1));
        if (operation === 'bytes.store')
          b.bytes.store('u32', 'little', ram, offset, b.const('u32', 0xaabbccdd));
        else b.bytes.copy(ram, offset, ram, b.const('u32', 0), b.const('u32', 4));
        b.state.store(state, b.const('u32', 2));
        b.return([]);
      });
      const runtime = interpreter(module);
      const failure = error(() => runtime.execute(run, [2], context), 'storage-failed');
      expect(failure.cause).toBeInstanceOf(IRStorageError);
      expect(failure.cause).toMatchObject({ code: 'out-of-bounds' });
      expect(runtime.storage.loadBytes('u32', 'little', ram, 0)).toBe(0x04030201);
      expect(runtime.storage.loadState(state)).toBe(1);
    },
  );

  it('locates an explicit trap terminator and retains effects', () => {
    const module = createIRModule();
    const state = module.state('state', 'u32', 0);
    const run = module.func('run', { params: [], results: [] });
    run.body((b) => {
      b.state.store(state, b.const('u32', 9));
      b.trap('invalidState');
    });
    const runtime = interpreter(module);
    const failure = error(() => runtime.execute(run, [], context), 'trap');
    expect(failure.message).toContain('invalidState');
    expect(failure.location).toEqual({
      functionIndex: 0,
      functionName: 'run',
      blockIndex: 0,
      blockId: 0,
      terminator: true,
    });
    expect(failure.steps).toBe(3);
    expect(runtime.storage.loadState(state)).toBe(9);
  });

  it('retains the float conversion error rather than truncating an invalid result', () => {
    const module = createIRModule();
    const convert = module.func('convert', { params: ['f64'], results: ['u8'] });
    convert.body((b, [value]) => b.return([b.convert.floatToInt('u8', value)]));
    const failure = error(
      () => interpreter(module).execute(convert, [256], context),
      'evaluation-failed',
    );
    expect(failure.cause).toBeInstanceOf(IRFloatEvaluationError);
    expect(failure.cause).toMatchObject({ code: 'integer-overflow' });
  });

  it.each([[], [true], [-1], [1.5], [2 ** 32], [1, 2], [undefined], [1n], new Array(1)])(
    'rejects invalid arguments %# before execution without faulting',
    (args) => {
      const { module, identity } = identityFixture();
      const runtime = interpreter(module);
      expect(
        error(() => runtime.execute(identity, args as RuntimeScalar[], context), 'invalid-argument')
          .steps,
      ).toBe(0);
      expect(runtime.execute(identity, [7], context).values).toEqual([7]);
    },
  );

  it.each([-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid context time %s without faulting',
    (virtualTime) => {
      const { module, identity } = identityFixture();
      const runtime = interpreter(module);
      error(() => runtime.execute(identity, [1], { ...context, virtualTime }), 'invalid-argument');
      expect(runtime.execute(identity, [1], context).values).toEqual([1]);
    },
  );

  it('rejects empty instance identity and foreign target without poisoning valid execution', () => {
    const { module, identity } = identityFixture();
    const foreign = identityFixture().identity;
    const runtime = interpreter(module);
    error(() => runtime.execute(identity, [1], { ...context, instanceId: '' }), 'invalid-argument');
    error(() => runtime.execute(foreign, [1], context), 'invalid-target');
    expect(runtime.execute(identity, [1], context).steps).toBe(1);
  });
});

describe('existing storage and exact floating transport', () => {
  it('uses state/array/byte/inbox storage, endian access and overlapping snapshot copy', () => {
    const module = createIRModule();
    const state = module.state('state', 'u16', 0);
    const array = module.array('array', 'u16', [7, 9]);
    const ram = module.bytes('ram', new Uint8Array([1, 2, 3, 4, 5, 6]), { readonly: false });
    const rom = module.bytes('rom', new Uint8Array([0x12, 0x34]), { readonly: true });
    const inbox = module.inbox('inbox', 1);
    const run = module.func('run', { params: [], results: ['u16', 'u16', 'u8'] });
    run.body((b) => {
      const zero = b.const('u32', 0);
      const one = b.const('u32', 1);
      b.array.store(array, one, b.bytes.load('u16', 'big', rom, zero));
      b.state.store(state, b.array.load(array, one));
      b.bytes.store('u16', 'little', ram, zero, b.state.load(state));
      b.bytes.copy(ram, one, ram, zero, b.const('u32', 4));
      b.return([
        b.state.load(state),
        b.bytes.load('u16', 'big', ram, zero),
        b.bytes.load('u8', 'little', inbox, zero),
      ]);
    });
    const runtime = interpreter(module);
    expect(runtime.execute(run, [], context).values).toEqual([0x1234, 0x3434, 0]);
    expect(
      Array.from({ length: 6 }, (_, i) => runtime.storage.loadBytes('u8', 'little', ram, i)),
    ).toEqual([0x34, 0x34, 0x12, 3, 4, 6]);
    expect(runtime.storage.loadArray(array, 1)).toBe(0x1234);
  });

  it.each([0, 1, 0xffffffff])('checks dynamic array bounds through storage (%i)', (index) => {
    const module = createIRModule();
    const array = module.array('array', 'u32', [9]);
    const run = module.func('run', { params: ['u32'], results: ['u32'] });
    run.body((b, [i]) => b.return([b.array.load(array, i)]));
    const runtime = interpreter(module);
    if (index === 0) expect(runtime.execute(run, [index], context).values).toEqual([9]);
    else
      expect(
        error(() => runtime.execute(run, [index], context), 'storage-failed').cause,
      ).toMatchObject({ code: 'out-of-bounds' });
  });

  it.each([
    ['f32', '0x7fa12345'],
    ['f32', '0xffa12345'],
    ['f32', '0x80000000'],
    ['f64', '0x7ff0000000000123'],
    ['f64', '0xfff0000000000123'],
    ['f64', '0x8000000000000000'],
  ] as const)('preserves raw %s bits %s across blocks, calls, select and storage', (type, bits) => {
    const module = createIRModule();
    const state = module.state('state', type, 0);
    const array = module.array('array', type, [0]);
    const ram = module.bytes('ram', new Uint8Array(16), { readonly: false });
    const echo = module.func('echo', { params: [type], results: [type, type] });
    echo.body((b, [value]) =>
      b.return([value, b.select(b.const('bool', false), b.const(type, 0), value)]),
    );
    const transport = module.func('transport', {
      params: [type],
      results: [type, type, type, type, type],
    });
    transport.body((b, [value]) => {
      const join = b.block([type]);
      const offset = b.const('u32', 0);
      b.jump(join, [value]);
      b.at(join, (b, [moved]) => {
        const [first, second] = b.call(echo, [moved]);
        b.state.store(state, first);
        b.array.store(array, offset, second);
        b.bytes.store(type, 'big', ram, offset, moved);
        b.return([
          first,
          second,
          b.state.load(state),
          b.array.load(array, offset),
          b.bytes.load(type, 'big', ram, offset),
        ]);
      });
    });
    const constant = module.func('constant', {
      params: [],
      results: [type, type, type, type, type],
    });
    constant.body((b) => b.return(b.call(transport, [b.bits(type, bits)])));
    const runtime = interpreter(module);
    const expected = { type, bits };
    const input = { ...expected };
    expect(runtime.execute(transport, [input], context).values).toEqual(
      Array.from({ length: 5 }, () => expected),
    );
    expect(input).toEqual(expected);
    expect(runtime.execute(constant, [], context).values).toEqual(
      Array.from({ length: 5 }, () => expected),
    );
    expect(runtime.storage.loadState(state)).toEqual(expected);
  });

  it('preserves f32 bitcasts and uses the approved evaluators for arithmetic/conversion', () => {
    const module = createIRModule();
    const run = module.func('run', { params: [], results: ['u32', 'f32', 'f64', 'bool', 'u32'] });
    run.body((b) => {
      const raw = b.const('u32', 0x7fa12345);
      const float = b.bitcast('f32', raw);
      const nan = b.float.add(float, b.const('f32', 1));
      b.return([
        b.bitcast('u32', float),
        nan,
        b.convert.float('f64', nan),
        b.float.isNaN(nan),
        b.convert.floatToInt('u32', b.convert.intToFloat('f64', b.const('u32', 7))),
      ]);
    });
    expect(interpreter(module).execute(run, [], context).values).toEqual([
      0x7fa12345,
      { type: 'f32', bits: '0x7fc00000' },
      { type: 'f64', bits: '0x7ff8000000000000' },
      true,
      7,
    ]);
  });

  it('captures floating host numbers as FloatBits and rejects mismatched bit patterns', () => {
    const module = createIRModule();
    const echo = module.func('echo', {
      params: ['f32', 'f64', 'bool'],
      results: ['f32', 'f64', 'bool'],
    });
    echo.body((b, values) => b.return(values));
    const runtime = interpreter(module);
    expect(runtime.execute(echo, [-0, NaN, true], context).values).toEqual([
      { type: 'f32', bits: '0x80000000' },
      { type: 'f64', bits: '0x7ff8000000000000' },
      true,
    ]);
    for (const value of [
      { type: 'f64', bits: '0x8000000000000000' },
      { type: 'f32', bits: '0x123' },
      false,
      undefined,
    ]) {
      error(
        () => runtime.execute(echo, [value as FloatBits, 0, true], context),
        'invalid-argument',
      );
    }
    error(() => runtime.execute(echo, [0, 0, 1], context), 'invalid-argument');
    expect(runtime.execute(echo, [1, 2, false], context).values[2]).toBe(false);
  });

  it('keeps instance resources independent even when the same static module is reused', () => {
    const module = createIRModule();
    const count = module.state('count', 'u32', 0);
    const run = module.func('run', { params: [], results: ['u32'] });
    run.body((b) => {
      const next = b.int.add(b.state.load(count), b.const('u32', 1));
      b.state.store(count, next);
      b.return([next]);
    });
    const a = interpreter(module);
    const b = interpreter(module);
    const independent = createIRStorage(module);
    expect(a.execute(run, [], context).values).toEqual([1]);
    expect(a.execute(run, [], context).values).toEqual([2]);
    expect(b.execute(run, [], context).values).toEqual([1]);
    expect(independent.loadState(count)).toBe(0);
    const foreign = createIRModule().state('count', 'u32', 9);
    expect(() => a.storage.loadState(foreign)).toThrow(IRStorageError);
  });
});

describe('static validation, snapshots and unsupported execution', () => {
  it('rejects null instead of treating it as an omitted budget', () => {
    const { module } = identityFixture();
    error(
      () => createIRInterpreter(module, { validation: policy(module), maxSteps: null as never }),
      'invalid-options',
    );
  });

  it('cannot turn a readonly byte resource into a writable destination with a grant', () => {
    const module = createIRModule();
    const ram = module.bytes('ram', new Uint8Array(4), { readonly: false });
    const rom = module.bytes('rom', new Uint8Array(4), { readonly: true });
    module.func('run', { params: [], results: [] }).body((b) => {
      b.bytes.store('u8', 'little', ram, b.const('u32', 0), b.const('u8', 7));
      b.return([]);
    });
    Object.assign(module.functions[0]!.body!.entry.instructions[2]!.operands[2]!, { ref: rom });
    const failure = error(
      () =>
        createIRInterpreter(module, {
          validation: policy(module, {
            resources: [
              { ref: ram, access: 'read-write' },
              { ref: rom, access: 'read-write' },
            ],
          }),
        }),
      'validation-failed',
    );
    expect(failure.diagnostics.some((diagnostic) => diagnostic.code === 'invalid-resource')).toBe(
      true,
    );
  });

  it('rejects unimplemented instructions in an uncalled function before any execution', () => {
    const { module } = identityFixture();
    const extension = module.domainInstruction('device.effect', { operands: [], results: [] });
    module.func('uncalled', { params: [], results: [] }).body((b) => {
      b.invoke(extension, []);
      b.return([]);
    });
    const validation = policy(module, {
      supportedInstructions: [...CORE_INSTRUCTION_NAMES, 'device.effect'],
      authorizedInstructions: [...CORE_INSTRUCTION_NAMES, 'device.effect'],
      validators: [{ op: 'device.effect', validate: () => [] }],
    });
    expect(validateIR(module, validation).ok).toBe(true);
    expect(
      error(() => createIRInterpreter(module, { validation }), 'unsupported-instruction').location,
    ).toMatchObject({ functionName: 'uncalled', instructionIndex: 0 });
  });

  it('requires explicit operation authorization and resource access', () => {
    const module = createIRModule();
    const state = module.state('state', 'u32', 0);
    const run = module.func('run', { params: [], results: [] });
    run.body((b) => {
      b.state.store(state, b.const('u32', 1));
      b.return([]);
    });
    for (const changes of [
      { resources: [] },
      { resources: [{ ref: state, access: 'read' as const }] },
      { authorizedInstructions: ['const', 'return'] },
    ]) {
      const failure = error(
        () => createIRInterpreter(module, { validation: policy(module, changes) }),
        'validation-failed',
      );
      expect(
        failure.diagnostics.some((diagnostic) => diagnostic.code.startsWith('unauthorized-')),
      ).toBe(true);
    }
  });

  it('rejects foreign resource references, foreign callees and synchronous entry calls', () => {
    for (const mode of ['resource', 'callee', 'entry'] as const) {
      const module = createIRModule();
      const state = module.state('state', 'u32', 0);
      const callee = module.func('callee', { params: [], results: [] });
      callee.body((b) => b.return([]));
      const entry = module.entry('entry', []);
      entry.body((b) => b.return([]));
      const run = module.func('run', { params: [], results: [] });
      run.body((b) => {
        b.state.store(state, b.const('u32', 1));
        b.call(callee, []);
        b.return([]);
      });
      const nodes = module.functions[2]!.body!.entry.instructions;
      if (mode === 'resource')
        Object.assign(nodes[1]!.operands[0]!, { ref: createIRModule().state('state', 'u32', 0) });
      else
        Object.assign(nodes[2]!.operands[0]!, {
          ref: mode === 'entry' ? entry : identityFixture().identity,
        });
      error(() => createIRInterpreter(module, { validation: policy(module) }), 'validation-failed');
    }
  });

  it('rejects recursion and missing/malformed IR before execution', () => {
    const { module, identity } = identityFixture();
    const caller = module.func('caller', { params: ['u32'], results: ['u32'] });
    caller.body((b, [value]) => b.return(b.call(identity, [value])));
    Object.assign(module.functions[1]!.body!.entry.instructions[0]!.operands[0]!, { ref: caller });
    const failure = error(
      () => createIRInterpreter(module, { validation: policy(module) }),
      'validation-failed',
    );
    expect(failure.diagnostics.some((diagnostic) => diagnostic.code === 'recursive-call')).toBe(
      true,
    );
    error(
      () => createIRInterpreter(null as unknown as IRModule, { validation: policy(module) }),
      'validation-failed',
    );
    error(() => createIRInterpreter(module, undefined as never), 'invalid-options');
    const missing = createIRModule();
    missing.func('missing', { params: [], results: [] });
    error(() => createIRInterpreter(missing, { validation: policy(missing) }), 'validation-failed');
  });

  it.each(['device.effect'])('rejects %s even when an extension validator accepts it', (op) => {
    const module = createIRModule();
    const state = module.state('state', 'u32', 0);
    const extension = module.domainInstruction(op, { operands: [], results: [] });
    const run = module.func('run', { params: [], results: [] });
    run.body((b) => {
      b.state.store(state, b.const('u32', 1));
      b.invoke(extension, []);
      b.return([]);
    });
    const validation = policy(module, {
      supportedInstructions: [...CORE_INSTRUCTION_NAMES, op],
      authorizedInstructions: [...CORE_INSTRUCTION_NAMES, op],
      validators: [{ op, validate: () => [] }],
    });
    expect(validateIR(module, validation)).toEqual({ ok: true, diagnostics: [] });
    const failure = error(
      () => createIRInterpreter(module, { validation }),
      'unsupported-instruction',
    );
    expect(failure.message).toContain(op);
    expect(failure.location).toMatchObject({ functionName: 'run', instructionIndex: 2 });
  });

  it.each(['resource.update', 'resource.fill', 'provider.invoke', 'checkpoint.save'])(
    'keeps reserved capability %s statically rejected',
    (op) => {
      const module = createIRModule();
      const extension = module.domainInstruction(op, { operands: [], results: [] });
      module.func('run', { params: [], results: [] }).body((b) => {
        b.invoke(extension, []);
        b.return([]);
      });
      const failure = error(
        () =>
          createIRInterpreter(module, {
            validation: policy(module, {
              supportedInstructions: [...CORE_INSTRUCTION_NAMES, op],
              authorizedInstructions: [...CORE_INSTRUCTION_NAMES, op],
              validators: [{ op, validate: () => [] }],
            }),
          }),
        'validation-failed',
      );
      expect(
        failure.diagnostics.some((diagnostic) => diagnostic.code === 'unsupported-instruction'),
      ).toBe(true);
    },
  );

  it('rejects dispatch instead of treating it as a successful return', () => {
    const module = createIRModule();
    const run = module.func('run', { params: [], results: [] });
    run.body((b) => b.return([]));
    Object.assign(module.functions[0]!.body!.entry.terminator!, { kind: 'dispatch' });
    const failure = error(
      () => createIRInterpreter(module, { validation: policy(module) }),
      'validation-failed',
    );
    expect(failure.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'unsupported-instruction',
        location: expect.objectContaining({ terminator: true }),
      }),
    );
  });

  it('freezes a private execution graph rather than executing mutable validated source nodes', () => {
    const module = createIRModule();
    const state = module.state('state', 'u32', 0);
    const run = module.func('run', { params: [], results: ['u32'] });
    run.body((b) => {
      const value = b.const('u32', 7);
      b.state.store(state, value);
      b.return([value]);
    });
    const runtime = interpreter(module);
    const body = module.functions[0]!.body!.entry;
    Object.assign(body.instructions[0]!.operands[0]!, { value: 99 });
    Object.assign(body.instructions[0]!.results[0]!, { type: 'bool' });
    Object.assign(body.instructions[1]!, { op: 'device.effect' });
    Object.assign(body.terminator!, { kind: 'trap', code: 'changed' });
    const later = module.func('later', { params: [], results: [] });
    later.body((b) => b.return([]));
    expect(runtime.execute(run, [], context)).toEqual({ values: [7], steps: 3 });
    expect(runtime.storage.loadState(state)).toBe(7);
    error(() => runtime.execute(later, [], context), 'invalid-target');
  });

  it('rejects unsupported execution even if its static validator mutates the source module', () => {
    const module = createIRModule();
    const state = module.state('state', 'u32', 1);
    const declared = module.domainInstruction('device.unused', { operands: [], results: [] });
    const run = module.func('run', { params: [], results: [] });
    run.body((b) => {
      b.invoke(declared, []);
      b.return([]);
    });
    const validation = policy(module, {
      supportedInstructions: [...CORE_INSTRUCTION_NAMES, 'device.unused'],
      authorizedInstructions: [...CORE_INSTRUCTION_NAMES, 'device.unused'],
      validators: [
        {
          op: 'device.unused',
          validate: () => {
            Object.assign(module.memories[0]!.initial, { 0: 9 });
            return [];
          },
        },
      ],
    });
    // The unsupported capability is rejected before any instance can be returned.
    error(() => createIRInterpreter(module, { validation }), 'unsupported-instruction');
    expect(createIRStorage(module).loadState(state)).toBe(9);
  });
});
