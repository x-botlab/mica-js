import { describe, expect, it } from 'vitest';
import { createPackageWidgetProvider } from '@mica-js/widget';
import { PLAYGROUND_WIDGET_FILES, PLAYGROUND_WIDGETS, playgroundWidgetSource } from './index';

describe('playground widget package', () => {
  it('loads every declared widget definition and implementation', async () => {
    const provider = await createPackageWidgetProvider({ files: PLAYGROUND_WIDGET_FILES });
    for (const ref of PLAYGROUND_WIDGETS) {
      const module = await provider.resolve(ref);
      expect(module, ref).toBeDefined();
      expect(module?.code.length ?? 0).toBeGreaterThan(0);
      expect(Object.keys(module?.definition.properties ?? {}).length).toBeGreaterThan(0);
    }
  });

  it('resolves to undefined for an unknown widget', async () => {
    const provider = await createPackageWidgetProvider({ files: PLAYGROUND_WIDGET_FILES });
    expect(await provider.resolve('lab:nope')).toBeUndefined();
  });

  it('ships syntactically valid ES modules with a default factory', async () => {
    for (const ref of PLAYGROUND_WIDGETS) {
      const [, widgetId] = ref.split(':');
      const source = playgroundWidgetSource(`${widgetId}/${widgetId}.js`);
      expect(source, ref).toBeDefined();
      const url = `data:text/javascript;base64,${Buffer.from(source ?? '', 'utf8').toString('base64')}`;
      const module = (await import(/* @vite-ignore */ url)) as { default?: unknown };
      expect(typeof module.default, ref).toBe('function');
    }
  });

  it('declares the ports the demo scenarios bind', async () => {
    const provider = await createPackageWidgetProvider({ files: PLAYGROUND_WIDGET_FILES });
    const potentiometer = await provider.resolve('lab:potentiometer');
    expect(potentiometer?.definition.ports.voltage).toMatchObject({
      direction: 'output',
      type: 'number',
    });
    const power = await provider.resolve('lab:power-switch');
    expect(power?.definition.ports.power).toMatchObject({
      direction: 'output',
      type: 'boolean',
    });
    const text = await provider.resolve('lab:text-display');
    expect(text?.definition.ports.text).toMatchObject({ direction: 'input', type: 'string' });
    expect(text?.definition.ports.send).toMatchObject({ direction: 'output', type: 'string' });
  });
});
