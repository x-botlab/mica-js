/** Interaction mode of a mounted editor: editing the document, or driving the running widgets. */
export type CanvasMode = 'edit' | 'run';

/** Zoom/pan of the canvas surface; `x`/`y` are the screen offset of the document origin. */
export interface CanvasEditorViewport {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

/**
 * What the host may persist or inspect. Both values are editor state: they never belong to the
 * `.cnv` document.
 */
export interface CanvasEditorState {
  readonly mode: CanvasMode;
  readonly selection: readonly string[];
  readonly viewport: CanvasEditorViewport;
}

export type CanvasEditorDiagnosticCode =
  | 'canvas-editor/context-unavailable'
  | 'canvas-editor/render-failed'
  | 'canvas-editor/command-failed'
  | 'canvas-editor/selection-failed'
  | 'canvas-editor/dispatch-failed';

/**
 * Problems the editor survives. Rendering, input handling and host callbacks keep running after a
 * diagnostic, so a broken widget frame or a throwing callback never blocks the canvas.
 */
export interface CanvasEditorDiagnostic {
  readonly code: CanvasEditorDiagnosticCode;
  readonly message: string;
  readonly instanceId?: string;
  readonly cause?: unknown;
}
