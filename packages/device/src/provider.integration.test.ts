import { describe, expect, it } from 'vitest';
import { createScheduler } from '@mica-js/core';
import type { ArrayRef, StateRef } from '@mica-js/ir';
import { loadDeviceModule } from './loader';
import { createTempDevice } from './test-helpers';
import { createDeviceInstance } from './lifecycle/instance';

interface ProviderGlobals {
  __micaProviderValues?: ArrayRef<'u32'>;
  __micaRecoveryResult?: StateRef<'u32'>;
  __micaRecoveryTracked?: StateRef<'u32'>;
}

const globals = globalThis as ProviderGlobals;

const factorySource = `
  export default function createDevice(api) {
    const ir = api.ir;
    const rom = ir.bytes('rom', new Uint8Array([2, 3, 4, 5]), { readonly: true, unitBytes: 2 });
    const values = ir.array('values', 'u32', [0, 0]);
    const step = ir.entry('step', ['u32']);
    const code = ir.provider(
      'code',
      { keyTypes: ['u32'], params: [], results: [], reads: [rom], imports: [values] },
      (gen, [slot]) => {
        const bytes = gen.readBytes(rom, slot * 2, 2);
        const value = bytes[0] * 256 + bytes[1];
        return gen.function((b) => {
          b.array.store(values, b.const('u32', slot), b.const('u32', value));
          b.return([]);
        });
      }
    );
    step.body((b, [slot]) => b.dispatch(code, [slot], []));
    const initialize = ir.lifecycle('initialize', []);
    initialize.body((b) => {
      b.event.at(step, b.event.now(), [b.const('u32', 0)]);
      b.event.at(step, b.event.now(), [b.const('u32', 1)]);
      b.return([]);
    });
    globalThis.__micaProviderValues = values;
    return { initialize };
  }
`;

const recoveryFactorySource = `
  export default function createDevice(api) {
    const ir = api.ir;
    const rom = ir.bytes('rom', new Uint8Array([1, 2, 3, 4]), { readonly: true, unitBytes: 2 });
    const tracked = ir.state('tracked', 'u32', 0);
    const pc = ir.state('pc', 'u32', 0);
    const result = ir.state('result', 'u32', 0);
    const update = ir.func('update', { params: [], results: [] });
    update.body((b) => {
      b.state.store(tracked, b.const('u32', 1));
      b.return([]);
    });
    const code = ir.provider(
      'code',
      {
        keyTypes: ['u32'],
        params: [],
        results: [],
        reads: [rom, tracked],
        imports: [pc, result, update]
      },
      (gen, [address]) => {
        gen.readState(tracked);
        const value = gen.readBytes(rom, address, 1)[0];
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
      }
    );
    const step = ir.entry('step', []);
    step.body((b) => b.dispatch(code, [b.state.load(pc)], []));
    const initialize = ir.lifecycle('initialize', []);
    initialize.body((b) => {
      b.event.at(step, b.event.now(), []);
      b.return([]);
    });
    globalThis.__micaRecoveryResult = result;
    globalThis.__micaRecoveryTracked = tracked;
    return { initialize };
  }
`;

describe('device layer provider integration', () => {
  it('declares api.ir.provider and executes generated artifacts through the scheduler', async () => {
    const temp = await createTempDevice(
      { 'mcu.json': JSON.stringify({}), 'mcu.js': factorySource },
      { 'acme:mcu': 'mcu' },
    );
    try {
      const scheduler = createScheduler();
      const loaded = await loadDeviceModule('acme:mcu', temp.provider);
      const instance = createDeviceInstance(loaded, scheduler, { instanceId: 'mcu-provider' });
      expect(instance.state).toBe('initializing');
      scheduler.start();
      expect(instance.state).toBe('ready');

      const values = globals.__micaProviderValues;
      expect(values).toBeDefined();
      // The artifact uses array.store, which no static body uses: generated code is validated
      // against the interpreter's core set while grants still bound the resources.
      expect(instance.storage.loadArray(values!, 0)).toBe(0x0203);
      expect(instance.storage.loadArray(values!, 1)).toBe(0x0405);

      instance.destroy();
    } finally {
      delete globals.__micaProviderValues;
      await temp.cleanup();
    }
  });

  it('recovers a generated artifact through a checkpoint within one entry', async () => {
    const temp = await createTempDevice(
      { 'mcu.json': JSON.stringify({}), 'mcu.js': recoveryFactorySource },
      { 'acme:mcu': 'mcu' },
    );
    try {
      const scheduler = createScheduler();
      const loaded = await loadDeviceModule('acme:mcu', temp.provider);
      const instance = createDeviceInstance(loaded, scheduler, { instanceId: 'mcu-recovery' });
      scheduler.start();

      expect(instance.state).toBe('ready');
      // Recovery happens inside the 0 ps entry and does not advance device time.
      expect(scheduler.now).toBe(0);
      const result = globals.__micaRecoveryResult;
      const tracked = globals.__micaRecoveryTracked;
      expect(result).toBeDefined();
      expect(tracked).toBeDefined();
      expect(instance.storage.loadState(tracked!)).toBe(1);
      expect(instance.storage.loadState(result!)).toBe(2003);

      instance.destroy();
    } finally {
      delete globals.__micaRecoveryResult;
      delete globals.__micaRecoveryTracked;
      await temp.cleanup();
    }
  });
});
