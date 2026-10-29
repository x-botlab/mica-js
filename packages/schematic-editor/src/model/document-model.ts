import type {
  DesignatorFactory,
  DeviceSymbolProvider,
  ElementIdFactory,
  HitTestOptions,
  Point,
  PropertyValue,
  SchematicCommand,
  SchematicDocument,
  SchematicError,
  SchematicHit,
  SchematicTopology,
} from '@mica-js/core/schematic';
import * as symbols from './symbols';
import * as wires from './wires';
import {
  createSchematicClipboard,
  pasteClipboard,
  type PasteOptions,
  type SchematicClipboard,
} from './clipboard';
import { resolveSchematicContent, type SchematicContent } from './content';
import { DocumentStore } from './store';
import type { SchematicTarget } from '../types';
import { DisposableStore, Emitter, type Event } from '@mica-js/core/lifecycle';

export interface DocumentModelOptions {
  /** Initial content: a `.sch` document or its JSON text; defaults to an empty sheet. */
  readonly value?: SchematicContent;
  /** Device provider used for drag geometry, designator prefixes and property declarations. */
  readonly devices?: DeviceSymbolProvider;
  /** Hit / geometry tolerance in page units. */
  readonly tolerance?: number;
  /** Maximum number of undo steps kept; defaults to 200. */
  readonly historyLimit?: number;
  /** Element id factory; defaults to the core UUID factory. */
  readonly createId?: ElementIdFactory;
  /** Designator policy; defaults to the device's `designatorPrefix` (`U` when it declares none). */
  readonly createDesignator?: DesignatorFactory;
}

export interface DocumentUpdateOptions {
  /** Records the swap as one undoable edit instead of starting a new history. */
  readonly keepHistory?: boolean;
}

/**
 * Owns a `.sch` document and its undo history, independent of any DOM.
 *
 * The model is the single writer for document content: every mutation runs as one undoable edit,
 * rejects without touching the content, and notifies subscribers exactly once. Canvas state —
 * selection, active tool, display options and viewport — belongs to {@link SchematicEditor}.
 */
export class DocumentModel {
  readonly #store: DocumentStore;
  readonly #subscriptions = new DisposableStore();
  readonly #content = new Emitter<SchematicDocument>();
  readonly #rejections = new Emitter<SchematicError>();

  /** Fires after every committed change with the new content; rejected edits do not fire it. */
  readonly onDidChangeContent: Event<SchematicDocument> = this.#content.event;
  /** Fires when an edit is rejected, with the error the model recorded; the content stays. */
  readonly onDidRejectEdit: Event<SchematicError> = this.#rejections.event;

  constructor(options: DocumentModelOptions = {}) {
    const { value, ...rest } = options;
    this.#store = new DocumentStore({ ...rest, document: resolveSchematicContent(value) });
    this.#subscriptions.add(
      this.#store.onDidChangeContent(() => {
        this.#content.fire(this.#store.document);
      }),
    );
    this.#subscriptions.add(
      this.#store.onDidRejectEdit((error) => {
        this.#rejections.fire(error);
      }),
    );
  }

  /** Current content; the same reference until an edit replaces it. */
  getValue(): SchematicDocument {
    return this.#store.document;
  }

  /** Device provider the editor renders symbols from; the model uses it for drag geometry. */
  getDevices(): DeviceSymbolProvider | undefined {
    return this.#store.devices;
  }

  getCanUndo(): boolean {
    return this.#store.editor.canUndo;
  }

  getCanRedo(): boolean {
    return this.#store.editor.canRedo;
  }

  /** Last rejected edit; cleared by the next successful edit or undo/redo. */
  getLastError(): SchematicError | undefined {
    return this.#store.lastError;
  }

  /** Derived connectivity of the current document, cached until the document changes. */
  getTopology(): SchematicTopology {
    return this.#store.topology();
  }

  /** Serializes the current document as `.sch` JSON. */
  toJSON(): string {
    return this.#store.editor.toJSON();
  }

  /**
   * Applies one core command as one undoable edit. A command the document rejects is reported
   * through {@link DocumentModel.getLastError} and rethrown; the document stays untouched.
   */
  applyCommand(command: SchematicCommand): void {
    this.#store.mutate(() => {
      this.#store.editor.dispatch(command);
    });
  }

  /**
   * Replaces the content, accepting a document or its `.sch` JSON text. By default history and
   * errors start over; `keepHistory` records the swap as one undoable edit instead.
   *
   * @throws {SchematicError} when the text is invalid, or the document is rejected (`keepHistory`).
   */
  setValue(value: SchematicContent, options: DocumentUpdateOptions = {}): void {
    const document = resolveSchematicContent(value);
    if (options.keepHistory === true) {
      this.#store.replace(document);
      return;
    }
    this.#store.reset(document);
  }

  undo(): void {
    this.#store.undo();
  }

  redo(): void {
    this.#store.redo();
  }

  /** Runs several edits as one history step; a failure rolls all of them back. */
  transaction(run: (model: DocumentModel) => void): void {
    this.#store.mutate(() => {
      run(this);
    });
  }

  /**
   * Releases the model's events; an editor that created the model disposes it with itself. Further
   * edits still apply, but nobody is notified.
   */
  dispose(): void {
    this.#subscriptions.dispose();
    this.#content.dispose();
    this.#rejections.dispose();
  }

  /** Reference designator the next placed component gets, per the model's policy. */
  nextDesignator(device: string): string {
    return symbols.nextDesignator(this.#store, device);
  }

  /** Moves document elements by a page-space delta. */
  moveTargets(targets: readonly SchematicTarget[], dx: number, dy: number): void {
    symbols.moveTargets(this.#store, targets, dx, dy);
  }

  /** Rotates symbols clockwise by `degrees`. */
  rotateTargets(targets: readonly SchematicTarget[], degrees: number): void {
    symbols.rotateTargets(this.#store, targets, degrees);
  }

  /** Removes symbols, wires, junctions and wire vertices. */
  removeTargets(targets: readonly SchematicTarget[]): void {
    symbols.removeTargets(this.#store, targets);
  }

  /**
   * Extracts the selected elements as a clipboard payload. Pure read: no history step.
   * Reference targets copy their symbol, vertex targets their whole wire.
   */
  copy(targets: readonly SchematicTarget[]): SchematicClipboard | undefined {
    return createSchematicClipboard(this.#store.document, targets);
  }

  /** Copies then deletes the selected elements as one undoable edit. */
  cut(targets: readonly SchematicTarget[]): SchematicClipboard | undefined {
    const clipboard = createSchematicClipboard(this.#store.document, targets);
    if (clipboard === undefined) {
      return undefined;
    }
    symbols.removeTargets(this.#store, targets);
    return clipboard;
  }

  /** Inserts a payload as one undoable edit; returns the pasted symbols and wires. */
  paste(clipboard: SchematicClipboard, options?: PasteOptions): readonly SchematicTarget[] {
    return pasteClipboard(this.#store, clipboard, options);
  }

  /** Copies and re-inserts the selected elements offset by one grid step, as one undoable edit. */
  duplicate(
    targets: readonly SchematicTarget[],
    options?: PasteOptions,
  ): readonly SchematicTarget[] {
    const clipboard = createSchematicClipboard(this.#store.document, targets);
    return clipboard === undefined ? [] : pasteClipboard(this.#store, clipboard, options);
  }

  /** Moves a reference designator by a world-space delta. */
  moveReferenceBy(symbolId: string, dx: number, dy: number): void {
    symbols.moveReferenceBy(this.#store, symbolId, dx, dy);
  }

  setSymbolProperty(symbolId: string, key: string, value: PropertyValue): void {
    symbols.setSymbolProperty(this.#store, symbolId, key, value);
  }

  removeSymbolProperty(symbolId: string, key: string): void {
    symbols.removeSymbolProperty(this.#store, symbolId, key);
  }

  renameDesignator(symbolId: string, nextDesignator: string): void {
    symbols.renameDesignator(this.#store, symbolId, nextDesignator);
  }

  renameNet(symbolId: string, nextNet: string): void {
    symbols.renameNet(this.#store, symbolId, nextNet);
  }

  addWire(points: readonly Point[]): void {
    wires.addWire(this.#store, points);
  }

  connectWireAt(wireId: string, point: Point, otherWireId?: string): string {
    return wires.connectWireAt(this.#store, wireId, point, otherWireId);
  }

  moveWireSegment(wireId: string, segment: number, delta: Point): void {
    wires.moveWireSegment(this.#store, wireId, segment, delta);
  }

  /** Wire points a segment drag would produce, for previews; commits nothing. */
  previewWireSegment(wireId: string, segment: number, delta: Point): readonly Point[] | undefined {
    return wires.previewWireSegment(this.#store, wireId, segment, delta);
  }

  hitTest(point: Point, options: HitTestOptions = {}): SchematicHit | undefined {
    return this.#store.hitTest(point, options);
  }
}
