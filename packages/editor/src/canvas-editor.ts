import type { Event } from '@mica-js/core/lifecycle';
import type { CanvasCommand, CanvasDocument } from '@mica-js/document/canvas';
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
import { ICanvasConfiguration, CanvasSession, ICanvasSession } from './canvas/session';
import { CanvasRuntimeFactory, ICanvasRuntimeFactory } from './canvas/runtime-factory';
import { CanvasDocumentService, ICanvasDocumentService } from './canvas/document';
import { createCanvasView } from './canvas/view';
import './canvas/styles.css';

export interface ICanvasEditorOptions {
  readonly container: HTMLElement;
  readonly uri: string;
  readonly fileSystem: IFileSystemProvider;
  readonly deviceLibrary: IDeviceLibrary;
  readonly widgetLibrary: IWidgetLibrary;
  readonly readOnly?: boolean;
}

export interface ICanvasEditor {
  readonly uri: string;
  readonly state: EditorState;
  readonly onDidChangeContent: Event<CanvasDocument>;
  executeCommand(id: string, ...args: readonly unknown[]): Promise<unknown>;
  dispose(): Promise<void>;
}

export async function createCanvasEditor(options: ICanvasEditorOptions): Promise<ICanvasEditor> {
  const uri = new URL(options.uri).href;
  const services = new ServiceCollection();
  services.set(IFileSystemProvider, options.fileSystem);
  services.set(IDeviceLibrary, options.deviceLibrary);
  services.set(IWidgetLibrary, options.widgetLibrary);
  services.set(ICanvasConfiguration, { uri, container: options.container });
  services.set(ICommandService, new SyncDescriptor(Commands));
  services.set(IDeviceLibraryResolver, new SyncDescriptor(DeviceLibraryResolver));
  services.set(IWidgetLibraryResolver, new SyncDescriptor(WidgetLibraryResolver));
  services.set(ICanvasRuntimeFactory, new SyncDescriptor(CanvasRuntimeFactory));
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
    });
    const mountedView = view;
    repaint = session.onDidRender(() => mountedView.render());
    const commands = scope.get(ICommandService);
    const assertWritable = () => {
      if (readOnly) throw new Error('Canvas editor is read-only.');
      if (session.mode !== 'edit')
        throw new Error('Switch to edit mode before changing the canvas.');
    };
    commands.register({
      id: 'canvas.apply',
      execute: (command) => {
        assertWritable();
        return document.apply(command as CanvasCommand);
      },
    });
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
      execute: async (mode) => {
        await document.model.whenIdle();
        return session.setMode(mode as 'edit' | 'simulation');
      },
    });
    commands.register({ id: 'canvas.run', execute: () => session.run() });
    commands.register({ id: 'canvas.pause', execute: () => session.pause() });
    commands.register({ id: 'canvas.step', execute: () => session.step() });
    commands.register({ id: 'canvas.reset', execute: () => session.reset() });
    commands.register({ id: 'canvas.status', execute: () => session.status });
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
      onDidChangeContent: document.model.onDidChangeContent,
      async executeCommand(id, ...args) {
        if (state !== 'ready') throw new Error('Canvas editor is disposed.');
        const pending = execution.then(() => {
          if (state !== 'ready') throw new Error('Canvas editor is disposed.');
          return commands.execute(id, ...args);
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
