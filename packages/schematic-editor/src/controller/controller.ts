import {
  SchematicEditor,
  SchematicError,
  defaultElementIdFactory,
  createDesignatorFactory,
  deriveSchematicTopology,
  designatorOf,
  hasDesignator,
  hitTestSchematic,
  mergeWiresAtJunction,
  namesNet,
  netNameOf,
  parseDeviceReference,
  pointOnPolyline,
  previewSymbolDrag,
  referenceAnchor,
  rotatePoint,
  splitWireAt,
  symbolPinPosition,
  symbolRole,
  type DeviceSymbolProvider,
  type DesignatorFactory,
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
} from '@mica-js/core/schematic';
import { buildInspector } from './inspector';
import { pruneSelection } from './selection';
import {
  DEFAULT_DISPLAY_OPTIONS,
  type DisplayOptions,
  type EditorRenderState,
  type EditorSelection,
  type EditorState,
  type EditorTool,
  type Inspector,
} from './types';
import { ViewOverlay } from './view';

export interface SchematicEditorControllerOptions {
  readonly document: SchematicDocument;
  readonly view?: SchematicViewDocument;
  readonly devices?: DeviceSymbolProvider;
  readonly tolerance?: number;
  readonly historyLimit?: number;
  readonly display?: Partial<DisplayOptions>;
  readonly createId?: ElementIdFactory;
  /** Designator policy; defaults to the device's `designatorPrefix` (`U` when it declares none). */
  readonly createDesignator?: DesignatorFactory;
}

const MAX_MERGE_PASSES = 64;

/**
 * Editing state without any DOM dependency: selection, tool, undo history and the derived
 * data the UI needs. Every mutation flows through `applySchematicCommand`.
 */
export class SchematicEditorController {
  #editor: SchematicEditor;
  #overlay: ViewOverlay;
  #selection: readonly EditorSelection[] = [];
  #tool: EditorTool = 'select';
  #display: DisplayOptions;
  #lastError: SchematicError | undefined;
  #devices: DeviceSymbolProvider | undefined;
  #tolerance: number | undefined;
  #createId: ElementIdFactory;
  #createDesignator: DesignatorFactory;
  #placingDevice: string | undefined;
  #listeners = new Set<(state: EditorState) => void>();
  #topology:
    { readonly document: SchematicDocument; readonly value: SchematicTopology } | undefined;
  #stateCache: EditorState | undefined;
  #renderCache: EditorRenderState | undefined;

  constructor(options: SchematicEditorControllerOptions) {
    this.#editor = new SchematicEditor(options.document, {
      ...deriveOptions(options.devices, options.tolerance),
      ...(options.historyLimit === undefined ? {} : { historyLimit: options.historyLimit }),
    });
    this.#overlay = new ViewOverlay(options.view);
    this.#devices = options.devices;
    this.#tolerance = options.tolerance;
    this.#createId = options.createId ?? defaultElementIdFactory;
    this.#createDesignator = options.createDesignator ?? createDesignatorFactory(options.devices);
    this.#display = { ...DEFAULT_DISPLAY_OPTIONS, ...options.display };
  }

  /**
   * Full editor state. Cached until the next change so hosts can compare references, and so a
   * repaint does not rebuild the inspector payload.
   */
  get state(): EditorState {
    if (this.#stateCache !== undefined) {
      return this.#stateCache;
    }
    const render = this.renderState;
    this.#stateCache = {
      ...render,
      placingDevice: this.#placingDevice,
      canUndo: this.#editor.canUndo,
      canRedo: this.#editor.canRedo,
      inspector: this.inspect(),
      lastError: this.#lastError,
    };
    return this.#stateCache;
  }

  /** Everything the canvas draws from; never builds the inspector. */
  get renderState(): EditorRenderState {
    if (this.#renderCache !== undefined) {
      return this.#renderCache;
    }
    this.#renderCache = {
      document: this.#editor.document,
      view: this.#overlay.renderView,
      selection: this.#selection,
      tool: this.#tool,
      display: this.#display,
    };
    return this.#renderCache;
  }

  /**
   * The view used for rendering: placement overrides are dropped for symbols edited here, so a
   * rotation or move is visible instead of being masked by the read-only layout.
   */
  get renderView(): SchematicViewDocument | undefined {
    return this.#overlay.renderView;
  }

  get document(): SchematicDocument {
    return this.#editor.document;
  }

  get view(): SchematicViewDocument | undefined {
    return this.#overlay.view;
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

  /** Device armed for placement by the host's device list; `undefined` when idle. */
  get placingDevice(): string | undefined {
    return this.#placingDevice;
  }

  /**
   * Arms placement of `device`: the next canvas click inserts it and disarms again. Hosts drive
   * this from their own device list — the editor ships no library browser.
   *
   * @throws {SchematicError} when the device reference is malformed.
   */
  placeDevice(device: string): void {
    if (parseDeviceReference(device) === undefined) {
      this.#reject(
        new SchematicError([
          {
            severity: 'error',
            code: 'device/invalid-reference',
            message: `Invalid device reference ${JSON.stringify(device)}.`,
          },
        ]),
      );
    }
    this.#placingDevice = device;
    this.#tool = 'select';
    this.#emit();
  }

  cancelPlacement(): void {
    if (this.#placingDevice === undefined) {
      return;
    }
    this.#placingDevice = undefined;
    this.#emit();
  }

  /** Reference designator the next placed component gets, per the host's policy. */
  nextDesignator(device: string): string {
    return this.#createDesignator(device, this.#editor.document);
  }

  setTool(tool: EditorTool): void {
    if (this.#tool === tool && this.#placingDevice === undefined) {
      return;
    }
    this.#tool = tool;
    this.#placingDevice = undefined;
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
    this.#overlay.setView(view);
    this.#emit();
  }

  /** Swaps the edited document and clears history, selection and errors. */
  reset(document: SchematicDocument, options: { view?: SchematicViewDocument } = {}): void {
    this.#editor = new SchematicEditor(document, deriveOptions(this.#devices, this.#tolerance));
    if (options.view === undefined) {
      this.#overlay.clearMarkers();
    } else {
      this.#overlay.setView(options.view);
    }
    this.#selection = [];
    this.#lastError = undefined;
    this.#topology = undefined;
    this.#placingDevice = undefined;
    this.#emit();
  }

  /** @throws {SchematicError} leaving document, history and selection untouched. */
  dispatch(command: SchematicCommand): void {
    this.#mutate(() => {
      this.#editor.dispatch(command);
    });
  }

  /**
   * Swaps the whole document as one undoable edit, so a host can reload a file without losing
   * the history it already has.
   *
   * @throws {SchematicError} when the document is invalid; the state stays untouched.
   */
  replace(document: SchematicDocument): void {
    this.#mutate(() => {
      this.#editor.replace(document);
    });
  }

  /** Runs several edits as one history step; a failure rolls all of them back. */
  transaction(run: () => void): void {
    this.#mutate(run);
  }

  undo(): void {
    if (!this.#editor.canUndo) {
      return;
    }
    this.#editor.undo();
    this.#overlay.undo();
    this.#afterHistoryChange();
  }

  redo(): void {
    if (!this.#editor.canRedo) {
      return;
    }
    this.#editor.redo();
    this.#overlay.redo();
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
              this.#repositionSymbol(symbol, {
                ...symbol,
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
          case 'reference':
            this.moveReferenceBy(item.symbolId, dx, dy);
            break;
          case 'junction':
            // Junctions are derived from wire geometry; moving one would break orthogonality.
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
        this.#repositionSymbol(symbol, {
          ...symbol,
          rotation: normalizeRotation(symbol.rotation + degrees),
        });
      }
    });
  }

  /**
   * Replaces a symbol's placement and drags everything anchored to its pins: wire ends keep
   * orthogonal routing, junctions and attached builtin anchors follow.
   */
  #repositionSymbol(symbol: SchematicSymbol, next: SchematicSymbol): void {
    const document = this.#editor.document;
    const preview = previewSymbolDrag(document, this.#devices, symbol.id, next);
    if (preview === undefined) {
      return;
    }
    this.#overlay.markEdited(symbol.id);
    const symbols = document.sheet.symbols.map((item) => {
      if (item.id === symbol.id) {
        return next;
      }
      const target = preview.symbols.get(item.id);
      return target === undefined ? item : { ...item, x: target.x, y: target.y };
    });
    const wires = document.sheet.wires.map((wire) => {
      const points = preview.wires.get(wire.id);
      return points === undefined ? wire : { ...wire, points };
    });
    const junctions = document.sheet.junctions.map((junction) => {
      const target = preview.junctions.get(junction.id);
      return target === undefined ? junction : { ...junction, x: target.x, y: target.y };
    });

    this.#editor.replace({
      ...document,
      sheet: { ...document.sheet, symbols, wires, junctions },
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
   * Appends a wire. Endpoints that land inside another wire split it and create a junction, and
   * endpoints that land on an existing junction join it, so the new wire is electrically connected.
   */
  addWire(points: readonly Point[]): void {
    if (points.length < 2) {
      this.#reject(
        new SchematicError([
          { severity: 'error', code: 'wire/invalid-points', message: 'A wire needs two points.' },
        ]),
      );
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
            continue;
          }
          this.#joinJunction(id, point);
        }
      },
      { reconcile: false },
    );
  }

  /** Adds a wire that ends on an existing junction to that junction's participants. */
  #joinJunction(wireId: string, point: Point): void {
    const junction = this.#editor.document.sheet.junctions.find(
      (item) => item.x === point.x && item.y === point.y,
    );
    if (junction === undefined || junction.wires.includes(wireId)) {
      return;
    }
    this.#editor.dispatch({
      type: 'update-junction',
      id: junction.id,
      wires: [...junction.wires, wireId],
    });
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

  /**
   * Slides one wire segment by `delta` along its normal. The whole run of segments parallel to it
   * moves along, so no neighbour is left diagonal; where that run ends at a pin, an anchor, a
   * junction or another wire, the vertex stays put and the wire gains a dogleg. Junctions left
   * behind on the old geometry let go of this wire instead of failing the edit.
   */
  moveWireSegment(wireId: string, segment: number, delta: Point): void {
    const wire = this.#findWire(wireId);
    const points = wire === undefined ? undefined : this.#segmentDragPoints(wire, segment, delta);
    if (wire === undefined || points === undefined) {
      return;
    }
    this.#mutate(() => {
      this.#releaseJunctions(wire.id, points);
      this.#editor.dispatch({ type: 'set-wire-points', id: wire.id, points });
    });
  }

  /** Wire points a segment drag would produce; the renderer previews them before the commit. */
  previewWireSegment(wireId: string, segment: number, delta: Point): readonly Point[] | undefined {
    const wire = this.#findWire(wireId);
    return wire === undefined ? undefined : this.#segmentDragPoints(wire, segment, delta);
  }

  #segmentDragPoints(
    wire: SchematicWire,
    segment: number,
    delta: Point,
  ): readonly Point[] | undefined {
    const points = wire.points;
    const start = points[segment];
    const end = points[segment + 1];
    if (start === undefined || end === undefined || (delta.x === 0 && delta.y === 0)) {
      return undefined;
    }
    if (start.x === end.x && start.y === end.y) {
      return undefined;
    }
    // Dragging a horizontal segment moves its run vertically; the run only breaks at a segment
    // pointing the other way (it just stretches) or at a connected vertex (it needs a dogleg).
    const horizontal = start.y === end.y;
    const isParallel = (from: Point, to: Point): boolean =>
      horizontal ? from.y === to.y : from.x === to.x;

    let first = segment;
    while (first > 0) {
      const previous = points[first - 1];
      const current = points[first];
      if (
        previous === undefined ||
        current === undefined ||
        !isParallel(previous, current) ||
        this.#isConnectedVertex(current, wire.id)
      ) {
        break;
      }
      first -= 1;
    }
    let last = segment + 1;
    while (last < points.length - 1) {
      const current = points[last];
      const next = points[last + 1];
      if (
        current === undefined ||
        next === undefined ||
        !isParallel(current, next) ||
        this.#isConnectedVertex(current, wire.id)
      ) {
        break;
      }
      last += 1;
    }

    const firstPoint = points[first];
    const lastPoint = points[last];
    if (firstPoint === undefined || lastPoint === undefined) {
      return undefined;
    }
    const shift = (point: Point): Point => ({ x: point.x + delta.x, y: point.y + delta.y });
    const moved: Point[] = [];
    for (let index = first; index <= last; index += 1) {
      const point = points[index];
      if (point !== undefined) {
        moved.push(shift(point));
      }
    }
    if (this.#isConnectedVertex(firstPoint, wire.id)) {
      moved.unshift(firstPoint);
    }
    if (this.#isConnectedVertex(lastPoint, wire.id)) {
      moved.push(lastPoint);
    }
    return [...points.slice(0, first), ...moved, ...points.slice(last + 1)];
  }

  /** Drops this wire from junctions that no longer lie on its new geometry. */
  #releaseJunctions(wireId: string, points: readonly Point[]): void {
    for (const junction of [...this.#editor.document.sheet.junctions]) {
      if (!junction.wires.includes(wireId)) {
        continue;
      }
      if (pointOnPolyline(points, { x: junction.x, y: junction.y })) {
        continue;
      }
      const remaining = junction.wires.filter((id) => id !== wireId);
      if (remaining.length < 2) {
        this.#editor.dispatch({ type: 'remove-junction', id: junction.id });
      } else {
        this.#editor.dispatch({ type: 'update-junction', id: junction.id, wires: remaining });
      }
    }
  }

  /** True when something other than this wire is attached at `point`. */
  #isConnectedVertex(point: Point, wireId: string): boolean {
    const document = this.#editor.document;
    const same = (candidate: Point): boolean => candidate.x === point.x && candidate.y === point.y;
    for (const junction of document.sheet.junctions) {
      if (same(junction)) {
        return true;
      }
    }
    for (const wire of document.sheet.wires) {
      if (wire.id !== wireId && wire.points.some(same)) {
        return true;
      }
    }
    for (const symbol of document.sheet.symbols) {
      const role = symbolRole(symbol.device);
      if (role !== 'component') {
        if (same({ x: symbol.x, y: symbol.y })) {
          return true;
        }
        continue;
      }
      const reference = parseDeviceReference(symbol.device);
      const definition =
        reference === undefined ? undefined : this.#devices?.getDeviceSymbol(reference);
      if (definition === undefined) {
        continue;
      }
      for (const anchor of Object.values(definition.pins)) {
        if (same(symbolPinPosition(symbol, anchor))) {
          return true;
        }
      }
    }
    return false;
  }

  /** Moves a reference designator by a world-space delta; the offset is stored locally. */
  moveReferenceBy(symbolId: string, dx: number, dy: number): void {
    const symbol = this.#findSymbol(symbolId);
    if (symbol === undefined || (dx === 0 && dy === 0)) {
      return;
    }
    this.#mutate(() => {
      const anchor = referenceAnchor(this.#outlineOf(symbol), symbol.reference);
      // Offsets live in symbol-local space, so undo the rotation before moving.
      const local = rotatePoint({ x: dx, y: dy }, -symbol.rotation);
      this.#editor.dispatch({
        type: 'update-symbol',
        id: symbol.id,
        reference: { x: anchor.x + local.x, y: anchor.y + local.y },
      });
    });
  }

  setSymbolProperty(symbolId: string, key: string, value: PropertyValue): void {
    this.#mutate(() => {
      this.#editor.dispatch({ type: 'set-symbol-property', id: symbolId, key, value });
    });
  }

  /**
   * Sets a component's reference designator. The symbol id stays untouched, so selections and
   * `.view` layout keys keep pointing at the same element.
   *
   * @throws {SchematicError} when the new designator is empty, taken or the symbol is unknown.
   */
  renameDesignator(symbolId: string, nextDesignator: string): void {
    const trimmed = nextDesignator.trim();
    const symbol = this.#requireSymbol(symbolId);
    const role = symbolRole(symbol.device);
    if (!hasDesignator(role)) {
      this.#reject(
        new SchematicError([
          {
            severity: 'error',
            code: 'symbol/unsupported-field',
            message: `Symbols of role "${role}" carry no reference designator.`,
            entity: { kind: 'symbol', id: symbolId },
          },
        ]),
      );
    }
    if (trimmed.length === 0) {
      this.#reject(
        new SchematicError([
          {
            severity: 'error',
            code: 'schema/invalid-value',
            message: 'Reference designator must not be empty.',
          },
        ]),
      );
    }
    if (trimmed === designatorOf(symbol)) {
      return;
    }
    const duplicate = this.#editor.document.sheet.symbols.find(
      (candidate) => candidate.id !== symbolId && designatorOf(candidate) === trimmed,
    );
    if (duplicate !== undefined) {
      this.#reject(
        new SchematicError([
          {
            severity: 'error',
            code: 'symbol/designator-duplicate',
            message: `Reference designator ${JSON.stringify(trimmed)} is already used.`,
            entity: { kind: 'symbol', id: duplicate.id },
          },
        ]),
      );
    }
    this.#mutate(() => {
      this.#editor.dispatch({ type: 'update-symbol', id: symbolId, designator: trimmed });
    });
  }

  /**
   * Sets the net name of a label / power / ground symbol. Same-named ports are one net, so
   * duplicates are allowed.
   *
   * @throws {SchematicError} when the name is empty or the symbol names no net.
   */
  renameNet(symbolId: string, nextNet: string): void {
    const trimmed = nextNet.trim();
    const symbol = this.#requireSymbol(symbolId);
    const role = symbolRole(symbol.device);
    if (!namesNet(role)) {
      this.#reject(
        new SchematicError([
          {
            severity: 'error',
            code: 'symbol/unsupported-field',
            message: `Symbols of role "${role}" name no net.`,
            entity: { kind: 'symbol', id: symbolId },
          },
        ]),
      );
    }
    if (trimmed.length === 0) {
      this.#reject(
        new SchematicError([
          {
            severity: 'error',
            code: 'schema/invalid-value',
            message: 'Net name must not be empty.',
          },
        ]),
      );
    }
    if (trimmed === netNameOf(symbol)) {
      return;
    }
    this.#mutate(() => {
      this.#editor.dispatch({ type: 'update-symbol', id: symbolId, net: trimmed });
    });
  }

  #requireSymbol(symbolId: string): SchematicSymbol {
    const symbol = this.#editor.document.sheet.symbols.find(
      (candidate) => candidate.id === symbolId,
    );
    if (symbol === undefined) {
      this.#reject(
        new SchematicError([
          {
            severity: 'error',
            code: 'edit/unknown-entity',
            message: `Unknown symbol "${symbolId}".`,
            entity: { kind: 'symbol', id: symbolId },
          },
        ]),
      );
    }
    return symbol;
  }

  /** Records a rejected edit in `state.lastError`, notifies listeners, then rethrows. */
  #reject(error: SchematicError): never {
    this.#lastError = error;
    this.#emit();
    throw error;
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
    this.#stateCache = undefined;
    this.#renderCache = undefined;
    const state = this.state;
    for (const listener of [...this.#listeners]) {
      listener(state);
    }
  }

  #mutate(run: () => void, options: { reconcile?: boolean } = {}): void {
    const document = this.#editor.document;
    const markers = this.#overlay.snapshot();
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
    if (this.#editor.document !== document) {
      // One document history step, so the marker set keeps one snapshot per step.
      this.#overlay.commit(markers);
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

  /** Device outline in symbol-local coordinates, used as the reference-designator default. */
  #outlineOf(
    symbol: SchematicSymbol,
  ): { x: number; y: number; width: number; height: number } | undefined {
    const reference = parseDeviceReference(symbol.device);
    return reference === undefined ? undefined : this.#devices?.getDeviceSymbol(reference)?.bounds;
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

  #hitTestWire(point: Point, excludeWireId: string): { wireId: string } | undefined {
    // Scanned directly instead of through `hitTest`: the point sits on both the new wire and the
    // host, and which one a plain hit reports depends on element order.
    for (const wire of this.#editor.document.sheet.wires) {
      if (wire.id === excludeWireId || !pointOnPolyline(wire.points, point, this.#tolerance ?? 0)) {
        continue;
      }
      const [first, last] = [wire.points[0], wire.points[wire.points.length - 1]];
      if (first === undefined || last === undefined) {
        continue;
      }
      if (samePoint(first, point) || samePoint(last, point)) {
        continue;
      }
      return { wireId: wire.id };
    }
    return undefined;
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
