import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDeviceBuilder,
  createJitBlockBuilder,
  types,
  validateBlockIR,
  validateBoundBlockIR,
  validateDeviceIR,
} from '../dist/index.js';

/** 最小的合法 IR：只需满足 schema，不含任何声明。 */
const device = () => ({ kind: 'device', name: 'Node', declarations: [] });
const block = (operations = []) => ({
  kind: 'block',
  instructions: [{ pc: 0, nextPc: 0, body: { operations } }],
});

test('Builder 在嵌套指令发射时保留构造诊断', () => {
  const builder = createJitBlockBuilder();
  assert.throws(
    () =>
      builder.instruction({ pc: 0, nextPc: 1 }, (body) => {
        body.if(true, (branch) => branch.notify(42));
      }),
    ({ diagnostics: [diagnostic] }) =>
      diagnostic.phase === 'construct' &&
      diagnostic.code === 'IR_SCHEMA' &&
      diagnostic.path.join('.') === 'notification',
  );
});

test('外部 IR 的嵌套操作仍完整检查 schema', () => {
  const input = block([
    { kind: 'if', condition: 0, yes: { operations: [{ kind: 'stop', extra: true }] } },
  ]);
  assert.throws(
    () => validateBlockIR(input),
    ({ diagnostics: [diagnostic] }) =>
      diagnostic.code === 'IR_SCHEMA' &&
      diagnostic.path.join('.') === 'instructions.0.body.operations.0.yes.operations.0.extra',
  );
});

test('结果可在子区域读取，但不能逃逸到父区域或兄弟分支', () => {
  const constant = (result, kind, value) => ({
    kind: 'constant',
    result,
    type: { kind },
    constant: { kind, value },
  });
  const elapse = (duration) => ({ kind: 'elapse', duration });
  const branch = (no) => ({
    kind: 'if',
    condition: 0,
    yes: { operations: [constant(2, 'number', 2), elapse(1)] },
    no: { operations: [no] },
  });
  const prefix = [constant(0, 'bool', true), constant(1, 'number', 1)];
  assert.doesNotThrow(() => validateBlockIR(block([...prefix, branch(elapse(1)), elapse(1)])));
  for (const [body, message] of [
    [block([...prefix, branch(elapse(2))]), /not visible/],
    [block([...prefix, branch(elapse(1)), elapse(2)]), /not visible/],
    [block([...prefix, branch(constant(2, 'number', 3))]), /Duplicate result/],
  ]) {
    assert.throws(
      () => validateBlockIR(body),
      ({ diagnostics: [diagnostic] }) =>
        diagnostic.code === 'IR_SCOPE' && message.test(diagnostic.message),
    );
  }
});

/**
 * 顺序合并同一个 local：每轮的两个分支各自带着上一轮的 local 身份再做一次条件合并，
 * 外层再把两个分支合流。旧 key 实现会在这里把父 join 的完整字符串复制两份。
 */
function mergeChain(depth) {
  const boolType = { kind: 'bool' },
    numberType = { kind: 'number' };
  let next = 1;
  const id = () => next++;
  const condition = id(),
    initial = id(),
    left = id(),
    right = id();
  const operations = [
    {
      kind: 'constant',
      result: condition,
      type: boolType,
      constant: { kind: 'bool', value: true },
    },
    { kind: 'constant', result: initial, type: numberType, constant: { kind: 'number', value: 0 } },
    { kind: 'constant', result: left, type: numberType, constant: { kind: 'number', value: 1 } },
    { kind: 'constant', result: right, type: numberType, constant: { kind: 'number', value: 2 } },
    { kind: 'local', local: 0, type: numberType, initial },
  ];
  for (let i = 0; i < depth; i++) {
    const yesRead = id(),
      noRead = id();
    operations.push({
      kind: 'if',
      condition,
      yes: {
        operations: [
          { kind: 'localRead', result: yesRead, type: numberType, local: 0 },
          {
            kind: 'if',
            condition,
            yes: { operations: [{ kind: 'localWrite', local: 0, value: left }] },
          },
        ],
      },
      no: {
        operations: [
          { kind: 'localRead', result: noRead, type: numberType, local: 0 },
          {
            kind: 'if',
            condition,
            yes: { operations: [{ kind: 'localWrite', local: 0, value: right }] },
          },
        ],
      },
    });
  }
  return block(operations);
}

/** 可选 local 在两个分支中分别写入值：可选择让其中一路丢失 non-null 证明。 */
function optionalMerge(withNone) {
  const boolType = { kind: 'bool' },
    numberType = { kind: 'number' },
    optionalType = { kind: 'optional', inner: numberType };
  let next = 1;
  const id = () => next++;
  const condition = id(),
    one = id(),
    two = id(),
    initial = id(),
    branch = id(),
    none = withNone ? id() : 0;
  const operations = [
    {
      kind: 'constant',
      result: condition,
      type: boolType,
      constant: { kind: 'bool', value: true },
    },
    { kind: 'constant', result: one, type: numberType, constant: { kind: 'number', value: 1 } },
    { kind: 'constant', result: two, type: numberType, constant: { kind: 'number', value: 2 } },
    { kind: 'optional', result: initial, type: optionalType, value: one },
    { kind: 'optional', result: branch, type: optionalType, value: two },
    ...(withNone
      ? [
          {
            kind: 'constant',
            result: none,
            type: optionalType,
            constant: { kind: 'none' },
          },
        ]
      : []),
    { kind: 'local', local: 0, type: optionalType, initial },
  ];
  operations.push({
    kind: 'if',
    condition,
    yes: { operations: [{ kind: 'localWrite', local: 0, value: branch }] },
    ...(withNone ? { no: { operations: [{ kind: 'localWrite', local: 0, value: none }] } } : {}),
  });
  const read = id();
  operations.push({ kind: 'localRead', result: read, type: optionalType, local: 0 });
  operations.push({ kind: 'nonNull', result: id(), type: numberType, value: read });
  return block(operations);
}

/** match / select / 短路求值的分支合流：两条路径分别写可选值，可选择其中一路丢失证明。 */
function optionalControl(kind, lossy) {
  const boolType = { kind: 'bool' },
    numberType = { kind: 'number' },
    optionalType = { kind: 'optional', inner: numberType };
  let next = 1;
  const id = () => next++;
  const condition = id(),
    one = id(),
    two = id(),
    initial = id(),
    left = id(),
    right = id(),
    none = lossy ? id() : 0;
  const operations = [
    {
      kind: 'constant',
      result: condition,
      type: boolType,
      constant: { kind: 'bool', value: true },
    },
    { kind: 'constant', result: one, type: numberType, constant: { kind: 'number', value: 1 } },
    { kind: 'constant', result: two, type: numberType, constant: { kind: 'number', value: 2 } },
    { kind: 'optional', result: initial, type: optionalType, value: one },
    { kind: 'optional', result: left, type: optionalType, value: one },
    { kind: 'optional', result: right, type: optionalType, value: two },
    ...(lossy
      ? [
          {
            kind: 'constant',
            result: none,
            type: optionalType,
            constant: { kind: 'none' },
          },
        ]
      : []),
    { kind: 'local', local: 0, type: optionalType, initial },
  ];
  const write = (value) => ({ operations: [{ kind: 'localWrite', local: 0, value }] });
  if (kind === 'match') {
    operations.push({
      kind: 'match',
      value: condition,
      arms: [
        { pattern: { kind: 'bool', value: true }, body: write(left) },
        { pattern: { kind: 'bool', value: false }, body: write(lossy ? none : right) },
      ],
    });
  } else if (kind === 'select') {
    operations.push({
      kind: 'select',
      result: id(),
      type: numberType,
      condition,
      yes: {
        type: numberType,
        body: {
          operations: [
            { kind: 'localWrite', local: 0, value: left },
            { kind: 'yield', value: one },
          ],
        },
      },
      no: {
        type: numberType,
        body: {
          operations: [
            { kind: 'localWrite', local: 0, value: lossy ? none : right },
            { kind: 'yield', value: two },
          ],
        },
      },
    });
  } else {
    operations.push({
      kind,
      result: id(),
      type: boolType,
      left: condition,
      right: {
        type: boolType,
        body: {
          operations: [
            { kind: 'localWrite', local: 0, value: lossy ? none : right },
            { kind: 'yield', value: condition },
          ],
        },
      },
    });
  }
  const read = id();
  operations.push({ kind: 'localRead', result: read, type: optionalType, local: 0 });
  operations.push({ kind: 'nonNull', result: id(), type: numberType, value: read });
  return block(operations);
}

/** 同一 record 的 field 访问共享身份；不同 field 不能互相借走 non-null 证明。 */
function fieldProof(sameField) {
  const boolType = { kind: 'bool' },
    numberType = { kind: 'number' },
    optionalType = { kind: 'optional', inner: numberType },
    recordType = { kind: 'record', name: 'R' };
  let next = 1;
  const id = () => next++;
  const one = id(),
    two = id(),
    record = id(),
    first = id(),
    second = id(),
    tested = id();
  const operations = [
    { kind: 'constant', result: one, type: numberType, constant: { kind: 'number', value: 1 } },
    { kind: 'constant', result: two, type: numberType, constant: { kind: 'number', value: 2 } },
    {
      kind: 'record',
      result: record,
      type: recordType,
      fields: [
        { name: 'x', value: one },
        { name: 'y', value: two },
      ],
    },
    { kind: 'field', result: first, type: optionalType, value: record, field: 'x' },
    {
      kind: 'field',
      result: second,
      type: optionalType,
      value: record,
      field: sameField ? 'x' : 'y',
    },
    { kind: 'isNone', result: tested, type: boolType, value: first },
    {
      kind: 'if',
      condition: tested,
      yes: { operations: [] },
      no: { operations: [{ kind: 'nonNull', result: id(), type: numberType, value: second }] },
    },
  ];
  return block(operations);
}

/** while 循环的局部合流需要跨迭代收敛；每轮都从 none 写入得到新的 join 结构。 */
function loopMerge() {
  const boolType = { kind: 'bool' },
    numberType = { kind: 'number' },
    optionalType = { kind: 'optional', inner: numberType };
  let next = 1;
  const id = () => next++;
  const condition = id(),
    one = id(),
    two = id(),
    initial = id(),
    branch = id(),
    none = id();
  const operations = [
    {
      kind: 'constant',
      result: condition,
      type: boolType,
      constant: { kind: 'bool', value: true },
    },
    { kind: 'constant', result: one, type: numberType, constant: { kind: 'number', value: 1 } },
    { kind: 'constant', result: two, type: numberType, constant: { kind: 'number', value: 2 } },
    { kind: 'optional', result: initial, type: optionalType, value: one },
    { kind: 'optional', result: branch, type: optionalType, value: two },
    { kind: 'constant', result: none, type: optionalType, constant: { kind: 'none' } },
    { kind: 'local', local: 0, type: optionalType, initial },
    {
      kind: 'while',
      test: { type: boolType, body: { operations: [{ kind: 'yield', value: condition }] } },
      body: {
        operations: [
          {
            kind: 'if',
            condition,
            yes: { operations: [{ kind: 'localWrite', local: 0, value: none }] },
          },
        ],
      },
    },
  ];
  const read = id();
  operations.push({ kind: 'localRead', result: read, type: optionalType, local: 0 });
  operations.push({ kind: 'nonNull', result: id(), type: numberType, value: read });
  return block(operations);
}

const diagnostic = (act) => {
  try {
    act();
  } catch (error) {
    return error.diagnostics?.[0];
  }
  assert.fail('expected BuildError');
};

test('validateDeviceIR 按输入对象身份缓存，并返回递归冻结的副本', () => {
  const model = device();
  const first = validateDeviceIR(model);
  const second = validateDeviceIR(model);

  assert.equal(second, first, '第二次校验必须命中缓存并返回同一份快照');
  assert.notEqual(first, model, '校验结果必须是与输入不同的捕获副本');
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.declarations));
  assert.ok(!Object.isFrozen(model), '输入对象保持可变');
});

test('validateBlockIR 与 validateBoundBlockIR 复用已校验的块与器件', () => {
  const model = validateDeviceIR(device());
  const instructions = block();
  const first = validateBoundBlockIR(instructions, model);
  const second = validateBoundBlockIR(instructions, model);

  assert.equal(validateBlockIR(instructions), first);
  assert.equal(second, first);
  assert.ok(Object.isFrozen(first));
});

test('JIT 草稿允许先重写，绑定只接受合法的最终 IR', () => {
  const definition = createDeviceBuilder({ name: 'Draft' });
  definition.state({ name: 'finalState', type: types.number, initial: 0 });
  const model = definition.finish();
  const builder = createJitBlockBuilder();
  builder.instruction({ pc: 0, nextPc: 1 }, (body) => body.writeState('draftState', 1));
  const draft = builder.finishDraft();
  assert.throws(() => builder.finish(), { name: 'BuildError' });
  assert.throws(() => validateBoundBlockIR({ ...draft }, model), { name: 'BuildError' });

  draft.instructions[0].body.operations.at(-1).name = 'finalState';
  const bound = validateBoundBlockIR(draft, model);
  assert.equal(bound.instructions[0].body.operations.at(-1).name, 'finalState');
  assert.ok(Object.isFrozen(bound.instructions[0].body.operations.at(-1)));
  assert.equal(validateBoundBlockIR(bound, model), bound);
});

test('声明索引只供对应器件复用，不跨器件共享绑定结果', () => {
  const buildDevice = (type, initial) => {
    const builder = createDeviceBuilder({ name: 'Node' });
    builder.state({ name: 'cell', type, initial });
    return builder.finish();
  };
  const numeric = buildDevice(types.number, 0);
  const boolean = buildDevice(types.bool, false);
  const builder = createJitBlockBuilder({ device: numeric });
  builder.instruction({ pc: 0, nextPc: 1 }, (body) => {
    body.writeState('cell', 1);
  });
  const compiled = builder.finish();

  assert.equal(validateBoundBlockIR(compiled, numeric), compiled);
  const incompatible = diagnostic(() => validateBoundBlockIR(compiled, boolean));
  assert.equal(incompatible.code, 'IR_TYPE');
  assert.equal(incompatible.phase, 'bind');
});

test('非法 IR 每次校验都抛出相同诊断', () => {
  const invalid = { ...device(), unexpected: true };
  const first = diagnostic(() => validateDeviceIR(invalid));
  const second = diagnostic(() => validateDeviceIR(invalid));

  assert.deepEqual(second, first);
  assert.equal(first.code, 'IR_SCHEMA');
  assert.equal(first.message, 'Unexpected field unexpected.');
  assert.deepEqual(first.path, ['unexpected']);
});

test('捕获快照保留 __proto__ 自有属性，交由 schema 报错', () => {
  const model = device();
  Object.defineProperty(model, '__proto__', {
    value: { pollute: true },
    enumerable: true,
    configurable: true,
    writable: true,
  });

  const first = diagnostic(() => validateDeviceIR(model));

  assert.equal(first.message, 'Unexpected field __proto__.');
  assert.deepEqual(first.path, ['__proto__']);
});

test('snapshot 的结构守卫保持原有诊断与路径', () => {
  const sparse = device();
  sparse.declarations = [];
  sparse.declarations.length = 2;

  const extra = device();
  extra.declarations = [];
  extra.declarations.extra = 1;

  const accessor = device();
  Object.defineProperty(accessor, 'name', { get: () => 'Node', enumerable: true });

  const symbol = device();
  symbol[Symbol('name')] = 'Node';

  const cyclic = device();
  cyclic.self = cyclic;

  class Model {
    constructor() {
      this.kind = 'device';
      this.name = 'Node';
      this.declarations = [];
    }
  }

  const cases = [
    ['稀疏数组', sparse, 'IR arrays cannot be sparse.', []],
    ['数组额外属性', extra, 'IR arrays cannot contain extra properties.', []],
    ['访问器', accessor, 'IR data cannot contain symbols or accessors.', []],
    ['符号键', symbol, 'IR data cannot contain symbols or accessors.', []],
    ['循环引用', cyclic, 'Cyclic IR data is not supported.', ['self']],
    ['类实例', new Model(), 'Expected an ordinary data object.', []],
    ['函数值', { ...device(), version: () => 1 }, 'Expected ordinary IR data.', ['version']],
    ['bigint 值', { ...device(), version: 1n }, 'Expected ordinary IR data.', ['version']],
  ];

  for (const [label, input, message, path] of cases) {
    const first = diagnostic(() => validateDeviceIR(input));
    const second = diagnostic(() => validateDeviceIR(input));
    assert.equal(first.message, message, label);
    assert.equal(first.code, 'IR_SCHEMA', label);
    assert.deepEqual(first.path, path, label);
    assert.deepEqual(second, first, `${label} 必须每次重新报错`);
  }
});

test('join 身份按结构驻留，合并链不复制父 key', () => {
  // 旧实现约在 24 层就抛出 RangeError: Invalid string length。深度是线性 IR 规模，
  // 校验必须保持线性；增加深度可继续验证身份表没有按迭代重新生成。
  for (const depth of [64, 128, 256]) {
    assert.doesNotThrow(() => validateBlockIR(mergeChain(depth)), `depth ${depth}`);
  }
});

test('join 只在所有分支都保留 non-null 证明时传递可选性事实', () => {
  assert.doesNotThrow(() => validateBlockIR(optionalMerge(false)));

  const error = diagnostic(() => validateBlockIR(optionalMerge(true)));
  assert.equal(error.code, 'IR_TYPE');
  assert.equal(error.message, 'nonNull requires a dominating non-null proof.');
});

test('match、select 与短路右值的合流都只传递全路径证明', () => {
  for (const kind of ['match', 'select', 'and', 'or']) {
    assert.doesNotThrow(() => validateBlockIR(optionalControl(kind, false)), kind);
    const error = diagnostic(() => validateBlockIR(optionalControl(kind, true)));
    assert.equal(error.code, 'IR_TYPE', kind);
    assert.equal(error.message, 'nonNull requires a dominating non-null proof.', kind);
  }
});

test('field 身份保持同一访问别名且不串到不同字段', () => {
  assert.doesNotThrow(() => validateBlockIR(fieldProof(true)));
  const error = diagnostic(() => validateBlockIR(fieldProof(false)));
  assert.equal(error.code, 'IR_TYPE');
  assert.equal(error.message, 'nonNull requires a dominating non-null proof.');
});

test('loop local 合流身份稳定，并在证明丢失后收敛', () => {
  const error = diagnostic(() => validateBlockIR(loopMerge()));
  assert.equal(error.code, 'IR_TYPE');
  assert.equal(error.message, 'nonNull requires a dominating non-null proof.');
});
