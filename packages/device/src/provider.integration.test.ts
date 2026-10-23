import { describe, expect, it } from 'vitest';
import { createScheduler } from '@mica-js/core';
import type { ArrayRef } from '@mica-js/ir';
import { loadDeviceModule } from './loader';
import { createTempDevice } from './test-helpers';
import { createDeviceInstance } from './lifecycle/instance';

interface ProviderGlobals {
  __micaProviderValues?: ArrayRef<'u32'>;
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
});
