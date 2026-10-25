import {
  parseDeviceReference,
  parseSchematic,
  symbolPinPosition,
  type Placement,
  type Point,
  type SchematicDocument,
} from '@mica-js/core/schematic';
import { getDeviceRegistry } from '@/lib/registry';

/** One symbol placed on a generated sheet. */
export interface SymbolSpec extends Placement {
  readonly id: string;
  readonly device: string;
  readonly designator?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly net?: string;
}

/** One wire drawn on a generated sheet. */
export interface WireSpec {
  readonly id: string;
  readonly points: readonly Point[];
}

/** Deterministic UUID v4 the parser accepts; readable enough to debug a sheet by eye. */
export function uuid(value: number): string {
  return `0000000${value.toString(16)}-0000-4000-8000-000000000000`;
}

export function symbol(
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
export function pinOf(spec: SymbolSpec, pinId: string): Point {
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
export function route(from: Point, to: Point): readonly Point[] {
  if (from.y === to.y) {
    return [from, to];
  }
  const cornerX = Math.round(((from.x + to.x) / 2) * 10) / 10;
  return [from, { x: cornerX, y: from.y }, { x: cornerX, y: to.y }, to];
}

export function wire(value: number, points: readonly Point[]): WireSpec {
  return { id: uuid(value), points };
}

export function documentOf(
  symbols: readonly SymbolSpec[],
  wires: readonly WireSpec[],
): SchematicDocument {
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
