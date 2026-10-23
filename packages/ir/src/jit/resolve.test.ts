import { describe, expect, it } from 'vitest';
import { CORE_INSTRUCTION_NAMES } from '../builder';
import { prepareEngine } from '../engine-setup';
import { createIRModule } from '../index';
import type { InstructionNode, IRModule, ProviderRef } from '../types';
import type { IRValidationOptions } from '../validation-types';
import {
  createLowerContext,
  internConstant,
  resolveCall,
  resolveCheckpoint,
  resolveDispatch,
  resolveDispatchTerminator,
  resolveEntry,
  resolveExecutor,
  resolveMemory,
  resolveOutput,
  resolveTrapCode,
  staticOperand,
  type LowerContext,
} from './resolve';

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

function node(instructions: readonly InstructionNode[], op: string): InstructionNode {
  const result = instructions.find((instruction) => instruction.op === op);
  if (result === undefined) throw new Error(`missing ${op}`);
  return result;
}

function makeFixture() {
  const module = createIRModule();
  const counter = module.state('counter', 'u32', 0);
  const table = module.array('table', 'u16', [0, 0]);
  const ram = module.bytes('ram', new Uint8Array(8), { readonly: false });
  const output = module.output('value', { params: ['u32'], capacity: 4 });
  const bytesOutput = module.outputBytes('packet', { maxBytes: 8, capacity: 4 });
  const helper = module.func('helper', { params: ['u32'], results: ['u32'] });
  helper.body((b, [value]) => b.return([value]));
  const scheduled = module.entry('scheduled', ['u32']);
  scheduled.body((b, [value]) => {
    b.state.store(counter, value);
    b.return([]);
  });
  const probe = module.domainInstruction('probe.read', {
    operands: [{ kind: 'value', type: 'u32' }],
    results: ['u32'],
  });
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
  const run = module.func('run', { params: ['u32'], results: ['u32'] });
  run.body((b, [index]) => {
    const loaded = b.state.load(counter);
    const called = b.call(helper, [loaded])[0]!;
    const probed = b.invoke(probe, [called])[0]!;
    const arrays = b.array.load(table, index);
    b.bytes.store('u16', 'little', ram, index, arrays);
    const bytes = b.bytes.load('u16', 'little', ram, index);
    void bytes;
    const sent = b.output(output, [probed]);
    const sentBytes = b.outputBytes(bytesOutput, ram, index, b.const('u32', 2));
    const now = b.event.now();
    const id = b.event.at(scheduled, now, [probed]);
    b.event.cancel(id);
    b.dispatch(recovery, [probed], []);
    void sent;
    void sentBytes;
  });
  const runDefinition = module.functions.find((candidate) => candidate.ref === run)!;
  return {
    module,
    counter,
    table,
    ram,
    output,
    bytesOutput,
    helper,
    scheduled,
    probe,
    recovery,
    code,
    run,
    runDefinition,
  };
}

function dispatchNode(f: ReturnType<typeof makeFixture>) {
  const terminator = f.runDefinition.body!.blocks[0]!.terminator;
  if (terminator?.kind !== 'dispatch') throw new Error('missing dispatch');
  return terminator;
}

describe('static reference resolution', () => {
  it('resolves model indices for every reference kind', () => {
    const f = makeFixture();
    const ctx = createLowerContext(f.module, ['probe.read']);
    const instructions = f.runDefinition.body!.blocks[0]!.instructions;

    expect(resolveCall(ctx, node(instructions, 'call'))).toBe(ctx.functionIndices.get(f.helper));
    expect(resolveEntry(ctx, node(instructions, 'event.at'))).toBe(
      ctx.functionIndices.get(f.scheduled),
    );
    expect(resolveMemory(ctx, node(instructions, 'state.load'), 0)).toBe(
      ctx.memoryIndices.get(f.counter),
    );
    expect(resolveMemory(ctx, node(instructions, 'array.load'), 0)).toBe(
      ctx.memoryIndices.get(f.table),
    );
    expect(resolveMemory(ctx, node(instructions, 'bytes.load'), 2)).toBe(
      ctx.memoryIndices.get(f.ram),
    );
    expect(resolveOutput(ctx, node(instructions, 'bridge.send'), 0)).toBe(
      ctx.outputIndices.get(f.output),
    );
    expect(resolveOutput(ctx, node(instructions, 'bridge.send_bytes'), 0)).toBe(
      ctx.outputIndices.get(f.bytesOutput),
    );
    expect(resolveExecutor(ctx, 'probe.read')).toBe(0);
    expect(resolveExecutor(ctx, 'missing.executor')).toBe(-1);
    expect(resolveDispatch(ctx, f.recovery)).toBe(ctx.providerIndices.get(f.recovery));
    expect(resolveDispatchTerminator(ctx, dispatchNode(f))).toBe(
      ctx.providerIndices.get(f.recovery),
    );
  });

  it('resolves checkpoint targets inside provider artifacts', () => {
    const f = makeFixture();
    const setup = prepareEngine(f.module, {
      validation: policy(f.module),
      executors: [{ op: 'probe.read', execute: () => [0] }],
      eventHost: { now: () => 0, at: () => 1, cancel: () => undefined },
      bridge: { send: () => true, sendBytes: () => true },
    });
    const artifact = setup.providers.materialize(f.code as ProviderRef, [7]);
    const checkpoint = node(artifact.fn.body!.blocks[0]!.instructions, 'checkpoint');
    const ctx = createLowerContext(f.module);
    expect(resolveCheckpoint(ctx, checkpoint)).toBe(ctx.providerIndices.get(f.recovery));
  });

  it('interns constants and trap codes once', () => {
    const f = makeFixture();
    const ctx: LowerContext = createLowerContext(f.module);
    const first = internConstant(ctx, 'trap-a');
    const second = internConstant(ctx, 'trap-a');
    expect(second).toBe(first);
    expect(resolveTrapCode(ctx, 'trap-a')).toBe(first);
    expect(ctx.constants[first]).toBe('trap-a');
    expect(internConstant(ctx, 42)).toBe(first + 1);
  });

  it('reports internal errors for unknown targets and malformed operands', () => {
    const f = makeFixture();
    const ctx = createLowerContext(f.module);
    const foreign = createIRModule().func('foreign', { params: [], results: [] });
    const foreignCall: InstructionNode = {
      op: 'call',
      operands: [{ kind: 'static', ref: foreign }],
      results: [],
    };
    expect(() => resolveCall(ctx, foreignCall)).toThrow(/MIR lowering failed/);

    const nonCall = node(f.runDefinition.body!.blocks[0]!.instructions, 'state.load');
    expect(() => resolveCall(ctx, nonCall)).toThrow(/not a call instruction/);

    const notStatic: InstructionNode = {
      op: 'call',
      operands: [{ kind: 'literal', value: 1 }],
      results: [],
    };
    expect(() => staticOperand(notStatic, 0)).toThrow(/must be a static reference/);

    expect(() => createLowerContext(f.module, ['probe.read', 'probe.read'])).toThrow(
      /listed more than once/,
    );
  });

  it('rejects duplicate dispatch keys and missing static operands', () => {
    const f = makeFixture();
    const ctx = createLowerContext(f.module);
    expect(() => resolveDispatch(ctx, f.run)).toThrow(/dispatch target/);
    expect(() => resolveDispatchTerminator(ctx, { kind: 'return', values: [] })).toThrow(
      /not a dispatch terminator/,
    );
  });
});
