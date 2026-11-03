// 仅供 tsc 验证类型合同；含预期错误的调用不执行，也不是运行时验收测试。
import {
  createDeviceBuilder,
  types,
  type CreationBody,
  type DeviceBuilder,
  type JitBlockBuilder,
  type JitInstructionBuilder,
  type MemoryRef,
  type PinRef,
  type ProcessBody,
  type PureValueFunctionBody,
  type Value,
  type ValueFunctionBody,
  type BytesValue,
  type IntentValue,
} from './builder';
import {
  BuildError,
  validateBlockIR,
  validateDeviceIR,
  type BlockIR,
  type DeclarationIR,
  type DeviceIR,
  type Diagnostic,
  type OperationIR,
} from './ir';

function deviceExample(): DeviceIR {
  const device = createDeviceBuilder({ name: 'Example' });
  const mode = device.enum({ name: 'Mode', members: ['idle', 'active'] });
  const item = device.record({ name: 'Item', fields: { value: types.number, ready: types.bool } });
  device.property({ name: 'capacity', type: types.number, default: 16 });
  device.property({ name: 'mode', type: mode, default: mode.members.idle });
  device.property({ name: 'label', type: types.optional(types.string), default: null });
  device.constant({ name: 'header', type: types.bytes, value: new Uint8Array([1, 2]) });
  device.property({ name: 'optionalHeader', type: types.optional(types.bytes), default: [1, 2] });
  // @ts-expect-error The property type cannot be widened by an invalid default.
  device.property({ name: 'invalidHeader', type: types.optional(types.bytes), default: false });
  device.constant({
    name: 'optionalItem',
    type: types.optional(item),
    value: { value: 1, ready: true },
  });
  device.state({
    name: 'optionalChunk',
    type: types.optional(types.bytes),
    initial: (body) => {
      body.returnValue([1, 2]);
    },
  });
  device.derived({ name: 'optionalResult', type: types.optional(item) }, (body) => {
    body.returnValue({ value: 1, ready: true });
    // @ts-expect-error Derived return types cannot be widened by a field mismatch.
    body.returnValue({ value: false, ready: true });
  });
  device.memory({
    name: 'data',
    public: true,
    length: (body) => {
      body.returnValue(body.multiply(body.readProperty('capacity', types.number), 2));
    },
  });
  device.state({ name: 'count', type: types.number, initial: 0 });
  device.state({ name: 'modeState', type: mode, initial: mode.members.idle });
  device.pin({ name: 'probe', low: 0.8, high: 2 });
  device.pin({ name: 'supply' });
  // @ts-expect-error Logic thresholds must be provided together.
  device.pin({ name: 'incomplete', low: 0.8 });
  // @ts-expect-error A lone high threshold is also invalid.
  device.pin({ name: 'incompleteHigh', high: 2 });
  device.channel({ name: 'incoming', direction: 'input', type: item, capacity: 8 });
  device.channel({
    name: 'outgoing',
    direction: 'output',
    type: types.bytes,
    capacity: 8,
    maxLength: 64,
  });
  device.notification({ name: 'changed', direction: 'output' });
  device.pureFn(
    { name: 'positive', params: [{ name: 'value', type: types.number }], returns: types.bool },
    (body, args) => {
      body.returnValue(body.greaterThan(args.value, 0));
      // @ts-expect-error Pure functions have no instance writes.
      body.writeState('count', 1);
      // @ts-expect-error Pure functions cannot read time.
      body.now();
    },
  );
  device.fn(
    { name: 'increment', params: [{ name: 'amount', type: types.number }], returns: types.number },
    (body, args) => {
      const next = body.add(body.readState('count', types.number), args.amount);
      body.writeState('count', next);
      body.returnValue(next);
      // @ts-expect-error Value-returning functions have no void return operation.
      body.return();
      // @ts-expect-error The parameter is numeric, not boolean.
      body.not(args.amount);
    },
  );
  device.fn(
    {
      name: 'copy',
      params: [
        { name: 'buffer', type: types.memory },
        { name: 'contact', type: types.pin },
      ],
    },
    (body, args) => {
      const data: MemoryRef = args.buffer;
      const probe: PinRef = args.contact;
      body.store8(data, 0, 255);
      body.writeIntent(probe, body.resistor(body.pin('supply'), 1000));
      body.return();
      // @ts-expect-error Memory parameters cannot be used as pin references.
      body.readSample(args.buffer);
      // @ts-expect-error Void functions cannot return a numeric value.
      body.returnValue(1);
    },
  );
  device.derived({ name: 'ready', type: types.bool }, (body) => {
    body.returnValue(
      body.callPureValue('positive', types.bool, body.readState('count', types.number)),
    );
  });
  device.assert((body) => {
    body.assert(
      body.greaterThan(body.readProperty('capacity', types.number), 0),
      () => 'capacity must be positive',
    );
  });
  device.start((body) => {
    const input = body.receive('incoming', item);
    const field: Value<number> = body.field(input, 'value');
    body.writeState('count', field);
    const chunk = body.copyBytes('data', 0, 2);
    body.send('outgoing', chunk);
    body.call('copy', body.memory('data'), body.pin('probe'));
    body.wait(1000);
    body.notify('changed');
    body.return();
  });
  device.on({ name: 'observe', sourcePath: ['probe', 'sample', 'level'] }, (body) => {
    const sample = body.readSample('probe');
    const voltage = body.field(sample, 'voltage');
    body.equal(types.sampleStatus, body.field(sample, 'status'), types.sampleStatus.members.valid);
    body.equal(types.logic, body.field(sample, 'level'), types.logic.members.high);
    body.if(body.not(body.isNone(voltage)), (branch) => {
      const nonNull: Value<number> = branch.nonNull(voltage);
      branch.writeState('count', nonNull);
    });
    body.match(body.readState('modeState', mode), [
      { pattern: mode.members.idle, emit: (branch) => branch.writeState('count', 0) },
      { pattern: mode.members.active, emit: (branch) => branch.writeState('count', 1) },
    ]);
  });
  return device.finish();
}

function removedSignalExample(device: DeviceBuilder, body: ProcessBody): void {
  // @ts-expect-error Signal declarations have been removed without an alias.
  device.signal({ name: 'removed', type: types.bool, initial: true });
  // @ts-expect-error Signal reads are no longer part of runtime bodies.
  body.readSignal('removed', types.bool);
  // @ts-expect-error Signal writes are no longer part of runtime bodies.
  body.writeSignal('removed', false);
}

function operationsExample(body: ValueFunctionBody<number>): void {
  const number = body.readState('count', types.number);
  const local = body.local(types.number, number);
  body.while(
    (test) => test.lessThan(test.getLocal(local), 10),
    (loop) => {
      loop.setLocal(local, loop.add(loop.getLocal(local), 1));
    },
  );
  const value = body.select(
    types.number,
    body.lessThan(number, 0),
    (yes) => {
      yes.writeState('visitedNegative', true);
      return yes.negate(number);
    },
    () => number,
  );
  body.and(body.greaterThan(value, 0), (right) => right.callValue('check', types.bool));
  body.or(false, (right) => right.callPureValue('checkPure', types.bool));
  body.assert(true, (message) => message.concat('value: ', 'valid'));
  body.withSource({ label: 'generated arithmetic' }, (scoped) => {
    scoped.bitNot(scoped.shiftRightUnsigned(value, 2));
  });
  body.returnValue(value);
  // @ts-expect-error Locals retain their declared type.
  body.setLocal(local, false);
  // @ts-expect-error A numeric local cannot be initialized with a boolean.
  body.local(types.number, true);
  // @ts-expect-error Comparison operands are numeric.
  body.lessThan(number, false);
  // @ts-expect-error Runtime value handles are not host numbers.
  void (number + 1);
  // @ts-expect-error Conditions must be boolean.
  body.if(number, () => {});
  // @ts-expect-error The expected type controls both equality operands.
  body.equal(types.number, 1, true);
  // @ts-expect-error A synchronous function cannot receive channel messages.
  body.receive('incoming', types.number);
  body.while(
    (test) => {
      test.writeState('count', test.add(test.readState('count', types.number), 1));
      return test.callValue('step', types.bool);
    },
    () => {},
  );
  body.while(
    (test) => {
      // @ts-expect-error Condition computations must remain synchronous.
      test.elapse(1);
      return true;
    },
    () => {},
  );
  body.select(
    types.number,
    true,
    (yes) => {
      // @ts-expect-error Lazy synchronous computations cannot wait.
      yes.wait(1);
      return 1;
    },
    () => 0,
  );
  body.select(
    types.number,
    true,
    (yes) => {
      // @ts-expect-error A computation callback cannot return from the outer function.
      yes.returnValue(1);
      return 1;
    },
    () => 0,
  );
  // @ts-expect-error No boolean-to-number conversion is implied.
  body.constant(types.number, true);
}

function compoundExample(body: ProcessBody): void {
  const item = types.namedRecord('Item', { value: types.number, ready: types.bool });
  const other = types.namedRecord('Other', { value: types.number, ready: types.bool });
  const value = body.record(item, { value: 1, ready: body.constant(types.bool, true) });
  const numericField: Value<number> = body.field(value, 'value');
  const readyField: Value<boolean> = body.field(value, 'ready');
  body.constant(item, { value: 1, ready: true });
  const bytes: Value<BytesValue> = body.bytes(1, body.load8('data', 0));
  body.constant(types.bytes, [1, 255]);
  const byte: Value<number> = body.index(bytes, 0);
  const text: Value<string> = body.index(body.constant(types.string, 'abc'), 0);
  body.length(bytes);
  body.writeState('count', numericField);
  body.writeState('ready', readyField);
  body.writeState('count', byte);
  body.writeState('text', text);
  // @ts-expect-error Different record names retain distinct types.
  body.equal(other, value, value);
  // @ts-expect-error Record fields retain their types.
  body.record(item, { value: false, ready: true });
  // @ts-expect-error Missing record fields are rejected.
  body.record(item, { value: 1 });
  // @ts-expect-error Unknown record fields are rejected for object literals.
  body.record(item, { value: 1, ready: true, extra: 1 });
  // @ts-expect-error Unknown field names are rejected.
  body.field(value, 'missing');
  // @ts-expect-error Samples cannot be manually constructed as constants.
  body.constant(types.sample, {
    voltage: 1,
    level: types.logic.members.high,
    status: types.sampleStatus.members.valid,
  });
  // @ts-expect-error Board reference nodes are not device pin handles.
  body.resistor({ kind: 'ground' }, 1000);
  // @ts-expect-error Device bodies cannot construct voltage sources.
  body.drive(body.pin('probe'), 3.3, 25);
  // @ts-expect-error Memory handles cannot be resistor targets.
  body.resistor(body.memory('data'), 1000);
  // @ts-expect-error Resource references are not local values.
  body.local(types.pin, body.pin('probe'));
  // @ts-expect-error Process bodies cannot redirect.
  body.redirect(0);
  body.while(
    (test) => {
      // @ts-expect-error A process loop condition cannot wait.
      test.wait(1);
      return true;
    },
    () => {},
  );
  body.select(
    types.number,
    true,
    (branch) => {
      // @ts-expect-error Process computation callbacks cannot redirect directly.
      branch.redirect(0);
      return 0;
    },
    () => 1,
  );
}

function nullableCompoundExample(body: ProcessBody): void {
  const item = types.namedRecord('Item', { value: types.number, ready: types.bool });
  const optionalItem = types.optional(item);
  const optionalBytes = types.optional(types.bytes);
  const optionalSample = types.optional(types.sample);
  const optionalIntent = types.optional(types.intent);
  const record = body.constant(optionalItem, { value: 1, ready: true });
  const bytes = body.constant(optionalBytes, new Uint8Array([1, 2]));
  body.constant(optionalItem, null);
  body.constant(optionalBytes, null);
  const local = body.local(optionalItem, { value: 1, ready: true });
  body.setLocal(local, { value: 2, ready: false });
  body.local(optionalBytes, [1, 2]);
  body.match(record, [{ pattern: null, emit: () => {} }], () => {});
  body.equal(optionalItem, record, { value: 1, ready: true });
  body.select(
    optionalBytes,
    true,
    () => [1, 2],
    () => null,
  );
  body.constant(optionalSample, null);
  body.constant(optionalIntent, null);
  const sample = body.optional(body.readSample('probe'));
  const intent = body.optional(body.resistor('supply', 1000));
  body.if(body.not(body.isNone(record)), (branch) => {
    const value: Value<number> = branch.field(branch.nonNull(record), 'value');
    branch.writeState('count', value);
  });
  body.if(body.not(body.isNone(bytes)), (branch) => {
    const value: Value<number> = branch.index(branch.nonNull(bytes), 0);
    branch.writeState('count', value);
  });
  body.if(body.not(body.isNone(sample)), (branch) => {
    const voltage: Value<number | null> = branch.field(branch.nonNull(sample), 'voltage');
    branch.isNone(voltage);
  });
  body.if(body.not(body.isNone(intent)), (branch) => {
    branch.writeIntent('probe', branch.nonNull(intent));
  });
  // @ts-expect-error Nullable records must be narrowed before field access.
  body.field(record, 'value');
  // @ts-expect-error Nullable bytes must be narrowed before indexing.
  body.index(bytes, 0);
  // @ts-expect-error Optional record constants preserve their field types.
  body.constant(optionalItem, { value: false, ready: true });
  // @ts-expect-error Local writes cannot widen the declared nullable record type.
  body.setLocal(local, { value: false, ready: true });
  body.select(
    optionalBytes,
    true,
    // @ts-expect-error Selection callbacks cannot widen the explicit target type.
    () => false,
    () => null,
  );
  // @ts-expect-error Nullable record patterns permit none, not record contents.
  body.match(record, [{ pattern: { value: 1, ready: true }, emit: () => {} }], () => {});
  // @ts-expect-error Optional records still require every field.
  body.constant(optionalItem, { value: 1 });
  // @ts-expect-error Optional intent accepts null, not a host-constructed intent.
  body.constant(optionalIntent, []);
  // @ts-expect-error Optional sample accepts null, not a host-constructed sample.
  body.constant(optionalSample, {
    voltage: 1,
    level: types.logic.members.high,
    status: types.sampleStatus.members.valid,
  });
  // @ts-expect-error Value lifting also permits only one nullable layer.
  body.optional(bytes);
}

function enumExample(body: ProcessBody): void {
  const mode = types.namedEnum('Mode', ['idle', 'active']);
  const other = types.namedEnum('OtherMode', ['idle', 'active']);
  body.constant(mode, mode.members.idle);
  body.equal(mode, mode.members.idle, body.readState('mode', mode));
  const optionalNumber = types.optional(types.number);
  body.constant(optionalNumber, null);
  body.constant(optionalNumber, 1);
  body.optional(body.constant(types.number, 1));
  // @ts-expect-error Optional types cannot be nested.
  types.optional(optionalNumber);
  // @ts-expect-error Enum members have nominal type identity.
  body.constant(mode, other.members.idle);
  // @ts-expect-error Enum constants are not plain strings.
  body.constant(mode, 'idle');
  // @ts-expect-error Nonexistent enum members are not inferred.
  void mode.members.unknown;
}

function creationExample(body: CreationBody<number>): void {
  const input = body.readProperty('capacity', types.number);
  const local = body.local(types.number, input);
  body.if(body.greaterThan(input, 0), (branch) => branch.setLocal(local, input));
  body.returnValue(body.getLocal(local));
  // @ts-expect-error Creation cannot read runtime state.
  body.readState('count', types.number);
  // @ts-expect-error Creation cannot use random.
  body.random();
  // @ts-expect-error Creation cannot read runtime time.
  body.now();
  // @ts-expect-error Creation cannot load runtime memory.
  body.load8('data', 0);
}

function pureExample(body: PureValueFunctionBody<number>): void {
  body.returnValue(body.load8('data', 0));
  // @ts-expect-error Pure functions cannot redirect.
  body.redirect(0);
  // @ts-expect-error Pure functions cannot use random.
  body.random();
  // @ts-expect-error Pure functions cannot call ordinary functions.
  body.callValue('ordinary', types.number);
  body.while(
    (test) => {
      // @ts-expect-error Pure loop conditions cannot write resources.
      test.writeState('count', 1);
      return true;
    },
    () => {},
  );
}

function jitExample(block: JitBlockBuilder): BlockIR {
  block.instruction({ pc: 0, nextPc: 1 }, (body) => {
    const duration = body.load8('data', 0);
    body.elapse(duration);
  });
  block.instruction({ pc: 1, nextPc: 2 }, (body) => {
    body.if(
      body.readDerived('ready', types.bool),
      (yes) => {
        yes.waitUntil('ready');
      },
      (no) => no.stop(),
    );
    // @ts-expect-error JIT does not expose receive.
    body.receive('incoming', types.number);
    // @ts-expect-error JIT does not expose function return.
    body.return();
    // @ts-expect-error JIT cannot return a value from its current instruction.
    body.returnValue(1);
  });
  return block.finish();
}

function redirectExample(body: JitInstructionBuilder): void {
  body.redirect(body.readState('target', types.number), body.load8('data', 0));
}

function redirectComputeExample(body: JitInstructionBuilder): void {
  const condition = body.readState('redirectNow', types.bool);
  body.select(
    types.number,
    condition,
    (branch) => {
      branch.redirect(4);
    },
    () => 1,
  );
  body.select(
    types.number,
    condition,
    (branch) => {
      branch.if(
        condition,
        (yes) => yes.redirect(4),
        (no) => no.redirect(8),
      );
    },
    () => 1,
  );
  body.select(
    types.number,
    condition,
    (branch) => {
      branch.if(condition, (yes) => yes.redirect(4));
      return branch.add(1, 2);
    },
    () => 0,
  );
  body.and(condition, (right) => right.redirect(4));
  body.or(condition, (right) => {
    right.if(condition, (yes) => yes.redirect(4));
    return false;
  });
  body.assert(condition, (message) => {
    message.redirect(4);
  });
  body.while(
    (test) => {
      test.if(condition, (branch) => branch.redirect(4));
      return test.readState('running', types.bool);
    },
    (loop) => loop.writeState('running', false),
  );
  body.while(
    (test) => {
      test.redirect(4);
    },
    () => {},
  );
}

function strictComputeExample(
  pure: PureValueFunctionBody<number>,
  creation: CreationBody<number>,
): void {
  pure.select(
    types.number,
    true,
    // @ts-expect-error Pure selection callbacks must return an operand.
    () => {},
    () => 1,
  );
  // @ts-expect-error Pure short-circuit callbacks must return an operand.
  pure.and(true, () => {});
  // @ts-expect-error Pure short-circuit callbacks must return an operand.
  pure.or(false, () => {});
  pure.while(
    // @ts-expect-error Pure loop conditions must return an operand.
    () => {},
    () => {},
  );
  // @ts-expect-error Pure assertion messages must return an operand.
  pure.assert(false, () => {});
  creation.select(
    types.number,
    true,
    // @ts-expect-error Creation selection callbacks must return an operand.
    () => {},
    () => 1,
  );
  creation.while(
    // @ts-expect-error Creation loop conditions must return an operand.
    () => {},
    () => {},
  );
  pure.select(
    types.number,
    true,
    (branch) => {
      // @ts-expect-error Pure calculation views do not acquire redirect.
      branch.redirect(4);
      return 0;
    },
    () => 1,
  );
  creation.select(
    types.number,
    true,
    (branch) => {
      // @ts-expect-error Creation calculation views do not acquire redirect.
      branch.redirect(4);
      return 0;
    },
    () => 1,
  );
}

const rawDevice: DeviceIR = {
  kind: 'device',
  name: 'Empty',
  declarations: [],
};
const rawBlock: BlockIR = {
  kind: 'block',
  instructions: [{ pc: 0, nextPc: 1, body: { operations: [{ kind: 'stop' }] } }],
};
const deviceIR: DeviceIR = validateDeviceIR(rawDevice);
const blockIR: BlockIR = validateBlockIR(rawBlock);
const operation: OperationIR = {
  kind: 'constant',
  result: 0,
  type: { kind: 'number' },
  constant: { kind: 'number', value: -0 },
};
const removedSignalDeclaration: DeclarationIR = {
  // @ts-expect-error The IR no longer accepts signal declarations.
  kind: 'signal',
  name: 'removed',
  type: { kind: 'bool' },
  initial: { type: { kind: 'bool' }, body: { operations: [] } },
};
const removedSignalRead: OperationIR = {
  kind: 'read',
  // @ts-expect-error The IR no longer accepts signal reads.
  resource: 'signal',
  name: 'removed',
  result: 0,
  type: { kind: 'bool' },
};
const removedSignalWrite: OperationIR = {
  kind: 'write',
  // @ts-expect-error The IR no longer accepts signal writes.
  resource: 'signal',
  name: 'removed',
  value: 0,
};
const removedDrive: OperationIR = {
  // @ts-expect-error Ideal voltage sources cannot be constructed by device IR.
  kind: 'drive',
  result: 0,
  type: { kind: 'intent' },
  to: { kind: 'pin', name: 'supply' },
  voltage: 1,
  resistance: 2,
};
const invalidReference: OperationIR = {
  kind: 'resistor',
  result: 0,
  type: { kind: 'intent' },
  // @ts-expect-error Resistor targets cannot refer directly to board reference nodes.
  to: { kind: 'ground' },
  resistance: 1,
};
// @ts-expect-error IR pin thresholds must be provided together.
const incompleteThreshold: DeclarationIR = {
  kind: 'pin',
  name: 'probe',
  low: { type: { kind: 'number' }, body: { operations: [] } },
};
const diagnostic: Diagnostic = {
  code: 'IR_TYPE',
  message: 'Expected number, received bool.',
  phase: 'finalize',
  path: ['declarations', 0],
  related: [],
  source: { label: 'generated test' },
};
const error = new BuildError([diagnostic]);
// @ts-expect-error Diagnostics contain at least one item.
new BuildError([]);
// @ts-expect-error IR arrays are read-only.
rawBlock.instructions.push(rawBlock.instructions[0]);
// @ts-expect-error Source ranges require a file URI.
const source: import('./ir').SourceInfo = {
  range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
};
// @ts-expect-error Intent is not a numeric value handle.
const incompatible: Value<number> = {} as Value<IntentValue>;
void [
  deviceExample,
  removedSignalExample,
  operationsExample,
  compoundExample,
  nullableCompoundExample,
  enumExample,
  creationExample,
  pureExample,
  jitExample,
  redirectExample,
  redirectComputeExample,
  strictComputeExample,
  deviceIR,
  blockIR,
  operation,
  removedSignalDeclaration,
  removedSignalRead,
  removedSignalWrite,
  removedDrive,
  invalidReference,
  incompleteThreshold,
  error,
  source,
  incompatible,
];
