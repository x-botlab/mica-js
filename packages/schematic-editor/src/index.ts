// The library build extracts this import into `dist/style.css`; it injects nothing at runtime, so
// hosts opt in with `import '@mica-js/schematic-editor/style.css'`.
import './styles/editor.css';

export { createSchematicEditor, SchematicEditor } from './editor/schematic-editor';
export type {
  SchematicEditorModelOptions,
  SchematicEditorOptions,
} from './editor/schematic-editor';

export { DocumentModel } from './model/document-model';
export type { DocumentModelOptions, DocumentUpdateOptions } from './model/document-model';

export { createEmptySchematicDocument } from './model/content';
export type { SchematicContent } from './model/content';

export { DisposableStore, Emitter, toDisposable } from '@mica-js/core/lifecycle';
export type { Disposable, Event, IDisposable } from '@mica-js/core/lifecycle';

export { DEFAULT_DISPLAY_OPTIONS } from './types';
export type {
  DisplayOptions,
  EditorRenderState,
  EditorSelection,
  EditorState,
  EditorTool,
  Inspector,
  PropertyField,
  SchematicTarget,
  SymbolInspector,
  WireInspector,
} from './types';
export {
  DARK_SCHEMATIC_THEME,
  LIGHT_SCHEMATIC_THEME,
  resolveSchematicTheme,
  themeToCssVariables,
} from './render/theme';
export type { SchematicTheme, ThemeColor } from './render/theme';
export {
  DEFAULT_VIEWPORT_LIMITS,
  resolveViewportLimits,
  type ViewportLimits,
  type ViewportState,
} from './render/viewport';
