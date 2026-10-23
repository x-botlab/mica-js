import type { CanvasBindingTarget, CanvasCommand, CanvasDocument } from '@mica-js/core/canvas';
import type { WidgetDiagnostic, WidgetHost, WidgetPublish } from '@mica-js/widget';
import { mountCanvasEditor } from './editor/mount';
import type { CanvasTheme } from './theme';
import type { CanvasEditorDiagnostic, CanvasMode } from './types';

/** Scene-owned diagnostic codes; every one of them carries the `canvas-scene/` prefix. */
export type CanvasSceneDiagnosticCode =
  | 'canvas-scene/command-failed'
  | 'canvas-scene/change-failed'
  | 'canvas-scene/publish-failed'
  | 'canvas-scene/unbound-publish';

/** A problem the scene survives; the editor, the host and the listeners keep running. */
export interface CanvasSceneFailure {
  readonly code: CanvasSceneDiagnosticCode;
  readonly message: string;
  readonly instanceId?: string;
  readonly cause?: unknown;
}

export type CanvasSceneDiagnostic = CanvasEditorDiagnostic | WidgetDiagnostic | CanvasSceneFailure;

export type CanvasScenePublishListener = (
  target: CanvasBindingTarget,
  payload: unknown,
  simTime: number,
) => void;

/**
 * `WidgetHost` plus the publish subscription some hosts offer. `WidgetHostOptions.onPublish` is
 * the only publish hook of a real host and it accepts exactly one callback, so a host that keeps
 * it at construction time forwards to {@link CanvasScene.receivePublish} instead.
 */
export interface CanvasSceneHost extends WidgetHost {
  onPublish?(listener: (publish: WidgetPublish) => void): () => void;
}

export interface CreateCanvasSceneOptions {
  readonly container: HTMLElement;
  /** `.cnv` text or an already parsed document. */
  readonly document: string | CanvasDocument;
  /** Runtime built by the host (see x-botlab/mica-js#118); the scene never owns it. */
  readonly host: WidgetHost;
  /** Defaults to `'edit'`. */
  readonly mode?: CanvasMode;
  /** Called after every committed document change, so the host can persist the `.cnv`. */
  readonly onChange?: (document: CanvasDocument) => void;
  readonly onSelectionChange?: (ids: readonly string[]) => void;
  readonly onDiagnostic?: (diagnostic: CanvasSceneDiagnostic) => void;
  readonly theme?: Partial<CanvasTheme>;
}

export interface CanvasScene {
  readonly document: CanvasDocument;
  readonly mode: CanvasMode;
  /** Drops the interaction in flight before entering run mode; a rejected switch keeps the mode. */
  setMode(mode: CanvasMode): void;
  /** Simulation side → widgets: forwards to every instance bound to `target`. */
  deliver(target: CanvasBindingTarget, payload: unknown, simTime: number): void;
  /** Widget → simulation side; the returned function unsubscribes. */
  onPublish(listener: CanvasScenePublishListener): () => void;
  /**
   * Feeds one publish of a host created with `WidgetHostOptions.onPublish`; hosts that offer a
   * publish subscription hand their payloads over through it automatically.
   */
  receivePublish(publish: WidgetPublish): void;
  destroy(): void;
}

/**
 * Mounts the editor over a loaded document and wires it to the widget host: commands go down,
 * snapshots come back, and publishes are resolved to their bound endpoints.
 *
 * @throws {SchematicError} when the host rejects `options.document`; no editor is mounted then.
 */
export async function createCanvasScene(options: CreateCanvasSceneOptions): Promise<CanvasScene> {
  const { host } = options;
  await host.loadDocument(options.document);

  let snapshot: CanvasDocument = host.document;
  let mode: CanvasMode = options.mode ?? 'edit';
  let destroyed = false;
  let unsubscribeHostPublish: (() => void) | undefined;
  const publishListeners = new Set<CanvasScenePublishListener>();

  function report(diagnostic: CanvasSceneDiagnostic): void {
    try {
      options.onDiagnostic?.(diagnostic);
    } catch {
      // A throwing diagnostic sink must not break the scene.
    }
  }

  /**
   * Makes `next` the snapshot the editor draws. The reference check is what keeps a command from
   * being adopted twice: the host notifies `onDocumentChange` synchronously, and the command
   * handler adopts `host.document` afterwards.
   */
  function adopt(next: CanvasDocument): void {
    if (destroyed || next === snapshot) {
      return;
    }
    snapshot = next;
    editor.setDocument(next);
    if (options.onChange === undefined) {
      return;
    }
    try {
      options.onChange(next);
    } catch (error) {
      report({
        code: 'canvas-scene/change-failed',
        message: 'onChange threw.',
        cause: error,
      });
    }
  }

  function handleCommand(command: CanvasCommand): void {
    try {
      host.applyCommand(command);
    } catch (error) {
      // The host kept its old snapshot, so the editor must keep drawing it.
      report({
        code: 'canvas-scene/command-failed',
        message: `The host rejected "${command.type}": ${describeError(error)}`,
        cause: error,
      });
      return;
    }
    adopt(host.document);
  }

  function deliver(target: CanvasBindingTarget, payload: unknown, simTime: number): void {
    if (destroyed) {
      return;
    }
    for (const instance of snapshot.widgets) {
      const bindings = instance.bindings;
      if (bindings === undefined) {
        continue;
      }
      for (const port of Object.keys(bindings)) {
        const bound = bindings[port];
        if (bound === undefined || bound.symbol !== target.symbol || bound.port !== target.port) {
          continue;
        }
        host.deliver(instance.id, port, payload, simTime);
      }
    }
  }

  function receivePublish(publish: WidgetPublish): void {
    if (destroyed) {
      return;
    }
    const target = snapshot.widgets.find((instance) => instance.id === publish.instanceId)
      ?.bindings?.[publish.port];
    if (target === undefined) {
      report({
        code: 'canvas-scene/unbound-publish',
        instanceId: publish.instanceId,
        message: `Instance "${publish.instanceId}" published "${publish.port}", which has no binding.`,
      });
      return;
    }
    for (const listener of [...publishListeners]) {
      try {
        listener(target, publish.payload, publish.simTime);
      } catch (error) {
        report({
          code: 'canvas-scene/publish-failed',
          message: 'A publish listener threw.',
          instanceId: publish.instanceId,
          cause: error,
        });
      }
    }
  }

  function setMode(next: CanvasMode): void {
    if (destroyed || next === mode) {
      return;
    }
    if (next === 'run') {
      // A gesture started in edit mode must not spill a command into the run mode.
      editor.cancelInteraction();
    }
    editor.setMode(next);
    mode = next;
  }

  function onPublish(listener: CanvasScenePublishListener): () => void {
    if (destroyed) {
      return () => {};
    }
    publishListeners.add(listener);
    return () => {
      publishListeners.delete(listener);
    };
  }

  function destroy(): void {
    if (destroyed) {
      return;
    }
    destroyed = true;
    editor.destroy();
    unsubscribeDocumentChange();
    unsubscribeHostPublish?.();
    publishListeners.clear();
  }

  const editor = mountCanvasEditor({
    container: options.container,
    document: snapshot,
    layers: host.layers,
    mode,
    onCommand: handleCommand,
    dispatch: (instanceId, event) => host.dispatch(instanceId, event),
    onDiagnostic: report,
    ...(options.onSelectionChange === undefined
      ? {}
      : { onSelectionChange: options.onSelectionChange }),
    ...(options.theme === undefined ? {} : { theme: options.theme }),
  });
  const unsubscribeDocumentChange = host.onDocumentChange(adopt);

  // `WidgetHost` has no publish subscription; a host that offers one is wired here, and the rest
  // of the world forwards through `receivePublish`.
  const publishHost = host as CanvasSceneHost;
  if (typeof publishHost.onPublish === 'function') {
    unsubscribeHostPublish = publishHost.onPublish(receivePublish);
  }

  return {
    get document() {
      return snapshot;
    },
    get mode() {
      return mode;
    },
    setMode,
    deliver,
    onPublish,
    receivePublish,
    destroy,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
