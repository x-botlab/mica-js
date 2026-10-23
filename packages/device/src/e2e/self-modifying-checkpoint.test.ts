import { describe, expect, it } from 'vitest';
import { createScheduler } from '@mica-js/core';
import type { BytesRef, StateRef } from '@mica-js/ir';
import { createDeviceInstance, loadDeviceModule } from '../index';
import { createTempDevice } from '../test-helpers';

interface FixtureRefs {
  readonly code: BytesRef;
  readonly counter: StateRef<'u32'>;
  readonly result: StateRef<'u32'>;
  readonly pc: StateRef<'u32'>;
  readonly calls: { generated: number };
}

const globals = globalThis as { __micaSelfModifying?: FixtureRefs };

/**
 * A generated block reads `code`, a helper rewrites the byte it already decoded, and the
 * checkpoint must leave the old artifact before it reaches the stale follow-up step. The helper
 * also increments `counter`, so replaying it during recovery is directly observable.
 */
const factorySource = `
  export default function createDevice(api) {
    const ir = api.ir;
    const code = ir.bytes('code', new Uint8Array([1, 2, 3, 4]), { readonly: true, unitBytes: 2 });
    const patch = ir.bytes('patch', new Uint8Array([9]), { readonly: true });
    const counter = ir.state('counter', 'u32', 0);
    const result = ir.state('result', 'u32', 0);
    const pc = ir.state('pc', 'u32', 0);
    const step = ir.entry('step', []);
    const calls = { generated: 0 };

    const update = ir.func('update', { params: [], results: [] });
    update.body((b) => {
      b.resource.updateBytes(code, b.const('u32', 0), patch, b.const('u32', 0), b.const('u32', 1));
      b.state.store(counter, b.int.add(b.state.load(counter), b.const('u32', 1)));
      b.return([]);
    });

    const artifact = ir.provider(
      'artifact',
      {
        keyTypes: ['u32'],
        params: [],
        results: [],
        reads: [code],
        imports: [pc, result, counter, update, step],
      },
      (gen, [address]) => {
        calls.generated += 1;
        const value = gen.readBytes(code, address, 1)[0];
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
          b.checkpoint(artifact, [nextPc], []);
          b.state.store(result, b.const('u32', 1000 + value));
          b.return([]);
        });
      }
    );

    step.body((b) => b.dispatch(artifact, [b.state.load(pc)], []));
    const initialize = ir.lifecycle('initialize', []);
    initialize.body((b) => {
      b.event.at(step, b.event.now(), []);
      b.return([]);
    });
    const stop = api.subscribe('run', () => api.post(step, []));
    globalThis.__micaSelfModifying = { code, counter, result, pc, calls };
    return { initialize, onDispose: stop };
  }
`;

describe('self-modifying helper checkpoint (#62)', () => {
  it('recovers without replaying the helper effect or the stale follow-up step', async () => {
    const temp = await createTempDevice(
      {
        'mcu.json': JSON.stringify({
          ports: { run: { direction: 'input', type: 'boolean' } },
        }),
        'mcu.js': factorySource,
      },
      { 'acme:self-modifying': 'mcu' },
    );
    try {
      const scheduler = createScheduler();
      const loaded = await loadDeviceModule('acme:self-modifying', temp.provider);
      const instance = createDeviceInstance(loaded, scheduler, {
        instanceId: 'self-modifying',
        updateResources: ['code'],
      });
      scheduler.start({ maxEntries: 10 });

      const refs = globals.__micaSelfModifying;
      expect(refs).toBeDefined();
      expect(instance.state).toBe('ready');
      expect(scheduler.now).toBe(0);
      // The generated key-0 artifact is abandoned at the checkpoint; key 2 is generated instead.
      expect(refs!.calls.generated).toBe(2);
      expect(instance.storage.loadBytes('u8', 'little', refs!.code, 0)).toBe(9);
      // The helper ran exactly once and the post-checkpoint result assignment never ran.
      expect(instance.storage.loadState(refs!.counter)).toBe(1);
      expect(instance.storage.loadState(refs!.result)).toBe(2003);
      expect(instance.storage.loadState(refs!.pc)).toBe(2);

      // Re-entering the regenerated key uses the cache; the helper is not replayed.
      instance.deliver('run', true, { simTime: scheduler.now });
      scheduler.start({ maxEntries: 10 });
      expect(refs!.calls.generated).toBe(2);
      expect(instance.storage.loadState(refs!.counter)).toBe(1);
      expect(instance.storage.loadState(refs!.result)).toBe(2003);
      expect(instance.storage.loadState(refs!.pc)).toBe(2);

      instance.destroy();
    } finally {
      delete globals.__micaSelfModifying;
      await temp.cleanup();
    }
  });
});
