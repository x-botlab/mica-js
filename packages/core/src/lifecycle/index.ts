export interface IDisposable {
  dispose(): void;
}

/** Alias of {@link IDisposable}; the name {@link Event} subscriptions use. */
export type Disposable = IDisposable;

/**
 * VS Code-style event: subscribing returns a {@link Disposable} instead of an unsubscribe function,
 * so a listener can be released individually or collected in `disposables` / a `DisposableStore`.
 *
 * ```ts
 * const subscription = host.onDidChangeContent((document) => render(document));
 * subscription.dispose();
 * ```
 */
export type Event<T> = (
  listener: (e: T) => unknown,
  thisArgs?: unknown,
  disposables?: Disposable[],
) => Disposable;

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

interface ListenerEntry<T> {
  readonly listener: (e: T) => unknown;
  readonly thisArgs: unknown;
}

/**
 * Minimal event source behind `onDidXxx` members: `event` is what subscribers consume, `fire()`
 * delivers one payload to the listeners registered at that moment.
 */
export class Emitter<T> implements IDisposable {
  readonly #listeners = new Set<ListenerEntry<T>>();
  #disposed = false;

  /** The same event can be handed out any number of times; each call subscribes one listener. */
  readonly event: Event<T> = (listener, thisArgs, disposables) => {
    if (this.#disposed) return toDisposable(() => {});
    const entry: ListenerEntry<T> = { listener, thisArgs };
    this.#listeners.add(entry);
    const subscription = toDisposable(() => {
      this.#listeners.delete(entry);
    });
    disposables?.push(subscription);
    return subscription;
  };

  get hasListeners(): boolean {
    return this.#listeners.size > 0;
  }

  /** Listener exceptions propagate; a listener added while firing runs on the next fire. */
  fire(event: T): void {
    if (this.#disposed) return;
    for (const entry of [...this.#listeners]) {
      entry.listener.call(entry.thisArgs, event);
    }
  }

  /** Drops every listener; later fires are no-ops and new subscriptions dispose themselves. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
  }
}
