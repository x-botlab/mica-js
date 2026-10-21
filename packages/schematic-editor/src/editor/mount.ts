import type {
  DeviceSymbolProvider,
  SchematicDocument,
  SchematicViewDocument,
} from '@mica/core/schematic';
import { SchematicEditorController } from '../controller/controller';
import { sameSelection } from '../controller/selection';
import type { DisplayOptions, EditorSelection, EditorState, EditorTool } from '../controller/types';
import { PropertyPanel } from '../panel/property-panel';
import { CanvasSchematicRenderer } from '../render/canvas-renderer';
import { buildSchematicScene } from '../render/scene';
import { resolveSchematicTheme, themeToCssVariables, type SchematicTheme } from '../render/theme';
import { EditorInput } from './input';
import { toSceneHighlight } from './scene-input';
import { createShell } from './shell';
import { EditorViewport } from './viewport-state';

export interface MountSchematicEditorOptions {
  /** Caller-provided container; the editor only appends and removes its own root. */
  readonly container: HTMLElement;
  readonly schematic: SchematicDocument;
  readonly view?: SchematicViewDocument;
  readonly devices?: DeviceSymbolProvider;
  readonly theme?: Partial<SchematicTheme>;
  readonly display?: Partial<DisplayOptions>;
  readonly tolerance?: number;
  readonly historyLimit?: number;
  /** Disables the built-in interactions and property editing; the controller stays writable. */
  readonly readOnly?: boolean;
  /** Defaults to true. */
  readonly toolbar?: boolean;
  /** Defaults to true; the right-hand inspector column. */
  readonly propertiesPanel?: boolean;
  readonly onChange?: (state: EditorState) => void;
  readonly onSelectionChange?: (selection: readonly EditorSelection[]) => void;
  readonly onToolChange?: (tool: EditorTool) => void;
}

export interface MountedSchematicEditor {
  readonly controller: SchematicEditorController;
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly propertiesPanel: HTMLElement;

  setSchematic(document: SchematicDocument): void;
  setView(view: SchematicViewDocument | undefined): void;
  setTheme(theme: Partial<SchematicTheme>): void;
  setDisplayOptions(patch: Partial<DisplayOptions>): void;
  setTool(tool: EditorTool): void;
  fitToContent(): void;
  zoomTo(scale: number): void;
  undo(): void;
  redo(): void;
  /** Removes the DOM and listeners created by the editor, keeping the container contents. */
  dispose(): void;
}

/** Mounts a canvas schematic editor inside `options.container`. */
export function mountSchematicEditor(options: MountSchematicEditorOptions): MountedSchematicEditor {
  const doc = options.container.ownerDocument;
  const readOnly = options.readOnly ?? false;
  const showPanel = options.propertiesPanel !== false;

  const controller = new SchematicEditorController({
    document: options.schematic,
    ...(options.view === undefined ? {} : { view: options.view }),
    ...(options.devices === undefined ? {} : { devices: options.devices }),
    ...(options.display === undefined ? {} : { display: options.display }),
    ...(options.tolerance === undefined ? {} : { tolerance: options.tolerance }),
    ...(options.historyLimit === undefined ? {} : { historyLimit: options.historyLimit }),
  });

  const shell = createShell({
    document: doc,
    readOnly,
    toolbar: options.toolbar !== false,
    propertiesPanel: showPanel,
    onToolClick: (tool) => {
      controller.setTool(controller.tool === tool ? 'select' : tool);
      shell.root.focus();
    },
  });

  const panel = new PropertyPanel({
    readOnly,
    onPropertyChange: (symbolId, key, value) => {
      if (!readOnly) {
        run(() => controller.setSymbolProperty(symbolId, key, value));
      }
    },
    onPropertyReset: (symbolId, key) => {
      if (!readOnly) {
        run(() => controller.removeSymbolProperty(symbolId, key));
      }
    },
    onDesignatorChange: (symbolId, next) => {
      if (!readOnly) {
        run(() => controller.renameDesignator(symbolId, next));
      }
    },
    onNetChange: (symbolId, next) => {
      if (!readOnly) {
        run(() => controller.renameNet(symbolId, next));
      }
    },
  });
  if (showPanel) {
    shell.root.append(panel.element);
  }

  const viewport = new EditorViewport();
  const renderer = new CanvasSchematicRenderer(shell.canvas, {
    theme: resolveSchematicTheme(options.theme),
  });
  let theme = resolveSchematicTheme(options.theme);
  let disposed = false;
  let lastSelection: readonly EditorSelection[] = [];
  let lastTool: EditorTool = controller.tool;

  const input = new EditorInput({
    controller,
    devices: options.devices,
    viewport,
    root: shell.root,
    canvas: shell.canvas,
    readOnly,
    onChange: () => {
      render();
    },
    onFit: () => {
      fitToContent();
    },
    run: (edit) => {
      run(edit);
    },
  });

  function run(edit: () => void): void {
    try {
      edit();
    } catch {
      // Errors surface through `state.lastError` and the toast; the document stays untouched.
    }
  }

  function applyTheme(): void {
    for (const [name, value] of Object.entries(themeToCssVariables(theme))) {
      shell.root.style.setProperty(name, value);
    }
    renderer.setTheme(theme);
  }

  function render(): void {
    if (disposed) {
      return;
    }
    const state = controller.state;
    const scene = buildSchematicScene({
      document: state.document,
      ...(state.view === undefined ? {} : { view: state.view }),
      ...(options.devices === undefined ? {} : { devices: options.devices }),
      theme,
      selection: {
        ...toSceneHighlight(state.selection),
        ...(input.dragOffset === undefined ? {} : { offset: input.dragOffset }),
      },
      ...(input.hover === undefined ? {} : { hover: input.hover }),
      tool: state.tool,
      display: {
        grid: state.display.grid,
        labels: state.display.labels,
        gridSize: state.display.gridSize,
      },
      ...(input.pendingWire.length === 0 ? {} : { pendingWire: input.pendingWireWithCursor }),
      ...(input.marquee === undefined ? {} : { marquee: input.marquee }),
      ...(input.placementPreview === undefined ? {} : { placementPreview: input.placementPreview }),
      ...(input.referencePreview === undefined ? {} : { referencePreview: input.referencePreview }),
    });
    renderer.render(scene, viewport.state);
  }

  function sync(state: EditorState): void {
    panel.update(state.inspector);
    shell.setToolActive(state.tool);
    shell.canvas.style.cursor = state.tool === 'select' ? 'default' : 'crosshair';
    shell.toast.textContent = state.lastError?.message ?? '';
    shell.toast.hidden = state.lastError === undefined;
    if (state.tool !== lastTool) {
      lastTool = state.tool;
      input.resetTransient();
      options.onToolChange?.(state.tool);
    }
    if (!sameSelection(state.selection, lastSelection)) {
      lastSelection = state.selection;
      options.onSelectionChange?.(state.selection);
    }
    options.onChange?.(state);
    render();
  }

  function resize(): void {
    const width = shell.canvasHost.clientWidth;
    const height = shell.canvasHost.clientHeight;
    if (width === 0 || height === 0) {
      return;
    }
    renderer.resize(width, height, Math.max(1, window.devicePixelRatio || 1));
    if (viewport.autoFit) {
      fitToContent();
      return;
    }
    render();
  }

  function fitToContent(): void {
    viewport.fit(controller.topology().bounds, {
      width: shell.canvasHost.clientWidth,
      height: shell.canvasHost.clientHeight,
    });
    render();
  }

  const unsubscribe = controller.subscribe(sync);
  applyTheme();
  input.attach();
  sync(controller.state);

  const resizeObserver = new ResizeObserver(() => resize());
  resizeObserver.observe(shell.canvasHost);
  options.container.append(shell.root);
  resize();

  return {
    controller,
    root: shell.root,
    canvas: shell.canvas,
    propertiesPanel: panel.element,
    setSchematic(document: SchematicDocument): void {
      controller.reset(document);
      fitToContent();
    },
    setView(view: SchematicViewDocument | undefined): void {
      controller.setView(view);
    },
    setTheme(next: Partial<SchematicTheme>): void {
      theme = resolveSchematicTheme(next);
      applyTheme();
      render();
    },
    setDisplayOptions(patch: Partial<DisplayOptions>): void {
      controller.setDisplayOptions(patch);
    },
    setTool(tool: EditorTool): void {
      controller.setTool(tool);
    },
    fitToContent,
    zoomTo(scale: number): void {
      viewport.zoomTo(scale, {
        x: shell.canvasHost.clientWidth / 2,
        y: shell.canvasHost.clientHeight / 2,
      });
      render();
    },
    undo(): void {
      controller.undo();
    },
    redo(): void {
      controller.redo();
    },
    dispose(): void {
      disposed = true;
      unsubscribe();
      resizeObserver.disconnect();
      input.detach();
      renderer.destroy();
      shell.root.remove();
    },
  };
}
