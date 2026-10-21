import type { DeviceSymbolProvider } from '@mica-js/core/schematic';
import type { SchematicEditorController } from '../../controller/controller';
import type { EditorViewport } from '../viewport-state';
import type { Pointer } from './pointer';
import type { InteractionState } from './state';

export interface EditorInputDeps {
  readonly controller: SchematicEditorController;
  readonly devices: DeviceSymbolProvider | undefined;
  readonly viewport: EditorViewport;
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly readOnly: boolean;
  /** Called after any interaction state or document change. */
  readonly onChange: () => void;
  /** Fits the view to the document (F key, initial layout). */
  readonly onFit: () => void;
  /** Runs an edit, swallowing `SchematicError` (surfaced through `state.lastError`). */
  readonly run: (edit: () => void) => void;
}

/** Shared handle for the interaction modules: dependencies, transient state and page geometry. */
export interface InteractionContext {
  readonly deps: EditorInputDeps;
  readonly state: InteractionState;
  readonly pointer: Pointer;
}
