import type { IHitTestOptions, SchematicHit } from '../editing/query';
import type { Point, SchematicCommand, SchematicDocument } from '@mica-js/document/schematic';
import type { ISchematicClipboard } from '../model/clipboard';
import type { IDisplayOptions, EditorSelection, EditorTool } from '../types';
import type { IEditorPasteOptions, IClipboardWriteOptions } from './schematic-editor';

/**
 * Editing surface the interaction modules drive. {@link SchematicEditor} implements it; keeping
 * the contract separate lets the pointer, keyboard and snapping code stay free of the DOM.
 */
export interface IEditorSurface {
  getValue(): SchematicDocument;
  getSelection(): readonly EditorSelection[];
  setSelection(selection: readonly EditorSelection[]): void;
  getTool(): EditorTool;
  setTool(tool: EditorTool): void;
  getDisplay(): IDisplayOptions;
  getPlacingDevice(): string | undefined;
  placeDevice(device: string): void;
  cancelPlacement(): void;
  nextDesignator(device: string): string;
  hitTest(point: Point, options?: IHitTestOptions): SchematicHit | undefined;
  applyCommand(command: SchematicCommand): void;
  transaction(run: () => void): void;
  addWire(points: readonly Point[]): void;
  moveWireSegment(wireId: string, segment: number, delta: Point): void;
  previewWireSegment(wireId: string, segment: number, delta: Point): readonly Point[] | undefined;
  moveSelectionBy(dx: number, dy: number): void;
  rotateSelection(degrees: number): void;
  deleteSelection(): void;
  copySelection(options?: IClipboardWriteOptions): ISchematicClipboard | undefined;
  cutSelection(options?: IClipboardWriteOptions): ISchematicClipboard | undefined;
  pasteSelection(options?: IEditorPasteOptions): Promise<boolean>;
  duplicateSelection(): readonly EditorSelection[];
  selectAll(): void;
  moveReferenceBy(symbolId: string, dx: number, dy: number): void;
  undo(): void;
  redo(): void;
}
