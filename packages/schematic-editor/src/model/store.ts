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
  type SchematicWire,
} from '@mica-js/core/schematic';
import { Emitter, type Event } from '@mica-js/core/lifecycle';

const MAX_MERGE_PASSES = 64;

export interface DocumentStoreOptions {
  readonly document: SchematicDocument;
  readonly devices?: DeviceSymbolProvider;
  readonly tolerance?: number;
  readonly historyLimit?: number;
  readonly createId?: ElementIdFactory;
  /** Designator policy; defaults to the device's `designatorPrefix` (`U` when it declares none). */
  readonly createDesignator?: DesignatorFactory;
}

/**
 * Internal document state behind `DocumentModel`: the core editor (document + history), the
 * junction reconciliation pass and the caches derived from the document. Canvas state such as
 * selection, tool and display options lives in the editor.
 */
export class DocumentStore {
  editor: SchematicEditor;
  readonly devices: DeviceSymbolProvider | undefined;
  readonly tolerance: number | undefined;
  readonly createId: ElementIdFactory;
  readonly createDesignator: DesignatorFactory;
  readonly #content = new Emitter<DocumentStore>();
  readonly #rejections = new Emitter<SchematicError>();
  readonly #historyLimit: number | undefined;
  #topology:
    { readonly document: SchematicDocument; readonly value: SchematicTopology } | undefined;
  #lastError: SchematicError | undefined;

  /** Fires after every commit: an edit, undo/redo or a document swap. */
  readonly onDidChangeContent: Event<DocumentStore> = this.#content.event;
  /** Fires instead of {@link onDidChangeContent} when an edit is rejected. */
  readonly onDidRejectEdit: Event<SchematicError> = this.#rejections.event;

  constructor(options: DocumentStoreOptions) {
    this.#historyLimit = options.historyLimit;
    this.editor = createEditor(options);
    this.devices = options.devices;
    this.tolerance = options.tolerance;
    this.createId = options.createId ?? defaultElementIdFactory;
    this.createDesignator = options.createDesignator ?? createDesignatorFactory(options.devices);
  }

  get document(): SchematicDocument {
    return this.editor.document;
  }

  get lastError(): SchematicError | undefined {
    return this.#lastError;
  }

  /** Editing options for core calls (`exactOptionalPropertyTypes` friendly). */
  get options(): { devices?: DeviceSymbolProvider; tolerance?: number } {
    return deriveOptions(this.devices, this.tolerance);
  }

  /**
   * Runs `run` as one undoable edit, then reconciles junctions. Failures are recorded in
   * `lastError`, reported through `onDidRejectEdit` and rethrown; the content stays untouched.
   */
  mutate(run: () => void, options: { reconcile?: boolean } = {}): void {
    try {
      this.editor.transaction(() => {
        run();
        if (options.reconcile !== false) {
          this.mergeDegenerateJunctions();
        }
      });
    } catch (error) {
      this.#lastError = toSchematicError(error);
      this.#rejections.fire(this.#lastError);
      throw error;
    }
    this.#lastError = undefined;
    this.#content.fire(this);
  }

  afterHistoryChange(): void {
    this.#lastError = undefined;
    this.#content.fire(this);
  }

  /** Records a rejected edit in `lastError`, notifies listeners, then rethrows. */
  reject(error: SchematicError): never {
    this.#lastError = error;
    this.#rejections.fire(error);
    throw error;
  }

  undo(): void {
    if (!this.editor.canUndo) {
      return;
    }
    this.editor.undo();
    this.afterHistoryChange();
  }

  redo(): void {
    if (!this.editor.canRedo) {
      return;
    }
    this.editor.redo();
    this.afterHistoryChange();
  }

  /** Swaps the edited document and clears history and errors. */
  reset(document: SchematicDocument): void {
    this.editor = createEditor({
      document,
      ...deriveOptions(this.devices, this.tolerance),
      ...(this.#historyLimit === undefined ? {} : { historyLimit: this.#historyLimit }),
      createId: this.createId,
      createDesignator: this.createDesignator,
    });
    this.#lastError = undefined;
    this.#topology = undefined;
    this.#content.fire(this);
  }

  /** Swaps the whole document as one undoable edit. */
  replace(document: SchematicDocument): void {
    this.mutate(() => {
      this.editor.replace(document);
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

function createEditor(options: DocumentStoreOptions): SchematicEditor {
  return new SchematicEditor(options.document, {
    ...deriveOptions(options.devices, options.tolerance),
    ...(options.historyLimit === undefined ? {} : { historyLimit: options.historyLimit }),
    ...(options.createId === undefined ? {} : { createId: options.createId }),
  });
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
