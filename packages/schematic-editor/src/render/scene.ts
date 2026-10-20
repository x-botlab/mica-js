import {
  DEFAULT_GROUND_LABEL,
  DEFAULT_POWER_LABEL,
  builtinSymbolKind,
  parseDeviceReference,
  symbolBounds,
  symbolPinPosition,
  type DeviceSymbolProvider,
  type Point,
  type Rect,
  type SchematicDocument,
  type SchematicHit,
  type SchematicViewDocument,
} from '@mica/core/schematic';
import type { SchematicTheme } from './theme';

export type SceneTool = 'select' | 'wire' | 'power' | 'ground';

export interface SceneSelection {
  readonly symbols?: ReadonlySet<string>;
  readonly wires?: ReadonlySet<string>;
  readonly junctions?: ReadonlySet<string>;
  readonly vertices?: readonly { readonly wireId: string; readonly index: number }[];
}

export interface SceneDisplayOptions {
  readonly grid: boolean;
  readonly gridSize?: number;
  readonly labels: boolean;
}

export type SceneItem =
  | {
      readonly kind: 'line';
      readonly from: Point;
      readonly to: Point;
      readonly color: string;
      readonly width: number;
      readonly dash?: readonly number[];
    }
  | {
      readonly kind: 'polyline';
      readonly points: readonly Point[];
      readonly color: string;
      readonly width: number;
      readonly dash?: readonly number[];
    }
  | {
      readonly kind: 'rect';
      readonly bounds: Rect;
      readonly fill?: string;
      readonly stroke?: string;
      readonly width: number;
      readonly dash?: readonly number[];
    }
  | {
      readonly kind: 'circle';
      readonly center: Point;
      readonly radius: number;
      readonly fill?: string;
      readonly stroke?: string;
      readonly width: number;
    }
  | {
      readonly kind: 'text';
      readonly position: Point;
      readonly text: string;
      readonly color: string;
      readonly align: 'left' | 'center' | 'right';
      readonly baseline: 'top' | 'middle' | 'bottom';
      readonly font: string;
    };

export interface SchematicScene {
  readonly background: string;
  readonly grid:
    { readonly size: number; readonly minor: string; readonly major: string } | undefined;
  readonly items: readonly SceneItem[];
}

export interface RenderInput {
  readonly document: SchematicDocument;
  readonly view?: SchematicViewDocument;
  readonly devices?: DeviceSymbolProvider;
  readonly theme: SchematicTheme;
  readonly selection?: SceneSelection;
  readonly hover?: SchematicHit;
  readonly tool?: SceneTool;
  readonly display?: SceneDisplayOptions;
  readonly pendingWire?: readonly Point[];
}

const WIRE_WIDTH = 1.5;
const SELECTED_WIDTH = 2.5;
const PIN_RADIUS = 1.6;
const JUNCTION_RADIUS = 3;
const VERTEX_SIZE = 5;

/** Builds a flat, drawable scene. Every color comes from `theme`. */
export function buildSchematicScene(input: RenderInput): SchematicScene {
  const { document, view, devices, theme } = input;
  const selection = input.selection ?? {};
  const tool = input.tool ?? 'select';
  const display = input.display ?? { grid: true, labels: true };
  const font = `${theme.fontSize}px ${theme.fontFamily}`;
  const items: SceneItem[] = [];

  for (const wire of document.sheet.wires) {
    const selected = selection.wires?.has(wire.id) ?? false;
    const hovered = input.hover?.kind === 'wire' && input.hover.id === wire.id;
    items.push({
      kind: 'polyline',
      points: wire.points,
      color: selected ? theme.wireSelected : hovered ? theme.hover : theme.wire,
      width: selected ? SELECTED_WIDTH : WIRE_WIDTH,
    });
  }

  for (const junction of document.sheet.junctions) {
    const selected = selection.junctions?.has(junction.id) ?? false;
    const hovered = input.hover?.kind === 'junction' && input.hover.id === junction.id;
    items.push({
      kind: 'circle',
      center: { x: junction.x, y: junction.y },
      radius: JUNCTION_RADIUS,
      fill: selected ? theme.junctionSelected : hovered ? theme.hover : theme.junction,
      width: 0,
    });
  }

  for (const symbol of document.sheet.symbols) {
    const selected = selection.symbols?.has(symbol.id) ?? false;
    const hovered = input.hover?.kind === 'symbol' && input.hover.id === symbol.id;
    const placement = view?.layout[symbol.id] ?? {
      x: symbol.x,
      y: symbol.y,
      rotation: symbol.rotation,
    };
    const stroke = selected ? theme.selection : hovered ? theme.hover : theme.symbolStroke;
    const builtin = builtinSymbolKind(symbol.device);

    if (builtin !== undefined) {
      drawBuiltin(items, {
        kind: builtin,
        position: placement,
        text:
          builtin === 'label'
            ? symbol.id
            : ((symbol.properties?.['label'] as string | undefined) ??
              (builtin === 'power' ? DEFAULT_POWER_LABEL : DEFAULT_GROUND_LABEL)),
        color: selected ? theme.selection : theme.labelText,
        anchorColor: theme.labelAnchor,
        font,
      });
      continue;
    }

    const reference = parseDeviceReference(symbol.device);
    const definition = reference === undefined ? undefined : devices?.getDeviceSymbol(reference);

    if (definition === undefined) {
      const half = 12;
      items.push({
        kind: 'rect',
        bounds: { x: placement.x - half, y: placement.y - half, width: half * 2, height: half * 2 },
        stroke: theme.symbolPlaceholder,
        width: 1,
        dash: [4, 3],
      });
      items.push({
        kind: 'text',
        position: { x: placement.x, y: placement.y },
        text:
          (reference === undefined ? undefined : devices?.getDeviceName(reference)) ?? symbol.id,
        color: theme.symbolPlaceholder,
        align: 'center',
        baseline: 'middle',
        font,
      });
      continue;
    }

    const bounds = symbolBounds(placement, definition.bounds, definition.pins);
    if (bounds !== undefined) {
      items.push({ kind: 'rect', bounds, fill: theme.symbolFill, stroke, width: 1.2 });
    }
    items.push({
      kind: 'text',
      position: { x: placement.x, y: placement.y },
      text: definition.name,
      color: theme.symbolText,
      align: 'center',
      baseline: 'middle',
      font,
    });

    for (const [pinId, anchor] of Object.entries(definition.pins)) {
      const pinPosition = symbolPinPosition(placement, anchor);
      items.push({
        kind: 'circle',
        center: pinPosition,
        radius: PIN_RADIUS,
        fill: theme.pin,
        width: 0,
      });
      if (!display.labels) {
        continue;
      }
      const direction = symbolPinPosition({ x: 0, y: 0, rotation: placement.rotation }, anchor);
      const outward = {
        x: Math.abs(direction.x) >= Math.abs(direction.y) ? Math.sign(direction.x) : 0,
        y: Math.abs(direction.y) > Math.abs(direction.x) ? Math.sign(direction.y) : 0,
      };
      items.push({
        kind: 'text',
        position: {
          x: pinPosition.x + outward.x * 4,
          y: pinPosition.y + outward.y * 4,
        },
        text: pinId,
        color: theme.pinText,
        align: outward.x > 0 ? 'left' : outward.x < 0 ? 'right' : 'center',
        baseline: outward.y > 0 ? 'top' : outward.y < 0 ? 'bottom' : 'middle',
        font,
      });
    }
  }

  for (const vertex of selection.vertices ?? []) {
    const wire = document.sheet.wires.find((candidate) => candidate.id === vertex.wireId);
    const point = wire?.points[vertex.index];
    if (point === undefined) {
      continue;
    }
    items.push({
      kind: 'rect',
      bounds: {
        x: point.x - VERTEX_SIZE / 2,
        y: point.y - VERTEX_SIZE / 2,
        width: VERTEX_SIZE,
        height: VERTEX_SIZE,
      },
      fill: theme.selection,
      width: 0,
    });
  }

  if (tool === 'wire' && input.pendingWire !== undefined && input.pendingWire.length > 0) {
    items.push({
      kind: 'polyline',
      points: input.pendingWire,
      color: theme.pendingWire,
      width: WIRE_WIDTH,
      dash: [5, 4],
    });
    const last = input.pendingWire[input.pendingWire.length - 1];
    if (last !== undefined) {
      items.push({ kind: 'circle', center: last, radius: 2.5, fill: theme.pendingWire, width: 0 });
    }
  }

  return {
    background: theme.background,
    grid:
      display.grid === false
        ? undefined
        : {
            size: display.gridSize ?? theme.gridSize,
            minor: theme.grid,
            major: theme.gridMajor,
          },
    items,
  };
}

function drawBuiltin(
  items: SceneItem[],
  input: {
    readonly kind: 'label' | 'power' | 'ground';
    readonly position: Point;
    readonly text: string;
    readonly color: string;
    readonly anchorColor: string;
    readonly font: string;
  },
): void {
  const { position, color, anchorColor, font } = input;
  items.push({ kind: 'circle', center: position, radius: 2.5, fill: anchorColor, width: 0 });

  if (input.kind === 'power') {
    items.push({
      kind: 'line',
      from: position,
      to: { x: position.x, y: position.y - 10 },
      color,
      width: 1.5,
    });
    items.push({
      kind: 'line',
      from: { x: position.x - 6, y: position.y - 10 },
      to: { x: position.x + 6, y: position.y - 10 },
      color,
      width: 1.5,
    });
    items.push({
      kind: 'text',
      position: { x: position.x + 9, y: position.y - 10 },
      text: input.text,
      color,
      align: 'left',
      baseline: 'middle',
      font,
    });
    return;
  }

  if (input.kind === 'ground') {
    items.push({
      kind: 'line',
      from: position,
      to: { x: position.x, y: position.y + 6 },
      color,
      width: 1.5,
    });
    for (const [offset, width] of [
      [6, 12],
      [9, 8],
      [12, 4],
    ] as const) {
      items.push({
        kind: 'line',
        from: { x: position.x - width / 2, y: position.y + offset },
        to: { x: position.x + width / 2, y: position.y + offset },
        color,
        width: 1.5,
      });
    }
    items.push({
      kind: 'text',
      position: { x: position.x + 9, y: position.y + 9 },
      text: input.text,
      color,
      align: 'left',
      baseline: 'middle',
      font,
    });
    return;
  }

  items.push({
    kind: 'text',
    position: { x: position.x + 6, y: position.y },
    text: input.text,
    color,
    align: 'left',
    baseline: 'middle',
    font,
  });
}
