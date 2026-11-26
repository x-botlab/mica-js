import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildJitFunctions,
  types,
  validateBlockIR,
  validateBoundBlockIR,
  validateDeviceIR,
} from '../dist/index.js';

const numberType = { kind: 'number' };
const rawDevice = (name = 'Node') => ({ kind: 'device', name, declarations: [] });
const model = (name = 'Node') => validateDeviceIR(rawDevice(name));
const constant = (result, value, type = numberType) => ({
  kind: 'constant',
  result,
  type,
  constant: { kind: type.kind, value },
});
const block = (operations, pc = 0, nextPc = 1) => ({
  kind: 'block',
  instructions: [{ pc, nextPc, body: { operations } }],
});
const errorOf = (run) => {
  try {
    run();
  } catch (error) {
    return error;
  }
  assert.fail('expected BuildError');
};

function emit(device, { name = 'value', params, returns, source, body }) {
  return buildJitFunctions(device, (fns) => {
    fns.pureFn(
      {
        name,
        params: params ?? [{ name: 'input', type: types.number }],
        returns: returns ?? types.number,
        ...(source ? { source } : {}),
      },
      body,
    );
  });
}
const identity = (device, options = {}) =>
  emit(device, {
    ...options,
    body: (b, { input }) => b.returnValue(input),
  });
const addOne = (device) =>
  emit(device, {
    body: (b, { input }) => b.returnValue(b.add(input, 1)),
  });
const boolIdentity = (device) =>
  emit(device, {
    params: [{ name: 'input', type: types.bool }],
    returns: types.bool,
    body: (b, { input }) => b.returnValue(input),
  });
const orderedPair = (device, reversed) =>
  buildJitFunctions(device, (fns) => {
    for (const name of reversed ? ['second', 'first'] : ['first', 'second'])
      fns.pureFn({ name, params: [], returns: types.number }, (b) =>
        b.returnValue(b.constant(types.number, 1)),
      );
  });
const zero = (device, value) =>
  emit(device, {
    params: [],
    body: (b) => b.returnValue(b.constant(types.number, value)),
  });

test('结构相等的 JIT 函数表复用同一个冻结数组', () => {
  const device = rawDevice();
  const first = identity(device);
  const second = identity(device);

  assert.equal(second, first);
  assert.equal(identity(device), first);
  assert.ok(Object.isFrozen(first));
});

test('已校验的原始输入按规范器件身份复用函数表', () => {
  const raw = rawDevice();
  const canonical = validateDeviceIR(raw);
  const first = identity(canonical);

  assert.equal(identity(raw), first);
});

test('函数体、源码位置、参数类型、声明顺序与 -0/0 仍产生不同数组', () => {
  const cases = [
    ['函数体', (device) => identity(device), addOne],
    [
      '源码位置',
      (device) => identity(device, { source: { label: 'a' } }),
      (device) => identity(device, { source: { label: 'b' } }),
    ],
    ['参数类型', identity, boolIdentity],
    ['声明顺序', (device) => orderedPair(device, false), (device) => orderedPair(device, true)],
    ['-0 与 0', (device) => zero(device, 0), (device) => zero(device, -0)],
  ];
  for (const [label, base, changed] of cases) {
    const device = rawDevice();
    assert.notEqual(base(device), changed(device), label);
  }
});

test('空函数表保持原有行为', () => {
  const device = rawDevice();
  const first = buildJitFunctions(device, () => {});
  const second = buildJitFunctions(device, () => {});

  assert.deepEqual(first, []);
  assert.deepEqual(second, []);
  assert.ok(Object.isFrozen(first));
  assert.notEqual(first, second);
});

test('结构相等的不同块对象返回同一个规范绑定块并记录两个身份', () => {
  const definition = model();
  const firstInput = block([constant(0, 1)]);
  const secondInput = block([constant(0, 1)]);
  assert.notEqual(firstInput, secondInput);

  const first = validateBoundBlockIR(firstInput, definition);
  const second = validateBoundBlockIR(secondInput, definition);

  assert.equal(second, first);
  assert.equal(validateBoundBlockIR(firstInput, definition), first);
  assert.equal(validateBlockIR(secondInput), first);
  assert.ok(Object.isFrozen(first));
});

test('不同块即使结构摘要相同也不共享结果', () => {
  const definition = model();
  const firstInput = block([constant(0, 1)]);
  const secondInput = block([constant(0, 2)]);

  const first = validateBoundBlockIR(firstInput, definition);
  const second = validateBoundBlockIR(secondInput, definition);

  assert.notEqual(first, second);
  assert.equal(first.instructions[0].body.operations[0].constant.value, 1);
  assert.equal(second.instructions[0].body.operations[0].constant.value, 2);
  assert.equal(validateBoundBlockIR(block([constant(0, 2)]), definition), second);
});

test('不同 DeviceIR 不共享结构相等的绑定块', () => {
  const firstModel = model('First');
  const secondModel = model('Second');

  const first = validateBoundBlockIR(block([constant(0, 1)]), firstModel);
  const second = validateBoundBlockIR(block([constant(0, 1)]), secondModel);

  assert.notEqual(first, second);
  assert.equal(validateBoundBlockIR(block([constant(0, 1)]), firstModel), first);
  assert.equal(validateBoundBlockIR(block([constant(0, 1)]), secondModel), second);
});

test('非法与循环输入保持相同诊断且不进入缓存', () => {
  const definition = model();
  const invalid = block([{ kind: 'localRead', result: 0, type: numberType, local: 9 }]);
  const first = errorOf(() => validateBoundBlockIR(invalid, definition));
  const second = errorOf(() =>
    validateBoundBlockIR(globalThis.structuredClone(invalid), definition),
  );
  assert.deepEqual(second.diagnostics, first.diagnostics);

  const malformed = { ...block([constant(0, 1)]), unexpected: true };
  const malformedFirst = errorOf(() => validateBoundBlockIR(malformed, definition));
  assert.equal(malformedFirst.diagnostics[0].code, 'IR_SCHEMA');
  delete malformed.unexpected;
  assert.doesNotThrow(() => validateBoundBlockIR(malformed, definition));

  const cyclic = { kind: 'block', instructions: [] };
  cyclic.instructions.push({ pc: 0, nextPc: 1, body: { operations: [] }, self: cyclic });
  const cyclicFirst = errorOf(() => validateBoundBlockIR(cyclic, definition));
  const cyclicSecond = errorOf(() => validateBoundBlockIR(cyclic, definition));
  assert.equal(cyclicFirst.diagnostics[0].code, 'IR_SCHEMA');
  assert.match(cyclicFirst.diagnostics[0].message, /Cyclic/);
  assert.deepEqual(cyclicSecond.diagnostics, cyclicFirst.diagnostics);
});

test('摘要缓存超过上限后淘汰最旧项且校验仍正确', () => {
  const definition = model();
  const original = [];
  for (let i = 0; i < 70; i++)
    original.push(validateBoundBlockIR(block([constant(0, i)], i, i + 1), definition));

  const oldestAgain = validateBoundBlockIR(block([constant(0, 0)], 0, 1), definition);
  assert.notEqual(oldestAgain, original[0]);
  assert.equal(oldestAgain.instructions[0].body.operations[0].constant.value, 0);
  assert.ok(Object.isFrozen(oldestAgain));

  const recentAgain = validateBoundBlockIR(block([constant(0, 69)], 69, 70), definition);
  assert.equal(recentAgain, original[69]);
});
