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
      /** Degrees, clockwise around `position`. */
      readonly rotation?: number;
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
const JUNCTION_RADIUS = 3;
const VERTEX_SIZE = 5;

/** Builds a flat, drawable scene. Every color comes from `theme`. */
export function buildSchematicScene(input: RenderInput): SchematicScene {
  const { document, view, devices, theme } = input;
  const selection = input.selection ?? {};
  const tool = input.tool ?? 'select';
  const display = input.display ?? { grid: true, labels: true };
  const font = `${theme.fontSize}px ${theme.fontFamily}`;
  const pinFont = `${theme.pinFontSize}px ${theme.fontFamily}`;
  const symbolFont = `${theme.symbolFontSize}px ${theme.fontFamily}`;
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
        font: symbolFont,
      });
      continue;
    }

    const localBody = definition.bounds ?? pinsBounds(definition.pins);
    const body = symbolBounds(placement, localBody, {}) ?? fallbackBounds(placement);

    items.push({ kind: 'rect', bounds: body, fill: theme.symbolFill, stroke, width: 1.5 });
    items.push({
      kind: 'text',
      position: { x: body.x + body.width / 2, y: body.y - 12 },
      text: symbol.id,
      color: theme.symbolText,
      align: 'center',
      baseline: 'bottom',
      font,
    });
    items.push({
      kind: 'text',
      position: { x: body.x + body.width / 2, y: body.y + body.height / 2 },
      text: definition.name,
      color: theme.symbolText,
      align: 'center',
      baseline: 'middle',
      font: symbolFont,
    });

    for (const [pinId, anchor] of Object.entries(definition.pins)) {
      const side = anchor.side ?? inferSide(anchor, localBody);
      const pinPosition = symbolPinPosition(placement, anchor);
      const edge = symbolPinPosition(placement, stubEdge(localBody, anchor, side));
      items.push({ kind: 'line', from: edge, to: pinPosition, color: theme.pin, width: 1.2 });
      if (!display.labels) {
        continue;
      }
      const label = pinLabel(localBody, side, anchor);
      items.push({
        kind: 'text',
        position: symbolPinPosition(placement, label.position),
        text: pinId,
        color: theme.pinText,
        align: label.align,
        baseline: label.baseline,
        rotation: placement.rotation + label.rotation,
        font: pinFont,
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

function pinsBounds(
  pins: Readonly<Record<string, { readonly x: number; readonly y: number }>>,
): Rect {
  const points = Object.values(pins);
  if (points.length === 0) {
    return { x: -12, y: -12, width: 24, height: 24 };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function fallbackBounds(placement: { readonly x: number; readonly y: number }): Rect {
  return { x: placement.x - 12, y: placement.y - 12, width: 24, height: 24 };
}

function inferSide(
  anchor: { readonly x: number; readonly y: number },
  body: Rect,
): 'left' | 'right' | 'top' | 'bottom' {
  const centerX = body.x + body.width / 2;
  const centerY = body.y + body.height / 2;
  const dx = (anchor.x - centerX) / Math.max(body.width / 2, 1e-6);
  const dy = (anchor.y - centerY) / Math.max(body.height / 2, 1e-6);
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? 'right' : 'left';
  }
  return dy >= 0 ? 'bottom' : 'top';
}

function stubEdge(
  body: Rect,
  anchor: { readonly x: number; readonly y: number },
  side: 'left' | 'right' | 'top' | 'bottom',
): Point {
  switch (side) {
    case 'left':
      return { x: body.x, y: anchor.y };
    case 'right':
      return { x: body.x + body.width, y: anchor.y };
    case 'top':
      return { x: anchor.x, y: body.y };
    case 'bottom':
      return { x: anchor.x, y: body.y + body.height };
    default:
      return anchor;
  }
}

function pinLabel(
  body: Rect,
  side: 'left' | 'right' | 'top' | 'bottom',
  anchor: { readonly x: number; readonly y: number },
): {
  position: Point;
  align: 'left' | 'center' | 'right';
  baseline: 'top' | 'middle' | 'bottom';
  rotation: number;
} {
  const centerX = body.x + body.width / 2;
  const centerY = body.y + body.height / 2;
  const clampX = Math.min(Math.max(anchor.x, body.x), body.x + body.width);
  const clampY = Math.min(Math.max(anchor.y, body.y), body.y + body.height);
  switch (side) {
    case 'left':
      return {
        position: { x: body.x + 5, y: clampY },
        align: 'left',
        baseline: 'middle',
        rotation: 0,
      };
    case 'right':
      return {
        position: { x: body.x + body.width - 5, y: clampY },
        align: 'right',
        baseline: 'middle',
        rotation: 0,
      };
    case 'top':
      return {
        position: { x: clampX, y: body.y + 10 },
        align: 'center',
        baseline: 'middle',
        rotation: -90,
      };
    case 'bottom':
      return {
        position: { x: clampX, y: body.y + body.height - 10 },
        align: 'center',
        baseline: 'middle',
        rotation: -90,
      };
    default:
      return {
        position: { x: centerX, y: centerY },
        align: 'center',
        baseline: 'middle',
        rotation: 0,
      };
  }
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
