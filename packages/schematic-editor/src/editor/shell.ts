import type { EditorTool } from '../types';
import { TOOL_ICONS, createToolIcon } from './icons';

export interface EditorShell {
  readonly root: HTMLElement;
  readonly canvasHost: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly toolButtons: ReadonlyMap<EditorTool, HTMLButtonElement>;
  setToolActive(tool: EditorTool): void;
}

export interface ShellOptions {
  readonly document: Document;
  readonly readOnly: boolean;
  readonly toolbar: boolean;
  readonly onToolClick: (tool: EditorTool) => void;
}

/** Builds the canvas surface and the floating tool strip; it owns no behaviour beyond wiring. */
export function createShell(options: ShellOptions): EditorShell {
  const doc = options.document;
  const root = doc.createElement('div');
  root.className = 'mica-schematic';
  root.tabIndex = 0;

  const canvasHost = doc.createElement('div');
  canvasHost.className = 'mica-schematic__canvas-host';

  const canvas = doc.createElement('canvas');
  canvas.className = 'mica-schematic__canvas';
  canvasHost.append(canvas);

  root.append(canvasHost);

  const toolButtons = new Map<EditorTool, HTMLButtonElement>();
  if (options.toolbar) {
    const toolbar = doc.createElement('div');
    toolbar.className = 'mica-schematic__toolbar';
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
    root.append(toolbar);
  } else {
    root.classList.add('mica-schematic--no-toolbar');
  }

  return {
    root,
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
