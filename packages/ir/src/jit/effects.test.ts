import { describe, expect, it } from 'vitest';
import { CORE_INSTRUCTION_NAMES } from '../builder';
import { prepareEngine } from '../engine-setup';
import { createIRModule } from '../index';
import type { IRModule, ProviderRef } from '../types';
import type { IRValidationOptions } from '../validation-types';
import {
  computeEffects,
  computeFunctionSummary,
  computeSummaries,
  Effect,
  returnRepresentations,
} from './effects';
import { createLowerContext, lowerFunction, Op } from './mir';
import type { MInst } from './mir';
import { analyzeRepresentation } from './repr';

function policy(module: IRModule): IRValidationOptions {
  const instructions = [...CORE_INSTRUCTION_NAMES, ...module.instructions.map((item) => item.name)];
  return {
    supportedInstructions: instructions,
    authorizedInstructions: instructions,
    validators: module.instructions.map((item) => ({ op: item.name, validate: () => [] })),
    resources: module.memories.map((memory) => ({
      ref: memory.ref,
      access: memory.writable ? 'read-write' : 'read',
    })),
  };
}

function fake(op: Op): MInst {
  return { op, args: [], results: [], imm: [], refs: [], node: undefined, loc: 0, step: 1 };
}

const ALL = [
  Effect.MemoryRead,
  Effect.MemoryWrite,
  Effect.ScalarRead,
  Effect.ScalarWrite,
  Effect.Event,
  Effect.Output,
  Effect.VersionedRead,
  Effect.Throws,
];

describe('instruction effects', () => {
  it.each([
    Op.Const,
    Op.BoolNot,
    Op.BoolAnd,
    Op.BoolOr,
    Op.BoolXor,
    Op.IntAdd,
    Op.IntSub,
    Op.IntMul,
    Op.IntAnd,
    Op.IntOr,
    Op.IntXor,
    Op.IntNot,
    Op.IntShl,
    Op.IntLshr,
    Op.IntAshr,
    Op.IntCmp,
    Op.IntZext,
    Op.IntSext,
    Op.IntTrunc,
    Op.IntReinterpret,
    Op.FloatAdd,
    Op.FloatSub,
    Op.FloatMul,
    Op.FloatDiv,
    Op.FloatFma,
    Op.FloatCmp,
    Op.FloatIsNaN,
    Op.FloatIsFinite,
    Op.ConvertIntToFloat,
    Op.ConvertFloat,
    Op.Bitcast,
    Op.Select,
  ])('%s is pure', (op) => {
    expect(computeEffects(fake(op))).toEqual([]);
  });

  it.each([Op.IntDiv, Op.IntRem, Op.ConvertFloatToInt, Op.Check])('%s can throw', (op) => {
    expect(computeEffects(fake(op))).toEqual([Effect.Throws]);
  });

  it.each([
    [Op.StateLoad, [Effect.ScalarRead]],
    [Op.StateStore, [Effect.ScalarWrite, Effect.Throws]],
    [Op.ArrayLoad, [Effect.MemoryRead, Effect.Throws]],
    [Op.ArrayStore, [Effect.MemoryWrite, Effect.Throws]],
    [Op.BytesLoad, [Effect.MemoryRead, Effect.VersionedRead, Effect.Throws]],
    [Op.BytesStore, [Effect.MemoryWrite, Effect.Throws]],
    [Op.BytesCopy, [Effect.MemoryRead, Effect.MemoryWrite, Effect.VersionedRead, Effect.Throws]],
    [
      Op.ResourceUpdateBytes,
      [Effect.MemoryRead, Effect.MemoryWrite, Effect.VersionedRead, Effect.Throws],
    ],
    [Op.ResourceFillBytes, [Effect.MemoryWrite, Effect.Throws]],
    [Op.Spill, []],
  ])('%s has storage effects', (op, expected) => {
    expect(computeEffects(fake(op))).toEqual(expected);
  });

  it.each([
    Op.Executor,
    Op.EventNow,
    Op.EventAt,
    Op.EventCancel,
    Op.BridgeSend,
    Op.BridgeSendBytes,
  ])('%s is host code with all effects', (op) => {
    expect(computeEffects(fake(op))).toEqual(ALL);
  });

  it('treats a checkpoint as a host transfer and an unknown call conservatively', () => {
    expect(computeEffects(fake(Op.Checkpoint))).toEqual(ALL);
    expect(computeEffects(fake(Op.Call))).toEqual(ALL);
    const callee = {
      functionIndex: 0,
      effects: [Effect.ScalarRead],
      reads: [Effect.ScalarRead],
      writes: [],
      throws: false,
      host: false,
      hasTransfer: false,
      recursive: false,
      resultReps: [],
    };
    expect(computeEffects(fake(Op.Call), callee)).toEqual([Effect.ScalarRead]);
  });
});

function summariesFixture() {
  const module = createIRModule();
  const counter = module.state('counter', 'u32', 0);
  const ram = module.bytes('ram', new Uint8Array(4), { readonly: false });
  const probe = module.domainInstruction('probe.read', { operands: [], results: ['u32'] });
  const pure = module.func('pure', { params: ['u32'], results: ['u32'] });
  pure.body((b, [value]) => b.return([b.int.add(value, b.const('u32', 1))]));
  const caller = module.func('caller', { params: ['u32'], results: ['u32'] });
  caller.body((b, [value]) => b.return([b.call(pure, [value])[0]!]));
  const host = module.func('host', { params: [], results: ['u32'] });
  host.body((b) => b.return([b.invoke(probe, [])[0]!]));
  const writer = module.func('writer', { params: ['u32'], results: [] });
  writer.body((b, [value]) => {
    b.state.store(counter, value);
    b.return([]);
  });
  const reader = module.func('reader', { params: [], results: ['u32'] });
  reader.body((b) => b.return([b.bytes.load('u32', 'little', ram, b.const('u32', 0))]));
  const checkpointer = module.provider(
    'recovery',
    { keyTypes: ['u32'], params: [], results: ['u32'], reads: [], imports: [] },
    (gen) => gen.function((b) => b.return([b.const('u32', 0)])),
  );
  const code = module.provider(
    'code',
    { keyTypes: ['u32'], params: [], results: ['u32'], reads: [], imports: [checkpointer] },
    (gen) =>
      gen.function((b) => {
        b.checkpoint(checkpointer, [b.const('u32', 1)], []);
        b.return([b.const('u32', 2)]);
      }),
  );
  const dispatcher = module.func('dispatcher', { params: [], results: ['u32'] });
  dispatcher.body((b) => b.dispatch(checkpointer, [b.const('u32', 3)], []));
  const transitive = module.func('transitive', { params: ['u32'], results: ['u32'] });
  transitive.body((b) => b.return([b.call(caller, [b.call(host, [])[0]!])[0]!]));
  return {
    module,
    counter,
    pure,
    caller,
    host,
    writer,
    reader,
    checkpointer,
    code,
    dispatcher,
    transitive,
  };
}

describe('function summaries', () => {
  it('propagates effects through calls and marks host code', () => {
    const fixture = summariesFixture();
    const context = createLowerContext(fixture.module, ['probe.read']);
    const mir = {
      pure: lowerFunction(context, fixture.pure),
      caller: lowerFunction(context, fixture.caller),
      host: lowerFunction(context, fixture.host),
      writer: lowerFunction(context, fixture.writer),
      reader: lowerFunction(context, fixture.reader),
      dispatcher: lowerFunction(context, fixture.dispatcher),
      transitive: lowerFunction(context, fixture.transitive),
    };
    const summaries = computeSummaries(Object.values(mir));

    expect(summaries.get(mir.pure.functionIndex)).toMatchObject({
      effects: [],
      throws: false,
      host: false,
      hasTransfer: false,
      recursive: false,
    });
    expect(summaries.get(mir.caller.functionIndex)).toMatchObject({
      effects: [],
      host: false,
      throws: false,
    });
    expect(summaries.get(mir.host.functionIndex)).toMatchObject({
      effects: ALL,
      host: true,
      throws: true,
    });
    expect(summaries.get(mir.writer.functionIndex)).toMatchObject({
      effects: [Effect.ScalarWrite, Effect.Throws],
      reads: [],
      writes: [Effect.ScalarWrite],
      throws: true,
      host: false,
    });
    expect(summaries.get(mir.reader.functionIndex)).toMatchObject({
      effects: [Effect.MemoryRead, Effect.VersionedRead, Effect.Throws],
      reads: [Effect.MemoryRead, Effect.VersionedRead],
      writes: [],
    });
    expect(summaries.get(mir.dispatcher.functionIndex)).toMatchObject({
      effects: ALL,
      host: true,
      hasTransfer: true,
    });
    // transitive calls `caller` and `host`, so it inherits host/throws/effects.
    expect(summaries.get(mir.transitive.functionIndex)).toMatchObject({
      effects: ALL,
      host: true,
      throws: true,
    });
  });

  it('marks provider checkpoints as transfers', () => {
    const fixture = summariesFixture();
    const setup = prepareEngine(fixture.module, {
      validation: policy(fixture.module),
      executors: [{ op: 'probe.read', execute: () => [0] }],
      eventHost: { now: () => 0, at: () => 1, cancel: () => undefined },
      bridge: { send: () => true, sendBytes: () => true },
    });
    const artifact = setup.providers.materialize(fixture.code as ProviderRef, [3]);
    const context = createLowerContext(fixture.module);
    const mir = lowerFunction(context, artifact.fn, artifact.index, artifact.name);
    const summary = computeFunctionSummary(mir);
    expect(summary.hasTransfer).toBe(true);
    expect(summary.host).toBe(true);
    expect(summary.throws).toBe(true);
  });

  it('finds recursive SCCs and their summaries', () => {
    const module = createIRModule();
    const counter = module.state('counter', 'u32', 0);
    const left = module.func('left', { params: ['u32'], results: ['u32'] });
    const right = module.func('right', { params: ['u32'], results: ['u32'] });
    left.body((b, [value]) => b.return([b.call(right, [value])[0]!]));
    right.body((b, [value]) => {
      b.state.store(counter, value);
      b.return([b.call(left, [value])[0]!]);
    });
    const context = createLowerContext(module);
    const mirLeft = lowerFunction(context, left);
    const mirRight = lowerFunction(context, right);
    const summaries = computeSummaries([mirLeft, mirRight]);

    expect(summaries.get(mirLeft.functionIndex)!.recursive).toBe(true);
    expect(summaries.get(mirRight.functionIndex)!.recursive).toBe(true);
    expect(summaries.get(mirLeft.functionIndex)!.writes).toEqual([Effect.ScalarWrite]);
    expect(summaries.get(mirLeft.functionIndex)!.throws).toBe(true);
  });

  it('treats unknown callees conservatively in a standalone summary', () => {
    const fixture = summariesFixture();
    const context = createLowerContext(fixture.module, ['probe.read']);
    const mir = lowerFunction(context, fixture.caller);
    const summary = computeFunctionSummary(mir);
    expect(summary.host).toBe(true);
    expect(summary.throws).toBe(true);
    expect(summary.effects).toEqual(ALL);
    expect(summary.resultReps).toEqual(['int']);
  });
});

describe('return representation summaries', () => {
  it('joins every return and reports non-float results directly', () => {
    const module = createIRModule();
    const fn = module.func('mixed', { params: ['bool', 'f64'], results: ['f64', 'bool'] });
    fn.body((b, [flag, value]) => {
      const yes = b.block([]);
      const no = b.block([]);
      b.branch(flag, { target: yes, args: [] }, { target: no, args: [] });
      b.at(yes, (b) => b.return([b.float.mul(value, b.const('f64', 2)), flag]));
      b.at(no, (b) => b.return([b.float.add(value, b.const('f64', 1)), b.bool.not(flag)]));
    });
    const context = createLowerContext(module);
    const mir = lowerFunction(context, fn);
    const reps = analyzeRepresentation(mir);
    expect(returnRepresentations(mir, reps)).toEqual(['D', 'bool']);
  });
});
