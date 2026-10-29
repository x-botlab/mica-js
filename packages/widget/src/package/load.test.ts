import { describe, expect, it } from 'vitest';
import { WidgetLoadError, loadWidgetPackage } from '../index';
import {
  DEMO_MANIFEST,
  GAUGE_CODE,
  GAUGE_DEFINITION,
  INDICATOR_CODE,
  INDICATOR_DEFINITION,
  createMemoryFiles,
  demoEntries,
} from '../test-helpers';

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

  it('changes the content hash when the same source moves to another widget id', async () => {
    const named = (widgetId: string): string =>
      JSON.stringify({
        name: 'demo-package',
        version: '1.0.0',
        widgets: { [widgetId]: { path: 'widgets/impl.json' } },
      });
    const entriesFor = (widgetId: string): Record<string, string> => ({
      'package.json': named(widgetId),
      'widgets/impl.json': JSON.stringify({}),
      'widgets/impl.js': GAUGE_CODE,
    });

    const gauge = await loadWidgetPackage(createMemoryFiles(entriesFor('gauge')));
    const meter = await loadWidgetPackage(createMemoryFiles(entriesFor('meter')));

    expect(gauge.modules['gauge']?.code).toBe(meter.modules['meter']?.code);
    expect(meter.contentHash).not.toBe(gauge.contentHash);
  });

  it('changes the content hash when a widget with empty source is added', async () => {
    const entries = demoEntries();
    entries['package.json'] = JSON.stringify({
      ...DEMO_MANIFEST,
      widgets: { ...DEMO_MANIFEST.widgets, blank: { path: 'widgets/blank.json' } },
    });
    entries['widgets/blank.json'] = JSON.stringify({});
    entries['widgets/blank.js'] = '';

    const original = await loadWidgetPackage(createMemoryFiles(demoEntries()));
    const extended = await loadWidgetPackage(createMemoryFiles(entries));

    expect(extended.modules['blank']?.code).toBe('');
    expect(extended.contentHash).not.toBe(original.contentHash);
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

  it('reads the optional delivery declared on a port', async () => {
    const entries = demoEntries();
    entries['widgets/gauge.json'] = JSON.stringify({
      ports: {
        frame: { direction: 'output', type: 'bytes<rgb565>', delivery: 'level' },
        press: { direction: 'input', type: 'boolean', delivery: 'message' },
        value: { direction: 'output', type: 'number' },
      },
    });

    const widgetPackage = await loadWidgetPackage(createMemoryFiles(entries));
    const ports = widgetPackage.modules['gauge']?.definition.ports;

    // RFC 0017: delivery and type are orthogonal, so any combination is accepted.
    expect(ports?.['frame']).toMatchObject({ type: 'bytes<rgb565>', delivery: 'level' });
    expect(ports?.['press']).toMatchObject({ type: 'boolean', delivery: 'message' });
    // An omitted delivery stays absent so the host can apply the payload type default.
    expect(ports?.['value']).toEqual({ direction: 'output', type: 'number' });
    expect('delivery' in (ports?.['value'] ?? {})).toBe(false);
  });

  it('rejects an unknown delivery value', async () => {
    const entries = demoEntries();
    entries['widgets/gauge.json'] = JSON.stringify({
      ports: { value: { direction: 'output', type: 'number', delivery: 'latest' } },
    });

    await expect(loadWidgetPackage(createMemoryFiles(entries))).rejects.toMatchObject({
      code: 'schema/invalid-value',
      packageId: 'demo-package',
      path: 'widgets/gauge.json',
    });
  });

  it('keeps a __proto__ property key out of the definition record', async () => {
    const entries = demoEntries();
    entries['widgets/gauge.json'] =
      '{"properties":{"__proto__":{"type":"color"},"tint":{"type":"color"}},"ports":{}}';

    const widgetPackage = await loadWidgetPackage(createMemoryFiles(entries));
    const properties = widgetPackage.modules['gauge']?.definition.properties;

    expect(properties).toBeDefined();
    expect(Object.keys(properties ?? {})).toEqual(['tint']);
    expect(Object.getPrototypeOf(properties)).toBeNull();
    expect(Object.keys({ ...properties })).toEqual(['tint']);
    expect(properties?.['__proto__']).toBeUndefined();
    expect('type' in (properties ?? {})).toBe(false);
  });

  it('keeps a __proto__ port key out of the definition record', async () => {
    const entries = demoEntries();
    entries['widgets/gauge.json'] =
      '{"ports":{"__proto__":{"direction":"input","type":"number"},"value":{"direction":"output","type":"number"}}}';

    const widgetPackage = await loadWidgetPackage(createMemoryFiles(entries));
    const ports = widgetPackage.modules['gauge']?.definition.ports;

    expect(ports).toBeDefined();
    expect(Object.keys(ports ?? {})).toEqual(['value']);
    expect(Object.getPrototypeOf(ports)).toBeNull();
    expect(ports?.['__proto__']).toBeUndefined();
    // The declared descriptor must not leak in as an inherited member.
    expect('direction' in (ports ?? {})).toBe(false);
    expect((ports as Record<string, unknown> | undefined)?.['direction']).toBeUndefined();
  });

  it('returns prototype-free records when a definition declares no properties or ports', async () => {
    const entries = demoEntries();
    entries['widgets/gauge.json'] = JSON.stringify({});

    const widgetPackage = await loadWidgetPackage(createMemoryFiles(entries));
    const definition = widgetPackage.modules['gauge']?.definition;

    expect(Object.getPrototypeOf(definition?.properties)).toBeNull();
    expect(Object.getPrototypeOf(definition?.ports)).toBeNull();
    expect(Object.keys(definition?.properties ?? {})).toEqual([]);
    expect(Object.keys(definition?.ports ?? {})).toEqual([]);
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

  it.each([
    ['displayName', { displayName: 42 }],
    ['description', { description: ['not', 'text'] }],
  ])('reports a non-string %s against package.json', async (_label, extra) => {
    const entries = demoEntries();
    entries['package.json'] = JSON.stringify({
      ...DEMO_MANIFEST,
      widgets: { gauge: { path: 'widgets/gauge.json', ...extra } },
    });

    const failure = await loadWidgetPackage(createMemoryFiles(entries)).catch(
      (cause: unknown) => cause,
    );

    expect(failure).toMatchObject({
      code: 'widget/invalid-manifest',
      packageId: 'demo-package',
      path: 'package.json',
    });
    expect((failure as Error).message).toContain('in package.json');
    expect((failure as Error).message).not.toContain('widgets/gauge.json');
  });

  it('passes implementation source through untouched', async () => {
    const entries = demoEntries();
    const code = "import x from './y.js';\nexport default x;\n";
    entries['widgets/gauge.js'] = code;

    const widgetPackage = await loadWidgetPackage(createMemoryFiles(entries));

    expect(widgetPackage.modules['gauge']?.code).toBe(code);
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
