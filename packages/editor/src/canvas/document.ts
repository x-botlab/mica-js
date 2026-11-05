import { parseCanvas, type CanvasCommand } from '@mica-js/document/canvas';
import { createDecorator } from '../instantiation';
import { IFileSystemProvider } from '../provider-services';
import { ICanvasConfiguration, ICanvasSession } from './session';
import { CanvasModel } from './model';

export class CanvasDocumentService {
  #model: CanvasModel | undefined;
  #disposed = false;

  constructor(
    @ICanvasConfiguration private readonly configuration: ICanvasConfiguration,
    @IFileSystemProvider private readonly files: IFileSystemProvider,
    @ICanvasSession private readonly session: ICanvasSession,
  ) {}

  async initialize(): Promise<void> {
    const bytes = await this.files.read(this.configuration.uri);
    this.#assertAlive();
    const document = parseCanvas(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    await this.session.synchronize(document);
    this.#assertAlive();
    this.#model = new CanvasModel(document, (next) => this.session.synchronize(next));
  }

  get model(): CanvasModel {
    this.#assertAlive();
    if (!this.#model) throw new Error('Canvas document is not initialized.');
    return this.#model;
  }
  apply(command: CanvasCommand): Promise<void> {
    return this.model.apply(command);
  }
  undo(): Promise<void> {
    return this.model.undo();
  }
  redo(): Promise<void> {
    return this.model.redo();
  }
  dispose(): void {
    this.#disposed = true;
    this.#model?.dispose();
    this.#model = undefined;
  }
  #assertAlive(): void {
    if (this.#disposed) throw new Error('Canvas document is disposed.');
  }
}
export const ICanvasDocumentService =
  createDecorator<CanvasDocumentService>('editor.canvasDocument');
