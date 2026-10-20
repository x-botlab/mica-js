import {
  SchematicEditor,
  SchematicError,
  defaultElementIdFactory,
  deriveSchematicTopology,
  hitTestSchematic,
  mergeWiresAtJunction,
  splitWireAt,
  type DeviceSymbolProvider,
  type Diagnostic,
  type ElementIdFactory,
  type HitTestOptions,
  type Point,
  type PropertyValue,
  type SchematicCommand,
  type SchematicDocument,
  type SchematicHit,
  type SchematicSymbol,
  type SchematicTopology,
  type SchematicViewDocument,
  type SchematicWire,
} from '@mica/core/schematic';
import { buildInspector } from './inspector';
import { pruneSelection } from './selection';
import {
  DEFAULT_DISPLAY_OPTIONS,
  type DisplayOptions,
  type EditorSelection,
  type EditorState,
  type EditorTool,
  type Inspector,
} from './types';

export interface SchematicEditorControllerOptions {
  readonly document: SchematicDocument;
  readonly view?: SchematicViewDocument;
  readonly devices?: DeviceSymbolProvider;
  readonly tolerance?: number;
  readonly historyLimit?: number;
  readonly display?: Partial<DisplayOptions>;
  readonly createId?: ElementIdFactory;
}

const MAX_MERGE_PASSES = 64;

/**
 * Editing state without any DOM dependency: selection, tool, undo history and the derived
 * data the UI needs. Every mutation flows through `applySchematicCommand`.
 */
export class SchematicEditorController {
  #editor: SchematicEditor;
  #view: SchematicViewDocument | undefined;
  #selection: readonly EditorSelection[] = [];
  #tool: EditorTool = 'select';
  #display: DisplayOptions;
  #lastError: SchematicError | undefined;
  #devices: DeviceSymbolProvider | undefined;
  #tolerance: number | undefined;
  #createId: ElementIdFactory;
  #listeners = new Set<(state: EditorState) => void>();
  #topology:
    { readonly document: SchematicDocument; readonly value: SchematicTopology } | undefined;

  constructor(options: SchematicEditorControllerOptions) {
    this.#editor = new SchematicEditor(options.document, {
      ...deriveOptions(options.devices, options.tolerance),
      ...(options.historyLimit === undefined ? {} : { historyLimit: options.historyLimit }),
    });
    this.#view = options.view;
    this.#devices = options.devices;
    this.#tolerance = options.tolerance;
    this.#createId = options.createId ?? defaultElementIdFactory;
    this.#display = { ...DEFAULT_DISPLAY_OPTIONS, ...options.display };
  }

  get state(): EditorState {
    return {
      document: this.#editor.document,
      view: this.#view,
      selection: this.#selection,
      tool: this.#tool,
      display: this.#display,
      canUndo: this.#editor.canUndo,
      canRedo: this.#editor.canRedo,
      inspector: this.inspect(),
      lastError: this.#lastError,
    };
  }

  get document(): SchematicDocument {
    return this.#editor.document;
  }

  get view(): SchematicViewDocument | undefined {
    return this.#view;
  }

  get selection(): readonly EditorSelection[] {
    return this.#selection;
  }

  get tool(): EditorTool {
    return this.#tool;
  }

  get display(): DisplayOptions {
    return this.#display;
  }

  get canUndo(): boolean {
    return this.#editor.canUndo;
  }

  get canRedo(): boolean {
    return this.#editor.canRedo;
  }

  setTool(tool: EditorTool): void {
    if (this.#tool === tool) {
      return;
    }
    this.#tool = tool;
    this.#emit();
  }

  setSelection(selection: readonly EditorSelection[]): void {
    this.#selection = selection;
    this.#pruneSelection();
    this.#emit();
  }

  setDisplayOptions(patch: Partial<DisplayOptions>): void {
    this.#display = { ...this.#display, ...patch };
    this.#emit();
  }

  /** Replaces the read-only view document; it never takes part in editing or history. */
  setView(view: SchematicViewDocument | undefined): void {
    this.#view = view;
    this.#emit();
  }

  /** Swaps the edited document and clears history, selection and errors. */
  reset(document: SchematicDocument, options: { view?: SchematicViewDocument } = {}): void {
    this.#editor = new SchematicEditor(document, deriveOptions(this.#devices, this.#tolerance));
    this.#view = options.view ?? this.#view;
    this.#selection = [];
    this.#lastError = undefined;
    this.#topology = undefined;
    this.#emit();
  }

  /** @throws {SchematicError} leaving document, history and selection untouched. */
  dispatch(command: SchematicCommand): void {
    this.#mutate(() => {
      this.#editor.dispatch(command);
    });
  }

  undo(): void {
    this.#editor.undo();
    this.#afterHistoryChange();
  }

  redo(): void {
    this.#editor.redo();
    this.#afterHistoryChange();
  }

  moveSelectionBy(dx: number, dy: number): void {
    if (this.#selection.length === 0 || (dx === 0 && dy === 0)) {
      return;
    }
    this.#mutate(() => {
      for (const item of this.#selection) {
        switch (item.kind) {
          case 'symbol': {
            const symbol = this.#findSymbol(item.id);
            if (symbol !== undefined) {
              this.#editor.dispatch({
                type: 'update-symbol',
                id: symbol.id,
                x: symbol.x + dx,
                y: symbol.y + dy,
              });
            }
            break;
          }
          case 'vertex': {
            const wire = this.#findWire(item.wireId);
            const target = wire?.points[item.index];
            if (wire !== undefined && target !== undefined) {
              this.#editor.dispatch({
                type: 'set-wire-points',
                id: wire.id,
                points: wire.points.map((point, index) =>
                  index === item.index ? { x: point.x + dx, y: point.y + dy } : point,
                ),
              });
            }
            break;
          }
          case 'junction':
            this.#moveJunction(item.id, dx, dy);
            break;
          default:
            break;
        }
      }
    });
  }

  rotateSelection(degrees: number): void {
    if (this.#selection.length === 0 || degrees === 0) {
      return;
    }
    this.#mutate(() => {
      for (const item of this.#selection) {
        if (item.kind !== 'symbol') {
          continue;
        }
        const symbol = this.#findSymbol(item.id);
        if (symbol === undefined) {
          continue;
        }
        this.#editor.dispatch({
          type: 'update-symbol',
          id: symbol.id,
          rotation: normalizeRotation(symbol.rotation + degrees),
        });
      }
    });
  }

  deleteSelection(): void {
    if (this.#selection.length === 0) {
      return;
    }
    this.#mutate(() => {
      for (const item of this.#selection) {
        switch (item.kind) {
          case 'symbol':
            this.#editor.dispatch({ type: 'remove-symbol', id: item.id });
            break;
          case 'wire':
            this.#removeWire(item.id);
            break;
          case 'junction':
            this.#editor.dispatch({ type: 'remove-junction', id: item.id });
            break;
          case 'vertex': {
            const wire = this.#findWire(item.wireId);
            if (wire === undefined) {
              break;
            }
            const points = wire.points.filter((_, index) => index !== item.index);
            if (points.length < 2) {
              this.#removeWire(wire.id);
            } else {
              this.#editor.dispatch({ type: 'set-wire-points', id: wire.id, points });
            }
            break;
          }
          default:
            break;
        }
      }
      this.#selection = [];
    });
  }

  /**
   * Appends a wire. Endpoints that land inside another wire split it and create a junction,
   * so the new wire is electrically connected.
   */
  addWire(points: readonly Point[]): void {
    if (points.length < 2) {
      throw new SchematicError([
        { severity: 'error', code: 'wire/invalid-points', message: 'A wire needs two points.' },
      ]);
    }
    this.#mutate(
      () => {
        const id = this.#createId('wire', this.#editor.document);
        this.#editor.dispatch({ type: 'add-wire', id, points });
        for (const point of [points[0], points[points.length - 1]]) {
          if (point === undefined) {
            continue;
          }
          const host = this.#hitTestWire(point, id);
          if (host !== undefined) {
            this.#splitInto(id, host.wireId, point);
          }
        }
      },
      { reconcile: false },
    );
  }

  /**
   * Splits `wireId` at `point` and creates a junction there.
   *
   * @throws {SchematicError} when the wire is unknown or `point` is not an interior point.
   */
  connectWireAt(wireId: string, point: Point, otherWireId?: string): string {
    let junctionId = '';
    this.#mutate(
      () => {
        junctionId = this.#splitInto(otherWireId, wireId, point, { strict: true });
      },
      { reconcile: false },
    );
    return junctionId;
  }

  setSymbolProperty(symbolId: string, key: string, value: PropertyValue): void {
    this.#mutate(() => {
      this.#editor.dispatch({ type: 'set-symbol-property', id: symbolId, key, value });
    });
  }

  removeSymbolProperty(symbolId: string, key: string): void {
    this.#mutate(() => {
      this.#editor.dispatch({ type: 'remove-symbol-property', id: symbolId, key });
    });
  }

  inspect(): Inspector {
    return buildInspector(this.#editor.document, this.#selection, {
      devices: this.#devices,
      topology: () => this.topology(),
    });
  }

  topology(): SchematicTopology {
    const document = this.#editor.document;
    if (this.#topology?.document !== document) {
      this.#topology = {
        document,
        value: deriveSchematicTopology(document, deriveOptions(this.#devices, this.#tolerance)),
      };
    }
    return this.#topology.value;
  }

  hitTest(point: Point, options: HitTestOptions = {}): SchematicHit | undefined {
    return hitTestSchematic(this.#editor.document, point, {
      ...deriveOptions(this.#devices, this.#tolerance),
      ...options,
    });
  }

  subscribe(listener: (state: EditorState) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #emit(): void {
    const state = this.state;
    for (const listener of [...this.#listeners]) {
      listener(state);
    }
  }

  #mutate(run: () => void, options: { reconcile?: boolean } = {}): void {
    try {
      this.#editor.transaction(() => {
        run();
        if (options.reconcile !== false) {
          this.#mergeDegenerateJunctions();
        }
      });
    } catch (error) {
      this.#lastError = toSchematicError(error);
      this.#emit();
      throw error;
    }
    this.#lastError = undefined;
    this.#pruneSelection();
    this.#emit();
  }

  #afterHistoryChange(): void {
    this.#lastError = undefined;
    this.#pruneSelection();
    this.#emit();
  }

  #findSymbol(id: string): SchematicSymbol | undefined {
    return this.#editor.document.sheet.symbols.find((symbol) => symbol.id === id);
  }

  #findWire(id: string): SchematicWire | undefined {
    return this.#editor.document.sheet.wires.find((wire) => wire.id === id);
  }

  /** Removes a wire while keeping its junctions for the merge pass to collapse. */
  #removeWire(wireId: string): void {
    const attached = this.#editor.document.sheet.junctions.filter((junction) =>
      junction.wires.includes(wireId),
    );
    for (const junction of attached) {
      const remaining = junction.wires.filter((id) => id !== wireId);
      if (remaining.length >= 2) {
        this.#editor.dispatch({ type: 'update-junction', id: junction.id, wires: remaining });
      } else {
        this.#editor.dispatch({ type: 'remove-junction', id: junction.id });
      }
    }
    this.#editor.dispatch({ type: 'remove-wire', id: wireId });
  }

  #moveJunction(id: string, dx: number, dy: number): void {
    const document = this.#editor.document;
    const junction = document.sheet.junctions.find((candidate) => candidate.id === id);
    if (junction === undefined) {
      return;
    }
    const from = { x: junction.x, y: junction.y };
    const to = { x: junction.x + dx, y: junction.y + dy };
    // Coincident wire points follow the junction; otherwise it would detach from its wires.
    const wires = document.sheet.wires.map((wire) =>
      junction.wires.includes(wire.id)
        ? {
            ...wire,
            points: wire.points.map((point) => (samePoint(point, from) ? { ...to } : point)),
          }
        : wire,
    );
    const junctions = document.sheet.junctions.map((candidate) =>
      candidate.id === id ? { ...candidate, x: to.x, y: to.y } : candidate,
    );
    this.#editor.replace({ ...document, sheet: { ...document.sheet, wires, junctions } });
  }

  #hitTestWire(point: Point, excludeWireId: string): { wireId: string } | undefined {
    const hit = this.hitTest(point, { includeSymbols: false });
    if (hit?.kind !== 'wire' || hit.id === excludeWireId) {
      return undefined;
    }
    const wire = this.#findWire(hit.id);
    if (wire === undefined) {
      return undefined;
    }
    const [first, last] = [wire.points[0], wire.points[wire.points.length - 1]];
    if (first === undefined || last === undefined) {
      return undefined;
    }
    if (samePoint(first, point) || samePoint(last, point)) {
      return undefined;
    }
    return { wireId: wire.id };
  }

  #splitInto(
    newWireId: string | undefined,
    hostWireId: string,
    point: Point,
    options: { strict?: boolean } = {},
  ): string {
    const document = this.#editor.document;
    if (!options.strict) {
      const wire = this.#findWire(hostWireId);
      const [first, last] = [wire?.points[0], wire?.points[wire.points.length - 1]];
      if (
        wire === undefined ||
        first === undefined ||
        last === undefined ||
        samePoint(first, point) ||
        samePoint(last, point)
      ) {
        return '';
      }
    }
    const split = splitWireAt(document, hostWireId, point, {
      ...deriveOptions(undefined, this.#tolerance),
      createId: this.#createId,
    });
    const junctionId = this.#createId('junction', split.document);
    const wires = [split.firstWireId, split.secondWireId];
    if (newWireId !== undefined && newWireId.length > 0 && !wires.includes(newWireId)) {
      wires.push(newWireId);
    }
    const junctions = [
      ...split.document.sheet.junctions,
      { id: junctionId, x: point.x, y: point.y, wires },
    ];
    this.#editor.replace({
      ...split.document,
      sheet: { ...split.document.sheet, junctions },
    });
    return junctionId;
  }

  /** A junction that only splices two collinear wires collapses back into a single wire. */
  #mergeDegenerateJunctions(): void {
    for (let pass = 0; pass < MAX_MERGE_PASSES; pass += 1) {
      const junctions = this.#editor.document.sheet.junctions;
      let merged = false;
      for (const junction of junctions) {
        const result = mergeWiresAtJunction(this.#editor.document, junction.id, {
          ...deriveOptions(undefined, this.#tolerance),
          createId: this.#createId,
        });
        if (result === undefined) {
          continue;
        }
        this.#editor.replace(result.document);
        merged = true;
        break;
      }
      if (!merged) {
        return;
      }
    }
  }

  #pruneSelection(): void {
    const kept = pruneSelection(this.#selection, this.#editor.document);
    if (kept !== this.#selection) {
      this.#selection = kept;
    }
  }
}

/** Builds provider options without `undefined` values (`exactOptionalPropertyTypes`). */
function deriveOptions(
  devices: DeviceSymbolProvider | undefined,
  tolerance: number | undefined,
): { devices?: DeviceSymbolProvider; tolerance?: number } {
  const options: { devices?: DeviceSymbolProvider; tolerance?: number } = {};
  if (devices !== undefined) {
    options.devices = devices;
  }
  if (tolerance !== undefined) {
    options.tolerance = tolerance;
  }
  return options;
}

function toSchematicError(error: unknown): SchematicError {
  if (error instanceof SchematicError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const diagnostics: Diagnostic[] = [{ severity: 'error', code: 'edit/invalid-command', message }];
  return new SchematicError(diagnostics);
}

function samePoint(left: Point, right: Point): boolean {
  return left.x === right.x && left.y === right.y;
}

function normalizeRotation(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}
