import assert from 'node:assert/strict';
import test from 'node:test';
import { validateBlockIR, validateBoundBlockIR, validateDeviceIR } from '../dist/index.js';

const numberType = { kind: 'number' },
  boolType = { kind: 'bool' },
  stringType = { kind: 'string' },
  enumType = { kind: 'enum', name: 'E' };

const constant = (result, type, value) => ({
  kind: 'constant',
  result,
  type,
  constant: { kind: type.kind, ...('name' in type ? { name: type.name } : {}), value },
});
const enumConstant = (result, member) => ({
  kind: 'constant',
  result,
  type: enumType,
  constant: { kind: 'enum', name: 'E', member },
});
const block = (operations) => ({
  kind: 'block',
  instructions: [{ pc: 0, nextPc: 0, body: { operations } }],
});
const computation = (value) => ({
  type: numberType,
  body: { operations: [constant(0, numberType, value), { kind: 'returnValue', value: 0 }] },
});
const enumMatch = (value, closed = false) => ({
  kind: 'match',
  value,
  arms: [
    { pattern: { kind: 'enum', name: 'E', member: 'a' }, body: { operations: [] } },
    { pattern: { kind: 'enum', name: 'E', member: 'b' }, body: { operations: [] } },
  ],
  ...(closed ? { otherwise: { operations: [] } } : {}),
});
const buildError = (run) => {
  try {
    run();
  } catch (error) {
    return error;
  }
  assert.fail('expected BuildError');
};
const diagnostic = (run) => {
  const error = buildError(run);
  return error.diagnostics?.[0] ?? error;
};

/** 设备声明覆盖枚举、记录、状态、内存、引脚与函数，供绑定阶段产生 C 独有错误。 */
const device = () => ({
  kind: 'device',
  name: 'Node',
  declarations: [
    { kind: 'enum', name: 'E', members: ['a', 'b'] },
    {
      kind: 'record',
      name: 'R',
      fields: [
        { name: 'x', type: 'number' },
        { name: 'y', type: 'bool' },
      ],
    },
    { kind: 'state', name: 's', type: numberType, initial: computation(0) },
    { kind: 'memory', name: 'm', public: false, length: computation(4) },
    { kind: 'pin', name: 'p' },
    {
      kind: 'function',
      name: 'f',
      pure: false,
      params: [{ name: 'n', type: numberType }],
      body: { operations: [] },
    },
  ],
});

test('枚举 match 无默认分支仍由独立校验拒绝，绑定校验不因器件成员而放宽', () => {
  const model = validateDeviceIR(device());
  const input = block([enumConstant(0, 'a'), enumMatch(0)]);
  const standalone = diagnostic(() => validateBlockIR(globalThis.structuredClone(input)));
  const bound = diagnostic(() => validateBoundBlockIR(globalThis.structuredClone(input), model));

  assert.equal(standalone.code, 'IR_CONTROL_FLOW');
  assert.equal(standalone.phase, 'finalize');
  assert.deepEqual(standalone.path, ['instructions', 0, 'body', 'operations', 1]);
  assert.equal(bound.code, standalone.code);
  assert.equal(bound.message, standalone.message);
  assert.deepEqual(bound.path, standalone.path);
  assert.equal(bound.phase, 'bind');
});

test('枚举 match 有默认分支通过并复用块身份，后续独立校验命中同一快照', () => {
  const model = validateDeviceIR(device());
  const input = block([enumConstant(0, 'a'), enumMatch(0, true)]);
  const first = validateBoundBlockIR(input, model);

  assert.equal(validateBoundBlockIR(input, model), first);
  assert.equal(validateBlockIR(input), first);
  assert.ok(Object.isFrozen(first));
});

test('绑定阶段先失败仍保留独立校验在前的首个诊断', () => {
  const model = validateDeviceIR(device());
  const standaloneFirst = block([
    { kind: 'localRead', result: 0, type: numberType, local: 9 },
    { kind: 'read', resource: 'state', name: 'missing', result: 1, type: numberType },
  ]);
  const boundFirst = block([
    { kind: 'read', resource: 'state', name: 'missing', result: 0, type: numberType },
    { kind: 'localRead', result: 1, type: numberType, local: 9 },
  ]);
  for (const input of [standaloneFirst, boundFirst]) {
    const standalone = diagnostic(() => validateBlockIR(globalThis.structuredClone(input)));
    const bound = diagnostic(() => validateBoundBlockIR(globalThis.structuredClone(input), model));
    assert.equal(bound.code, standalone.code);
    assert.equal(bound.message, standalone.message);
    assert.deepEqual(bound.path, standalone.path);
    assert.equal(bound.phase, 'bind');
  }
});

test('绑定阶段独有错误在结构校验通过时仍被检出，并缓存已校验块', () => {
  const model = validateDeviceIR(device());
  const input = block([
    constant(0, boolType, true),
    { kind: 'write', resource: 'state', name: 's', value: 0 },
  ]);
  const first = diagnostic(() => validateBoundBlockIR(input, model));
  const second = diagnostic(() => validateBoundBlockIR(input, model));

  assert.equal(first.code, 'IR_TYPE');
  assert.equal(first.phase, 'bind');
  assert.deepEqual(second, first);
  const captured = validateBlockIR(input);
  assert.ok(Object.isFrozen(captured));
  assert.equal(validateBlockIR(captured), captured);
  assert.deepEqual(
    diagnostic(() => validateBoundBlockIR(captured, model)),
    first,
  );
});

test('记录字段类型、枚举成员与调用签名等绑定错误仍逐项报告', () => {
  const model = validateDeviceIR(device());
  const cases = [
    [
      'field-type',
      block([
        constant(0, numberType, 1),
        constant(1, boolType, true),
        {
          kind: 'record',
          result: 2,
          type: { kind: 'record', name: 'R' },
          fields: [
            { name: 'x', value: 0 },
            { name: 'y', value: 1 },
          ],
        },
        { kind: 'field', result: 3, type: boolType, value: 2, field: 'x' },
      ]),
      'IR_TYPE',
      ['instructions', 0, 'body', 'operations', 3, 'type'],
    ],
    [
      'enum-member',
      block([
        {
          kind: 'constant',
          result: 0,
          type: enumType,
          constant: { kind: 'enum', name: 'E', member: 'missing' },
        },
      ]),
      'IR_REFERENCE',
      ['instructions', 0, 'body', 'operations', 0, 'constant'],
    ],
    [
      'call-arity',
      block([constant(0, numberType, 1), { kind: 'call', name: 'f', pure: false, args: [] }]),
      'IR_TYPE',
      ['instructions', 0, 'body', 'operations', 1],
    ],
  ];
  for (const [label, input, code, path] of cases) {
    const first = diagnostic(() => validateBoundBlockIR(globalThis.structuredClone(input), model));
    const second = diagnostic(() => validateBoundBlockIR(globalThis.structuredClone(input), model));
    assert.equal(first.code, code, label);
    assert.deepEqual(first.path, path, label);
    assert.equal(first.phase, 'bind', label);
    assert.deepEqual(second, first, label);
    assert.doesNotThrow(() => validateBlockIR(globalThis.structuredClone(input)), label);
  }
});

test('非法器件与非法块同时失败时块诊断保持优先', () => {
  const invalidDevice = { ...device(), unexpected: true };
  const invalidBlock = block([{ kind: 'localRead', result: 0, type: numberType, local: 9 }]);
  const diagnosticEntry = diagnostic(() => validateBoundBlockIR(invalidBlock, invalidDevice));
  assert.equal(diagnosticEntry.code, 'IR_SCOPE');
  assert.deepEqual(diagnosticEntry.path, ['instructions', 0, 'body', 'operations', 0, 'local']);
  assert.equal(diagnosticEntry.phase, 'bind');
});

/**
 * 每个形状都有一个“补上 otherwise 即合法”的闭包版本。闭包版本必须通过绑定校验，
 * 而开放版本必须在绑定校验中仍被独立结构遍历拒绝；否则说明嵌套扫描漏掉了该路径。
 */
const matchShapes = {
  if: (closed) => ({
    operations: [
      constant(0, boolType, true),
      enumConstant(1, 'a'),
      {
        kind: 'if',
        condition: 0,
        yes: { operations: [enumMatch(1, closed)] },
        no: { operations: [] },
      },
    ],
    path: ['instructions', 0, 'body', 'operations', 2, 'yes', 'operations', 0],
  }),
  while: (closed) => ({
    operations: [
      constant(0, boolType, true),
      enumConstant(1, 'a'),
      {
        kind: 'while',
        test: { type: boolType, body: { operations: [{ kind: 'yield', value: 0 }] } },
        body: { operations: [enumMatch(1, closed)] },
      },
    ],
    path: ['instructions', 0, 'body', 'operations', 2, 'body', 'operations', 0],
  }),
  loop: (closed) => ({
    operations: [
      enumConstant(0, 'a'),
      {
        kind: 'loop',
        body: { operations: [enumMatch(0, closed), { kind: 'break' }] },
      },
    ],
    path: ['instructions', 0, 'body', 'operations', 1, 'body', 'operations', 0],
  }),
  select: (closed) => ({
    operations: [
      constant(0, boolType, true),
      enumConstant(1, 'a'),
      {
        kind: 'select',
        result: 2,
        type: numberType,
        condition: 0,
        yes: {
          type: numberType,
          body: {
            operations: [
              enumMatch(1, closed),
              constant(3, numberType, 1),
              { kind: 'yield', value: 3 },
            ],
          },
        },
        no: {
          type: numberType,
          body: { operations: [constant(4, numberType, 2), { kind: 'yield', value: 4 }] },
        },
      },
    ],
    path: ['instructions', 0, 'body', 'operations', 2, 'yes', 'body', 'operations', 0],
  }),
  assert: (closed) => ({
    operations: [
      constant(0, boolType, true),
      enumConstant(1, 'a'),
      {
        kind: 'assert',
        condition: 0,
        message: {
          type: stringType,
          body: {
            operations: [
              enumMatch(1, closed),
              constant(2, stringType, 'x'),
              { kind: 'yield', value: 2 },
            ],
          },
        },
      },
    ],
    path: ['instructions', 0, 'body', 'operations', 2, 'message', 'body', 'operations', 0],
  }),
  and: (closed) => ({
    operations: [
      constant(0, boolType, true),
      enumConstant(1, 'a'),
      {
        kind: 'and',
        result: 2,
        type: boolType,
        left: 0,
        right: {
          type: boolType,
          body: {
            operations: [
              enumMatch(1, closed),
              constant(3, boolType, true),
              { kind: 'yield', value: 3 },
            ],
          },
        },
      },
    ],
    path: ['instructions', 0, 'body', 'operations', 2, 'right', 'body', 'operations', 0],
  }),
  or: (closed) => ({
    operations: [
      constant(0, boolType, true),
      enumConstant(1, 'a'),
      {
        kind: 'or',
        result: 2,
        type: boolType,
        left: 0,
        right: {
          type: boolType,
          body: {
            operations: [
              enumMatch(1, closed),
              constant(3, boolType, true),
              { kind: 'yield', value: 3 },
            ],
          },
        },
      },
    ],
    path: ['instructions', 0, 'body', 'operations', 2, 'right', 'body', 'operations', 0],
  }),
  matchArm: (closed) => ({
    operations: [
      constant(0, boolType, true),
      enumConstant(1, 'a'),
      {
        kind: 'match',
        value: 0,
        otherwise: { operations: [] },
        arms: [
          { pattern: { kind: 'bool', value: true }, body: { operations: [enumMatch(1, closed)] } },
        ],
      },
    ],
    path: ['instructions', 0, 'body', 'operations', 2, 'arms', 0, 'body', 'operations', 0],
  }),
  matchOtherwise: (closed) => ({
    operations: [
      constant(0, boolType, true),
      enumConstant(1, 'a'),
      {
        kind: 'match',
        value: 0,
        arms: [{ pattern: { kind: 'bool', value: true }, body: { operations: [] } }],
        otherwise: { operations: [enumMatch(1, closed)] },
      },
    ],
    path: ['instructions', 0, 'body', 'operations', 2, 'otherwise', 'operations', 0],
  }),
};

for (const [name, shape] of Object.entries(matchShapes)) {
  test(`嵌套 ${name} 中的无默认枚举 match 仍走独立校验`, () => {
    const model = validateDeviceIR(device());
    const closed = block(shape(true).operations);
    assert.doesNotThrow(() => validateBlockIR(globalThis.structuredClone(closed)), name);
    assert.doesNotThrow(
      () => validateBoundBlockIR(globalThis.structuredClone(closed), model),
      name,
    );

    const open = block(shape(false).operations);
    const standalone = diagnostic(() => validateBlockIR(globalThis.structuredClone(open)));
    const bound = diagnostic(() => validateBoundBlockIR(globalThis.structuredClone(open), model));
    assert.equal(bound.code, standalone.code, name);
    assert.equal(bound.message, standalone.message, name);
    assert.deepEqual(bound.path, shape(false).path, name);
    assert.deepEqual(bound.path, standalone.path, name);
    assert.equal(bound.phase, 'bind', name);
  });
}

test('器件校验的 CHANNEL_CONSUMER_CONFLICT code 在有效块上保留，非法块仍优先', () => {
  const conflictDevice = {
    kind: 'device',
    name: 'Node',
    declarations: [
      { kind: 'notification', name: 'n', direction: 'input' },
      {
        kind: 'channel',
        name: 'ch',
        direction: 'input',
        type: numberType,
        capacity: computation(1),
      },
      {
        kind: 'on',
        name: 'p1',
        sourcePath: ['n'],
        body: { operations: [{ kind: 'receive', channel: 'ch', result: 0, type: numberType }] },
      },
      {
        kind: 'on',
        name: 'p2',
        sourcePath: ['n'],
        body: { operations: [{ kind: 'receive', channel: 'ch', result: 0, type: numberType }] },
      },
    ],
  };
  const valid = block([constant(0, numberType, 1)]);
  const invalid = block([{ kind: 'localRead', result: 0, type: numberType, local: 9 }]);
  const conflict = buildError(() => validateBoundBlockIR(valid, conflictDevice));
  assert.equal(conflict.code, 'CHANNEL_CONSUMER_CONFLICT');
  assert.equal(conflict.diagnostics[0].code, 'IR_REFERENCE');
  assert.equal(conflict.diagnostics[0].phase, 'bind');

  const blockError = diagnostic(() => validateBoundBlockIR(invalid, conflictDevice));
  assert.equal(blockError.code, 'IR_SCOPE');
  assert.equal(blockError.phase, 'bind');
});
