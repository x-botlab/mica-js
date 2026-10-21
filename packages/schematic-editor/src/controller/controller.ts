import type {
  HitTestOptions,
  SchematicCommand,
  SchematicDocument,
  SchematicHit,
  SchematicTopology,
  SchematicViewDocument,
} from '@mica-js/core/schematic';
import type { PropertyValue } from '@mica-js/core/schematic';
import { EditorSession, type EditorSessionOptions } from './session';
import * as symbols from './symbols';
import * as wires from './wires';
import type {
  DisplayOptions,
  EditorRenderState,
  EditorSelection,
  EditorState,
  EditorTool,
  Inspector,
} from './types';

export type SchematicEditorControllerOptions = EditorSessionOptions;

/**
 * Editing state without any DOM dependency: selection, tool, undo history and the derived data
 * the UI needs. It is a façade over {@link EditorSession} (state + mutation plumbing) and the
 * action modules `symbols.ts` / `wires.ts`; every mutation flows through `applySchematicCommand`.
 */
export class SchematicEditorController {
  readonly #session: EditorSession;

  constructor(options: SchematicEditorControllerOptions) {
    this.#session = new EditorSession(options);
  }

  get state(): EditorState {
    return this.#session.state();
  }

  /** Everything the canvas draws from; never builds the inspector. */
  get renderState(): EditorRenderState {
    return this.#session.renderState();
  }

  /**
   * The view used for rendering: placement overrides are dropped for symbols edited here, so a
   * rotation or move is visible instead of being masked by the read-only layout.
   */
  get renderView(): SchematicViewDocument | undefined {
    return this.#session.renderView;
  }

  get document(): SchematicDocument {
    return this.#session.document;
  }

  get view(): SchematicViewDocument | undefined {
    return this.#session.view;
  }

  get selection(): readonly EditorSelection[] {
    return this.#session.selection;
  }

  get tool(): EditorTool {
    return this.#session.tool;
  }

  get display(): DisplayOptions {
    return this.#session.display;
  }

  get canUndo(): boolean {
    return this.#session.editor.canUndo;
  }

  get canRedo(): boolean {
    return this.#session.editor.canRedo;
  }

  /** Device armed for placement by the host's device list; `undefined` when idle. */
  get placingDevice(): string | undefined {
    return this.#session.placingDevice;
  }

  setTool(tool: EditorTool): void {
    if (this.#session.tool === tool && this.#session.placingDevice === undefined) {
      return;
    }
    this.#session.tool = tool;
    this.#session.placingDevice = undefined;
    this.#session.emit();
  }

  setSelection(selection: readonly EditorSelection[]): void {
    this.#session.selection = selection;
    this.#session.pruneSelection();
    this.#session.emit();
  }

  setDisplayOptions(patch: Partial<DisplayOptions>): void {
    this.#session.display = { ...this.#session.display, ...patch };
    this.#session.emit();
  }

  /** Replaces the read-only view document; it never takes part in editing or history. */
  setView(view: SchematicViewDocument | undefined): void {
    this.#session.overlay.setView(view);
    this.#session.emit();
  }

  /** Swaps the edited document and clears history, selection and errors. */
  reset(document: SchematicDocument, options: { view?: SchematicViewDocument } = {}): void {
    this.#session.reset(document, options);
  }

  /** @throws {SchematicError} leaving document, history and selection untouched. */
  dispatch(command: SchematicCommand): void {
    this.#session.mutate(() => {
      this.#session.editor.dispatch(command);
    });
  }

  /**
   * Swaps the whole document as one undoable edit, so a host can reload a file without losing
   * the history it already has.
   */
  replace(document: SchematicDocument): void {
    this.#session.mutate(() => {
      this.#session.editor.replace(document);
    });
  }

  /** Runs several edits as one history step; a failure rolls all of them back. */
  transaction(run: () => void): void {
    this.#session.mutate(run);
  }

  undo(): void {
    this.#session.undo();
  }

  redo(): void {
    this.#session.redo();
  }

  /** Arms placement of `device`: the next canvas click inserts it and disarms again. */
  placeDevice(device: string): void {
    symbols.placeDevice(this.#session, device);
  }

  cancelPlacement(): void {
    symbols.cancelPlacement(this.#session);
  }

  /** Reference designator the next placed component gets, per the host's policy. */
  nextDesignator(device: string): string {
    return symbols.nextDesignator(this.#session, device);
  }

  moveSelectionBy(dx: number, dy: number): void {
    symbols.moveSelectionBy(this.#session, dx, dy);
  }

  rotateSelection(degrees: number): void {
    symbols.rotateSelection(this.#session, degrees);
  }

  deleteSelection(): void {
    symbols.deleteSelection(this.#session);
  }

  moveReferenceBy(symbolId: string, dx: number, dy: number): void {
    symbols.moveReferenceBy(this.#session, symbolId, dx, dy);
  }

  setSymbolProperty(symbolId: string, key: string, value: PropertyValue): void {
    symbols.setSymbolProperty(this.#session, symbolId, key, value);
  }

  removeSymbolProperty(symbolId: string, key: string): void {
    symbols.removeSymbolProperty(this.#session, symbolId, key);
  }

  renameDesignator(symbolId: string, nextDesignator: string): void {
    symbols.renameDesignator(this.#session, symbolId, nextDesignator);
  }

  renameNet(symbolId: string, nextNet: string): void {
    symbols.renameNet(this.#session, symbolId, nextNet);
  }

  addWire(points: readonly { readonly x: number; readonly y: number }[]): void {
    wires.addWire(this.#session, points);
  }

  connectWireAt(
    wireId: string,
    point: { readonly x: number; readonly y: number },
    otherWireId?: string,
  ): string {
    return wires.connectWireAt(this.#session, wireId, point, otherWireId);
  }

  moveWireSegment(
    wireId: string,
    segment: number,
    delta: { readonly x: number; readonly y: number },
  ): void {
    wires.moveWireSegment(this.#session, wireId, segment, delta);
  }

  previewWireSegment(
    wireId: string,
    segment: number,
    delta: { readonly x: number; readonly y: number },
  ): readonly { readonly x: number; readonly y: number }[] | undefined {
    return wires.previewWireSegment(this.#session, wireId, segment, delta);
  }

  inspect(): Inspector {
    return this.#session.inspect();
  }

  topology(): SchematicTopology {
    return this.#session.topology();
  }

  hitTest(
    point: { readonly x: number; readonly y: number },
    options: HitTestOptions = {},
  ): SchematicHit | undefined {
    return this.#session.hitTest(point, options);
  }

  subscribe(listener: (state: EditorState) => void): () => void {
    return this.#session.subscribe(listener);
  }
}
