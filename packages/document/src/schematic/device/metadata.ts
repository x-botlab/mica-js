import type { Diagnostic } from '../../format/diagnostics';
import { SchematicError } from '../../format/errors';
import { parseInput } from '../../format/input';
import { isRecord } from '../../format/validate';
import type { Rect } from '../../format/types';
import { propertyValueProblem, type PropertyDescriptor } from './properties';
import type { DeviceSymbolDefinition, PinAnchor } from './symbol';
import { synthesizeDeviceSymbol } from './synthesis';

export type DeviceCoordinate = readonly [number, number];
export type DeviceTextAlign = 'left' | 'center' | 'right';
export interface DeviceGraphicStyle {
  readonly fill?: 'none' | 'foreground' | 'background';
  readonly strokeWidth?: number;
}
export type DeviceGraphic = DeviceGraphicStyle &
  (
    | { readonly type: 'line'; readonly from: DeviceCoordinate; readonly to: DeviceCoordinate }
    | {
        readonly type: 'polyline';
        readonly points: readonly DeviceCoordinate[];
        readonly closed?: boolean;
      }
    | {
        readonly type: 'rect';
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      }
    | { readonly type: 'circle'; readonly center: DeviceCoordinate; readonly radius: number }
    | {
        readonly type: 'arc';
        readonly center: DeviceCoordinate;
        readonly radius: number;
        readonly startAngle: number;
        readonly sweepAngle: number;
      }
    | {
        readonly type: 'text';
        readonly position: DeviceCoordinate;
        readonly text: string;
        readonly align?: DeviceTextAlign;
        readonly fontSize?: number;
      }
  );
export interface DevicePinLabel {
  readonly visible: boolean;
  readonly position?: DeviceCoordinate;
  readonly align?: DeviceTextAlign;
}
export interface DeviceSymbolAnnotations {
  readonly designator?: { readonly position: DeviceCoordinate; readonly align?: DeviceTextAlign };
}
export type DevicePropertyEditor =
  | {
      readonly kind: 'number';
      readonly min?: number;
      readonly max?: number;
      readonly step?: number;
    }
  | { readonly kind: 'text' | 'textarea' | 'checkbox' }
  | {
      readonly kind: 'file';
      readonly extensions?: readonly string[];
      readonly maxSize?: number;
    }
  | { readonly kind: 'select'; readonly labels?: Readonly<Record<string, string>> };
export interface DevicePropertyMetadata {
  readonly type: 'number' | 'boolean' | 'string' | 'enum' | 'bytes';
  readonly required: boolean;
  readonly nullable?: boolean;
  readonly default?: unknown;
  readonly enumName?: string;
  readonly values?: readonly string[];
  readonly title?: string;
  readonly description?: string;
  readonly unit?: string;
  readonly group?: string;
  readonly order?: number;
  readonly editor?: DevicePropertyEditor;
}
export interface DevicePinMetadata {
  readonly label?: string;
  readonly description?: string;
  readonly group?: string;
}
export interface DevicePortMetadata {
  readonly direction: 'input' | 'output';
  readonly type:
    | 'boolean'
    | 'number'
    | 'string'
    | 'vec2d'
    | 'vec3d'
    | 'bytes'
    | 'bytes<rgb565>'
    | 'bytes<segments>';
  readonly title?: string;
  readonly description?: string;
  readonly delivery?: 'level' | 'message';
}
export interface DeviceMetadata {
  readonly kind: 'device';
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly description?: string;
  readonly license?: string;
  readonly tags?: readonly string[];
  readonly templates?: readonly string[];
  readonly recommends?: { readonly widgets?: readonly string[] };
  readonly designatorPrefix?: string;
  readonly properties?: Readonly<Record<string, DevicePropertyMetadata>>;
  readonly pins?: Readonly<Record<string, DevicePinMetadata>>;
  readonly ports?: Readonly<Record<string, DevicePortMetadata>>;
  readonly symbol?: {
    readonly bounds: Rect;
    readonly graphics: readonly DeviceGraphic[];
    readonly pins: Readonly<
      Record<
        string,
        {
          readonly position: DeviceCoordinate;
          readonly direction: 'left' | 'right' | 'up' | 'down';
          readonly label?: DevicePinLabel;
        }
      >
    >;
    readonly annotations?: DeviceSymbolAnnotations;
  };
}

type Check = (value: unknown, path: string, diagnostics: Diagnostic[]) => void;
const fail = (path: string, diagnostics: Diagnostic[], message: string): void => {
  diagnostics.push({
    severity: 'error',
    code: 'device/invalid-description',
    pointer: path,
    message,
  });
};
const text: Check = (v, p, d) => {
  if (typeof v !== 'string') fail(p, d, 'Expected a string.');
};
const nonempty: Check = (v, p, d) => {
  if (typeof v !== 'string' || v.length === 0) fail(p, d, 'Expected a nonempty string.');
};
const number: Check = (v, p, d) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(p, d, 'Expected a finite number.');
};
const positive: Check = (v, p, d) => {
  number(v, p, d);
  if (typeof v === 'number' && v <= 0) fail(p, d, 'Expected a positive number.');
};
const boolean: Check = (v, p, d) => {
  if (typeof v !== 'boolean') fail(p, d, 'Expected a boolean.');
};
const choice =
  (...values: readonly unknown[]): Check =>
  (v, p, d) => {
    if (!values.includes(v)) fail(p, d, `Expected one of ${values.join(', ')}.`);
  };
const pointer = (key: string): string => key.replaceAll('~', '~0').replaceAll('/', '~1');
const object =
  (fields: Readonly<Record<string, Check>>, required: readonly string[] = []): Check =>
  (v, p, d) => {
    if (!isRecord(v)) {
      fail(p, d, 'Expected an object.');
      return;
    }
    for (const key of required)
      if (!Object.hasOwn(v, key)) fail(`${p}/${pointer(key)}`, d, 'Required field is missing.');
    for (const [key, value] of Object.entries(v)) {
      const check = Object.hasOwn(fields, key) ? fields[key] : undefined;
      if (check === undefined) fail(`${p}/${pointer(key)}`, d, 'Unknown field.');
      else check(value, `${p}/${pointer(key)}`, d);
    }
  };
const map =
  (check: Check): Check =>
  (v, p, d) => {
    if (!isRecord(v)) {
      fail(p, d, 'Expected a map.');
      return;
    }
    for (const [key, value] of Object.entries(v)) check(value, `${p}/${pointer(key)}`, d);
  };
const tuple: Check = (v, p, d) => {
  if (!Array.isArray(v) || v.length !== 2) {
    fail(p, d, 'Expected two coordinates.');
    return;
  }
  v.forEach((value, index) => number(value, `${p}/${index}`, d));
};
const strings: Check = (v, p, d) => {
  if (!Array.isArray(v)) {
    fail(p, d, 'Expected an array.');
    return;
  }
  v.forEach((value, index) => nonempty(value, `${p}/${index}`, d));
  if (new Set(v).size !== v.length) fail(p, d, 'Values must be unique.');
};
const align = choice('left', 'center', 'right');
const label = object({ visible: boolean, position: tuple, align }, ['visible']);
const editor: Check = (v, p, d) => {
  const fields: Record<string, Check> = {
    kind: choice('number', 'text', 'textarea', 'checkbox', 'file', 'select'),
  };
  if (isRecord(v) && v.kind === 'number')
    Object.assign(fields, { min: number, max: number, step: positive });
  if (isRecord(v) && v.kind === 'file') {
    fields.extensions = (value, path, diagnostics) => {
      strings(value, path, diagnostics);
      if (Array.isArray(value))
        value.forEach((extension, index) => {
          if (
            typeof extension === 'string' &&
            !/^\.[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*$/.test(extension)
          )
            fail(`${path}/${index}`, diagnostics, 'Expected a dotted filename extension.');
        });
    };
    fields.maxSize = (value, path, diagnostics) => {
      positive(value, path, diagnostics);
      if (typeof value === 'number' && !Number.isInteger(value))
        fail(path, diagnostics, 'Expected an integer byte count.');
    };
  }
  if (isRecord(v) && v.kind === 'select') fields.labels = map(text);
  object(fields, ['kind'])(v, p, d);
};
const property: Check = (v, p, d) => {
  object(
    {
      type: choice('number', 'boolean', 'string', 'enum', 'bytes'),
      required: boolean,
      nullable: boolean,
      default: () => {},
      enumName: nonempty,
      values: strings,
      title: text,
      description: text,
      unit: text,
      group: text,
      order: (value, path, diagnostics) => {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
          fail(path, diagnostics, 'Expected a nonnegative integer.');
      },
      editor,
    },
    ['type', 'required'],
  )(v, p, d);
  if (!isRecord(v)) return;
  if (v.required === true && Object.hasOwn(v, 'default'))
    fail(`${p}/default`, d, 'Required properties cannot declare defaults.');
  if (v.type === 'enum') {
    if (!Object.hasOwn(v, 'enumName') || !Object.hasOwn(v, 'values'))
      fail(p, d, 'Enum properties require enumName and values.');
    if (Array.isArray(v.values) && v.values.length === 0)
      fail(`${p}/values`, d, 'Enum values cannot be empty.');
  } else if (Object.hasOwn(v, 'enumName') || Object.hasOwn(v, 'values'))
    fail(p, d, 'Only enum properties declare enumName and values.');
};
const graphic: Check = (v, p, d) => {
  const common = {
    type: choice('line', 'polyline', 'rect', 'circle', 'arc', 'text'),
    fill: choice('none', 'foreground', 'background'),
    strokeWidth: positive,
  };
  const variants: Record<string, { fields: Record<string, Check>; required: string[] }> = {
    line: { fields: { from: tuple, to: tuple }, required: ['from', 'to'] },
    polyline: {
      fields: {
        points: (value, path, diagnostics) => {
          if (!Array.isArray(value) || value.length < 2) {
            fail(path, diagnostics, 'Expected at least two points.');
            return;
          }
          value.forEach((point, index) => tuple(point, `${path}/${index}`, diagnostics));
        },
        closed: boolean,
      },
      required: ['points'],
    },
    rect: {
      fields: { x: number, y: number, width: positive, height: positive },
      required: ['x', 'y', 'width', 'height'],
    },
    circle: { fields: { center: tuple, radius: positive }, required: ['center', 'radius'] },
    arc: {
      fields: {
        center: tuple,
        radius: positive,
        startAngle: number,
        sweepAngle: (value, path, diagnostics) => {
          number(value, path, diagnostics);
          if (typeof value === 'number' && (value === 0 || value < -360 || value > 360))
            fail(path, diagnostics, 'Sweep must be nonzero and within [-360, 360].');
        },
      },
      required: ['center', 'radius', 'startAngle', 'sweepAngle'],
    },
    text: {
      fields: { position: tuple, text, align, fontSize: positive },
      required: ['position', 'text'],
    },
  };
  const variant =
    isRecord(v) && typeof v.type === 'string' && Object.hasOwn(variants, v.type)
      ? variants[v.type]
      : undefined;
  object({ ...common, ...variant?.fields }, ['type', ...(variant?.required ?? [])])(v, p, d);
};
const graphics: Check = (v, p, d) => {
  if (!Array.isArray(v)) fail(p, d, 'Expected graphics array.');
  else v.forEach((value, i) => graphic(value, `${p}/${i}`, d));
};
const annotations = object({
  designator: object({ position: tuple, align }, ['position']),
});

/** Shared validation for optional presentation data on legacy normalized geometry. */
export function validateSymbolPresentation(
  value: Record<string, unknown>,
  diagnostics: Diagnostic[],
): void {
  if (value.graphics !== undefined) graphics(value.graphics, '/symbol/graphics', diagnostics);
  if (value.annotations !== undefined)
    annotations(value.annotations, '/symbol/annotations', diagnostics);
  if (!isRecord(value.pins)) return;
  for (const [id, pin] of Object.entries(value.pins)) {
    if (!isRecord(pin)) continue;
    const path = `/symbol/pins/${pointer(id)}`;
    if (pin.label !== undefined) label(pin.label, `${path}/label`, diagnostics);
    if (pin.displayName !== undefined) text(pin.displayName, `${path}/displayName`, diagnostics);
  }
}

const checkMetadata = object(
  {
    kind: choice('device'),
    id: (v, p, d) => {
      if (typeof v !== 'string' || !/^[A-Za-z0-9-]+$/.test(v)) fail(p, d, 'Invalid device id.');
    },
    version: nonempty,
    displayName: nonempty,
    description: nonempty,
    license: nonempty,
    tags: strings,
    templates: strings,
    recommends: object({ widgets: strings }),
    designatorPrefix: (v, p, d) => {
      if (typeof v !== 'string' || !/^\S+$/.test(v))
        fail(p, d, 'Expected a nonempty prefix without whitespace.');
    },
    properties: map(property),
    pins: map(object({ label: text, description: text, group: text })),
    ports: map(
      object(
        {
          direction: choice('input', 'output'),
          type: choice(
            'boolean',
            'number',
            'string',
            'vec2d',
            'vec3d',
            'bytes',
            'bytes<rgb565>',
            'bytes<segments>',
          ),
          title: text,
          description: text,
          delivery: choice('level', 'message'),
        },
        ['direction', 'type'],
      ),
    ),
    symbol: object(
      {
        bounds: object({ x: number, y: number, width: positive, height: positive }, [
          'x',
          'y',
          'width',
          'height',
        ]),
        graphics,
        pins: map(
          object({ position: tuple, direction: choice('left', 'right', 'up', 'down'), label }, [
            'position',
            'direction',
          ]),
        ),
        annotations,
      },
      ['bounds', 'graphics', 'pins'],
    ),
  },
  ['kind', 'id', 'version', 'displayName'],
);

/** Validates JSON text or an object, throwing the existing diagnostic-bearing format error. */
export function parseDeviceMetadata(input: unknown): DeviceMetadata {
  const diagnostics: Diagnostic[] = [];
  const parsed = parseInput(input, diagnostics);
  if (parsed.ok) checkMetadata(parsed.value, '', diagnostics);
  if (diagnostics.length > 0) throw new SchematicError(diagnostics);
  return parsed.value as DeviceMetadata;
}

export function deviceMetadataPropertyDescriptors(
  metadata: DeviceMetadata,
): ReadonlyMap<string, PropertyDescriptor> {
  return new Map(
    Object.entries(metadata.properties ?? {}).map(([key, value]) => {
      const descriptor: PropertyDescriptor = {
        key,
        type: value.type === 'bytes' ? 'binary' : value.type,
        required: value.required,
        ...(value.nullable === undefined ? {} : { nullable: value.nullable }),
        ...(value.title === undefined ? {} : { title: value.title }),
        ...(value.description === undefined ? {} : { description: value.description }),
        ...(value.unit === undefined ? {} : { unit: value.unit }),
        ...(value.group === undefined ? {} : { group: value.group }),
        ...(value.order === undefined ? {} : { order: value.order }),
        ...(value.editor === undefined ? {} : { editor: value.editor }),
        ...(value.type === 'number' && value.editor?.kind === 'number'
          ? {
              ...(value.editor.min === undefined ? {} : { min: value.editor.min }),
              ...(value.editor.max === undefined ? {} : { max: value.editor.max }),
              ...(value.editor.step === undefined ? {} : { step: value.editor.step }),
            }
          : {}),
        ...(value.type === 'enum'
          ? {
              options: value.values!.map((option) => ({
                value: option,
                label:
                  value.editor?.kind === 'select'
                    ? (value.editor.labels?.[option] ?? option)
                    : option,
              })),
            }
          : {}),
      };
      // Metadata defaults are unrestricted JSON; only instance-compatible defaults enter the document model.
      if (
        Object.hasOwn(value, 'default') &&
        propertyValueProblem(descriptor, value.default) === undefined
      ) {
        return [
          key,
          {
            ...descriptor,
            default: value.default as PropertyDescriptor['default'],
          } as PropertyDescriptor,
        ];
      }
      return [key, descriptor];
    }),
  );
}

export function deviceMetadataSymbol(metadata: DeviceMetadata): DeviceSymbolDefinition {
  const symbol = metadata.symbol;
  const base =
    symbol === undefined
      ? synthesizeDeviceSymbol({
          name: metadata.displayName,
          pins: Object.fromEntries(Object.keys(metadata.pins ?? {}).map((id) => [id, {}])),
        })
      : undefined;
  const pins: Record<string, PinAnchor> = Object.create(null);
  for (const [id, pin] of Object.entries(symbol?.pins ?? base!.pins)) {
    const caption = metadata.pins?.[id]?.label;
    if (symbol !== undefined) {
      const custom = symbol.pins[id]!;
      pins[id] = {
        x: custom.position[0],
        y: custom.position[1],
        side:
          custom.direction === 'up'
            ? 'top'
            : custom.direction === 'down'
              ? 'bottom'
              : custom.direction,
        ...(custom.label === undefined ? {} : { label: custom.label }),
        ...(caption === undefined ? {} : { displayName: caption }),
      };
    } else
      pins[id] = {
        ...(pin as PinAnchor),
        ...(caption === undefined ? {} : { displayName: caption }),
      };
  }
  return symbol === undefined
    ? { ...base!, pins }
    : {
        name: metadata.displayName,
        bounds: symbol.bounds,
        graphics: symbol.graphics,
        pins,
        ...(symbol.annotations === undefined ? {} : { annotations: symbol.annotations }),
      };
}
