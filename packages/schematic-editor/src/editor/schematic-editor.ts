import {
  SchematicError,
  parseDeviceReference,
  type HitTestOptions,
  type Point,
  type SchematicCommand,
  type SchematicDocument,
  type SchematicHit,
  type SchematicTopology,
} from '@mica-js/core/schematic';
import {
  DocumentModel,
  type DocumentModelOptions,
  type DocumentUpdateOptions,
} from '../model/document-model';
import { resolveSchematicContent, type SchematicContent } from '../model/content';
import {
  parseSchematicClipboard,
  serializeSchematicClipboard,
  type PasteOptions,
  type SchematicClipboard,
} from '../model/clipboard';
import { buildInspector } from '../model/inspector';
import { pruneSelection, sameSelection } from '../model/selection';
import { toSchematicError } from '../model/store';
import { CanvasSchematicRenderer } from '../render/canvas-renderer';
import { buildSchematicScene } from '../render/scene';
import { resolveSchematicTheme, themeToCssVariables, type SchematicTheme } from '../render/theme';
import {
  clampViewport,
  pageToScreen,
  resolveViewportLimits,
  screenToPage,
  type ViewportLimits,
  type ViewportState,
} from '../render/viewport';
import {
  DEFAULT_DISPLAY_OPTIONS,
  type DisplayOptions,
  type EditorRenderState,
  type EditorSelection,
  type EditorState,
  type EditorTool,
} from '../types';
import { DisposableStore, Emitter, type Event } from '@mica-js/core/lifecycle';
import { createBrowserClipboardPort, type ClipboardPort } from './clipboard';
import { EditorInput } from './interactions/input';
import { toSceneHighlight } from './scene-input';
import { snapToGrid } from './snapping';
import { createShell, type EditorShell } from './shell';
import type { EditorSurface } from './surface';
import { EditorViewport } from './viewport-state';

/** Model construction options exposed by {@link SchematicEditorOptions} (`value` is separate). */
export type SchematicEditorModelOptions = Omit<DocumentModelOptions, 'value'>;

/** Paste options of the editor API: a caller-provided payload skips the system clipboard. */
export interface EditorPasteOptions extends PasteOptions {
  /** Serialized payload; when present the system clipboard is not read. */
  readonly text?: string;
}

/**
 * Options shared by {@link SchematicEditor} and {@link createSchematicEditor}.
 *
 * The editor displays one {@link DocumentModel} and leaves document content to it. Pass `model` to
 * hand in an existing one, or `value` (plus the model options below) to have the editor create and
 * own the model: `model` wins, then `value`, then an empty sheet.
 */
export interface SchematicEditorOptions extends SchematicEditorModelOptions {
  /** Caller-provided container; the editor only appends and removes its own root. */
  readonly container: HTMLElement;
  /** Model the editor draws and edits; when given, `value` and the model options are ignored. */
  readonly model?: DocumentModel;
  /** Initial content of the editor's own model: a `.sch` document or its JSON text. */
  readonly value?: SchematicContent;
  readonly theme?: Partial<SchematicTheme>;
  readonly display?: Partial<DisplayOptions>;
  /** Zoom range for wheel, fit and `zoomTo`; defaults to 0.25×–4×. */
  readonly zoomLimits?: Partial<ViewportLimits>;
  /** Disables the built-in interactions; the editor and model stay writable through their APIs. */
  readonly readOnly?: boolean;
  /** Renders the floating tool strip in the canvas corner; defaults to true. */
  readonly toolbar?: boolean;
  /** System clipboard bridge; defaults to the browser Clipboard API. */
  readonly clipboard?: ClipboardPort;
}

/**
 * Canvas surface over a {@link DocumentModel}: rendering, input handling, selection, viewport and
 * tool state. Construction is synchronous and only touches `options.container`.
 *
 * Document edits go through the model, so every path — a gesture, a host call or the model's own
 * methods — commits one undoable step, fires `onDidChangeContent` and `onDidChangeState` once and
 * can be undone.
 */
export class SchematicEditor implements EditorSurface {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;

  readonly #contentChanged = new Emitter<SchematicDocument>();
  readonly #stateChanged = new Emitter<EditorState>();
  readonly #selectionChanged = new Emitter<readonly EditorSelection[]>();
  readonly #toolChanged = new Emitter<EditorTool>();
  readonly #errorChanged = new Emitter<SchematicError | undefined>();
  readonly #viewportChanged = new Emitter<ViewportState>();

  /** Fires after every committed content change with the new document. */
  readonly onDidChangeContent: Event<SchematicDocument> = this.#contentChanged.event;
  /** Fires after every editor or document change with the new state. */
  readonly onDidChangeState: Event<EditorState> = this.#stateChanged.event;
  /** Fires when the selection changes. */
  readonly onDidChangeSelection: Event<readonly EditorSelection[]> = this.#selectionChanged.event;
  /** Fires when the active tool or the armed placement changes. */
  readonly onDidChangeTool: Event<EditorTool> = this.#toolChanged.event;
  /** Fires when the reported edit error changes; `undefined` once an edit succeeds. */
  readonly onDidChangeError: Event<SchematicError | undefined> = this.#errorChanged.event;
  /** Fires on wheel/pan/fit/`zoomTo`/`setViewport` and when auto fit re-runs. */
  readonly onDidChangeViewport: Event<ViewportState> = this.#viewportChanged.event;

  readonly #subscriptions = new DisposableStore();
  readonly #model: DocumentModel;
  readonly #ownsModel: boolean;
  readonly #container: HTMLElement;
  readonly #shell: EditorShell;
  readonly #viewport: EditorViewport;
  readonly #renderer: CanvasSchematicRenderer;
  readonly #input: EditorInput;
  readonly #readOnly: boolean;
  readonly #clipboardPort: ClipboardPort;
  #clipboard: SchematicClipboard | undefined;
  #theme: SchematicTheme;
  #display: DisplayOptions;
  #selection: readonly EditorSelection[] = [];
  #tool: EditorTool = 'select';
  #placingDevice: string | undefined;
  /** Last edit or placement error; the model reports document failures, the editor placement ones. */
  #error: SchematicError | undefined;
  #lastContent: SchematicDocument;
  #lastSelection: readonly EditorSelection[] = [];
  #lastTool: EditorTool = 'select';
  #lastPlacing: string | undefined;
  #reportedError: SchematicError | undefined;
  #lastViewport: ViewportState | undefined;
  #disposed = false;
  readonly #resizeObserver: ResizeObserver;

  constructor(options: SchematicEditorOptions) {
    this.#ownsModel = options.model === undefined;
    this.#model = options.model ?? createOwnedModel(options);
    this.#lastContent = this.#model.getValue();
    this.#container = options.container;
    this.#readOnly = options.readOnly ?? false;
    this.#clipboardPort = options.clipboard ?? createBrowserClipboardPort();
    this.#display = { ...DEFAULT_DISPLAY_OPTIONS, ...options.display };
    this.#theme = resolveSchematicTheme(options.theme);
    this.#error = this.#model.getLastError();

    this.#shell = createShell({
      document: options.container.ownerDocument,
      readOnly: this.#readOnly,
      toolbar: options.toolbar !== false,
      onToolClick: (tool) => {
        this.setTool(this.getTool() === tool ? 'select' : tool);
        this.root.focus();
      },
    });
    this.root = this.#shell.root;
    this.canvas = this.#shell.canvas;

    this.#viewport = new EditorViewport(resolveViewportLimits(options.zoomLimits));
    this.#renderer = new CanvasSchematicRenderer(this.canvas, { theme: this.#theme });
    this.#input = new EditorInput({
      editor: this,
      devices: this.#model.getDevices(),
      viewport: this.#viewport,
      root: this.root,
      canvas: this.canvas,
      readOnly: this.#readOnly,
      onChange: () => this.#render(),
      onFit: () => this.fitToContent(),
      run: (edit) => this.#run(edit),
    });
    this.#resizeObserver = new ResizeObserver(() => this.resize());

    this.#subscriptions.add(this.#model.onDidChangeContent(() => this.#onModelChanged()));
    this.#subscriptions.add(this.#model.onDidRejectEdit(() => this.#onModelChanged()));

    this.#applyTheme();
    this.#input.attach();
    this.#sync();

    this.#resizeObserver.observe(this.#shell.canvasHost);
    this.#container.append(this.root);
    this.resize();
  }

  /** Model the editor draws; the same reference for the lifetime of the editor. */
  getModel(): DocumentModel {
    return this.#model;
  }

  /** Current content; the same shape `DocumentModel.getValue()` returns. */
  getValue(): SchematicDocument {
    return this.#model.getValue();
  }

  getSelection(): readonly EditorSelection[] {
    return this.#selection;
  }

  /** Replaces the selection; targets the document does not contain are dropped. */
  setSelection(selection: readonly EditorSelection[]): void {
    if (this.#disposed) {
      return;
    }
    this.#selection = pruneSelection(selection, this.#model.getValue());
    this.#sync();
  }

  getTool(): EditorTool {
    return this.#tool;
  }

  /** Switches the active tool and disarms any pending device placement. */
  setTool(tool: EditorTool): void {
    if (this.#disposed) {
      return;
    }
    if (this.#tool === tool && this.#placingDevice === undefined) {
      return;
    }
    this.#tool = tool;
    this.#placingDevice = undefined;
    this.#sync();
  }

  getDisplay(): DisplayOptions {
    return this.#display;
  }

  setDisplayOptions(patch: Partial<DisplayOptions>): void {
    if (this.#disposed) {
      return;
    }
    this.#display = { ...this.#display, ...patch };
    this.#sync();
  }

  getCanUndo(): boolean {
    return this.#model.getCanUndo();
  }

  getCanRedo(): boolean {
    return this.#model.getCanRedo();
  }

  /** Device armed for placement by the host's device list; `undefined` when idle. */
  getPlacingDevice(): string | undefined {
    return this.#placingDevice;
  }

  /**
   * Arms placement of `device`: the next canvas click inserts it and disarms again.
   *
   * @throws {SchematicError} when the device reference is malformed.
   */
  placeDevice(device: string): void {
    if (this.#disposed || this.#readOnly) {
      return;
    }
    if (parseDeviceReference(device) === undefined) {
      const error = new SchematicError([
        {
          severity: 'error',
          code: 'device/invalid-reference',
          message: `Invalid device reference ${JSON.stringify(device)}.`,
        },
      ]);
      this.#error = error;
      this.#sync();
      throw error;
    }
    this.#placingDevice = device;
    this.#tool = 'select';
    this.#sync();
    this.root.focus();
  }

  /** Disarms a pending placement without touching the document. */
  cancelPlacement(): void {
    if (this.#disposed || this.#placingDevice === undefined) {
      return;
    }
    this.#placingDevice = undefined;
    this.#sync();
  }

  /** Reference designator the next placed component gets, per the model's policy. */
  nextDesignator(device: string): string {
    return this.#model.nextDesignator(device);
  }

  /** Applies one core command through the model, like a gesture that just finished. */
  applyCommand(command: SchematicCommand): void {
    if (this.#disposed) {
      return;
    }
    this.#model.applyCommand(command);
  }

  /**
   * Replaces the content. By default selection and placement start over and the view fits the new
   * content; `keepHistory` records the swap as one undoable edit instead.
   *
   * @throws {SchematicError} when the text is not a valid `.sch` document, or the model rejects the
   * swap (`keepHistory`); the editor keeps its previous content, selection and placement.
   */
  setValue(value: SchematicContent, options: DocumentUpdateOptions = {}): void {
    if (this.#disposed) {
      return;
    }
    // Resolve first: invalid text throws before the editor drops selection or placement.
    const content = resolveSchematicContent(value);
    this.cancelInteraction();
    if (options.keepHistory === true) {
      this.#model.setValue(content, options);
      return;
    }
    this.#placingDevice = undefined;
    this.#selection = [];
    this.#model.setValue(content);
    this.fitToContent();
  }

  undo(): void {
    if (this.#disposed) {
      return;
    }
    this.#model.undo();
  }

  redo(): void {
    if (this.#disposed) {
      return;
    }
    this.#model.redo();
  }

  /** Runs several edits as one history step; a failure rolls all of them back. */
  transaction(run: () => void): void {
    if (this.#disposed) {
      return;
    }
    this.#model.transaction(() => {
      run();
    });
  }

  addWire(points: readonly Point[]): void {
    if (this.#disposed) {
      return;
    }
    this.#model.addWire(points);
  }

  connectWireAt(wireId: string, point: Point, otherWireId?: string): string {
    if (this.#disposed) {
      return '';
    }
    return this.#model.connectWireAt(wireId, point, otherWireId);
  }

  moveWireSegment(wireId: string, segment: number, delta: Point): void {
    if (this.#disposed) {
      return;
    }
    this.#model.moveWireSegment(wireId, segment, delta);
  }

  previewWireSegment(wireId: string, segment: number, delta: Point): readonly Point[] | undefined {
    return this.#model.previewWireSegment(wireId, segment, delta);
  }

  moveSelectionBy(dx: number, dy: number): void {
    if (this.#disposed) {
      return;
    }
    this.#model.moveTargets(this.#selection, dx, dy);
  }

  rotateSelection(degrees: number): void {
    if (this.#disposed) {
      return;
    }
    this.#model.rotateTargets(this.#selection, degrees);
  }

  /** Deletes the selected elements; the selection empties once the edit commits. */
  deleteSelection(): void {
    if (this.#disposed || this.#selection.length === 0) {
      return;
    }
    this.#model.removeTargets(this.#selection);
    if (this.#selection.length > 0) {
      this.#selection = [];
      this.#sync();
    }
  }

  /**
   * Copies the selection into the editor's own buffer and, best-effort, into the system clipboard.
   * Allowed in read-only editors because it changes nothing.
   */
  copySelection(): SchematicClipboard | undefined {
    if (this.#disposed) {
      return undefined;
    }
    const clipboard = this.#model.copy(this.#selection);
    if (clipboard === undefined) {
      return undefined;
    }
    this.#clipboard = clipboard;
    void this.#writeClipboard(clipboard);
    return clipboard;
  }

  /** Cuts the selection as one undoable edit, then mirrors the payload to the system clipboard. */
  cutSelection(): SchematicClipboard | undefined {
    if (this.#disposed || this.#readOnly) {
      return undefined;
    }
    const clipboard = this.#model.cut(this.#selection);
    if (clipboard === undefined) {
      return undefined;
    }
    this.#clipboard = clipboard;
    void this.#writeClipboard(clipboard);
    return clipboard;
  }

  /**
   * Pastes a payload as one undoable edit and selects the new elements. The payload comes from
   * `options.text`, then the clipboard port, then the editor's own buffer.
   */
  async pasteSelection(options: EditorPasteOptions = {}): Promise<boolean> {
    if (this.#disposed || this.#readOnly) {
      return false;
    }
    const clipboard =
      options.text === undefined ? await this.#readClipboard() : this.#parseClipboard(options.text);
    if (clipboard === undefined || this.#disposed) {
      return false;
    }
    try {
      const targets = this.#model.paste(clipboard, this.#pasteOptions(options));
      if (targets.length === 0) {
        return false;
      }
      this.setSelection(targets);
      this.root.focus();
      return true;
    } catch (error) {
      if (!this.#disposed) {
        this.#error = toSchematicError(error);
        this.#sync();
      }
      return false;
    }
  }

  /** Copies and re-inserts the selection one grid step away as one undoable edit. */
  duplicateSelection(): readonly EditorSelection[] {
    if (this.#disposed || this.#readOnly) {
      return [];
    }
    const targets = this.#model.duplicate(this.#selection, { offset: this.#gridStep() });
    if (targets.length > 0) {
      this.setSelection(targets);
      this.root.focus();
    }
    return targets;
  }

  /** Selects every symbol, wire and junction; reference designators stay part of their symbol. */
  selectAll(): void {
    if (this.#disposed) {
      return;
    }
    const { symbols, wires, junctions } = this.#model.getValue().sheet;
    this.setSelection([
      ...symbols.map((symbol): EditorSelection => ({ kind: 'symbol', id: symbol.id })),
      ...wires.map((wire): EditorSelection => ({ kind: 'wire', id: wire.id })),
      ...junctions.map((junction): EditorSelection => ({ kind: 'junction', id: junction.id })),
    ]);
  }

  moveReferenceBy(symbolId: string, dx: number, dy: number): void {
    if (this.#disposed) {
      return;
    }
    this.#model.moveReferenceBy(symbolId, dx, dy);
  }

  hitTest(point: Point, options: HitTestOptions = {}): SchematicHit | undefined {
    return this.#model.hitTest(point, options);
  }

  getTopology(): SchematicTopology {
    return this.#model.getTopology();
  }

  /** Everything the canvas draws from; reading it never builds the inspector. */
  getRenderState(): EditorRenderState {
    return {
      document: this.#model.getValue(),
      selection: this.#selection,
      tool: this.#tool,
      display: this.#display,
    };
  }

  /** Selection, tool and the inspector payload for the current document. */
  getState(): EditorState {
    return this.#state();
  }

  setTheme(theme: Partial<SchematicTheme>): void {
    if (this.#disposed) {
      return;
    }
    this.#theme = resolveSchematicTheme(theme);
    this.#applyTheme();
    this.#render();
  }

  getTheme(): SchematicTheme {
    return this.#theme;
  }

  fitToContent(): void {
    if (this.#disposed) {
      return;
    }
    this.#viewport.fit(this.#model.getTopology().bounds, {
      width: this.#shell.canvasHost.clientWidth,
      height: this.#shell.canvasHost.clientHeight,
    });
    this.#render();
  }

  zoomTo(scale: number): void {
    if (this.#disposed) {
      return;
    }
    this.#viewport.zoomTo(scale, {
      x: this.#shell.canvasHost.clientWidth / 2,
      y: this.#shell.canvasHost.clientHeight / 2,
    });
    this.#render();
  }

  /** Current zoom/pan; safe to persist and hand back to {@link setViewport}. */
  getViewport(): ViewportState {
    return this.#viewport.state;
  }

  /** Restores a saved viewport; the scale is clamped to `zoomLimits` around the canvas centre. */
  setViewport(viewport: ViewportState): void {
    if (this.#disposed) {
      return;
    }
    this.#viewport.setState(
      clampViewport(
        viewport,
        { width: this.#shell.canvasHost.clientWidth, height: this.#shell.canvasHost.clientHeight },
        this.#viewport.limits,
      ),
    );
    this.#render();
  }

  /** Serializes the current document as `.sch` JSON. */
  toJSON(): string {
    return this.#model.toJSON();
  }

  /** Moves keyboard focus to the canvas surface; call after host toolbar interactions. */
  focus(): void {
    if (this.#disposed) {
      return;
    }
    this.root.focus();
  }

  /** Canvas-relative client coordinates → page coordinates (for host overlays). */
  toPage(clientPoint: Point): Point {
    const rect = this.canvas.getBoundingClientRect();
    return screenToPage(this.#viewport.state, {
      x: clientPoint.x - rect.left,
      y: clientPoint.y - rect.top,
    });
  }

  /** Page coordinates → canvas-relative CSS pixels (for host overlays). */
  toScreen(pagePoint: Point): Point {
    return pageToScreen(this.#viewport.state, pagePoint);
  }

  /** Cancels the pending wire, drag or marquee; selection and tool stay as they are. */
  cancelInteraction(): void {
    if (this.#disposed) {
      return;
    }
    this.#input.resetTransient();
    this.#render();
  }

  /** Re-measures the container; call after showing a previously hidden editor. */
  resize(): void {
    if (this.#disposed) {
      return;
    }
    const width = this.#shell.canvasHost.clientWidth;
    const height = this.#shell.canvasHost.clientHeight;
    if (width === 0 || height === 0) {
      return;
    }
    const pixelRatio = this.#container.ownerDocument.defaultView?.devicePixelRatio ?? 1;
    this.#renderer.resize(width, height, Math.max(1, pixelRatio));
    if (this.#viewport.autoFit) {
      this.fitToContent();
      return;
    }
    this.#render();
  }

  /** Repaints without touching layout (e.g. after a device-pixel-ratio change). */
  invalidate(): void {
    this.#render();
  }

  /** Removes the DOM and listeners created by the editor, keeping the container contents. */
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#subscriptions.dispose();
    this.#resizeObserver.disconnect();
    this.#input.detach();
    this.#renderer.destroy();
    this.root.remove();
    this.#contentChanged.dispose();
    this.#stateChanged.dispose();
    this.#selectionChanged.dispose();
    this.#toolChanged.dispose();
    this.#errorChanged.dispose();
    this.#viewportChanged.dispose();
    if (this.#ownsModel) {
      this.#model.dispose();
    }
  }

  /** Runs a gesture edit; errors surface through `state.lastError` / `onDidChangeError`. */
  #run(edit: () => void): void {
    try {
      edit();
    } catch {
      // The model already recorded the failure and notified the editor.
    }
  }

  async #writeClipboard(clipboard: SchematicClipboard): Promise<void> {
    try {
      await this.#clipboardPort.write(serializeSchematicClipboard(clipboard));
    } catch {
      // The editor's own buffer keeps paste working without clipboard permissions.
    }
  }

  /** Payload from the system clipboard, falling back to the last copied or cut selection. */
  async #readClipboard(): Promise<SchematicClipboard | undefined> {
    let text: string | undefined;
    try {
      text = await this.#clipboardPort.read();
    } catch {
      return this.#clipboard;
    }
    if (text === undefined) {
      return this.#clipboard;
    }
    try {
      return parseSchematicClipboard(text);
    } catch {
      // Foreign clipboard content: keep pasting what the editor itself copied.
      return this.#clipboard;
    }
  }

  #parseClipboard(text: string): SchematicClipboard | undefined {
    try {
      return parseSchematicClipboard(text);
    } catch (error) {
      this.#error = toSchematicError(error);
      this.#sync();
      return undefined;
    }
  }

  /** Explicit target first, then the pointer position, then a plain grid offset. */
  #pasteOptions(options: PasteOptions): PasteOptions {
    if (options.at !== undefined) {
      return { at: options.at };
    }
    if (options.offset !== undefined) {
      return { offset: options.offset };
    }
    const page = this.#input.lastPointerPage;
    return page === undefined
      ? { offset: this.#gridStep() }
      : { at: snapToGrid(page, this.#display) };
  }

  #gridStep(): Point {
    const size = this.#display.gridSize;
    return size > 0 ? { x: size, y: size } : { x: 1, y: 1 };
  }

  #onModelChanged(): void {
    // A rejected model edit records its error; every committed edit clears it.
    this.#error = this.#model.getLastError();
    this.#sync();
  }

  #state(): EditorState {
    const document = this.#model.getValue();
    return {
      document,
      selection: this.#selection,
      tool: this.#tool,
      placingDevice: this.#placingDevice,
      display: this.#display,
      canUndo: this.#model.getCanUndo(),
      canRedo: this.#model.getCanRedo(),
      inspector: buildInspector(document, this.#selection, {
        devices: this.#model.getDevices(),
        topology: () => this.#model.getTopology(),
      }),
      lastError: this.#error,
    };
  }

  #applyTheme(): void {
    for (const [name, value] of Object.entries(themeToCssVariables(this.#theme))) {
      this.root.style.setProperty(name, value);
    }
    this.#renderer.setTheme(this.#theme);
  }

  #sync(): void {
    if (this.#disposed) {
      return;
    }
    this.#selection = pruneSelection(this.#selection, this.#model.getValue());
    const state = this.#state();
    this.#shell.setToolActive(state.tool);
    this.canvas.style.cursor =
      state.tool === 'select' && state.placingDevice === undefined ? 'default' : 'crosshair';
    if (state.document !== this.#lastContent) {
      this.#lastContent = state.document;
      this.#contentChanged.fire(state.document);
    }
    if (state.lastError !== this.#reportedError) {
      this.#reportedError = state.lastError;
      this.#errorChanged.fire(state.lastError);
    }
    if (state.tool !== this.#lastTool || state.placingDevice !== this.#lastPlacing) {
      this.#lastTool = state.tool;
      this.#lastPlacing = state.placingDevice;
      this.#input.resetTransient();
      this.#toolChanged.fire(state.tool);
    }
    if (!sameSelection(state.selection, this.#lastSelection)) {
      this.#lastSelection = state.selection;
      this.#selectionChanged.fire(state.selection);
    }
    this.#stateChanged.fire(state);
    // The state came from this emit: reuse it instead of building another one for the repaint.
    this.#render(state);
  }

  #render(state: EditorRenderState = this.getRenderState()): void {
    if (this.#disposed) {
      return;
    }
    const devices = this.#model.getDevices();
    const scene = buildSchematicScene({
      document: state.document,
      ...(devices === undefined ? {} : { devices }),
      theme: this.#theme,
      selection: {
        ...toSceneHighlight(state.selection),
        ...(this.#input.dragOffset === undefined ? {} : { offset: this.#input.dragOffset }),
      },
      ...(this.#input.hover === undefined ? {} : { hover: this.#input.hover }),
      tool: state.tool,
      display: {
        grid: state.display.grid,
        labels: state.display.labels,
        gridSize: state.display.gridSize,
        gridSubdivisions: state.display.gridSubdivisions,
      },
      ...(this.#input.pendingWire.length === 0
        ? {}
        : { pendingWire: this.#input.pendingWireWithCursor }),
      ...(this.#input.marquee === undefined ? {} : { marquee: this.#input.marquee }),
      ...(this.#input.placementPreview === undefined
        ? {}
        : { placementPreview: this.#input.placementPreview }),
      ...(this.#input.referencePreview === undefined
        ? {}
        : { referencePreview: this.#input.referencePreview }),
      ...(this.#input.wirePreview === undefined ? {} : { wirePreview: this.#input.wirePreview }),
    });
    this.#renderer.render(scene, this.#viewport.state);
    if (!sameViewport(this.#viewport.state, this.#lastViewport)) {
      this.#lastViewport = this.#viewport.state;
      this.#viewportChanged.fire(this.#viewport.state);
    }
  }
}

/** Creates a canvas schematic editor over `options.model`, or over a model it builds from `value`. */
export function createSchematicEditor(options: SchematicEditorOptions): SchematicEditor {
  return new SchematicEditor(options);
}

/** Builds the model an editor owns when the host passes content instead of a model. */
function createOwnedModel(options: SchematicEditorOptions): DocumentModel {
  return new DocumentModel({
    ...(options.value === undefined ? {} : { value: options.value }),
    ...(options.devices === undefined ? {} : { devices: options.devices }),
    ...(options.tolerance === undefined ? {} : { tolerance: options.tolerance }),
    ...(options.historyLimit === undefined ? {} : { historyLimit: options.historyLimit }),
    ...(options.createId === undefined ? {} : { createId: options.createId }),
    ...(options.createDesignator === undefined
      ? {}
      : { createDesignator: options.createDesignator }),
  });
}

function sameViewport(left: ViewportState, right: ViewportState | undefined): boolean {
  return (
    right !== undefined &&
    left.scale === right.scale &&
    left.offsetX === right.offsetX &&
    left.offsetY === right.offsetY
  );
}
