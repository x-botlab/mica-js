import type {
  HitTestOptions,
  Point,
  SchematicCommand,
  SchematicDocument,
  SchematicHit,
} from '@mica-js/core/schematic';
import type { SchematicClipboard } from '../model/clipboard';
import type { DisplayOptions, EditorSelection, EditorTool } from '../types';
import type { EditorPasteOptions } from './schematic-editor';

/**
 * Editing surface the interaction modules drive. {@link SchematicEditor} implements it; keeping
 * the contract separate lets the pointer, keyboard and snapping code stay free of the DOM.
 */
export interface EditorSurface {
  getValue(): SchematicDocument;
  getSelection(): readonly EditorSelection[];
  setSelection(selection: readonly EditorSelection[]): void;
  getTool(): EditorTool;
  setTool(tool: EditorTool): void;
  getDisplay(): DisplayOptions;
  getPlacingDevice(): string | undefined;
  placeDevice(device: string): void;
  cancelPlacement(): void;
  nextDesignator(device: string): string;
  hitTest(point: Point, options?: HitTestOptions): SchematicHit | undefined;
  applyCommand(command: SchematicCommand): void;
  transaction(run: () => void): void;
  addWire(points: readonly Point[]): void;
  moveWireSegment(wireId: string, segment: number, delta: Point): void;
  previewWireSegment(wireId: string, segment: number, delta: Point): readonly Point[] | undefined;
  moveSelectionBy(dx: number, dy: number): void;
  rotateSelection(degrees: number): void;
  deleteSelection(): void;
  copySelection(): SchematicClipboard | undefined;
  cutSelection(): SchematicClipboard | undefined;
  pasteSelection(options?: EditorPasteOptions): Promise<boolean>;
  duplicateSelection(): readonly EditorSelection[];
  selectAll(): void;
  moveReferenceBy(symbolId: string, dx: number, dy: number): void;
  undo(): void;
  redo(): void;
}
