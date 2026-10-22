import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { DeviceError, type DeviceErrorCode } from './errors';
import { parseDeviceDescription } from './description';
import { TOPIC_PAYLOAD_TYPES } from './types';

const METADATA = {
  name: 'acme:demo',
  displayName: 'Demo',
  description: 'Demo device',
} as const;

function capture(run: () => unknown): DeviceError {
  try {
    run();
  } catch (error) {
    if (error instanceof DeviceError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected DeviceError.');
}

function expectCode(run: () => unknown, code: DeviceErrorCode, pointer?: string): void {
  const error = capture(run);
  expect(error.code).toBe(code);
  if (pointer !== undefined) {
    expect(error.pointer).toBe(pointer);
  }
}

describe('parseDeviceDescription', () => {
  it('parses an empty description with metadata', () => {
    const description = parseDeviceDescription({}, METADATA);
    expect(description.name).toBe('acme:demo');
    expect(description.displayName).toBe('Demo');
    expect(description.description).toBe('Demo device');
    expect(description.properties.size).toBe(0);
    expect(description.ports.size).toBe(0);
    expect(description.designatorPrefix).toBeUndefined();
  });

  it('falls back to the name when displayName is omitted or blank', () => {
    expect(parseDeviceDescription({}, { name: 'acme:demo' }).displayName).toBe('acme:demo');
    expect(parseDeviceDescription({}, { name: 'acme:demo', displayName: '   ' }).displayName).toBe(
      'acme:demo',
    );
  });

  it('normalizes metadata whitespace and empty descriptions', () => {
    const description = parseDeviceDescription(
      {},
      { name: ' acme:demo ', displayName: ' Demo ', description: '   ' },
    );
    expect(description.name).toBe('acme:demo');
    expect(description.displayName).toBe('Demo');
    expect(description.description).toBeUndefined();
  });

  it('keeps usable #7 property descriptors and ignores unusable ones', () => {
    const description = parseDeviceDescription(
      {
        properties: {
          label: { type: 'string', default: 'MCU', maxLength: 4 },
          cores: { type: 'integer', default: 1, min: 1, max: 2 },
          speed: { type: 'number', default: 72, min: 1, max: 170, unit: 'MHz' },
          enabled: { type: 'boolean', default: true },
          accent: { type: 'color', default: '#3b82f6', alpha: true },
          orientation: {
            type: 'enum',
            default: 'landscape',
            options: [
              { value: 'landscape', label: '横向' },
              { value: 'portrait', label: '纵向' },
            ],
          },
          panel: {
            type: 'image',
            default: { src: 'assets/panel.png', mode: 'file' },
            maxBytes: 65536,
          },
          firmware: {
            type: 'binary',
            default: { src: 'assets/fw.bin', mode: 'file' },
            maxBytes: 1024,
          },
          unknownType: { type: 'not-a-type', default: 1 },
          badEnum: { type: 'enum', default: 'a', options: [] },
          badDefault: { type: 'integer', default: 1.5 },
          notAnObject: true,
        },
      },
      METADATA,
    );
    expect([...description.properties.keys()]).toEqual([
      'label',
      'cores',
      'speed',
      'enabled',
      'accent',
      'orientation',
      'panel',
      'firmware',
      'badDefault',
    ]);
    expect(description.properties.get('label')?.default).toBe('MCU');
    expect(description.properties.get('accent')?.default).toBe('#3b82f6');
    expect(description.properties.get('badDefault')?.default).toBeUndefined();
  });

  it('parses every #10 port field and payload type', () => {
    const ports: Record<string, unknown> = {};
    for (const [index, type] of TOPIC_PAYLOAD_TYPES.entries()) {
      ports[`port${String(index)}`] = {
        title: `Port ${String(index)}`,
        description: `Payload ${type}`,
        direction: index % 2 === 0 ? 'input' : 'output',
        type,
      };
    }
    const description = parseDeviceDescription({ ports }, METADATA);
    expect(description.ports.size).toBe(TOPIC_PAYLOAD_TYPES.length);
    for (const [index, type] of TOPIC_PAYLOAD_TYPES.entries()) {
      const port = description.ports.get(`port${String(index)}`);
      expect(port?.type).toBe(type);
      expect(port?.direction).toBe(index % 2 === 0 ? 'input' : 'output');
      expect(port?.title).toBe(`Port ${String(index)}`);
    }
  });

  it('drops blank optional port text and keeps the key', () => {
    const description = parseDeviceDescription(
      {
        ports: {
          button: { title: '  ', description: '', direction: 'input', type: 'boolean' },
        },
      },
      METADATA,
    );
    expect(description.ports.get('button')).toEqual({
      key: 'button',
      direction: 'input',
      type: 'boolean',
    });
  });

  it('normalizes designatorPrefix and ignores unknown top-level fields', () => {
    const description = parseDeviceDescription(
      { designatorPrefix: ' U ', futureField: true },
      METADATA,
    );
    expect(description.designatorPrefix).toBe('U');
    expect(description.pins.size).toBe(0);
    expect(description.pinGroups.size).toBe(0);
    expect(parseDeviceDescription({ designatorPrefix: '  ' }, METADATA).designatorPrefix).toBe(
      undefined,
    );
    expect(parseDeviceDescription({}, METADATA).designatorPrefix).toBeUndefined();
  });

  it('parses physical pin declarations and fixed groups', () => {
    const description = parseDeviceDescription(
      {
        pins: {
          VCC: { kind: 'power', side: 'top' },
          GND: { kind: 'gnd' },
          OUT: { kind: 'signal', side: 'right' },
          DIN: {
            kind: 'signal',
            powerDomain: 'io',
            levels: { low: 0.3, high: 0.7 },
          },
        },
        pinGroups: { data: { pins: ['OUT', 'DIN'] } },
      },
      METADATA,
    );
    expect(description.pins.get('VCC')).toEqual({ key: 'VCC', kind: 'power', side: 'top' });
    expect(description.pins.get('GND')).toEqual({ key: 'GND', kind: 'gnd', side: 'left' });
    expect(description.pins.get('OUT')).toEqual({ key: 'OUT', kind: 'signal', side: 'right' });
    expect(description.pins.get('DIN')).toEqual({
      key: 'DIN',
      kind: 'signal',
      side: 'left',
      powerDomain: 'io',
      levels: { low: 0.3, high: 0.7 },
    });
    expect(description.pinGroups.get('data')).toEqual({
      key: 'data',
      pins: ['OUT', 'DIN'],
    });
  });

  it('rejects invalid pin declarations', () => {
    expectCode(
      () => parseDeviceDescription({ pins: { A: {} } }, METADATA),
      'device/description-schema',
      '/pins/A/kind',
    );
    expectCode(
      () => parseDeviceDescription({ pins: { A: { kind: 'io' } } }, METADATA),
      'schema/invalid-value',
      '/pins/A/kind',
    );
    expectCode(
      () => parseDeviceDescription({ pins: { A: { kind: 'signal', side: 'center' } } }, METADATA),
      'schema/invalid-value',
      '/pins/A/side',
    );
    expectCode(
      () => parseDeviceDescription({ pins: { A: { kind: 'signal', future: 1 } } }, METADATA),
      'schema/unknown-field',
      '/pins/A/future',
    );
    expectCode(
      () => parseDeviceDescription({ pins: { A: { kind: 'power', powerDomain: 'io' } } }, METADATA),
      'schema/invalid-value',
      '/pins/A/powerDomain',
    );
    expectCode(
      () =>
        parseDeviceDescription(
          { pins: { A: { kind: 'signal', levels: { low: 0.2, high: 0.8 } } } },
          METADATA,
        ),
      'schema/invalid-value',
      '/pins/A/levels',
    );
    expectCode(
      () =>
        parseDeviceDescription(
          {
            pins: {
              A: { kind: 'signal', powerDomain: 'io', levels: { low: 0.8, high: 0.2 } },
            },
          },
          METADATA,
        ),
      'schema/invalid-value',
      '/pins/A/levels',
    );
    expectCode(
      () => parseDeviceDescription({ pins: [] }, METADATA),
      'device/description-schema',
      '/pins',
    );
    expectCode(
      () => parseDeviceDescription({ pins: { '': { kind: 'signal' } } }, METADATA),
      'device/description-schema',
      '/pins',
    );
  });

  it('rejects invalid pin groups', () => {
    const pins = { A: { kind: 'signal' }, B: { kind: 'signal' } };
    expectCode(
      () => parseDeviceDescription({ pins, pinGroups: { g: { pins: [] } } }, METADATA),
      'schema/invalid-value',
      '/pinGroups/g/pins',
    );
    expectCode(
      () => parseDeviceDescription({ pins, pinGroups: { g: { pins: ['A', 'A'] } } }, METADATA),
      'schema/invalid-value',
      '/pinGroups/g/pins/1',
    );
    expectCode(
      () => parseDeviceDescription({ pins, pinGroups: { g: { pins: ['A', 'Z'] } } }, METADATA),
      'schema/invalid-value',
      '/pinGroups/g/pins/1',
    );
    expectCode(
      () =>
        parseDeviceDescription({ pins, pinGroups: { g: { pins: ['A'], future: 1 } } }, METADATA),
      'schema/unknown-field',
      '/pinGroups/g/future',
    );
    expectCode(
      () => parseDeviceDescription({ pins, pinGroups: { '': { pins: ['A'] } } }, METADATA),
      'device/description-schema',
      '/pinGroups',
    );
  });

  it('rejects non-object definitions', () => {
    expectCode(() => parseDeviceDescription('{}', METADATA), 'device/description-schema', '');
    expectCode(() => parseDeviceDescription([], METADATA), 'device/description-schema', '');
    expectCode(() => parseDeviceDescription(null, METADATA), 'device/description-schema', '');
  });

  it('rejects invalid metadata', () => {
    expectCode(
      () => parseDeviceDescription({}, { name: '' }),
      'device/description-schema',
      '/metadata/name',
    );
    expectCode(
      () => parseDeviceDescription({}, { name: 42 } as unknown as { name: string }),
      'device/description-schema',
      '/metadata/name',
    );
    expectCode(
      () =>
        parseDeviceDescription({}, { name: 'acme:demo', displayName: 42 } as unknown as {
          name: string;
        }),
      'device/description-schema',
      '/metadata/displayName',
    );
    expectCode(
      () =>
        parseDeviceDescription({}, { name: 'acme:demo', description: 42 } as unknown as {
          name: string;
        }),
      'device/description-schema',
      '/metadata/description',
    );
  });

  it('rejects invalid containers and designatorPrefix', () => {
    expectCode(
      () => parseDeviceDescription({ properties: [] }, METADATA),
      'device/description-schema',
      '/properties',
    );
    expectCode(
      () => parseDeviceDescription({ ports: [] }, METADATA),
      'device/description-schema',
      '/ports',
    );
    expectCode(
      () => parseDeviceDescription({ designatorPrefix: 42 }, METADATA),
      'device/description-schema',
      '/designatorPrefix',
    );
  });

  it('rejects non-plain objects instead of treating them as empty records', () => {
    expectCode(() => parseDeviceDescription(new Map(), METADATA), 'device/description-schema', '');
    expectCode(() => parseDeviceDescription(new Date(), METADATA), 'device/description-schema', '');
    expectCode(
      () => parseDeviceDescription({ properties: new Map() }, METADATA),
      'device/description-schema',
      '/properties',
    );
    expectCode(
      () => parseDeviceDescription({ properties: new Set() }, METADATA),
      'device/description-schema',
      '/properties',
    );
    expectCode(
      () => parseDeviceDescription({ ports: new Map() }, METADATA),
      'device/description-schema',
      '/ports',
    );
    expectCode(
      () => parseDeviceDescription({ ports: { p: new Map() } }, METADATA),
      'schema/invalid-type',
      '/ports/p',
    );
  });

  it('accepts null-prototype and cross-realm plain objects, but rejects class instances', () => {
    const properties = Object.assign(Object.create(null), {
      label: { type: 'string', default: 'x' },
    });
    const definition = Object.assign(Object.create(null), { properties });
    expect(parseDeviceDescription(definition, METADATA).properties.get('label')?.default).toBe('x');

    const foreign: unknown = runInNewContext(
      '({ properties: { label: { type: "string", default: "y" } } })',
    );
    expect(parseDeviceDescription(foreign, METADATA).properties.get('label')?.default).toBe('y');

    class Holder {
      readonly properties = {};
    }
    expectCode(
      () => parseDeviceDescription(new Holder(), METADATA),
      'device/description-schema',
      '',
    );
  });

  it('rejects invalid port declarations with specific #10 codes', () => {
    expectCode(
      () => parseDeviceDescription({ ports: { '': {} } }, METADATA),
      'schema/invalid-value',
      '/ports',
    );
    expectCode(
      () => parseDeviceDescription({ ports: { p: true } }, METADATA),
      'schema/invalid-type',
      '/ports/p',
    );
    expectCode(
      () =>
        parseDeviceDescription(
          { ports: { p: { direction: 'input', type: 'boolean', extra: 1 } } },
          METADATA,
        ),
      'schema/unknown-field',
      '/ports/p/extra',
    );
    expectCode(
      () => parseDeviceDescription({ ports: { p: { type: 'boolean' } } }, METADATA),
      'schema/invalid-value',
      '/ports/p/direction',
    );
    expectCode(
      () =>
        parseDeviceDescription(
          { ports: { p: { direction: 'sideways', type: 'boolean' } } },
          METADATA,
        ),
      'schema/invalid-value',
      '/ports/p/direction',
    );
    expectCode(
      () => parseDeviceDescription({ ports: { p: { direction: 'input' } } }, METADATA),
      'type/unknown',
      '/ports/p/type',
    );
    expectCode(
      () =>
        parseDeviceDescription(
          { ports: { p: { direction: 'input', type: 'bytes<x>' } } },
          METADATA,
        ),
      'type/unknown',
      '/ports/p/type',
    );
    expectCode(
      () => parseDeviceDescription({ ports: { p: { direction: 'input', type: 42 } } }, METADATA),
      'type/unknown',
      '/ports/p/type',
    );
    expectCode(
      () =>
        parseDeviceDescription(
          { ports: { p: { direction: 'input', type: 'boolean', title: 42 } } },
          METADATA,
        ),
      'schema/invalid-type',
      '/ports/p/title',
    );
  });
});
