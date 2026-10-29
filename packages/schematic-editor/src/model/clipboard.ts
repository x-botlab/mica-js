import {
  SCHEMATIC_VERSION,
  SchematicError,
  hasDesignator,
  parseSchematic,
  symbolRole,
  type DiagnosticCode,
  type Point,
  type SchematicDocument,
  type SchematicJunction,
  type SchematicSymbol,
  type SchematicWire,
} from '@mica-js/core/schematic';
import { DEFAULT_DISPLAY_OPTIONS, type SchematicTarget } from '../types';
import type { DocumentStore } from './store';

/** Identifies a payload produced by this editor; anything else is a foreign clipboard. */
export const SCHEMATIC_CLIPBOARD_FORMAT = 'mica-schematic/selection';
/** Payload schema version; older payloads are rejected instead of migrated. */
export const SCHEMATIC_CLIPBOARD_VERSION = 1;
/** Custom MIME type written next to `text/plain`. */
export const SCHEMATIC_CLIPBOARD_MIME = 'application/x-mica-schematic+json';

/** Element budget and coordinate bound that keep a hostile payload from building a huge document. */
const MAX_CLIPBOARD_ELEMENTS = 10_000;
const MAX_CLIPBOARD_COORDINATE = 1_000_000;

/**
 * Copied schematic elements, ready to serialize.
 *
 * Element ids stay as they were copied: they only resolve junction → wire references, and every
 * pasted element gets a fresh id. Geometry lives in page coordinates, so pasting rebuilds it from
 * the payload bounds instead of storing an origin.
 */
export interface SchematicClipboard {
  readonly format: typeof SCHEMATIC_CLIPBOARD_FORMAT;
  readonly version: typeof SCHEMATIC_CLIPBOARD_VERSION;
  readonly symbols: readonly SchematicSymbol[];
  readonly wires: readonly SchematicWire[];
  readonly junctions: readonly SchematicJunction[];
}

export interface PasteOptions {
  /** Page coordinate the top-left corner of the copied content lands on. */
  readonly at?: Point;
  /** Translation used without `at`; defaults to one grid step (`DEFAULT_DISPLAY_OPTIONS.gridSize`). */
  readonly offset?: Point;
}

/**
 * Collects the selected elements into a payload. Reference targets copy their whole symbol and
 * vertex targets their whole wire; targets that no longer exist are skipped.
 *
 * Junctions come along only when every wire they join is copied, so a pasted selection never
 * starts with a dangling junction. Reading never edits the document or its history.
 */
export function createSchematicClipboard(
  document: SchematicDocument,
  targets: readonly SchematicTarget[],
): SchematicClipboard | undefined {
  const symbolIds = new Set<string>();
  const wireIds = new Set<string>();
  for (const target of targets) {
    switch (target.kind) {
      case 'symbol':
        symbolIds.add(target.id);
        break;
      case 'reference':
        symbolIds.add(target.symbolId);
        break;
      case 'wire':
        wireIds.add(target.id);
        break;
      case 'vertex':
        wireIds.add(target.wireId);
        break;
      default:
        break;
    }
  }

  const symbols = document.sheet.symbols.filter((symbol) => symbolIds.has(symbol.id));
  const wires = document.sheet.wires.filter((wire) => wireIds.has(wire.id));
  const copiedWireIds = new Set(wires.map((wire) => wire.id));
  const junctions = document.sheet.junctions.filter(
    (junction) => junction.wires.length >= 2 && junction.wires.every((id) => copiedWireIds.has(id)),
  );
  if (symbols.length === 0 && wires.length === 0 && junctions.length === 0) {
    return undefined;
  }
  return {
    format: SCHEMATIC_CLIPBOARD_FORMAT,
    version: SCHEMATIC_CLIPBOARD_VERSION,
    symbols,
    wires,
    junctions,
  };
}

export function serializeSchematicClipboard(clipboard: SchematicClipboard): string {
  return JSON.stringify(clipboard);
}

/**
 * Parses and normalizes a clipboard payload.
 *
 * @throws {SchematicError} when the text is not JSON, not a selection payload, uses another
 * version or exceeds the element / coordinate budget; the document is never touched.
 */
export function parseSchematicClipboard(text: string): SchematicClipboard {
  const value = parseClipboardJson(text);
  if (!isRecord(value)) {
    fail('schema/invalid-type', 'Clipboard payload must be a JSON object.');
  }
  if (value['format'] !== SCHEMATIC_CLIPBOARD_FORMAT) {
    fail('schema/invalid-value', 'Clipboard payload is not a schematic selection.');
  }
  if (value['version'] !== SCHEMATIC_CLIPBOARD_VERSION) {
    fail(
      'schema/unsupported-version',
      `Unsupported clipboard version; expected ${SCHEMATIC_CLIPBOARD_VERSION}.`,
    );
  }
  const symbols = readElementArray(value, 'symbols');
  const wires = readElementArray(value, 'wires');
  const junctions = readElementArray(value, 'junctions');
  checkLimits(symbols, wires, junctions);
  // Re-validation through the `.sch` contract normalizes the payload and rejects unknown fields.
  const parsed = parseSchematic({
    version: SCHEMATIC_VERSION,
    sheet: { symbols, wires, junctions },
  });
  return {
    format: SCHEMATIC_CLIPBOARD_FORMAT,
    version: SCHEMATIC_CLIPBOARD_VERSION,
    symbols: parsed.sheet.symbols,
    wires: parsed.sheet.wires,
    junctions: parsed.sheet.junctions,
  };
}

/**
 * Inserts a payload as one undoable edit and returns the pasted symbols and wires.
 *
 * Every new element is merged into the working document before the next id is generated, so a
 * batch never reuses an id. Components get fresh designators and junctions follow their new wires.
 */
export function pasteClipboard(
  store: DocumentStore,
  clipboard: SchematicClipboard,
  options: PasteOptions = {},
): readonly SchematicTarget[] {
  // Junctions only attach to wires; without copied wires there is nothing to insert or to record.
  if (clipboard.symbols.length === 0 && clipboard.wires.length === 0) {
    return [];
  }

  const document = store.document;
  const delta = pasteDelta(clipboard, options);
  const symbols = [...document.sheet.symbols];
  const wires = [...document.sheet.wires];
  const junctions = [...document.sheet.junctions];
  const targets: SchematicTarget[] = [];
  let working: SchematicDocument = document;
  const rebuild = (): void => {
    working = { ...document, sheet: { ...document.sheet, symbols, wires, junctions } };
  };

  for (const source of clipboard.symbols) {
    const id = store.createId('symbol', working);
    symbols.push(translateSymbol(store, source, id, delta, working));
    rebuild();
    targets.push({ kind: 'symbol', id });
  }

  const wireIds = new Map<string, string>();
  for (const source of clipboard.wires) {
    const id = store.createId('wire', working);
    wireIds.set(source.id, id);
    wires.push({
      id,
      points: source.points.map((point) => ({ x: point.x + delta.x, y: point.y + delta.y })),
    });
    rebuild();
    targets.push({ kind: 'wire', id });
  }

  for (const source of clipboard.junctions) {
    const mapped = source.wires
      .map((wireId) => wireIds.get(wireId))
      .filter((wireId): wireId is string => wireId !== undefined);
    if (mapped.length < 2) {
      continue;
    }
    const id = store.createId('junction', working);
    junctions.push({ id, x: source.x + delta.x, y: source.y + delta.y, wires: mapped });
    rebuild();
  }

  // Reconciling would rewrite the geometry the user copied; the payload is already consistent.
  store.mutate(() => store.editor.replace(working), { reconcile: false });
  return targets;
}

function translateSymbol(
  store: DocumentStore,
  source: SchematicSymbol,
  id: string,
  delta: Point,
  working: SchematicDocument,
): SchematicSymbol {
  const role = symbolRole(source.device);
  return {
    id,
    device: source.device,
    x: source.x + delta.x,
    y: source.y + delta.y,
    rotation: source.rotation,
    ...(source.properties === undefined ? {} : { properties: source.properties }),
    // Pasted components are new instances, so they must not reuse the copied designator.
    ...(hasDesignator(role) ? { designator: store.createDesignator(source.device, working) } : {}),
    ...(source.net === undefined ? {} : { net: source.net }),
    ...(source.reference === undefined ? {} : { reference: source.reference }),
  };
}

function pasteDelta(clipboard: SchematicClipboard, options: PasteOptions): Point {
  if (options.at !== undefined) {
    const topLeft = clipboardTopLeft(clipboard);
    return { x: options.at.x - topLeft.x, y: options.at.y - topLeft.y };
  }
  return (
    options.offset ?? {
      x: DEFAULT_DISPLAY_OPTIONS.gridSize,
      y: DEFAULT_DISPLAY_OPTIONS.gridSize,
    }
  );
}

function clipboardTopLeft(clipboard: SchematicClipboard): Point {
  let x = Number.POSITIVE_INFINITY;
  let y = Number.POSITIVE_INFINITY;
  const visit = (point: Point): void => {
    x = Math.min(x, point.x);
    y = Math.min(y, point.y);
  };
  for (const symbol of clipboard.symbols) {
    visit(symbol);
  }
  for (const wire of clipboard.wires) {
    for (const point of wire.points) {
      visit(point);
    }
  }
  for (const junction of clipboard.junctions) {
    visit(junction);
  }
  return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 };
}

function parseClipboardJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail('json/invalid', 'Clipboard payload is not valid JSON.');
  }
}

function readElementArray(value: Record<string, unknown>, field: string): readonly unknown[] {
  const items = value[field];
  if (!Array.isArray(items)) {
    fail('schema/invalid-type', `Field "${field}" must be an array.`);
  }
  return items;
}

function checkLimits(
  symbols: readonly unknown[],
  wires: readonly unknown[],
  junctions: readonly unknown[],
): void {
  if (symbols.length + wires.length + junctions.length > MAX_CLIPBOARD_ELEMENTS) {
    fail('schema/invalid-value', `Clipboard selection exceeds ${MAX_CLIPBOARD_ELEMENTS} elements.`);
  }
  for (const symbol of symbols) {
    checkCoordinates(symbol, ['x', 'y']);
  }
  for (const wire of wires) {
    if (!isRecord(wire)) {
      continue;
    }
    const points = wire['points'];
    if (!Array.isArray(points)) {
      continue;
    }
    for (const point of points) {
      checkCoordinates(point, ['x', 'y']);
    }
  }
  for (const junction of junctions) {
    checkCoordinates(junction, ['x', 'y']);
  }
}

function checkCoordinates(value: unknown, fields: readonly string[]): void {
  if (!isRecord(value)) {
    return;
  }
  for (const field of fields) {
    const coordinate = value[field];
    if (
      typeof coordinate === 'number' &&
      (!Number.isFinite(coordinate) || Math.abs(coordinate) > MAX_CLIPBOARD_COORDINATE)
    ) {
      fail(
        'schema/invalid-value',
        `Coordinate "${field}" is outside ±${MAX_CLIPBOARD_COORDINATE}.`,
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: DiagnosticCode, message: string): never {
  throw new SchematicError([{ severity: 'error', code, message }]);
}
