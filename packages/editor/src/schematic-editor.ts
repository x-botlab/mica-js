import type { Event } from '@mica-js/core/lifecycle';
import type { SchematicCommand, SchematicDocument } from '@mica-js/document/schematic';
import { createSchematicEditor as createView } from './schematic/editor/schematic-editor';
import type { ISchematicTheme } from './schematic/render/theme';
import './schematic/styles/editor.css';
import { Commands, ICommandService } from './commands';
import type { EditorState } from './editor';
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
  executeCommand(id: string, ...args: readonly unknown[]): Promise<unknown>;
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
  services.set(ICommandService, new SyncDescriptor(Commands));
  services.set(IDeviceLibraryResolver, new SyncDescriptor(DeviceLibraryResolver));
  services.set(ISchematicDevices, new SyncDescriptor(SchematicDevices));
  services.set(ISchematicDocumentService, new SyncDescriptor(SchematicDocumentService));
  const scope = new InstantiationService(services);
  let view: ReturnType<typeof createView> | undefined;
  try {
    const document = scope.get(ISchematicDocumentService);
    await document.initialize();
    view = createView({
      container: options.container,
      model: document.model,
      prepareDevices: (ids) => scope.get(ISchematicDevices).prepare(ids),
      readOnly,
      ...(options.theme === undefined ? {} : { theme: options.theme }),
    });
    const commands = scope.get(ICommandService);
    const assertWritable = () => {
      if (readOnly) throw new Error('Schematic editor is read-only.');
    };
    commands.register({
      id: 'schematic.apply',
      execute: (command) => {
        assertWritable();
        return document.apply(command as SchematicCommand);
      },
    });
    commands.register({
      id: 'schematic.undo',
      execute: () => {
        assertWritable();
        return document.undo();
      },
    });
    commands.register({
      id: 'schematic.redo',
      execute: () => {
        assertWritable();
        return document.redo();
      },
    });
    const mountedView = view;
    commands.register({
      id: 'schematic.placeDevice',
      execute: async (id) => {
        assertWritable();
        if (typeof id !== 'string') throw new TypeError('Device ID must be a string.');
        await scope.get(ISchematicDevices).prepare([id]);
        assertReady();
        mountedView.placeDevice(id);
      },
    });
    let state: EditorState = 'ready';
    let disposal: Promise<void> | undefined;
    function assertReady(): void {
      if (state !== 'ready') throw new Error('Schematic editor is disposed.');
    }
    return {
      uri,
      get state() {
        return state;
      },
      onDidChangeContent: document.onDidChangeContent,
      async executeCommand(id, ...args) {
        assertReady();
        return commands.execute(id, ...args);
      },
      dispose() {
        if (disposal) return disposal;
        state = 'disposing';
        disposal = Promise.resolve().then(async () => {
          try {
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
