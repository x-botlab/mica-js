// Compile-only contract checks. This file is not executed and is excluded from
// the package build; `pnpm --filter @mica-js/ir typecheck` is the test runner.
import type {
  EntryRef,
  FunctionBuilder,
  FunctionRef,
  GeneratedFunctionBuilder,
  IRDeclarations,
  IRInstructionExecution,
  IRInstructionExecutor,
  IRModule,
  LifecycleRef,
  ScalarType,
  Value,
} from './index';

function expectType<T>(value: T): void {
  void value;
}

declare const api: IRDeclarations;
declare const module: IRModule;
declare const b: FunctionBuilder<readonly ['u32']>;
declare const empty: FunctionBuilder;
declare const bool: Value<'bool'>;
declare const u8: Value<'u8'>;
declare const u16: Value<'u16'>;
declare const u32: Value<'u32'>;
declare const i8: Value<'i8'>;
declare const i32: Value<'i32'>;
declare const f32: Value<'f32'>;
declare const f64: Value<'f64'>;

const count = api.state('count', 'u32', 0);
const flag = api.state('flag', 'bool', false);
const words = api.array('words', 'u16', [0, 1]);
const ram = api.bytes('ram', new Uint8Array(16), { readonly: false });
const rom = api.bytes('rom', new Uint8Array(16), { readonly: true, unitBytes: 8 });
const inbox = api.inbox('inbox', 64);
const set = api.entry('set', ['u32']);
const receive = api.entry('receive', ['u32', 'u32']);
const initialize = api.lifecycle('initialize', []);
const pair = api.func('pair', { params: ['u32'], results: ['u32', 'bool'] });

pair.body((body, [value]) => {
  body.return([value, body.const('bool', true)]);
});
receive.body((body, [offset, length]) => {
  body.bytes.copy(ram, body.const('u32', 0), inbox, offset, length);
  body.return([]);
});
initialize.body((body) => {
  body.state.store(flag, body.const('bool', true));
  body.return([]);
});

expectType<Value<'u8'>>(b.const('u8', 1));
expectType<Value<'bool'>>(b.const('bool', true));
expectType<Value<'u32'>>(b.int.add(u32, u32));
expectType<Value<'i32'>>(b.int.ashr(i32, u32));
expectType<Value<'u16'>>(b.int.zext('u16', u8));
expectType<Value<'i32'>>(b.int.sext('i32', i8));
expectType<Value<'u8'>>(b.int.trunc('u8', u32));
expectType<Value<'i32'>>(b.int.reinterpret('i32', u32));
expectType<Value<'bool'>>(b.int.cmp('lt', u32, u32));
expectType<Value<'f32'>>(b.float.fma(f32, f32, f32));
expectType<Value<'f64'>>(b.convert.intToFloat('f64', u32));
expectType<Value<'u32'>>(b.convert.floatToInt('u32', f64));
expectType<Value<'f64'>>(b.convert.float('f64', f32));
expectType<Value<'u32'>>(b.bitcast('u32', f32));
expectType<Value<'f32'>>(b.bitcast('f32', u32));
expectType<Value<'f64'>>(b.bits('f64', '0x7FF8000000001234'));
expectType<Value<'u32'>>(b.select(bool, u32, u32));
expectType<Value<'u32'>>(b.state.load(count));
expectType<Value<'u16'>>(b.array.load(words, u32));
expectType<Value<'u16'>>(b.bytes.load('u16', 'little', rom, u32));
b.state.store(flag, bool);
b.array.store(words, u32, u16);
b.bytes.store('u32', 'big', ram, u32, u32);
b.bytes.copy(ram, u32, inbox, u32, u32);

const [pairedNumber, pairedFlag] = b.call(pair, [u32]);
expectType<Value<'u32'>>(pairedNumber);
expectType<Value<'bool'>>(pairedFlag);
b.return([pairedNumber]);

const join = b.block(['u32']);
b.jump(join, [u32]);
b.branch(bool, { target: join, args: [u32] }, { target: join, args: [u32] });
b.at(join, (nested, [value]) => {
  expectType<FunctionBuilder<readonly ['u32']>>(nested);
  return nested.return([value]);
});
empty.trap('invalidState');

declare const generated: GeneratedFunctionBuilder<readonly []>;
generated.at(generated.block([]), (nested) => {
  expectType<GeneratedFunctionBuilder<readonly []>>(nested);
  return nested.return([]);
});

const led = module.domainDeclaration('led', 'status');
const setLed = module.domainInstruction('led.set', {
  operands: [
    { kind: 'static', category: 'led' },
    { kind: 'value', type: 'bool' },
  ],
  results: [],
});
b.invoke(setLed, [led, bool]);

const listInstruction = module.domainInstruction('led.lists', {
  operands: [
    { kind: 'static-list', category: 'led', minLength: 1 },
    { kind: 'value-list', type: 'bool', minLength: 1 },
  ],
  results: [],
});
b.invoke(listInstruction, [
  [led, led],
  [bool, bool],
]);
// @ts-expect-error Static-list elements must match the declared category.
b.invoke(listInstruction, [[led, u32], [bool]]);
// @ts-expect-error Value-list elements must match the declared scalar type.
b.invoke(listInstruction, [[led], [u32]]);
// @ts-expect-error A scalar operand is not an operand list.
b.invoke(listInstruction, [led, bool]);

const executor: IRInstructionExecutor = {
  op: 'led.lists',
  execute(request: IRInstructionExecution): readonly [] {
    expectType<readonly (boolean | number | object)[]>(request.operands);
    return [];
  },
};
void executor;

// @ts-expect-error A lifecycle reference is not an ordinary entry.
const lifecycleAsEntry: EntryRef<readonly []> = initialize;
void lifecycleAsEntry;
const lifecycleAsLifecycle: LifecycleRef<readonly []> = initialize;
void lifecycleAsLifecycle;
const pairAsFunction: FunctionRef<readonly ['u32'], readonly ['u32', 'bool']> = pair;
void pairAsFunction;

// Scalar names and initial values are exact.
// @ts-expect-error u64 is not a scalar type.
api.state('wide', 'u64', 0);
// @ts-expect-error A bool state cannot start from a number.
api.state('badFlag', 'bool', 1);
// @ts-expect-error Array initial values follow the element type.
api.array('badWords', 'u16', [true]);
// @ts-expect-error Blocks only accept declared scalar types.
b.block(['u64']);

// Operand categories and layouts are exact.
// @ts-expect-error An SSA handle is not a constant literal.
b.const('u32', u32);
// @ts-expect-error Integer operations do not silently widen.
b.int.add(u8, u32);
// @ts-expect-error Float operands must share one type.
b.float.add(f32, f64);
// @ts-expect-error FMA keeps all three operands at one type.
b.float.fma(f32, f32, f64);
// @ts-expect-error Boolean operations only accept bool.
b.bool.and(u32, bool);
// @ts-expect-error Shift counts are u32.
b.int.shl(u32, u8);
// @ts-expect-error Arithmetic right shift requires a signed value.
b.int.ashr(u32, u32);
// @ts-expect-error zext must widen.
b.int.zext('u8', u32);
// @ts-expect-error sext requires a signed source.
b.int.sext('i32', u8);
// @ts-expect-error trunc must narrow.
b.int.trunc('u32', u8);
// @ts-expect-error reinterpret only changes sign at equal width.
b.int.reinterpret('i16', u32);
// @ts-expect-error bitcast cannot replace integer reinterpretation.
b.bitcast('i32', u32);
// @ts-expect-error No integer representation matching f64 exists in core.
b.bitcast('u32', f64);
// @ts-expect-error Select candidates must share one type.
b.select(bool, u8, u32);
// @ts-expect-error State store type is fixed by the resource.
b.state.store(count, bool);
// @ts-expect-error Array element type is fixed by the declaration.
b.array.store(words, u32, u32);
// @ts-expect-error A state reference is not an array reference.
b.array.load(count, u32);
// @ts-expect-error A byte region does not directly encode bool.
b.bytes.load('bool', 'little', ram, u32);
// @ts-expect-error A read-only region rejects ordinary writes.
b.bytes.store('u32', 'little', rom, u32, u32);
// @ts-expect-error An inbox cannot be an ordinary write destination.
b.bytes.copy(inbox, u32, ram, u32, u32);
// @ts-expect-error Byte store values must match the operation type.
b.bytes.store('u16', 'little', ram, u32, u32);
// @ts-expect-error Endianness is explicit.
b.bytes.load('u16', 'middle', ram, u32);
// @ts-expect-error Byte offsets are u32.
b.bytes.load('u16', 'little', ram, u8);
// @ts-expect-error Only ordinary functions are synchronously callable.
b.call(set, [u32]);
// @ts-expect-error Call arguments follow the target layout.
b.call(pair, [bool]);
// @ts-expect-error Return layout is fixed by the current function.
b.return([bool]);
// @ts-expect-error Entry callbacks have no results.
set.body((body, [value]) => body.return([value]));
// @ts-expect-error Every block parameter needs an argument.
b.jump(join, []);
// @ts-expect-error Branch edges cannot change the block parameter type.
b.branch(bool, { target: join, args: [bool] }, { target: join, args: [u32] });
// @ts-expect-error Trap codes are strings.
b.trap(1);

// Lifecycle and ordinary entry categories stay distinct.
// @ts-expect-error A lifecycle reference is not an ordinary entry.
const wrongEntry: EntryRef<readonly []> = initialize;
void wrongEntry;
// @ts-expect-error An ordinary entry is not a lifecycle reference.
const wrongLifecycle: LifecycleRef<readonly []> = set;
void wrongLifecycle;
// @ts-expect-error Lifecycle refs cannot replace ordinary function refs.
b.call(initialize, []);

// Domain operands are checked by category and scalar type.
// @ts-expect-error A normal resource is not a led declaration.
b.invoke(setLed, [words, bool]);
// @ts-expect-error A bool operand is not a u32.
b.invoke(setLed, [led, u32]);
// @ts-expect-error Every instruction operand is required.
b.invoke(setLed, [led]);
// @ts-expect-error Instruction results are declared by the domain.
module.domainInstruction('bad', { operands: [], results: ['u64'] });

// Construction callbacks must be synchronous; generators do not run inline.
// @ts-expect-error Async body callbacks are rejected.
pair.body(async () => {});
// @ts-expect-error Generator body callbacks are rejected.
pair.body(function* () {
  yield undefined;
  return undefined;
});
// @ts-expect-error Async entry body callbacks are rejected.
initialize.body(async () => {});
// @ts-expect-error Nested block callbacks must also be synchronous.
b.at(join, async () => {});

// Keep the scalar type import meaningful for declaration checking.
const scalar: ScalarType = 'u32';
void scalar;
