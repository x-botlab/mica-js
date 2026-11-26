import assert from 'node:assert/strict';
import test from 'node:test';
import { compileResumableBody, proveJitBatch, RESUMABLE_TICKS } from '../dist/index.js';

/**
 * Focused compiler proofs for Issue #313 batch execution. These tests exercise the
 * canonical DDL/JIT IR shapes, the real resumable frame pc, and conservative declines
 * for legal IR that is outside the first-version operation set.
 */

const numberType = Object.freeze({ kind: 'number' });
const boolType = Object.freeze({ kind: 'bool' });
const video = Object.freeze({ kind: 'memory', name: 'video' });
const source = Object.freeze({ kind: 'memory', name: 'source' });
const ram = Object.freeze({ kind: 'memory', name: 'ram' });

let nextResult = 0;
function reset() {
  nextResult = 0;
}

function result(operations, operation, type = numberType) {
  const id = nextResult++;
  operations.push({ ...operation, result: id, type });
  return id;
}
function constant(operations, value) {
  return result(operations, { kind: 'constant', constant: { kind: 'number', value } });
}
/** DDL lowers a negative literal to one unary node over its unsigned literal. */
function numericLiteral(operations, value) {
  return value < 0
    ? unary(operations, 'negate', constant(operations, -value))
    : constant(operations, value);
}
function unary(operations, operator, value) {
  return result(operations, { kind: 'unary', operator, value });
}
function read(operations, name, resource = 'state') {
  return result(operations, { kind: 'read', resource, name });
}
function binary(operations, operator, left, right, type = numberType) {
  return result(operations, { kind: 'binary', operator, left, right }, type);
}
function write(operations, name, value) {
  operations.push({ kind: 'write', resource: 'state', name, value });
}
function store8(operations, memory, offset, value) {
  operations.push({ kind: 'store8', memory, offset, value });
}
function load8(operations, memory, offset) {
  return result(operations, { kind: 'load8', memory, offset });
}
function local(operations, id, initial) {
  operations.push({ kind: 'local', local: id, type: numberType, initial });
}
function localRead(operations, id) {
  return result(operations, { kind: 'localRead', local: id });
}
function localWrite(operations, id, value) {
  operations.push({ kind: 'localWrite', local: id, value });
}
function wait(operations, duration) {
  operations.push({ kind: 'wait', duration });
}
function redirect(operations, target, delay) {
  operations.push({ kind: 'redirect', target, delay });
}
function yieldValue(operations, value) {
  operations.push({ kind: 'yield', value });
}
function send(operations, channel, value) {
  operations.push({ kind: 'send', channel, value });
}

function offset(operations, cursor, base) {
  return base === 0 ? cursor : binary(operations, 'add', cursor, constant(operations, base));
}

function increment(operations, cursor) {
  return binary(operations, 'add', read(operations, cursor), constant(operations, 1));
}

function fillStep(operations, { cursor = 'cursor', base = 0, value = 42, stepPs = 10 } = {}) {
  const current = read(operations, cursor);
  store8(operations, video, offset(operations, current, base), numericLiteral(operations, value));
  write(operations, cursor, increment(operations, cursor));
  wait(operations, constant(operations, stepPs));
}

function advanceStep(operations, { cursor = 'cursor', stepPs = 10 } = {}) {
  write(operations, cursor, increment(operations, cursor));
  wait(operations, constant(operations, stepPs));
}

function inlineCopyStep(
  operations,
  { cursor = 'cursor', sourceBase = 0, destinationBase = 0, stepPs = 10 } = {},
) {
  const current = read(operations, cursor);
  const byte = load8(operations, source, offset(operations, current, sourceBase));
  store8(operations, ram, offset(operations, current, destinationBase), byte);
  write(operations, cursor, increment(operations, cursor));
  wait(operations, constant(operations, stepPs));
}

function localCopyStep(
  operations,
  { cursor = 'cursor', sourceBase = 0, destinationBase = 0, stepPs = 10, localId = 7 } = {},
) {
  const current = read(operations, cursor);
  const byte = load8(operations, source, offset(operations, current, sourceBase));
  local(operations, localId, byte);
  store8(
    operations,
    ram,
    offset(operations, current, destinationBase),
    localRead(operations, localId),
  );
  write(operations, cursor, increment(operations, cursor));
  wait(operations, constant(operations, stepPs));
}

function loopTest(limit, { cursor = 'cursor', operator = 'lessThan' } = {}) {
  const operations = [];
  const left = read(operations, cursor);
  const right = typeof limit === 'string' ? read(operations, limit) : constant(operations, limit);
  yieldValue(operations, binary(operations, operator, left, right, boolType));
  return { type: boolType, body: { operations } };
}

function whileLoop(testRegion, body) {
  return { kind: 'while', test: testRegion, body: { operations: body } };
}

function regionOf(operation, after = []) {
  return { operations: [operation, ...after] };
}

function processHost(initial) {
  const states = new Map(Object.entries(initial));
  const memories = new Map([
    ['video', new Uint8Array(512)],
    ['source', new Uint8Array(512)],
    ['ram', new Uint8Array(512)],
  ]);
  const events = [];
  return {
    states,
    memories,
    events,
    read(kind, name) {
      events.push(['read', kind, name]);
      return states.get(name);
    },
    write(name, value) {
      events.push(['write', name, value]);
      states.set(name, value);
    },
    store(kind, name, offset, value) {
      events.push(['store', kind, name, offset, value]);
      const bytes = memories.get(name) ?? new Uint8Array(512);
      memories.set(name, bytes);
      bytes[offset] = value;
    },
    load(kind, name, offset) {
      events.push(['load', kind, name, offset]);
      return (memories.get(name) ?? new Uint8Array(512))[offset];
    },
    send(channel, value) {
      events.push(['send', channel, value]);
    },
    assert(condition, message) {
      if (condition !== true) throw new Error(String(message));
    },
  };
}

function runProgram(program, host) {
  const frame = {
    pc: program.start,
    slots: new Array(program.slotCount),
    kind: 0,
    duration: 0,
    channel: '',
    value: undefined,
  };
  const pcs = [];
  for (let guard = 0; guard < 1000; guard++) {
    if (!program.run(host, undefined, undefined, frame)) return { frame, pcs };
    pcs.push(frame.pc);
    assert.equal(frame.kind, RESUMABLE_TICKS);
  }
  throw new Error('resumable body did not finish');
}

function assertFillPlan(plan, { value = 42, base = 0 } = {}) {
  assert.ok(plan);
  assert.equal(plan.cursor, 'cursor');
  assert.deepEqual(plan.limit, { kind: 'constant', value: 256 });
  assert.equal(plan.stepPs, 10);
  assert.deepEqual(plan.effect, {
    kind: 'fill',
    destination: 'video',
    destinationBase: base,
    value,
  });
  assert.deepEqual(plan.reads, ['state:cursor']);
  assert.deepEqual(plan.writes, ['state:cursor', 'memory:video']);
}

// ---------------------------------------------------------------------------
// JIT canonical instruction forms

function jitFixture(
  kind = 'fill',
  {
    pc = 0,
    nextPc = 1,
    limit = 256,
    limitState,
    value = 42,
    sourceBase = 0,
    destinationBase = 0,
    target = pc,
    stepPs = 10,
    sharedCursor = true,
    localCopy = false,
  } = {},
) {
  reset();
  const operations = [];
  const cursor = read(operations, 'cursor');
  const bounded =
    limitState !== undefined ? read(operations, limitState) : constant(operations, limit);
  const condition = binary(operations, 'lessThan', cursor, bounded, boolType);
  const yes = [];
  const current = sharedCursor ? cursor : read(yes, 'cursor');
  if (kind === 'fill') {
    store8(yes, video, offset(yes, current, destinationBase), numericLiteral(yes, value));
  } else if (kind === 'copy') {
    const byte = load8(yes, source, offset(yes, current, sourceBase));
    if (localCopy) {
      local(yes, 3, byte);
      store8(yes, ram, offset(yes, current, destinationBase), localRead(yes, 3));
    } else {
      store8(yes, ram, offset(yes, current, destinationBase), byte);
    }
  }
  write(yes, 'cursor', binary(yes, 'add', current, constant(yes, 1)));
  redirect(yes, constant(yes, target), constant(yes, stepPs));
  operations.push({ kind: 'if', condition, yes: { operations: yes } });
  return { pc, nextPc, body: { operations } };
}

test('JIT fill canonical form proves a constant limit and low-byte value', () => {
  reset();
  const instruction = jitFixture('fill', { destinationBase: 8, value: -1 });
  const plan = proveJitBatch(instruction);
  assert.ok(plan);
  assert.equal(plan.cursor, 'cursor');
  assert.deepEqual(plan.limit, { kind: 'constant', value: 256 });
  assert.equal(plan.stepPs, 10);
  assert.deepEqual(plan.effect, {
    kind: 'fill',
    destination: 'video',
    destinationBase: 8,
    value: -1,
  });
  assert.deepEqual(plan.writes, ['state:cursor', 'memory:video']);
});

test('JIT advance and both copy spellings prove', () => {
  reset();
  const advance = proveJitBatch(jitFixture('advance'));
  assert.ok(advance);
  assert.deepEqual(advance.effect, { kind: 'advance' });

  reset();
  const dynamic = proveJitBatch(jitFixture('fill', { limitState: 'bound', pc: -0 }));
  assert.ok(dynamic);
  assert.deepEqual(dynamic.limit, { kind: 'state', name: 'bound' });
  assert.deepEqual(dynamic.reads, ['state:cursor', 'state:bound']);

  reset();
  const inline = proveJitBatch(jitFixture('copy', { sourceBase: 4, destinationBase: 12 }));
  assert.ok(inline);
  assert.deepEqual(inline.effect, {
    kind: 'copy',
    source: 'source',
    sourceBase: 4,
    destination: 'ram',
    destinationBase: 12,
  });
  assert.deepEqual(inline.reads, ['state:cursor', 'memory:source']);
  assert.deepEqual(inline.writes, ['state:cursor', 'memory:ram']);

  reset();
  const spilled = proveJitBatch(jitFixture('copy', { localCopy: true }));
  assert.ok(spilled, 'a loop-local load value stays provable when it never escapes');
  assert.equal(spilled.effect.kind, 'copy');
});

test('JIT declines aliases, wrong order, extra work and non-canonical timing', () => {
  reset();
  assert.equal(
    proveJitBatch(jitFixture('fill', { pc: 0, target: 1 })),
    undefined,
    'redirect target must equal the head pc',
  );

  reset();
  assert.equal(
    proveJitBatch(jitFixture('fill', { pc: -0, target: 0 })),
    undefined,
    'signed zero is observable and target equality is Object.is',
  );
  reset();
  assert.ok(proveJitBatch(jitFixture('fill', { pc: -0, target: -0 })));
  reset();
  assert.ok(
    proveJitBatch(jitFixture('fill', { pc: 0.5, target: 0.5 })),
    'PC arithmetic is finite-number, not integer-only',
  );

  reset();
  assert.equal(proveJitBatch(jitFixture('fill', { pc: 0, nextPc: 0 })), undefined);
  reset();
  assert.equal(proveJitBatch(jitFixture('fill', { pc: 0, nextPc: -0 })), undefined);

  reset();
  const extraPrefix = jitFixture('fill');
  extraPrefix.body.operations.unshift({
    kind: 'constant',
    result: nextResult++,
    type: numberType,
    constant: { kind: 'number', value: 9 },
  });
  assert.equal(proveJitBatch(extraPrefix), undefined, 'unused prefix work is not folded');

  reset();
  const extraTail = jitFixture('fill');
  extraTail.body.operations.push({ kind: 'stop' });
  assert.equal(proveJitBatch(extraTail), undefined, 'no operation may follow the loop head if');

  reset();
  const elseBranch = jitFixture('fill');
  elseBranch.body.operations.at(-1).no = { operations: [] };
  assert.equal(proveJitBatch(elseBranch), undefined, 'the false path falls through to nextPc');

  reset();
  const wrongOrder = jitFixture('fill');
  const yes = wrongOrder.body.operations.at(-1).yes.operations;
  const store = yes.shift();
  yes.unshift(store);
  // Move the cursor write ahead of the store while keeping the same values.
  const writeIndex = yes.findIndex((operation) => operation.kind === 'write');
  yes.unshift(...yes.splice(writeIndex, 1));
  assert.equal(proveJitBatch(wrongOrder), undefined, 'the cursor write stays after the store');

  reset();
  const wrongIncrement = jitFixture('advance');
  const advanceOps = wrongIncrement.body.operations.at(-1).yes.operations;
  const writeOperation = advanceOps.find((operation) => operation.kind === 'write');
  const add = advanceOps.find(
    (operation) =>
      operation.kind === 'binary' &&
      operation.operator === 'add' &&
      operation.result === writeOperation.value,
  );
  const one = advanceOps.find(
    (operation) => operation.kind === 'constant' && operation.result === add.right,
  );
  one.constant.value = 2;
  assert.equal(proveJitBatch(wrongIncrement), undefined);

  reset();
  const derived = jitFixture('fill');
  derived.body.operations[0].resource = 'derived';
  assert.equal(proveJitBatch(derived), undefined);

  reset();
  const parameterMemory = jitFixture('fill');
  const parameterStore = parameterMemory.body.operations
    .at(-1)
    .yes.operations.find((operation) => operation.kind === 'store8');
  parameterStore.memory = {
    kind: 'parameter',
    resource: 'memory',
    index: 0,
  };
  assert.equal(proveJitBatch(parameterMemory), undefined);

  reset();
  const negativeLimit = jitFixture('fill');
  negativeLimit.body.operations[1] = {
    kind: 'unary',
    result: nextResult++,
    type: numberType,
    operator: 'negate',
    value: negativeLimit.body.operations[1].result,
  };
  assert.equal(proveJitBatch(negativeLimit), undefined);

  reset();
  const zeroDelay = jitFixture('fill', { stepPs: 0 });
  assert.equal(proveJitBatch(zeroDelay), undefined);

  reset();
  const wrongComparison = jitFixture('fill');
  const comparison = wrongComparison.body.operations.find(
    (operation) => operation.kind === 'binary' && operation.operator === 'lessThan',
  );
  comparison.operator = 'greaterThan';
  assert.equal(proveJitBatch(wrongComparison), undefined);

  reset();
  const duplicateResult = jitFixture('fill');
  duplicateResult.body.operations[1].result = duplicateResult.body.operations[0].result;
  assert.equal(proveJitBatch(duplicateResult), undefined);
});

// ---------------------------------------------------------------------------
// Process resumable opt-in

function processFillRegion(options = {}) {
  reset();
  const body = [];
  fillStep(body, options);
  const loop = whileLoop(loopTest(256, options), body);
  const after = [];
  if (options.afterSend) send(after, 'done', read(after, 'cursor'));
  return regionOf(loop, after);
}

test('ordinary resumable compilation keeps the batch artifact absent', () => {
  const region = processFillRegion();
  const ordinary = compileResumableBody(region);
  assert.ok(ordinary);
  assert.equal(Object.hasOwn(ordinary, 'batchLoops'), false);
});

test('opt-in process fill exposes the real ticks resume block', () => {
  const region = processFillRegion();
  const program = compileResumableBody(region, {
    bindResources: true,
    batchLoops: true,
  });
  assert.ok(program);
  assert.ok(Array.isArray(program.batchLoops));
  assert.equal(program.batchLoops.length, 1);
  const plan = program.batchLoops[0];
  assertFillPlan(plan);
  assert.ok(Number.isSafeInteger(plan.resumeBlock));
  assert.match(program.run.toString(), new RegExp(`case ${plan.resumeBlock}:`));

  const runnable = compileResumableBody(region, { batchLoops: true });
  assert.ok(runnable);
  const planForRun = runnable.batchLoops[0];
  assert.ok(planForRun);
  const host = processHost({ cursor: 0 });
  const { frame } = runProgram(runnable, host);
  assert.equal(frame.pc, 0);
  assert.deepEqual(host.states.get('cursor'), 256);
  // One test read per iteration plus the final failing test, and two body reads.
  assert.equal(host.events.filter((entry) => entry[0] === 'read').length, 256 * 3 + 1);
  // The first suspension is the proven tail suspension.
  const firstHost = processHost({ cursor: 0 });
  const first = {
    pc: runnable.start,
    slots: new Array(runnable.slotCount),
    kind: 0,
    duration: 0,
    channel: '',
    value: undefined,
  };
  assert.equal(runnable.run(firstHost, undefined, undefined, first), true);
  assert.equal(first.pc, planForRun.resumeBlock);
});

test('process advance and copy forms prove and preserve frame spills', () => {
  reset();
  const advanceBody = [];
  advanceStep(advanceBody);
  const advanceLoop = whileLoop(loopTest(10), advanceBody);
  const prefix = [];
  const initial = constant(prefix, 5);
  prefix.push({ kind: 'local', local: 0, type: numberType, initial });
  const spillAfter = [];
  send(spillAfter, 'done', localRead(spillAfter, 0));
  const advanceRegion = { operations: [...prefix, advanceLoop, ...spillAfter] };
  const advance = compileResumableBody(advanceRegion, { batchLoops: true });
  assert.ok(advance);
  const advancePlan = advance.batchLoops[0];
  assert.ok(advancePlan);
  assert.deepEqual(advancePlan.effect, { kind: 'advance' });
  assert.deepEqual(advancePlan.writes, ['state:cursor']);
  const advanceHost = processHost({ cursor: 0 });
  const { pcs } = runProgram(advance, advanceHost);
  assert.equal(pcs[0], advancePlan.resumeBlock);
  assert.deepEqual(advanceHost.events.at(-1), ['send', 'done', 5]);

  reset();
  const inlineBody = [];
  inlineCopyStep(inlineBody, { sourceBase: 2, destinationBase: 7 });
  const inline = compileResumableBody(regionOf(whileLoop(loopTest(4), inlineBody)), {
    batchLoops: true,
  });
  assert.ok(inline);
  assert.deepEqual(inline.batchLoops[0].effect, {
    kind: 'copy',
    source: 'source',
    sourceBase: 2,
    destination: 'ram',
    destinationBase: 7,
  });

  reset();
  const localBody = [];
  localCopyStep(localBody, { sourceBase: 1, destinationBase: 3, localId: 11 });
  const local = compileResumableBody(regionOf(whileLoop(loopTest(4), localBody)), {
    batchLoops: true,
  });
  assert.ok(local);
  assert.equal(local.batchLoops[0].effect.kind, 'copy');

  reset();
  const negativeBody = [];
  fillStep(negativeBody, { value: -1 });
  const negative = compileResumableBody(regionOf(whileLoop(loopTest(4), negativeBody)), {
    batchLoops: true,
  });
  assert.ok(negative);
  assert.deepEqual(negative.batchLoops[0].effect, {
    kind: 'fill',
    destination: 'video',
    destinationBase: 0,
    value: -1,
  });
});

test('a loop-local value that escapes the body declines', () => {
  reset();
  const body = [];
  localCopyStep(body, { localId: 13 });
  const after = [];
  // Legal IR shape, but the same local id is read after the loop.
  send(after, 'leak', localRead(after, 13));
  const program = compileResumableBody(regionOf(whileLoop(loopTest(4), body), after), {
    batchLoops: true,
  });
  assert.ok(program);
  assert.equal(program.batchLoops[0], undefined);
});

test('top-level while ordinals ignore nested loops and keep source order', () => {
  reset();
  const innerBody = [];
  fillStep(innerBody);
  const inner = whileLoop(loopTest(3), innerBody);
  const outer = whileLoop(loopTest(3), [inner]);
  const secondBody = [];
  advanceStep(secondBody);
  const second = whileLoop(loopTest(2), secondBody);
  const program = compileResumableBody({ operations: [outer, second] }, { batchLoops: true });
  assert.ok(program);
  assert.equal(program.batchLoops.length, 2);
  assert.equal(program.batchLoops[0], undefined, 'a nested loop is not a top-level ordinal');
  assert.ok(program.batchLoops[1]);
  assert.deepEqual(program.batchLoops[1].effect, { kind: 'advance' });
});

test('legal but unsupported process shapes decline without losing the machine', () => {
  const declines = [
    (body) => {
      const extra = [];
      write(extra, 'other', constant(extra, 1));
      body.unshift(...extra);
    },
    (body) => {
      // Store and cursor write swapped.
      const store = body.shift();
      const writeIndex = body.findIndex((operation) => operation.kind === 'write');
      body.splice(writeIndex + 1, 0, store);
    },
    (body) => {
      const next = body.find((operation) => operation.kind === 'write');
      next.value = binary(body, 'add', read(body, 'cursor'), constant(body, 2));
    },
    (body) => {
      body.push({ kind: 'break' });
    },
    (body) => {
      body.splice(1, 0, {
        kind: 'constant',
        result: nextResult++,
        type: numberType,
        constant: { kind: 'number', value: 99 },
      });
    },
  ];
  for (const mutate of declines) {
    reset();
    const body = [];
    fillStep(body);
    mutate(body);
    const program = compileResumableBody(regionOf(whileLoop(loopTest(256), body)), {
      batchLoops: true,
    });
    assert.ok(program, 'the shape stays resumable');
    assert.equal(program.batchLoops[0], undefined);
  }

  reset();
  const negativeLimit = compileResumableBody(regionOf(whileLoop(loopTest(-1), [])), {
    batchLoops: true,
  });
  assert.ok(negativeLimit);
  assert.equal(negativeLimit.batchLoops[0], undefined);

  reset();
  const fractionalStepBody = [];
  const cursor = read(fractionalStepBody, 'cursor');
  store8(fractionalStepBody, video, cursor, constant(fractionalStepBody, 42));
  write(
    fractionalStepBody,
    'cursor',
    binary(
      fractionalStepBody,
      'add',
      read(fractionalStepBody, 'cursor'),
      constant(fractionalStepBody, 1),
    ),
  );
  wait(fractionalStepBody, constant(fractionalStepBody, 1.5));
  const fractional = compileResumableBody(regionOf(whileLoop(loopTest(256), fractionalStepBody)), {
    batchLoops: true,
  });
  assert.ok(fractional);
  assert.equal(fractional.batchLoops[0], undefined);
});

test('multiple proven top-level loops carry distinct actual resume blocks', () => {
  reset();
  const fillBody = [];
  fillStep(fillBody);
  const advanceBody = [];
  advanceStep(advanceBody);
  const program = compileResumableBody(
    {
      operations: [whileLoop(loopTest(256), fillBody), whileLoop(loopTest(3), advanceBody)],
    },
    { batchLoops: true },
  );
  assert.ok(program);
  assert.equal(program.batchLoops.length, 2);
  const [fill, advance] = program.batchLoops;
  assert.ok(fill);
  assert.ok(advance);
  assert.notEqual(fill.resumeBlock, advance.resumeBlock);
  assert.match(program.run.toString(), new RegExp(`case ${fill.resumeBlock}:`));
  assert.match(program.run.toString(), new RegExp(`case ${advance.resumeBlock}:`));
});
