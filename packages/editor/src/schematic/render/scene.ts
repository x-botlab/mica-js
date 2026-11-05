import {
  DEFAULT_TEXT_CONTENT,
  builtinSymbolKind,
  designatorOf,
  isTextDevice,
  netNameOf,
  parseDeviceReference,
  pinSide,
  pinStubEnd,
  pinsBounds,
  referencePosition,
  rotatePoint,
  symbolBounds,
  symbolPinPosition,
  textDeviceContent,
  type DeviceSymbolDefinition,
  type DeviceSymbolProvider,
  type Placement,
  type Point,
  type Rect,
  type SchematicDocument,
  type SchematicSymbol,
} from '@mica-js/document/schematic';
import { previewSymbolDrag } from '../editing/preview';
import { type SchematicHit } from '../editing/query';
import type { ISchematicTheme } from './theme';
import { deviceReferencePosition } from '../model/reference';
export type SceneTool = 'select' | 'wire' | 'power' | 'ground' | 'label' | 'text';

export interface ISceneSelection {
  readonly symbols?: ReadonlySet<string>;
  readonly wires?: ReadonlySet<string>;
  readonly junctions?: ReadonlySet<string>;
  readonly vertices?: readonly { readonly wireId: string; readonly index: number }[];
  /** Preview offset applied to the selected symbols while dragging. */
  readonly offset?: Point;
}

export interface ISceneDisplayOptions {
  readonly grid: boolean;
  readonly gridSize?: number;
  /** Visible grid lines per snap cell; `1` draws only the snap grid. */
  readonly gridSubdivisions?: number;
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
      readonly closed?: boolean;
      readonly fill?: string;
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
      readonly kind: 'arc';
      readonly center: Point;
      readonly radius: number;
      readonly startAngle: number;
      readonly sweepAngle: number;
      readonly fill?: string;
      readonly stroke: string;
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

export interface ISchematicScene {
  readonly background: string;
  readonly grid:
    | {
        readonly size: number;
        /** Minor lines drawn per snap cell; `1` means the cell size is the only step. */
        readonly subdivisions: number;
        readonly minor: string;
        readonly major: string;
      }
    | undefined;
  readonly items: readonly SceneItem[];
}

export interface IRenderInput {
  readonly document: SchematicDocument;
  readonly devices?: DeviceSymbolProvider;
  readonly theme: ISchematicTheme;
  readonly selection?: ISceneSelection;
  readonly hover?: SchematicHit;
  readonly tool?: SceneTool;
  readonly display?: ISceneDisplayOptions;
  readonly pendingWire?: readonly Point[];
  /** Rubber-band selection rectangle in page units. */
  readonly marquee?: Rect;
  /** Ghost of the symbol the current placement tool would insert. */
  readonly placementPreview?: {
    readonly device: string;
    readonly position: Point;
    readonly rotation: number;
    /** Stub wire the placement will add, e.g. when a label lands on a pin. */
    readonly wire?: readonly Point[];
  };
  /** Reference designator being dragged; drawn at this world position instead. */
  readonly referencePreview?: { readonly symbolId: string; readonly position: Point };
  /** Wire being reshaped by a segment drag; drawn with these points instead of the document's. */
  readonly wirePreview?: { readonly wireId: string; readonly points: readonly Point[] };
}

const WIRE_WIDTH = 1.5;
const SELECTED_WIDTH = 2.5;
const JUNCTION_RADIUS = 3;
const VERTEX_SIZE = 5;

/** Visible grid lines per snap cell; anything unset or invalid falls back to the snap grid. */
function gridSubdivisions(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 1 ? Math.round(value) : 1;
}

interface ITextPlacement {
  readonly align: 'left' | 'center' | 'right';
  readonly baseline: 'top' | 'middle' | 'bottom';
  readonly rotation: number;
}

const ALIGN_MIRROR: Readonly<Record<ITextPlacement['align'], ITextPlacement['align']>> = {
  left: 'right',
  center: 'center',
  right: 'left',
};

const BASELINE_MIRROR: Readonly<Record<ITextPlacement['baseline'], ITextPlacement['baseline']>> = {
  top: 'bottom',
  middle: 'middle',
  bottom: 'top',
};

/**
 * Text turns with the symbol, except at half turns where it would read upside down: those flip
 * back and mirror the anchor alignment so the glyphs stay on the same side of the anchor.
 */
function uprightText(
  rotation: number,
  align: ITextPlacement['align'],
  baseline: ITextPlacement['baseline'],
): ITextPlacement {
  const normalized = (((rotation % 360) + 540) % 360) - 180;
  if (Math.abs(normalized) === 180) {
    return { align: ALIGN_MIRROR[align], baseline: BASELINE_MIRROR[baseline], rotation: 0 };
  }
  return { align, baseline, rotation: normalized };
}

interface IPreviewDrag {
  readonly wires: ReadonlyMap<string, readonly Point[]>;
  readonly junctions: ReadonlyMap<string, Point>;
  readonly symbols: ReadonlyMap<string, Point>;
}

const NO_PREVIEW: IPreviewDrag = { wires: new Map(), junctions: new Map(), symbols: new Map() };

/** Live preview of the dragged symbols: wires, junctions and anchors follow their pins. */
function previewDrag(
  document: SchematicDocument,
  devices: DeviceSymbolProvider | undefined,
  selection: ISceneSelection,
): IPreviewDrag {
  const offset = selection.offset;
  if (offset === undefined || selection.symbols === undefined) {
    return NO_PREVIEW;
  }
  const wires = new Map<string, readonly Point[]>();
  const junctions = new Map<string, Point>();
  const symbols = new Map<string, Point>();
  for (const symbol of document.sheet.symbols) {
    if (!selection.symbols.has(symbol.id)) {
      continue;
    }
    const placed = { x: symbol.x, y: symbol.y, rotation: symbol.rotation };
    const preview = previewSymbolDrag(document, devices, symbol.id, {
      ...placed,
      x: placed.x + offset.x,
      y: placed.y + offset.y,
    });
    if (preview === undefined) {
      continue;
    }
    for (const [id, points] of preview.wires) {
      wires.set(id, points);
    }
    for (const [id, point] of preview.junctions) {
      junctions.set(id, point);
    }
    for (const [id, point] of preview.symbols) {
      symbols.set(id, point);
    }
    symbols.set(symbol.id, { x: placed.x + offset.x, y: placed.y + offset.y });
  }
  return { wires, junctions, symbols };
}

/** Builds a flat, drawable scene. Every color comes from `theme`. */
export function buildSchematicScene(input: IRenderInput): ISchematicScene {
  const { document, devices, theme } = input;
  const selection = input.selection ?? {};
  const tool = input.tool ?? 'select';
  const display = input.display ?? { grid: true, labels: true };
  const font = `${theme.fontSize}px ${theme.fontFamily}`;
  const pinFont = `${theme.pinFontSize}px ${theme.fontFamily}`;
  const symbolFont = `${theme.symbolFontSize}px ${theme.fontFamily}`;
  const items: SceneItem[] = [];
  const drag = previewDrag(document, devices, selection);

  for (const wire of document.sheet.wires) {
    const selected = selection.wires?.has(wire.id) ?? false;
    const hovered = input.hover?.kind === 'wire' && input.hover.id === wire.id;
    const preview = input.wirePreview;
    const points =
      preview !== undefined && preview.wireId === wire.id
        ? preview.points
        : (drag.wires.get(wire.id) ?? wire.points);
    items.push({
      kind: 'polyline',
      points,
      color: selected ? theme.wireSelected : hovered ? theme.hover : theme.wire,
      width: selected ? SELECTED_WIDTH : WIRE_WIDTH,
    });
  }

  for (const junction of document.sheet.junctions) {
    const selected = selection.junctions?.has(junction.id) ?? false;
    const hovered = input.hover?.kind === 'junction' && input.hover.id === junction.id;
    const center = drag.junctions.get(junction.id) ?? { x: junction.x, y: junction.y };
    items.push({
      kind: 'circle',
      center,
      radius: JUNCTION_RADIUS,
      fill: selected ? theme.junctionSelected : hovered ? theme.hover : theme.junction,
      width: 0,
    });
  }

  for (const symbol of document.sheet.symbols) {
    const selected = selection.symbols?.has(symbol.id) ?? false;
    const hovered =
      (input.hover?.kind === 'symbol' && input.hover.id === symbol.id) ||
      (input.hover?.kind === 'reference' && input.hover.symbolId === symbol.id);
    const placed = { x: symbol.x, y: symbol.y, rotation: symbol.rotation };
    const dragged = drag.symbols.get(symbol.id);
    drawSymbol(items, {
      symbol,
      placement: dragged === undefined ? placed : { ...placed, x: dragged.x, y: dragged.y },
      theme,
      devices,
      labels: display.labels,
      fonts: { font, pinFont, symbolFont },
      selected,
      hovered,
      ...(input.referencePreview?.symbolId === symbol.id
        ? { referenceOverride: input.referencePreview.position }
        : {}),
    });
  }
  for (const vertex of selection.vertices ?? []) {
    const wire = document.sheet.wires.find((candidate) => candidate.id === vertex.wireId);
    const point = wire?.points[vertex.index];
    if (point === undefined) {
      continue;
    }
    const center = point;
    items.push({
      kind: 'rect',
      bounds: {
        x: center.x - VERTEX_SIZE / 2,
        y: center.y - VERTEX_SIZE / 2,
        width: VERTEX_SIZE,
        height: VERTEX_SIZE,
      },
      fill: theme.selection,
      width: 0,
    });
  }

  if (input.marquee !== undefined) {
    items.push({
      kind: 'rect',
      bounds: input.marquee,
      stroke: theme.selection,
      width: 1,
      dash: [4, 3],
    });
  }

  if (input.placementPreview !== undefined) {
    const { device, position, rotation, wire } = input.placementPreview;
    if (wire !== undefined) {
      items.push({ kind: 'polyline', points: wire, color: theme.hover, width: WIRE_WIDTH });
    }
    drawSymbol(items, {
      symbol: previewSymbol(device, position),
      placement: { ...position, rotation },
      theme,
      devices,
      labels: display.labels,
      fonts: { font, pinFont, symbolFont },
      selected: false,
      hovered: false,
      ghost: true,
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
            subdivisions: gridSubdivisions(display.gridSubdivisions),
            minor: theme.grid,
            major: theme.gridMajor,
          },
    items,
  };
}

interface ISymbolFonts {
  readonly font: string;
  readonly pinFont: string;
  readonly symbolFont: string;
}

interface IDrawSymbolOptions {
  readonly symbol: SchematicSymbol;
  readonly placement: Placement;
  readonly theme: ISchematicTheme;
  readonly devices: DeviceSymbolProvider | undefined;
  readonly labels: boolean;
  readonly fonts: ISymbolFonts;
  readonly selected: boolean;
  readonly hovered: boolean;
  /** Drawn as a placement ghost (hover color, no reference override). */
  readonly ghost?: boolean;
  readonly referenceOverride?: Point;
}

/**
 * Draws one symbol: the single code path shared by placed symbols and the placement preview,
 * so what follows the cursor is exactly what will be inserted.
 */
function drawSymbol(items: SceneItem[], options: IDrawSymbolOptions): void {
  const { symbol, placement, theme, devices, fonts, selected, hovered } = options;
  const ghost = options.ghost ?? false;
  const highlight = selected ? theme.selection : hovered || ghost ? theme.hover : undefined;
  const stroke = highlight ?? theme.symbolStroke;
  const annotation = highlight ?? theme.labelText;

  if (isTextDevice(symbol.device)) {
    items.push({
      kind: 'text',
      position: placement,
      text: textDeviceContent(symbol),
      color: annotation,
      ...uprightText(placement.rotation, 'left', 'middle'),
      font: fonts.symbolFont,
    });
    return;
  }

  const builtin = builtinSymbolKind(symbol.device);
  if (builtin !== undefined) {
    drawBuiltin(items, {
      kind: builtin,
      placement,
      text: netNameOf(symbol) ?? symbol.id,
      color: annotation,
      anchorColor: highlight ?? theme.labelAnchor,
      font: builtin === 'label' ? fonts.font : fonts.pinFont,
    });
    return;
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
      text: (reference === undefined ? undefined : devices?.getDeviceName(reference)) ?? symbol.id,
      color: theme.symbolPlaceholder,
      align: 'center',
      baseline: 'middle',
      font: fonts.symbolFont,
    });
    return;
  }

  const localBody = definition.bounds ??
    pinsBounds(definition.pins) ?? { x: -12, y: -12, width: 24, height: 24 };
  if (definition.graphics !== undefined) {
    drawCustomSymbol(items, options, definition, localBody);
    return;
  }

  const body = symbolBounds(placement, localBody, {}) ?? fallbackBounds(placement);

  items.push({ kind: 'rect', bounds: body, fill: theme.symbolFill, stroke, width: 1.5 });
  items.push({
    kind: 'text',
    position:
      options.referenceOverride ?? referencePosition(placement, localBody, symbol.reference),
    text: designatorOf(symbol) ?? symbol.id,
    color: options.referenceOverride === undefined ? annotation : theme.selection,
    ...uprightText(placement.rotation, 'left', 'bottom'),
    font: fonts.pinFont,
  });
  items.push({
    kind: 'text',
    position: { x: body.x + body.width / 2, y: body.y + body.height / 2 },
    text: definition.name,
    // Inverted on purpose: the name is quiet by default and lights up on hover / selection.
    color: selected || hovered ? theme.selection : theme.symbolText,
    ...uprightText(placement.rotation, 'center', 'middle'),
    font: fonts.symbolFont,
  });

  for (const anchor of Object.values(definition.pins)) {
    const side = pinSide(anchor, localBody) ?? 'left';
    const pinPosition = symbolPinPosition(placement, anchor);
    const edge = symbolPinPosition(placement, pinStubEnd(localBody, anchor, side));
    items.push({
      kind: 'line',
      from: edge,
      to: pinPosition,
      color: highlight ?? theme.pin,
      width: 1.2,
    });
  }
  drawPinLabels(items, options, definition, localBody);
}

function drawCustomSymbol(
  items: SceneItem[],
  options: IDrawSymbolOptions,
  definition: DeviceSymbolDefinition,
  localBody: Rect,
): void {
  const { placement, theme, symbol, selected, hovered, fonts } = options;
  const highlight = selected ? theme.selection : hovered || options.ghost ? theme.hover : undefined;
  const stroke = highlight ?? theme.symbolStroke;
  const at = (point: readonly [number, number]): Point =>
    symbolPinPosition(placement, { x: point[0], y: point[1] });
  for (const graphic of definition.graphics ?? []) {
    const fill =
      graphic.fill === 'foreground'
        ? stroke
        : graphic.fill === 'background'
          ? theme.symbolFill
          : undefined;
    const style = { ...(fill === undefined ? {} : { fill }), width: graphic.strokeWidth ?? 1.5 };
    switch (graphic.type) {
      case 'line':
        items.push({
          kind: 'line',
          from: at(graphic.from),
          to: at(graphic.to),
          color: stroke,
          width: style.width,
        });
        break;
      case 'polyline':
        items.push({
          kind: 'polyline',
          points: graphic.points.map(at),
          closed: graphic.closed ?? false,
          color: stroke,
          ...style,
        });
        break;
      case 'rect':
        items.push({
          kind: 'polyline',
          points: [
            at([graphic.x, graphic.y]),
            at([graphic.x + graphic.width, graphic.y]),
            at([graphic.x + graphic.width, graphic.y + graphic.height]),
            at([graphic.x, graphic.y + graphic.height]),
          ],
          closed: true,
          color: stroke,
          ...style,
        });
        break;
      case 'circle':
        items.push({
          kind: 'circle',
          center: at(graphic.center),
          radius: graphic.radius,
          stroke,
          ...style,
        });
        break;
      case 'arc':
        items.push({
          kind: 'arc',
          center: at(graphic.center),
          radius: graphic.radius,
          startAngle: graphic.startAngle + placement.rotation,
          sweepAngle: graphic.sweepAngle,
          stroke,
          ...style,
        });
        break;
      case 'text':
        items.push({
          kind: 'text',
          position: at(graphic.position),
          text: graphic.text,
          color: stroke,
          ...uprightText(placement.rotation, graphic.align ?? 'left', 'middle'),
          font:
            graphic.fontSize === undefined
              ? fonts.symbolFont
              : `${graphic.fontSize}px ${theme.fontFamily}`,
        });
        break;
    }
  }
  const annotation = definition.annotations?.designator;
  items.push({
    kind: 'text',
    position:
      options.referenceOverride ??
      deviceReferencePosition(
        {
          ...placement,
          ...(symbol.reference === undefined ? {} : { reference: symbol.reference }),
        },
        definition,
      ),
    text: designatorOf(symbol) ?? symbol.id,
    color:
      options.referenceOverride === undefined ? (highlight ?? theme.labelText) : theme.selection,
    ...uprightText(placement.rotation, annotation?.align ?? 'left', 'bottom'),
    font: fonts.pinFont,
  });
  drawPinLabels(items, options, definition, localBody);
}

function drawPinLabels(
  items: SceneItem[],
  options: IDrawSymbolOptions,
  definition: DeviceSymbolDefinition,
  localBody: Rect,
): void {
  if (!options.labels) return;
  const { placement, theme, fonts, selected, hovered } = options;
  const highlight = selected ? theme.selection : hovered || options.ghost ? theme.hover : undefined;
  for (const [pinId, pin] of Object.entries(definition.pins)) {
    if (pin.label?.visible === false) continue;
    const explicit = pin.label?.position;
    const label =
      explicit === undefined
        ? pinLabel(localBody, pinSide(pin, localBody) ?? 'left', pin)
        : {
            position: { x: explicit[0], y: explicit[1] },
            align: 'left' as const,
            baseline: 'middle' as const,
            rotation: 0,
          };
    items.push({
      kind: 'text',
      position: symbolPinPosition(placement, label.position),
      text: pin.displayName ?? pinId,
      color: highlight ?? theme.pinText,
      ...uprightText(
        placement.rotation + label.rotation,
        pin.label?.align ?? label.align,
        label.baseline,
      ),
      font: fonts.pinFont,
    });
  }
}

/** Synthetic symbol used to preview the current placement tool. */
function previewSymbol(device: string, position: Point): SchematicSymbol {
  const base: SchematicSymbol = { id: 'N', device, x: position.x, y: position.y, rotation: 0 };
  if (isTextDevice(device)) {
    return { ...base, properties: { text: DEFAULT_TEXT_CONTENT } };
  }
  return base;
}

function fallbackBounds(placement: { readonly x: number; readonly y: number }): Rect {
  return { x: placement.x - 12, y: placement.y - 12, width: 24, height: 24 };
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
        position: { x: body.x + 2, y: clampY },
        align: 'left',
        baseline: 'middle',
        rotation: 0,
      };
    case 'right':
      return {
        position: { x: body.x + body.width - 2, y: clampY },
        align: 'right',
        baseline: 'middle',
        rotation: 0,
      };
    case 'top':
      return {
        position: { x: clampX, y: body.y + 5 },
        align: 'center',
        baseline: 'middle',
        rotation: -90,
      };
    case 'bottom':
      return {
        position: { x: clampX, y: body.y + body.height - 5 },
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
    readonly placement: Placement;
    readonly text: string;
    readonly color: string;
    readonly anchorColor: string;
    readonly font: string;
  },
): void {
  const { placement, color, anchorColor, font } = input;
  const at = (x: number, y: number): Point => symbolPinPosition(placement, { x, y });
  // Annotation text keeps its orientation and grows away from the glyph, so it stays readable
  // whatever the rotation.
  const push = (x: number, y: number): void => {
    const rotated = rotatePoint({ x, y }, placement.rotation);
    items.push({
      kind: 'text',
      position: { x: placement.x + rotated.x, y: placement.y + rotated.y },
      text: input.text,
      color,
      ...outwardLabel(rotated),
      font,
    });
  };

  // Power and ground mark their connection point with the stem itself; only free-standing
  // labels need a marker, drawn as a small cross.
  if (input.kind === 'label') {
    items.push({ kind: 'line', from: at(-3, 0), to: at(3, 0), color: anchorColor, width: 1.2 });
    items.push({ kind: 'line', from: at(0, -3), to: at(0, 3), color: anchorColor, width: 1.2 });
    // The name sits beside the cross, off the wire it names, so the wire never crosses the text.
    const layout = LABEL_TEXT_LAYOUTS[quarterTurns(placement.rotation)];
    items.push({
      kind: 'text',
      position: { x: placement.x + layout.offset.x, y: placement.y + layout.offset.y },
      text: input.text,
      color,
      align: layout.align,
      baseline: layout.baseline,
      font,
    });
    return;
  }

  if (input.kind === 'power') {
    items.push({ kind: 'line', from: at(0, 0), to: at(0, -10), color, width: 1.5 });
    items.push({ kind: 'line', from: at(-6, -10), to: at(6, -10), color, width: 1.5 });
    push(0, -13);
    return;
  }

  if (input.kind === 'ground') {
    items.push({ kind: 'line', from: at(0, 0), to: at(0, 6), color, width: 1.5 });
    for (const [offset, width] of [
      [6, 12],
      [9, 8],
      [12, 4],
    ] as const) {
      items.push({
        kind: 'line',
        from: at(-width / 2, offset),
        to: at(width / 2, offset),
        color,
        width: 1.5,
      });
    }
    push(0, 16);
  }
}

/** Rotation snapped to the 90° steps builtin glyphs support. */
function quarterTurns(rotation: number): 0 | 90 | 180 | 270 {
  const normalized = ((((rotation % 360) + 360) % 360) + 45) % 360;
  return (Math.floor(normalized / 90) * 90) as 0 | 90 | 180 | 270;
}

/** Distance between a label's name and the wire it names. */
const LABEL_TEXT_GAP = 1;
/** Clearance from the anchor cross, so the name starts just past its arms. */
const LABEL_TEXT_INSET = 4;

/**
 * Where a label's name goes for each rotation: right above the wire for horizontal labels and
 * just past its tip for vertical ones, clear of the anchor cross.
 */
const LABEL_TEXT_LAYOUTS: Readonly<
  Record<
    0 | 90 | 180 | 270,
    {
      readonly offset: Point;
      readonly align: ITextPlacement['align'];
      readonly baseline: ITextPlacement['baseline'];
    }
  >
> = {
  0: {
    offset: { x: LABEL_TEXT_INSET, y: -LABEL_TEXT_GAP },
    align: 'left',
    baseline: 'bottom',
  },
  90: { offset: { x: LABEL_TEXT_INSET, y: 0 }, align: 'left', baseline: 'middle' },
  180: {
    offset: { x: -LABEL_TEXT_INSET, y: -LABEL_TEXT_GAP },
    align: 'right',
    baseline: 'bottom',
  },
  270: { offset: { x: LABEL_TEXT_INSET, y: 0 }, align: 'left', baseline: 'middle' },
};

/** Horizontal text starting at `offset` (already rotated) and growing away from the origin. */
function outwardLabel(offset: Point): ITextPlacement {
  if (Math.abs(offset.x) >= Math.abs(offset.y)) {
    return { align: offset.x >= 0 ? 'left' : 'right', baseline: 'middle', rotation: 0 };
  }
  return { align: 'center', baseline: offset.y >= 0 ? 'top' : 'bottom', rotation: 0 };
}
