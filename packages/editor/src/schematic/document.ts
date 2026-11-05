import {
  parseSchematic,
  type SchematicCommand,
  type SchematicDocument,
} from '@mica-js/document/schematic';
import { type Event } from '@mica-js/core/lifecycle';
import { DocumentModel } from './model/document-model';
import { createDecorator } from '../instantiation';
import { IFileSystemProvider } from '../provider-services';
import { ISchematicDevices } from './devices';

export interface ISchematicConfiguration {
  readonly uri: string;
}
export const ISchematicConfiguration = createDecorator<ISchematicConfiguration>(
  'editor.schematicConfiguration',
);

export class SchematicDocumentService {
  #model: DocumentModel | undefined;
  #disposed = false;
  #queue: Promise<void> = Promise.resolve();

  constructor(
    @ISchematicConfiguration private readonly configuration: ISchematicConfiguration,
    @IFileSystemProvider private readonly files: IFileSystemProvider,
    @ISchematicDevices private readonly devices: ISchematicDevices,
  ) {}

  async initialize(): Promise<void> {
    this.#assertAlive();
    const bytes = await this.files.read(this.configuration.uri);
    this.#assertAlive();
    const document = parseSchematic(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    await this.devices.prepare(document.sheet.symbols.map((symbol) => symbol.device));
    this.#assertAlive();
    this.#model = new DocumentModel({ value: document, devices: this.devices });
  }

  get model(): DocumentModel {
    this.#assertAlive();
    if (!this.#model) throw new Error('Schematic document is not initialized.');
    return this.#model;
  }

  get onDidChangeContent(): Event<SchematicDocument> {
    return this.model.onDidChangeContent;
  }

  apply(command: SchematicCommand): Promise<void> {
    return this.#enqueue(async () => {
      if ((command.type === 'add-symbol' || command.type === 'update-symbol') && command.device) {
        await this.devices.prepare([command.device]);
      }
      this.model.applyCommand(command);
    });
  }

  undo(): Promise<void> {
    return this.#enqueue(() => this.model.undo());
  }

  redo(): Promise<void> {
    return this.#enqueue(() => this.model.redo());
  }

  #enqueue(run: () => void | Promise<void>): Promise<void> {
    const pending = this.#queue.then(() => {
      this.#assertAlive();
      return run();
    });
    this.#queue = pending.catch(() => undefined);
    return pending;
  }

  dispose(): void {
    this.#disposed = true;
    this.#model?.dispose();
    this.#model = undefined;
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error('Schematic document is disposed.');
  }
}

export const ISchematicDocumentService = createDecorator<SchematicDocumentService>(
  'editor.schematicDocument',
);
