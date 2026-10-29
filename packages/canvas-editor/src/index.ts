// The library build extracts this import into `dist/style.css`; it injects nothing at runtime, so
// hosts opt in with `import '@mica-js/canvas-editor/style.css'`.
import './styles/editor.css';

export { CanvasEditor, createCanvasEditor } from './editor/canvas-editor';
export type { CanvasEditorOptions, CanvasEditorPublishListener } from './editor/canvas-editor';

export type {
  CanvasBindingTargetInfo,
  HostProvider,
  HostProviderCreateOptions,
} from './host/provider';
export {
  deviceSimulationGuest,
  SandboxHostProvider,
  widgetGuest,
} from './host/sandbox-host-provider';
export type { SandboxHostProviderOptions } from './host/sandbox-host-provider';

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
