import { describe, expect, it } from 'vitest';
import { createScheduler } from '@mica-js/core';
import type { StateRef } from '@mica-js/ir';
import { loadDeviceModule } from '../loader';
import { createTempDevice } from '../test-helpers';
import { createDeviceInstance } from './instance';

interface IntegrationGlobals {
  __micaLifecycleRef?: StateRef<'u32'>;
  __micaDisposed?: number;
}

const globals = globalThis as IntegrationGlobals;

describe('loaded device lifecycle integration', () => {
  it('loads a real JSON/JS pair, builds IR and drives initialize/dispose', async () => {
    const temp = await createTempDevice(
      {
        'demo.json': JSON.stringify({
          properties: {
            speed: { type: 'number', default: 72 },
            label: { type: 'string', default: 'Demo' },
          },
          designatorPrefix: 'U',
        }),
        'demo.js': `
          export default function createDevice(api) {
            const value = api.ir.state('value', 'u32', 0);
            globalThis.__micaLifecycleRef = value;
            globalThis.__micaDisposed = 0;
            const initialize = api.ir.lifecycle('initialize', []);
            initialize.body((b) => {
              b.state.store(value, b.const('u32', api.props.speed));
              b.return([]);
            });
            return {
              initialize,
              onDispose: () => {
                globalThis.__micaDisposed += 1;
              },
            };
          }
        `,
      },
      { 'acme:demo': 'demo' },
    );
    try {
      const scheduler = createScheduler();
      const loaded = await loadDeviceModule('acme:demo', temp.provider);
      const instance = createDeviceInstance(loaded, scheduler, {
        instanceId: 'loaded-demo',
        properties: { speed: 96 },
      });
      expect(instance.state).toBe('initializing');
      scheduler.start();
      expect(instance.state).toBe('ready');
      expect(globals.__micaLifecycleRef).toBeDefined();
      expect(instance.storage.loadState(globals.__micaLifecycleRef!)).toBe(96);
      instance.destroy();
      expect(instance.state).toBe('destroyed');
      expect(globals.__micaDisposed).toBe(1);
    } finally {
      delete globals.__micaLifecycleRef;
      delete globals.__micaDisposed;
      await temp.cleanup();
    }
  });
});
