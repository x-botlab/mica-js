export interface IDisposable {
  dispose(): void;
}

export function toDisposable(dispose: () => void): IDisposable {
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      dispose();
    },
  };
}

export class DisposableStore implements IDisposable {
  readonly #items = new Set<IDisposable>();
  #disposed = false;

  add<T extends IDisposable>(value: T): T {
    if ((value as IDisposable) === this)
      throw new TypeError('A DisposableStore cannot contain itself');
    if (this.#disposed) value.dispose();
    else this.#items.add(value);
    return value;
  }

  clear(): void {
    const items = [...this.#items];
    this.#items.clear();
    const errors: unknown[] = [];
    for (const item of items) {
      try {
        item.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Failed to dispose resources');
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.clear();
  }
}
