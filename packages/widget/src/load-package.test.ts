import { describe, expect, it } from 'vitest';
import { WidgetLoadError, loadWidgetPackage } from './index';
import {
  DEMO_MANIFEST,
  GAUGE_CODE,
  GAUGE_DEFINITION,
  INDICATOR_CODE,
  INDICATOR_DEFINITION,
  createMemoryFiles,
  demoEntries,
} from './test-helpers';

describe('loadWidgetPackage', () => {
  it('loads every declared widget with its definition and source', async () => {
    const widgetPackage = await loadWidgetPackage(createMemoryFiles(demoEntries()));

    expect(widgetPackage.id).toBe('demo-package');
    expect(widgetPackage.version).toBe('1.2.3');
    expect(Object.keys(widgetPackage.modules)).toEqual(['gauge', 'indicator']);
    expect(widgetPackage.modules['indicator']).toEqual({
      definition: {
        ...INDICATOR_DEFINITION,
        displayName: '指示灯',
        description: '亮度指示',
      },
      code: INDICATOR_CODE,
    });
    expect(widgetPackage.modules['gauge']).toEqual({
      definition: GAUGE_DEFINITION,
      code: GAUGE_CODE,
    });
  });

  it('treats a manifest without widgets as an empty package', async () => {
    const widgetPackage = await loadWidgetPackage(
      createMemoryFiles({ 'package.json': JSON.stringify({ name: 'empty', version: '0.1.0' }) }),
    );

    expect(widgetPackage.modules).toEqual({});
    expect(widgetPackage.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the content hash stable for identical content', async () => {
    const first = await loadWidgetPackage(createMemoryFiles(demoEntries()));
    const second = await loadWidgetPackage(createMemoryFiles(demoEntries()));

    expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.contentHash).toBe(first.contentHash);
  });

  it('changes the content hash when a source changes', async () => {
    const entries = demoEntries();
    entries['widgets/gauge.js'] = 'export default () => 3;\n';

    const original = await loadWidgetPackage(createMemoryFiles(demoEntries()));
    const changed = await loadWidgetPackage(createMemoryFiles(entries));

    expect(changed.contentHash).not.toBe(original.contentHash);
  });

  it('reports a missing package.json', async () => {
    await expect(loadWidgetPackage(createMemoryFiles({}))).rejects.toMatchObject({
      name: 'WidgetLoadError',
      code: 'widget/package-not-found',
      path: 'package.json',
    });
  });

  it('reports invalid package.json JSON', async () => {
    await expect(
      loadWidgetPackage(createMemoryFiles({ 'package.json': '{' })),
    ).rejects.toMatchObject({ code: 'widget/invalid-manifest', path: 'package.json' });
  });

  it.each([
    ['a non-object manifest', JSON.stringify([])],
    ['a missing name', JSON.stringify({ version: '1.0.0' })],
    ['a non-kebab-case name', JSON.stringify({ name: 'Demo_Package', version: '1.0.0' })],
    ['a missing version', JSON.stringify({ name: 'demo-package' })],
    ['a non-object widgets index', JSON.stringify({ ...DEMO_MANIFEST, widgets: [] })],
    ['a non-object widget entry', JSON.stringify({ ...DEMO_MANIFEST, widgets: { gauge: 1 } })],
    [
      'a widget entry without a path',
      JSON.stringify({ ...DEMO_MANIFEST, widgets: { gauge: { displayName: 'Gauge' } } }),
    ],
    [
      'a widget entry without a .json path',
      JSON.stringify({ ...DEMO_MANIFEST, widgets: { gauge: { path: 'widgets/gauge.js' } } }),
    ],
  ])('rejects %s', async (_label, manifest) => {
    await expect(
      loadWidgetPackage(createMemoryFiles({ 'package.json': manifest })),
    ).rejects.toMatchObject({ code: 'widget/invalid-manifest' });
  });

  it.each([
    ['a parent segment', '../outside.json'],
    ['an absolute path', '/outside.json'],
    ['a drive letter', 'C:/outside.json'],
    ['backslashes', 'widgets\\gauge.json'],
  ])('rejects a widget path with %s', async (_label, path) => {
    const entries = demoEntries();
    entries['package.json'] = JSON.stringify({
      ...DEMO_MANIFEST,
      widgets: { gauge: { path } },
    });

    await expect(loadWidgetPackage(createMemoryFiles(entries))).rejects.toMatchObject({
      code: 'widget/invalid-manifest',
      packageId: 'demo-package',
      path,
    });
  });

  it('reports a missing widget definition', async () => {
    const entries = demoEntries();
    delete entries['widgets/gauge.json'];

    await expect(loadWidgetPackage(createMemoryFiles(entries))).rejects.toMatchObject({
      code: 'widget/invalid-manifest',
      packageId: 'demo-package',
      path: 'widgets/gauge.json',
    });
  });

  it('reports invalid widget definition JSON', async () => {
    const entries = demoEntries();
    entries['widgets/gauge.json'] = 'not json';

    await expect(loadWidgetPackage(createMemoryFiles(entries))).rejects.toMatchObject({
      code: 'widget/invalid-definition',
      packageId: 'demo-package',
      path: 'widgets/gauge.json',
    });
  });

  it('reports a port with an unknown payload type', async () => {
    const entries = demoEntries();
    entries['widgets/gauge.json'] = JSON.stringify({
      ports: { value: { direction: 'output', type: 'bytes<rgb888>' } },
    });

    await expect(loadWidgetPackage(createMemoryFiles(entries))).rejects.toMatchObject({
      code: 'widget/invalid-definition',
      path: 'widgets/gauge.json',
    });
  });

  it('reports a port with an invalid direction', async () => {
    const entries = demoEntries();
    entries['widgets/gauge.json'] = JSON.stringify({
      ports: { value: { direction: 'sideways', type: 'number' } },
    });

    await expect(loadWidgetPackage(createMemoryFiles(entries))).rejects.toBeInstanceOf(
      WidgetLoadError,
    );
  });

  it('reports a missing implementation', async () => {
    const entries = demoEntries();
    delete entries['widgets/indicator.js'];

    await expect(loadWidgetPackage(createMemoryFiles(entries))).rejects.toMatchObject({
      code: 'widget/no-implementation',
      packageId: 'demo-package',
      path: 'widgets/indicator.js',
    });
  });

  it('reports an implementation without a default export', async () => {
    const entries = demoEntries();
    entries['widgets/gauge.js'] = 'export function createGauge() {\n  return 2;\n}\n';

    await expect(loadWidgetPackage(createMemoryFiles(entries))).rejects.toMatchObject({
      code: 'widget/load-failed',
      packageId: 'demo-package',
      path: 'widgets/gauge.js',
    });
  });

  it.each([
    ['a static import', "import value from './value.js';\nexport default value;\n"],
    ['a side-effect import', "import './style.js';\nexport default 1;\n"],
    ['a bare import', "import { helper } from 'helper';\nexport default helper;\n"],
    ['a dynamic import', "export default () => import('./other.js');\n"],
    ['a re-export', "export { value } from './value.js';\n"],
    ['a namespace re-export', "export * from './all.js';\n"],
  ])('rejects an implementation with %s', async (_label, code) => {
    const entries = demoEntries();
    entries['widgets/gauge.js'] = code;

    await expect(loadWidgetPackage(createMemoryFiles(entries))).rejects.toMatchObject({
      code: 'widget/not-self-contained',
      packageId: 'demo-package',
      path: 'widgets/gauge.js',
    });
  });

  it('allows import-like text inside comments and strings', async () => {
    const entries = demoEntries();
    entries['widgets/gauge.js'] = [
      '// import value from "./value.js";',
      '/* export { value } from "./value.js"; */',
      'const message = "import value from elsewhere";',
      'export default function gauge() {',
      '  return message;',
      '}',
    ].join('\n');

    const widgetPackage = await loadWidgetPackage(createMemoryFiles(entries));
    expect(widgetPackage.modules['gauge']?.code).toContain('message');
  });

  it('reads only the manifest, definitions and implementations', async () => {
    const reads: string[] = [];
    await loadWidgetPackage(createMemoryFiles(demoEntries(), { reads }));

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

  it('wraps every failure in WidgetLoadError', async () => {
    const entries = demoEntries();
    delete entries['widgets/gauge.js'];

    await expect(loadWidgetPackage(createMemoryFiles(entries))).rejects.toBeInstanceOf(
      WidgetLoadError,
    );
  });
});
