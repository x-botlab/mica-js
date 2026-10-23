import { describe, expect, it } from 'vitest';
import { CORE_INSTRUCTION_NAMES } from '../builder';
import { prepareEngine } from '../engine-setup';
import { createIRModule } from '../index';
import type { IRModule, ProviderRef } from '../types';
import type { IRValidationOptions } from '../validation-types';
import { createLowerContext, lowerFunction, Op, printMIR } from './mir';
import type { MFunction } from './mir';
import { assertStepInvariant, verifyMIR } from './verify';

function policy(module: IRModule): IRValidationOptions {
  const instructions = [...CORE_INSTRUCTION_NAMES, ...module.instructions.map((item) => item.name)];
  return {
    supportedInstructions: instructions,
    authorizedInstructions: instructions,
    resources: module.memories.map((memory) => ({
      ref: memory.ref,
      access: memory.writable ? 'read-write' : 'read',
    })),
  };
}

function instsOf(mir: MFunction, sourceOp: string) {
  return mir.blocks.flatMap((block) => block.insts.filter((inst) => inst.node?.op === sourceOp));
}

const EXPECTED_OP: Readonly<Record<string, Op>> = {
  const: Op.Const,
  'const.bits': Op.Const,
  'bool.not': Op.BoolNot,
  'bool.and': Op.BoolAnd,
  'bool.or': Op.BoolOr,
  'bool.xor': Op.BoolXor,
  'int.add': Op.IntAdd,
  'int.sub': Op.IntSub,
  'int.mul': Op.IntMul,
  'int.div': Op.IntDiv,
  'int.rem': Op.IntRem,
  'int.and': Op.IntAnd,
  'int.or': Op.IntOr,
  'int.xor': Op.IntXor,
  'int.not': Op.IntNot,
  'int.shl': Op.IntShl,
  'int.lshr': Op.IntLshr,
  'int.ashr': Op.IntAshr,
  'int.cmp': Op.IntCmp,
  'int.zext': Op.IntZext,
  'int.sext': Op.IntSext,
  'int.trunc': Op.IntTrunc,
  'int.reinterpret': Op.IntReinterpret,
  'float.add': Op.FloatAdd,
  'float.sub': Op.FloatSub,
  'float.mul': Op.FloatMul,
  'float.div': Op.FloatDiv,
  'float.fma': Op.FloatFma,
  'float.cmp': Op.FloatCmp,
  'float.isNaN': Op.FloatIsNaN,
  'float.isFinite': Op.FloatIsFinite,
  'convert.intToFloat': Op.ConvertIntToFloat,
  'convert.floatToInt': Op.ConvertFloatToInt,
  'convert.float': Op.ConvertFloat,
  bitcast: Op.Bitcast,
  select: Op.Select,
  'state.load': Op.StateLoad,
  'state.store': Op.StateStore,
  'array.load': Op.ArrayLoad,
  'array.store': Op.ArrayStore,
  'bytes.load': Op.BytesLoad,
  'bytes.store': Op.BytesStore,
  'bytes.copy': Op.BytesCopy,
  'resource.update_bytes': Op.ResourceUpdateBytes,
  'resource.fill_bytes': Op.ResourceFillBytes,
  'bridge.send': Op.BridgeSend,
  'bridge.send_bytes': Op.BridgeSendBytes,
  call: Op.Call,
  'event.now': Op.EventNow,
  'event.at': Op.EventAt,
  'event.cancel': Op.EventCancel,
};

function kitchenSink() {
  const module = createIRModule();
  const counter = module.state('counter', 'u32', 0);
  const table = module.array('table', 'u32', [0, 0, 0, 0]);
  const ram = module.bytes('ram', new Uint8Array(16), { readonly: false });
  const scalarOutput = module.output('scalar', { params: ['u32'], capacity: 4 });
  const bytesOutput = module.outputBytes('packet', { maxBytes: 16, capacity: 4 });
  const helper = module.func('helper', { params: ['u32'], results: ['u32'] });
  helper.body((b, [value]) => b.return([b.int.add(value, b.const('u32', 1))]));
  const scheduled = module.entry('scheduled', ['u32']);
  scheduled.body((b, [value]) => {
    b.state.store(counter, value);
    b.return([]);
  });
  const probe = module.domainInstruction('probe.read', {
    operands: [{ kind: 'value', type: 'u32' }],
    results: ['u32'],
  });
  const run = module.func('run', { params: ['u32', 'f64', 'bool'], results: ['u32', 'f64'] });
  run.body((b, [index, float, flag]) => {
    const zero = b.const('u32', 0);
    const one = b.const('u32', 1);
    const negativeZero = b.const('f64', -0);
    const canonicalBits = b.bits('f32', '0x3f800000');
    const rawBits = b.bits('f32', '0x7FA12345');
    const i8 = b.const('i8', -2);
    const u8 = b.const('u8', 1);
    const sum = b.int.add(index, one);
    const difference = b.int.sub(sum, one);
    const product = b.int.mul(difference, one);
    const quotient = b.int.div(product, one);
    const remainder = b.int.rem(quotient, one);
    const and = b.int.and(remainder, one);
    const or = b.int.or(and, one);
    const xor = b.int.xor(or, one);
    const not = b.int.not(xor);
    const shl = b.int.shl(not, one);
    const lshr = b.int.lshr(shl, one);
    const ashr = b.int.ashr(i8, one);
    const cmp = b.int.cmp('lt', ashr, i8);
    const zext = b.int.zext('u32', u8);
    const sext = b.int.sext('i32', i8);
    const trunc = b.int.trunc('u8', zext);
    const reinterpret = b.int.reinterpret('i32', zext);
    const boolNot = b.bool.not(flag);
    const boolAnd = b.bool.and(flag, boolNot);
    const boolOr = b.bool.or(flag, boolNot);
    const boolXor = b.bool.xor(flag, boolNot);
    const floatAdd = b.float.add(float, float);
    const floatSub = b.float.sub(float, float);
    const floatMul = b.float.mul(float, float);
    const floatDiv = b.float.div(float, float);
    const floatFma = b.float.fma(float, float, float);
    const floatCmp = b.float.cmp('eq', float, float);
    const isNaN = b.float.isNaN(float);
    const isFinite = b.float.isFinite(float);
    const intToFloat = b.convert.intToFloat('f64', index);
    const floatToInt = b.convert.floatToInt('i32', float);
    const floatConvert = b.convert.float('f32', float);
    const bitcast = b.bitcast('u32', canonicalBits);
    const selected = b.select(flag, sum, difference);
    b.state.store(counter, selected);
    const loaded = b.state.load(counter);
    b.array.store(table, index, loaded);
    const arrayLoaded = b.array.load(table, index);
    b.bytes.store('u32', 'little', ram, index, arrayLoaded);
    const bytesLoaded = b.bytes.load('u32', 'little', ram, index);
    b.bytes.copy(ram, index, ram, one, one);
    b.resource.updateBytes(ram, index, ram, one, one);
    b.resource.fillBytes(ram, index, one, u8);
    const sent = b.output(scalarOutput, [bytesLoaded]);
    const sentBytes = b.outputBytes(bytesOutput, ram, index, one);
    const called = b.call(helper, [bytesLoaded])[0]!;
    const now = b.event.now();
    const id = b.event.at(scheduled, now, [called]);
    b.event.cancel(id);
    const probed = b.invoke(probe, [called])[0]!;
    void [
      zero,
      negativeZero,
      rawBits,
      remainder,
      lshr,
      cmp,
      sext,
      trunc,
      reinterpret,
      boolAnd,
      boolOr,
      boolXor,
      floatAdd,
      floatSub,
      floatMul,
      floatDiv,
      floatFma,
      floatCmp,
      isNaN,
      isFinite,
      intToFloat,
      floatToInt,
      floatConvert,
      bitcast,
      sent,
      sentBytes,
      probed,
    ];
    b.return([b.int.add(loaded, b.int.add(zext, called)), float]);
  });
  return {
    module,
    counter,
    table,
    ram,
    scalarOutput,
    bytesOutput,
    helper,
    scheduled,
    probe,
    run,
  };
}

function definitionOf(module: IRModule, handle: object) {
  const definition = module.functions.find((candidate) => candidate.ref === handle);
  if (definition === undefined) throw new Error('missing function definition');
  return definition;
}

describe('MIR lowering', () => {
  it('maps every core instruction to its opcode and keeps one instruction per source item', () => {
    const fixture = kitchenSink();
    const context = createLowerContext(fixture.module, ['probe.read']);
    const source = definitionOf(fixture.module, fixture.run);
    const mir = lowerFunction(context, source);

    expect(mir.source).toBe(source);
    expect(mir.functionIndex).toBe(context.functionIndices.get(fixture.run));
    expect(mir.name).toBe('run');
    expect(mir.params).toEqual(['u32', 'f64', 'bool']);
    expect(mir.results).toEqual(['u32', 'f64']);
    expect(mir.values).toHaveLength(
      source.body!.blocks.reduce(
        (sum, block) =>
          sum +
          block.params.length +
          block.instructions.reduce((count, inst) => count + inst.results.length, 0),
        0,
      ),
    );

    source.body!.blocks.forEach((sourceBlock, index) => {
      const block = mir.blocks[index]!;
      expect(block.id).toBe(index);
      expect(block.insts).toHaveLength(sourceBlock.instructions.length);
      sourceBlock.instructions.forEach((node, instructionIndex) => {
        const inst = block.insts[instructionIndex]!;
        expect(inst.node).toBe(node);
        expect(inst.op).toBe(EXPECTED_OP[node.op] ?? Op.Executor);
        expect(inst.step).toBe(1);
        expect(inst.results).toHaveLength(node.results.length);
      });
      expect(block.term.step).toBe(1);
    });
    assertStepInvariant(mir);
    verifyMIR(mir, context);
  });

  it('flattens ssa-list operands and resolves every static reference', () => {
    const fixture = kitchenSink();
    const context = createLowerContext(fixture.module, ['probe.read']);
    const mir = lowerFunction(context, fixture.run);

    expect(instsOf(mir, 'call')[0]!.refs).toEqual([context.functionIndices.get(fixture.helper)]);
    expect(instsOf(mir, 'state.load')[0]!.refs).toEqual([
      context.memoryIndices.get(fixture.counter),
    ]);
    expect(instsOf(mir, 'bytes.copy')[0]!.refs).toEqual([
      context.memoryIndices.get(fixture.ram),
      context.memoryIndices.get(fixture.ram),
    ]);
    expect(instsOf(mir, 'resource.update_bytes')[0]!.refs).toEqual([
      context.memoryIndices.get(fixture.ram),
      context.memoryIndices.get(fixture.ram),
    ]);
    expect(instsOf(mir, 'bridge.send')[0]!.refs).toEqual([
      context.outputIndices.get(fixture.scalarOutput),
    ]);
    expect(instsOf(mir, 'bridge.send_bytes')[0]!.refs).toEqual([
      context.outputIndices.get(fixture.bytesOutput),
      context.memoryIndices.get(fixture.ram),
    ]);
    expect(instsOf(mir, 'event.at')[0]!.refs).toEqual([
      context.functionIndices.get(fixture.scheduled),
    ]);
    expect(instsOf(mir, 'probe.read')[0]!.op).toBe(Op.Executor);
    expect(instsOf(mir, 'probe.read')[0]!.refs).toEqual([0]);
  });

  it('normalizes constants and marks D/U float constants', () => {
    const module = createIRModule();
    const run = module.func('run', { params: [], results: ['f32', 'f32', 'f64', 'i32'] });
    run.body((b) =>
      b.return([
        b.bits('f32', '0x3f800000'),
        b.bits('f32', '0x7FA12345'),
        b.const('f64', -0),
        b.const('i32', -0),
      ]),
    );
    const context = createLowerContext(module);
    const mir = lowerFunction(context, run);
    const [canonical, raw, negativeZero, integerZero] = mir.blocks[0]!.insts;

    expect(canonical).toMatchObject({ op: Op.Const, constRep: 'D', imm: [1] });
    expect(raw).toMatchObject({ op: Op.Const, constRep: 'U' });
    expect(typeof raw!.imm[0]).toBe('number');
    expect(context.constants[raw!.imm[0] as number]).toEqual({
      type: 'f32',
      bits: '0x7FA12345',
    });
    expect(Object.is(negativeZero!.imm[0], -0)).toBe(true);
    expect(negativeZero).toMatchObject({ op: Op.Const, constRep: 'D' });
    expect(integerZero!.imm[0]).toBe(0);
    expect(Object.is(integerZero!.imm[0], -0)).toBe(false);
    verifyMIR(mir, context);
  });

  it('lowers a provider artifact with its own index and name', () => {
    const module = createIRModule();
    const recovery = module.provider(
      'recovery',
      { keyTypes: ['u32'], params: [], results: ['u32'], reads: [], imports: [] },
      (gen) => gen.function((b) => b.return([b.const('u32', 0)])),
    );
    const code = module.provider(
      'code',
      { keyTypes: ['u32'], params: [], results: ['u32'], reads: [], imports: [recovery] },
      (gen) =>
        gen.function((b) => {
          b.checkpoint(recovery, [b.const('u32', 1)], []);
          b.return([b.const('u32', 2)]);
        }),
    );
    const setup = prepareEngine(module, { validation: policy(module) });
    const artifact = setup.providers.materialize(code as ProviderRef, [7]);
    const context = createLowerContext(module);
    const mir = lowerFunction(context, artifact.fn, artifact.index, artifact.name);

    expect(mir.functionIndex).toBe(artifact.index);
    expect(mir.name).toBe(artifact.name);
    expect(mir.name).toMatch(/^code#/);
    const checkpoint = mir.blocks[0]!.insts.find((inst) => inst.op === Op.Checkpoint)!;
    expect(checkpoint).toMatchObject({
      op: Op.Checkpoint,
      refs: [context.providerIndices.get(recovery)],
      listSplit: [1, 0],
      step: 1,
    });
    expect(checkpoint.args).toHaveLength(1);
    verifyMIR(mir, context);
  });

  it('prints a stable MIR snapshot', () => {
    const module = createIRModule();
    const loopFn = module.func('loop', { params: ['u32'], results: ['u32'] });
    loopFn.body((b, [input]) => {
      const one = b.const('u32', 1);
      const ten = b.const('u32', 10);
      const head = b.block(['u32']);
      const done = b.block(['u32']);
      b.jump(head, [input]);
      b.at(head, (b, [value]) => {
        const next = b.int.add(value, one);
        b.branch(
          b.int.cmp('lt', next, ten),
          { target: head, args: [next] },
          { target: done, args: [next] },
        );
      });
      b.at(done, (b, [value]) => b.return([value]));
    });
    const mir = lowerFunction(createLowerContext(module), loopFn);
    expect(printMIR(mir)).toBe(
      [
        'function loop#0(u32) -> (u32)',
        '  b0(v0: u32):',
        '    v1 = const 1',
        '    v2 = const 10',
        '    jump b1(v0)',
        '  b1(v3: u32):',
        '    v4 = int.add v3, v1',
        '    v5 = int.cmp("lt") v4, v2',
        '    branch v5 ? b1(v4) : b2(v4)',
        '  b2(v6: u32):',
        '    return (v6)',
      ].join('\n'),
    );
  });

  it('flattens executor ssa-list operands with listSplit', () => {
    const module = createIRModule();
    const listInstruction = module.domainInstruction('probe.list', {
      operands: [{ kind: 'value-list', type: 'u32' }],
      results: [],
    });
    const fn = module.func('lists', { params: ['u32', 'u32'], results: [] });
    fn.body((b, [left, right]) => {
      b.invoke(listInstruction, [[left, right]]);
      b.return([]);
    });
    const ctx = createLowerContext(module, ['probe.list']);
    const mir = lowerFunction(ctx, fn);
    const inst = mir.blocks[0]!.insts[0]!;
    expect(inst.op).toBe(Op.Executor);
    expect(inst.node?.op).toBe('probe.list');
    expect(inst.args).toEqual([0, 1]);
    expect(inst.listSplit).toEqual([2]);
    expect(inst.refs).toEqual([0]);
    verifyMIR(mir, ctx);
  });

  it('interns trap codes into the constant table', () => {
    const module = createIRModule();
    const fn = module.func('fault', { params: [], results: [] });
    fn.body((b) => b.trap('device failed'));
    const ctx = createLowerContext(module);
    const mir = lowerFunction(ctx, fn);
    const term = mir.blocks[0]!.term;
    expect(term).toMatchObject({ kind: 'trap', loc: 0, step: 1 });
    if (term.kind !== 'trap') throw new Error('expected trap');
    expect(ctx.constants[term.code]).toBe('device failed');
    verifyMIR(mir, ctx);
  });

  it('rejects instructions that should be terminators', () => {
    const module = createIRModule();
    const handle = module.func('fake', { params: [], results: [] });
    handle.body((b) => b.return([]));
    const definition = module.functions.find((candidate) => candidate.ref === handle)!;
    const fake: import('../types').InstructionNode = {
      op: 'return',
      operands: [],
      results: [],
    };
    const block = { ...definition.body!.blocks[0]!, instructions: [fake] };
    expect(() =>
      lowerFunction(createLowerContext(module), {
        ...definition,
        body: { entry: block, blocks: [block] },
      }),
    ).toThrow(/must be encoded as a block terminator/);
  });
});
