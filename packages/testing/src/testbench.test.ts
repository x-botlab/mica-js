import { describe, expect, it } from 'vitest';
import { buttonLedCircuit } from './test-helpers';
import { createTestbench } from './testbench';
import { ms } from './time';

const brightnessEvent = { designator: 'D1', event: 'onDidBrightnessChange' } as const;

describe('production headless testbench', () => {
  it('records initialization and observes real button-to-LED electrical propagation', async () => {
    const bench = await createTestbench({
      ...(await buttonLedCircuit()),
      step: ms(0.01),
      record: [brightnessEvent],
    });
    try {
      expect(bench.events(brightnessEvent).length).toBeGreaterThan(0);
      const press = bench.device('S1').methods.press;
      const getBrightness = bench.device('D1').methods.getBrightness;
      if (!press || !getBrightness) throw new Error('Fixture methods missing');
      expect(await getBrightness(null)).toBe(0);
      await press(true);
      await bench.advanceFor(ms(1));
      expect(await getBrightness(null)).toBeGreaterThan(0.9);
      await press(false);
      await bench.advanceTo(ms(2));
      expect(await getBrightness(null)).toBe(0);
      expect(bench.simTime).toBe(ms(2));
      expect(bench.events(brightnessEvent).at(-1)?.value).toBe(0);
    } finally {
      await bench.dispose();
    }
  });

  it('rejects unreachable targets before advancing and stops at the virtual timeout', async () => {
    const bench = await createTestbench({ ...(await buttonLedCircuit()), step: ms(0.01) });
    try {
      await expect(bench.advanceFor(ms(0.015))).rejects.toThrow('multiple');
      expect(bench.simTime).toBe(0);
      await expect(bench.advanceUntil(() => false, { timeout: ms(0.03) })).rejects.toMatchObject({
        code: 'testing/timeout',
      });
      expect(bench.simTime).toBe(ms(0.03));
      await expect(bench.advanceTo(ms(0.02))).rejects.toThrow('backwards');
    } finally {
      await bench.dispose();
    }
  });

  it('keeps the LED unpowered when its connection to the button is removed', async () => {
    const fixture = await buttonLedCircuit();
    const bench = await createTestbench({
      ...fixture,
      document: { ...fixture.document, wires: [] },
      step: ms(0.01),
    });
    try {
      const press = bench.device('S1').methods.press;
      const brightness = bench.device('D1').methods.getBrightness;
      if (!press || !brightness) throw new Error('Fixture methods missing');
      await press(true);
      await bench.advanceFor(ms(0.1));
      expect(await brightness(null)).toBe(0);
    } finally {
      await bench.dispose();
    }
  });

  it('resets recordings and invalidates previous model clients', async () => {
    const bench = await createTestbench({
      ...(await buttonLedCircuit()),
      step: ms(0.01),
      record: [brightnessEvent],
    });
    const oldPress = bench.device('S1').methods.press;
    if (!oldPress) throw new Error('Fixture method missing');
    try {
      await oldPress(true);
      await bench.advanceFor(ms(0.02));
      await bench.reset();
      expect(bench.simTime).toBe(0);
      expect(bench.events(brightnessEvent).at(-1)?.value).toBe(0);
      await expect(oldPress(false)).rejects.toMatchObject({ code: 'model/disconnected' });
      expect(() => bench.events({ designator: 'S1', event: 'onDidNothing' })).toThrow('Configure');
    } finally {
      await bench.dispose();
    }
    await bench.dispose();
  });

  it('rejects overlapping control operations without changing their target', async () => {
    const bench = await createTestbench({
      ...(await buttonLedCircuit()),
      step: ms(0.01),
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = bench.advanceUntil(
      async () => {
        await gate;
        return true;
      },
      { timeout: ms(1) },
    );
    try {
      await expect(bench.advanceFor(ms(1))).rejects.toMatchObject({ code: 'testing/busy' });
      await expect(bench.dispose()).rejects.toMatchObject({ code: 'testing/busy' });
      expect(bench.simTime).toBe(0);
    } finally {
      release?.();
      await waiting;
      await bench.dispose();
    }
  });

  it('recovers from a model fault by resetting the production runtime', async () => {
    const fixture = await buttonLedCircuit();
    let failNextPress = true;
    const bench = await createTestbench({
      ...fixture,
      async loadModule(files, path) {
        const loaded = await fixture.loadModule(files, path);
        if (files.lock.id !== 'test:button') return loaded;
        if (typeof loaded !== 'object' || loaded === null) throw new Error('Invalid fixture');
        return {
          ...loaded,
          create: (context: { inputs: { pressed: { send(value: boolean): void } } }) => ({
            methods: {
              press(value: boolean) {
                if (failNextPress) {
                  failNextPress = false;
                  throw new Error('Fixture model failure');
                }
                context.inputs.pressed.send(value);
                return null;
              },
            },
            sync() {},
            dispose() {},
          }),
        };
      },
      step: ms(0.01),
    });
    try {
      const failedPress = bench.device('S1').methods.press;
      if (!failedPress) throw new Error('Fixture method missing');
      await expect(failedPress(true)).rejects.toMatchObject({ code: 'model/execution-failed' });
      expect(bench.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'model/execution-failed' }),
      );
      await bench.reset();
      expect(bench.diagnostics).toEqual([]);
      const press = bench.device('S1').methods.press;
      const brightness = bench.device('D1').methods.getBrightness;
      if (!press || !brightness) throw new Error('Fixture methods missing');
      await press(true);
      await bench.advanceFor(ms(0.1));
      expect(await brightness(null)).toBeGreaterThan(0.9);
    } finally {
      await bench.dispose();
    }
  });
});
