import type { IDisposable } from '@mica-js/core/lifecycle';
import { createDecorator } from './instantiation';
import { IDeviceLibrary, IWidgetLibrary } from './provider-services';
import type { IDeviceDescription, IWidgetDescription } from './providers';

class LibraryResolver<T> implements IDisposable {
  readonly #cache = new Map<string, Promise<T | undefined>>();
  #disposed = false;

  constructor(private readonly library: { resolve(id: string): Promise<T | undefined> }) {}

  resolve(id: string): Promise<T | undefined> {
    if (this.#disposed) return Promise.reject(new Error('Library resolver is disposed.'));
    const cached = this.#cache.get(id);
    if (cached) return cached;
    const pending = Promise.resolve()
      .then(() => {
        if (this.#disposed) throw new Error('Library resolver is disposed.');
        return this.library.resolve(id);
      })
      .then(
        (description) => {
          if (description === undefined) this.#cache.delete(id);
          return description;
        },
        (error: unknown) => {
          this.#cache.delete(id);
          throw error;
        },
      );
    this.#cache.set(id, pending);
    return pending;
  }

  dispose(): void {
    this.#disposed = true;
    this.#cache.clear();
  }
}

export const IDeviceLibraryResolver = createDecorator<IDeviceLibrary>(
  'editor.deviceLibraryResolver',
);

export class DeviceLibraryResolver extends LibraryResolver<IDeviceDescription> {
  constructor(@IDeviceLibrary library: IDeviceLibrary) {
    super(library);
  }
}

export const IWidgetLibraryResolver = createDecorator<IWidgetLibrary>(
  'editor.widgetLibraryResolver',
);

export class WidgetLibraryResolver extends LibraryResolver<IWidgetDescription> {
  constructor(@IWidgetLibrary library: IWidgetLibrary) {
    super(library);
  }
}
