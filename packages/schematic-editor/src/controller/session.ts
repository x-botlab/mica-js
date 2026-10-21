import {
  SchematicEditor,
  SchematicError,
  createDesignatorFactory,
  defaultElementIdFactory,
  deriveSchematicTopology,
  hitTestSchematic,
  mergeWiresAtJunction,
  type DesignatorFactory,
  type DeviceSymbolProvider,
  type Diagnostic,
  type ElementIdFactory,
  type HitTestOptions,
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

const MAX_MERGE_PASSES = 64;

export interface EditorSessionOptions {
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

/**
 * Editing session: the document editor, the read-only view overlay, the session-level state
 * (selection, tool, display, errors), the caches derived from them and the mutation plumbing.
 * Actions in `symbols.ts` / `wires.ts` operate on it; the controller is only a façade.
 */
export class EditorSession {
  editor: SchematicEditor;
  readonly overlay: ViewOverlay;
  readonly devices: DeviceSymbolProvider | undefined;
  readonly tolerance: number | undefined;
  readonly createId: ElementIdFactory;
  readonly createDesignator: DesignatorFactory;
  selection: readonly EditorSelection[] = [];
  tool: EditorTool = 'select';
  display: DisplayOptions;
  placingDevice: string | undefined;
  lastError: SchematicError | undefined;
  readonly #listeners = new Set<(state: EditorState) => void>();
  #topology:
    { readonly document: SchematicDocument; readonly value: SchematicTopology } | undefined;
  #stateCache: EditorState | undefined;
  #renderCache: EditorRenderState | undefined;

  constructor(options: EditorSessionOptions) {
    this.editor = new SchematicEditor(options.document, {
      ...deriveOptions(options.devices, options.tolerance),
      ...(options.historyLimit === undefined ? {} : { historyLimit: options.historyLimit }),
    });
    this.overlay = new ViewOverlay(options.view);
    this.devices = options.devices;
    this.tolerance = options.tolerance;
    this.createId = options.createId ?? defaultElementIdFactory;
    this.createDesignator = options.createDesignator ?? createDesignatorFactory(options.devices);
    this.display = { ...DEFAULT_DISPLAY_OPTIONS, ...options.display };
  }

  get document(): SchematicDocument {
    return this.editor.document;
  }

  get view(): SchematicViewDocument | undefined {
    return this.overlay.view;
  }

  get renderView(): SchematicViewDocument | undefined {
    return this.overlay.renderView;
  }

  /** Editing options for core calls (`exactOptionalPropertyTypes` friendly). */
  get options(): { devices?: DeviceSymbolProvider; tolerance?: number } {
    return deriveOptions(this.devices, this.tolerance);
  }

  /**
   * Full editor state. Cached until the next change so hosts can compare references, and so a
   * repaint does not rebuild the inspector payload.
   */
  state(): EditorState {
    if (this.#stateCache !== undefined) {
      return this.#stateCache;
    }
    this.#stateCache = {
      ...this.renderState(),
      placingDevice: this.placingDevice,
      canUndo: this.editor.canUndo,
      canRedo: this.editor.canRedo,
      inspector: this.inspect(),
      lastError: this.lastError,
    };
    return this.#stateCache;
  }

  /** Everything the canvas draws from; never builds the inspector. */
  renderState(): EditorRenderState {
    if (this.#renderCache !== undefined) {
      return this.#renderCache;
    }
    this.#renderCache = {
      document: this.editor.document,
      view: this.overlay.renderView,
      selection: this.selection,
      tool: this.tool,
      display: this.display,
    };
    return this.#renderCache;
  }

  subscribe(listener: (state: EditorState) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(): void {
    this.#stateCache = undefined;
    this.#renderCache = undefined;
    const state = this.state();
    for (const listener of [...this.#listeners]) {
      listener(state);
    }
  }

  /**
   * Runs `run` as one undoable edit, then reconciles junctions. Failures are recorded in
   * `lastError` and rethrown; the document stays untouched.
   */
  mutate(run: () => void, options: { reconcile?: boolean } = {}): void {
    const document = this.editor.document;
    const markers = this.overlay.snapshot();
    try {
      this.editor.transaction(() => {
        run();
        if (options.reconcile !== false) {
          this.mergeDegenerateJunctions();
        }
      });
    } catch (error) {
      this.lastError = toSchematicError(error);
      this.emit();
      throw error;
    }
    if (this.editor.document !== document) {
      // One document history step, so the marker set keeps one snapshot per step.
      this.overlay.commit(markers);
    }
    this.lastError = undefined;
    this.pruneSelection();
    this.emit();
  }

  afterHistoryChange(): void {
    this.lastError = undefined;
    this.pruneSelection();
    this.emit();
  }

  /** Records a rejected edit in `state.lastError`, notifies listeners, then rethrows. */
  reject(error: SchematicError): never {
    this.lastError = error;
    this.emit();
    throw error;
  }

  undo(): void {
    if (!this.editor.canUndo) {
      return;
    }
    this.editor.undo();
    this.overlay.undo();
    this.afterHistoryChange();
  }

  redo(): void {
    if (!this.editor.canRedo) {
      return;
    }
    this.editor.redo();
    this.overlay.redo();
    this.afterHistoryChange();
  }

  /** Swaps the edited document and clears history, selection and errors. */
  reset(document: SchematicDocument, options: { view?: SchematicViewDocument } = {}): void {
    this.editor = new SchematicEditor(document, deriveOptions(this.devices, this.tolerance));
    if (options.view === undefined) {
      this.overlay.clearMarkers();
    } else {
      this.overlay.setView(options.view);
    }
    this.selection = [];
    this.lastError = undefined;
    this.#topology = undefined;
    this.placingDevice = undefined;
    this.emit();
  }

  inspect(): Inspector {
    return buildInspector(this.editor.document, this.selection, {
      devices: this.devices,
      topology: () => this.topology(),
    });
  }

  topology(): SchematicTopology {
    const document = this.editor.document;
    if (this.#topology?.document !== document) {
      this.#topology = {
        document,
        value: deriveSchematicTopology(document, this.options),
      };
    }
    return this.#topology.value;
  }

  hitTest(
    point: { readonly x: number; readonly y: number },
    options: HitTestOptions = {},
  ): SchematicHit | undefined {
    return hitTestSchematic(this.editor.document, point, { ...this.options, ...options });
  }

  pruneSelection(): void {
    const kept = pruneSelection(this.selection, this.editor.document);
    if (kept !== this.selection) {
      this.selection = kept;
    }
  }

  findSymbol(id: string): SchematicSymbol | undefined {
    return this.editor.document.sheet.symbols.find((symbol) => symbol.id === id);
  }

  findWire(id: string): SchematicWire | undefined {
    return this.editor.document.sheet.wires.find((wire) => wire.id === id);
  }

  /** @throws {SchematicError} when the symbol is unknown. */
  requireSymbol(symbolId: string): SchematicSymbol {
    const symbol = this.findSymbol(symbolId);
    if (symbol === undefined) {
      this.reject(
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

  /** Device outline in symbol-local coordinates, used as the reference-designator default. */
  outlineOf(
    symbol: SchematicSymbol,
  ): { x: number; y: number; width: number; height: number } | undefined {
    const separator = symbol.device.indexOf(':');
    if (separator <= 0) {
      return undefined;
    }
    return this.devices?.getDeviceSymbol({
      raw: symbol.device,
      packageId: symbol.device.slice(0, separator),
      deviceId: symbol.device.slice(separator + 1),
    })?.bounds;
  }

  /** A junction that only splices two collinear wires collapses back into a single wire. */
  mergeDegenerateJunctions(): void {
    for (let pass = 0; pass < MAX_MERGE_PASSES; pass += 1) {
      const junctions = this.editor.document.sheet.junctions;
      let merged = false;
      for (const junction of junctions) {
        const result = mergeWiresAtJunction(this.editor.document, junction.id, {
          ...deriveOptions(undefined, this.tolerance),
          createId: this.createId,
        });
        if (result === undefined) {
          continue;
        }
        this.editor.replace(result.document);
        merged = true;
        break;
      }
      if (!merged) {
        return;
      }
    }
  }
}

/** Builds provider options without `undefined` values (`exactOptionalPropertyTypes`). */
export function deriveOptions(
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

export function toSchematicError(error: unknown): SchematicError {
  if (error instanceof SchematicError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const diagnostics: readonly Diagnostic[] = [
    { severity: 'error', code: 'edit/invalid-command', message },
  ];
  return new SchematicError(diagnostics);
}
