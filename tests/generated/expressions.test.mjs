import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fc from 'fast-check';
import { buildIR, domain, renderDDL } from './domains/expressions.mjs';
import { evaluate, trace } from './oracles/expressions.mjs';

const number = (value) => ({ kind: 'literal', type: 'number', value });
const boolean = (value) => ({ kind: 'literal', type: 'bool', value });
const binary = (operator, left, right, type = 'number') => ({
  kind: 'binary',
  type,
  operator,
  left,
  right,
});

for (const [operator, left, right, expected] of [
  ['%', -5, 3, -2],
  ['/', 1, 0, Infinity],
  ['/', 0, 0, NaN],
  ['*', 0, -1, -0],
  ['**', -2, 3, -8],
  ['>>>', -1, 0, 4294967295],
  ['<<', 1, 33, 2],
  ['>>', -3, 1, -2],
  ['&', 4294967295, 3, 3],
  ['|', 0.5, 1, 1],
]) {
  test(`expression oracle ${left} ${operator} ${right}`, () => {
    assert.equal(evaluate(binary(operator, number(left), number(right)), {}), expected);
  });
}

test('numeric equality distinguishes NaN from itself but equates signed zero', () => {
  assert.equal(evaluate(binary('==', number(NaN), number(NaN), 'bool'), {}), false);
  assert.equal(evaluate(binary('==', number(0), number(-0), 'bool'), {}), true);
});

test('interpreter does not visit unselected subtrees', () => {
  const unreachable = { kind: 'unreachable' };
  assert.equal(evaluate(binary('&&', boolean(false), unreachable, 'bool'), {}), false);
  assert.equal(evaluate(binary('||', boolean(true), unreachable, 'bool'), {}), true);
  assert.equal(
    evaluate({ kind: 'select', condition: boolean(true), yes: number(7), no: unreachable }, {}),
    7,
  );
});

test('reference process accounts for zero waits, state updates and message time', () => {
  assert.deepEqual(
    trace({
      expression: { kind: 'read', type: 'number', name: 'tick' },
      props: {},
      delays: [0, 3, 0, 2],
    }),
    [
      { time: 0, value: 0 },
      { time: 0, value: 1 },
      { time: 3, value: 2 },
      { time: 3, value: 3 },
      { time: 5, value: 4 },
    ],
  );
});

function checkType(node) {
  assert.ok(['number', 'bool'].includes(node.type));
  if (node.kind === 'literal') {
    assert.equal(typeof node.value, node.type === 'bool' ? 'boolean' : 'number');
  } else if (node.kind === 'read') {
    assert.ok((node.type === 'bool' ? ['flag'] : ['n', 'm', 'tick']).includes(node.name));
  } else if (node.kind === 'unary') {
    assert.equal(checkType(node.value), node.type);
    assert.ok((node.type === 'bool' ? ['!'] : ['+', '-', '~']).includes(node.operator));
  } else if (node.kind === 'select') {
    assert.equal(checkType(node.condition), 'bool');
    assert.equal(checkType(node.yes), node.type);
    assert.equal(checkType(node.no), node.type);
  } else if (node.kind === 'binary') {
    const left = checkType(node.left);
    assert.equal(checkType(node.right), left);
    if (node.operator === '&&' || node.operator === '||') {
      assert.equal(left, 'bool');
      assert.equal(node.type, 'bool');
    } else if (['==', '!='].includes(node.operator)) {
      assert.equal(node.type, 'bool');
    } else if (['<', '<=', '>', '>='].includes(node.operator)) {
      assert.equal(left, 'number');
      assert.equal(node.type, 'bool');
    } else {
      assert.equal(left, 'number');
      assert.equal(node.type, 'number');
    }
  } else assert.fail(`Unknown node: ${node.kind}`);
  return node.type;
}

test('typed productions and shrinking retain serializable, well-typed samples', () => {
  const arbitrary = domain.arbitrary(5);
  fc.assert(
    fc.property(arbitrary, (sample) => {
      checkType(sample.expression);
      assert.deepEqual(JSON.parse(JSON.stringify(sample)), sample);
      assert.equal(
        typeof evaluate(sample.expression, { ...sample.props, tick: 0 }),
        sample.expression.type === 'bool' ? 'boolean' : 'number',
      );
      const ir = buildIR(sample);
      assert.equal(ir.declarations.at(-1).kind, 'start');
      assert.equal(ir.declarations.at(-2).type.kind, sample.expression.type);
      assert.ok(renderDDL(sample).includes(`out: ${sample.expression.type}`));
    }),
    { seed: 1296646977, numRuns: 300 },
  );
  const result = fc.check(
    fc.property(arbitrary, (sample) => {
      checkType(sample.expression);
      return false;
    }),
    { seed: 1296646977, numRuns: 1 },
  );
  assert.equal(result.failed, true);
  assert.ok(result.numShrinks > 0);
  checkType(result.counterexample[0].expression);
});

test('IR uses lazy regions rather than eager binary operations for logical expressions', () => {
  const model = buildIR({
    expression: binary('&&', boolean(false), boolean(true), 'bool'),
    props: { n: 1, m: 2, flag: false },
    delays: [],
  });
  const operations = model.declarations.at(-1).body.operations;
  assert.deepEqual(
    operations.map((op) => op.kind),
    ['constant', 'and', 'send'],
  );
  assert.equal(operations[1].right.body.operations.at(-1).kind, 'yield');
});
