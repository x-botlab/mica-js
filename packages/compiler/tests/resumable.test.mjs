import assert from 'node:assert/strict';
import test from 'node:test';
import { compileBody, compileResumableBody, RESUMABLE_TICKS } from '../dist/index.js';

/**
 * Differential tests for suspension-aware fusion: a control-flow subtree without a
 * suspension point stays inside one machine block and must produce exactly the generator
 * body's host operations, in the same order. Guarded `break`/`continue` and `return`
 * keep their blocks, so the block count shows which form was taken.
 */

let nextResultId = 0;
const numberType = Object.freeze({ kind: 'number' });
const booleanType = Object.freeze({ kind: 'bool' });
const comparisons = new Set([
  'lessThan',
  'lessThanOrEqual',
  'greaterThan',
  'greaterThanOrEqual',
  'equal',
  'notEqual',
]);

function builder(operations) {
  const value = (operation, type = numberType) => {
    const result = nextResultId++;
    operations.push({ ...operation, result, type });
    return result;
  };
  const statement = (operation) => operations.push(operation);
  return {
    constant: (literal) =>
      typeof literal === 'boolean'
        ? value({ kind: 'constant', constant: { kind: 'bool', value: literal } }, booleanType)
        : value({ kind: 'constant', constant: { kind: 'number', value: literal } }),
    read: (name) => value({ kind: 'read', resource: 'state', name }),
    binary: (operator, left, right) =>
      value(
        { kind: 'binary', operator, left, right },
        comparisons.has(operator) ? booleanType : numberType,
      ),
    localRead: (id) => value({ kind: 'localRead', local: id }),
    local: (id, initial) => statement({ kind: 'local', local: id, type: numberType, initial }),
    localWrite: (id, input) => statement({ kind: 'localWrite', local: id, value: input }),
    write: (name, input) => statement({ kind: 'write', resource: 'state', name, value: input }),
    send: (channel, input) => statement({ kind: 'send', channel, value: input }),
    wait: (duration) => statement({ kind: 'wait', duration }),
    break: () => statement({ kind: 'break' }),
    continue: () => statement({ kind: 'continue' }),
    return: () => statement({ kind: 'return' }),
    if: (condition, yes, no) =>
      statement({
        kind: 'if',
        condition,
        yes: { operations: nested(yes) },
        ...(no ? { no: { operations: nested(no) } } : {}),
      }),
    loop: (body) => statement({ kind: 'loop', body: { operations: nested(body) } }),
    while: (test, body) => {
      const testOperations = [];
      const condition = test(builder(testOperations));
      testOperations.push({ kind: 'yield', value: condition });
      return statement({
        kind: 'while',
        test: { type: booleanType, body: { operations: testOperations } },
        body: { operations: nested(body) },
      });
    },
    match: (input, arms, otherwise) =>
      statement({
        kind: 'match',
        value: input,
        arms: arms.map(([pattern, arm]) => ({ pattern, body: { operations: nested(arm) } })),
        ...(otherwise ? { otherwise: { operations: nested(otherwise) } } : {}),
      }),
  };
}

function nested(callback) {
  const operations = [];
  callback(builder(operations));
  return operations;
}

function host(initial) {
  const states = new Map(Object.entries(initial));
  const events = [];
  return {
    states,
    events,
    read(kind, name) {
      events.push(['read', kind, name]);
      return states.get(name);
    },
    write(name, input) {
      events.push(['write', name, input]);
      states.set(name, input);
    },
    send(channel, input) {
      events.push(['send', channel, input]);
    },
    assert(condition, message) {
      events.push(['assert', condition, message]);
      if (condition !== true) throw new Error(message === undefined ? 'assert' : String(message));
    },
  };
}

function runGenerator(body, executionHost) {
  const iterator = body(executionHost);
  for (let guard = 0; guard < 1000; guard++) {
    const step = iterator.next();
    if (step.done) return;
    assert.equal(step.value.kind, 'ticks');
  }
  throw new Error('generator body did not finish');
}

function runResumable(program, executionHost) {
  const frame = {
    pc: program.start,
    slots: new Array(program.slotCount),
    kind: 0,
    duration: 0,
    channel: '',
    value: undefined,
  };
  for (let guard = 0; guard < 1000; guard++) {
    if (!program.run(executionHost, undefined, undefined, frame)) return;
    assert.equal(frame.kind, RESUMABLE_TICKS);
  }
  throw new Error('resumable body did not finish');
}

/** Runs both forms on the same body and returns the admitted resumable program. */
function differential(body, initial = {}) {
  const region = { operations: nested(body) };
  const generic = host(initial);
  runGenerator(compileBody(region), generic);
  const program = compileResumableBody(region);
  assert.ok(program, 'the body stays admitted');
  const fused = host(initial);
  runResumable(program, fused);
  assert.deepEqual(fused.events, generic.events, 'same host operations in the same order');
  assert.deepEqual([...fused.states], [...generic.states], 'same final state');
  return program;
}

function controlFlow(extra) {
  return (b) => {
    b.local(0, b.constant(0));
    b.if(
      b.read('flag'),
      (yes) => yes.write('a', yes.constant(1)),
      (no) => no.write('a', no.constant(2)),
    );
    b.match(
      b.read('code'),
      [[{ kind: 'number', value: 1 }, (arm) => arm.send('out', arm.constant(10))]],
      (otherwise) => otherwise.send('out', otherwise.constant(20)),
    );
    b.loop((body) => {
      body.localWrite(0, body.binary('add', body.localRead(0), body.constant(1)));
      extra(body);
      body.break();
    });
    b.while(
      (condition) => condition.binary('lessThan', condition.localRead(0), condition.constant(4)),
      (body) => {
        body.localWrite(0, body.binary('add', body.localRead(0), body.constant(1)));
        body.continue();
      },
    );
    b.send('out', b.localRead(0));
  };
}

test('suspension-free if, match and loops stay in one block', () => {
  const finish = (b) => {
    b.wait(b.constant(5));
    b.send('out', b.constant(99));
  };
  const fused = differential(
    (b) => {
      controlFlow(() => {})(b);
      finish(b);
    },
    { flag: true, code: 1, a: 0 },
  );
  const blocked = differential(
    (b) => {
      controlFlow((body) => body.wait(body.constant(1)))(b);
      finish(b);
    },
    { flag: true, code: 1, a: 0 },
  );
  assert.ok(fused.blocks < blocked.blocks, 'fused control flow needs fewer blocks');
});

test('nested fused loops send an inner break to the inner loop only', () => {
  const program = differential((b) => {
    b.local(0, b.constant(0));
    b.loop((outer) => {
      outer.loop((inner) => {
        inner.localWrite(0, inner.binary('add', inner.localRead(0), inner.constant(10)));
        inner.break();
      });
      outer.localWrite(0, outer.binary('add', outer.localRead(0), outer.constant(1)));
      outer.break();
    });
    b.send('out', b.localRead(0));
  });
  const probe = host({});
  runResumable(program, probe);
  assert.deepEqual(probe.events.at(-1), ['send', 'out', 11]);
});

test('a break or continue under an if keeps the whole loop in blocks', () => {
  const fused = differential((b) => {
    b.local(0, b.constant(0));
    b.while(
      (condition) => condition.binary('lessThan', condition.localRead(0), condition.constant(3)),
      (body) => {
        body.localWrite(0, body.binary('add', body.localRead(0), body.constant(1)));
        body.continue();
      },
    );
    b.send('out', b.localRead(0));
  });
  const guarded = differential((b) => {
    b.local(0, b.constant(0));
    b.while(
      (condition) => condition.binary('lessThan', condition.localRead(0), condition.constant(3)),
      (body) => {
        body.localWrite(0, body.binary('add', body.localRead(0), body.constant(1)));
        body.if(body.binary('lessThan', body.localRead(0), body.constant(2)), (yes) =>
          yes.continue(),
        );
      },
    );
    b.send('out', b.localRead(0));
  });
  assert.ok(fused.blocks < guarded.blocks, 'a guarded continue prevents fusion');
});

test('a return under an if keeps the branch and the done block in place', () => {
  const shared = (yes) => (b) => {
    b.if(b.read('flag'), yes);
    b.send('out', b.constant(2));
  };
  const fused = differential(
    (b) => {
      shared((branch) => branch.write('a', branch.constant(1)))(b);
      b.wait(b.constant(1));
    },
    { flag: true, a: 0 },
  );
  const returned = differential(
    (b) => {
      shared((branch) => {
        branch.write('a', branch.constant(1));
        branch.return();
      })(b);
      b.wait(b.constant(1));
    },
    { flag: true, a: 0 },
  );
  assert.ok(fused.blocks < returned.blocks, 'a return prevents fusion');
});

test('blocks counts the generated cases', () => {
  const program = differential((b) => {
    b.send('out', b.constant(1));
    b.wait(b.constant(2));
    b.send('out', b.constant(3));
  });
  const cases = program.run.toString().match(/^case \d+:/gm) ?? [];
  assert.equal(program.blocks, cases.length);
});

test('a suspension inside a match arm keeps the match in blocks', () => {
  const program = differential(
    (b) => {
      b.match(
        b.read('code'),
        [
          [
            { kind: 'number', value: 1 },
            (arm) => {
              arm.send('out', arm.constant(1));
              arm.wait(arm.constant(1));
            },
          ],
        ],
        (otherwise) => otherwise.send('out', otherwise.constant(2)),
      );
      b.send('out', b.constant(3));
    },
    { code: 1 },
  );
  assert.ok(program.blocks > 4, 'the match arms own blocks');
});
