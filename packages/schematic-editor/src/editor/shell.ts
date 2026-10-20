import type { EditorTool } from '../controller/types';
import { EDITOR_STYLES } from '../styles';
import { TOOL_ICONS, createToolIcon } from './icons';

export interface EditorShell {
  readonly root: HTMLElement;
  readonly toast: HTMLElement;
  readonly canvasHost: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly toolButtons: ReadonlyMap<EditorTool, HTMLButtonElement>;
  setToolActive(tool: EditorTool): void;
}

export interface ShellOptions {
  readonly document: Document;
  readonly readOnly: boolean;
  readonly toolbar: boolean;
  readonly propertiesPanel: boolean;
  readonly onToolClick: (tool: EditorTool) => void;
}

/** Builds the static editor chrome; it owns no behaviour beyond button wiring. */
export function createShell(options: ShellOptions): EditorShell {
  const doc = options.document;
  const root = doc.createElement('div');
  root.className = 'mica-schematic';
  root.tabIndex = 0;

  const style = doc.createElement('style');
  style.textContent = EDITOR_STYLES;

  const toolbar = doc.createElement('div');
  toolbar.className = 'mica-schematic__toolbar';

  const canvasHost = doc.createElement('div');
  canvasHost.className = 'mica-schematic__canvas-host';

  const canvas = doc.createElement('canvas');
  canvas.className = 'mica-schematic__canvas';
  canvasHost.append(canvas);

  const body = doc.createElement('div');
  body.className = 'mica-schematic__body';
  body.append(toolbar, canvasHost);

  const toast = doc.createElement('div');
  toast.className = 'mica-schematic__toast';
  toast.hidden = true;
  canvasHost.append(toast);

  root.append(style, body);

  const toolButtons = new Map<EditorTool, HTMLButtonElement>();
  for (const icon of TOOL_ICONS) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'mica-schematic__tool';
    button.title = icon.label;
    button.setAttribute('aria-label', icon.label);
    button.disabled = options.readOnly;
    button.append(createToolIcon(doc, icon));
    button.addEventListener('click', () => options.onToolClick(icon.tool));
    toolButtons.set(icon.tool, button);
    toolbar.append(button);
  }

  if (!options.toolbar) {
    root.classList.add('mica-schematic--no-toolbar');
  }
  if (!options.propertiesPanel) {
    root.classList.add('mica-schematic--no-panel');
  }

  return {
    root,
    toast,
    canvasHost,
    canvas,
    toolButtons,
    setToolActive(tool) {
      for (const [candidate, button] of toolButtons) {
        button.setAttribute('aria-pressed', String(candidate === tool));
      }
    },
  };
}
