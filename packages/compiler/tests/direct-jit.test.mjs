import assert from 'node:assert/strict';
import test from 'node:test';
import { compileBody, compileDirectJit } from '../dist/index.js';

const stateNames = ['pc', 'x', 'y', 'flag', 'offset', 'marker'];
const binding = {
  states: new Map(stateNames.map((name, index) => [name, index])),
  memories: new Map([['ram', 0]]),
  pc: { name: 'pc', index: 0 },
};
const ram = { kind: 'memory', name: 'ram' };

function builder() {
  let serial = 0;
  const operations = [];
  const value = (operation, type = 'number', target = operations) => {
    const result = serial++;
    target.push({ ...operation, result, type: { kind: type } });
    return result;
  };
  return {
    operations,
    value,
    constant: (literal) =>
      value(
        {
          kind: 'constant',
          constant: {
            kind: typeof literal === 'boolean' ? 'bool' : 'number',
            value: literal,
          },
        },
        typeof literal === 'boolean' ? 'bool' : 'number',
      ),
    read: (name, type = 'number') => value({ kind: 'read', resource: 'state', name }, type),
    binary: (operator, left, right, type = 'number') =>
      value({ kind: 'binary', operator, left, right }, type),
    write: (name, result) => operations.push({ kind: 'write', name, value: result }),
    delay(duration) {
      const result = this.constant(duration);
      operations.push({ kind: 'elapse', duration: result });
    },
    instruction(pc, nextPc) {
      return { pc, nextPc, body: { operations } };
    },
  };
}

function frame(program, states = [0, 1, 0, true, 0, 0], memory = [7, 8, 9]) {
  return {
    states: [...states],
    memories: [Uint8Array.from(memory)],
    stateDirty: new Array(Math.ceil(states.length / 32)).fill(0),
    memoryDirty: [0],
    time: 0,
    due: 0,
    resume: 0,
    locals: new Array(program.localCount),
  };
}

function generic(instructions, states, memories) {
  const lookup = new Map();
  for (const instruction of instructions)
    if (!lookup.has(instruction.pc)) lookup.set(instruction.pc, instruction);
  const machine = {
    states: [...states],
    memories: memories.map((bytes) => bytes.slice()),
    time: 0,
  };
  const host = {
    read: (_resource, name) => machine.states[binding.states.get(name)],
    write: (name, value) => {
      machine.states[binding.states.get(name)] = value;
    },
    load: (_kind, _memory, offset) => {
      assert(Number.isSafeInteger(offset) && offset >= 0 && offset < machine.memories[0].length);
      return machine.memories[0][offset];
    },
    store: (_kind, _memory, offset, value) => {
      machine.memories[0][offset] = value;
    },
  };
  let active;
  let due;
  machine.run = (deadline) => {
    while (machine.time < deadline) {
      if (due !== undefined) {
        if (due >= deadline) {
          machine.time = deadline;
          return 'deadline';
        }
        machine.time = due;
        due = undefined;
      }
      if (!active) {
        const instruction = lookup.get(machine.states[0]);
        if (!instruction) return 'fallback';
        machine.states[0] = instruction.nextPc;
        active = compileBody(instruction.body)(host);
      }
      const step = active.next();
      if (step.done) {
        active = undefined;
        continue;
      }
      const signal = step.value;
      if (signal.kind === 'elapse') due = machine.time + signal.duration;
      else if (signal.kind === 'redirect') {
        machine.states[0] = signal.pc;
        due = machine.time + signal.delay;
        active.return();
        active = undefined;
      } else if (signal.kind === 'stop') {
        active.return();
        return 'stopped';
      } else throw new Error(`Unexpected signal ${signal.kind}`);
    }
    return 'deadline';
  };
  return machine;
}

function scalarLoop() {
  const alu = builder();
  const x = alu.read('x');
  const sum = alu.binary('add', x, alu.constant(1));
  alu.write('x', sum);
  alu.delay(2);
  alu.write('y', alu.binary('multiply', sum, alu.constant(2)));
  const memory = builder();
  const offset = memory.constant(0);
  memory.operations.push({ kind: 'store8', memory: ram, offset, value: memory.read('x') });
  const loaded = memory.value({ kind: 'load8', memory: ram, offset });
  memory.delay(3);
  memory.write('x', loaded);
  return [alu.instruction(0, 2), memory.instruction(2, 0)];
}

test('whole cached-PC loop matches compileBody and segment/monolithic execution', () => {
  const instructions = scalarLoop();
  const program = compileDirectJit(instructions, binding);
  assert(program);
  const whole = frame(program);
  const sliced = frame(program);
  const reference = generic(instructions, whole.states, whole.memories);
  assert.equal(program.run(whole, 39), 'deadline');
  for (const deadline of [0, 1, 2, 3, 5, 8, 13, 21, 39]) {
    assert.equal(program.run(sliced, deadline), reference.run(deadline));
    assert.deepEqual(sliced.states, reference.states);
    assert.deepEqual(sliced.memories, reference.memories);
    assert.equal(sliced.time, reference.time);
  }
  assert.deepEqual(sliced.states, whole.states);
  assert.deepEqual(sliced.memories, whole.memories);
  assert.equal(sliced.resume, whole.resume);
  assert.equal(sliced.due, whole.due);
});

test('deadline equality neither starts nor resumes the captured-load suffix', () => {
  const b = builder();
  b.write('marker', b.constant(17));
  const loaded = b.value({ kind: 'load8', memory: ram, offset: b.read('offset') });
  b.delay(10);
  b.write('x', loaded);
  const program = compileDirectJit([b.instruction(0, 99)], binding);
  const f = frame(program);
  assert.equal(program.run(f, 0), 'deadline');
  assert.equal(f.states[0], 0);
  assert.deepEqual(f.stateDirty, [0]);
  assert.equal(program.run(f, 4), 'deadline');
  assert.equal(f.states[0], 99);
  assert.equal(f.due, 10);
  assert.deepEqual(f.stateDirty, [(1 << 0) | (1 << 5)]);
  assert.deepEqual(f.memoryDirty, [0]);
  const continuation = f.resume;
  f.stateDirty.fill(0);
  f.memoryDirty.fill(0);
  f.memories[0][0] = 200;
  f.states[4] = 2;
  f.states[5] = 99;
  assert.equal(program.run(f, 10), 'deadline');
  assert.equal(f.states[1], 1);
  assert.equal(f.resume, continuation);
  assert.deepEqual(f.stateDirty, [0]);
  assert.deepEqual(f.memoryDirty, [0]);
  assert.equal(program.run(f, 11), 'fallback');
  assert.equal(f.states[1], 7);
  assert.equal(f.states[5], 99);
  assert.equal(f.time, 10);
  assert.equal(f.resume, 0);
  assert.deepEqual(f.stateDirty, [1 << 1]);
  assert.deepEqual(f.memoryDirty, [0]);
});

test('PC nextPc is visible to prefix reads before any elapse', () => {
  const b = builder();
  b.write('x', b.read('pc'));
  b.delay(2);
  const program = compileDirectJit([b.instruction(0, 12)], binding);
  const f = frame(program);
  program.run(f, 1);
  assert.equal(f.states[1], 12);
  assert.equal(f.states[0], 12);
});

test('scalar select with nested if/yield and dynamic redirect matches generic', () => {
  const b = builder();
  const condition = b.read('flag', 'bool');
  const yes = [];
  const busy = b.value({ kind: 'constant', constant: { kind: 'number', value: 2 } }, 'number', yes);
  const idle = b.constant(9);
  yes.push({
    kind: 'if',
    condition,
    yes: { operations: [{ kind: 'yield', value: busy }] },
    no: { operations: [{ kind: 'yield', value: idle }] },
  });
  const no = [];
  const target = b.value({ kind: 'read', resource: 'state', name: 'y' }, 'number', no);
  no.push({ kind: 'yield', value: target });
  const selected = b.value({
    kind: 'select',
    condition,
    yes: { type: { kind: 'number' }, body: { operations: yes } },
    no: { type: { kind: 'number' }, body: { operations: no } },
  });
  const delay = b.constant(3);
  b.operations.push({ kind: 'redirect', target: selected, delay });
  const instructions = [b.instruction(0, 1)];
  const program = compileDirectJit(instructions, binding);
  for (const condition of [true, false]) {
    const f = frame(program, [0, 0, 42, condition, 0, 0]);
    const reference = generic(instructions, f.states, f.memories);
    for (const deadline of [1, 3, 4]) {
      assert.equal(program.run(f, deadline), reference.run(deadline));
      assert.deepEqual(f.states, reference.states);
      assert.equal(f.time, reference.time);
    }
    assert.equal(f.states[0], condition ? 2 : 42);
  }
  assert(program.readStates.includes('y'));
});

test('pending continuation tolerates nonfinite PC until suffix repair or runtime handoff', () => {
  for (const repairSuffix of [true, false]) {
    const b = builder();
    b.delay(5);
    b.write('marker', b.constant(17));
    if (repairSuffix) b.write('pc', b.constant(99));
    const program = compileDirectJit([b.instruction(0, 1)], binding);
    for (const externalPc of [NaN, Infinity, -Infinity]) {
      const f = frame(program);
      assert.equal(program.run(f, 2), 'deadline');
      f.stateDirty.fill(0);
      f.states[0] = externalPc;
      f.stopAfterInstruction = !repairSuffix;
      assert.equal(program.run(f, 5), 'deadline');
      assert.notEqual(f.resume, 0);
      assert.equal(f.states[5], 0);
      assert.deepEqual(f.stateDirty, [0]);
      assert.equal(program.run(f, 6), repairSuffix ? 'fallback' : 'invalidated');
      assert.equal(f.resume, 0);
      assert.equal(f.time, 5);
      assert.equal(f.states[5], 17);
      assert.equal(f.states[0], repairSuffix ? 99 : externalPc);
      assert.deepEqual(f.stateDirty, [(1 << 5) | (repairSuffix ? 1 : 0)]);
      assert.deepEqual(f.memoryDirty, [0]);
      if (!repairSuffix) {
        f.states[0] = 99;
        f.stopAfterInstruction = false;
        f.stateDirty.fill(0);
        assert.equal(program.run(f, 7), 'fallback');
        assert.deepEqual(f.stateDirty, [0]);
      }
    }
  }
});

test('invalidated pending suffix finishes once and cannot start the next PC', () => {
  const instructions = scalarLoop();
  const program = compileDirectJit(instructions, binding);
  const f = frame(program);
  program.run(f, 1);
  f.stopAfterInstruction = true;
  assert.equal(program.run(f, 2), 'deadline');
  assert.equal(f.resume > 0, true);
  assert.equal(program.run(f, 100), 'invalidated');
  assert.equal(f.time, 2);
  assert.equal(f.states[2], 4);
  assert.equal(f.states[0], 2);
  assert.equal(f.memories[0][0], 7);
  assert.equal(f.resume, 0);
  assert.equal(program.run(f, 101), 'invalidated');
  assert.equal(f.time, 2);
});

test('invalidated idle frame exits without instruction effects', () => {
  const program = compileDirectJit(scalarLoop(), binding);
  const f = frame(program);
  f.stopAfterInstruction = true;
  assert.equal(program.run(f, 100), 'invalidated');
  assert.deepEqual(f.states, [0, 1, 0, true, 0, 0]);
});

test('pending redirect finishes before invalidation exit without executing its target', () => {
  const b = builder();
  const target = b.read('x');
  const delay = b.constant(5);
  b.operations.push({ kind: 'redirect', target, delay });
  const program = compileDirectJit([b.instruction(0, 88)], binding);
  const f = frame(program, [0, 0, 0, true, 0, 0]);
  program.run(f, 2);
  f.states[1] = 99;
  f.stopAfterInstruction = true;
  assert.equal(program.run(f, 6), 'invalidated');
  assert.equal(f.time, 5);
  assert.equal(f.states[0], 0);
  assert.equal(f.resume, 0);
});

test('memory exceptions preserve completed prefix/PC writes for finally flushing', () => {
  const b = builder();
  b.write('marker', b.constant(17));
  b.value({ kind: 'load8', memory: ram, offset: b.read('offset') });
  b.delay(2);
  const program = compileDirectJit([b.instruction(0, 99)], binding);
  for (const [offset, error] of [
    [0.5, TypeError],
    [NaN, TypeError],
    [-1, RangeError],
    [3, RangeError],
  ]) {
    const f = frame(program, [0, 1, 0, true, offset, 0]);
    assert.throws(() => program.run(f, 100), error);
    assert.equal(f.states[5], 17);
    assert.equal(f.states[0], 99);
    assert.equal(f.time, 0);
    assert.deepEqual(f.stateDirty, [(1 << 0) | (1 << 5)]);
    assert.deepEqual(f.memoryDirty, [0]);
  }
});

test('suffix failure does not replay prefix or lose earlier suffix effects', () => {
  const b = builder();
  b.write('x', b.binary('add', b.read('x'), b.constant(1)));
  b.delay(3);
  b.write('marker', b.constant(19));
  b.value({ kind: 'load8', memory: ram, offset: b.constant(99) });
  const program = compileDirectJit([b.instruction(0, 77)], binding);
  const f = frame(program);
  program.run(f, 1);
  assert.throws(() => program.run(f, 5), RangeError);
  assert.equal(f.states[1], 2);
  assert.equal(f.states[5], 19);
  assert.equal(f.states[0], 77);
  assert.equal(f.time, 3);
  assert.equal(f.resume, 0);
});

test('store8 follows safe-integer validation and Uint8Array wrapping semantics', () => {
  const b = builder();
  b.operations.push({ kind: 'store8', memory: ram, offset: b.read('offset'), value: b.read('x') });
  b.delay(1);
  const program = compileDirectJit([b.instruction(0, 99)], binding);
  for (const value of [-1, 256, 513, Number.MAX_SAFE_INTEGER]) {
    const f = frame(program, [0, value, 0, true, 0, 0]);
    assert.equal(program.run(f, 2), 'fallback');
    assert.equal(f.memories[0][0], Uint8Array.of(value)[0]);
  }
  const f = frame(program, [0, 0.1, 0, true, 0, 0]);
  assert.throws(() => program.run(f, 2), /stored value must be a safe integer/);
  f.states[4] = -1;
  assert.throws(() => {
    f.states[0] = 0;
    program.run(f, 2);
  }, /offset must be nonnegative/);
});

test('unknown/unsupported PC falls back before changing PC or executing a prefix', () => {
  const supported = builder();
  supported.delay(1);
  const unsupported = builder();
  unsupported.write('marker', unsupported.constant(7));
  unsupported.value({ kind: 'random' });
  unsupported.delay(1);
  const program = compileDirectJit(
    [supported.instruction(0, 2), unsupported.instruction(2, 4)],
    binding,
  );
  const f = frame(program);
  assert.equal(program.run(f, 10), 'fallback');
  assert.equal(f.states[0], 2);
  assert.equal(f.states[5], 0);
  assert.equal(f.time, 1);
  f.states[0] = 1234;
  assert.equal(program.run(f, 20), 'fallback');
  assert.equal(f.states[0], 1234);
  f.states[0] = NaN;
  assert.throws(() => program.run(f, 20), TypeError);
});

test('first repeated PC owns lookup even when its instruction is unsupported', () => {
  const first = builder();
  first.value({ kind: 'random' });
  first.delay(1);
  const second = builder();
  second.write('marker', second.constant(9));
  second.delay(1);
  const last = builder();
  last.delay(1);
  const program = compileDirectJit(
    [first.instruction(0, 2), second.instruction(0, 3), last.instruction(2, 4)],
    binding,
  );
  const f = frame(program);
  assert.equal(program.run(f, 10), 'fallback');
  assert.equal(f.states[0], 0);
  assert.equal(f.states[5], 0);
  const duplicate = compileDirectJit([second.instruction(0, 3), last.instruction(0, 4)], binding);
  const d = frame(duplicate);
  duplicate.run(d, 2);
  assert.equal(d.states[0], 3);
  assert.equal(d.states[5], 9);
});

test('numeric/bool constants and arithmetic match compileBody including signed zero', () => {
  const b = builder();
  b.write('x', b.constant(-0));
  const nan = b.constant(NaN);
  b.write('flag', b.binary('equal', nan, nan, 'bool'));
  const negative = b.value({ kind: 'unary', operator: 'negate', value: b.constant(7) });
  const abs = b.value({ kind: 'numeric', builtin: 'abs', args: [negative] });
  b.delay(1);
  b.write(
    'y',
    b.binary('shiftRightUnsigned', b.binary('bitXor', abs, b.constant(255)), b.constant(0)),
  );
  const instructions = [b.instruction(0, 99)];
  const program = compileDirectJit(instructions, binding);
  const f = frame(program);
  const reference = generic(instructions, f.states, f.memories);
  assert.equal(program.run(f, 2), reference.run(2));
  assert.deepEqual(f.states, reference.states);
  assert(Object.is(f.states[1], -0));
  assert.equal(f.states[3], false);
});

test('mutable local captures survive exact slices', () => {
  const b = builder();
  const initial = b.read('x');
  b.operations.push({ kind: 'local', local: 19, type: { kind: 'number' }, initial });
  const captured = b.value({ kind: 'localRead', local: 19 });
  b.operations.push({ kind: 'localWrite', local: 19, value: b.constant(55) });
  b.delay(5);
  b.write('x', captured);
  b.write('y', b.value({ kind: 'localRead', local: 19 }));
  const program = compileDirectJit([b.instruction(0, 99)], binding);
  const f = frame(program);
  program.run(f, 2);
  f.states[1] = 88;
  assert.equal(program.run(f, 6), 'fallback');
  assert.equal(f.states[1], 1);
  assert.equal(f.states[2], 55);
});

test('stop waits for suffix horizon and terminates without another instruction', () => {
  const b = builder();
  b.delay(5);
  b.write('marker', b.constant(9));
  b.operations.push({ kind: 'stop' });
  const program = compileDirectJit([b.instruction(0, 0)], binding);
  const f = frame(program);
  assert.equal(program.run(f, 5), 'deadline');
  assert.equal(f.states[5], 0);
  assert.equal(program.run(f, 6), 'stopped');
  assert.equal(f.states[5], 9);
  assert.equal(f.time, 5);
});

test('resource lists conservatively include implicit PC and both branch resources', () => {
  const program = compileDirectJit(scalarLoop(), binding);
  assert.deepEqual(new Set(program.readStates), new Set(['pc', 'x']));
  assert.deepEqual(new Set(program.writeStates), new Set(['pc', 'x', 'y']));
  assert.deepEqual(program.readMemories, ['ram']);
  assert.deepEqual(program.writeMemories, ['ram']);
  assert(Object.isFrozen(program));
  assert(Object.isFrozen(program.readStates));
});

test('all unsupported bodies and invalid static bindings decline compilation', () => {
  const invalid = builder();
  invalid.delay(0);
  assert.equal(compileDirectJit([invalid.instruction(0, 1)], binding), undefined);
  assert.equal(compileDirectJit([], binding), undefined);
  assert.equal(
    compileDirectJit(scalarLoop(), { ...binding, pc: { name: 'pc', index: 2 } }),
    undefined,
  );
  assert.equal(
    compileDirectJit(scalarLoop(), { ...binding, states: new Map([['pc', 0]]) }),
    undefined,
  );
  const dynamic = builder();
  dynamic.operations.push({ kind: 'elapse', duration: dynamic.read('x') });
  assert.equal(compileDirectJit([dynamic.instruction(0, 1)], binding), undefined);
  const missing = builder();
  missing.value({
    kind: 'load8',
    memory: { kind: 'memory', name: 'missing' },
    offset: missing.constant(0),
  });
  missing.delay(1);
  assert.equal(compileDirectJit([missing.instruction(0, 1)], binding), undefined);
});

test('duration overflow rejects after prefix and redirect validates before time consumption', () => {
  const b = builder();
  b.write('marker', b.constant(22));
  b.delay(2);
  const program = compileDirectJit([b.instruction(0, 99)], binding);
  const f = frame(program);
  f.time = 7_200_000_000_000_000 - 1;
  assert.throws(() => program.run(f, 7_200_000_000_000_000), /Time out of range/);
  assert.equal(f.states[5], 22);
  assert.equal(f.time, 7_200_000_000_000_000 - 1);
  const redirect = builder();
  const target = redirect.read('x');
  const delay = redirect.constant(2);
  redirect.operations.push({ kind: 'redirect', target, delay });
  const other = compileDirectJit([redirect.instruction(0, 99)], binding);
  const r = frame(other, [0, Infinity, 0, true, 0, 0]);
  assert.throws(() => other.run(r, 10), /Redirect target must be a finite number/);
  assert.equal(r.states[0], 99);
  assert.equal(r.time, 0);
});

test('dirty words preserve only successful writes when a later store fails', () => {
  const b = builder();
  b.write('marker', b.constant(17));
  const offset = b.constant(0);
  b.operations.push({ kind: 'store8', memory: ram, offset, value: b.constant(9) });
  b.operations.push({
    kind: 'store8',
    memory: { kind: 'memory', name: 'other' },
    offset: b.read('offset'),
    value: b.read('x'),
  });
  b.delay(2);
  const program = compileDirectJit([b.instruction(0, 99)], {
    ...binding,
    memories: new Map([
      ['ram', 0],
      ['other', 31],
    ]),
  });
  for (const [offset, value, error] of [
    [2, 5, RangeError],
    [-1, 5, RangeError],
    [0.5, 5, TypeError],
    [0, 0.5, TypeError],
    [0, Infinity, TypeError],
  ]) {
    const f = frame(program, [0, value, 0, true, offset, 0]);
    f.memories[31] = Uint8Array.of(3);
    assert.throws(() => program.run(f, 10), error);
    assert.deepEqual(f.stateDirty, [(1 << 0) | (1 << 5)]);
    assert.deepEqual(f.memoryDirty, [1]);
    assert.equal(f.memories[0][0], 9);
    assert.equal(f.memories[31][0], 3);
  }
});

test('dirty bits are idempotent and span state/memory word boundaries', () => {
  const b = builder();
  const one = b.constant(1);
  const two = b.constant(2);
  b.write('x', one);
  b.write('x', two);
  b.write('y', two);
  b.write('flag', b.constant(true));
  b.write('marker', two);
  const offset = b.constant(0);
  for (const name of ['ram', 'ram', 'other', 'last'])
    b.operations.push({ kind: 'store8', memory: { kind: 'memory', name }, offset, value: two });
  b.delay(5);
  const wide = {
    states: new Map([
      ['pc', 31],
      ['x', 32],
      ['y', 63],
      ['flag', 64],
      ['marker', 96],
    ]),
    memories: new Map([
      ['ram', 31],
      ['other', 32],
      ['last', 95],
    ]),
    pc: { name: 'pc', index: 31 },
  };
  const program = compileDirectJit([b.instruction(0, 99)], wide);
  const f = frame(program, new Array(100).fill(0));
  f.memories = Array.from({ length: 96 }, () => new Uint8Array(1));
  f.memoryDirty = [0, 0, 0];
  assert.equal(program.run(f, 1), 'deadline');
  assert.deepEqual(f.stateDirty, [1 << 31, (1 << 0) | (1 << 31), 1, 1]);
  assert.deepEqual(f.memoryDirty, [1 << 31, 1, 1 << 31]);
  f.stateDirty.fill(0);
  f.memoryDirty.fill(0);
  assert.equal(program.run(f, 6), 'fallback');
  assert.deepEqual(f.stateDirty, [0, 0, 0, 0]);
  assert.deepEqual(f.memoryDirty, [0, 0, 0]);
});

test('dirty words track only selected branch writes and no unsupported entry effects', () => {
  const b = builder();
  const condition = b.read('flag', 'bool');
  const value = b.constant(4);
  b.operations.push({
    kind: 'if',
    condition,
    yes: { operations: [{ kind: 'write', name: 'x', value }] },
    no: { operations: [{ kind: 'write', name: 'y', value }] },
  });
  const delay = b.constant(3);
  b.operations.push({ kind: 'redirect', target: value, delay });
  const program = compileDirectJit([b.instruction(0, 1)], binding);
  for (const condition of [true, false]) {
    const f = frame(program, [0, 1, 0, condition, 0, 0]);
    assert.equal(program.run(f, 1), 'deadline');
    assert.deepEqual(f.stateDirty, [1 | (condition ? 1 << 1 : 1 << 2)]);
    f.stateDirty.fill(0);
    f.stopAfterInstruction = true;
    assert.equal(program.run(f, 4), 'invalidated');
    assert.deepEqual(f.stateDirty, [0]);
    assert.deepEqual(f.memoryDirty, [0]);
    f.stopAfterInstruction = false;
    assert.equal(program.run(f, 5), 'fallback');
    assert.deepEqual(f.stateDirty, [0]);
  }
});

test('blocked ISR state writes do not disable a cached dynamic-RAM hot loop', () => {
  const hot = builder();
  const count = hot.binary('add', hot.read('x'), hot.constant(1));
  const offset = hot.binary('bitAnd', count, hot.constant(3));
  const loaded = hot.value({ kind: 'load8', memory: ram, offset });
  const value = hot.binary('bitAnd', hot.binary('add', loaded, count), hot.constant(255));
  hot.write('x', count);
  hot.operations.push({ kind: 'store8', memory: ram, offset, value });
  const remaining = hot.binary('subtract', hot.read('offset'), hot.constant(1));
  hot.write('offset', remaining);
  const condition = hot.binary('greaterThan', remaining, hot.constant(0), 'bool');
  const busy = hot.constant(2);
  const interrupt = hot.constant(128);
  const target = hot.value({
    kind: 'select',
    condition,
    yes: { type: { kind: 'number' }, body: { operations: [{ kind: 'yield', value: busy }] } },
    no: { type: { kind: 'number' }, body: { operations: [{ kind: 'yield', value: interrupt }] } },
  });
  const delay = hot.constant(2);
  hot.operations.push({ kind: 'redirect', target, delay });
  const isr = builder();
  isr.write('y', isr.constant(999));
  isr.write('marker', isr.constant(17));
  isr.delay(3);
  const instructions = [hot.instruction(2, 3), isr.instruction(128, 129)];
  const program = compileDirectJit(instructions, {
    ...binding,
    blockedStates: new Set(['marker']),
  });
  assert(program);
  assert.deepEqual(new Set(program.writeStates), new Set(['pc', 'x', 'offset']));
  assert.deepEqual(program.writeMemories, ['ram']);
  const f = frame(program, [2, 1, 0, true, 3, 0], [1, 2, 3, 4]);
  assert.equal(program.run(f, 10), 'fallback');
  assert.equal(f.time, 6);
  assert.equal(f.states[0], 128);
  assert.equal(f.states[1], 4);
  assert.equal(f.states[2], 0);
  assert.equal(f.states[4], 0);
  assert.equal(f.states[5], 0);
  assert.deepEqual(f.stateDirty, [1 | (1 << 1) | (1 << 4)]);
  assert.deepEqual(f.memoryDirty, [1]);
  f.stateDirty.fill(0);
  f.memoryDirty.fill(0);
  assert.equal(program.run(f, 20), 'fallback');
  assert.equal(f.states[0], 128);
  assert.equal(f.time, 6);
  assert.deepEqual(f.stateDirty, [0]);
  assert.deepEqual(f.memoryDirty, [0]);
});

test('blocked memory writes in unselected branches are complete-instruction barriers, not read barriers', () => {
  const load = builder();
  const value = load.value({ kind: 'load8', memory: ram, offset: load.read('offset') });
  load.delay(1);
  load.write('x', value);
  const store = builder();
  store.write('y', store.constant(999));
  const condition = store.constant(false);
  const offset = store.constant(0);
  const stored = store.constant(8);
  store.operations.push({
    kind: 'if',
    condition,
    yes: { operations: [{ kind: 'store8', memory: ram, offset, value: stored }] },
  });
  store.delay(3);
  const program = compileDirectJit([load.instruction(0, 128), store.instruction(128, 129)], {
    ...binding,
    blockedMemories: new Set(['ram']),
  });
  assert(program);
  assert.deepEqual(program.readMemories, ['ram']);
  assert.deepEqual(program.writeMemories, []);
  assert.deepEqual(new Set(program.writeStates), new Set(['pc', 'x']));
  const f = frame(program);
  assert.equal(program.run(f, 10), 'fallback');
  assert.equal(f.states[0], 128);
  assert.equal(f.states[1], 7);
  assert.equal(f.states[2], 0);
  assert.deepEqual(f.memoryDirty, [0]);
  f.stateDirty.fill(0);
  assert.equal(program.run(f, 20), 'fallback');
  assert.equal(f.states[0], 128);
  assert.equal(f.states[2], 0);
  assert.deepEqual(f.stateDirty, [0]);
});

test('nested select state barriers preserve first-PC ownership and are fixed at compilation', () => {
  const blocked = builder();
  blocked.write('y', blocked.constant(999));
  const condition = blocked.constant(false);
  const value = blocked.constant(7);
  const selected = blocked.value({
    kind: 'select',
    condition,
    yes: {
      type: { kind: 'number' },
      body: {
        operations: [
          {
            kind: 'if',
            condition,
            yes: { operations: [{ kind: 'write', name: 'marker', value }] },
          },
          { kind: 'yield', value },
        ],
      },
    },
    no: { type: { kind: 'number' }, body: { operations: [{ kind: 'yield', value }] } },
  });
  blocked.write('x', selected);
  blocked.delay(1);
  const accepted = builder();
  accepted.delay(1);
  const blockedStates = new Set(['marker']);
  const filtered = { ...binding, blockedStates };
  const instructions = [
    blocked.instruction(0, 9),
    accepted.instruction(0, 10),
    accepted.instruction(2, 3),
  ];
  const program = compileDirectJit(instructions, filtered);
  assert(program);
  assert.deepEqual(program.readStates, ['pc']);
  assert.deepEqual(program.writeStates, ['pc']);
  const f = frame(program);
  assert.equal(program.run(f, 10), 'fallback');
  assert.equal(f.states[0], 0);
  assert.equal(f.states[2], 0);
  assert.deepEqual(f.stateDirty, [0]);
  blockedStates.clear();
  assert.equal(program.run(f, 10), 'fallback');
  const rebuilt = compileDirectJit(instructions, filtered);
  assert.equal(rebuilt.run(f, 10), 'fallback');
  assert.equal(f.states[0], 9);
  assert.equal(f.states[2], 999);
  assert.equal(
    compileDirectJit(instructions, { ...binding, blockedStates: new Set(['pc']) }),
    undefined,
  );
});

test('arbitrary resource names are never interpolated into generated source', () => {
  const name = 'state"); throw new Error("injected"); //';
  const b = builder();
  b.write(name, b.constant(8));
  b.delay(1);
  const program = compileDirectJit([b.instruction(0, 9)], {
    ...binding,
    states: new Map([
      ['pc', 0],
      [name, 1],
    ]),
  });
  const f = frame(program);
  assert.equal(program.run(f, 2), 'fallback');
  assert.equal(f.states[1], 8);
});
