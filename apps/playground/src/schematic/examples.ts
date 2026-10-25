import {
  parseDeviceReference,
  parseSchematic,
  symbolPinPosition,
  type Placement,
  type Point,
  type SchematicDocument,
} from '@mica-js/core/schematic';
import { getDeviceRegistry } from '@/lib/registry';

/** One page under "原理图示例"; the editor mounts `document`. */
export interface SchematicExample {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly document: SchematicDocument;
}

interface SymbolSpec extends Placement {
  readonly id: string;
  readonly device: string;
  readonly designator?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly net?: string;
}

interface WireSpec {
  readonly id: string;
  readonly points: readonly Point[];
}

/** Deterministic UUID v4 the parser accepts; readable enough to debug a sheet by eye. */
function uuid(value: number): string {
  return `0000000${value.toString(16)}-0000-4000-8000-000000000000`;
}

function symbol(
  value: number,
  device: string,
  x: number,
  y: number,
  options: {
    readonly designator?: string;
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly net?: string;
  } = {},
): SymbolSpec {
  return { id: uuid(value), device, x, y, rotation: 0, ...options };
}

/** Resolves a placed pin through the shared registry, so wires never hardcode geometry. */
function pinOf(spec: SymbolSpec, pinId: string): Point {
  if (spec.device.startsWith('builtin:')) {
    return { x: spec.x, y: spec.y };
  }
  const reference = parseDeviceReference(spec.device);
  const anchor =
    reference === undefined
      ? undefined
      : getDeviceRegistry().getDeviceSymbol(reference)?.pins[pinId];
  if (anchor === undefined) {
    throw new Error(`Device ${spec.device} has no pin ${pinId}.`);
  }
  return symbolPinPosition(spec, anchor);
}

/** Orthogonal route with one vertical fold, which is what a hand-drawn sheet looks like. */
function route(from: Point, to: Point): readonly Point[] {
  if (from.y === to.y) {
    return [from, to];
  }
  const cornerX = Math.round(((from.x + to.x) / 2) * 10) / 10;
  return [from, { x: cornerX, y: from.y }, { x: cornerX, y: to.y }, to];
}

function wire(value: number, points: readonly Point[]): WireSpec {
  return { id: uuid(value), points };
}

function documentOf(symbols: readonly SymbolSpec[], wires: readonly WireSpec[]): SchematicDocument {
  return parseSchematic(
    JSON.stringify({
      version: 1,
      sheet: {
        symbols: symbols.map((spec) => ({
          id: spec.id,
          device: spec.device,
          x: spec.x,
          y: spec.y,
          rotation: spec.rotation,
          ...(spec.designator === undefined ? {} : { designator: spec.designator }),
          ...(spec.properties === undefined ? {} : { properties: spec.properties }),
          ...(spec.net === undefined ? {} : { net: spec.net }),
        })),
        wires,
        junctions: [],
      },
    }),
  );
}

const ledBlinkMcu = symbol(1, 'mica:teaching-mcu', 260, 220, { designator: 'U1' });
const ledBlinkLed = symbol(2, 'board:led', 620, 200, {
  designator: 'D1',
  properties: { color: '#F97316' },
});
const ledBlinkAnode = pinOf(ledBlinkLed, 'A');
const ledBlinkCathode = pinOf(ledBlinkLed, 'K');
const ledBlinkGround = symbol(3, 'builtin:ground', ledBlinkCathode.x, ledBlinkCathode.y + 130, {
  net: 'GND',
});

const segmentMcu = symbol(1, 'mica:teaching-mcu', 240, 260, { designator: 'U1' });
const segmentDisplay = symbol(2, 'board:seven-segment', 640, 160, { designator: 'DS1' });
const segmentPin = pinOf(segmentDisplay, 'A');
const segmentCommon = pinOf(segmentDisplay, 'COM');
const segmentGround = symbol(3, 'builtin:ground', segmentCommon.x, segmentCommon.y + 140, {
  net: 'GND',
});

const basicPower = symbol(1, 'builtin:power', 180, 160, { net: '5V' });
const basicButton = symbol(2, 'mica:ideal-button', 380, 210, { designator: 'S1' });
const basicLed = symbol(3, 'board:led', 660, 200, {
  designator: 'D1',
  properties: { color: '#22C55E' },
});
const basicButtonOut = pinOf(basicButton, 'A');
const basicButtonIn = pinOf(basicButton, 'B');
const basicAnode = pinOf(basicLed, 'A');
const basicCathode = pinOf(basicLed, 'K');
const basicGround = symbol(4, 'builtin:ground', basicCathode.x, basicCathode.y + 130, {
  net: 'GND',
});

/** The three starter sheets; each one stays small enough to read in a single screen. */
export const SCHEMATIC_EXAMPLES: readonly SchematicExample[] = Object.freeze([
  {
    id: 'led-blink',
    title: 'LED 闪烁',
    summary: 'teaching-mcu 的 GPIO 驱动 LED：把定时翻转固件换成你自己的。',
    document: documentOf(
      [ledBlinkMcu, ledBlinkLed, ledBlinkGround],
      [
        wire(9, route(pinOf(ledBlinkMcu, 'GPIO'), ledBlinkAnode)),
        wire(10, [ledBlinkCathode, { x: ledBlinkCathode.x, y: ledBlinkGround.y }]),
      ],
    ),
  },
  {
    id: 'segment-display',
    title: '数码管显示',
    summary: 'teaching-mcu + 7 段数码管：段选与共地接线的最小示例。',
    document: documentOf(
      [segmentMcu, segmentDisplay, segmentGround],
      [
        wire(9, route(pinOf(segmentMcu, 'GPIO'), segmentPin)),
        wire(10, [segmentCommon, { x: segmentCommon.x, y: segmentGround.y }]),
      ],
    ),
  },
  {
    id: 'basic-io',
    title: '基础 I/O',
    summary: '按钮输入 + LED 输出：5 V → 按钮 → LED → 地。',
    document: documentOf(
      [basicPower, basicButton, basicLed, basicGround],
      [
        wire(9, route({ x: basicPower.x, y: basicPower.y }, basicButtonIn)),
        wire(10, route(basicButtonOut, basicAnode)),
        wire(11, [basicCathode, { x: basicCathode.x, y: basicGround.y }]),
      ],
    ),
  },
]);

export function schematicExampleById(id: string): SchematicExample {
  const example = SCHEMATIC_EXAMPLES.find((candidate) => candidate.id === id);
  if (example === undefined) {
    throw new Error(`Unknown schematic example "${id}".`);
  }
  return example;
}

export const LED_BLINK_EXAMPLE = schematicExampleById('led-blink');
export const SEGMENT_DISPLAY_EXAMPLE = schematicExampleById('segment-display');
export const BASIC_IO_EXAMPLE = schematicExampleById('basic-io');
