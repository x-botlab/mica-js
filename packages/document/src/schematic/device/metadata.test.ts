import { describe, expect, it } from 'vitest';
import { SchematicError } from '../../format/errors';
import { createDeviceRegistry } from './registry';
import { parseDeviceReference } from './reference';
import { loadSchematic } from '../load/load';
import {
  parseDeviceMetadata,
  deviceMetadataPropertyDescriptors,
  deviceMetadataSymbol,
  type DeviceMetadata,
} from './metadata';

const metadata = (): DeviceMetadata => ({
  kind: 'device',
  id: 'part-1',
  version: '1',
  displayName: 'Part',
  properties: {},
  pins: { A: { label: 'Input' } },
  ports: {},
});

const custom = (): DeviceMetadata => ({
  ...metadata(),
  symbol: {
    bounds: { x: -10, y: -20, width: 20, height: 40 },
    graphics: [
      { type: 'line', from: [0, 0], to: [10, 10], fill: 'none', strokeWidth: 1 },
      {
        type: 'polyline',
        points: [
          [0, 0],
          [10, 10],
        ],
        closed: true,
      },
      { type: 'rect', x: 0, y: 0, width: 1, height: 2, fill: 'background' },
      { type: 'circle', center: [0, 0], radius: 1 },
      { type: 'arc', center: [0, 0], radius: 1, startAngle: 90, sweepAngle: -360 },
      { type: 'text', position: [1, 2], text: 'Part', align: 'center', fontSize: 10 },
    ],
    pins: {
      A: {
        position: [-10, 0],
        direction: 'up',
        label: { visible: true, position: [-9, 1], align: 'right' },
      },
    },
    annotations: { designator: { position: [0, -30], align: 'center' } },
  },
});

describe('device metadata', () => {
  it('retains file constraints in property panel descriptors', () => {
    const raw: DeviceMetadata = {
      ...metadata(),
      properties: {
        firmware: {
          type: 'bytes',
          required: true,
          editor: {
            kind: 'file',
            extensions: ['.bin', '.HEX', '.tar.gz'],
            maxSize: 1048576,
          },
        },
      },
    };
    expect(parseDeviceMetadata(raw)).toBe(raw);
    expect(deviceMetadataPropertyDescriptors(raw).get('firmware')?.editor).toEqual(
      raw.properties!.firmware!.editor,
    );
    for (const editor of [
      { kind: 'file', extensions: ['bin'] },
      { kind: 'file', extensions: ['.'] },
      { kind: 'file', extensions: ['.bin', '.bin'] },
      { kind: 'file', maxSize: 0 },
      { kind: 'file', maxSize: 1.5 },
    ])
      expect(() =>
        parseDeviceMetadata({
          ...raw,
          properties: { firmware: { type: 'bytes', required: true, editor } },
        }),
      ).toThrow(SchematicError);
  });
  it('preserves optional platform references without resolving targets', () => {
    const raw: DeviceMetadata = {
      ...metadata(),
      templates: ['platform:c51'],
      recommends: { widgets: ['demo:voltmeter'] },
    };
    expect(parseDeviceMetadata(raw)).toBe(raw);
    expect(() => parseDeviceMetadata({ ...raw, templates: [''] })).toThrow(SchematicError);
    expect(() => parseDeviceMetadata({ ...raw, recommends: { widgets: ['x', 'x'] } })).toThrow(
      SchematicError,
    );
    expect(() => parseDeviceMetadata({ ...raw, recommends: { unknown: [] } })).toThrow(
      SchematicError,
    );
  });
  it('accepts omitted maps and normalizes them as empty', () => {
    const raw = { kind: 'device', id: 'minimal', version: '1', displayName: 'Minimal' };
    const parsed = parseDeviceMetadata(raw);
    expect(parsed).toBe(raw);
    expect(parsed).not.toHaveProperty('properties');
    expect(deviceMetadataPropertyDescriptors(parsed).size).toBe(0);
    expect(deviceMetadataSymbol(parsed).pins).toEqual({});
    const registry = createDeviceRegistry([{ packageId: 'pkg', devices: [{ id: raw.id, raw }] }]);
    expect(registry.resolve('pkg:minimal')?.symbol?.pins).toEqual({});
    expect(() => parseDeviceMetadata({ ...raw, pins: null })).toThrow(SchematicError);
  });

  it('accepts SDK optional port delivery and designator alignment without inserting defaults', () => {
    const raw = {
      ...custom(),
      ports: { value: { direction: 'input', type: 'number' } },
      symbol: {
        ...custom().symbol,
        annotations: { designator: { position: [0, -30] } },
      },
    };
    const parsed = parseDeviceMetadata(raw);
    expect(parsed).toBe(raw);
    expect(parsed.ports?.value).not.toHaveProperty('delivery');
    expect(deviceMetadataSymbol(parsed).annotations?.designator).not.toHaveProperty('align');
  });

  it('requires kind rather than type in editors', () => {
    expect(() =>
      parseDeviceMetadata({
        ...metadata(),
        properties: {
          p: { type: 'number', required: false, editor: { type: 'number' } },
        },
      }),
    ).toThrow(SchematicError);
  });
  it.each(['MCU-123', '123', '-MCU', '-', '--'])(
    'loads and resolves schema-valid device id %j',
    (id) => {
      const raw = { ...metadata(), id };
      const registry = createDeviceRegistry([
        { packageId: '@scope/devices', devices: [{ id, raw }] },
      ]);
      const reference = `@scope/devices:${id}`;
      expect(registry.resolve(reference)?.deviceId).toBe(id);
      expect(registry.getDeviceSymbol(parseDeviceReference(reference)!)).toBeDefined();
      const loaded = loadSchematic(
        {
          version: 1,
          sheet: {
            symbols: [
              {
                id: '00000002-2dc0-44c6-8963-e4ea065d722b',
                device: reference,
                x: 0,
                y: 0,
                rotation: 0,
              },
            ],
            wires: [],
            junctions: [],
          },
        },
        { devices: registry },
      );
      expect(loaded.document.sheet.symbols[0]?.device).toBe(reference);
    },
  );
  it('accepts objects and JSON without inserting defaults or changing input', () => {
    const raw = custom();
    expect(parseDeviceMetadata(raw)).toBe(raw);
    expect(parseDeviceMetadata(JSON.stringify(raw))).toEqual(raw);
    expect(
      parseDeviceMetadata({ ...metadata(), tags: [], description: ' ', license: 'MIT' }),
    ).toBeDefined();
    expect(raw.symbol?.graphics[1]).not.toHaveProperty('fill');
    expect(() => parseDeviceMetadata('{')).toThrow(SchematicError);
  });

  it.each([
    { kind: 'widget' },
    { id: 'bad_id' },
    { version: '' },
    { displayName: '' },
    { unexpected: true },
    { description: '' },
    { license: '' },
    { tags: ['x', 'x'] },
    { tags: [''] },
    { designatorPrefix: 'R X' },
    { pins: { A: { x: 1 } } },
    { ports: { p: { direction: 'input', type: 'float', delivery: 'level' } } },
    { properties: { p: { type: 'number' } } },
    { properties: { p: { type: 'bytes', required: true, default: null } } },
    { properties: { p: { type: 'enum', required: false } } },
    { properties: { p: { type: 'enum', required: false, enumName: 'Mode', values: [] } } },
    { properties: { p: { type: 'enum', required: false, enumName: 'Mode', values: ['a', 'a'] } } },
    { properties: { p: { type: 'string', required: false, values: ['a'] } } },
    { properties: { p: { type: 'string', required: false, enumName: 'Bad' } } },
    { properties: { p: { type: 'number', required: false, order: -1 } } },
    { properties: { p: { type: 'number', required: false, editor: { kind: 'number', step: 0 } } } },
    { properties: { p: { type: 'string', required: false, editor: { kind: 'text', min: 1 } } } },
  ])('rejects invalid metadata %j', (patch) => {
    expect(() => parseDeviceMetadata({ ...metadata(), ...patch })).toThrow(SchematicError);
  });

  it.each([
    { type: 'arc', center: [0, 0], radius: 1, startAngle: 0, sweepAngle: 0 },
    { type: 'arc', center: [0, 0], radius: 1, startAngle: 0, sweepAngle: 361 },
    { type: 'rect', x: 0, y: 0, width: 0, height: 1 },
    { type: 'circle', center: [0, 0], radius: -1 },
    { type: 'line', from: [0, 0, 1], to: [0, 0] },
    { type: 'line', from: [0, 0], to: [0, Number.NaN] },
    { type: 'line', from: [0, 0], to: [0, 0], radius: 1 },
    { type: 'polyline', points: [[0, 0]] },
    { type: 'text', position: [0, 0], text: '', fontSize: 0 },
    { type: 'text', position: [0, 0], text: '', strokeWidth: 0 },
  ])('rejects invalid graphics %j', (graphic) => {
    expect(() =>
      parseDeviceMetadata({ ...custom(), symbol: { ...custom().symbol, graphics: [graphic] } }),
    ).toThrow(SchematicError);
  });

  it('reports escaped JSON pointers and forbids nested unknown fields', () => {
    try {
      parseDeviceMetadata({
        ...metadata(),
        properties: { 'a/b~c': { type: 'number', required: false, unknown: 1 } },
      });
      expect.fail('expected validation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(SchematicError);
      expect((error as SchematicError).diagnostics[0]?.pointer).toBe('/properties/a~1b~0c/unknown');
    }
    for (const symbol of [
      { ...custom().symbol, bounds: { x: 0, y: 0, width: 1, height: 1, unknown: 1 } },
      {
        ...custom().symbol,
        pins: { A: { position: [0, 0], direction: 'left', label: { visible: true, unknown: 1 } } },
      },
      {
        ...custom().symbol,
        annotations: { designator: { position: [0, 0], align: 'left', unknown: 1 } },
      },
    ])
      expect(() => parseDeviceMetadata({ ...metadata(), symbol })).toThrow(SchematicError);
  });

  it('normalizes descriptors without replacing property type with editor type', () => {
    const descriptors = deviceMetadataPropertyDescriptors(
      parseDeviceMetadata({
        ...metadata(),
        properties: {
          count: {
            type: 'number',
            required: false,
            default: 2,
            unit: 'V',
            group: 'Basic',
            order: 0,
            editor: { kind: 'number', min: 0, max: 10, step: 1 },
          },
          mode: {
            type: 'enum',
            required: true,
            enumName: 'Mode',
            values: ['a', 'b'],
            editor: { kind: 'select', labels: { a: 'Alpha' } },
          },
          data: {
            type: 'bytes',
            required: false,
            editor: { kind: 'file' },
            default: { src: 'data.bin', mode: 'file' },
          },
          nullable: { type: 'string', required: false, nullable: true, default: null },
          arbitrary: {
            type: 'string',
            required: false,
            default: { anything: 1 },
            editor: { kind: 'number' },
          },
        },
      }),
    );
    expect(descriptors.get('count')).toMatchObject({
      type: 'number',
      required: false,
      default: 2,
      group: 'Basic',
      order: 0,
      unit: 'V',
      min: 0,
      max: 10,
      step: 1,
    });
    expect(descriptors.get('mode')).toMatchObject({
      required: true,
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'b' },
      ],
    });
    expect(descriptors.get('data')).toMatchObject({
      type: 'binary',
      default: { src: 'data.bin', mode: 'file' },
    });
    expect(descriptors.get('nullable')?.default).toBeNull();
    expect(descriptors.get('arbitrary')?.type).toBe('string');
    expect(descriptors.get('arbitrary')).not.toHaveProperty('default');
  });

  it('preserves custom graphics, labels, annotation and maps direction', () => {
    const raw = custom();
    const symbol = deviceMetadataSymbol(raw);
    expect(symbol.graphics).toBe(raw.symbol?.graphics);
    expect(symbol.annotations).toBe(raw.symbol?.annotations);
    expect(symbol.pins.A).toEqual({
      x: -10,
      y: 0,
      side: 'top',
      displayName: 'Input',
      label: { visible: true, position: [-9, 1], align: 'right' },
    });
    expect(
      deviceMetadataSymbol({ ...raw, symbol: { ...raw.symbol!, graphics: [] } }).graphics,
    ).toEqual([]);
    const synthesized = deviceMetadataSymbol(metadata());
    expect(synthesized.graphics).toBeUndefined();
    expect(synthesized.bounds).toBeDefined();
    expect(synthesized.pins.A?.displayName).toBe('Input');
  });

  it('registers metadata from raw and preserves atomic legacy registration', () => {
    const raw = { ...custom(), description: 'Description', designatorPrefix: 'X' };
    const registry = createDeviceRegistry([
      {
        packageId: 'pkg',
        devices: [
          { id: raw.id, displayName: 'Ignored', raw: { ...raw } },
          { id: 'legacy', raw: { pins: { P: {} } } },
        ],
      },
    ]);
    expect(registry.resolve('pkg:part-1')).toMatchObject({
      displayName: 'Part',
      description: 'Description',
      designatorPrefix: 'X',
      symbol: { graphics: raw.symbol?.graphics },
    });
    expect(registry.resolve('pkg:legacy')?.symbol?.pins.P).toBeDefined();
    expect(() =>
      registry.registerPackage({
        packageId: 'bad',
        devices: [{ id: 'valid' }, { id: raw.id, raw: { ...raw, unknown: true } }],
      }),
    ).toThrow(SchematicError);
    expect(registry.listDevices('bad')).toEqual([]);
    expect(() =>
      registry.registerPackage({
        packageId: 'mismatch',
        devices: [{ id: 'other', raw: { ...raw } }],
      }),
    ).toThrow(SchematicError);
  });
});
