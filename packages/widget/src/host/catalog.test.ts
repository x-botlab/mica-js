import { describe, expect, it } from 'vitest';
import { HostBindingCatalog } from './catalog';

describe('HostBindingCatalog', () => {
  it('records resolved widget definitions independently of a device host', () => {
    const catalog = new HostBindingCatalog();
    expect(catalog.knows('demo:indicator')).toBe(false);
    catalog.recordDefinition('demo:indicator', {
      properties: { label: { type: 'string', default: '' } },
      ports: { value: { direction: 'input', type: 'number' } },
    });
    expect(catalog.knows('demo:indicator')).toBe(true);
    expect(catalog.widgetDefinition('demo:indicator')).toEqual({
      propertyKeys: ['label'],
      ports: { value: { direction: 'input', type: 'number' } },
    });
  });

  it('accepts caller-resolved topic facts and excludes unsupported payload types', () => {
    const catalog = new HostBindingCatalog();
    catalog.setDeviceFacts({
      schematics: ['board.sch', undefined, ''],
      schematic: undefined,
      topics: [
        { symbol: 'led', port: 'value', direction: 'output', type: 'number' },
        { symbol: 'opaque', port: 'value', direction: 'input', type: 'unsupported' },
      ],
    });
    expect(catalog.hasSchematic('board.sch')).toBe(true);
    expect(catalog.hasSchematic('')).toBe(false);
    expect(catalog.hasSymbol('led')).toBe(true);
    expect(catalog.hasSymbol('opaque')).toBe(true);
    expect(catalog.symbolPort('led', 'value')).toEqual({ direction: 'output', type: 'number' });
    expect(catalog.symbolPort('opaque', 'value')).toBeUndefined();
  });

  it('replaces old topic facts without losing widget definitions', () => {
    const catalog = new HostBindingCatalog();
    catalog.recordDefinition('demo:indicator', { properties: {}, ports: {} });
    catalog.setDeviceFacts({
      schematics: ['old.sch'],
      schematic: undefined,
      topics: [{ symbol: 'led', port: 'value', direction: 'output', type: 'number' }],
    });
    catalog.setDeviceFacts({ schematics: [], schematic: undefined, topics: [] });
    expect(catalog.hasSchematic('old.sch')).toBe(false);
    expect(catalog.hasSymbol('led')).toBe(false);
    expect(catalog.symbolPort('led', 'value')).toBeUndefined();
    expect(catalog.knows('demo:indicator')).toBe(true);
  });
});
