// @ts-check
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { device, messages } from '../../conformance/semantics/fixture.mjs';
import { trace } from '../oracles/expressions.mjs';

const arithmetic = ['+', '-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', '>>>'];
const comparisons = ['<', '<=', '>', '>=', '==', '!='];
/** @type {Record<string, import('../../../docs/spec/contracts/ir').BinaryOperator>} */
const irOperators = {
  '+': 'add',
  '-': 'subtract',
  '*': 'multiply',
  '/': 'divide',
  '%': 'remainder',
  '**': 'power',
  '&': 'bitAnd',
  '|': 'bitOr',
  '^': 'bitXor',
  '<<': 'shiftLeft',
  '>>': 'shiftRight',
  '>>>': 'shiftRightUnsigned',
  '<': 'lessThan',
  '<=': 'lessThanOrEqual',
  '>': 'greaterThan',
  '>=': 'greaterThanOrEqual',
  '==': 'equal',
  '!=': 'notEqual',
};
/** @type {Record<string, import('../../../docs/spec/contracts/ir').UnaryOperator>} */
const unaryOperators = { '+': 'positive', '-': 'negate', '~': 'bitNot', '!': 'not' };
const number = fc.oneof(
  fc.integer({ min: -2048, max: 2048 }),
  fc.constantFrom(0, 1, -1, 0.5, -0.5, 2147483648, 4294967295, -4294967296),
);

// Each production is indexed by its result type; shrinking cannot mix types.
// Rules: language/expressions.rst, language/types.rst, ir/operations.rst.
export function expressionArbitrary(type, depth) {
  const cache = new Map();
  function build(resultType, remaining) {
    const key = `${resultType}/${remaining}`;
    if (cache.has(key)) return cache.get(key);
    const literal = fc.record({
      kind: fc.constant('literal'),
      type: fc.constant(resultType),
      value: resultType === 'number' ? number : fc.boolean(),
    });
    const read = fc.record({
      kind: fc.constant('read'),
      type: fc.constant(resultType),
      name: resultType === 'number' ? fc.constantFrom('n', 'm', 'tick') : fc.constant('flag'),
    });
    const leaf = fc.oneof(literal, read);
    if (remaining === 0) return leaf;
    const numeric = build('number', remaining - 1);
    const boolean = build('bool', remaining - 1);
    const same = resultType === 'number' ? numeric : boolean;
    const binary = (operators, operands) =>
      fc.record({
        kind: fc.constant('binary'),
        type: fc.constant(resultType),
        operator: fc.constantFrom(...operators),
        left: operands,
        right: operands,
      });
    const arbitrary = fc.oneof(
      { withCrossShrink: true },
      leaf,
      leaf,
      fc.record({
        kind: fc.constant('unary'),
        type: fc.constant(resultType),
        operator: resultType === 'number' ? fc.constantFrom('+', '-', '~') : fc.constant('!'),
        value: same,
      }),
      resultType === 'number' ? binary(arithmetic, numeric) : binary(comparisons, numeric),
      ...(resultType === 'bool' ? [binary(['&&', '||', '==', '!='], boolean)] : []),
      fc.record({
        kind: fc.constant('select'),
        type: fc.constant(resultType),
        condition: boolean,
        yes: same,
        no: same,
      }),
    );
    cache.set(key, arbitrary);
    return arbitrary;
  }
  return build(type, depth);
}

export function renderExpression(node) {
  switch (node.kind) {
    case 'literal':
      return `(${String(node.value)})`;
    case 'read':
      return node.name;
    case 'unary':
      return `(${node.operator}${renderExpression(node.value)})`;
    case 'binary':
      return `(${renderExpression(node.left)} ${node.operator} ${renderExpression(node.right)})`;
    case 'select':
      return `(${renderExpression(node.condition)} ? ${renderExpression(node.yes)} : ${renderExpression(node.no)})`;
    default:
      throw new Error(`Unknown expression: ${node.kind}`);
  }
}

export function renderDDL(sample) {
  const lines = [
    'device Generated(n: number, m: number, flag: bool) {',
    '  state tick: number = 0;',
    `  output channel out: ${sample.expression.type}(capacity: ${sample.delays.length + 1});`,
    '  process start {',
    `    out.send(${renderExpression(sample.expression)});`,
  ];
  for (const delay of sample.delays) {
    lines.push(
      `    await ticks(${delay});`,
      '    tick = tick + 1;',
      `    out.send(${renderExpression(sample.expression)});`,
    );
  }
  return [...lines, '  }', '}'].join('\n');
}

/** @returns {import('../../../docs/spec/contracts/ir').DeviceIR} */
export function buildIR(sample) {
  let next = 0;
  /** @param {import('../../../docs/spec/contracts/ir').OperationIR[]} operations */
  function literal(value, operations) {
    const result = next++;
    const kind = typeof value === 'boolean' ? 'bool' : 'number';
    operations.push({ kind: 'constant', result, type: { kind }, constant: { kind, value } });
    return result;
  }
  /** @param {import('../../../docs/spec/contracts/ir').OperationIR[]} operations */
  function lower(node, operations) {
    const type = { kind: node.type };
    if (node.kind === 'literal') return literal(node.value, operations);
    const result = next++;
    if (node.kind === 'read') {
      operations.push({
        kind: 'read',
        result,
        type,
        resource: node.name === 'tick' ? 'state' : 'property',
        name: node.name,
      });
    } else if (node.kind === 'unary') {
      const value = lower(node.value, operations);
      operations.push({
        kind: 'unary',
        result,
        type,
        operator: unaryOperators[node.operator],
        value,
      });
    } else if (node.kind === 'select') {
      const condition = lower(node.condition, operations);
      operations.push({
        kind: 'select',
        result,
        type,
        condition,
        yes: region(node.yes),
        no: region(node.no),
      });
    } else if (node.kind === 'binary') {
      const left = lower(node.left, operations);
      if (node.operator === '&&' || node.operator === '||') {
        operations.push({
          kind: node.operator === '&&' ? 'and' : 'or',
          result,
          type,
          left,
          right: region(node.right),
        });
      } else {
        const right = lower(node.right, operations);
        operations.push({
          kind: 'binary',
          result,
          type,
          operator: irOperators[node.operator],
          left,
          right,
        });
      }
    } else throw new Error(`Unknown expression: ${node.kind}`);
    return result;
  }
  /** @returns {import('../../../docs/spec/contracts/ir').ValueRegionIR} */
  function region(node) {
    /** @type {import('../../../docs/spec/contracts/ir').OperationIR[]} */
    const operations = [];
    const value = lower(node, operations);
    operations.push({ kind: 'yield', value });
    return { type: { kind: node.type }, body: { operations } };
  }
  /** @returns {import('../../../docs/spec/contracts/ir').ComputationIR} */
  function computation(value) {
    return {
      type: { kind: 'number' },
      body: {
        operations: [
          {
            kind: 'constant',
            result: 0,
            type: { kind: 'number' },
            constant: { kind: 'number', value },
          },
          { kind: 'returnValue', value: 0 },
        ],
      },
    };
  }
  /** @type {import('../../../docs/spec/contracts/ir').OperationIR[]} */
  const operations = [];
  operations.push({ kind: 'send', channel: 'out', value: lower(sample.expression, operations) });
  for (const delay of sample.delays) {
    operations.push({ kind: 'wait', duration: literal(delay, operations) });
    const tick = lower({ kind: 'read', type: 'number', name: 'tick' }, operations);
    const one = literal(1, operations);
    const value = next++;
    operations.push({
      kind: 'binary',
      result: value,
      type: { kind: 'number' },
      operator: 'add',
      left: tick,
      right: one,
    });
    operations.push({ kind: 'write', resource: 'state', name: 'tick', value });
    operations.push({ kind: 'send', channel: 'out', value: lower(sample.expression, operations) });
  }
  return {
    kind: 'device',
    name: 'GeneratedIR',
    declarations: [
      { kind: 'property', name: 'n', type: { kind: 'number' } },
      { kind: 'property', name: 'm', type: { kind: 'number' } },
      { kind: 'property', name: 'flag', type: { kind: 'bool' } },
      { kind: 'state', name: 'tick', type: { kind: 'number' }, initial: computation(0) },
      {
        kind: 'channel',
        name: 'out',
        direction: 'output',
        type: { kind: sample.expression.type },
        capacity: computation(sample.delays.length + 1),
      },
      { kind: 'start', body: { operations } },
    ],
  };
}

async function execute(adapter, model, sample, sliced) {
  const description = {
    instances: [{ id: 'one', type: 'probe', props: sample.props }],
    nets: [],
  };
  const { board, batches } = await device(adapter, model, {}, description);
  try {
    const end = sample.delays.reduce((sum, delay) => sum + delay, 0) + 1;
    if (sliced) {
      let time = 0;
      board.runUntil(0);
      for (const delay of sample.delays) {
        time += delay;
        board.runUntil(time);
        board.runUntil(time);
      }
    }
    board.runUntil(end);
    assert.equal(board.time, end);
    assert.equal(board.status, 'ready');
    return messages(batches).map(({ time, value }) => ({ time, value }));
  } finally {
    board.dispose();
  }
}

export const domain = {
  name: 'expressions',
  arbitrary(size) {
    return fc
      .constantFrom('number', 'bool')
      .chain((type) =>
        fc.record({
          expression: expressionArbitrary(type, Math.min(size, 7)),
          props: fc.record({ n: number, m: number, flag: fc.boolean() }),
          delays: fc.array(fc.integer({ min: 0, max: 12 }), { maxLength: size }),
        }),
      )
      .map((sample) => JSON.parse(JSON.stringify(sample)));
  },
  async check(adapter, sample) {
    const expected = trace(sample);
    const compiled = await adapter.compileDDL(renderDDL(sample));
    const manual = buildIR(sample);
    const ddl = await execute(adapter, compiled, sample, false);
    const ir = await execute(adapter, manual, sample, false);
    const sliced = await execute(adapter, compiled, sample, true);
    // Equality between two implementations alone is not an oracle.
    assert.deepEqual(ddl, expected, 'DDL versus expression interpreter');
    assert.deepEqual(ir, expected, 'manual IR versus expression interpreter');
    assert.deepEqual(sliced, expected, 'runUntil slicing must preserve this input-free trace');
    assert.deepEqual(ddl, ir, 'DDL versus manual IR');
  },
};
