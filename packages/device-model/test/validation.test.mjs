import assert from 'node:assert/strict';
import test from 'node:test';
import { validateBlockIR, validateBoundBlockIR, validateDeviceIR } from '../dist/index.js';

/** 最小的合法 IR：只需满足 schema，不含任何声明。 */
const device = () => ({ kind: 'device', name: 'Node', declarations: [] });
const block = () => ({
  kind: 'block',
  instructions: [{ pc: 0, nextPc: 0, body: { operations: [] } }],
});

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
