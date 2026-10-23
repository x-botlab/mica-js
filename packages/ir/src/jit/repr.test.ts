import { describe, expect, it } from 'vitest';
import { createIRModule } from '../index';
import { computeSummaries } from './effects';
import { createLowerContext, lowerFunction, Op } from './mir';
import type { MFunction } from './mir';
import { analyzeRepresentation } from './repr';

function firstInst(mir: MFunction, op: Op) {
  const inst = mir.blocks.flatMap((block) => block.insts).find((candidate) => candidate.op === op);
  if (inst === undefined) throw new Error(`missing ${op}`);
  return inst;
}

function returnValues(mir: MFunction): number[] {
  const block = mir.blocks.find((candidate) => candidate.term.kind === 'return');
  if (block === undefined || block.term.kind !== 'return') throw new Error('missing return');
  return block.term.values;
}

describe('representation analysis', () => {
  it('keeps an all-D float accumulation loop in D', () => {
    const module = createIRModule();
    const accumulate = module.func('accumulate', { params: ['u32'], results: ['f64'] });
    accumulate.body((b, [count]) => {
      const zero = b.const('u32', 0);
      const one = b.const('u32', 1);
      const seed = b.const('f64', 0);
      const loop = b.block(['u32', 'f64']);
      const done = b.block(['f64']);
      b.jump(loop, [zero, seed]);
      b.at(loop, (b, [index, sum]) => {
        const next = b.int.add(index, one);
        const nextSum = b.float.add(sum, b.const('f64', 1));
        b.branch(
          b.int.cmp('lt', next, count),
          { target: loop, args: [next, nextSum] },
          { target: done, args: [nextSum] },
        );
      });
      b.at(done, (b, [sum]) => b.return([sum]));
    });
    const mir = lowerFunction(createLowerContext(module), accumulate);
    const reps = analyzeRepresentation(mir);

    expect(reps.get(returnValues(mir)[0]!)).toBe('D');
    const loopParam = mir.blocks[1]!.params[1]!;
    expect(reps.get(loopParam)).toBe('D');
    expect(mir.values[loopParam]!.rep).toBe('D');
  });

  it('joins a load into U and keeps a function parameter U', () => {
    const module = createIRModule();
    const ratio = module.state('ratio', 'f64', 0);
    const mix = module.func('mix', { params: ['f64', 'bool'], results: ['f64'] });
    mix.body((b, [seed, flag]) => {
      const loaded = b.state.load(ratio);
      const computed = b.float.add(seed, b.const('f64', 1));
      const loop = b.block(['f64', 'f64']);
      const done = b.block(['f64']);
      b.jump(loop, [loaded, computed]);
      b.at(loop, (b, [left, right]) => {
        const nextLeft = b.select(flag, left, right);
        const nextRight = b.select(flag, right, left);
        b.branch(
          flag,
          { target: loop, args: [nextLeft, nextRight] },
          { target: done, args: [nextLeft] },
        );
      });
      b.at(done, (b, [value]) => b.return([value]));
    });
    const mir = lowerFunction(createLowerContext(module), mix);
    const reps = analyzeRepresentation(mir);

    const loaded = firstInst(mir, Op.StateLoad).results[0]!;
    expect(reps.get(loaded)).toBe('U');
    expect(reps.get(mir.blocks[0]!.params[0]!)).toBe('U');
    expect(reps.get(returnValues(mir)[0]!)).toBe('U');
    expect(reps.get(mir.blocks[1]!.params[0]!)).toBe('U');
  });

  it('uses callee summaries for call results and iterates recursive SCCs', () => {
    const module = createIRModule();
    const producer = module.func('producer', { params: [], results: ['f64'] });
    producer.body((b) => b.return([b.float.add(b.const('f64', 1), b.const('f64', 2))]));
    const consumer = module.func('consumer', { params: [], results: ['f64'] });
    consumer.body((b) => b.return([b.call(producer, [])[0]!]));
    const context = createLowerContext(module);
    const mirProducer = lowerFunction(context, producer);
    const mirConsumer = lowerFunction(context, consumer);
    const summaries = computeSummaries([mirProducer, mirConsumer]);
    const reps = analyzeRepresentation(mirConsumer, summaries);

    const call = firstInst(mirConsumer, Op.Call);
    expect(reps.get(call.results[0]!)).toBe('D');
    expect(summaries.get(mirConsumer.functionIndex)!.resultReps).toEqual(['D']);
    expect(summaries.get(mirProducer.functionIndex)!.resultReps).toEqual(['D']);
  });

  it('marks non-canonical and uppercase float constants as U', () => {
    const module = createIRModule();
    const constants = module.func('constants', {
      params: [],
      results: ['f32', 'f32', 'f32', 'f64'],
    });
    constants.body((b) =>
      b.return([
        b.bits('f32', '0x3f800000'),
        b.bits('f32', '0x7fc00000'),
        b.bits('f32', '0x7FA12345'),
        b.bits('f64', '0x7FF8000000000123'),
      ]),
    );
    const mir = lowerFunction(createLowerContext(module), constants);
    const reps = analyzeRepresentation(mir);
    const [lowercase, canonicalNan, uppercase, payloadNan] = mir.blocks[0]!.insts;

    expect(lowercase!.constRep).toBe('D');
    expect(canonicalNan!.constRep).toBe('D');
    expect(uppercase!.constRep).toBe('U');
    expect(payloadNan!.constRep).toBe('U');
    expect(reps.get(uppercase!.results[0]!)).toBe('U');
    expect(reps.get(payloadNan!.results[0]!)).toBe('U');
    expect(reps.get(canonicalNan!.results[0]!)).toBe('D');
  });

  it('joins select inputs and reports bool/int values directly', () => {
    const module = createIRModule();
    const ratio = module.state('ratio', 'f64', 0);
    const choose = module.func('choose', {
      params: ['bool'],
      results: ['f64', 'f64', 'bool', 'u32'],
    });
    choose.body((b, [flag]) => {
      const computed = b.float.add(b.const('f64', 1), b.const('f64', 2));
      const loaded = b.state.load(ratio);
      const both = b.select(flag, computed, b.float.mul(computed, computed));
      const mixed = b.select(flag, computed, loaded);
      b.return([both, mixed, flag, b.const('u32', 7)]);
    });
    const mir = lowerFunction(createLowerContext(module), choose);
    const reps = analyzeRepresentation(mir);
    const [both, mixed] = mir.blocks[0]!.insts.filter((inst) => inst.op === Op.Select);

    expect(reps.get(both!.results[0]!)).toBe('D');
    expect(reps.get(mixed!.results[0]!)).toBe('U');
    const values = returnValues(mir);
    expect(reps.get(values[0]!)).toBe('D');
    expect(reps.get(values[1]!)).toBe('U');
    expect(reps.get(values[2]!)).toBe('bool');
    expect(reps.get(values[3]!)).toBe('int');
  });
});
