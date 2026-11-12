import assert from 'node:assert/strict';
import test from 'node:test';
import { profileInstructions } from './profile.mjs';

const model = {
  declarations: ['pc', 'x', 'primask', 'ipsr'].map((name) => ({
    kind: 'state',
    name,
    type: { kind: 'number' },
  })),
};
const constant = (result, value) => ({
  kind: 'constant',
  result,
  type: { kind: 'number' },
  constant: { kind: 'number', value },
});
const instruction = (pc, name) => ({
  pc,
  nextPc: pc + 2,
  body: {
    operations: [
      constant(0, 1),
      { kind: 'write', name, value: 0 },
      { kind: 'elapse', duration: 0 },
    ],
  },
});

test('STM32 offline profile counts original IR and IRQ write barriers separately', () => {
  const profile = profileInstructions([instruction(0, 'x'), instruction(2, 'primask')], model);
  assert.equal(profile.translatedInstructions, 2);
  assert.equal(profile.directInstructions, 1);
  assert.equal(profile.directCoverage, 0.5);
  assert.equal(profile.operations, 6);
  assert.deepEqual(profile.byKind, { constant: 2, write: 2, elapse: 2 });
  assert.ok(profile.sourceCharacters > 0);
  assert.equal(profile.capturedLoads, 0, 'safe integer constants are literal source');

  assert.deepEqual(profile.instructions[1].blockedStateWrites, ['primask']);
  assert.equal(profile.excludedInstructions, 1);
  assert.deepEqual(profile.excludedStateWrites, { primask: 1 });
  assert.deepEqual(profile.excludedByKind, { constant: 1, write: 1, elapse: 1 });
  assert.match(profile.scope, /not runtime fallback rate/);
});

test('STM32 offline profile handles an empty cold cache', () => {
  const profile = profileInstructions([], model);
  assert.equal(profile.operations, 0);
  assert.equal(profile.directCoverage, 0);
  assert.equal(profile.sourceCharacters, 0);
  assert.deepEqual(profile.instructions, []);
});
