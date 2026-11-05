import { DisposableStore, Emitter, type Event } from '@mica-js/core/lifecycle';
import type { SchematicDocument } from '@mica-js/document/schematic';
import type {
  EditorCommandArgs,
  IEditorErrorEvent,
  IEditorIntegrationState,
  IEditorPointerEvent,
  IEditorProperty,
} from './host';
import type { ISchematicCommandMap } from './schematic-commands';
import type { SchematicTarget } from './schematic/types';
import { buildInspector } from './schematic/model/inspector';
export type { ISchematicCommandMap } from './schematic-commands';
export type { SchematicTarget } from './schematic/types';
import { createSchematicEditor as createView } from './schematic/editor/schematic-editor';
import type { ISchematicTheme } from './schematic/render/theme';
import './schematic/styles/editor.css';
import type { EditorState } from './editor';
import { editorSnapshot as snapshot } from './snapshot';
import { InstantiationService, ServiceCollection, SyncDescriptor } from './instantiation';
import { DeviceLibraryResolver, IDeviceLibraryResolver } from './libraries';
import { IDeviceLibrary, IFileSystemProvider } from './provider-services';
import { SchematicDevices, ISchematicDevices } from './schematic/devices';
import {
  ISchematicConfiguration,
  ISchematicDocumentService,
  SchematicDocumentService,
} from './schematic/document';

export interface ISchematicEditorOptions {
  readonly container: HTMLElement;
  readonly uri: string;
  readonly fileSystem: IFileSystemProvider;
  readonly deviceLibrary: IDeviceLibrary;
  readonly readOnly?: boolean;
  readonly theme?: Partial<ISchematicTheme>;
}

export interface ISchematicEditor {
  readonly uri: string;
  readonly state: EditorState;
  readonly onDidChangeContent: Event<SchematicDocument>;
  readonly onDidChangeSelection: Event<readonly SchematicTarget[]>;
  readonly onDidClick: Event<IEditorPointerEvent<SchematicTarget>>;
  readonly onDidDoubleClick: Event<IEditorPointerEvent<SchematicTarget>>;
  readonly onDidContextMenu: Event<IEditorPointerEvent<SchematicTarget>>;
  readonly onDidChangeState: Event<IEditorIntegrationState>;
  readonly onDidError: Event<IEditorErrorEvent>;
  getDocument(): SchematicDocument;
  getSelection(): readonly SchematicTarget[];
  setSelection(selection: readonly SchematicTarget[]): void;
  getProperties(symbolId: string): readonly IEditorProperty[];
  getState(): IEditorIntegrationState;
  executeCommand<K extends keyof ISchematicCommandMap>(
    id: K,
    ...args: EditorCommandArgs<ISchematicCommandMap[K]>
  ): Promise<ISchematicCommandMap[K]['result']>;
  dispose(): Promise<void>;
}

/** Loads one document and mounts one schematic view; the returned instance owns all internal services. */
export async function createSchematicEditor(
  options: ISchematicEditorOptions,
): Promise<ISchematicEditor> {
  const uri = new URL(options.uri).href;
  const readOnly = options.readOnly ?? false;
  const services = new ServiceCollection();
  services.set(IFileSystemProvider, options.fileSystem);
  services.set(IDeviceLibrary, options.deviceLibrary);
  services.set(ISchematicConfiguration, { uri });
  services.set(IDeviceLibraryResolver, new SyncDescriptor(DeviceLibraryResolver));
  services.set(ISchematicDevices, new SyncDescriptor(SchematicDevices));
  services.set(ISchematicDocumentService, new SyncDescriptor(SchematicDocumentService));
  const scope = new InstantiationService(services);
  let view: ReturnType<typeof createView> | undefined;
  const subscriptions = new DisposableStore();
  const content = subscriptions.add(new Emitter<SchematicDocument>());
  const selection = subscriptions.add(new Emitter<readonly SchematicTarget[]>());
  const click = subscriptions.add(new Emitter<IEditorPointerEvent<SchematicTarget>>());
  const doubleClick = subscriptions.add(new Emitter<IEditorPointerEvent<SchematicTarget>>());
  const contextMenu = subscriptions.add(new Emitter<IEditorPointerEvent<SchematicTarget>>());
  const stateChanged = subscriptions.add(new Emitter<IEditorIntegrationState>());
  const errors = subscriptions.add(new Emitter<IEditorErrorEvent>());
  try {
    const document = scope.get(ISchematicDocumentService);
    await document.initialize();
    view = createView({
      container: options.container,
      model: document.model,
      prepareDevices: (ids) => scope.get(ISchematicDevices).prepare(ids),
      readOnly,
      onPointerEvent: (kind, event) => {
        const emitter =
          kind === 'click' ? click : kind === 'doubleClick' ? doubleClick : contextMenu;
        emitter.fire(snapshot(event));
      },
      ...(options.theme === undefined ? {} : { theme: options.theme }),
    });
    const mountedView = view;
    const model = document.model;
    let state: EditorState = 'ready';
    let disposal: Promise<void> | undefined;
    let queue: Promise<unknown> = Promise.resolve();
    let executing = false;
    function assertReady(): void {
      if (state !== 'ready') throw new Error('Schematic editor is disposed.');
    }
    const prepare = async (deviceId: string) => {
      await scope.get(ISchematicDevices).prepare([deviceId]);
      assertReady();
    };
    type Handlers = {
      [K in keyof ISchematicCommandMap]: (
        params: ISchematicCommandMap[K]['params'],
      ) => ISchematicCommandMap[K]['result'];
    };
    const handlers: Handlers = {
      'schematic.setProperty': ({ symbolId, key, value }) =>
        model.setSymbolProperty(symbolId, key, value),
      'schematic.removeProperty': ({ symbolId, key }) => model.removeSymbolProperty(symbolId, key),
      'schematic.setProperties': ({ symbolId, values, remove = [] }) =>
        model.transaction(() => {
          for (const key of remove) model.removeSymbolProperty(symbolId, key);
          for (const [key, value] of Object.entries(values))
            model.setSymbolProperty(symbolId, key, value);
        }),
      'schematic.addDevice': ({ deviceId, ...params }) => {
        const before = new Set(model.getValue().sheet.symbols.map((symbol) => symbol.id));
        model.applyCommand({ type: 'add-symbol', ...params, device: deviceId });
        return model.getValue().sheet.symbols.find((symbol) => !before.has(symbol.id))!.id;
      },
      'schematic.removeDevice': ({ symbolId }) =>
        model.removeTargets([{ kind: 'symbol', id: symbolId }]),
      'schematic.updateDevice': ({ symbolId, deviceId, ...params }) => {
        model.applyCommand({
          type: 'update-symbol',
          ...params,
          id: symbolId,
          ...(deviceId === undefined ? {} : { device: deviceId }),
        });
      },
      'schematic.addWire': (params) => {
        const before = new Set(model.getValue().sheet.wires.map((wire) => wire.id));
        model.applyCommand({ type: 'add-wire', ...params });
        return model.getValue().sheet.wires.find((wire) => !before.has(wire.id))!.id;
      },
      'schematic.removeWire': ({ wireId }) => model.removeTargets([{ kind: 'wire', id: wireId }]),
      'schematic.setWirePoints': ({ wireId, points }) =>
        model.applyCommand({ type: 'set-wire-points', id: wireId, points }),
      'schematic.deleteSelection': () => mountedView.deleteSelection(),
      'schematic.moveSelection': ({ dx, dy }) => mountedView.moveSelectionBy(dx, dy),
      'schematic.rotateSelection': ({ degrees }) => mountedView.rotateSelection(degrees),
      'schematic.placeDevice': ({ deviceId }) => mountedView.placeDevice(deviceId),
      'schematic.undo': () => model.undo(),
      'schematic.redo': () => model.redo(),
      'schematic.setTool': ({ tool }) => mountedView.setTool(tool),
      'schematic.zoom': ({ scale }) => mountedView.zoomTo(scale),
      'schematic.fit': () => mountedView.fitToContent(),
      'schematic.resetView': () => mountedView.setViewport({ scale: 1, offsetX: 0, offsetY: 0 }),
    };
    const getState = (): IEditorIntegrationState =>
      snapshot({
        readOnly,
        mode: 'edit',
        canUndo: model.getCanUndo(),
        canRedo: model.getCanRedo(),
        tool: mountedView.getTool(),
      });
    let lastState = getState();
    const reportError = (source: IEditorErrorEvent['source'], error: unknown) => {
      let detached: unknown;
      try {
        detached = snapshot(error);
      } catch {
        detached = Object.freeze(new Error(String(error)));
      }
      errors.fire(Object.freeze({ source, error: detached }));
    };
    subscriptions.add(mountedView.onDidChangeContent((value) => content.fire(snapshot(value))));
    subscriptions.add(mountedView.onDidChangeSelection((value) => selection.fire(snapshot(value))));
    subscriptions.add(
      mountedView.onDidChangeState(() => {
        const next = getState();
        if (JSON.stringify(next) !== JSON.stringify(lastState)) {
          lastState = next;
          stateChanged.fire(next);
        }
      }),
    );
    subscriptions.add(
      mountedView.onDidChangeError((error) => {
        if (error !== undefined && !executing) reportError('runtime', error);
      }),
    );
    return {
      uri,
      get state() {
        return state;
      },
      onDidChangeContent: content.event,
      onDidChangeSelection: selection.event,
      onDidClick: click.event,
      onDidDoubleClick: doubleClick.event,
      onDidContextMenu: contextMenu.event,
      onDidChangeState: stateChanged.event,
      onDidError: errors.event,
      getDocument() {
        assertReady();
        return snapshot(model.getValue());
      },
      getSelection() {
        assertReady();
        return snapshot(mountedView.getSelection());
      },
      setSelection(value) {
        assertReady();
        mountedView.setSelection(snapshot(value));
      },
      getProperties(symbolId) {
        assertReady();
        const inspector = buildInspector(model.getValue(), [{ kind: 'symbol', id: symbolId }], {
          devices: model.getDevices(),
          topology: () => model.getTopology(),
        });
        if (inspector?.kind !== 'symbol') return Object.freeze([]);
        return snapshot(
          inspector.properties.map((field) => ({
            ...field,
            label: field.title ?? field.key,
            value: field.value === undefined ? field.defaultValue : field.value,
            defaultValue: field.defaultValue,
            overrideValue: field.value,
            overridden: field.value !== undefined,
            readOnly,
          })),
        );
      },
      getState() {
        assertReady();
        return getState();
      },
      executeCommand<K extends keyof ISchematicCommandMap>(
        id: K,
        ...args: EditorCommandArgs<ISchematicCommandMap[K]>
      ): Promise<ISchematicCommandMap[K]['result']> {
        let params: ISchematicCommandMap[K]['params'];
        try {
          params = snapshot(args[0]) as ISchematicCommandMap[K]['params'];
        } catch (error) {
          reportError('command', error);
          return Promise.reject(error);
        }
        const pending = queue
          .then(async () => {
            assertReady();
            if (!Object.hasOwn(handlers, id)) throw new Error(`Unknown command: ${String(id)}`);
            if (
              readOnly &&
              id !== 'schematic.zoom' &&
              id !== 'schematic.fit' &&
              id !== 'schematic.resetView'
            )
              throw new Error('Schematic editor is read-only.');
            if (
              (id === 'schematic.addDevice' ||
                id === 'schematic.updateDevice' ||
                id === 'schematic.placeDevice') &&
              params !== undefined &&
              'deviceId' in params &&
              typeof params.deviceId === 'string'
            )
              await prepare(params.deviceId);
            executing = true;
            try {
              return handlers[id](params);
            } finally {
              executing = false;
            }
          })
          .catch((error: unknown) => {
            reportError('command', error);
            throw error;
          });
        queue = pending.catch(() => undefined);
        return pending;
      },
      dispose() {
        if (disposal) return disposal;
        state = 'disposing';
        disposal = Promise.resolve().then(async () => {
          try {
            subscriptions.dispose();
          } finally {
            try {
              mountedView.dispose();
            } finally {
              try {
                await scope.dispose();
              } finally {
                state = 'disposed';
              }
            }
          }
        });
        return disposal;
      },
    };
  } catch (error) {
    const errors: unknown[] = [error];
    try {
      subscriptions.dispose();
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    try {
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
      throw new AggregateError(errors, 'Schematic initialization and cleanup failed.', {
        cause: error,
      });
    throw error;
  }
}
