import { describe, expect, it } from 'vitest';
import type { WidgetModule } from '../types';
import { createStaticWidgetProvider } from './static';

describe('createStaticWidgetProvider', () => {
  const module: WidgetModule = {
    definition: { properties: {}, ports: {} },
    code: 'export default 1;',
  };

  it('resolves modules from the fixed table', async () => {
    const provider = createStaticWidgetProvider({ 'demo:indicator': module });

    await expect(provider.resolve('demo:indicator')).resolves.toBe(module);
  });

  it('returns undefined for unknown references', async () => {
    const provider = createStaticWidgetProvider({ 'demo:indicator': module });

    await expect(provider.resolve('demo:other')).resolves.toBeUndefined();
    await expect(provider.resolve('')).resolves.toBeUndefined();
  });

  it('does not observe later changes to the source record', async () => {
    const modules: Record<string, WidgetModule> = { 'demo:indicator': module };
    const provider = createStaticWidgetProvider(modules);
    delete modules['demo:indicator'];

    await expect(provider.resolve('demo:indicator')).resolves.toBe(module);
  });
});
