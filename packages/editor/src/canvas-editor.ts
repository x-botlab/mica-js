import { DisposableStore, Emitter, type Event } from '@mica-js/core/lifecycle';
import {
  applyCanvasCommand,
  type CanvasCommand,
  type CanvasDocument,
} from '@mica-js/document/canvas';
import type { ISimulationMessage } from '@mica-js/simulator';
import type { IWidgetFrame } from '@mica-js/widget';
import type {
  EditorCommandArgs,
  IEditorErrorEvent,
  IEditorIntegrationState,
  IEditorPointerEvent,
  IEditorProperty,
} from './host';
import type { ICanvasCommandMap } from './canvas-commands';
import {
  canvasSnapshot,
  type ICanvasBindingInfo,
  type ICanvasRenderObserver,
  type ICanvasTarget,
  type ICanvasTopicMessageSample,
  type ICanvasWidgetFrameSample,
} from './canvas-host';
export type { ICanvasCommandMap } from './canvas-commands';
export type {
  ICanvasTarget,
  ICanvasBindingInfo,
  ICanvasBindingCandidate,
  ICanvasRenderSample,
  ICanvasRenderObserver,
  ICanvasWidgetFrameSample,
  ICanvasTopicMessageSample,
} from './canvas-host';
import { Commands, ICommandService } from './commands';
import type { EditorState } from './editor';
import { InstantiationService, ServiceCollection, SyncDescriptor } from './instantiation';
import { IDeviceLibrary, IFileSystemProvider, IWidgetLibrary } from './provider-services';
import {
  DeviceLibraryResolver,
  IDeviceLibraryResolver,
  WidgetLibraryResolver,
  IWidgetLibraryResolver,
} from './libraries';
import {
  ICanvasConfiguration,
  CanvasSession,
  ICanvasSession,
  type ICanvasAdvanceObserver,
} from './canvas/session';
import {
  CanvasRuntimeFactory,
  ICanvasRuntimeFactory,
  type ICanvasRuntimes,
} from './canvas/runtime-factory';
import { CanvasDocumentService, ICanvasDocumentService } from './canvas/document';
import { createCanvasView } from './canvas/view';
import './canvas/styles.css';

/**
 * Optional low-overhead sinks for browser-side measurement.
 *
 * Every sink is synchronous and purely additive: the canvas session still awaits the same tick and
 * widget steps, and the runtime keeps delivering topic traffic over its existing channel.
 */
export interface ICanvasEditorMeasurement {
  /** Completed advance rounds from the canvas session. */
  readonly advance?: ICanvasAdvanceObserver;
  /** Called before an advance round starts awaiting its tick. */
  readonly advanceStart?: () => void;
  /** Called after an advance round settles, including when its tick or widget step fails. */
  readonly advanceSettled?: () => void;
  /** Whole-surface paints on the host thread. */
  readonly render?: ICanvasRenderObserver;
  /** Committed widget bitmaps, including the instance and the runtime frame sequence. */
  readonly widgetFrame?: (sample: ICanvasWidgetFrameSample) => void;
  /** Device publications already crossing the widget topic bridge. */
  readonly topic?: (message: ICanvasTopicMessageSample) => void;
}

export interface ICanvasEditorOptions {
  readonly container: HTMLElement;
  readonly uri: string;
  readonly fileSystem: IFileSystemProvider;
  readonly deviceLibrary: IDeviceLibrary;
  readonly widgetLibrary: IWidgetLibrary;
  /** Simulation step and target frame period in milliseconds; defaults to 20. */
  readonly stepMs?: number;
  /** CPU execution mode; defaults to the simulator's throughput mode. */
  readonly execution?: 'throughput' | 'precise';
  readonly readOnly?: boolean;
  /** Fixed board voltages by exact schematic net name; ignored without a schematic. Ground stays zero. */
  readonly voltageReferences?: Readonly<Record<string, number>>;
  readonly projectRoot?: string;
  /** Optional measurement sinks; omitted means no timing or event sampling is installed. */
  readonly measurement?: ICanvasEditorMeasurement;
}

/** Wraps the existing runtime factory so measurement taps the same events it already exposes. */
function measurementRuntimeFactory(
  measurement: ICanvasEditorMeasurement,
  reportError: (source: 'runtime', error: unknown) => void,
): ICanvasRuntimeFactory {
  const base = new CanvasRuntimeFactory();
  return {
    async create(container: HTMLElement): Promise<ICanvasRuntimes> {
      const runtimes = await base.create(container);
      const subscriptions = new DisposableStore();
      const tap = (run: () => void): void => {
        try {
          run();
        } catch (error) {
          reportError('runtime', error);
        }
      };
      const widgetFrame = measurement.widgetFrame;
      if (widgetFrame !== undefined) {
        subscriptions.add(
          runtimes.widgets.onDidRender((frame: IWidgetFrame) => {
            tap(() =>
              widgetFrame({
                at: performance.now(),
                instanceId: frame.instanceId,
                sequence: frame.sequence,
                width: frame.width,
                height: frame.height,
                dpr: frame.dpr,
              }),
            );
          }),
        );
      }
      const topic = measurement.topic;
      if (topic !== undefined) {
        subscriptions.add(
          runtimes.simulation.onDidPublish((message: ISimulationMessage) => {
            tap(() =>
              topic({
                at: performance.now(),
                symbol: message.target.symbol,
                port: message.target.port,
                simTime: message.simTime,
                payload: message.payload,
              }),
            );
          }),
        );
      }
      return {
        simulation: runtimes.simulation,
        widgets: runtimes.widgets,
        resumeAudio: () => runtimes.resumeAudio(),
        async dispose() {
          subscriptions.dispose();
          await runtimes.dispose();
        },
      };
    },
  };
}

export interface ICanvasEditor {
  readonly uri: string;
  readonly state: EditorState;
  readonly onDidChangeContent: Event<CanvasDocument>;
  getDocument(): CanvasDocument;
  getSelection(): readonly ICanvasTarget[];
  setSelection(selection: readonly ICanvasTarget[]): void;
  readonly onDidChangeSelection: Event<readonly ICanvasTarget[]>;
  readonly onDidClick: Event<IEditorPointerEvent<ICanvasTarget>>;
  readonly onDidDoubleClick: Event<IEditorPointerEvent<ICanvasTarget>>;
  readonly onDidContextMenu: Event<IEditorPointerEvent<ICanvasTarget>>;
  getProperties(instanceId: string): readonly IEditorProperty[];
  getBindings(instanceId: string): readonly ICanvasBindingInfo[];
  getState(): IEditorIntegrationState;
  readonly onDidChangeState: Event<IEditorIntegrationState>;
  readonly onDidError: Event<IEditorErrorEvent>;
  executeCommand<K extends keyof ICanvasCommandMap>(
    id: K,
    ...args: EditorCommandArgs<ICanvasCommandMap[K]>
  ): Promise<ICanvasCommandMap[K]['result']>;
  dispose(): Promise<void>;
}

export async function createCanvasEditor(options: ICanvasEditorOptions): Promise<ICanvasEditor> {
  const references = options.voltageReferences;
  if (
    references !== undefined &&
    (references === null ||
      typeof references !== 'object' ||
      (Object.getPrototypeOf(references) !== Object.prototype &&
        Object.getPrototypeOf(references) !== null) ||
      Reflect.ownKeys(references).some(
        (name) =>
          typeof name !== 'string' ||
          name.trim().length === 0 ||
          typeof references[name] !== 'number' ||
          !Number.isFinite(references[name]),
      ))
  ) {
    throw new Error(
      'Expected a plain voltageReferences map with nonempty net names and finite numeric voltages',
    );
  }
  const measurement = options.measurement;
  const uri = new URL(options.uri).href;
  const projectRoot =
    options.projectRoot === undefined ? new URL('.', uri).href : new URL(options.projectRoot).href;
  const root = projectRoot.endsWith('/') ? projectRoot : `${projectRoot}/`;
  const subscriptions = new DisposableStore();
  const content = new Emitter<CanvasDocument>();
  const selection = new Emitter<readonly ICanvasTarget[]>();
  const clicks = new Emitter<IEditorPointerEvent<ICanvasTarget>>();
  const doubleClicks = new Emitter<IEditorPointerEvent<ICanvasTarget>>();
  const contextMenus = new Emitter<IEditorPointerEvent<ICanvasTarget>>();
  const changes = new Emitter<IEditorIntegrationState>();
  const errors = new Emitter<IEditorErrorEvent>();
  const reportError = (source: IEditorErrorEvent['source'], error: unknown) => {
    let detached: unknown;
    try {
      detached = canvasSnapshot(error);
    } catch {
      detached = new Error('Editor operation failed with an uncloneable error.');
    }
    errors.fire(Object.freeze({ source, error: detached }));
  };
  for (const emitter of [content, selection, clicks, doubleClicks, contextMenus, changes, errors])
    subscriptions.add(emitter);
  const services = new ServiceCollection();
  services.set(IFileSystemProvider, options.fileSystem);
  services.set(IDeviceLibrary, options.deviceLibrary);
  services.set(IWidgetLibrary, options.widgetLibrary);
  services.set(ICanvasConfiguration, {
    uri,
    ...(options.projectRoot === undefined ? {} : { projectRoot: root }),
    container: options.container,
    ...(options.stepMs === undefined ? {} : { stepMs: options.stepMs }),
    ...(options.execution === undefined ? {} : { execution: options.execution }),
    ...(options.voltageReferences === undefined
      ? {}
      : { voltageReferences: Object.freeze(structuredClone(options.voltageReferences)) }),
    ...(measurement?.advance === undefined ? {} : { observer: measurement.advance }),
    ...(measurement?.advanceStart === undefined
      ? {}
      : { onAdvanceStart: measurement.advanceStart }),
    ...(measurement?.advanceSettled === undefined
      ? {}
      : { onAdvanceSettled: measurement.advanceSettled }),
  });
  services.set(ICommandService, new SyncDescriptor(Commands));
  services.set(IDeviceLibraryResolver, new SyncDescriptor(DeviceLibraryResolver));
  services.set(IWidgetLibraryResolver, new SyncDescriptor(WidgetLibraryResolver));
  services.set(
    ICanvasRuntimeFactory,
    measurement?.widgetFrame === undefined && measurement?.topic === undefined
      ? new SyncDescriptor(CanvasRuntimeFactory)
      : measurementRuntimeFactory(measurement, reportError),
  );
  services.set(ICanvasSession, new SyncDescriptor(CanvasSession));
  services.set(ICanvasDocumentService, new SyncDescriptor(CanvasDocumentService));
  const scope = new InstantiationService(services);
  let view: ReturnType<typeof createCanvasView> | undefined;
  let repaint: { dispose(): void } | undefined;
  try {
    const document = scope.get(ICanvasDocumentService);
    await document.initialize();
    const session = scope.get(ICanvasSession);
    const readOnly = options.readOnly ?? false;
    view = createCanvasView({
      container: options.container,
      model: document.model,
      readOnly,
      getFrame: (id) => session.getFrame(id),
      isSimulation: () => session.mode === 'simulation',
      onDispatch: (id, event) => session.dispatch(id, event),
      onError: (error, source = 'render') => reportError(source, error),
      ...(measurement?.render === undefined ? {} : { onRender: measurement.render }),
      onSelectionChange: (value) => selection.fire(canvasSnapshot(value)),
      onClick: (event) => clicks.fire(canvasSnapshot(event)),
      onDoubleClick: (event) => doubleClicks.fire(canvasSnapshot(event)),
      onContextMenu: (event) => contextMenus.fire(canvasSnapshot(event)),
    });
    const mountedView = view;
    repaint = session.onDidRender(() => mountedView.render());
    const commands = scope.get(ICommandService);
    const assertWritable = () => {
      if (readOnly) throw new Error('Canvas editor is read-only.');
      if (session.mode !== 'edit')
        throw new Error('Switch to edit mode before changing the canvas.');
    };
    const register = <K extends keyof ICanvasCommandMap>(
      id: K,
      execute: (params: ICanvasCommandMap[K]['params']) => void | Promise<void>,
    ) => {
      commands.register({
        id,
        execute: (params) => execute(params as ICanvasCommandMap[K]['params']),
      });
    };
    const edit = (command: CanvasCommand) => {
      assertWritable();
      return document.apply(command);
    };
    register('canvas.setProperty', (params) => edit({ type: 'set-property', ...params }));
    register('canvas.removeProperty', (params) => edit({ type: 'unset-property', ...params }));
    register('canvas.setProperties', (params) => {
      assertWritable();
      return document.model.applyMany([
        ...(params.remove ?? []).map((key): CanvasCommand => ({
          type: 'unset-property',
          instanceId: params.instanceId,
          key,
        })),
        ...Object.entries(params.values).map(([key, value]): CanvasCommand => ({
          type: 'set-property',
          instanceId: params.instanceId,
          key,
          value,
        })),
      ]);
    });
    register('canvas.setBinding', (params) => edit({ type: 'set-binding', ...params }));
    register('canvas.setSchematic', ({ path, bindings = 'preserve' }) => {
      assertWritable();
      if (bindings !== 'preserve' && bindings !== 'clear')
        throw new TypeError('Invalid canvas bindings policy.');
      return document.model.transform((current) => {
        const next = applyCanvasCommand(current, { type: 'set-schematic', schematic: path });
        return path === null || bindings === 'clear'
          ? {
              ...next,
              widgets: next.widgets.map((instance) => {
                const copy = { ...instance };
                delete copy.bindings;
                return copy;
              }),
            }
          : next;
      });
    });
    register('canvas.addWidget', ({ instance, z }) =>
      edit({ type: 'add-instance', instance, z: z ?? document.model.document.widgets.length }),
    );
    register('canvas.removeWidget', (params) => edit({ type: 'remove-instance', ...params }));
    register('canvas.setPlacement', (params) => edit({ type: 'set-placement', ...params }));
    register('canvas.setZ', (params) => edit({ type: 'set-z', ...params }));
    commands.register({
      id: 'canvas.undo',
      execute: () => {
        assertWritable();
        return document.undo();
      },
    });
    commands.register({
      id: 'canvas.redo',
      execute: () => {
        assertWritable();
        return document.redo();
      },
    });
    commands.register({
      id: 'canvas.setMode',
      execute: async (params) => {
        await document.model.whenIdle();
        await session.setMode((params as ICanvasCommandMap['canvas.setMode']['params']).mode);
        mountedView.render();
      },
    });
    commands.register({ id: 'canvas.run', execute: () => session.run() });
    commands.register({ id: 'canvas.pause', execute: () => session.pause() });
    commands.register({ id: 'canvas.step', execute: () => session.step() });
    commands.register({ id: 'canvas.reset', execute: () => session.reset() });
    const getState = (): IEditorIntegrationState =>
      canvasSnapshot({
        readOnly,
        mode: session.mode,
        canUndo: !readOnly && session.mode === 'edit' && document.model.canUndo,
        canRedo: !readOnly && session.mode === 'edit' && document.model.canRedo,
        running: session.status.running,
      });
    let previousState = getState();
    const refreshState = () => {
      const next = getState();
      if (JSON.stringify(previousState) === JSON.stringify(next)) return;
      previousState = next;
      changes.fire(next);
    };
    subscriptions.add(
      document.model.onDidChangeContent((value) => {
        content.fire(canvasSnapshot(value));
        refreshState();
      }),
    );
    subscriptions.add(session.onDidChangeState(refreshState));
    subscriptions.add(session.onDidError((error) => reportError('runtime', error)));
    for (const action of ['zoomIn', 'zoomOut', 'resetView', 'fitView'] as const) {
      commands.register({ id: `canvas.${action}`, execute: () => mountedView[action]() });
    }
    let state: EditorState = 'ready';
    let execution: Promise<unknown> = Promise.resolve();
    let disposal: Promise<void> | undefined;
    return {
      uri,
      get state() {
        return state;
      },
      getDocument: () => canvasSnapshot(document.model.document),
      getSelection: () => mountedView.getSelection(),
      setSelection: (value) => mountedView.setSelection(canvasSnapshot(value)),
      getProperties: (instanceId) =>
        session.getProperties(instanceId, readOnly || session.mode !== 'edit'),
      getBindings: (instanceId) => session.getBindings(instanceId),
      getState,
      onDidChangeContent: content.event,
      onDidChangeSelection: selection.event,
      onDidClick: clicks.event,
      onDidDoubleClick: doubleClicks.event,
      onDidContextMenu: contextMenus.event,
      onDidChangeState: changes.event,
      onDidError: errors.event,
      async executeCommand<K extends keyof ICanvasCommandMap>(
        id: K,
        ...args: EditorCommandArgs<ICanvasCommandMap[K]>
      ): Promise<ICanvasCommandMap[K]['result']> {
        if (state !== 'ready') throw new Error('Canvas editor is disposed.');
        const captured = canvasSnapshot(args);
        const pending = execution.then(async () => {
          if (state !== 'ready') throw new Error('Canvas editor is disposed.');
          try {
            return (await commands.execute(id, ...captured)) as ICanvasCommandMap[K]['result'];
          } catch (error) {
            reportError('command', error);
            throw error;
          } finally {
            if (state === 'ready') refreshState();
          }
        });
        execution = pending.catch(() => undefined);
        return pending;
      },
      dispose() {
        if (disposal) return disposal;
        state = 'disposing';
        disposal = Promise.resolve().then(async () => {
          try {
            repaint?.dispose();
            subscriptions.dispose();
            mountedView.dispose();
          } finally {
            try {
              await scope.dispose();
            } finally {
              state = 'disposed';
            }
          }
        });
        return disposal;
      },
    };
  } catch (error) {
    const errors: unknown[] = [error];
    try {
      repaint?.dispose();
      subscriptions.dispose();
      view?.dispose();
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    try {
      await scope.dispose();
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    if (errors.length > 1)
      throw new AggregateError(errors, 'Canvas initialization and cleanup failed.', {
        cause: error,
      });
    throw error;
  }
}
