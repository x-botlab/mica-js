import type {
  DesignatorFactory,
  DeviceSymbolProvider,
  Point,
  SchematicDocument,
  SchematicError,
} from '@mica-js/core/schematic';
import { serializeSchematic } from '@mica-js/core/schematic';
import { SchematicEditorController } from '../controller/controller';
import { sameSelection } from '../controller/selection';
import type {
  DisplayOptions,
  EditorRenderState,
  EditorSelection,
  EditorState,
  EditorTool,
} from '../controller/types';
import { CanvasSchematicRenderer } from '../render/canvas-renderer';
import { buildSchematicScene } from '../render/scene';
import { resolveSchematicTheme, themeToCssVariables, type SchematicTheme } from '../render/theme';
import {
  resolveViewportLimits,
  clampViewport,
  pageToScreen,
  screenToPage,
  type ViewportLimits,
  type ViewportState,
} from '../render/viewport';
import { EditorInput } from './interactions/input';
import { toSceneHighlight } from './scene-input';
import { createShell } from './shell';
import { EditorViewport } from './viewport-state';

export interface MountSchematicEditorOptions {
  /** Caller-provided container; the editor only appends and removes its own root. */
  readonly container: HTMLElement;
  readonly schematic: SchematicDocument;
  readonly devices?: DeviceSymbolProvider;
  readonly theme?: Partial<SchematicTheme>;
  readonly display?: Partial<DisplayOptions>;
  readonly tolerance?: number;
  readonly historyLimit?: number;
  /** Reference designator policy; defaults to the device's `designatorPrefix`, then `U`. */
  readonly createDesignator?: DesignatorFactory;
  /** Zoom range for wheel, fit and `zoomTo`; defaults to 0.25×–4×. */
  readonly zoomLimits?: Partial<ViewportLimits>;
  /** Disables the built-in interactions; the controller stays writable. */
  readonly readOnly?: boolean;
  /** Renders the floating tool strip in the canvas corner; defaults to true. */
  readonly toolbar?: boolean;
  readonly onChange?: (state: EditorState) => void;
  readonly onSelectionChange?: (selection: readonly EditorSelection[]) => void;
  readonly onToolChange?: (tool: EditorTool) => void;
  /** Fires whenever the last edit error changes; `undefined` once an edit succeeds. */
  readonly onError?: (error: SchematicError | undefined) => void;
  /** Fires on wheel/pan/fit/`zoomTo`/`setViewport` and when auto fit re-runs. */
  readonly onViewportChange?: (viewport: ViewportState) => void;
}

export interface MountedSchematicEditor {
  readonly controller: SchematicEditorController;
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;

  /**
   * Loads another document. By default history and selection start over; `keepHistory` records
   * the swap as one undoable edit instead.
   */
  setSchematic(document: SchematicDocument, options?: { readonly keepHistory?: boolean }): void;
  setTheme(theme: Partial<SchematicTheme>): void;
  getTheme(): SchematicTheme;
  setDisplayOptions(patch: Partial<DisplayOptions>): void;
  setTool(tool: EditorTool): void;
  /**
   * Arms placement of `device`: the next canvas click inserts it. Hosts drive this from their own
   * device list, so the editor never needs to know where the parts come from.
   *
   * @throws {SchematicError} when the device reference is malformed.
   */
  placeDevice(device: string): void;
  /** Disarms a pending placement without touching the document. */
  cancelPlacement(): void;
  fitToContent(): void;
  zoomTo(scale: number): void;
  /** Current zoom/pan; safe to persist and hand back to {@link setViewport}. */
  getViewport(): ViewportState;
  /** Restores a saved viewport; the scale is clamped to `zoomLimits` around the canvas centre. */
  setViewport(viewport: ViewportState): void;
  /** Serializes the current document as `.sch` JSON. */
  toJSON(): string;
  /** Moves keyboard focus to the canvas surface; call after host toolbar interactions. */
  focus(): void;
  /** Canvas-relative client coordinates → page coordinates (for host overlays). */
  toPage(clientPoint: Point): Point;
  /** Page coordinates → canvas-relative CSS pixels (for host overlays). */
  toScreen(pagePoint: Point): Point;
  /** Re-measures the container; call after showing a previously hidden editor. */
  resize(): void;
  /** Repaints without touching layout (e.g. after a device-pixel-ratio change). */
  invalidate(): void;
  undo(): void;
  redo(): void;
  /** Removes the DOM and listeners created by the editor, keeping the container contents. */
  dispose(): void;
}

/** Mounts a canvas schematic editor inside `options.container`. */
export function mountSchematicEditor(options: MountSchematicEditorOptions): MountedSchematicEditor {
  const doc = options.container.ownerDocument;
  const readOnly = options.readOnly ?? false;

  const controller = new SchematicEditorController({
    document: options.schematic,
    ...(options.devices === undefined ? {} : { devices: options.devices }),
    ...(options.display === undefined ? {} : { display: options.display }),
    ...(options.tolerance === undefined ? {} : { tolerance: options.tolerance }),
    ...(options.historyLimit === undefined ? {} : { historyLimit: options.historyLimit }),
    ...(options.createDesignator === undefined
      ? {}
      : { createDesignator: options.createDesignator }),
  });

  const shell = createShell({
    document: doc,
    readOnly,
    toolbar: options.toolbar !== false,
    onToolClick: (tool) => {
      controller.setTool(controller.getTool() === tool ? 'select' : tool);
      shell.root.focus();
    },
  });

  const viewport = new EditorViewport(resolveViewportLimits(options.zoomLimits));
  const renderer = new CanvasSchematicRenderer(shell.canvas, {
    theme: resolveSchematicTheme(options.theme),
  });
  let theme = resolveSchematicTheme(options.theme);
  let disposed = false;
  let lastSelection: readonly EditorSelection[] = [];
  let lastTool: EditorTool = controller.getTool();
  let lastPlacing: string | undefined = controller.getPlacingDevice();
  let lastError: SchematicError | undefined = controller.getState().lastError;
  let lastViewport: ViewportState | undefined = viewport.state;

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
      // Errors surface through `state.lastError` / `onError`; the document stays untouched.
    }
  }

  function applyTheme(): void {
    for (const [name, value] of Object.entries(themeToCssVariables(theme))) {
      shell.root.style.setProperty(name, value);
    }
    renderer.setTheme(theme);
  }

  function render(state: EditorRenderState = controller.getRenderState()): void {
    if (disposed) {
      return;
    }
    const scene = buildSchematicScene({
      document: state.document,
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
        gridSubdivisions: state.display.gridSubdivisions,
      },
      ...(input.pendingWire.length === 0 ? {} : { pendingWire: input.pendingWireWithCursor }),
      ...(input.marquee === undefined ? {} : { marquee: input.marquee }),
      ...(input.placementPreview === undefined ? {} : { placementPreview: input.placementPreview }),
      ...(input.referencePreview === undefined ? {} : { referencePreview: input.referencePreview }),
      ...(input.wirePreview === undefined ? {} : { wirePreview: input.wirePreview }),
    });
    renderer.render(scene, viewport.state);
    if (!sameViewport(viewport.state, lastViewport)) {
      lastViewport = viewport.state;
      options.onViewportChange?.(viewport.state);
    }
  }

  function sync(state: EditorState): void {
    shell.setToolActive(state.tool);
    shell.canvas.style.cursor =
      state.tool === 'select' && state.placingDevice === undefined ? 'default' : 'crosshair';
    if (state.lastError !== lastError) {
      lastError = state.lastError;
      options.onError?.(state.lastError);
    }
    if (state.tool !== lastTool || state.placingDevice !== lastPlacing) {
      lastTool = state.tool;
      lastPlacing = state.placingDevice;
      input.resetTransient();
      options.onToolChange?.(state.tool);
    }
    if (!sameSelection(state.selection, lastSelection)) {
      lastSelection = state.selection;
      options.onSelectionChange?.(state.selection);
    }
    options.onChange?.(state);
    // The state came from this emit: reuse it instead of building another one for the repaint.
    render(state);
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
  sync(controller.getState());

  const resizeObserver = new ResizeObserver(() => resize());
  resizeObserver.observe(shell.canvasHost);
  options.container.append(shell.root);
  resize();

  return {
    controller,
    root: shell.root,
    canvas: shell.canvas,
    setSchematic(document: SchematicDocument, setOptions: { keepHistory?: boolean } = {}): void {
      if (setOptions.keepHistory === true) {
        run(() => controller.replace(document));
        return;
      }
      controller.reset(document);
      fitToContent();
    },
    setTheme(next: Partial<SchematicTheme>): void {
      theme = resolveSchematicTheme(next);
      applyTheme();
      render();
    },
    getTheme(): SchematicTheme {
      return theme;
    },
    setDisplayOptions(patch: Partial<DisplayOptions>): void {
      controller.setDisplayOptions(patch);
    },
    setTool(tool: EditorTool): void {
      controller.setTool(tool);
    },
    placeDevice(device: string): void {
      // Read-only editors cannot place: the canvas would have nowhere to commit the symbol.
      if (readOnly) {
        return;
      }
      controller.placeDevice(device);
      shell.root.focus();
    },
    cancelPlacement(): void {
      controller.cancelPlacement();
    },
    fitToContent,
    zoomTo(scale: number): void {
      viewport.zoomTo(scale, {
        x: shell.canvasHost.clientWidth / 2,
        y: shell.canvasHost.clientHeight / 2,
      });
      render();
    },
    getViewport(): ViewportState {
      return viewport.state;
    },
    setViewport(next: ViewportState): void {
      viewport.setState(
        clampViewport(
          next,
          { width: shell.canvasHost.clientWidth, height: shell.canvasHost.clientHeight },
          viewport.limits,
        ),
      );
      render();
    },
    toJSON(): string {
      return serializeSchematic(controller.getDocument());
    },
    focus(): void {
      shell.root.focus();
    },
    toPage(clientPoint: Point): Point {
      const rect = shell.canvas.getBoundingClientRect();
      return screenToPage(viewport.state, {
        x: clientPoint.x - rect.left,
        y: clientPoint.y - rect.top,
      });
    },
    toScreen(pagePoint: Point): Point {
      return pageToScreen(viewport.state, pagePoint);
    },
    resize,
    invalidate: render,
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

function sameViewport(left: ViewportState, right: ViewportState | undefined): boolean {
  return (
    right !== undefined &&
    left.scale === right.scale &&
    left.offsetX === right.offsetX &&
    left.offsetY === right.offsetY
  );
}
