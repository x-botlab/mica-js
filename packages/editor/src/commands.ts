import { toDisposable, type Disposable } from '@mica-js/core/lifecycle';
import { createDecorator } from './instantiation';

export interface ICommandContribution {
  readonly id: string;
  readonly execute: (...args: readonly unknown[]) => unknown;
}

export interface ICommandService {
  register(command: ICommandContribution): Disposable;
  execute(id: string, ...args: readonly unknown[]): Promise<unknown>;
}

export const ICommandService = createDecorator<ICommandService>('editor.commandService');

export class Commands implements ICommandService {
  readonly #commands = new Map<string, ICommandContribution>();
  #disposed = false;

  register(command: ICommandContribution): Disposable {
    this.#assertActive();
    if (!command.id.trim()) throw new Error('Command id must not be empty.');
    if (this.#commands.has(command.id)) throw new Error(`Duplicate command: ${command.id}`);
    const snapshot = { id: command.id, execute: command.execute };
    this.#commands.set(snapshot.id, snapshot);
    return toDisposable(() => {
      if (this.#commands.get(snapshot.id) === snapshot) this.#commands.delete(snapshot.id);
    });
  }

  async execute(id: string, ...args: readonly unknown[]): Promise<unknown> {
    this.#assertActive();
    const command = this.#commands.get(id);
    if (!command) throw new Error(`Unknown command: ${id}`);
    return command.execute(...args);
  }

  dispose(): void {
    this.#disposed = true;
    this.#commands.clear();
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('Command service is disposed.');
  }
}
