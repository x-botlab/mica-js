import { describe, expect, it } from 'vitest';
import {
  createIRModule,
  type IRModule,
  type IRValidationOptions,
  type ProviderRef,
} from '@mica-js/ir';
import { createIRSchedulerInstance, createScheduler } from '../index';

function policy(module: IRModule): IRValidationOptions {
  const instructions = new Set(['checkpoint', 'return', 'jump', 'branch', 'trap']);
  for (const fn of module.functions) {
    for (const block of fn.body?.blocks ?? []) {
      for (const node of block.instructions) instructions.add(node.op);
      if (block.terminator !== undefined) instructions.add(block.terminator.kind);
    }
  }
  return {
    supportedInstructions: [...instructions],
    authorizedInstructions: [...instructions],
    resources: module.memories.map((memory) => ({
      ref: memory.ref,
      access: memory.writable ? 'read-write' : 'read',
    })),
  };
}

describe('provider recovery through the scheduler entry boundary', () => {
  it('recovers inside one entry without advancing time or re-entering the device', () => {
    const calls = { generated: 0 };
    const module = createIRModule();
    const rom = module.bytes('rom', new Uint8Array([1, 2, 3, 4]), {
      readonly: true,
      unitBytes: 2,
    });
    const tracked = module.state('tracked', 'u32', 0);
    const pc = module.state('pc', 'u32', 0);
    const result = module.state('result', 'u32', 0);
    const update = module.func('update', { params: [], results: [] });
    update.body((b) => {
      b.state.store(tracked, b.const('u32', 1));
      b.return([]);
    });
    const code: ProviderRef<readonly ['u32'], readonly [], readonly []> = module.provider(
      'code',
      {
        keyTypes: ['u32'],
        params: [],
        results: [],
        reads: [rom, tracked],
        imports: [pc, result, update],
      },
      (gen, [address]) => {
        calls.generated += 1;
        gen.readState(tracked);
        const value = gen.readBytes(rom, address, 1)[0]!;
        return gen.function((b) => {
          if (address !== 0) {
            b.state.store(result, b.const('u32', 2000 + value));
            b.state.store(pc, b.const('u32', 2));
            b.return([]);
            return;
          }
          const nextPc = b.const('u32', 2);
          b.call(update, []);
          b.state.store(pc, nextPc);
          b.checkpoint(code, [nextPc], []);
          b.state.store(result, b.const('u32', 1000 + value));
          b.return([]);
        });
      },
    );
    const step = module.entry('step', []);
    step.body((b) => b.dispatch(code, [b.state.load(pc)], []));

    const scheduler = createScheduler();
    const instance = createIRSchedulerInstance(scheduler, {
      instanceId: 'recovery',
      module,
      validation: policy(module),
    });
    instance.at(step, 0, []);
    instance.at(step, 10, []);
    scheduler.start();

    expect(scheduler.now).toBe(10);
    expect(calls.generated).toBe(2);
    expect(instance.storage.loadState(tracked)).toBe(1);
    expect(instance.storage.loadState(pc)).toBe(2);
    expect(instance.storage.loadState(result)).toBe(2003);
  });
});
