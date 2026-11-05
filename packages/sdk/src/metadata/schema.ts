import type { MetadataKind } from './types.js';

export type { MetadataKind };

/** A JSON Schema node. The exported schemas are plain data and can be serialized as-is. */
export type MetadataJsonSchema = { readonly [keyword: string]: unknown };

const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

const PROPERTY_TYPES = ['number', 'boolean', 'string', 'enum', 'bytes'] as const;
const PORT_PAYLOAD_TYPES = [
  'boolean',
  'number',
  'string',
  'vec2d',
  'vec3d',
  'bytes',
  'bytes<rgb565>',
  'bytes<segments>',
] as const;
const PORT_DIRECTIONS = ['input', 'output'] as const;
const PORT_DELIVERIES = ['level', 'message'] as const;
const GRAPHIC_FILLS = ['none', 'foreground', 'background'] as const;
const TEXT_ALIGNS = ['left', 'center', 'right'] as const;
const SYMBOL_PIN_DIRECTIONS = ['left', 'right', 'up', 'down'] as const;
const EDITOR_TYPES = ['number', 'text', 'textarea', 'checkbox', 'file', 'select'] as const;
const GRAPHIC_TYPES = ['line', 'polyline', 'rect', 'circle', 'arc', 'text'] as const;

function stringEnum(values: readonly string[]): MetadataJsonSchema {
  return { type: 'string', enum: [...values] };
}

function objectSchema(
  properties: Record<string, MetadataJsonSchema>,
  required: readonly string[] = [],
): MetadataJsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    ...(required.length === 0 ? {} : { required: [...required] }),
    properties,
  };
}

function stringMap(values: MetadataJsonSchema, description: string): MetadataJsonSchema {
  return {
    type: 'object',
    description,
    propertyNames: { minLength: 1 },
    additionalProperties: values,
  };
}

/** Applies `then` only when the sibling discriminator field equals `value`. */
function whenEquals(field: string, value: string, then: MetadataJsonSchema): MetadataJsonSchema {
  return {
    if: { required: [field], properties: { [field]: { const: value } } },
    then,
  };
}

function whenType(typeName: string, then: MetadataJsonSchema): MetadataJsonSchema {
  return whenEquals('type', typeName, then);
}

function pointSchema(): MetadataJsonSchema {
  return {
    type: 'array',
    description: 'A point expressed as [x, y].',
    prefixItems: [{ type: 'number' }, { type: 'number' }],
    items: false,
    minItems: 2,
    maxItems: 2,
  };
}

function propertySchema(): MetadataJsonSchema {
  return {
    type: 'object',
    description: 'A persistent configuration value.',
    additionalProperties: false,
    required: ['type', 'required'],
    properties: {
      type: stringEnum(PROPERTY_TYPES),
      required: { type: 'boolean' },
      nullable: { type: 'boolean' },
      default: { type: ['number', 'boolean', 'string', 'null'] },
      title: { type: 'string' },
      description: { type: 'string' },
      unit: { type: 'string' },
      group: { type: 'string' },
      order: { type: 'integer', minimum: 0 },
      editor: { $ref: '#/$defs/editor' },
      enumName: { type: 'string', minLength: 1 },
      values: {
        type: 'array',
        minItems: 1,
        uniqueItems: true,
        items: { type: 'string', minLength: 1 },
      },
    },
    allOf: [
      {
        $comment: 'A required value has no default.',
        if: { required: ['required'], properties: { required: { const: true } } },
        then: { properties: { default: false } },
      },
      {
        $comment: 'Bytes defaults need an encoding that is not decided yet.',
        if: { required: ['type'], properties: { type: { const: 'bytes' } } },
        then: { properties: { default: false } },
      },
      {
        $comment: 'An explicit null default requires nullable: true.',
        if: {
          required: ['default'],
          properties: { default: { const: null }, type: { not: { const: 'bytes' } } },
        },
        then: { required: ['nullable'], properties: { nullable: { const: true } } },
      },
      {
        $comment:
          'Default values must match the declared type; membership in enum values is checked in code.',
        if: { required: ['type'], properties: { type: { const: 'number' } } },
        then: { properties: { default: { type: ['number', 'null'] } } },
      },
      {
        if: { required: ['type'], properties: { type: { const: 'boolean' } } },
        then: { properties: { default: { type: ['boolean', 'null'] } } },
      },
      {
        if: { required: ['type'], properties: { type: { const: 'string' } } },
        then: { properties: { default: { type: ['string', 'null'] } } },
      },
      {
        if: { required: ['type'], properties: { type: { const: 'enum' } } },
        then: {
          required: ['enumName', 'values'],
          properties: {
            default: { type: ['string', 'null'] },
            enumName: { type: 'string', minLength: 1 },
            values: { type: 'array' },
          },
        },
      },
      {
        $comment: 'Only enum properties carry an enum name and a value list.',
        if: { required: ['type'], properties: { type: { not: { const: 'enum' } } } },
        then: { properties: { enumName: false, values: false } },
      },
    ],
  };
}

function editorSchema(): MetadataJsonSchema {
  return {
    type: 'object',
    description: 'Editor hints for a property value.',
    required: ['kind'],
    properties: { kind: stringEnum(EDITOR_TYPES) },
    allOf: [
      whenEquals(
        'kind',
        'number',
        objectSchema({
          kind: { type: 'string', const: 'number' },
          min: { type: 'number' },
          max: { type: 'number' },
          step: { type: 'number', exclusiveMinimum: 0 },
        }),
      ),
      whenEquals('kind', 'text', objectSchema({ kind: { type: 'string', const: 'text' } })),
      whenEquals('kind', 'textarea', objectSchema({ kind: { type: 'string', const: 'textarea' } })),
      whenEquals('kind', 'checkbox', objectSchema({ kind: { type: 'string', const: 'checkbox' } })),
      whenEquals(
        'kind',
        'file',
        objectSchema({
          kind: { type: 'string', const: 'file' },
          extensions: {
            type: 'array',
            description:
              'Allowed dotted filename extensions, matched case-insensitively by the host.',
            uniqueItems: true,
            items: { type: 'string', pattern: '^\\.[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*$' },
          },
          maxSize: {
            type: 'integer',
            exclusiveMinimum: 0,
            description: 'Maximum file size in bytes.',
          },
        }),
      ),
      whenEquals(
        'kind',
        'select',
        objectSchema(
          {
            kind: { type: 'string', const: 'select' },
            labels: {
              type: 'object',
              description: 'Option value to display label.',
              propertyNames: { minLength: 1 },
              additionalProperties: { type: 'string' },
            },
          },
          ['labels'],
        ),
      ),
    ],
  };
}

function portSchema(): MetadataJsonSchema {
  return {
    type: 'object',
    description: 'A topic port.',
    additionalProperties: false,
    required: ['direction', 'type'],
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      direction: stringEnum(PORT_DIRECTIONS),
      type: stringEnum(PORT_PAYLOAD_TYPES),
      delivery: stringEnum(PORT_DELIVERIES),
    },
  };
}

function pinSchema(): MetadataJsonSchema {
  return {
    type: 'object',
    description: 'A physical pin.',
    additionalProperties: false,
    properties: {
      label: { type: 'string' },
      description: { type: 'string' },
      group: { type: 'string' },
    },
  };
}

function boundsSchema(): MetadataJsonSchema {
  return {
    ...objectSchema(
      {
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number', exclusiveMinimum: 0 },
        height: { type: 'number', exclusiveMinimum: 0 },
      },
      ['x', 'y', 'width', 'height'],
    ),
    description: 'The symbol body box.',
  };
}

function graphicSchema(): MetadataJsonSchema {
  return {
    type: 'object',
    description: 'A symbol graphic.',
    required: ['type'],
    properties: { type: stringEnum(GRAPHIC_TYPES) },
    allOf: [
      whenType('line', { $ref: '#/$defs/lineGraphic' }),
      whenType('polyline', { $ref: '#/$defs/polylineGraphic' }),
      whenType('rect', { $ref: '#/$defs/rectGraphic' }),
      whenType('circle', { $ref: '#/$defs/circleGraphic' }),
      whenType('arc', { $ref: '#/$defs/arcGraphic' }),
      whenType('text', { $ref: '#/$defs/textGraphic' }),
    ],
  };
}

function symbolPinSchema(): MetadataJsonSchema {
  return objectSchema(
    {
      position: { $ref: '#/$defs/point' },
      direction: stringEnum(SYMBOL_PIN_DIRECTIONS),
      label: { $ref: '#/$defs/pinLabel' },
    },
    ['position', 'direction'],
  );
}

function buildDefs(kind: MetadataKind): Record<string, MetadataJsonSchema> {
  const fill: MetadataJsonSchema = stringEnum(GRAPHIC_FILLS);
  const strokeWidth: MetadataJsonSchema = { type: 'number', exclusiveMinimum: 0 };
  const pointRef: MetadataJsonSchema = { $ref: '#/$defs/point' };
  const defs: Record<string, MetadataJsonSchema> = {
    point: pointSchema(),
    editor: editorSchema(),
    property: propertySchema(),
    properties: stringMap({ $ref: '#/$defs/property' }, 'Property key to property description.'),
    port: portSchema(),
    ports: stringMap({ $ref: '#/$defs/port' }, 'Port key to topic port description.'),
  };
  if (kind === 'widget') return defs;

  return {
    ...defs,
    pin: pinSchema(),
    pins: stringMap({ $ref: '#/$defs/pin' }, 'Pin key to physical pin description.'),
    bounds: boundsSchema(),
    graphic: graphicSchema(),
    lineGraphic: objectSchema(
      {
        type: { type: 'string', const: 'line' },
        from: pointRef,
        to: pointRef,
        fill,
        strokeWidth,
      },
      ['type', 'from', 'to'],
    ),
    polylineGraphic: objectSchema(
      {
        type: { type: 'string', const: 'polyline' },
        points: { type: 'array', minItems: 2, items: pointRef },
        closed: { type: 'boolean' },
        fill,
        strokeWidth,
      },
      ['type', 'points'],
    ),
    rectGraphic: objectSchema(
      {
        type: { type: 'string', const: 'rect' },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number', exclusiveMinimum: 0 },
        height: { type: 'number', exclusiveMinimum: 0 },
        fill,
        strokeWidth,
      },
      ['type', 'x', 'y', 'width', 'height'],
    ),
    circleGraphic: objectSchema(
      {
        type: { type: 'string', const: 'circle' },
        center: pointRef,
        radius: { type: 'number', exclusiveMinimum: 0 },
        fill,
        strokeWidth,
      },
      ['type', 'center', 'radius'],
    ),
    arcGraphic: objectSchema(
      {
        type: { type: 'string', const: 'arc' },
        center: pointRef,
        radius: { type: 'number', exclusiveMinimum: 0 },
        startAngle: { type: 'number' },
        sweepAngle: {
          type: 'number',
          minimum: -360,
          maximum: 360,
          not: { const: 0 },
        },
        fill,
        strokeWidth,
      },
      ['type', 'center', 'radius', 'startAngle', 'sweepAngle'],
    ),
    textGraphic: objectSchema(
      {
        type: { type: 'string', const: 'text' },
        position: pointRef,
        text: { type: 'string' },
        align: stringEnum(TEXT_ALIGNS),
        fontSize: { type: 'number', exclusiveMinimum: 0 },
        fill,
        strokeWidth,
      },
      ['type', 'position', 'text', 'fontSize'],
    ),
    pinLabel: objectSchema(
      {
        visible: { type: 'boolean' },
        position: pointRef,
        align: stringEnum(TEXT_ALIGNS),
      },
      ['visible'],
    ),
    symbolPin: symbolPinSchema(),
    designatorAnnotation: objectSchema(
      {
        position: pointRef,
        align: stringEnum(TEXT_ALIGNS),
      },
      ['position'],
    ),
    annotations: objectSchema({
      designator: { $ref: '#/$defs/designatorAnnotation' },
    }),
    symbol: objectSchema(
      {
        bounds: { $ref: '#/$defs/bounds' },
        graphics: { type: 'array', items: { $ref: '#/$defs/graphic' } },
        pins: stringMap({ $ref: '#/$defs/symbolPin' }, 'Pin key to symbol pin placement.'),
        annotations: { $ref: '#/$defs/annotations' },
      },
      ['bounds', 'graphics', 'pins'],
    ),
  };
}

function headerProperties(): Record<string, MetadataJsonSchema> {
  return {
    id: { type: 'string', pattern: '^[A-Za-z0-9-]+$' },
    version: { type: 'string', minLength: 1 },
    displayName: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    license: { type: 'string' },
    tags: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', minLength: 1 },
    },
  };
}

/** Metadata of a single device, independent of any package manifest or DDL source. */
export const deviceMetadataSchema: MetadataJsonSchema = {
  $schema: DRAFT_2020_12,
  title: 'Mica device metadata',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'id', 'version', 'displayName'],
  properties: {
    kind: { type: 'string', const: 'device' },
    ...headerProperties(),
    templates: {
      type: 'array',
      description: 'Platform project template IDs in display priority order.',
      uniqueItems: true,
      items: { type: 'string', minLength: 1 },
    },
    recommends: objectSchema({
      widgets: {
        type: 'array',
        description: 'Recommended full widget IDs in display priority order; not dependencies.',
        uniqueItems: true,
        items: { type: 'string', minLength: 1 },
      },
    }),
    designatorPrefix: { type: 'string', pattern: '^\\S+$' },
    properties: { $ref: '#/$defs/properties' },
    pins: { $ref: '#/$defs/pins' },
    ports: { $ref: '#/$defs/ports' },
    symbol: { $ref: '#/$defs/symbol' },
  },
  $defs: buildDefs('device'),
};

/** Metadata of a single widget, independent of any package manifest or DDL source. */
export const widgetMetadataSchema: MetadataJsonSchema = {
  $schema: DRAFT_2020_12,
  title: 'Mica widget metadata',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'id', 'version', 'displayName'],
  properties: {
    kind: { type: 'string', const: 'widget' },
    ...headerProperties(),
    properties: { $ref: '#/$defs/properties' },
    ports: { $ref: '#/$defs/ports' },
  },
  $defs: buildDefs('widget'),
};
