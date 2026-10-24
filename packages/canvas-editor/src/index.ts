export { createCanvasEditor } from './editor/mount';
export type {
  CanvasEditor,
  CanvasEditorPublishListener,
  CreateCanvasEditorOptions,
} from './editor/mount';

export type {
  CanvasEditorCoordinationDiagnostic,
  CanvasEditorCoordinationDiagnosticCode,
  CanvasEditorDiagnostic,
  CanvasEditorDiagnosticCode,
  CanvasEditorState,
  CanvasEditorViewport,
  CanvasMode,
} from './types';

export { DARK_CANVAS_THEME, LIGHT_CANVAS_THEME, resolveCanvasTheme } from './theme';
export type { CanvasTheme } from './theme';

export { MAX_VIEWPORT_SCALE, MIN_VIEWPORT_SCALE } from './viewport';
export type { ViewportState } from './viewport';
