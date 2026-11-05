import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { HostFs, WidgetModule, WidgetProvider } from '@mica-js/widget';
import {
  DeviceLibraryResolver,
  IDeviceLibraryResolver,
  IWidgetLibraryResolver,
  WidgetLibraryResolver,
} from './libraries';
import { InstantiationService, ServiceCollection, SyncDescriptor } from './instantiation';
import { IDeviceLibrary, IWidgetLibrary } from './provider-services';
import type { IDeviceDescription, IFileSystemProvider, IWidgetDescription } from './providers';

const device: IDeviceDescription = {
  definition: {
    kind: 'device',
    id: 'button',
    version: '1.0.0',
    displayName: 'Button',
    designatorPrefix: 'S',
    pins: { A: {}, B: {} },
    ports: { pressed: { direction: 'input', type: 'boolean' } },
    properties: { debounceTicks: { type: 'number', required: false, default: 0 } },
  },
  code: 'throw new Error("must not execute in host"); export default function createDevice() {}',
};

const widget: IWidgetDescription = {
  definition: {
    displayName: 'Indicator',
    properties: {},
    ports: { value: { direction: 'input', type: 'number' } },
  },
  code: 'throw new Error("must not execute in host"); export default function createWidget() {}',
};

interface IResolver<T> {
  resolve(id: string): Promise<T | undefined>;
  dispose(): void;
}

function testResolver<T>(
  name: string,
  description: T,
  create: (library: { resolve(id: string): Promise<T | undefined> }) => IResolver<T>,
): void {
  describe(name, () => {
    it('passes full IDs unchanged and shares concurrent and successful lookups', async () => {
      const resolve = vi.fn(async () => description);
      const resolver = create({ resolve });
      const first = resolver.resolve('demo:button');
      expect(resolver.resolve('demo:button')).toBe(first);
      await expect(first).resolves.toBe(description);
      await expect(resolver.resolve('demo:button')).resolves.toBe(description);
      expect(resolve).toHaveBeenCalledExactlyOnceWith('demo:button');
      await resolver.resolve('other:button');
      expect(resolve).toHaveBeenCalledTimes(2);
      resolver.dispose();
    });

    it('retries missing IDs and rejected resolutions', async () => {
      const resolve = vi
        .fn<() => Promise<T | undefined>>()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('offline'))
        .mockImplementation(() => new Promise<T>((resolve) => resolve(description)));
      const resolver = create({ resolve });
      await expect(resolver.resolve('demo:button')).resolves.toBeUndefined();
      await expect(resolver.resolve('demo:button')).rejects.toThrow('offline');
      await expect(resolver.resolve('demo:button')).resolves.toBe(description);
      expect(resolve).toHaveBeenCalledTimes(3);
      resolver.dispose();
    });

    it('turns synchronous provider errors into rejections and permits retry', async () => {
      let calls = 0;
      const resolver = create({
        resolve: () => {
          if (++calls === 1) throw new Error('sync failure');
          return Promise.resolve(description);
        },
      });
      await expect(resolver.resolve('demo:button')).rejects.toThrow('sync failure');
      await expect(resolver.resolve('demo:button')).resolves.toBe(description);
      resolver.dispose();
    });

    it('isolates caches between editor instances', async () => {
      const resolve = vi.fn(async () => description);
      const first = create({ resolve });
      const second = create({ resolve });
      await first.resolve('demo:button');
      first.dispose();
      await second.resolve('demo:button');
      expect(resolve).toHaveBeenCalledTimes(2);
      second.dispose();
    });

    it('blocks resolutions after disposal and cancels work not yet started', async () => {
      const resolve = vi.fn(async () => description);
      const resolver = create({ resolve });
      const pending = resolver.resolve('demo:button');
      resolver.dispose();
      resolver.dispose();
      await expect(pending).rejects.toThrow('disposed');
      await expect(resolver.resolve('other:button')).rejects.toThrow('disposed');
      expect(resolve).not.toHaveBeenCalled();
    });

    it('allows already running lookups to settle without reopening the resolver', async () => {
      let finish!: (value: T) => void;
      const pending = new Promise<T>((resolve) => {
        finish = resolve;
      });
      const resolver = create({ resolve: () => pending });
      const resolution = resolver.resolve('demo:button');
      await Promise.resolve();
      resolver.dispose();
      finish(description);
      await expect(resolution).resolves.toBe(description);
      await expect(resolver.resolve('demo:button')).rejects.toThrow('disposed');
    });
  });
}

testResolver('device resolution', device, (library) => new DeviceLibraryResolver(library));
testResolver('widget resolution', widget, (library) => new WidgetLibraryResolver(library));

describe('provider contracts', () => {
  it('reuses existing read-only filesystem and widget contracts', () => {
    expectTypeOf<IFileSystemProvider>().toEqualTypeOf<HostFs>();
    expectTypeOf<keyof IFileSystemProvider>().toEqualTypeOf<'read'>();
    expectTypeOf<IWidgetDescription>().toEqualTypeOf<WidgetModule>();
    expectTypeOf<IWidgetLibrary>().toExtend<WidgetProvider>();
    expectTypeOf<keyof IDeviceLibrary>().toEqualTypeOf<'resolve'>();
    expectTypeOf<keyof IWidgetLibrary>().toEqualTypeOf<'resolve'>();
    expectTypeOf<keyof IDeviceDescription>().toEqualTypeOf<'definition' | 'code'>();
  });

  it('injects libraries independently and keeps external providers alive', async () => {
    const disposeDevice = vi.fn();
    const disposeWidget = vi.fn();
    const deviceLibrary = { resolve: vi.fn(async () => device), dispose: disposeDevice };
    const services = new ServiceCollection();
    services.set(IDeviceLibrary, deviceLibrary);
    services.set(IDeviceLibraryResolver, new SyncDescriptor(DeviceLibraryResolver));
    const scope = new InstantiationService(services);
    // A schematic scope needs no widget service.
    await expect(scope.get(IDeviceLibraryResolver).resolve('demo:button')).resolves.toBe(device);
    const widgetLibrary = { resolve: vi.fn(async () => widget), dispose: disposeWidget };
    services.set(IWidgetLibrary, widgetLibrary);
    services.set(IWidgetLibraryResolver, new SyncDescriptor(WidgetLibraryResolver));
    const widgetResolver = scope.get(IWidgetLibraryResolver);
    await expect(widgetResolver.resolve('demo:indicator')).resolves.toBe(widget);
    await scope.dispose();
    expect(disposeDevice).not.toHaveBeenCalled();
    expect(disposeWidget).not.toHaveBeenCalled();
    await expect(widgetResolver.resolve('demo:indicator')).rejects.toThrow('disposed');
  });
});
