import { ICommandService, type ICommandContribution } from './commands';
import type { InstantiationService } from './instantiation';

export type EditorState = 'created' | 'starting' | 'ready' | 'failed' | 'disposing' | 'disposed';

export interface IEditorOptions {
  readonly commands?: readonly ICommandContribution[];
}

export interface IEditor {
  readonly state: EditorState;
  executeCommand(id: string, ...args: readonly unknown[]): Promise<unknown>;
  dispose(): Promise<void>;
}

class EditorServices {
  constructor(@ICommandService readonly commands: ICommandService) {}
}

export class EditorLifecycle implements IEditor {
  readonly #instantiation: InstantiationService;
  readonly #options: IEditorOptions;
  #services: EditorServices | undefined;
  #state: EditorState = 'created';
  #startup: Promise<void> | undefined;
  #disposal: Promise<void> | undefined;

  constructor(instantiation: InstantiationService, options: IEditorOptions = {}) {
    this.#options = {
      commands: (options.commands ?? []).map((command) => ({ ...command })),
    };
    this.#instantiation = instantiation;
  }

  get state(): EditorState {
    return this.#state;
  }

  start(): Promise<void> {
    if (this.#state === 'disposing' || this.#state === 'disposed') {
      return Promise.reject(new Error('IEditor is disposed.'));
    }
    if (this.#startup) return this.#startup;
    this.#state = 'starting';
    this.#startup = Promise.resolve().then(async () => {
      try {
        if (this.#state !== 'starting') throw new Error('IEditor startup was cancelled.');
        const services = this.#instantiation.createInstance(EditorServices);
        for (const command of this.#options.commands ?? []) services.commands.register(command);
        this.#services = services;
        this.#state = 'ready';
      } catch (error) {
        if (this.#state === 'starting') this.#state = 'failed';
        try {
          await this.#instantiation.dispose();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'IEditor startup and cleanup failed.', {
            cause: cleanupError,
          });
        }
        throw error;
      }
    });
    return this.#startup;
  }

  async executeCommand(id: string, ...args: readonly unknown[]): Promise<unknown> {
    return this.#ready().commands.execute(id, ...args);
  }

  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#state = 'disposing';
    this.#disposal = this.#release();
    return this.#disposal;
  }

  async #release(): Promise<void> {
    await this.#startup?.catch(() => undefined);
    try {
      await this.#instantiation.dispose();
    } finally {
      this.#services = undefined;
      this.#state = 'disposed';
    }
  }

  #ready(): EditorServices {
    if (this.#state !== 'ready' || !this.#services) {
      throw new Error(`IEditor is not ready: ${this.#state}`);
    }
    return this.#services;
  }
}
