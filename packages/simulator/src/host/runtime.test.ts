import { parseSchematic } from '@mica-js/core/schematic';
import { describe, expect, it } from 'vitest';
import { createSchematicDeviceSimulationHost } from './runtime';
import type { SimulationPublish } from './types';
import {
  TOGGLE_DEVICE,
  TOGGLE_SYMBOL,
  createToggleSymbols,
  resolveToggleDevice,
} from './test-helpers';

function toggleSchematic() {
  return parseSchematic(
    JSON.stringify({
      version: 1,
      sheet: {
        symbols: [
          {
            id: TOGGLE_SYMBOL,
            device: TOGGLE_DEVICE,
            designator: 'K1',
            x: 0,
            y: 0,
            rotation: 0,
          },
        ],
        wires: [],
        junctions: [],
      },
    }),
  );
}

function createHost(): {
  readonly host: ReturnType<typeof createSchematicDeviceSimulationHost>;
  readonly reads: string[];
  readonly publishes: SimulationPublish[];
} {
  const reads: string[] = [];
  const publishes: SimulationPublish[] = [];
  const bytes = new TextEncoder().encode(JSON.stringify(toggleSchematic()));
  const host = createSchematicDeviceSimulationHost({
    read: async (uri) => {
      reads.push(uri);
      return bytes;
    },
    devices: createToggleSymbols(),
    resolveDevice: resolveToggleDevice,
  });
  host.onDidPublish((publish) => publishes.push(publish));
  return { host, reads, publishes };
}

describe('createSchematicDeviceSimulationHost', () => {
  it('loads a schematic through the provided reader and reports caller-declared topics', async () => {
    const { host, reads } = createHost();
    try {
      await host.loadSchematic('file:///boards/demo.sch');

      expect(reads).toEqual(['file:///boards/demo.sch']);
      expect(await host.getSchematic()).toMatchObject({ version: 1 });
      expect(await host.getTopics()).toEqual([
        {
          symbol: TOGGLE_SYMBOL,
          designator: 'K1',
          port: 'lamp',
          direction: 'input',
          type: 'boolean',
          title: 'Lamp',
        },
        {
          symbol: TOGGLE_SYMBOL,
          designator: 'K1',
          port: 'state',
          direction: 'output',
          type: 'boolean',
          title: 'Lamp state',
        },
      ]);
    } finally {
      await host.dispose();
    }
  });

  it('delivers at the next step and publishes what the binding reads', async () => {
    const { host, publishes } = createHost();
    try {
      await host.loadSchematic('file:///boards/demo.sch');
      publishes.length = 0;

      await host.deliver({ symbol: TOGGLE_SYMBOL, port: 'lamp' }, true);
      const report = await host.tick(10_000);

      expect(report).toEqual({ simTime: 10_000, executed: 1 });
      expect(publishes).toEqual([
        {
          target: { symbol: TOGGLE_SYMBOL, port: 'state' },
          payload: true,
          simTime: 10_000,
        },
      ]);

      await host.deliver({ symbol: TOGGLE_SYMBOL, port: 'lamp' }, false);
      await host.tick(10_000);
      expect(publishes.at(-1)?.payload).toBe(false);
      expect(await host.getSimTime()).toBe(20_000);
    } finally {
      await host.dispose();
    }
  });

  it('publishes a level topic only when its value changes', async () => {
    const { host, publishes } = createHost();
    try {
      await host.loadSchematic('file:///boards/demo.sch');
      // The first step after a load reports the initial level, so widgets start in sync.
      await host.tick(10_000);
      expect(publishes).toEqual([
        { target: { symbol: TOGGLE_SYMBOL, port: 'state' }, payload: false, simTime: 10_000 },
      ]);

      // A silent circuit keeps the value; nothing republishes it step after step.
      await host.tick(10_000);
      await host.tick(10_000);
      expect(publishes).toHaveLength(1);

      await host.deliver({ symbol: TOGGLE_SYMBOL, port: 'lamp' }, true);
      await host.tick(10_000);
      expect(publishes).toHaveLength(2);
      expect(publishes.at(-1)).toEqual({
        target: { symbol: TOGGLE_SYMBOL, port: 'state' },
        payload: true,
        simTime: 40_000,
      });

      // Holding the level is not news either.
      await host.tick(10_000);
      await host.tick(10_000);
      expect(publishes).toHaveLength(2);
    } finally {
      await host.dispose();
    }
  });

  it('publishes every level again after a reset', async () => {
    const { host, publishes } = createHost();
    try {
      await host.loadSchematic('file:///boards/demo.sch');
      await host.deliver({ symbol: TOGGLE_SYMBOL, port: 'lamp' }, true);
      await host.tick(10_000);
      expect(publishes.at(-1)?.payload).toBe(true);

      await host.reset();
      publishes.length = 0;
      await host.tick(10_000);

      expect(publishes).toEqual([
        { target: { symbol: TOGGLE_SYMBOL, port: 'state' }, payload: false, simTime: 10_000 },
      ]);
    } finally {
      await host.dispose();
    }
  });

  it('resets the circuit clock without unloading the schematic', async () => {
    const { host } = createHost();
    try {
      await host.loadSchematic('file:///boards/demo.sch');
      await host.tick(10_000);
      expect(await host.getSimTime()).toBe(10_000);

      await host.reset();

      expect(await host.getSimTime()).toBe(0);
      expect(await host.getSchematic()).toBeDefined();
      expect(await host.getTopics()).toHaveLength(2);
    } finally {
      await host.dispose();
    }
  });

  it('clears the runtime when loadSchematic receives undefined', async () => {
    const { host } = createHost();
    try {
      await host.loadSchematic('file:///boards/demo.sch');
      await host.loadSchematic(undefined);
      expect(await host.getSchematic()).toBeUndefined();
      expect(await host.getTopics()).toEqual([]);
      expect(await host.getSimTime()).toBe(0);
    } finally {
      await host.dispose();
    }
  });

  it('rejects delivery without a loaded schematic or an unknown endpoint', async () => {
    const { host } = createHost();
    try {
      await expect(host.deliver({ symbol: TOGGLE_SYMBOL, port: 'lamp' }, true)).rejects.toThrow(
        'no loaded schematic',
      );

      await host.loadSchematic('file:///boards/demo.sch');
      await expect(
        host.deliver({ symbol: TOGGLE_SYMBOL, port: 'lamp' }, 'not-a-boolean'),
      ).rejects.toThrow('expects a boolean payload');
      await expect(host.deliver({ symbol: 'missing', port: 'lamp' }, true)).rejects.toThrow(
        'Unknown device input',
      );
      await expect(host.deliver({ symbol: TOGGLE_SYMBOL, port: 'state' }, true)).rejects.toThrow(
        'Unknown device input',
      );
    } finally {
      await host.dispose();
    }
  });

  it('reports an unresolved reference instead of inventing a model', async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        sheet: {
          symbols: [{ id: TOGGLE_SYMBOL, device: 'test:missing', x: 0, y: 0, rotation: 0 }],
          wires: [],
          junctions: [],
        },
      }),
    );
    const host = createSchematicDeviceSimulationHost({
      read: async () => bytes,
      devices: createToggleSymbols(),
      resolveDevice: resolveToggleDevice,
    });
    try {
      await expect(host.loadSchematic('file:///boards/missing.sch')).rejects.toMatchObject({
        code: 'unresolved-device',
      });
      expect(await host.getTopics()).toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  it('requires a resolver, because the package carries no built-in catalog', () => {
    expect(() =>
      createSchematicDeviceSimulationHost({
        read: async () => new Uint8Array(),
      } as unknown as Parameters<typeof createSchematicDeviceSimulationHost>[0]),
    ).toThrow('resolveDevice');
  });
});
