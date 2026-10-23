import { describe, expect, it, vi } from 'vitest';
import {
  createIRModule,
  validateIR,
  type BlockDefinition,
  type FunctionDefinition,
  type IRDiagnosticCode,
  type IRDiagnosticLocation,
  type IRInstructionValidator,
  type IRModule,
  type IRValidationOptions,
  type ScalarType,
  type Value,
} from './index';
import { byteReadonly, refKind, scalarType, signature, valueKind } from './types';

// Copies the public arrays, not builder metadata, so invalid models can be supplied directly.
type Mutable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;
type Model = Pick<IRModule, 'memories' | 'functions' | 'domainDeclarations' | 'instructions'>;

function mutable<T>(value: T): Mutable<T> {
  return value as Mutable<T>;
}

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing test fixture element');
  return value;
}

function model(module: IRModule): Mutable<Model> {
  return mutable({
    memories: [...module.memories],
    functions: [...module.functions],
    domainDeclarations: [...module.domainDeclarations],
    instructions: [...module.instructions],
  });
}

function block(input: Model, functionIndex = 0, blockIndex = 0): Mutable<BlockDefinition> {
  return mutable(present(present(input.functions[functionIndex]?.body).blocks[blockIndex]));
}

function fn(input: Model, index = 0): Mutable<FunctionDefinition> {
  return mutable(present(input.functions[index]));
}

function value<T extends ScalarType>(type: T): Value<T> {
  return { [valueKind]: 'ssa-value', type };
}

const core = [
  'const',
  'const.bits',
  'bool.not',
  'bool.and',
  'bool.or',
  'bool.xor',
  'int.add',
  'int.sub',
  'int.mul',
  'int.div',
  'int.rem',
  'int.and',
  'int.or',
  'int.xor',
  'int.not',
  'int.shl',
  'int.lshr',
  'int.ashr',
  'int.cmp',
  'int.zext',
  'int.sext',
  'int.trunc',
  'int.reinterpret',
  'float.add',
  'float.sub',
  'float.mul',
  'float.div',
  'float.fma',
  'float.cmp',
  'float.isNaN',
  'float.isFinite',
  'convert.intToFloat',
  'convert.floatToInt',
  'convert.float',
  'bitcast',
  'select',
  'state.load',
  'state.store',
  'array.load',
  'array.store',
  'bytes.load',
  'bytes.store',
  'bytes.copy',
  'call',
  'return',
  'jump',
  'branch',
  'trap',
] as const;

function options(overrides: Partial<IRValidationOptions> = {}): IRValidationOptions {
  return { supportedInstructions: core, authorizedInstructions: core, resources: [], ...overrides };
}

function location(
  input: Model,
  blockIndex = 0,
  suffix = '',
  functionIndex = 0,
): IRDiagnosticLocation {
  const definition = present(input.functions[functionIndex]);
  const current = block(input, functionIndex, blockIndex);
  return {
    path: `functions[${functionIndex}].body.blocks[${blockIndex}]${suffix}`,
    functionIndex,
    functionName: definition.name,
    blockIndex,
    blockId: current.id,
  };
}

function instructionLocation(input: Model, index: number, blockIndex = 0, functionIndex = 0) {
  return {
    ...location(input, blockIndex, `.instructions[${index}]`, functionIndex),
    instructionIndex: index,
  };
}

function terminalLocation(input: Model, blockIndex = 0, functionIndex = 0) {
  return {
    ...location(input, blockIndex, '.terminator', functionIndex),
    terminator: true as const,
  };
}

function rejects(
  input: unknown,
  code: IRDiagnosticCode,
  at: IRDiagnosticLocation,
  configuration = options(),
): void {
  const result = validateIR(input, configuration);
  expect(result.ok).toBe(false);
  expect(result.diagnostics).toContainEqual({ code, message: expect.any(String), location: at });
  expect(result.diagnostics.every((diagnostic) => diagnostic.message.length > 0)).toBe(true);
}

function single() {
  const module = createIRModule();
  module.func('main', { params: ['u32'], results: ['u32'] }).body((b, [parameter]) => {
    b.return([b.int.add(parameter, b.const('u32', 1))]);
  });
  return model(module);
}

function diamond() {
  const module = createIRModule();
  module.func('choose', { params: ['bool', 'u32'], results: ['u32'] }).body((b, [test, n]) => {
    const yes = b.block([]);
    const no = b.block([]);
    const join = b.block(['u32']);
    b.branch(test, { target: yes, args: [] }, { target: no, args: [] });
    b.at(yes, (inner) => inner.jump(join, [inner.int.add(n, inner.const('u32', 1))]));
    b.at(no, (inner) => inner.jump(join, [inner.int.sub(n, inner.const('u32', 1))]));
    b.at(join, (inner, [result]) => inner.return([result]));
  });
  return model(module);
}

function domain() {
  const module = createIRModule();
  const led = module.domainDeclaration('led', 'status');
  const emit = module.domainInstruction('led.set', {
    operands: [
      { kind: 'static', category: 'led' },
      { kind: 'value', type: 'bool' },
    ],
    results: [],
  });
  module.entry('main', ['bool']).body((b, [enabled]) => {
    b.invoke(emit, [led, enabled]);
    b.return([]);
  });
  const input = model(module);
  const configuration = options({
    supportedInstructions: [...core, 'led.set'],
    authorizedInstructions: [...core, 'led.set'],
    resources: [{ ref: led, access: 'write' }],
    validators: [{ op: 'led.set', validate: () => [] }],
  });
  return { input, configuration, led };
}

describe('validateIR public model boundary', () => {
  it('accepts empty and legal single-block public models without construction metadata', () => {
    expect(validateIR(model(createIRModule()), options())).toEqual({ ok: true, diagnostics: [] });
    const input = single();
    const entry = block(input);
    fn(input).ref = { ...fn(input).ref };
    const parameter = { type: 'u32' } as Value<'u32'>;
    const constant = { type: 'u32' } as Value<'u32'>;
    const result = { type: 'u32' } as Value<'u32'>;
    entry.params = [parameter];
    entry.instructions = [
      { op: 'const', operands: [{ kind: 'literal', value: 1 }], results: [constant] },
      {
        op: 'int.add',
        operands: [
          { kind: 'ssa', value: parameter },
          { kind: 'ssa', value: constant },
        ],
        results: [result],
      },
    ];
    entry.terminator = { kind: 'return', values: [result] };
    expect(validateIR(input, options())).toEqual({ ok: true, diagnostics: [] });
  });

  it('validates the current arrays and instructions, not a previous successful snapshot', () => {
    const input = single();
    expect(validateIR(input, options()).ok).toBe(true);
    present(block(input).instructions[1]).operands[0] = { kind: 'ssa', value: value('u32') };
    rejects(input, 'ssa-undefined', instructionLocation(input, 1));
    input.functions = [];
    expect(validateIR(input, options())).toEqual({ ok: true, diagnostics: [] });
  });

  it('also observes mutations on an actual builder module', () => {
    const module = createIRModule();
    module.entry('main', []).body((b) => b.return([]));
    expect(validateIR(module, options()).ok).toBe(true);
    block(module).terminator = undefined;
    rejects(module, 'invalid-terminator', terminalLocation(module));
  });

  it.each([
    null,
    undefined,
    false,
    1,
    'ir',
    [],
    {},
    { memories: [], functions: [], instructions: [] },
  ])('reports malformed top-level input %j', (input) => {
    const result = validateIR(input, options());
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'malformed-input', message: expect.any(String) }),
      ]),
    );
  });

  it.each(['memories', 'functions', 'domainDeclarations', 'instructions'] as const)(
    'requires an actual %s array',
    (key) => {
      const input = { ...model(createIRModule()), [key]: {} };
      rejects(input, 'malformed-input', { path: key });
    },
  );

  it('contains throwing public getters as a root malformed-input diagnostic', () => {
    const input = {
      get memories(): never {
        throw new Error('unavailable');
      },
    };
    rejects(input, 'malformed-input', { path: '$' });
  });

  it.each(['memories', 'functions', 'domainDeclarations', 'instructions'] as const)(
    'rejects sparse top-level %s lists',
    (key) => {
      rejects({ ...model(createIRModule()), [key]: new Array(1) }, 'malformed-input', {
        path: key,
      });
    },
  );

  it('rejects sparse instruction and operand lists rather than skipping missing nodes', () => {
    const input = single();
    block(input).instructions = new Array(1);
    rejects(input, 'malformed-input', location(input));
    const operands = single();
    present(block(operands).instructions[1]).operands = new Array(2);
    rejects(operands, 'malformed-input', instructionLocation(operands, 1));
  });

  it.each(['supportedInstructions', 'authorizedInstructions', 'resources', 'validators'] as const)(
    'rejects sparse policy %s lists',
    (key) => {
      rejects(
        single(),
        'malformed-input',
        { path: `options.${key}` },
        { ...options(), [key]: new Array(1) },
      );
    },
  );

  it('rejects an explicitly incorrect SSA value brand', () => {
    const input = single();
    mutable(present(block(input).params[0]))[valueKind] = 'not-an-ssa-value' as never;
    rejects(input, 'type-mismatch', location(input));
  });

  it('rejects malformed instruction nodes without throwing', () => {
    const input = single();
    block(input).instructions[0] = null as never;
    rejects(input, 'malformed-input', instructionLocation(input, 0));
  });

  it.each(['operands', 'results'] as const)('rejects malformed instruction %s arrays', (key) => {
    const input = single();
    present(block(input).instructions[0])[key] = {} as never;
    rejects(input, 'malformed-input', instructionLocation(input, 0));
  });

  it('requires function parameter arrays and validates declaration scalar types', () => {
    const input = single();
    fn(input).params = null as never;
    rejects(input, 'malformed-input', {
      path: 'functions[0]',
      functionIndex: 0,
      functionName: 'main',
    });
    const invalid = single();
    fn(invalid).results = ['u64' as never];
    rejects(invalid, 'type-mismatch', {
      path: 'functions[0]',
      functionIndex: 0,
      functionName: 'main',
    });
  });

  it('does not accept malformed or missing function reference signatures', () => {
    const input = single();
    mutable(fn(input).ref)[signature] = { params: null, results: [] } as never;
    rejects(input, 'signature-mismatch', {
      path: 'functions[0]',
      functionIndex: 0,
      functionName: 'main',
    });
    const absent = single();
    fn(absent).ref = { [refKind]: 'function' } as never;
    rejects(absent, 'signature-mismatch', {
      path: 'functions[0]',
      functionIndex: 0,
      functionName: 'main',
    });
  });

  it('rejects invalid declared scalar types rather than treating them as unknown SSA', () => {
    const input = single();
    mutable(present(block(input).params[0])).type = 'u64' as never;
    rejects(input, 'type-mismatch', location(input));
  });

  it('requires a body, a member entry, and defined blocks', () => {
    const missing = single();
    fn(missing).body = undefined;
    rejects(missing, 'invalid-block', {
      path: 'functions[0]',
      functionIndex: 0,
      functionName: 'main',
    });
    const detached = single();
    present(fn(detached).body).entry = { ...block(detached) };
    rejects(detached, 'invalid-block', {
      path: 'functions[0]',
      functionIndex: 0,
      functionName: 'main',
    });
    const undefinedBlock = single();
    block(undefinedBlock).defined = false;
    rejects(undefinedBlock, 'invalid-block', location(undefinedBlock));
  });

  it('rejects duplicate names across declaration families and duplicate reference identities', () => {
    const module = createIRModule();
    module.state('state', 'u32', 0);
    module.entry('main', []).body((b) => b.return([]));
    const names = model(module);
    fn(names).name = 'state';
    rejects(names, 'duplicate-definition', {
      path: 'functions[0]',
      functionIndex: 0,
      functionName: 'state',
    });
    const refs = model(module);
    refs.memories.push({ ...present(refs.memories[0]), name: 'other' });
    rejects(refs, 'duplicate-definition', { path: 'memories[1]' });
  });

  it.each(['params', 'results'] as const)(
    'rejects sparse function reference %s signatures matching dense declaration lengths',
    (part) => {
      const input = single();
      const definition = fn(input);
      const reference = definition.ref;
      if (reference[refKind] !== 'function')
        throw new Error('Expected an ordinary function fixture');
      definition.ref = {
        ...reference,
        [signature]: { ...reference[signature], [part]: new Array<ScalarType>(1) },
      };
      rejects(input, 'signature-mismatch', {
        path: 'functions[0]',
        functionIndex: 0,
        functionName: 'main',
      });
    },
  );

  it('checks current function reference signatures and categories', () => {
    const layout = single();
    mutable(fn(layout).ref)[signature].results = [];
    rejects(layout, 'signature-mismatch', {
      path: 'functions[0]',
      functionIndex: 0,
      functionName: 'main',
    });
    const category = single();
    mutable(fn(category).ref)[refKind] = 'entry' as never;
    rejects(category, 'invalid-static-reference', {
      path: 'functions[0]',
      functionIndex: 0,
      functionName: 'main',
    });
  });
});

describe('validateIR SSA and control flow', () => {
  it('accepts a diamond with predecessor arguments and entry parameters in both arms', () => {
    expect(validateIR(diamond(), options())).toEqual({ ok: true, diagnostics: [] });
  });

  it('accepts loops with loop-carried block parameters', () => {
    const module = createIRModule();
    module.func('loop', { params: ['u32'], results: ['u32'] }).body((b, [n]) => {
      const head = b.block(['u32']);
      const step = b.block(['u32']);
      const done = b.block(['u32']);
      b.jump(head, [n]);
      b.at(head, (inner, [remaining]) => {
        const zero = inner.int.cmp('eq', remaining, inner.const('u32', 0));
        inner.branch(
          zero,
          { target: done, args: [remaining] },
          { target: step, args: [remaining] },
        );
      });
      b.at(step, (inner, [remaining]) =>
        inner.jump(head, [inner.int.sub(remaining, inner.const('u32', 1))]),
      );
      b.at(done, (inner, [result]) => inner.return([result]));
    });
    expect(validateIR(module, options())).toEqual({ ok: true, diagnostics: [] });
  });

  it('permits local definitions and entry parameters in unreachable blocks', () => {
    const module = createIRModule();
    module.func('unreachable', { params: ['u32'], results: ['u32'] }).body((b, [n]) => {
      const dead = b.block([]);
      b.return([n]);
      b.at(dead, (inner) => inner.return([inner.int.add(n, inner.const('u32', 1))]));
    });
    expect(validateIR(module, options())).toEqual({ ok: true, diagnostics: [] });
  });

  it('does not invent dominance between disconnected unreachable blocks', () => {
    const input = diamond();
    block(input).terminator = { kind: 'return', values: [present(block(input).params[1])] };
    present(block(input, 0, 2).instructions[1]).operands[0] = {
      kind: 'ssa',
      value: present(present(block(input, 0, 1).instructions[0]).results[0]),
    };
    rejects(input, 'ssa-dominance', instructionLocation(input, 1, 2));
  });

  it('reports use-before-definition within one block', () => {
    const input = single();
    block(input).instructions.reverse();
    rejects(input, 'ssa-dominance', instructionLocation(input, 0));
  });

  it('rejects undeclared values even when their public type matches', () => {
    const input = single();
    present(block(input).instructions[1]).operands[0] = { kind: 'ssa', value: value('u32') };
    rejects(input, 'ssa-undefined', instructionLocation(input, 1));
  });

  it('does not allow another function parameter as a local definition', () => {
    const input = single();
    const other = single();
    fn(other).name = 'other';
    input.functions.push(fn(other));
    present(block(input).instructions[1]).operands[0] = {
      kind: 'ssa',
      value: present(block(input, 1).params[0]),
    };
    rejects(input, 'ssa-undefined', instructionLocation(input, 1));
  });

  it('rejects branch-local values used by a sibling or join block', () => {
    const input = diamond();
    const local = present(present(block(input, 0, 1).instructions[1]).results[0]);
    block(input, 0, 3).terminator = { kind: 'return', values: [local] };
    rejects(input, 'ssa-dominance', terminalLocation(input, 3));
    present(block(input, 0, 2).instructions[1]).operands[0] = { kind: 'ssa', value: local };
    rejects(input, 'ssa-dominance', instructionLocation(input, 1, 2));
  });

  it('rejects duplicate value object definitions and duplicate block ids', () => {
    const input = single();
    present(block(input).instructions[0]).results = [present(block(input).params[0])];
    rejects(input, 'duplicate-definition', instructionLocation(input, 0));
    const blocks = diamond();
    block(blocks, 0, 1).id = block(blocks).id;
    rejects(blocks, 'duplicate-definition', location(blocks, 1));
  });

  it.each(['absent', 'foreign'] as const)('rejects %s jump targets', (kind) => {
    const input = diamond();
    const terminal = present(block(input, 0, 1).terminator);
    if (terminal.kind !== 'jump') throw new Error('Expected fixture jump');
    if (kind === 'foreign') {
      const other = single();
      fn(other).name = 'other';
      input.functions.push(fn(other));
      terminal.target = block(input, 1);
    } else {
      terminal.target = { ...terminal.target };
    }
    rejects(input, 'invalid-block', terminalLocation(input, 1));
  });

  it('checks edge arity and argument types against the target parameters', () => {
    const input = diamond();
    const terminal = present(block(input, 0, 1).terminator);
    if (terminal.kind !== 'jump') throw new Error('Expected fixture jump');
    terminal.args = [];
    rejects(input, 'signature-mismatch', terminalLocation(input, 1));
    terminal.args = [present(block(input).params[0])];
    rejects(input, 'signature-mismatch', terminalLocation(input, 1));
  });

  it('checks both branch edges and the boolean condition', () => {
    const input = diamond();
    const terminal = present(block(input).terminator);
    if (terminal.kind !== 'branch') throw new Error('Expected fixture branch');
    terminal.no.args = [present(block(input).params[1])];
    rejects(input, 'signature-mismatch', terminalLocation(input));
    terminal.no.args = [];
    terminal.condition = present(block(input).params[1]) as Value<'bool'>;
    rejects(input, 'type-mismatch', terminalLocation(input));
  });

  it('checks return layouts and reports undefined return values at the terminator', () => {
    const input = single();
    block(input).terminator = { kind: 'return', values: [] };
    rejects(input, 'signature-mismatch', terminalLocation(input));
    block(input).terminator = { kind: 'return', values: [value('u32')] };
    rejects(input, 'ssa-undefined', terminalLocation(input));
  });

  it.each([undefined, { kind: 'future' }, { kind: 'return', values: 'wrong' }])(
    'rejects invalid terminator encodings %j',
    (terminal) => {
      const input = single();
      block(input).terminator = terminal as never;
      rejects(
        input,
        terminal?.kind === 'return' ? 'malformed-input' : 'invalid-terminator',
        terminalLocation(input),
      );
    },
  );

  it.each(['return', 'jump', 'branch', 'trap'])(
    'rejects terminal %s masquerading as a regular instruction',
    (op) => {
      const input = single();
      present(block(input).instructions[0]).op = op;
      rejects(input, 'invalid-terminator', instructionLocation(input, 0));
    },
  );
});

describe('validateIR core instruction schemas', () => {
  function operation(
    op: string,
    parameters: readonly ScalarType[],
    results: readonly ScalarType[],
    literals: readonly (boolean | number | string)[] = [],
  ) {
    const input = single();
    fn(input).params = [...parameters];
    fn(input).results = [];
    mutable(fn(input).ref)[signature].params = [...parameters];
    mutable(fn(input).ref)[signature].results = [];
    const entry = block(input);
    entry.params = parameters.map(value);
    entry.instructions = [
      {
        op,
        operands: [
          ...literals.map((literal) => ({ kind: 'literal' as const, value: literal })),
          ...entry.params.map((parameter) => ({ kind: 'ssa' as const, value: parameter })),
        ],
        results: results.map(value),
      },
    ];
    entry.terminator = { kind: 'return', values: [] };
    return input;
  }

  it('accepts every scalar operation family in the actual builder encoding', () => {
    const module = createIRModule();
    module.entry('allScalars', []).body((b) => {
      const flag = b.const('bool', true);
      const n = b.const('u32', 4);
      const small = b.const('u8', 2);
      const signed = b.const('i8', -1);
      const integer = b.const('i32', -4);
      const f = b.const('f32', 1.25);
      const d = b.const('f64', 2.5);
      for (const op of [b.bool.and, b.bool.or, b.bool.xor]) op(flag, flag);
      b.bool.not(flag);
      for (const op of [
        b.int.add,
        b.int.sub,
        b.int.mul,
        b.int.div,
        b.int.rem,
        b.int.and,
        b.int.or,
        b.int.xor,
      ])
        op(n, n);
      b.int.not(n);
      b.int.shl(small, n);
      b.int.lshr(n, n);
      b.int.ashr(integer, n);
      for (const predicate of ['eq', 'ne', 'lt', 'le', 'gt', 'ge'] as const) {
        b.int.cmp(predicate, n, n);
        b.float.cmp(predicate, d, d);
      }
      b.int.zext('u16', small);
      b.int.sext('i32', signed);
      b.int.trunc('u8', n);
      b.int.reinterpret('u32', integer);
      for (const op of [b.float.add, b.float.sub, b.float.mul, b.float.div]) {
        op(f, f);
        op(d, d);
      }
      b.float.fma(f, f, f);
      b.float.isNaN(d);
      b.float.isFinite(f);
      b.convert.intToFloat('f64', integer);
      b.convert.floatToInt('u16', d);
      b.convert.float('f64', f);
      b.convert.float('f32', d);
      b.bitcast('f32', n);
      b.bitcast('u32', f);
      b.bits('f32', '0x7FC00001');
      b.bits('f64', '0x7FF8000000000001');
      b.select(flag, f, f);
      b.return([]);
    });
    expect(validateIR(module, options())).toEqual({ ok: true, diagnostics: [] });
  });

  const invalidTypes: readonly [
    op: string,
    parameters: readonly ScalarType[],
    results: readonly ScalarType[],
    literals?: readonly (boolean | number | string)[],
  ][] = [
    ['const', [], ['u8'], [256]],
    ['const', [], ['bool'], [1]],
    ['const.bits', [], ['u32'], ['0x00000000']],
    ['const.bits', [], ['f32'], ['0x0000000000000000']],
    ['bool.not', ['u32'], ['bool']],
    ['bool.and', ['bool', 'u32'], ['bool']],
    ['int.add', ['u8', 'u16'], ['u8']],
    ['int.mul', ['f32', 'f32'], ['f32']],
    ['int.add', ['u32', 'u32'], ['bool']],
    ['int.shl', ['u8', 'u8'], ['u8']],
    ['int.ashr', ['u32', 'u32'], ['u32']],
    ['int.cmp', ['u32', 'u32'], ['bool'], ['invalid']],
    ['int.cmp', ['u32', 'u32'], ['u32'], ['eq']],
    ['int.zext', ['u16'], ['u8'], ['u8']],
    ['int.sext', ['u8'], ['i32'], ['i32']],
    ['int.trunc', ['u8'], ['u16'], ['u16']],
    ['int.reinterpret', ['u16'], ['i32'], ['i32']],
    ['int.reinterpret', ['u32'], ['u32'], ['u32']],
    ['float.add', ['f32', 'f64'], ['f32']],
    ['float.fma', ['f32', 'f32', 'f64'], ['f32']],
    ['float.isNaN', ['u32'], ['bool']],
    ['float.cmp', ['f32', 'f64'], ['bool'], ['eq']],
    ['convert.intToFloat', ['f32'], ['f64'], ['f64']],
    ['convert.floatToInt', ['u32'], ['u8'], ['u8']],
    ['convert.float', ['f32'], ['u32'], ['u32']],
    ['bitcast', ['f64'], ['u32'], ['u32']],
    ['bitcast', ['u32'], ['i32'], ['i32']],
    ['select', ['u32', 'u8', 'u8'], ['u8']],
    ['select', ['bool', 'u8', 'u16'], ['u8']],
  ];
  it.each(invalidTypes)(
    'rejects invalid %s operand/result types (%j -> %j)',
    (op, parameters, results, literals) => {
      const input = operation(op, parameters, results, literals);
      rejects(input, 'type-mismatch', instructionLocation(input, 0));
    },
  );

  it.each([
    ['int.add', ['u32'], ['u32']],
    ['int.add', ['u32', 'u32'], []],
    ['float.fma', ['f32', 'f32'], ['f32']],
    ['select', ['bool', 'u8'], ['u8']],
  ] as const)('rejects %s arity mismatches (%j -> %j)', (op, parameters, results) => {
    const input = operation(op, parameters, results);
    rejects(input, 'signature-mismatch', instructionLocation(input, 0));
  });

  it('does not let a trusted validator replace or waive core instruction checking', () => {
    const input = operation('int.add', ['u8', 'u16'], ['u8']);
    rejects(
      input,
      'unsupported-instruction',
      { path: 'options.validators[0]' },
      options({
        validators: [{ op: 'int.add', validate: () => [] }],
      }),
    );
  });
});

describe('validateIR calls', () => {
  function calls() {
    const module = createIRModule();
    const callee = module.func('callee', { params: ['u32'], results: ['u32', 'bool'] });
    callee.body((b, [n]) => b.return([n, b.const('bool', true)]));
    module.entry('main', ['u32']).body((b, [n]) => {
      b.call(callee, [n]);
      b.return([]);
    });
    return model(module);
  }

  it('accepts ordinary calls with multiple results', () => {
    expect(validateIR(calls(), options())).toEqual({ ok: true, diagnostics: [] });
  });

  it('checks call argument and result layouts', () => {
    const input = calls();
    const call = present(block(input, 1).instructions[0]);
    call.operands.pop();
    rejects(input, 'signature-mismatch', instructionLocation(input, 0, 0, 1));
    const output = calls();
    present(block(output, 1).instructions[0]).results.pop();
    rejects(output, 'signature-mismatch', instructionLocation(output, 0, 0, 1));
  });

  it.each(['entry', 'lifecycle'] as const)('rejects a call to a declared %s', (category) => {
    const input = calls();
    const module = createIRModule();
    const target =
      category === 'entry' ? module.entry('target', ['u32']) : module.lifecycle('target', ['u32']);
    target.body((b) => b.return([]));
    input.functions.push(fn(model(module)));
    const call = present(block(input, 1).instructions[0]);
    call.operands[0] = { kind: 'static', ref: target };
    call.results = [];
    rejects(input, 'invalid-call-target', instructionLocation(input, 0, 0, 1));
  });

  it('still checks a listed non-callable target argument and result layouts', () => {
    const input = calls();
    const targetModule = createIRModule();
    const target = targetModule.entry('notCallable', ['bool']);
    target.body((b) => b.return([]));
    input.functions.push(fn(model(targetModule)));
    present(block(input, 1).instructions[0]).operands[0] = { kind: 'static', ref: target };
    const at = instructionLocation(input, 0, 0, 1);
    rejects(input, 'invalid-call-target', at);
    rejects(input, 'signature-mismatch', at);
  });

  it('rejects a foreign or removed function reference', () => {
    const input = calls();
    input.functions.shift();
    rejects(input, 'invalid-static-reference', instructionLocation(input, 0));
  });

  it.each([1, 3])('rejects recursive cycles of length %i', (length) => {
    const module = createIRModule();
    const functions = Array.from({ length }, (_, index) =>
      module.func(`f${index}`, { params: [], results: [] }),
    );
    functions.forEach((target, index) =>
      target.body((b) => {
        b.call(present(functions[(index + 1) % length]), []);
        b.return([]);
      }),
    );
    const input = model(module);
    rejects(input, 'recursive-call', instructionLocation(input, 0));
  });
});

describe('validateIR capabilities and resources', () => {
  it('requires explicit backend support and authorization, including terminators', () => {
    const input = single();
    rejects(
      input,
      'unsupported-instruction',
      instructionLocation(input, 0),
      options({ supportedInstructions: [] }),
    );
    rejects(
      input,
      'unauthorized-instruction',
      instructionLocation(input, 0),
      options({ authorizedInstructions: [] }),
    );
    rejects(
      input,
      'unsupported-instruction',
      terminalLocation(input),
      options({ supportedInstructions: ['const', 'int.add'] }),
    );
    rejects(
      input,
      'unauthorized-instruction',
      terminalLocation(input),
      options({ authorizedInstructions: ['const', 'int.add'] }),
    );
  });

  it.each(['future.op', 'int.future'])(
    'does not turn a backend-listed unknown operation %s into a declared instruction',
    (op) => {
      const input = single();
      present(block(input).instructions[0]).op = op;
      rejects(
        input,
        'unknown-instruction',
        instructionLocation(input, 0),
        options({
          supportedInstructions: [...core, op],
          authorizedInstructions: [...core, op],
        }),
      );
    },
  );

  it.each(['provider.generate', 'kernel.call', 'resource.update', 'resource.fill'])(
    'rejects reserved future operation %s even when a backend lists it',
    (op) => {
      const input = single();
      present(block(input).instructions[0]).op = op;
      rejects(
        input,
        'unsupported-instruction',
        instructionLocation(input, 0),
        options({
          supportedInstructions: [...core, op],
          authorizedInstructions: [...core, op],
        }),
      );
    },
  );

  it('rejects checkpoint outside provider artifacts', () => {
    const input = single();
    present(block(input).instructions[0]).op = 'checkpoint';
    rejects(
      input,
      'invalid-checkpoint',
      instructionLocation(input, 0),
      options({
        supportedInstructions: [...core, 'checkpoint'],
        authorizedInstructions: [...core, 'checkpoint'],
      }),
    );
  });

  it('rejects dispatch in the instruction list because it is a terminator', () => {
    const input = single();
    present(block(input).instructions[0]).op = 'dispatch';
    rejects(
      input,
      'invalid-terminator',
      instructionLocation(input, 0),
      options({
        supportedInstructions: [...core, 'dispatch'],
        authorizedInstructions: [...core, 'dispatch'],
      }),
    );
  });

  it.each([
    'PROVIDER.foo',
    'kernel_only.op',
    'checkpoint_resume',
    'dispatch-tail',
    'Resource_updateBytes',
  ])('rejects reserved alias %s across capability and extension surfaces', (op) => {
    const configuration = options({
      supportedInstructions: [...core, op],
      authorizedInstructions: [...core, op],
    });
    const instruction = single();
    present(block(instruction).instructions[0]).op = op;
    rejects(
      instruction,
      'unsupported-instruction',
      instructionLocation(instruction, 0),
      configuration,
    );

    const terminal = single();
    block(terminal).terminator = { kind: op } as never;
    rejects(terminal, 'unsupported-instruction', terminalLocation(terminal), configuration);

    const declaration = single();
    declaration.instructions.push({ name: op, operands: [], results: [] });
    rejects(declaration, 'unsupported-instruction', { path: 'instructions[0]' }, configuration);

    const validate = vi.fn<IRInstructionValidator['validate']>(() => []);
    rejects(
      single(),
      'unsupported-instruction',
      { path: 'options.validators[0]' },
      {
        ...configuration,
        validators: [{ op, validate }],
      },
    );
    expect(validate).not.toHaveBeenCalled();
  });

  function stateAccess() {
    const module = createIRModule();
    const state = module.state('count', 'u32', 0);
    module.entry('main', []).body((b) => {
      const n = b.state.load(state);
      b.state.store(state, n);
      b.return([]);
    });
    return { input: model(module), state };
  }

  it('defaults to no grants and distinguishes reads from writes', () => {
    const { input, state } = stateAccess();
    rejects(input, 'unauthorized-resource', instructionLocation(input, 0));
    rejects(
      input,
      'unauthorized-resource',
      instructionLocation(input, 1),
      options({ resources: [{ ref: state, access: 'read' }] }),
    );
    rejects(
      input,
      'unauthorized-resource',
      instructionLocation(input, 0),
      options({ resources: [{ ref: state, access: 'write' }] }),
    );
    expect(
      validateIR(input, options({ resources: [{ ref: state, access: 'read-write' }] })),
    ).toEqual({ ok: true, diagnostics: [] });
  });

  it('rejects unlisted memory refs even when options grant the same ref', () => {
    const { input, state } = stateAccess();
    input.memories = [];
    rejects(
      input,
      'invalid-static-reference',
      instructionLocation(input, 0),
      options({ resources: [{ ref: state, access: 'read-write' }] }),
    );
  });

  it('checks memory reference scalar layout against the declaration', () => {
    const { input } = stateAccess();
    const memory = present(input.memories[0]);
    if (memory.layout.kind !== 'scalar') throw new Error('Expected fixture scalar layout');
    memory.layout.scalarType = 'bool';
    memory.initial = [false];
    rejects(input, 'invalid-resource', { path: 'memories[0]' });
  });

  it.each([256, -1, 1.5, true])('rejects illegal u8 initial values %j', (initial) => {
    const module = createIRModule();
    module.state('byte', 'u8', 0);
    const input = model(module);
    present(input.memories[0]).initial = [initial];
    rejects(input, 'invalid-resource', { path: 'memories[0]' });
  });

  it('checks byte dimensions, initializer length, and byte range', () => {
    const module = createIRModule();
    module.bytes('ram', new Uint8Array(4), { readonly: false, unitBytes: 2 });
    const input = model(module);
    const memory = present(input.memories[0]);
    memory.initial = [0];
    rejects(input, 'invalid-resource', { path: 'memories[0]' });
    memory.initial = [0, 0, 0, 999];
    rejects(input, 'invalid-resource', { path: 'memories[0]' });
    if (memory.layout.kind !== 'bytes') throw new Error('Expected fixture bytes layout');
    memory.layout.unitBytes = 0;
    rejects(input, 'invalid-resource', { path: 'memories[0]' });
  });

  it('checks readonly byte stores even when write access is granted', () => {
    const module = createIRModule();
    const ram = module.bytes('ram', new Uint8Array(8), { readonly: false });
    const rom = module.bytes('rom', new Uint8Array(8), { readonly: true });
    module.entry('main', []).body((b) => {
      const offset = b.const('u32', 0);
      b.bytes.store('u8', 'little', ram, offset, b.const('u8', 1));
      b.return([]);
    });
    const input = model(module);
    const instruction = present(block(input).instructions[2]);
    const resource = instruction.operands.find((operand) => operand.kind === 'static');
    if (resource?.kind !== 'static') throw new Error('Expected fixture byte reference');
    resource.ref = rom;
    rejects(
      input,
      'invalid-resource',
      instructionLocation(input, 2),
      options({ resources: [{ ref: rom, access: 'read-write' }] }),
    );
  });

  it('accepts all memory operations and enforces index, payload, and endian layouts', () => {
    const module = createIRModule();
    const state = module.state('state', 'u16', 0);
    const array = module.array('array', 'u16', [0, 1]);
    const bytes = module.bytes('bytes', new Uint8Array(8), { readonly: false });
    const inbox = module.inbox('inbox', 8);
    module.entry('allMemory', ['u32', 'u16', 'u8']).body((b, [offset, payload]) => {
      b.state.load(state);
      b.state.store(state, payload);
      b.array.load(array, offset);
      b.array.store(array, offset, payload);
      b.bytes.load('u16', 'little', inbox, offset);
      b.bytes.store('u16', 'big', bytes, offset, payload);
      b.bytes.copy(bytes, offset, inbox, offset, offset);
      b.return([]);
    });
    const input = model(module);
    const configuration = options({
      resources: input.memories.map((memory) => ({ ref: memory.ref, access: 'read-write' })),
    });
    expect(validateIR(input, configuration)).toEqual({ ok: true, diagnostics: [] });
    present(block(input).instructions[2]).operands[1] = {
      kind: 'ssa',
      value: present(block(input).params[1]),
    };
    rejects(input, 'type-mismatch', instructionLocation(input, 2), configuration);
    present(block(input).instructions[1]).operands[1] = {
      kind: 'ssa',
      value: present(block(input).params[2]),
    };
    rejects(input, 'type-mismatch', instructionLocation(input, 1), configuration);
    present(block(input).instructions[4]).operands[1] = { kind: 'literal', value: 'middle' };
    rejects(input, 'type-mismatch', instructionLocation(input, 4), configuration);
  });

  it('requires separate source read and destination write grants for bytes.copy', () => {
    const module = createIRModule();
    const destination = module.bytes('output', new Uint8Array(8), { readonly: false });
    const source = module.inbox('input', 8);
    module.entry('copy', []).body((b) => {
      const zero = b.const('u32', 0);
      b.bytes.copy(destination, zero, source, zero, b.const('u32', 8));
      b.return([]);
    });
    const input = model(module);
    const grants = [
      { ref: destination, access: 'write' as const },
      { ref: source, access: 'read' as const },
    ];
    expect(validateIR(input, options({ resources: grants }))).toEqual({
      ok: true,
      diagnostics: [],
    });
    rejects(
      input,
      'unauthorized-resource',
      instructionLocation(input, 2),
      options({ resources: grants.slice(0, 1) }),
    );
    rejects(
      input,
      'unauthorized-resource',
      instructionLocation(input, 2),
      options({ resources: grants.slice(1) }),
    );
  });

  it('rejects a memory ref whose current kind or readonly marker contradicts its layout', () => {
    const module = createIRModule();
    const ref = module.bytes('rom', new Uint8Array(2), { readonly: true });
    const input = model(module);
    mutable(ref)[byteReadonly] = false as never;
    rejects(input, 'invalid-resource', { path: 'memories[0]' });
    const scalar = stateAccess();
    mutable(scalar.state)[scalarType] = 'u16' as never;
    rejects(scalar.input, 'invalid-resource', { path: 'memories[0]' });
  });
});

describe('validateIR domain extensions', () => {
  it('requires a declared schema, backend support, authorization, and an extension validator', () => {
    const { input, configuration } = domain();
    expect(validateIR(input, configuration)).toEqual({ ok: true, diagnostics: [] });
    rejects(input, 'unsupported-instruction', instructionLocation(input, 0), {
      ...configuration,
      supportedInstructions: core,
    });
    rejects(input, 'unauthorized-instruction', instructionLocation(input, 0), {
      ...configuration,
      authorizedInstructions: core,
    });
    const withoutSchema = domain();
    withoutSchema.input.instructions = [];
    rejects(
      withoutSchema.input,
      'unknown-instruction',
      instructionLocation(withoutSchema.input, 0),
      withoutSchema.configuration,
    );
    rejects(input, 'unsupported-instruction', instructionLocation(input, 0), {
      ...configuration,
      validators: [],
    });
  });

  it('checks domain operands against the declared scalar and static categories', () => {
    const { input, configuration } = domain();
    present(input.instructions[0]).operands = [
      { kind: 'static', category: 'other' },
      { kind: 'value', type: 'bool' },
    ];
    rejects(input, 'signature-mismatch', instructionLocation(input, 0), configuration);
  });

  it('does not accept a removed domain static ref on the strength of a grant', () => {
    const { input, configuration } = domain();
    input.domainDeclarations = [];
    rejects(input, 'invalid-static-reference', instructionLocation(input, 0), configuration);
  });

  it('passes the current module, function, block, instruction, location, and grants to validators', () => {
    const { input, configuration } = domain();
    const validate = vi.fn<IRInstructionValidator['validate']>(() => []);
    const result = validateIR(input, {
      ...configuration,
      validators: [{ op: 'led.set', validate }],
    });
    expect(result).toEqual({ ok: true, diagnostics: [] });
    expect(validate).toHaveBeenCalledTimes(1);
    const context = present(present(validate.mock.calls[0])[0]);
    expect(context.module.functions).toEqual(input.functions);
    expect(context.fn).toBe(input.functions[0]);
    expect(context.block).toBe(block(input));
    expect(context.instruction).toBe(block(input).instructions[0]);
    expect(context.location).toEqual(instructionLocation(input, 0));
    expect(context.resources).toEqual(configuration.resources);
  });

  it('turns each backend rejection into a domain-validation diagnostic at the instruction', () => {
    const { input, configuration } = domain();
    const result = validateIR(input, {
      ...configuration,
      validators: [{ op: 'led.set', validate: () => ['pin unavailable', 'mode unsupported'] }],
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      {
        code: 'domain-validation',
        message: 'pin unavailable',
        location: instructionLocation(input, 0),
      },
      {
        code: 'domain-validation',
        message: 'mode unsupported',
        location: instructionLocation(input, 0),
      },
    ]);
  });

  it.each([
    [
      'throwing',
      () => {
        throw new Error('backend failure');
      },
    ],
    ['async', async () => []],
    [
      'generator',
      function* () {
        yield 'not synchronous';
      },
    ],
    ['Promise-returning', () => Promise.resolve([])],
    ['non-array', () => 'rejected'],
    ['non-string messages', () => [42]],
  ])('contains %s extension callbacks as extension-error diagnostics', (_name, validate) => {
    const { input, configuration } = domain();
    rejects(input, 'extension-error', instructionLocation(input, 0), {
      ...configuration,
      validators: [
        { op: 'led.set', validate: validate as unknown as IRInstructionValidator['validate'] },
      ],
    });
  });
});
