import { describe, expect, it } from 'vitest';
import { WidgetLoadError } from '../errors';
import { createPackageWidgetProvider } from './package-provider';
import { createMemoryFiles, demoEntries } from '../test-helpers';

describe('createPackageWidgetProvider', () => {
  it('resolves widgets of a loaded package by <packageId>:<widgetId>', async () => {
    const provider = await createPackageWidgetProvider({ files: createMemoryFiles(demoEntries()) });

    const indicator = await provider.resolve('demo-package:indicator');
    const gauge = await provider.resolve('demo-package:gauge');

    expect(indicator?.code).toContain('function indicator');
    expect(indicator?.definition.displayName).toBe('指示灯');
    expect(gauge?.definition.ports['value']).toEqual({
      direction: 'output',
      type: 'number',
      title: '读数',
    });
  });

  it('returns undefined for unknown references', async () => {
    const provider = await createPackageWidgetProvider({ files: createMemoryFiles(demoEntries()) });

    await expect(provider.resolve('demo-package:missing')).resolves.toBeUndefined();
    await expect(provider.resolve('other-package:indicator')).resolves.toBeUndefined();
    await expect(provider.resolve('indicator')).resolves.toBeUndefined();
    await expect(provider.resolve('')).resolves.toBeUndefined();
  });

  it('merges several package sources', async () => {
    const second = demoEntries();
    second['package.json'] = JSON.stringify({
      name: 'second-package',
      version: '2.0.0',
      widgets: { gauge: { path: 'widgets/gauge.json' } },
    });

    const provider = await createPackageWidgetProvider({
      files: [
        createMemoryFiles(demoEntries(), { label: 'first' }),
        createMemoryFiles(second, { label: 'second' }),
      ],
    });

    await expect(provider.resolve('demo-package:gauge')).resolves.toBeDefined();
    await expect(provider.resolve('second-package:gauge')).resolves.toBeDefined();
    await expect(provider.resolve('second-package:indicator')).resolves.toBeUndefined();
  });

  it('rejects duplicate package ids', async () => {
    await expect(
      createPackageWidgetProvider({
        files: [
          createMemoryFiles(demoEntries(), { label: 'first' }),
          createMemoryFiles(demoEntries(), { label: 'second' }),
        ],
      }),
    ).rejects.toMatchObject({ code: 'widget/invalid-manifest', packageId: 'demo-package' });
  });

  it('reads every file once and never re-reads on resolve', async () => {
    const reads: string[] = [];
    const provider = await createPackageWidgetProvider({
      files: createMemoryFiles(demoEntries(), { reads }),
    });

    await provider.resolve('demo-package:indicator');
    await provider.resolve('demo-package:indicator');
    await provider.resolve('demo-package:gauge');

    expect(reads.sort()).toEqual(
      [
        'package.json',
        'widgets/gauge.js',
        'widgets/gauge.json',
        'widgets/indicator.js',
        'widgets/indicator.json',
      ].sort(),
    );
  });

  it('rejects a broken package during construction', async () => {
    const entries = demoEntries();
    delete entries['widgets/indicator.js'];

    await expect(
      createPackageWidgetProvider({ files: createMemoryFiles(entries) }),
    ).rejects.toBeInstanceOf(WidgetLoadError);
  });

  it('accepts a single file source', async () => {
    const provider = await createPackageWidgetProvider({ files: createMemoryFiles(demoEntries()) });
    await expect(provider.resolve('demo-package:indicator')).resolves.toBeDefined();
  });
});
