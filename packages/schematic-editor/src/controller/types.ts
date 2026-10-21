import type {
  Point,
  PropertyValue,
  SchematicDocument,
  SchematicError,
  SchematicViewDocument,
  SymbolRole,
} from '@mica/core/schematic';

export type EditorTool = 'select' | 'wire' | 'power' | 'ground' | 'label' | 'text';

export type EditorSelection =
  | { readonly kind: 'symbol'; readonly id: string }
  | { readonly kind: 'reference'; readonly symbolId: string }
  | { readonly kind: 'wire'; readonly id: string }
  | { readonly kind: 'junction'; readonly id: string }
  | { readonly kind: 'vertex'; readonly wireId: string; readonly index: number };

export interface DisplayOptions {
  readonly grid: boolean;
  readonly snap: boolean;
  readonly labels: boolean;
  /** Snap step in page units. */
  readonly gridSize: number;
  /** Visible grid lines per snap cell; `1` shows only the snap grid. */
  readonly gridSubdivisions: number;
}

export const DEFAULT_DISPLAY_OPTIONS: DisplayOptions = {
  grid: true,
  snap: true,
  labels: true,
  gridSize: 10,
  gridSubdivisions: 2,
};

export interface PropertyField {
  readonly key: string;
  readonly type: 'string' | 'number' | 'boolean';
  /** Instance override; `undefined` when the instance inherits the default. */
  readonly value: PropertyValue | undefined;
  readonly defaultValue: PropertyValue | undefined;
}

export interface SymbolInspector {
  readonly kind: 'symbol';
  readonly id: string;
  /** What the symbol is for; drives which fields the panel shows. */
  readonly role: SymbolRole;
  readonly device: string;
  readonly name: string | undefined;
  /** True for the builtin symbols (`label` / `power` / `ground` / `text`). */
  readonly builtin: boolean;
  /** Reference designator; absent for symbols that carry none. */
  readonly designator?: string;
  /** Net name; absent for symbols that name no net. */
  readonly net?: string;
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly properties: readonly PropertyField[];
}

export interface WireInspector {
  readonly kind: 'wire';
  readonly id: string;
  /** Net name derived from the topology; `null` for anonymous nets. */
  readonly netName: string | null;
  readonly points: readonly Point[];
}

export type Inspector = SymbolInspector | WireInspector | undefined;

export interface EditorState {
  readonly document: SchematicDocument;
  readonly view: SchematicViewDocument | undefined;
  readonly selection: readonly EditorSelection[];
  readonly tool: EditorTool;
  /** Device armed for placement by the host's device list; `undefined` when idle. */
  readonly placingDevice: string | undefined;
  readonly display: DisplayOptions;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly inspector: Inspector;
  /** Last captured edit error; cleared by the next successful edit. */
  readonly lastError: SchematicError | undefined;
}
