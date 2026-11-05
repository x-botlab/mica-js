import type {
  CanvasBindingTarget,
  CanvasWidgetInstance,
  WidgetPlacement,
} from '@mica-js/document/canvas';
import type { IEditorCommand } from './host';

export interface ICanvasCommandMap {
  'canvas.setProperty': IEditorCommand<{ instanceId: string; key: string; value: unknown }>;
  'canvas.removeProperty': IEditorCommand<{ instanceId: string; key: string }>;
  'canvas.setProperties': IEditorCommand<{
    instanceId: string;
    values: Readonly<Record<string, unknown>>;
    remove?: readonly string[];
  }>;
  'canvas.setBinding': IEditorCommand<{
    instanceId: string;
    port: string;
    target: CanvasBindingTarget | null;
  }>;
  'canvas.setSchematic': IEditorCommand<{ path: string | null; bindings?: 'preserve' | 'clear' }>;
  'canvas.addWidget': IEditorCommand<{ instance: CanvasWidgetInstance; z?: number }>;
  'canvas.removeWidget': IEditorCommand<{ instanceId: string }>;
  'canvas.setPlacement': IEditorCommand<{ instanceId: string; placement: WidgetPlacement }>;
  'canvas.setZ': IEditorCommand<{ instanceId: string; z: number }>;
  'canvas.setMode': IEditorCommand<{ mode: 'edit' | 'simulation' }>;
  'canvas.undo': IEditorCommand;
  'canvas.redo': IEditorCommand;
  'canvas.run': IEditorCommand;
  'canvas.pause': IEditorCommand;
  'canvas.step': IEditorCommand;
  'canvas.reset': IEditorCommand;
  'canvas.zoomIn': IEditorCommand;
  'canvas.zoomOut': IEditorCommand;
  'canvas.resetView': IEditorCommand;
  'canvas.fitView': IEditorCommand;
}
