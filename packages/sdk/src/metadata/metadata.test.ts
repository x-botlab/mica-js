import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { deviceMetadataSchema, widgetMetadataSchema } from './schema.js';
import type { DeviceMetadata, WidgetMetadata } from './types.js';
import { MetadataValidationError, validateMetadata } from './validate.js';
import type { MetadataIssue } from './validate.js';

const DEVICE: DeviceMetadata = {
  kind: 'device',
  id: 'resistor',
  version: '1.0.0',
  displayName: 'Resistor',
  description: 'A two-terminal resistor.',
  license: 'MIT',
  tags: ['passive', 'basic'],
  designatorPrefix: 'R',
  properties: {
    resistance: {
      type: 'number',
      required: false,
      default: 10000,
      unit: 'ohm',
      editor: { kind: 'number', min: 0.001, max: 1000000, step: 1 },
    },
    enabled: { type: 'boolean', required: true, editor: { kind: 'checkbox' } },
    label: { type: 'string', required: false, default: 'R', title: 'Label', order: 2 },
    mode: {
      type: 'enum',
      required: false,
      enumName: 'Mode',
      values: ['fast', 'slow'],
      default: 'fast',
      editor: { kind: 'select', labels: { fast: 'Fast', slow: 'Slow' } },
    },
    waveform: { type: 'bytes', required: true },
  },
  pins: {
    a: { label: 'A' },
    b: { label: 'B', description: 'Second terminal', group: 'terminals' },
  },
  ports: {
    value: { direction: 'output', type: 'number', delivery: 'level' },
    frame: { direction: 'input', type: 'bytes<rgb565>', delivery: 'message' },
    position: { direction: 'output', type: 'vec2d', title: 'Position' },
    pixels: { direction: 'input', type: 'bytes', description: 'Raw pixels' },
  },
  symbol: {
    bounds: { x: -40, y: -20, width: 80, height: 40 },
    graphics: [
      { type: 'line', from: [-40, 0], to: [-24, 0], strokeWidth: 1 },
      {
        type: 'polyline',
        points: [
          [0, 0],
          [10, 10],
          [20, 0],
        ],
        closed: true,
        fill: 'foreground',
      },
      { type: 'rect', x: -24, y: -10, width: 48, height: 20, fill: 'background' },
      { type: 'circle', center: [0, 0], radius: 4 },
      { type: 'arc', center: [0, 0], radius: 8, startAngle: 0, sweepAngle: 90 },
      { type: 'text', position: [0, -16], text: 'R', align: 'center', fontSize: 8 },
    ],
    pins: {
      a: { position: [-40, 0], direction: 'left', label: { visible: false } },
      b: {
        position: [40, 0],
        direction: 'right',
        label: { visible: true, position: [38, 2], align: 'right' },
      },
    },
    annotations: { designator: { position: [0, -16], align: 'center' } },
  },
};

const WIDGET: WidgetMetadata = {
  kind: 'widget',
  id: 'lamp',
  version: '1.0.0',
  displayName: 'Lamp',
  properties: {
    color: { type: 'string', required: false, default: '#22AA55', editor: { kind: 'text' } },
  },
  ports: { brightness: { direction: 'input', type: 'number', delivery: 'level' } },
};

type JsonObject = Record<string, unknown>;

function deviceWith(patch: JsonObject): JsonObject {
  return { ...(structuredClone(DEVICE) as unknown as JsonObject), ...patch };
}

function widgetWith(patch: JsonObject): JsonObject {
  return { ...(structuredClone(WIDGET) as unknown as JsonObject), ...patch };
}

function deviceProperties(properties: JsonObject): JsonObject {
  return deviceWith({ properties });
}

function issuesOf(input: unknown, kind: 'device' | 'widget', expectedId?: string): MetadataIssue[] {
  try {
    validateMetadata(input, kind, expectedId);
  } catch (error) {
    if (error instanceof MetadataValidationError) return [...error.issues];
    throw error;
  }
  throw new Error('expected validateMetadata to throw');
}

function pathsOf(input: unknown, kind: 'device' | 'widget', expectedId?: string): string[] {
  return issuesOf(input, kind, expectedId).map((issue) => issue.path);
}

function expectIssue(input: unknown, kind: 'device' | 'widget', path: string): MetadataIssue {
  const issue = issuesOf(input, kind).find((candidate) => candidate.path === path);
  if (issue === undefined) {
    throw new Error(`expected an issue at ${path}, received [${pathsOf(input, kind).join(', ')}]`);
  }
  return issue;
}

describe('metadata schemas', () => {
  it('compiles as draft 2020-12 JSON Schema', () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
    expect(() => ajv.compile(deviceMetadataSchema)).not.toThrow();
    expect(() => ajv.compile(widgetMetadataSchema)).not.toThrow();
  });

  it('stays plain serializable data', () => {
    for (const schema of [deviceMetadataSchema, widgetMetadataSchema]) {
      expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
      expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    }
  });

  it('declares exactly the agreed root fields and no format version', () => {
    for (const schema of [deviceMetadataSchema, widgetMetadataSchema]) {
      const properties = schema.properties as JsonObject;
      expect(Object.keys(properties).sort()).toEqual(
        (schema === deviceMetadataSchema
          ? [
              'designatorPrefix',
              'description',
              'displayName',
              'id',
              'kind',
              'license',
              'pins',
              'ports',
              'properties',
              'recommends',
              'symbol',
              'tags',
              'templates',
              'version',
            ]
          : [
              'description',
              'displayName',
              'id',
              'kind',
              'license',
              'ports',
              'properties',
              'tags',
              'version',
            ]
        ).sort(),
      );
    }
  });
});

describe('validateMetadata', () => {
  it('accepts platform references and rejects invalid recommendation lists', () => {
    const metadata: DeviceMetadata = {
      ...DEVICE,
      templates: ['platform:c51', 'platform:arm-gcc'],
      recommends: { widgets: ['demo:voltmeter'] },
    };
    expect(() => validateMetadata(metadata, 'device')).not.toThrow();
    expect(() =>
      validateMetadata(deviceWith({ templates: [], recommends: {} }), 'device'),
    ).not.toThrow();
    for (const patch of [
      { templates: [''] },
      { templates: ['platform:c51', 'platform:c51'] },
      { recommends: { widgets: [1] } },
      { recommends: { unknown: [] } },
    ])
      expect(() => validateMetadata(deviceWith(patch), 'device')).toThrow();
  });
  it('accepts a complete device', () => {
    expect(() => validateMetadata(DEVICE, 'device')).not.toThrow();
    expect(() => validateMetadata(DEVICE, 'device', 'resistor')).not.toThrow();
  });

  it('accepts a complete widget', () => {
    expect(() => validateMetadata(WIDGET, 'widget')).not.toThrow();
    expect(() => validateMetadata(WIDGET, 'widget', 'lamp')).not.toThrow();
  });

  it('accepts the package template device and widget', () => {
    const templateDevice = {
      kind: 'device',
      id: 'resistor',
      version: '1.0.0',
      displayName: 'Resistor',
      designatorPrefix: 'R',
      properties: {
        resistance: {
          type: 'number',
          required: false,
          default: 10000,
          unit: 'ohm',
          editor: { kind: 'number', min: 0.001 },
        },
      },
      pins: { a: { label: 'A' }, b: { label: 'B' } },
      symbol: {
        bounds: { x: -40, y: -20, width: 80, height: 40 },
        graphics: [
          { type: 'line', from: [-40, 0], to: [-24, 0] },
          { type: 'rect', x: -24, y: -10, width: 48, height: 20, fill: 'background' },
          { type: 'line', from: [24, 0], to: [40, 0] },
        ],
        pins: {
          a: { position: [-40, 0], direction: 'left', label: { visible: false } },
          b: { position: [40, 0], direction: 'right', label: { visible: false } },
        },
        annotations: { designator: { position: [0, -16], align: 'center' } },
      },
    };
    expect(() => validateMetadata(templateDevice, 'device', 'resistor')).not.toThrow();
    expect(() =>
      validateMetadata(
        {
          kind: 'widget',
          id: 'lamp',
          version: '1.0.0',
          displayName: 'Lamp',
          ports: { brightness: { direction: 'input', type: 'number', delivery: 'level' } },
        },
        'widget',
        'lamp',
      ),
    ).not.toThrow();
  });

  it('rejects non-object input', () => {
    expect(() => validateMetadata(null, 'device')).toThrow(MetadataValidationError);
    expect(() => validateMetadata([], 'widget')).toThrow(MetadataValidationError);
    expect(() => validateMetadata('device', 'device')).toThrow(MetadataValidationError);
  });

  it('rejects a metadata kind that the format does not define', () => {
    expect(() => validateMetadata(deviceWith({ kind: 'component' }), 'device')).toThrow(
      MetadataValidationError,
    );
    expect(expectIssue(deviceWith({ kind: 'component' }), 'device', 'kind').message).toBe(
      'must be "device"',
    );
    expect(() => validateMetadata(deviceWith({ kind: 'device' }), 'widget')).toThrow(
      MetadataValidationError,
    );
  });

  it('requires id, version and displayName', () => {
    for (const field of ['kind', 'id', 'version', 'displayName']) {
      const metadata = structuredClone(DEVICE) as unknown as JsonObject;
      delete metadata[field];
      expect(expectIssue(metadata, 'device', field).message).toContain('missing required field');
    }
    expect(expectIssue(deviceWith({ displayName: '' }), 'device', 'displayName').message).toBe(
      'must not be empty',
    );
    expect(expectIssue(deviceWith({ version: '' }), 'device', 'version').message).toBe(
      'must not be empty',
    );
  });

  it('rejects ids outside [A-Za-z0-9-]', () => {
    for (const id of ['', 'has space', 'a.b', 'a/b', 'ünit', 'a:b']) {
      expect(expectIssue(deviceWith({ id }), 'device', 'id').message).toMatch(
        /^must match the pattern/,
      );
    }
    expect(() => validateMetadata(deviceWith({ id: 'sensor-2A' }), 'device')).not.toThrow();
  });

  it('reports the expected id mismatch', () => {
    expect(() => validateMetadata(DEVICE, 'device', 'resistor')).not.toThrow();
    const mismatch = issuesOf(DEVICE, 'device', 'capacitor');
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]?.path).toBe('id');
    expect(mismatch[0]?.message).toContain('"capacitor"');
  });

  it('rejects fields that the format does not define', () => {
    for (const field of ['formatVersion', 'icon', 'category']) {
      const metadata = deviceWith({ [field]: field === 'formatVersion' ? 1 : 'value' });
      const issue = expectIssue(metadata, 'device', field);
      expect(issue.message).toBe(`unknown field ${JSON.stringify(field)}`);
    }
    expect(expectIssue(deviceWith({ icon: 'led' }), 'device', 'icon').keyword).toBe(
      'additionalProperties',
    );
  });

  it('rejects device-only fields on a widget', () => {
    for (const field of ['designatorPrefix', 'pins', 'symbol']) {
      expect(expectIssue(widgetWith({ [field]: 'x' }), 'widget', field).message).toBe(
        `unknown field ${JSON.stringify(field)}`,
      );
    }
  });

  it('validates the optional header fields', () => {
    expect(() =>
      validateMetadata(widgetWith({ description: 'A lamp', license: 'MIT' }), 'widget'),
    ).not.toThrow();
    expect(expectIssue(widgetWith({ license: 1 }), 'widget', 'license').message).toBe(
      'must be string',
    );
  });

  it('validates designatorPrefix as non-whitespace', () => {
    expect(() => validateMetadata(deviceWith({ designatorPrefix: 'RV' }), 'device')).not.toThrow();
    for (const prefix of ['', ' ', 'U V']) {
      expectIssue(deviceWith({ designatorPrefix: prefix }), 'device', 'designatorPrefix');
    }
  });

  it('requires unique non-empty tags', () => {
    expect(() => validateMetadata(deviceWith({ tags: ['a', 'b'] }), 'device')).not.toThrow();
    expect(expectIssue(deviceWith({ tags: ['a', 'a'] }), 'device', 'tags').message).toBe(
      'must not contain duplicate values',
    );
    expect(expectIssue(deviceWith({ tags: ['a', ''] }), 'device', 'tags.1').message).toBe(
      'must not be empty',
    );
    expect(expectIssue(deviceWith({ tags: ['a', 2] }), 'device', 'tags.1').message).toBe(
      'must be string',
    );
  });

  it('throws an error that carries the kind, id and every issue', () => {
    try {
      validateMetadata(deviceWith({ id: '', version: '' }), 'device');
      throw new Error('expected validateMetadata to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(MetadataValidationError);
      expect(error).toBeInstanceOf(Error);
      const failure = error as MetadataValidationError;
      expect(failure.name).toBe('MetadataValidationError');
      expect(failure.kind).toBe('device');
      expect(failure.metadataId).toBe('');
      expect(failure.issues.length).toBe(2);
      expect(failure.message).toContain('Invalid device metadata');
      expect(failure.message).toContain('id: must match the pattern');
      expect(failure.message).toContain('version: must not be empty');
    }
  });

  it('rejects an unsupported metadata kind', () => {
    expect(() => validateMetadata(DEVICE, 'package' as 'device')).toThrow(TypeError);
  });
});

describe('property metadata', () => {
  it('requires type and required', () => {
    expect(
      expectIssue(deviceProperties({ x: { required: true } }), 'device', 'properties.x.type')
        .message,
    ).toContain('missing required field');
    expect(
      expectIssue(deviceProperties({ x: { type: 'number' } }), 'device', 'properties.x.required')
        .message,
    ).toContain('missing required field');
  });

  it('rejects unknown property fields', () => {
    const properties = { x: { type: 'number', required: true, min: 0 } };
    expect(expectIssue(deviceProperties(properties), 'device', 'properties.x.min').message).toBe(
      'unknown field "min"',
    );
  });

  it('allows omitting the default of an optional property', () => {
    expect(() =>
      validateMetadata(deviceProperties({ x: { type: 'number', required: false } }), 'device'),
    ).not.toThrow();
  });

  it('rejects a default on a required property', () => {
    const issue = expectIssue(
      deviceProperties({ x: { type: 'number', required: true, default: 1 } }),
      'device',
      'properties.x.default',
    );
    expect(issue.message).toBe('must not be declared when "required" is true');
  });

  it('type-checks default values', () => {
    expect(() =>
      validateMetadata(
        deviceProperties({ x: { type: 'number', required: false, default: 1 } }),
        'device',
      ),
    ).not.toThrow();
    expect(() =>
      validateMetadata(
        deviceProperties({ x: { type: 'boolean', required: false, default: false } }),
        'device',
      ),
    ).not.toThrow();
    expect(() =>
      validateMetadata(
        deviceProperties({ x: { type: 'string', required: false, default: 'text' } }),
        'device',
      ),
    ).not.toThrow();
    expect(
      expectIssue(
        deviceProperties({ x: { type: 'number', required: false, default: '1' } }),
        'device',
        'properties.x.default',
      ).message,
    ).toBe('must be number or null');
    expect(
      expectIssue(
        deviceProperties({ x: { type: 'boolean', required: false, default: 0 } }),
        'device',
        'properties.x.default',
      ).message,
    ).toBe('must be boolean or null');
  });

  it('ties null defaults to nullable', () => {
    const missing = { x: { type: 'number', required: false, default: null } };
    expect(expectIssue(deviceProperties(missing), 'device', 'properties.x.nullable').message).toBe(
      'must be true when the default value is null',
    );
    const disabled = { x: { type: 'number', required: false, default: null, nullable: false } };
    expect(expectIssue(deviceProperties(disabled), 'device', 'properties.x.nullable').message).toBe(
      'must be true when the default value is null',
    );
    expect(() =>
      validateMetadata(
        deviceProperties({
          x: { type: 'number', required: false, default: null, nullable: true },
        }),
        'device',
      ),
    ).not.toThrow();
  });

  it('rejects bytes defaults but allows omitting them', () => {
    expect(
      expectIssue(
        deviceProperties({ x: { type: 'bytes', required: false, default: '' } }),
        'device',
        'properties.x.default',
      ).message,
    ).toBe('must not be declared: bytes properties cannot declare defaults');
    expect(() =>
      validateMetadata(deviceProperties({ x: { type: 'bytes', required: false } }), 'device'),
    ).not.toThrow();
  });

  it('requires enumName and unique non-empty values for enums', () => {
    expect(() =>
      validateMetadata(
        deviceProperties({
          x: { type: 'enum', required: true, enumName: 'Mode', values: ['a', 'b'] },
        }),
        'device',
      ),
    ).not.toThrow();
    expect(
      expectIssue(
        deviceProperties({ x: { type: 'enum', required: true, values: ['a'] } }),
        'device',
        'properties.x.enumName',
      ).message,
    ).toContain('missing required field');
    expect(
      expectIssue(
        deviceProperties({ x: { type: 'enum', required: true, enumName: 'Mode' } }),
        'device',
        'properties.x.values',
      ).message,
    ).toContain('missing required field');
    expect(
      expectIssue(
        deviceProperties({
          x: { type: 'enum', required: true, enumName: 'Mode', values: [] },
        }),
        'device',
        'properties.x.values',
      ).message,
    ).toBe('must contain at least 1 items');
    expect(
      expectIssue(
        deviceProperties({
          x: { type: 'enum', required: true, enumName: 'Mode', values: ['a', 'a'] },
        }),
        'device',
        'properties.x.values',
      ).message,
    ).toBe('must not contain duplicate values');
  });

  it('keeps enumName and values on enum properties only', () => {
    expect(
      expectIssue(
        deviceProperties({ x: { type: 'string', required: true, enumName: 'Mode' } }),
        'device',
        'properties.x.enumName',
      ).message,
    ).toBe('must not be declared unless "type" is "enum"');
    expect(
      expectIssue(
        deviceProperties({ x: { type: 'number', required: true, values: ['a'] } }),
        'device',
        'properties.x.values',
      ).message,
    ).toBe('must not be declared unless "type" is "enum"');
  });

  it('checks that the enum default belongs to the declared values', () => {
    expect(() =>
      validateMetadata(
        deviceProperties({
          x: { type: 'enum', required: false, enumName: 'Mode', values: ['a', 'b'], default: 'b' },
        }),
        'device',
      ),
    ).not.toThrow();
    const issue = expectIssue(
      deviceProperties({
        x: { type: 'enum', required: false, enumName: 'Mode', values: ['a', 'b'], default: 'c' },
      }),
      'device',
      'properties.x.default',
    );
    expect(issue.message).toContain('must be one of the declared "values"');
    expect(issue.keyword).toBe('default');
  });

  it('rejects negative property order', () => {
    expectIssue(
      deviceProperties({ x: { type: 'number', required: true, order: -1 } }),
      'device',
      'properties.x.order',
    );
    expect(() =>
      validateMetadata(
        deviceProperties({ x: { type: 'number', required: true, order: 0 } }),
        'device',
      ),
    ).not.toThrow();
  });
});

describe('property editors', () => {
  it('accepts typed file constraints and rejects malformed limits', () => {
    const property: DeviceMetadata['properties'] = {
      firmware: {
        type: 'bytes',
        required: true,
        editor: { kind: 'file', extensions: ['.bin', '.HEX', '.tar.gz'], maxSize: 1048576 },
      },
    };
    expect(() => validateMetadata(deviceWith({ properties: property }), 'device')).not.toThrow();
    expect(() =>
      validateMetadata(
        deviceProperties({
          x: { type: 'bytes', required: true, editor: { kind: 'file', extensions: [] } },
        }),
        'device',
      ),
    ).not.toThrow();
    for (const options of [
      { extensions: ['bin'] },
      { extensions: ['.'] },
      { extensions: ['*.bin'] },
      { extensions: ['.bin', '.bin'] },
      { extensions: [1] },
      { maxSize: 0 },
      { maxSize: -1 },
      { maxSize: 1.5 },
      { maxSize: '1024' },
    ])
      expect(() =>
        validateMetadata(
          deviceProperties({
            x: { type: 'bytes', required: true, editor: { kind: 'file', ...options } },
          }),
          'device',
        ),
      ).toThrow();
  });
  it('accepts every editor kind', () => {
    const editors = [
      { kind: 'number', min: 0, max: 10, step: 0.5 },
      { kind: 'text' },
      { kind: 'textarea' },
      { kind: 'checkbox' },
      { kind: 'file' },
      { kind: 'select', labels: { a: 'A' } },
    ];
    for (const editor of editors) {
      expect(() =>
        validateMetadata(
          deviceProperties({ x: { type: 'string', required: true, editor } }),
          'device',
        ),
      ).not.toThrow();
    }
  });

  it('requires the kind discriminator', () => {
    expect(
      expectIssue(
        deviceProperties({ x: { type: 'string', required: true, editor: {} } }),
        'device',
        'properties.x.editor.kind',
      ).message,
    ).toContain('missing required field');
    expect(
      expectIssue(
        deviceProperties({ x: { type: 'string', required: true, editor: { kind: 'color' } } }),
        'device',
        'properties.x.editor.kind',
      ).message,
    ).toContain('must be one of');
  });

  it('bounds number editor options', () => {
    const editor = (patch: JsonObject): JsonObject => ({
      x: { type: 'number', required: true, editor: { kind: 'number', ...patch } },
    });
    expect(
      expectIssue(deviceProperties(editor({ step: 0 })), 'device', 'properties.x.editor.step')
        .message,
    ).toBe('must be greater than 0');
    expectIssue(deviceProperties(editor({ min: '0' })), 'device', 'properties.x.editor.min');
    expect(
      expectIssue(deviceProperties(editor({ min: 5, max: 1 })), 'device', 'properties.x.editor')
        .message,
    ).toBe('"min" must be less than or equal to "max"');
  });

  it('rejects unknown editor fields', () => {
    expect(
      expectIssue(
        deviceProperties({
          x: { type: 'string', required: true, editor: { kind: 'text', placeholder: 'x' } },
        }),
        'device',
        'properties.x.editor.placeholder',
      ).message,
    ).toBe('unknown field "placeholder"');
    expect(
      expectIssue(
        deviceProperties({
          x: { type: 'number', required: true, editor: { kind: 'text', min: 0 } },
        }),
        'device',
        'properties.x.editor.min',
      ).message,
    ).toBe('unknown field "min"');
  });

  it('requires string labels for select editors', () => {
    expect(
      expectIssue(
        deviceProperties({ x: { type: 'string', required: true, editor: { kind: 'select' } } }),
        'device',
        'properties.x.editor.labels',
      ).message,
    ).toContain('missing required field');
    expect(
      expectIssue(
        deviceProperties({
          x: { type: 'string', required: true, editor: { kind: 'select', labels: { a: 1 } } },
        }),
        'device',
        'properties.x.editor.labels.a',
      ).message,
    ).toBe('must be string');
  });
});

describe('port metadata', () => {
  it('requires direction and type', () => {
    expect(
      expectIssue(
        { ...structuredClone(WIDGET), ports: { x: { type: 'number' } } },
        'widget',
        'ports.x.direction',
      ).message,
    ).toContain('missing required field');
    expect(
      expectIssue(
        { ...structuredClone(WIDGET), ports: { x: { direction: 'input' } } },
        'widget',
        'ports.x.type',
      ).message,
    ).toContain('missing required field');
  });

  it('accepts the closed payload and delivery lists', () => {
    const ports = Object.fromEntries(
      [
        'boolean',
        'number',
        'string',
        'vec2d',
        'vec3d',
        'bytes',
        'bytes<rgb565>',
        'bytes<segments>',
      ].map((type) => [type.replace(/\W/g, ''), { direction: 'input', type }]),
    );
    expect(() => validateMetadata(widgetWith({ ports }), 'widget')).not.toThrow();
    expect(() =>
      validateMetadata(
        widgetWith({ ports: { x: { direction: 'output', type: 'number', delivery: 'message' } } }),
        'widget',
      ),
    ).not.toThrow();
  });

  it('rejects unknown payload types, directions and deliveries', () => {
    expect(
      expectIssue(
        widgetWith({ ports: { x: { direction: 'input', type: 'vec4d' } } }),
        'widget',
        'ports.x.type',
      ).message,
    ).toContain('must be one of');
    expect(
      expectIssue(
        widgetWith({ ports: { x: { direction: 'both', type: 'number' } } }),
        'widget',
        'ports.x.direction',
      ).message,
    ).toBe('must be one of "input", "output"');
    expect(
      expectIssue(
        widgetWith({ ports: { x: { direction: 'input', type: 'number', delivery: 'queue' } } }),
        'widget',
        'ports.x.delivery',
      ).message,
    ).toBe('must be one of "level", "message"');
  });

  it('rejects unknown port fields', () => {
    expect(
      expectIssue(
        widgetWith({ ports: { x: { direction: 'input', type: 'number', topic: 'a' } } }),
        'widget',
        'ports.x.topic',
      ).message,
    ).toBe('unknown field "topic"');
  });
});

describe('symbol metadata', () => {
  it('requires bounds, graphics and pins', () => {
    for (const field of ['bounds', 'graphics', 'pins']) {
      const symbol = {
        ...(DEVICE.symbol as unknown as JsonObject),
      };
      delete symbol[field];
      expect(expectIssue(deviceWith({ symbol }), 'device', `symbol.${field}`).message).toContain(
        'missing required field',
      );
    }
  });

  it('requires positive bounds', () => {
    const symbol = {
      ...(DEVICE.symbol as unknown as JsonObject),
      bounds: { x: 0, y: 0, width: 0, height: 10 },
    };
    expect(expectIssue(deviceWith({ symbol }), 'device', 'symbol.bounds.width').message).toBe(
      'must be greater than 0',
    );
  });

  it('validates each graphic variant', () => {
    const graphic = (item: JsonObject): JsonObject => ({
      ...(DEVICE.symbol as unknown as JsonObject),
      graphics: [item],
    });
    expect(
      expectIssue(
        deviceWith({ symbol: graphic({ type: 'line', from: [0, 0] }) }),
        'device',
        'symbol.graphics.0.to',
      ).message,
    ).toContain('missing required field');
    expect(
      expectIssue(
        deviceWith({ symbol: graphic({ type: 'polyline', points: [[0, 0]] }) }),
        'device',
        'symbol.graphics.0.points',
      ).message,
    ).toBe('must contain at least 2 items');
    expect(
      expectIssue(
        deviceWith({ symbol: graphic({ type: 'circle', center: [0, 0], radius: 0 }) }),
        'device',
        'symbol.graphics.0.radius',
      ).message,
    ).toBe('must be greater than 0');
    expect(
      expectIssue(
        deviceWith({
          symbol: graphic({ type: 'arc', center: [0, 0], radius: 1, startAngle: 0, sweepAngle: 0 }),
        }),
        'device',
        'symbol.graphics.0.sweepAngle',
      ).message,
    ).toBe('must not be 0');
    expect(
      expectIssue(
        deviceWith({
          symbol: graphic({
            type: 'arc',
            center: [0, 0],
            radius: 1,
            startAngle: 0,
            sweepAngle: 361,
          }),
        }),
        'device',
        'symbol.graphics.0.sweepAngle',
      ).message,
    ).toBe('must be less than or equal to 360');
    expect(
      expectIssue(
        deviceWith({ symbol: graphic({ type: 'text', position: [0, 0], text: 'R', fontSize: 0 }) }),
        'device',
        'symbol.graphics.0.fontSize',
      ).message,
    ).toBe('must be greater than 0');
  });

  it('requires positive dimensions, radii, font sizes and stroke widths', () => {
    const graphic = (item: JsonObject): JsonObject => ({
      ...(DEVICE.symbol as unknown as JsonObject),
      graphics: [item],
    });
    const rect = (patch: JsonObject): JsonObject =>
      graphic({ type: 'rect', x: 0, y: 0, width: 10, height: 10, ...patch });

    expect(
      expectIssue(deviceWith({ symbol: rect({ width: 0 }) }), 'device', 'symbol.graphics.0.width')
        .message,
    ).toBe('must be greater than 0');
    expect(
      expectIssue(
        deviceWith({ symbol: rect({ height: -1 }) }),
        'device',
        'symbol.graphics.0.height',
      ).message,
    ).toBe('must be greater than 0');
    expect(
      expectIssue(
        deviceWith({ symbol: graphic({ type: 'circle', center: [0, 0], radius: 0 }) }),
        'device',
        'symbol.graphics.0.radius',
      ).message,
    ).toBe('must be greater than 0');
    expect(
      expectIssue(
        deviceWith({
          symbol: graphic({
            type: 'arc',
            center: [0, 0],
            radius: -1,
            startAngle: 0,
            sweepAngle: 90,
          }),
        }),
        'device',
        'symbol.graphics.0.radius',
      ).message,
    ).toBe('must be greater than 0');
    expect(
      expectIssue(
        deviceWith({ symbol: graphic({ type: 'text', position: [0, 0], text: 'R', fontSize: 0 }) }),
        'device',
        'symbol.graphics.0.fontSize',
      ).message,
    ).toBe('must be greater than 0');
    expect(
      expectIssue(
        deviceWith({ symbol: rect({ strokeWidth: 0 }) }),
        'device',
        'symbol.graphics.0.strokeWidth',
      ).message,
    ).toBe('must be greater than 0');
    expect(
      expectIssue(
        deviceWith({
          symbol: graphic({ type: 'line', from: [0, 0], to: [1, 1], strokeWidth: -1 }),
        }),
        'device',
        'symbol.graphics.0.strokeWidth',
      ).message,
    ).toBe('must be greater than 0');
    expect(() =>
      validateMetadata(
        deviceWith({ symbol: rect({ width: 0.5, height: 0.5, strokeWidth: 0.25 }) }),
        'device',
      ),
    ).not.toThrow();
  });

  it('rejects unknown graphics, fields and malformed points', () => {
    const graphic = (item: JsonObject): JsonObject => ({
      ...(DEVICE.symbol as unknown as JsonObject),
      graphics: [item],
    });
    expect(
      expectIssue(
        deviceWith({ symbol: graphic({ type: 'spline' }) }),
        'device',
        'symbol.graphics.0.type',
      ).message,
    ).toContain('must be one of');
    expect(
      expectIssue(
        deviceWith({ symbol: graphic({ type: 'line', from: [0, 0], to: [1, 1], points: [] }) }),
        'device',
        'symbol.graphics.0.points',
      ).message,
    ).toBe('unknown field "points"');
    expect(
      expectIssue(
        deviceWith({ symbol: graphic({ type: 'line', from: [0], to: [1, 1] }) }),
        'device',
        'symbol.graphics.0.from',
      ).message,
    ).toBe('must contain at least 2 items');
    expect(
      expectIssue(
        deviceWith({ symbol: graphic({ type: 'circle', center: [0, 0, 0], radius: 1 }) }),
        'device',
        'symbol.graphics.0.center',
      ).message,
    ).toBe('must contain at most 2 items');
  });

  it('validates symbol pins and their labels', () => {
    const pins = (pin: JsonObject): JsonObject => ({
      ...(DEVICE.symbol as unknown as JsonObject),
      pins: { a: pin },
    });
    expect(() =>
      validateMetadata(
        deviceWith({ symbol: pins({ position: [0, 0], direction: 'up' }) }),
        'device',
      ),
    ).not.toThrow();
    expect(
      expectIssue(
        deviceWith({ symbol: pins({ position: [0, 0] }) }),
        'device',
        'symbol.pins.a.direction',
      ).message,
    ).toContain('missing required field');
    expect(
      expectIssue(
        deviceWith({ symbol: pins({ position: [0, 0], direction: 'middle' }) }),
        'device',
        'symbol.pins.a.direction',
      ).message,
    ).toBe('must be one of "left", "right", "up", "down"');
    expect(
      expectIssue(
        deviceWith({
          symbol: pins({ position: [0, 0], direction: 'left', label: { align: 'center' } }),
        }),
        'device',
        'symbol.pins.a.label.visible',
      ).message,
    ).toContain('missing required field');
    expect(
      expectIssue(
        deviceWith({
          symbol: pins({
            position: [0, 0],
            direction: 'left',
            label: { visible: true, color: 'red' },
          }),
        }),
        'device',
        'symbol.pins.a.label.color',
      ).message,
    ).toBe('unknown field "color"');
  });

  it('validates designator annotations', () => {
    const annotations = (value: JsonObject): JsonObject => ({
      ...(DEVICE.symbol as unknown as JsonObject),
      annotations: value,
    });
    expect(() => validateMetadata(deviceWith({ symbol: annotations({}) }), 'device')).not.toThrow();
    expect(
      expectIssue(
        deviceWith({ symbol: annotations({ designator: {} }) }),
        'device',
        'symbol.annotations.designator.position',
      ).message,
    ).toContain('missing required field');
    expect(
      expectIssue(
        deviceWith({
          symbol: annotations({ designator: { position: [0, 0], align: 'middle' } }),
        }),
        'device',
        'symbol.annotations.designator.align',
      ).message,
    ).toBe('must be one of "left", "center", "right"');
    expect(
      expectIssue(
        deviceWith({ symbol: annotations({ footprint: {} }) }),
        'device',
        'symbol.annotations.footprint',
      ).message,
    ).toBe('unknown field "footprint"');
  });
});

describe('JSON number handling', () => {
  it('rejects non-finite coordinates', () => {
    const symbol = {
      ...(DEVICE.symbol as unknown as JsonObject),
      bounds: { x: Number.NaN, y: 0, width: 10, height: 10 },
    };
    const issue = expectIssue(deviceWith({ symbol }), 'device', 'symbol.bounds.x');
    expect(issue.message).toBe('must be a finite JSON number');
    expect(issue.keyword).toBe('number');
  });

  it('rejects non-finite values outside geometry', () => {
    expect(
      expectIssue(
        deviceWith({
          tags: [],
          properties: { x: { type: 'number', required: false, default: Infinity } },
        }),
        'device',
        'properties.x.default',
      ).message,
    ).toBe('must be a finite JSON number');
  });
});
