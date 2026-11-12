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

/** Deterministic host double shared by the direct frame and the compileBody reference. */
function hostRecorder(clock) {
  const entries = [];
  return {
    entries,
    send: (name, value) => entries.push(['send', name, value, clock()]),
    notify: (name) => entries.push(['notify', name, clock()]),
    sample: (pin) => {
      entries.push(['sample', pin, clock()]);
      return { level: 'high', counts: 3, empty: null };
    },
    intent: (pin, value) => entries.push(['intent', pin, value, clock()]),
    resistor: (pin, resistance) => {
      entries.push(['resistor', pin, resistance, clock()]);
      return ['pullUp'];
    },
    now: () => clock(),
    random: () => {
      const value = entries.filter((entry) => entry[0] === 'random').length / 4 + 0.25;
      entries.push(['random', value, clock()]);
      return value;
    },
    assert: (condition, message) => {
      entries.push(['assert', condition, message, clock()]);
      if (condition !== true)
        throw new Error(message === undefined ? 'Assertion failed' : String(message));
    },
  };
}

function generated(program) {
  return program.run.toString();
}

/** Captures the factory body handed to new Function so split structure stays inspectable. */
function captureFactory(compile) {
  const original = globalThis.Function;
  let source = '';
  globalThis.Function = function (...args) {
    source = args.at(-1);
    return original(...args);
  };
  try {
    compile();
  } finally {
    globalThis.Function = original;
  }
  return source;
}

/** Compiles both emitters and runs them side by side, comparing every observable. */
function duet(instructions, options = {}) {
  const settings = options.binding ?? binding;
  const shardSize = options.shardSize ?? 4;
  const whole = compileDirectJit(instructions, settings);
  const split = compileDirectJit(instructions, {
    ...settings,
    split: true,
    shardSlotLimit: 0,
    shardSize,
  });
  assert(whole, 'monolithic program');
  assert(split, 'split program');
  const make = (program) => {
    const f = frame(program, options.states, options.memory);
    if (options.host) f.host = hostRecorder(() => f.time);
    return { program, frame: f, log: f.host };
  };
  const left = make(whole);
  const right = make(split);
  return {
    left,
    right,
    run(deadline) {
      const label = `deadline ${deadline}`;
      const outcome = (side) => {
        try {
          return { reason: side.program.run(side.frame, deadline) };
        } catch (error) {
          return { error };
        }
      };
      const a = outcome(left);
      const b = outcome(right);
      if (a.error || b.error) {
        assert(a.error && b.error, `${label}: both emitters must throw`);
        assert.equal(a.error.constructor, b.error.constructor, `${label} error type`);
        assert.equal(a.error.message, b.error.message, `${label} error message`);
      } else assert.equal(a.reason, b.reason, `${label} reason`);
      for (const field of ['states', 'memories', 'stateDirty', 'memoryDirty'])
        assert.deepEqual(left.frame[field], right.frame[field], `${label} ${field}`);
      for (const field of ['resume', 'due', 'time'])
        assert.equal(left.frame[field], right.frame[field], `${label} ${field}`);
      assert.deepEqual(left.log?.entries, right.log?.entries, `${label} host log`);
      return a.reason ?? a.error;
    },
  };
}

function generic(instructions, states, memories, recorder) {
  const lookup = new Map();
  for (const instruction of instructions)
    if (!lookup.has(instruction.pc)) lookup.set(instruction.pc, instruction);
  const machine = {
    states: [...states],
    memories: memories.map((bytes) => bytes.slice()),
    time: 0,
  };
  // Mirrors the simulator host: safe integer, nonnegative, then whole-range checks.
  const range = (memory, offset, size) => {
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset))
      throw new TypeError('offset must be a safe integer');
    if (offset < 0) throw new RangeError('offset must be nonnegative');
    if (offset > memory.length || size > memory.length - offset)
      throw new RangeError('Memory range is out of bounds');
    return offset;
  };
  const bank = (name) => machine.memories[binding.memories.get(name)];
  const width = (kind) =>
    kind.startsWith('load8') || kind.startsWith('store8') ? 1 : kind.includes('16') ? 2 : 4;
  const recorderHost = recorder?.(machine);
  const host = {
    ...recorderHost,
    read: (_resource, name) => machine.states[binding.states.get(name)],
    write: (name, value) => {
      machine.states[binding.states.get(name)] = value;
    },
    load: (kind, name, offset) => {
      const bytes = bank(name);
      const size = width(kind);
      const at = range(bytes, offset, size);
      if (size === 1) return bytes[at];
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return size === 2
        ? view.getUint16(at, kind.endsWith('le'))
        : view.getUint32(at, kind.endsWith('le'));
    },
    store: (kind, name, offset, value) => {
      const bytes = bank(name);
      const size = width(kind);
      const at = range(bytes, offset, size);
      if (typeof value !== 'number' || !Number.isSafeInteger(value))
        throw new TypeError('stored value must be a safe integer');
      if (size === 1) bytes[at] = value;
      else {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (size === 2) view.setUint16(at, value, kind.endsWith('le'));
        else view.setUint32(at, value, kind.endsWith('le'));
      }
    },
  };
  let active;
  let due;
  machine.log = recorderHost?.entries;
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

test('zero-duration elapse runs inline without consuming time or a continuation', () => {
  const zero = builder();
  zero.write('x', zero.constant(5));
  zero.delay(0);
  zero.write('y', zero.constant(7));
  const paced = builder();
  paced.delay(1);
  const instructions = [zero.instruction(0, 2), paced.instruction(2, 0)];
  const program = compileDirectJit(instructions, binding);
  assert(program);
  const f = frame(program);
  const reference = generic(instructions, f.states, f.memories);
  assert.equal(program.run(f, 10), reference.run(10));
  assert.deepEqual(f.states, reference.states);
  assert.equal(f.time, reference.time);
  assert.equal(f.time, 10);
  // The last one-cycle elapse lands exactly on the deadline, so only that suffix stays pending.
  assert.equal(f.resume, 2);
  assert.equal(f.states[1], 5);
  assert.equal(f.states[2], 7);
  assert.equal(program.run(f, 11), 'deadline');
  assert.equal(f.resume, 2);
  // A zero-duration redirect targets the new PC immediately and keeps the same time.
  const start = builder();
  start.write('x', start.constant(3));
  start.operations.push({ kind: 'redirect', target: start.constant(9), delay: start.constant(0) });
  const next = builder();
  next.write('y', next.constant(4));
  next.delay(1);
  const redirected = compileDirectJit([start.instruction(0, 1), next.instruction(9, 11)], binding);
  assert(redirected);
  const g = frame(redirected, [0, 0, 0, true, 0, 0]);
  assert.equal(redirected.run(g, 10), 'fallback');
  assert.equal(g.states[0], 11);
  assert.equal(g.states[1], 3);
  assert.equal(g.states[2], 4);
  assert.equal(g.time, 1);
  assert.equal(g.resume, 0);
});

test('slot budget selects the monolithic form for small programs', () => {
  const small = compileDirectJit(scalarLoop(), { ...binding, split: true });
  assert(small);
  assert(!small.run.toString().includes('stepShard0'));
  const large = compileDirectJit(scalarLoop(), {
    ...binding,
    split: true,
    shardSlotLimit: 0,
    shardSize: 1,
  });
  assert(large);
  assert(large.run.toString().includes('stepShard0'));
  assert(small.run.toString().includes('stepShard0') === false);
});

test('all unsupported bodies and invalid static bindings decline compilation', () => {
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
  // A computed duration is supported: it is validated at run time, not declined.
  assert(compileDirectJit([dynamic.instruction(0, 1)], binding));
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

test('safe integer and boolean literals, PCs and durations are inlined', () => {
  const b = builder();
  b.write('x', b.constant(7));
  b.write('flag', b.constant(true));
  b.delay(3);
  const program = compileDirectJit([b.instruction(5, 9)], binding);
  const source = generated(program);
  assert.doesNotMatch(source, /C\[/);
  assert.match(source, /case 5: \{/);
  assert.match(source, /S\[0\] = 9;/);
  assert.match(source, /v\d+ = 7;\nS\[1\] = v\d+;/);
  assert.match(source, /v\d+ = true;\nS\[3\] = v\d+;/);
  assert.match(source, /F\.due = F\.time \+ 3;/);
  const f = frame(program, [5, 1, 0, true, 0, 0]);
  assert.equal(program.run(f, 5), 'fallback');
  assert.equal(f.states[1], 7);
  assert.equal(f.states[3], true);
  assert.equal(f.states[0], 9);
  assert.equal(f.time, 3);
  const redirect = builder();
  redirect.write('marker', redirect.constant(0));
  const target = redirect.constant(12);
  const delay = redirect.constant(4);
  redirect.operations.push({ kind: 'redirect', target, delay });
  const jumping = compileDirectJit([redirect.instruction(3, 4)], binding);
  const jumpSource = generated(jumping);
  assert.doesNotMatch(jumpSource, /C\[/);
  assert.match(jumpSource, /v\d+ = 12;/);
  assert.match(jumpSource, /S\[0\] = H\.checkPc\(v\d+\);/);
  assert.match(jumpSource, /F\.due = F\.time \+ 4;/);
  const r = frame(jumping, [3, 0, 0, true, 0, 0]);
  assert.equal(jumping.run(r, 10), 'fallback');
  assert.equal(r.states[0], 12);
  assert.equal(r.time, 4);
});

test('captured NaN, infinities and fractional numbers keep compileBody semantics', () => {
  const b = builder();
  b.write('x', b.constant(-0));
  b.write('y', b.constant(NaN));
  b.write('marker', b.constant(Infinity));
  b.write('flag', b.binary('equal', b.constant(1.5), b.constant(1.5), 'bool'));
  b.delay(1);
  const instructions = [b.instruction(0, 99)];
  const program = compileDirectJit(instructions, binding);
  const source = generated(program);
  assert.match(source, /v\d+ = -0;\nS\[1\] = v\d+;/);
  assert.match(source, /v\d+ = C\[0\];\nS\[2\] = v\d+;/);
  assert.match(source, /v\d+ = C\[1\];\nS\[5\] = v\d+;/);
  assert.doesNotMatch(source, /= NaN|= Infinity|= 1\.5/);
  const f = frame(program);
  const reference = generic(instructions, f.states, f.memories);
  assert.equal(program.run(f, 2), reference.run(2));
  assert.deepEqual(f.states, reference.states);
  assert(Object.is(f.states[1], -0));
  assert.equal(Number.isNaN(f.states[2]), true);
  assert.equal(f.states[5], Infinity);
  assert.equal(f.states[3], true);
});

test('pure scalar select folds into one conditional expression', () => {
  const b = builder();
  const condition = b.read('flag', 'bool');
  const yes = [];
  const left = b.value({ kind: 'constant', constant: { kind: 'number', value: 4 } }, 'number', yes);
  const right = b.value(
    { kind: 'constant', constant: { kind: 'number', value: 3 } },
    'number',
    yes,
  );
  const sum = b.value({ kind: 'binary', operator: 'add', left, right }, 'number', yes);
  yes.push({ kind: 'yield', value: sum });
  const no = [];
  const current = b.value({ kind: 'read', resource: 'state', name: 'y' }, 'number', no);
  no.push({ kind: 'yield', value: current });
  const selected = b.value({
    kind: 'select',
    condition,
    yes: { type: { kind: 'number' }, body: { operations: yes } },
    no: { type: { kind: 'number' }, body: { operations: no } },
  });
  b.write('x', selected);
  b.delay(1);
  const instructions = [b.instruction(0, 99)];
  const program = compileDirectJit(instructions, binding);
  const source = generated(program);
  assert.match(
    source,
    /v\d+ = \(typeof v\d+ === "boolean" \? v\d+ : H\.checkBoolean\(v\d+\)\) \? \(4 \+ 3\) : S\[2\];/,
  );
  assert.doesNotMatch(source, /select\d+:/);
  assert(program.readStates.includes('y'));
  for (const flag of [true, false]) {
    const f = frame(program, [0, 0, 42, flag, 0, 0]);
    const reference = generic(instructions, f.states, f.memories);
    assert.equal(program.run(f, 5), reference.run(5));
    assert.deepEqual(f.states, reference.states);
    assert.equal(f.states[1], flag ? 7 : 42);
  }
});

test('select branches with effects or extra yields keep the labeled block', () => {
  const effectful = builder();
  const condition = effectful.read('flag', 'bool');
  const value = effectful.constant(4);
  const selected = effectful.value({
    kind: 'select',
    condition,
    yes: {
      type: { kind: 'number' },
      body: {
        operations: [
          { kind: 'write', name: 'marker', value },
          { kind: 'yield', value },
        ],
      },
    },
    no: {
      type: { kind: 'number' },
      body: {
        operations: [
          { kind: 'write', name: 'x', value },
          { kind: 'yield', value },
        ],
      },
    },
  });
  effectful.write('y', selected);
  effectful.delay(1);
  const instructions = [effectful.instruction(0, 99)];
  const program = compileDirectJit(instructions, binding);
  const source = generated(program);
  assert.match(source, /select0: \{/);
  // 条件守卫自身带三目；这里只要求分支没有被折成 `cond ? (…) : (…)` 的单表达式。
  assert.doesNotMatch(source, /\) \? \(/);
  for (const flag of [true, false]) {
    const f = frame(program, [0, 1, 0, flag, 0, 0]);
    const reference = generic(instructions, f.states, f.memories);
    assert.equal(program.run(f, 5), reference.run(5));
    assert.deepEqual(f.states, reference.states);
    assert.equal(f.states[2], 4);
    assert.equal(f.states[1], flag ? 1 : 4);
    assert.equal(f.states[5], flag ? 4 : 0);
    assert.deepEqual(f.stateDirty, [1 | (1 << 2) | (flag ? 1 << 5 : 1 << 1)]);
  }
  const repeated = builder();
  const repeatedCondition = repeated.read('flag', 'bool');
  const repeatedValue = repeated.constant(6);
  const twice = repeated.value({
    kind: 'select',
    condition: repeatedCondition,
    yes: {
      type: { kind: 'number' },
      body: {
        operations: [
          { kind: 'yield', value: repeatedValue },
          { kind: 'yield', value: repeatedValue },
        ],
      },
    },
    no: {
      type: { kind: 'number' },
      body: { operations: [{ kind: 'yield', value: repeatedValue }] },
    },
  });
  repeated.write('y', twice);
  repeated.delay(1);
  const looped = compileDirectJit([repeated.instruction(0, 99)], binding);
  assert.match(generated(looped), /select0: \{/);
  const f = frame(looped, [0, 0, 0, true, 0, 0]);
  assert.equal(looped.run(f, 5), 'fallback');
  assert.equal(f.states[2], 6);
});

test('wide loads and stores match compileBody for both byte orders and unaligned offsets', () => {
  const b = builder();
  const le16 = b.value({ kind: 'load16le', memory: ram, offset: b.constant(0) });
  const be16 = b.value({ kind: 'load16be', memory: ram, offset: b.constant(1) });
  const le32 = b.value({ kind: 'load32le', memory: ram, offset: b.constant(0) });
  const be32 = b.value({ kind: 'load32be', memory: ram, offset: b.constant(1) });
  b.write('x', le16);
  b.write('y', be16);
  b.write('marker', le32);
  b.write('offset', be32);
  b.operations.push({
    kind: 'store16le',
    memory: ram,
    offset: b.constant(2),
    value: b.constant(0x1234),
  });
  b.operations.push({
    kind: 'store16be',
    memory: ram,
    offset: b.constant(0),
    value: b.constant(0xabcd),
  });
  b.operations.push({
    kind: 'store32le',
    memory: ram,
    offset: b.constant(0),
    value: b.constant(0x01020304),
  });
  b.operations.push({
    kind: 'store32be',
    memory: ram,
    offset: b.constant(2),
    value: b.constant(0x01020304),
  });
  b.delay(1);
  const instructions = [b.instruction(0, 99)];
  const program = compileDirectJit(instructions, binding);
  assert(program);
  const first = frame(program, [0, 0, 0, true, 0, 0], [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]);
  const reference = generic(instructions, first.states, first.memories);
  assert.equal(program.run(first, 5), reference.run(5));
  assert.deepEqual(first.states, reference.states);
  assert.deepEqual(first.memories, reference.memories);
  assert.equal(first.states[1], 0x3412);
  assert.equal(first.states[2], 0x3456);
  assert.equal(first.states[5], 0x78563412);
  assert.equal(first.states[4], 0x3456789a);
  assert.deepEqual(Array.from(first.memories[0]), [0x04, 0x03, 0x01, 0x02, 0x03, 0x04]);
  assert.deepEqual(program.readMemories, ['ram']);
  assert.deepEqual(program.writeMemories, ['ram']);
});

test('wide accesses keep host addressing order and error messages', () => {
  for (const [kind, offset, stored, error, message] of [
    ['load16le', 0.5, null, TypeError, /offset must be a safe integer/],
    ['load32be', NaN, null, TypeError, /offset must be a safe integer/],
    ['load16be', -1, null, RangeError, /offset must be nonnegative/],
    ['load16le', 2, null, RangeError, /Memory range is out of bounds/],
    ['load32le', 0, null, RangeError, /Memory range is out of bounds/],
    ['store16le', 2, 5, RangeError, /Memory range is out of bounds/],
    ['store32be', -1, 0.5, RangeError, /offset must be nonnegative/],
    ['store16be', 0, 0.5, TypeError, /stored value must be a safe integer/],
  ]) {
    const b = builder();
    const at = b.read('offset');
    if (kind.startsWith('store')) {
      const value = stored === null ? b.read('x') : b.constant(stored);
      b.operations.push({ kind, memory: ram, offset: at, value });
    } else b.value({ kind, memory: ram, offset: at });
    b.delay(1);
    const instructions = [b.instruction(0, 99)];
    const program = compileDirectJit(instructions, binding);
    assert(program, kind);
    const capture = (run) => {
      try {
        run();
        return null;
      } catch (thrown) {
        return thrown;
      }
    };
    const f = frame(program, [0, 1, 0, true, offset, 0], [7, 8, 9]);
    const reference = generic(instructions, f.states, f.memories);
    const direct = capture(() => program.run(f, 5));
    const expected = capture(() => reference.run(5));
    assert(direct instanceof error, `${kind} ${offset}`);
    assert.match(direct.message, message);
    assert.equal(direct.constructor, expected.constructor);
    assert.equal(direct.message, expected.message);
  }
});

test('blocked memories keep every load kind eligible and exclude stores', () => {
  const loads = builder();
  const le = loads.value({ kind: 'load16le', memory: ram, offset: loads.constant(0) });
  const be = loads.value({ kind: 'load32be', memory: ram, offset: loads.constant(0) });
  loads.write('x', le);
  loads.write('y', be);
  loads.delay(1);
  const stores = builder();
  stores.operations.push({
    kind: 'store16le',
    memory: ram,
    offset: stores.constant(0),
    value: stores.constant(1),
  });
  stores.delay(1);
  const blocked = { ...binding, blockedMemories: new Set(['ram']) };
  const program = compileDirectJit([loads.instruction(0, 2), stores.instruction(2, 3)], blocked);
  assert(program);
  assert.deepEqual(program.readMemories, ['ram']);
  assert.deepEqual(program.writeMemories, []);
  const f = frame(program, [0, 0, 0, true, 0, 0], [0x12, 0x34, 0x56, 0x78]);
  assert.equal(program.run(f, 5), 'fallback');
  assert.equal(f.states[0], 2);
  assert.equal(f.states[1], 0x3412);
  assert.equal(f.states[2], 0x12345678);
  assert.deepEqual(f.memories[0], Uint8Array.from([0x12, 0x34, 0x56, 0x78]));
  assert.deepEqual(f.memoryDirty, [0]);
  assert.equal(compileDirectJit([stores.instruction(2, 3)], blocked), undefined);
});

test('and/or short-circuit and skip right-region effects', () => {
  for (const kind of ['and', 'or']) {
    const b = builder();
    const condition = b.read('flag', 'bool');
    const marker = b.constant(9);
    const right = b.read('x', 'bool');
    const rightOperations = [
      { kind: 'write', name: 'marker', value: marker },
      { kind: 'yield', value: right },
    ];
    const combined = b.value(
      {
        kind,
        left: condition,
        right: { type: { kind: 'bool' }, body: { operations: rightOperations } },
      },
      'bool',
    );
    b.write('y', combined);
    b.delay(1);
    const instructions = [b.instruction(0, 99)];
    const program = compileDirectJit(instructions, binding);
    assert(program, kind);
    assert.match(generated(program), new RegExp(`${kind}0: \\{`));
    for (const flag of [true, false]) {
      for (const value of [true, false]) {
        const f = frame(program, [0, value, null, flag, 0, 0]);
        const reference = generic(instructions, f.states, f.memories);
        assert.equal(program.run(f, 5), reference.run(5));
        assert.deepEqual(f.states, reference.states);
        const evaluated = kind === 'and' ? flag : !flag;
        assert.equal(f.states[5], evaluated ? 9 : 0);
        assert.equal(f.states[2], evaluated ? value : flag);
      }
    }
  }
});

test('match arms compare patterns like compileBody and fall through to otherwise', () => {
  const b = builder();
  const value = b.read('y');
  const arm = (pattern, literal) => {
    const body = [];
    const result = b.value(
      { kind: 'constant', constant: { kind: 'number', value: literal } },
      'number',
      body,
    );
    body.push({ kind: 'yield', value: result });
    return { pattern, body: { operations: body } };
  };
  const otherwise = [];
  const fallback = b.value(
    { kind: 'constant', constant: { kind: 'number', value: 99 } },
    'number',
    otherwise,
  );
  otherwise.push({ kind: 'yield', value: fallback });
  const match = {
    kind: 'match',
    value,
    arms: [
      arm({ kind: 'number', value: 3 }, 30),
      arm({ kind: 'bool', value: true }, 31),
      arm({ kind: 'string', value: 'alpha' }, 32),
      arm({ kind: 'enum', name: 'Mode', member: 'Busy' }, 33),
      arm({ kind: 'none' }, 34),
    ],
    otherwise: { operations: otherwise },
  };
  const condition = b.read('flag', 'bool');
  const no = [];
  const zero = b.value({ kind: 'constant', constant: { kind: 'number', value: 0 } }, 'number', no);
  no.push({ kind: 'yield', value: zero });
  const selected = b.value({
    kind: 'select',
    condition,
    yes: { type: { kind: 'number' }, body: { operations: [match] } },
    no: { type: { kind: 'number' }, body: { operations: no } },
  });
  b.write('marker', selected);
  b.delay(1);
  const instructions = [b.instruction(0, 99)];
  const program = compileDirectJit(instructions, binding);
  assert(program);
  const source = generated(program);
  assert.match(source, /H\.equalValues\(/);
  assert.match(source, /H\.equalValues\(v\d+, "alpha"\)/);
  for (const [state, expected] of [
    [3, 30],
    [true, 31],
    ['alpha', 32],
    ['Busy', 33],
    [null, 34],
    [42, 99],
  ]) {
    const f = frame(program, [0, 1, state, true, 0, 0]);
    const reference = generic(instructions, f.states, f.memories);
    assert.equal(program.run(f, 5), reference.run(5));
    assert.deepEqual(f.states, reference.states);
    assert.equal(f.states[5], expected, String(state));
  }
});

test('statement match needs no output while value-position match requires otherwise', () => {
  const b = builder();
  const value = b.read('y');
  const hit = b.constant(7);
  const miss = b.constant(8);
  b.operations.push({
    kind: 'match',
    value,
    arms: [
      {
        pattern: { kind: 'number', value: 3 },
        body: { operations: [{ kind: 'write', name: 'x', value: hit }] },
      },
    ],
    otherwise: { operations: [{ kind: 'write', name: 'marker', value: miss }] },
  });
  b.delay(1);
  const instructions = [b.instruction(0, 99)];
  const program = compileDirectJit(instructions, binding);
  assert(program);
  for (const [state, x, marker] of [
    [3, 7, 0],
    [4, 1, 8],
  ]) {
    const f = frame(program, [0, 1, state, true, 0, 0]);
    const reference = generic(instructions, f.states, f.memories);
    assert.equal(program.run(f, 5), reference.run(5));
    assert.deepEqual(f.states, reference.states);
    assert.equal(f.states[1], x);
    assert.equal(f.states[5], marker);
  }
  const only = builder();
  only.operations.push({
    kind: 'match',
    value: only.read('y'),
    arms: [],
    otherwise: { operations: [{ kind: 'write', name: 'x', value: only.constant(5) }] },
  });
  only.delay(1);
  const always = compileDirectJit([only.instruction(0, 99)], binding);
  assert(always);
  const f = frame(always);
  assert.equal(always.run(f, 5), 'fallback');
  assert.equal(f.states[1], 5);
  const incomplete = builder();
  const inner = [];
  const innerValue = incomplete.value(
    { kind: 'constant', constant: { kind: 'number', value: 1 } },
    'number',
    inner,
  );
  inner.push({ kind: 'yield', value: innerValue });
  const partial = {
    kind: 'match',
    value: incomplete.read('y'),
    arms: [{ pattern: { kind: 'number', value: 3 }, body: { operations: inner } }],
  };
  const no = [];
  const zero = incomplete.value(
    { kind: 'constant', constant: { kind: 'number', value: 0 } },
    'number',
    no,
  );
  no.push({ kind: 'yield', value: zero });
  const selected = incomplete.value({
    kind: 'select',
    condition: incomplete.read('flag', 'bool'),
    yes: { type: { kind: 'number' }, body: { operations: [partial] } },
    no: { type: { kind: 'number' }, body: { operations: no } },
  });
  incomplete.write('marker', selected);
  incomplete.delay(1);
  assert.equal(compileDirectJit([incomplete.instruction(0, 99)], binding), undefined);
});

const hostBinding = { ...binding, host: true };

function messageRegion(scope, text) {
  const operations = [];
  const result = scope.value(
    { kind: 'constant', constant: { kind: 'string', value: text } },
    'string',
    operations,
  );
  operations.push({ kind: 'yield', value: result });
  return { type: { kind: 'string' }, body: { operations } };
}

test('send, notify and now keep program order and frame time', () => {
  const b = builder();
  b.write('x', b.constant(4));
  b.operations.push({ kind: 'send', channel: 'bus', value: b.read('x') });
  b.operations.push({ kind: 'notify', notification: 'tick' });
  b.delay(3);
  b.operations.push({ kind: 'send', channel: 'bus', value: b.constant(9) });
  b.operations.push({ kind: 'write', name: 'marker', value: b.value({ kind: 'now' }) });
  const instructions = [b.instruction(0, 99)];
  const program = compileDirectJit(instructions, hostBinding);
  assert(program);
  const source = generated(program);
  assert.doesNotMatch(source, /bus|tick/);
  const f = frame(program);
  const log = hostRecorder(() => f.time);
  f.host = log;
  const reference = generic(instructions, f.states, f.memories, (machine) =>
    hostRecorder(() => machine.time),
  );
  assert.equal(program.run(f, 10), reference.run(10));
  assert.deepEqual(f.states, reference.states);
  assert.equal(f.states[5], 3);
  assert.deepEqual(log.entries, [
    ['send', 'bus', 4, 0],
    ['notify', 'tick', 0],
    ['send', 'bus', 9, 3],
  ]);
  assert.deepEqual(log.entries, reference.log);
});

test('readSample, field and match read host samples without leaking names', () => {
  const b = builder();
  const sample = b.value({ kind: 'readSample', pin: { kind: 'pin', name: 'p1' } }, 'sample');
  const level = b.value({ kind: 'field', value: sample, field: 'level' }, 'string');
  b.operations.push({
    kind: 'match',
    value: level,
    arms: [
      {
        pattern: { kind: 'string', value: 'high' },
        body: { operations: [{ kind: 'write', name: 'marker', value: b.constant(1) }] },
      },
      {
        pattern: { kind: 'string', value: 'low' },
        body: { operations: [{ kind: 'write', name: 'marker', value: b.constant(2) }] },
      },
    ],
    otherwise: { operations: [{ kind: 'write', name: 'marker', value: b.constant(0) }] },
  });
  b.delay(1);
  const instructions = [b.instruction(0, 99)];
  const program = compileDirectJit(instructions, hostBinding);
  assert(program);
  const source = generated(program);
  assert.match(source, /F\.host\.sample\(C\[0\]\)/);
  assert.match(source, /H\.equalValues\(v\d+, "high"\)/);
  assert.doesNotMatch(source, /p1|level/);
  const f = frame(program);
  const log = hostRecorder(() => f.time);
  f.host = log;
  const reference = generic(instructions, f.states, f.memories, (machine) =>
    hostRecorder(() => machine.time),
  );
  assert.equal(program.run(f, 5), reference.run(5));
  assert.deepEqual(f.states, reference.states);
  assert.equal(f.states[5], 1);
  assert.deepEqual(log.entries, [['sample', 'p1', 0]]);
  assert.deepEqual(log.entries, reference.log);
});

test('resistor, combineIntents and writeIntent record in program order', () => {
  const b = builder();
  const first = b.value(
    { kind: 'resistor', to: { kind: 'pin', name: 'p1' }, resistance: b.constant(100) },
    'intent',
  );
  const second = b.value(
    { kind: 'resistor', to: { kind: 'pin', name: 'p2' }, resistance: b.constant(200) },
    'intent',
  );
  const combined = b.value({ kind: 'combineIntents', values: [first, second] }, 'intent');
  b.operations.push({ kind: 'writeIntent', pin: { kind: 'pin', name: 'p2' }, value: combined });
  b.delay(1);
  const instructions = [b.instruction(0, 99)];
  const program = compileDirectJit(instructions, hostBinding);
  assert(program);
  const source = generated(program);
  assert.match(source, /H\.combineIntents\(\[/);
  assert.doesNotMatch(source, /p1|p2/);
  const f = frame(program);
  const log = hostRecorder(() => f.time);
  f.host = log;
  const reference = generic(instructions, f.states, f.memories, (machine) =>
    hostRecorder(() => machine.time),
  );
  assert.equal(program.run(f, 5), reference.run(5));
  assert.deepEqual(log.entries, [
    ['resistor', 'p1', 100, 0],
    ['resistor', 'p2', 200, 0],
    ['intent', 'p2', ['pullUp', 'pullUp'], 0],
  ]);
  assert.deepEqual(log.entries, reference.log);
  assert(Object.isFrozen(log.entries[2][2]));
});

test('a wide select over pin intents stays direct and runs only the taken branch', () => {
  const b = builder();
  const condition = b.read('flag', 'bool');
  const yes = [];
  const no = [];
  const yesIntent = b.value(
    { kind: 'resistor', to: { kind: 'pin', name: 'p1' }, resistance: b.constant(100) },
    'intent',
    yes,
  );
  yes.push({ kind: 'yield', value: yesIntent });
  const noIntent = b.value(
    { kind: 'resistor', to: { kind: 'pin', name: 'p2' }, resistance: b.constant(200) },
    'intent',
    no,
  );
  no.push({ kind: 'yield', value: noIntent });
  const chosen = b.value(
    {
      kind: 'select',
      condition,
      yes: { type: { kind: 'intent' }, body: { operations: yes } },
      no: { type: { kind: 'intent' }, body: { operations: no } },
    },
    'intent',
  );
  b.operations.push({ kind: 'writeIntent', pin: { kind: 'pin', name: 'p3' }, value: chosen });
  b.delay(1);
  const instructions = [b.instruction(0, 99)];
  const program = compileDirectJit(instructions, hostBinding);
  assert(program, 'wide select must not disqualify the instruction');
  const source = generated(program);
  assert.match(source, /select\d+: \{/);
  assert.doesNotMatch(source, /p1|p2|p3/);
  for (const [flag, expected] of [
    [true, ['resistor', 'p1', 100, 0]],
    [false, ['resistor', 'p2', 200, 0]],
  ]) {
    const f = frame(program);
    f.states[3] = flag;
    const log = hostRecorder(() => f.time);
    f.host = log;
    const reference = generic(instructions, f.states, f.memories, (machine) =>
      hostRecorder(() => machine.time),
    );
    assert.equal(program.run(f, 5), reference.run(5));
    assert.deepEqual(f.states, reference.states);
    assert.deepEqual(log.entries, [expected, ['intent', 'p3', ['pullUp'], 0]]);
    assert.deepEqual(log.entries, reference.log);
  }
});

test('a declared busy-wait head folds rounds and never crosses the deadline', () => {
  const b = builder();
  b.write('marker', b.constant(1));
  b.delay(2);
  const instruction = b.instruction(0, 2);
  const delayed = {
    ...binding,
    delayLoops: new Map([[0, { counter: binding.states.get('x'), cycles: 1000 }]]),
  };
  const program = compileDirectJit([instruction], delayed);
  assert(program);
  const source = generated(program);
  assert.match(
    source,
    /const rounds = Math\.min\(S\[\d+\] - 1, Math\.floor\(\(deadline - F\.time\) \/ 1000\)\);/,
  );

  // Horizon inside the wait: only the rounds that fit are folded and no instruction starts.
  const short = frame(program, [0, 11, 0, false, 0, 0]);
  assert.equal(program.run(short, 5000), 'deadline');
  assert.equal(short.time, 5000);
  assert.equal(short.states[1], 6);
  assert.equal(short.states[5], 0);

  // Horizon beyond the wait: every remaining round folds, then the real body runs once.
  const long = frame(program, [0, 11, 0, false, 0, 0]);
  assert.equal(program.run(long, 60_000), 'fallback');
  assert.equal(long.states[1], 1);
  assert.equal(long.time, 10 * 1000 + 2);
  assert.equal(long.states[5], 1);

  // The same body without the declaration executes once and costs one round only.
  const plain = compileDirectJit([instruction], binding);
  assert(plain);
  const unfolded = frame(plain, [0, 11, 0, false, 0, 0]);
  assert.equal(plain.run(unfolded, 60_000), 'fallback');
  assert.equal(unfolded.time, 2);
});

test('a computed elapse duration advances by the runtime value', () => {
  const b = builder();
  const amount = b.read('x');
  b.operations.push({ kind: 'elapse', duration: amount });
  const instruction = b.instruction(0, 99);
  const program = compileDirectJit([instruction], binding);
  assert(program);
  assert.match(generated(program), /F\.due = F\.time \+ H\.checkDuration\(v\d+\);/);

  const whole = frame(program, [0, 30, 0, false, 0, 0]);
  assert.equal(program.run(whole, 1_000), 'fallback');
  assert.equal(whole.time, 30);

  const split = frame(program, [0, 30, 0, false, 0, 0]);
  assert.equal(program.run(split, 10), 'deadline');
  assert.equal(split.time, 10);
  assert.equal(split.resume, 1);

  const zero = frame(program, [0, 0, 0, false, 0, 0]);
  assert.equal(program.run(zero, 1_000), 'fallback');
  assert.equal(zero.time, 0);

  const bad = frame(program, [0, 1.5, 0, false, 0, 0]);
  assert.throws(() => program.run(bad, 1_000), /finite integer/);
  const huge = frame(program, [0, 7_200_000_000_000_001, 0, false, 0, 0]);
  assert.throws(() => program.run(huge, 1_000), /picoseconds/);
});

test('refEqual compares names at compile time and declines parameter references', () => {
  const b = builder();
  b.write(
    'x',
    b.value(
      {
        kind: 'refEqual',
        left: { kind: 'pin', name: 'p1' },
        right: { kind: 'pin', name: 'p1' },
      },
      'bool',
    ),
  );
  b.write(
    'flag',
    b.value(
      {
        kind: 'refEqual',
        left: { kind: 'pin', name: 'p1' },
        right: { kind: 'memory', name: 'ram' },
      },
      'bool',
    ),
  );
  b.delay(1);
  const instructions = [b.instruction(0, 99)];
  const program = compileDirectJit(instructions, hostBinding);
  assert(program);
  const source = generated(program);
  assert.match(source, /= true;\nS\[1\] = /);
  assert.match(source, /= false;\nS\[3\] = /);
  assert.doesNotMatch(source, /p1|ram/);
  const f = frame(program);
  f.host = hostRecorder(() => f.time);
  const reference = generic(instructions, f.states, f.memories);
  assert.equal(program.run(f, 5), reference.run(5));
  assert.deepEqual(f.states, reference.states);
  assert.equal(f.states[1], true);
  assert.equal(f.states[3], false);
  const parameter = builder();
  parameter.value(
    {
      kind: 'refEqual',
      left: { kind: 'parameter', resource: 'pin', index: 0 },
      right: { kind: 'pin', name: 'p1' },
    },
    'bool',
  );
  parameter.delay(1);
  assert.equal(compileDirectJit([parameter.instruction(0, 99)], hostBinding), undefined);
});

test('random calls the host in program order', () => {
  const b = builder();
  b.write('x', b.value({ kind: 'random' }));
  b.write('y', b.value({ kind: 'random' }));
  b.delay(1);
  const instructions = [b.instruction(0, 99)];
  const program = compileDirectJit(instructions, hostBinding);
  assert(program);
  const f = frame(program);
  const log = hostRecorder(() => f.time);
  f.host = log;
  const reference = generic(instructions, f.states, f.memories, (machine) =>
    hostRecorder(() => machine.time),
  );
  assert.equal(program.run(f, 5), reference.run(5));
  assert.deepEqual(f.states, reference.states);
  assert.equal(f.states[1], 0.25);
  assert.equal(f.states[2], 0.5);
  assert.deepEqual(log.entries, [
    ['random', 0.25, 0],
    ['random', 0.5, 0],
  ]);
  assert.deepEqual(log.entries, reference.log);
});

test('assert defers messages until the condition fails', () => {
  const passing = builder();
  passing.operations.push({
    kind: 'assert',
    condition: passing.read('flag', 'bool'),
    message: messageRegion(passing, 'boom'),
  });
  passing.write('marker', passing.constant(1));
  passing.delay(1);
  const trueCase = [passing.instruction(0, 99)];
  const program = compileDirectJit(trueCase, hostBinding);
  assert(program);
  const source = generated(program);
  assert.match(
    source,
    /if \(!\(typeof v\d+ === "boolean" \? v\d+ : H\.checkBoolean\(v\d+\)\)\) F\.host\.assert\(false, "boom"\);/,
  );
  assert.doesNotMatch(source, /F\.host\.assert\(false, C\[/);
  const f = frame(program);
  const log = hostRecorder(() => f.time);
  f.host = log;
  assert.equal(program.run(f, 5), 'fallback');
  assert.deepEqual(log.entries, []);
  assert.equal(f.states[5], 1);

  const failing = builder();
  failing.operations.push({
    kind: 'assert',
    condition: failing.read('flag', 'bool'),
    message: messageRegion(failing, 'boom'),
  });
  failing.delay(1);
  const falseCase = [failing.instruction(0, 99)];
  const failingProgram = compileDirectJit(falseCase, hostBinding);
  const g = frame(failingProgram, [0, 1, 0, false, 0, 0]);
  const failingLog = hostRecorder(() => g.time);
  g.host = failingLog;
  const reference = generic(falseCase, g.states, g.memories, (machine) =>
    hostRecorder(() => machine.time),
  );
  assert.throws(() => failingProgram.run(g, 5), { message: 'boom' });
  assert.throws(() => reference.run(5), { message: 'boom' });
  assert.deepEqual(failingLog.entries, [['assert', false, 'boom', 0]]);
  assert.deepEqual(failingLog.entries, reference.log);

  const bare = builder();
  bare.operations.push({ kind: 'assert', condition: bare.read('flag', 'bool') });
  bare.delay(1);
  const bareProgram = compileDirectJit([bare.instruction(0, 99)], hostBinding);
  const h = frame(bareProgram, [0, 1, 0, false, 0, 0]);
  h.host = hostRecorder(() => h.time);
  assert.throws(() => bareProgram.run(h, 5), { message: 'Assertion failed' });

  const complex = builder();
  const message = [];
  complex.value({ kind: 'constant', constant: { kind: 'string', value: 'a' } }, 'string', message);
  const extra = complex.value(
    { kind: 'constant', constant: { kind: 'string', value: 'b' } },
    'string',
    message,
  );
  message.push({ kind: 'yield', value: extra });
  complex.operations.push({
    kind: 'assert',
    condition: complex.read('flag', 'bool'),
    message: { type: { kind: 'string' }, body: { operations: message } },
  });
  complex.delay(1);
  assert.equal(compileDirectJit([complex.instruction(0, 99)], hostBinding), undefined);
});

test('scalar helpers and non-number constants match compileBody under a host', () => {
  const b = builder();
  const text = b.value({ kind: 'constant', constant: { kind: 'string', value: 'abcd' } }, 'string');
  b.write('x', b.value({ kind: 'length', value: text }));
  const wrapped = b.value({ kind: 'optional', value: text }, 'optional');
  b.write('y', b.value({ kind: 'nonNull', value: wrapped }, 'string'));
  b.write(
    'marker',
    b.value({ kind: 'constant', constant: { kind: 'enum', name: 'Mode', member: 'Busy' } }, 'enum'),
  );
  const sample = b.value({ kind: 'readSample', pin: { kind: 'pin', name: 'p1' } }, 'sample');
  const empty = b.value({ kind: 'field', value: sample, field: 'empty' }, 'optional');
  b.write('flag', b.value({ kind: 'isNone', value: empty }, 'bool'));
  b.delay(1);
  const instructions = [b.instruction(0, 99)];
  const program = compileDirectJit(instructions, hostBinding);
  assert(program);
  const source = generated(program);
  assert.match(source, /H\.nonNull\(/);
  assert.match(source, /"abcd"/);
  assert.match(source, /"Busy"/);
  const f = frame(program);
  f.host = hostRecorder(() => f.time);
  const reference = generic(instructions, f.states, f.memories, (machine) =>
    hostRecorder(() => machine.time),
  );
  assert.equal(program.run(f, 5), reference.run(5));
  assert.deepEqual(f.states, reference.states);
  assert.equal(f.states[1], 4);
  assert.equal(f.states[2], 'abcd');
  assert.equal(f.states[5], 'Busy');
  assert.equal(f.states[3], true);

  const strict = builder();
  const strictSample = strict.value(
    { kind: 'readSample', pin: { kind: 'pin', name: 'p1' } },
    'sample',
  );
  const strictEmpty = strict.value(
    { kind: 'field', value: strictSample, field: 'empty' },
    'optional',
  );
  strict.operations.push({
    kind: 'write',
    name: 'x',
    value: strict.value({ kind: 'nonNull', value: strictEmpty }, 'number'),
  });
  strict.delay(1);
  const strictInstructions = [strict.instruction(0, 99)];
  const strictProgram = compileDirectJit(strictInstructions, hostBinding);
  assert(strictProgram);
  const s = frame(strictProgram);
  s.host = hostRecorder(() => s.time);
  const strictReference = generic(strictInstructions, s.states, s.memories, (machine) =>
    hostRecorder(() => machine.time),
  );
  assert.throws(() => strictProgram.run(s, 5), { message: 'Expected a non-null value' });
  assert.throws(() => strictReference.run(5), { message: 'Expected a non-null value' });
});

test('host operations are skipped unless the binding opts into a frame host', () => {
  const hostedCases = {
    send: (b) => b.operations.push({ kind: 'send', channel: 'c', value: b.constant(1) }),
    notify: (b) => b.operations.push({ kind: 'notify', notification: 'n' }),
    readSample: (b) => b.value({ kind: 'readSample', pin: { kind: 'pin', name: 'p1' } }, 'sample'),
    writeIntent: (b) =>
      b.operations.push({
        kind: 'writeIntent',
        pin: { kind: 'pin', name: 'p1' },
        value: b.constant(1),
      }),
    resistor: (b) =>
      b.value(
        { kind: 'resistor', to: { kind: 'pin', name: 'p1' }, resistance: b.constant(1) },
        'intent',
      ),
    field: (b) =>
      b.value(
        {
          kind: 'field',
          value: b.value({ kind: 'readSample', pin: { kind: 'pin', name: 'p1' } }, 'sample'),
          field: 'level',
        },
        'string',
      ),
    random: (b) => b.value({ kind: 'random' }),
    assert: (b) => b.operations.push({ kind: 'assert', condition: b.read('flag', 'bool') }),
  };
  for (const [name, build] of Object.entries(hostedCases)) {
    const b = builder();
    build(b);
    b.delay(1);
    assert.equal(compileDirectJit([b.instruction(0, 1)], binding), undefined, name);
    assert(
      compileDirectJit([b.instruction(0, 1)], { ...binding, host: false }) === undefined,
      name,
    );
    assert(compileDirectJit([b.instruction(0, 1)], hostBinding), name);
  }
  const pureCases = {
    combineIntents: (b) => b.value({ kind: 'combineIntents', values: [b.constant(1)] }, 'intent'),
    refEqual: (b) =>
      b.value(
        { kind: 'refEqual', left: { kind: 'pin', name: 'p1' }, right: { kind: 'pin', name: 'p1' } },
        'bool',
      ),
    length: (b) => b.value({ kind: 'length', value: b.read('x') }),
    optional: (b) => b.value({ kind: 'optional', value: b.read('x') }, 'optional'),
    isNone: (b) => b.value({ kind: 'isNone', value: b.read('x') }, 'bool'),
    nonNull: (b) => b.value({ kind: 'nonNull', value: b.read('x') }),
    now: (b) => b.value({ kind: 'now' }),
  };
  for (const [name, build] of Object.entries(pureCases)) {
    const b = builder();
    build(b);
    b.delay(1);
    assert(compileDirectJit([b.instruction(0, 1)], binding), name);
  }
  // JSON-encoded string and enum-member literals need no host: they stay pure source text.
  for (const constant of [
    { kind: 'string', value: 's' },
    { kind: 'enum', name: 'Mode', member: 'Busy' },
  ]) {
    const b = builder();
    b.value({ kind: 'constant', constant }, constant.kind);
    b.delay(1);
    assert(compileDirectJit([b.instruction(0, 1)], binding), constant.kind);
  }
  const plain = builder();
  plain.delay(1);
  const hosted = builder();
  hosted.operations.push({ kind: 'send', channel: 'c', value: hosted.constant(1) });
  hosted.delay(1);
  const program = compileDirectJit([plain.instruction(0, 2), hosted.instruction(2, 3)], binding);
  assert(program);
  const f = frame(program);
  f.host = hostRecorder(() => f.time);
  assert.equal(program.run(f, 10), 'fallback');
  assert.equal(f.states[0], 2);
  assert.equal(f.time, 1);
  assert.deepEqual(f.host.entries, []);
});

test('split code generation matches monolithic on the cached-PC scalar loop', () => {
  const instructions = scalarLoop();
  const pair = duet(instructions);
  const reference = generic(instructions, [0, 1, 0, true, 0, 0], [Uint8Array.from([7, 8, 9])]);
  for (const deadline of [0, 1, 2, 3, 5, 8, 13, 21, 39]) {
    assert.equal(pair.run(deadline), reference.run(deadline));
    assert.deepEqual(pair.left.frame.states, reference.states);
    assert.deepEqual(pair.left.frame.memories, reference.memories);
    assert.equal(pair.left.frame.time, reference.time);
  }
});

test('split code generation matches monolithic for select, wide memory, and/or, match and host operations', () => {
  const b = builder();
  b.write('x', b.binary('add', b.read('x'), b.constant(1)));
  const offset = b.binary('bitAnd', b.read('x'), b.constant(3));
  const loaded = b.value({ kind: 'load16le', memory: ram, offset });
  b.operations.push({ kind: 'store16be', memory: ram, offset, value: b.constant(0x12) });
  const condition = b.binary('lessThan', loaded, b.constant(1000), 'bool');
  const yes = [];
  const yesValue = b.value(
    { kind: 'binary', operator: 'add', left: loaded, right: b.constant(1) },
    'number',
    yes,
  );
  yes.push({ kind: 'yield', value: yesValue });
  const no = [];
  const noValue = b.value(
    { kind: 'binary', operator: 'subtract', left: loaded, right: b.constant(1) },
    'number',
    no,
  );
  no.push({ kind: 'yield', value: noValue });
  b.write(
    'y',
    b.value({
      kind: 'select',
      condition,
      yes: { type: { kind: 'number' }, body: { operations: yes } },
      no: { type: { kind: 'number' }, body: { operations: no } },
    }),
  );
  const rightOperations = [
    { kind: 'write', name: 'marker', value: b.constant(9) },
    { kind: 'yield', value: b.read('flag', 'bool') },
  ];
  const combined = b.value(
    {
      kind: 'and',
      left: b.read('flag', 'bool'),
      right: { type: { kind: 'bool' }, body: { operations: rightOperations } },
    },
    'bool',
  );
  b.operations.push({
    kind: 'if',
    condition: combined,
    yes: { operations: [{ kind: 'write', name: 'x', value: b.constant(1) }] },
  });
  b.operations.push({
    kind: 'match',
    value: b.read('y'),
    arms: [
      {
        pattern: { kind: 'number', value: 0 },
        body: { operations: [{ kind: 'write', name: 'marker', value: b.constant(5) }] },
      },
    ],
    otherwise: { operations: [{ kind: 'write', name: 'marker', value: b.constant(6) }] },
  });
  b.operations.push({ kind: 'send', channel: 'bus', value: b.read('x') });
  b.operations.push({ kind: 'notify', notification: 'tick' });
  const sample = b.value({ kind: 'readSample', pin: { kind: 'pin', name: 'p1' } }, 'sample');
  b.write('offset', b.value({ kind: 'field', value: sample, field: 'counts' }));
  const intent = b.value(
    {
      kind: 'combineIntents',
      values: [
        b.value(
          { kind: 'resistor', to: { kind: 'pin', name: 'p2' }, resistance: b.constant(220) },
          'intent',
        ),
      ],
    },
    'intent',
  );
  b.operations.push({ kind: 'writeIntent', pin: { kind: 'pin', name: 'p2' }, value: intent });
  b.operations.push({
    kind: 'assert',
    condition: b.read('flag', 'bool'),
    message: messageRegion(b, 'boom'),
  });
  b.write('marker', b.value({ kind: 'random' }));
  b.delay(3);
  b.write('x', b.value({ kind: 'now' }));
  const instructions = [b.instruction(0, 0)];
  const source = captureFactory(() =>
    compileDirectJit(instructions, {
      ...hostBinding,
      split: true,
      shardSlotLimit: 0,
      shardSize: 4,
    }),
  );
  assert.match(source, /function stepShard0\(F, deadline, pc\) \{/);
  assert.match(source, /function resumeShard0\(F, resume\) \{/);
  assert.doesNotMatch(source, /p1|p2|bus|tick/);
  const pair = duet(instructions, {
    binding: hostBinding,
    host: true,
    states: [0, 1, 0, true, 0, 0],
    memory: [1, 2, 3, 4, 5, 6, 7, 8],
  });
  for (const deadline of [0, 1, 2, 3, 4, 5, 8, 20]) pair.run(deadline);
  assert.equal(pair.left.frame.time, 20);
});

test('split resume path honours exact deadline boundaries', () => {
  const b = builder();
  b.write('marker', b.constant(17));
  const loaded = b.value({ kind: 'load8', memory: ram, offset: b.read('offset') });
  b.delay(10);
  b.write('x', loaded);
  const pair = duet([b.instruction(0, 99)], { states: [0, 1, 0, true, 0, 0], memory: [7, 8, 9] });
  assert.equal(pair.run(0), 'deadline');
  assert.equal(pair.left.frame.states[0], 0);
  assert.equal(pair.run(4), 'deadline');
  assert.equal(pair.left.frame.states[0], 99);
  assert.equal(pair.left.frame.due, 10);
  assert.deepEqual(pair.left.frame.stateDirty, [(1 << 0) | (1 << 5)]);
  pair.left.frame.stateDirty.fill(0);
  pair.right.frame.stateDirty.fill(0);
  pair.left.frame.memories[0][0] = 200;
  pair.right.frame.memories[0][0] = 200;
  pair.left.frame.states[4] = 2;
  pair.right.frame.states[4] = 2;
  assert.equal(pair.run(10), 'deadline');
  assert.equal(pair.left.frame.states[1], 1);
  assert(pair.left.frame.resume > 0);
  assert.equal(pair.run(11), 'fallback');
  assert.equal(pair.left.frame.states[1], 7);
  assert.equal(pair.left.frame.resume, 0);
  assert.equal(pair.left.frame.time, 10);
  assert.deepEqual(pair.left.frame.stateDirty, [1 << 1]);
});

test('split emission preserves stop, invalidation and unknown-PC fallback', () => {
  const stopping = builder();
  stopping.delay(5);
  stopping.write('marker', stopping.constant(9));
  stopping.operations.push({ kind: 'stop' });
  const stopPair = duet([stopping.instruction(0, 0)], { states: [0, 1, 0, true, 0, 0] });
  assert.equal(stopPair.run(5), 'deadline');
  assert.equal(stopPair.left.frame.states[5], 0);
  assert.equal(stopPair.run(6), 'stopped');
  assert.equal(stopPair.left.frame.states[5], 9);
  assert.equal(stopPair.left.frame.time, 5);

  const loopPair = duet(scalarLoop());
  assert.equal(loopPair.run(1), 'deadline');
  loopPair.left.frame.stopAfterInstruction = true;
  loopPair.right.frame.stopAfterInstruction = true;
  assert.equal(loopPair.run(2), 'deadline');
  assert(loopPair.left.frame.resume > 0);
  assert.equal(loopPair.run(100), 'invalidated');
  assert.equal(loopPair.run(101), 'invalidated');

  const unknown = duet(scalarLoop(), { states: [1234, 1, 0, true, 0, 0] });
  assert.equal(unknown.run(10), 'fallback');
  assert.equal(unknown.left.frame.states[0], 1234);
  unknown.left.frame.states[0] = NaN;
  unknown.right.frame.states[0] = NaN;
  assert(unknown.run(10) instanceof TypeError);
});

test('split mode emits a shard dispatcher instead of per-instruction cases', () => {
  const instructions = scalarLoop();
  const monolithic = captureFactory(() => compileDirectJit(instructions, binding));
  const split = captureFactory(() =>
    compileDirectJit(instructions, { ...binding, split: true, shardSlotLimit: 0, shardSize: 4 }),
  );
  assert.match(monolithic, /return \(function run\(F, deadline\) \{/);
  assert.doesNotMatch(monolithic, /function stepShard/);
  assert.match(split, /function stepShard0\(F, deadline, pc\) \{/);
  assert.match(split, /function resumeShard0\(F, resume\) \{/);
  assert.match(split, /if \(status !== "next"\) return status;/);
  assert.match(split, /if \(pc <= \d+\) status = stepShard0\(F, deadline, pc\);/);
  assert.match(split, /else return "fallback";/);
  assert.match(split, /const pc = H\.checkPc\(S\[0\]\);/);
  assert.match(split, /return run;$/);
  // A shard keeps executing while the next PC stays inside its own range.
  assert.match(split, /while \(true\) \{\nswitch \(pc\) \{/);
  assert.match(
    split,
    /pc = S\[0\]; if \(!\(typeof pc === "number" && pc < Infinity && pc > -Infinity\)\) H\.checkPc\(pc\); if \(pc <= \d+(?: && pc > \d+)?\) continue; return "next";/,
  );
  const whole = compileDirectJit(instructions, binding);
  const halves = compileDirectJit(instructions, {
    ...binding,
    split: true,
    shardSlotLimit: 0,
    shardSize: 4,
  });
  assert.equal(halves.localCount, whole.localCount);
  assert.deepEqual(halves.readStates, whole.readStates);
  assert.deepEqual(halves.writeStates, whole.writeStates);
  assert.deepEqual(halves.readMemories, whole.readMemories);
  assert.deepEqual(halves.writeMemories, whole.writeMemories);
  assert(Object.isFrozen(halves));
  assert.match(generated(whole), /let v0/);
  assert.doesNotMatch(generated(halves), /let v\d/);
  assert.doesNotMatch(generated(halves), /case \d+:/);
  assert.equal(
    compileDirectJit(instructions, { ...binding, split: false }).run.toString(),
    whole.run.toString(),
  );
  assert.equal(compileDirectJit(instructions, binding).run.toString(), whole.run.toString());
});

test('shard size groups instructions into contiguous range dispatches', () => {
  const instructions = Array.from({ length: 9 }, (_, index) => {
    const b = builder();
    b.write('x', b.binary('add', b.read('x'), b.constant(1)));
    b.delay(1 + (index % 2));
    return b.instruction(index * 2, index === 8 ? 0 : (index + 1) * 2);
  });
  const source = captureFactory(() =>
    compileDirectJit(instructions, { ...binding, split: true, shardSlotLimit: 0, shardSize: 4 }),
  );
  for (const shard of [0, 1, 2]) {
    assert.match(source, new RegExp(`function stepShard${shard}\\(F, deadline, pc\\) \\{`));
    assert.match(source, new RegExp(`function resumeShard${shard}\\(F, resume\\) \\{`));
  }
  assert.doesNotMatch(source, /function stepShard3\(/);
  const dispatcher = compileDirectJit(instructions, {
    ...binding,
    split: true,
    shardSlotLimit: 0,
    shardSize: 4,
  });
  const run = generated(dispatcher);
  assert.equal(run.match(/stepShard\d+\(F, deadline, pc\)/g).length, 3);
  assert.equal(run.match(/resumeShard\d+\(F, resume\)/g).length, 3);
  assert.doesNotMatch(run, /case \d+:/);
  assert.match(run, /if \(pc <= 6\) status = stepShard0\(F, deadline, pc\);/);
  assert.match(run, /else if \(pc <= 14\) status = stepShard1\(F, deadline, pc\);/);
  assert.match(run, /else if \(pc <= 16\) status = stepShard2\(F, deadline, pc\);/);
  assert.match(run, /if \(resume <= 4\) status = resumeShard0\(F, resume\);/);
  assert.match(run, /else if \(resume <= 9\) status = resumeShard2\(F, resume\);/);
  const pair = duet(instructions, { shardSize: 4 });
  for (const deadline of [0, 1, 2, 3, 4, 6, 9, 15, 30]) pair.run(deadline);
  assert.equal(pair.left.frame.states[1], pair.right.frame.states[1]);
  assert(pair.left.frame.states[1] > 0);
});
