import assert from 'node:assert/strict';
import test from 'node:test';
import { compileBody, compileSynchronousBody } from '../dist/index.js';

/**
 * Differential tests: every supported synchronous body must perform exactly the generic
 * generator body's device-visible operations, in the same order, with the same values and
 * failure prefix. Function-call entries are intentionally not part of the comparison: the
 * synchronous compiler replaces `host.call`/delegate with direct calls.
 */

let nextResultId = 0;

function regionBuilder() {
  const operations = [];
  const value = (operation, type = 'number') => {
    const result = nextResultId++;
    operations.push({ ...operation, result, type: { kind: type } });
    return result;
  };
  const op = (operation) => {
    operations.push(operation);
  };
  return {
    operations,
    value,
    op,
    constant: (literal) =>
      value(
        {
          kind: 'constant',
          constant:
            typeof literal === 'boolean'
              ? { kind: 'bool', value: literal }
              : { kind: 'number', value: literal },
        },
        typeof literal === 'boolean' ? 'bool' : 'number',
      ),
    read: (name, type = 'number', resource = 'state') =>
      value({ kind: 'read', resource, name }, type),
    write: (name, valueId) => op({ kind: 'write', resource: 'state', name, value: valueId }),
    binary: (operator, left, right, type = 'number') =>
      value({ kind: 'binary', operator, left, right }, type),
    unary: (operator, input, type = 'number') =>
      value({ kind: 'unary', operator, value: input }, type),
    local: (id, initial, type = 'number') =>
      op({ kind: 'local', local: id, type: { kind: type }, initial }),
    localRead: (id, type = 'number') => value({ kind: 'localRead', local: id }, type),
    localWrite: (id, input) => op({ kind: 'localWrite', local: id, value: input }),
    call: (name, args = [], pure = false) =>
      op({
        kind: 'call',
        name,
        pure,
        args: args.map((arg) => (typeof arg === 'object' ? arg : { kind: 'value', value: arg })),
      }),
    callValue: (name, args = [], pure = false) =>
      value(
        {
          kind: 'callValue',
          name,
          pure,
          args: args.map((arg) => (typeof arg === 'object' ? arg : { kind: 'value', value: arg })),
        },
        'number',
      ),
    readSample: (pin) => value({ kind: 'readSample', pin: { kind: 'pin', name: pin } }, 'sample'),
    writeIntent: (pin, valueId) =>
      op({ kind: 'writeIntent', pin: { kind: 'pin', name: pin }, value: valueId }),
    resistor: (pin, resistance) =>
      value({ kind: 'resistor', to: { kind: 'pin', name: pin }, resistance }, 'intent'),
    load16le: (memory, offset) =>
      value({ kind: 'load16le', memory: { kind: 'memory', name: memory }, offset }),
    store16le: (memory, offset, valueId) =>
      op({
        kind: 'store16le',
        memory: { kind: 'memory', name: memory },
        offset,
        value: valueId,
      }),
    copyBytes: (memory, offset, length) =>
      value(
        { kind: 'copyBytes', memory: { kind: 'memory', name: memory }, offset, length },
        'bytes',
      ),
    send: (channel, valueId) => op({ kind: 'send', channel, value: valueId }),
    now: () => value({ kind: 'now' }),
    reactionValue: (binding, type = 'number') => value({ kind: 'reactionValue', binding }, type),
    reactionCapture: (index, type = 'number') => value({ kind: 'reactionCapture', index }, type),
    if: (condition, yes, no) => op({ kind: 'if', condition, yes, no }),
    while: (test, body) =>
      op({ kind: 'while', test: { type: { kind: 'bool' }, body: test }, body }),
    returnValue: (valueId) => op({ kind: 'returnValue', value: valueId }),
    return: () => op({ kind: 'return' }),
    yield: (valueId) => op({ kind: 'yield', value: valueId }),
    wait: (duration) => op({ kind: 'wait', duration }),
    elapse: (duration) => op({ kind: 'elapse', duration }),
    redirect: (target, delay) => op({ kind: 'redirect', target, delay }),
    stop: () => op({ kind: 'stop' }),
    assert: (condition, message) => op({ kind: 'assert', condition, message }),
  };
}

function block(build) {
  const b = regionBuilder();
  build(b);
  return { operations: b.operations };
}

function makeHost(initial = {}, options = {}) {
  const state = new Map(Object.entries(initial.states ?? {}));
  const memories = new Map();
  for (const [name, bytes] of Object.entries(initial.memories ?? {}))
    memories.set(name, Uint8Array.from(bytes));
  const samples = new Map(Object.entries(initial.samples ?? {}));
  const constants = new Map(Object.entries(initial.constants ?? {}));
  const entries = [];
  const functions = initial.functions ?? new Map();
  let bindCalls = 0;
  const host = {
    entries,
    state,
    memories,
    bindCalls: () => bindCalls,
    effects: () => entries.filter((entry) => entry[0] !== 'call'),
    read(kind, name) {
      entries.push(['read', kind, name]);
      if (kind === 'const' || kind === 'property') {
        if (!constants.has(name)) throw new Error(`Unknown ${kind} ${name}`);
        return constants.get(name);
      }
      return state.get(name);
    },
    write(name, value) {
      entries.push(['write', name, value]);
      if (!state.has(name)) throw new Error(`Unknown state ${name}`);
      state.set(name, value);
    },
    sample(pin) {
      entries.push(['sample', pin]);
      if (!samples.has(pin)) throw new Error(`Unknown pin ${pin}`);
      return samples.get(pin);
    },
    intent(pin, value) {
      entries.push(['intent', pin, value]);
    },
    resistor(pin, resistance) {
      entries.push(['resistor', pin, resistance]);
      if (!samples.has(pin)) throw new Error(`Unknown pin ${pin}`);
      return Object.freeze([{ pin, resistance }]);
    },
    load(kind, memory, offset) {
      entries.push(['load', kind, memory, offset]);
      const bytes = memories.get(memory);
      if (!bytes) throw new Error(`Unknown memory ${memory}`);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const size = kind.startsWith('load8') ? 1 : kind.startsWith('load16') ? 2 : 4;
      if (!Number.isInteger(offset) || offset < 0 || offset + size > bytes.length)
        throw new RangeError('Memory range is out of bounds');
      if (size === 1) return bytes[offset];
      return size === 2
        ? view.getUint16(offset, kind.endsWith('le'))
        : view.getUint32(offset, kind.endsWith('le'));
    },
    store(kind, memory, offset, stored) {
      entries.push(['store', kind, memory, offset, stored]);
      const bytes = memories.get(memory);
      if (!bytes) throw new Error(`Unknown memory ${memory}`);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const size = kind.startsWith('store8') ? 1 : kind.startsWith('store16') ? 2 : 4;
      if (!Number.isInteger(offset) || offset < 0 || offset + size > bytes.length)
        throw new RangeError('Memory range is out of bounds');
      if (size === 1) bytes[offset] = stored;
      else if (size === 2) view.setUint16(offset, stored, kind.endsWith('le'));
      else view.setUint32(offset, stored, kind.endsWith('le'));
    },
    copyBytes(memory, offset, length) {
      entries.push(['copyBytes', memory, offset, length]);
      const bytes = memories.get(memory);
      if (!bytes) throw new Error(`Unknown memory ${memory}`);
      return bytes.slice(offset, offset + length);
    },
    memoryLength(memory) {
      entries.push(['memoryLength', memory]);
      const bytes = memories.get(memory);
      if (!bytes) throw new Error(`Unknown memory ${memory}`);
      return bytes.length;
    },
    send(channel, value) {
      entries.push(['send', channel, value]);
    },
    notify(notification) {
      entries.push(['notify', notification]);
    },
    now() {
      entries.push(['now']);
      return 17;
    },
    random() {
      entries.push(['random']);
      return 0.25;
    },
    assert(condition, message) {
      entries.push(['assert', condition, message]);
      if (condition !== true)
        throw new Error(message === undefined ? 'Assertion failed' : String(message));
    },
    call(name, args) {
      entries.push(['call', name]);
      if (options.noCall) throw new Error(`Unexpected host.call ${name}`);
      const fn = functions.get(name);
      if (fn === undefined) throw new Error(`Unknown function ${name}`);
      return compileBody(fn)(host, args);
    },
    bind(specs) {
      bindCalls += 1;
      return specs.map(([kind, name]) => {
        if (kind === 'state') {
          return {
            read: () => host.read('state', name),
            write: (value) => host.write(name, value),
          };
        }
        if (kind === 'pin') {
          return {
            sample: () => host.sample(name),
            intent: (value) => host.intent(name, value),
            resistor: (resistance) => host.resistor(name, resistance),
          };
        }
        return {
          load8: (offset) => host.load('load8', name, offset),
          load16le: (offset) => host.load('load16le', name, offset),
          load16be: (offset) => host.load('load16be', name, offset),
          load32le: (offset) => host.load('load32le', name, offset),
          load32be: (offset) => host.load('load32be', name, offset),
          store8: (offset, value) => host.store('store8', name, offset, value),
          store16le: (offset, value) => host.store('store16le', name, offset, value),
          store16be: (offset, value) => host.store('store16be', name, offset, value),
          store32le: (offset, value) => host.store('store32le', name, offset, value),
          store32be: (offset, value) => host.store('store32be', name, offset, value),
          length: () => host.memoryLength(name),
          copy: (offset, length) => host.copyBytes(name, offset, length),
        };
      });
    },
  };
  return host;
}

function runGenerator(region, options) {
  const host = makeHost(options);
  const execution = compileBody(region)(host, options.args ?? [], options.reaction);
  const step = execution.next();
  assert.equal(step.done, true, 'generator body completed');
  return { host, value: step.value };
}

function runSync(region, options) {
  const host = makeHost({ ...options, noCall: true });
  const program = compileSynchronousBody(region, {
    resolveFunction: (name) => options.functions?.get(name),
  });
  assert.ok(program, 'synchronous program compiled');
  const runner = program.bind(host);
  let value;
  let error;
  try {
    value = runner(options.args ?? [], options.reaction);
  } catch (cause) {
    error = cause;
  }
  return { host, value, error, program };
}

function compare(region, options) {
  const generic = runGenerator(region, options);
  const sync = runSync(region, options);
  assert.deepEqual(sync.host.effects(), generic.host.effects(), 'same ordered host effects');
  assert.deepEqual([...sync.host.state], [...generic.host.state], 'same state');
  for (const [name, bytes] of generic.host.memories)
    assert.deepEqual([...sync.host.memories.get(name)], [...bytes], `same memory ${name}`);
  assert.deepEqual(sync.value, generic.value, 'same return value');
  return { generic, sync };
}

test('synchronous body matches generator control flow, locals and returnValue', () => {
  const b = regionBuilder();
  const zero = b.constant(0);
  b.local(0, zero);
  const test = block((condition) => {
    const i = condition.localRead(0);
    const three = condition.constant(3);
    condition.yield(condition.binary('lessThan', i, three));
  });
  const body = block((loop) => {
    const n = loop.read('n');
    loop.write('n', loop.binary('add', n, loop.constant(2)));
    const current = loop.localRead(0);
    loop.localWrite(0, loop.binary('add', current, loop.constant(1)));
  });
  b.while(test, body);
  b.returnValue(b.read('n'));
  const region = { operations: b.operations };
  const result = compare(region, { states: { n: 4 } });
  assert.equal(result.sync.value, 10);
  assert.equal(result.sync.host.state.get('n'), 10);
});

test('synchronous calls are direct and preserve args, returns and call order', () => {
  const add = block((b) => {
    const a = b.value({ kind: 'parameter', index: 0 });
    const c = b.value({ kind: 'parameter', index: 1 });
    b.returnValue(b.binary('add', a, c));
  });
  const twice = block((b) => {
    const value = b.value({ kind: 'parameter', index: 0 });
    const call = b.callValue('add', [value, value]);
    b.returnValue(call);
  });
  const b = regionBuilder();
  const a = b.constant(5);
  const c = b.constant(9);
  const sum = b.callValue('add', [a, c]);
  const doubled = b.callValue('twice', [sum]);
  b.send('out', doubled);
  const functions = new Map([
    ['add', add],
    ['twice', twice],
  ]);
  const result = compare({ operations: b.operations }, { functions });
  assert.deepEqual(
    result.sync.host.entries.filter((entry) => entry[0] === 'send'),
    [['send', 'out', 28]],
  );
  assert.deepEqual(result.sync.program.functions, ['add', 'twice']);
  assert.equal(result.sync.host.bindCalls() > 0, false, 'this body has no fixed resources');
});

test('recursive and mutually recursive call graphs fail closed', () => {
  const recursive = block((b) => {
    const n = b.value({ kind: 'parameter', index: 0 });
    const zero = b.constant(0);
    const positive = b.binary('greaterThan', n, zero);
    b.if(
      positive,
      block((yes) => {
        const next = yes.binary('subtract', n, yes.constant(1));
        yes.returnValue(yes.callValue('recursive', [next]));
      }),
      block((no) => no.returnValue(no.constant(7))),
    );
  });
  const root = regionBuilder();
  root.send('out', root.callValue('recursive', [root.constant(3)]));
  assert.equal(
    compileSynchronousBody(
      { operations: root.operations },
      { resolveFunction: (name) => (name === 'recursive' ? recursive : undefined) },
    ),
    undefined,
  );

  const mutualA = block((b) => {
    b.returnValue(b.callValue('mutualB', []));
  });
  const mutualB = block((b) => {
    b.returnValue(b.callValue('mutualA', []));
  });
  const mutualRoot = regionBuilder();
  mutualRoot.call('mutualA');
  const functions = new Map([
    ['mutualA', mutualA],
    ['mutualB', mutualB],
  ]);
  assert.equal(
    compileSynchronousBody(
      { operations: mutualRoot.operations },
      { resolveFunction: (name) => functions.get(name) },
    ),
    undefined,
  );
});

test('reaction previous, current and captures match the generator', () => {
  const b = regionBuilder();
  const previous = b.reactionValue('previous');
  const current = b.reactionValue('current');
  const captured = b.reactionCapture(0);
  b.send('previous', previous);
  b.send('current', current);
  b.send('captured', captured);
  const region = { operations: b.operations };
  const reaction = { previous: 2, current: 5, captures: [11] };
  const result = compare(region, { reaction });
  assert.deepEqual(
    result.sync.host.entries.filter((entry) => entry[0] === 'send'),
    [
      ['send', 'previous', 2],
      ['send', 'current', 5],
      ['send', 'captured', 11],
    ],
  );
});

test('callees do not inherit the reaction frame', () => {
  const probe = block((b) => {
    b.send('calleeCurrent', b.reactionValue('current'));
  });
  const root = regionBuilder();
  root.call('probe');
  const functions = new Map([['probe', probe]]);
  const frame = { previous: 1, current: 2, captures: [] };
  const program = compileSynchronousBody(
    { operations: root.operations },
    { resolveFunction: (name) => functions.get(name) },
  );
  assert.ok(program);

  const genericHost = makeHost({ functions });
  const generic = compileBody({ operations: root.operations })(genericHost, [], frame);
  assert.throws(() => generic.next(), /Reaction value requires a reaction frame/u);

  const syncHost = makeHost({ functions, noCall: true });
  assert.throws(
    () => program.bind(syncHost)([], frame),
    /Reaction value requires a reaction frame/u,
  );
});

test('state, memory, pins, intents, resistors and copies use the same operations', () => {
  const b = regionBuilder();
  const offset = b.constant(1);
  const value = b.constant(0x1234);
  b.store16le('ram', offset, value);
  const loaded = b.load16le('ram', offset);
  b.send('loaded', loaded);
  const pin = b.readSample('line');
  const intent = b.resistor('line', b.constant(1000));
  b.writeIntent('line', intent);
  b.send('flipped', pin);
  const copied = b.copyBytes('ram', offset, b.constant(2));
  b.send('copyLength', b.value({ kind: 'length', value: copied }, 'number'));
  const region = { operations: b.operations };
  const result = compare(region, {
    states: { n: 0 },
    memories: { ram: new Uint8Array(8) },
    samples: { line: { level: 'high', voltage: 3.3, status: 'valid' } },
  });
  assert.equal(result.sync.value, undefined);
  assert.deepEqual([...result.sync.host.memories.get('ram')], [0, 0x34, 0x12, 0, 0, 0, 0, 0]);
});

test('resource parameters in compiled callees keep generic host calls', () => {
  const readPin = block((b) => {
    const pin = b.value(
      { kind: 'readSample', pin: { kind: 'parameter', resource: 'pin', index: 0 } },
      'sample',
    );
    b.returnValue(pin);
  });
  const readMemory = block((b) => {
    const offset = b.constant(0);
    const value = b.value(
      {
        kind: 'load16le',
        memory: { kind: 'parameter', resource: 'memory', index: 0 },
        offset,
      },
      'number',
    );
    b.returnValue(value);
  });
  const b = regionBuilder();
  const sampled = b.callValue('readPin', [{ kind: 'pin', name: 'line' }]);
  const loaded = b.callValue('readMemory', [{ kind: 'memory', name: 'ram' }]);
  b.send('sample', sampled);
  b.send('loaded', loaded);
  const functions = new Map([
    ['readPin', readPin],
    ['readMemory', readMemory],
  ]);
  const result = compare(
    { operations: b.operations },
    {
      functions,
      states: { n: 0 },
      memories: { ram: Uint8Array.from([0x34, 0x12]) },
      samples: { line: { level: 'high', voltage: 3.3, status: 'valid' } },
    },
  );
  assert.deepEqual(
    result.sync.host.entries.filter((entry) => entry[0] === 'send'),
    [
      ['send', 'sample', { level: 'high', voltage: 3.3, status: 'valid' }],
      ['send', 'loaded', 0x1234],
    ],
  );
});

test('a resource name error stays at its operation and is not raised by bind', () => {
  const missing = block((b) => {
    const offset = b.constant(0);
    const value = b.load16le('absent', offset);
    b.send('value', value);
  });
  const b = regionBuilder();
  const flag = b.read('flag', 'bool');
  b.if(
    flag,
    missing,
    block((no) => no.send('skipped', no.constant(1))),
  );
  const region = { operations: b.operations };
  const program = compileSynchronousBody(region, {
    resolveFunction: () => undefined,
  });
  assert.ok(program);
  const host = makeHost({ states: { flag: false } });
  const runner = program.bind(host);
  assert.equal(host.bindCalls(), 1, 'binding is lazy and succeeds');
  assert.equal(host.entries.length, 0, 'binding performs no resource operation');
  runner();
  assert.deepEqual(
    host.entries.filter((entry) => entry[0] === 'send'),
    [['send', 'skipped', 1]],
  );
  const failingHost = makeHost({ states: { flag: true } });
  const failing = program.bind(failingHost);
  assert.throws(() => failing(), /Unknown memory absent/u);
});

test('a compiled function failure preserves the prefix and the original error', () => {
  const explode = block((b) => {
    const one = b.constant(1);
    b.write('marker', one);
    const offset = b.constant(0);
    b.load16le('absent', offset);
  });
  const b = regionBuilder();
  b.call('explode');
  const functions = new Map([['explode', explode]]);
  const program = compileSynchronousBody(
    { operations: b.operations },
    { resolveFunction: (name) => functions.get(name) },
  );
  assert.ok(program);
  const syncHost = makeHost({ states: { marker: 0 }, noCall: true });
  assert.throws(() => program.bind(syncHost)(), /Unknown memory absent/u);
  assert.equal(syncHost.state.get('marker'), 1, 'successful prefix persisted');

  const genericHost = makeHost({ states: { marker: 0 }, functions });
  const generic = compileBody({ operations: b.operations })(genericHost, []);
  assert.throws(() => generic.next(), /Unknown memory absent/u);
  assert.equal(genericHost.state.get('marker'), 1);
  assert.deepEqual(syncHost.effects(), genericHost.effects(), 'same prefix before the failure');
});

test('unsupported suspension, redirect, stop and unresolved calls reject the whole body', () => {
  const directWait = regionBuilder();
  directWait.wait(directWait.constant(1));
  assert.equal(compileSynchronousBody({ operations: directWait.operations }), undefined);

  const directStop = regionBuilder();
  directStop.stop();
  assert.equal(compileSynchronousBody({ operations: directStop.operations }), undefined);

  const directRedirect = regionBuilder();
  directRedirect.redirect(directRedirect.constant(1), directRedirect.constant(2));
  assert.equal(compileSynchronousBody({ operations: directRedirect.operations }), undefined);

  const caller = regionBuilder();
  caller.call('missing');
  assert.equal(compileSynchronousBody({ operations: caller.operations }), undefined);

  const slow = block((b) => b.elapse(b.constant(1)));
  const transitive = regionBuilder();
  transitive.call('slow');
  assert.equal(
    compileSynchronousBody(
      { operations: transitive.operations },
      { resolveFunction: (name) => (name === 'slow' ? slow : undefined) },
    ),
    undefined,
  );
});

test('a host without bind still gets a synchronous runner with generic host operations', () => {
  const b = regionBuilder();
  const n = b.read('n');
  b.write('n', b.binary('add', n, b.constant(1)));
  b.send('n', b.read('n'));
  const region = { operations: b.operations };
  const host = makeHost({ states: { n: 4 } });
  delete host.bind;
  const program = compileSynchronousBody(region);
  assert.ok(program);
  const runner = program.bind(host);
  assert.equal(runner(), undefined);
  assert.equal(host.state.get('n'), 5);
  assert.deepEqual(host.entries.at(-1), ['send', 'n', 5]);
});

test('bindResources:false keeps the generic host path even when bind exists', () => {
  const b = regionBuilder();
  const n = b.read('n');
  b.write('n', b.binary('add', n, b.constant(1)));
  b.send('n', b.read('n'));
  const region = { operations: b.operations };
  const host = makeHost({ states: { n: 4 } });
  const program = compileSynchronousBody(region, { bindResources: false });
  assert.ok(program);
  assert.deepEqual(program.resources, [[]]);
  assert.equal(program.source.includes('F.h'), false, 'no handle accesses are emitted');
  const runner = program.bind(host);
  runner();
  assert.equal(host.bindCalls(), 0, 'the switch suppresses host.bind');
  assert.equal(host.state.get('n'), 5);
  assert.deepEqual(
    host.entries.map(([kind]) => kind),
    ['read', 'write', 'read', 'send'],
  );
});

test('one program binds independent handles for two instances', () => {
  const add = block((b) => {
    const value = b.value({ kind: 'parameter', index: 0 });
    b.returnValue(b.binary('add', value, b.constant(10)));
  });
  const b = regionBuilder();
  b.send('result', b.callValue('add', [b.read('n')]));
  const program = compileSynchronousBody(
    { operations: b.operations },
    { resolveFunction: (name) => (name === 'add' ? add : undefined) },
  );
  assert.ok(program);
  const first = makeHost({ states: { n: 1 } });
  const second = makeHost({ states: { n: 20 } });
  program.bind(first)();
  program.bind(second)();
  assert.equal(first.state.get('n'), 1, 'reads do not mutate state');
  assert.equal(second.state.get('n'), 20);
  assert.deepEqual(
    first.entries.filter((entry) => entry[0] === 'send'),
    [['send', 'result', 11]],
  );
  assert.deepEqual(
    second.entries.filter((entry) => entry[0] === 'send'),
    [['send', 'result', 30]],
  );
});
