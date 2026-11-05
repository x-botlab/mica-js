import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createDeviceRegistry,
  parseDeviceReference,
  type DeviceReference,
  type DeviceSymbolProvider,
} from '@mica-js/document/schematic';
import { InstantiationService, ServiceCollection, SyncDescriptor } from '../instantiation';
import { IDeviceLibraryResolver } from '../libraries';
import type { IDeviceDescription, IDeviceLibrary } from '../providers';
import { ISchematicDevices, SchematicDevices } from './devices';

const device = {
  definition: {
    kind: 'device',
    id: 'button',
    version: '1.0.0',
    displayName: 'Button',
    description: 'A switch',
    designatorPrefix: 'S',
    pins: { A: {}, B: {} },
    properties: { resistance: { type: 'number', required: false, default: 10 } },
  },
  code: 'throw new Error("must not execute in host");',
} satisfies IDeviceDescription;

function reference(id = 'demo:button'): DeviceReference {
  const parsed = parseDeviceReference(id);
  if (!parsed) throw new Error(`Invalid test ID ${id}`);
  return parsed;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

describe('SchematicDevices', () => {
  it('adapts definitions through the real core registry without evaluating code', async () => {
    const resolve = vi.fn(async () => device);
    const service = new SchematicDevices({ resolve });
    const ref = reference();
    expect(service.getDeviceSymbol(ref)).toBeUndefined();
    await service.prepare([ref.raw]);
    const expected = createDeviceRegistry([
      {
        packageId: ref.packageId,
        devices: [
          {
            id: ref.deviceId,
            displayName: 'Button',
            description: 'A switch',
            designatorPrefix: 'S',
            raw: { ...device.definition },
          },
        ],
      },
    ]);
    expect(service.getDeviceSymbol(ref)).toEqual(expected.getDeviceSymbol(ref));
    expect(Object.keys(service.getDeviceSymbol(ref)!.pins)).toEqual(['A', 'B']);
    expect(service.getDeviceName(ref)).toBe('Button');
    expect(service.getDeviceDesignatorPrefix(ref)).toBe('S');
    expect(service.getDevicePropertyDescriptors(ref)).toEqual(
      expected.getDevicePropertyDescriptors!(ref),
    );
    expect(service.getDevicePropertyDescriptors(ref)?.has('resistance')).toBe(true);
    await service.prepare([ref.raw]);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(ref.raw);
    expectTypeOf<ISchematicDevices>().toExtend<DeviceSymbolProvider>();
    expectTypeOf<keyof ISchematicDevices>().toEqualTypeOf<
      keyof DeviceSymbolProvider | 'prepare' | 'dispose'
    >();
  });

  it('uses SDK explicit geometry and display names', async () => {
    const explicit: IDeviceDescription = {
      ...device,
      definition: {
        ...device.definition,
        displayName: 'Contact',
        symbol: {
          bounds: { x: -20, y: -10, width: 40, height: 20 },
          graphics: [],
          pins: {
            A: { position: [-20, 0], direction: 'left' },
            B: { position: [20, 0], direction: 'right' },
          },
        },
      },
    };
    const service = new SchematicDevices({
      resolve: async (id) =>
        id === 'demo:button'
          ? explicit
          : {
              definition: { kind: 'device', id: 'other', version: '1', displayName: 'Other' },
              code: '',
            },
    });
    await service.prepare(['demo:button', 'demo:other']);
    expect(service.getDeviceName(reference())).toBe('Contact');
    expect(service.getDeviceSymbol(reference())?.pins['A']).toEqual({ x: -20, y: 0, side: 'left' });
    expect(service.getDeviceName(reference('demo:other'))).toBe('Other');
    expect(service.getDeviceDesignatorPrefix(reference('demo:other'))).toBeUndefined();
  });

  it('deduplicates overlapping preparation while resolving distinct IDs concurrently', async () => {
    const button = deferred<IDeviceDescription>();
    const other = deferred<IDeviceDescription>();
    const resolve = vi.fn((id: string) =>
      id === 'demo:button'
        ? button.promise
        : id === 'demo:other'
          ? other.promise
          : Promise.resolve({ ...device, definition: { ...device.definition, id: 'third' } }),
    );
    const service = new SchematicDevices({ resolve });
    const first = service.prepare(['demo:button', 'demo:other', 'demo:button']);
    const second = service.prepare(['demo:button']);
    await Promise.resolve();
    expect(resolve.mock.calls).toEqual([['demo:button'], ['demo:other']]);
    other.resolve({ ...device, definition: { ...device.definition, id: 'other' } });
    button.resolve(device);
    await Promise.all([first, second]);
    await service.prepare(['demo:third']);
    expect(service.getDeviceName(reference())).toBe('Button');
    expect(service.getDeviceName(reference('demo:other'))).toBe('Button');
    expect(service.getDeviceName(reference('demo:third'))).toBe('Button');
  });

  it('skips builtin symbols including text and never resolves malformed IDs', async () => {
    const resolve = vi.fn(async () => device);
    const service = new SchematicDevices({ resolve });
    await service.prepare(['builtin:label', 'builtin:power', 'builtin:ground', 'builtin:text']);
    await expect(service.prepare(['invalid'])).rejects.toThrow('invalid');
    expect(resolve).not.toHaveBeenCalled();
    expect(service.getDeviceSymbol(reference('builtin:text'))).toBeUndefined();
    expect(service.getDeviceName(reference('demo:missing'))).toBeUndefined();
    expect(service.getDeviceDesignatorPrefix(reference('demo:missing'))).toBeUndefined();
    expect(service.getDevicePropertyDescriptors(reference('demo:missing'))).toBeUndefined();
  });

  it('identifies missing devices and retries missing or failed resolutions', async () => {
    const resolve = vi
      .fn<IDeviceLibrary['resolve']>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(device);
    const service = new SchematicDevices({ resolve });
    await expect(service.prepare(['demo:button'])).rejects.toThrow('demo:button');
    await expect(service.prepare(['demo:button'])).rejects.toThrow('offline');
    await service.prepare(['demo:button']);
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(service.getDeviceName(reference())).toBe('Button');
  });

  it('keeps registered devices intact when another definition fails core validation', async () => {
    const invalid: IDeviceDescription = {
      ...device,
      definition: {
        ...device.definition,
        id: 'other',
        symbol: {
          bounds: { x: -20, y: -10, width: 40, height: 20 },
          graphics: [],
          pins: { A: { position: [Number.NaN, 0], direction: 'left' } },
        },
      },
    };
    const resolve = vi
      .fn<IDeviceLibrary['resolve']>()
      .mockResolvedValueOnce(device)
      .mockResolvedValueOnce(invalid)
      .mockResolvedValue({ ...device, definition: { ...device.definition, id: 'other' } });
    const service = new SchematicDevices({ resolve });
    await service.prepare(['demo:button']);
    await expect(service.prepare(['demo:other'])).rejects.toThrow();
    expect(service.getDeviceName(reference())).toBe('Button');
    expect(service.getDeviceSymbol(reference('demo:other'))).toBeUndefined();
    await service.prepare(['demo:other']);
    expect(service.getDeviceName(reference('demo:other'))).toBe('Button');
  });

  it('retries synchronous provider failures', async () => {
    const resolve = vi
      .fn<IDeviceLibrary['resolve']>()
      .mockImplementationOnce(() => {
        throw new Error('sync failure');
      })
      .mockResolvedValue(device);
    const service = new SchematicDevices({ resolve });
    await expect(service.prepare(['demo:button'])).rejects.toThrow('sync failure');
    await service.prepare(['demo:button']);
    expect(service.getDeviceName(reference())).toBe('Button');
  });

  it('prevents post-dispose commits and leaves the caller-owned library alive', async () => {
    const pending = deferred<IDeviceDescription>();
    const library = { resolve: vi.fn(() => pending.promise), dispose: vi.fn() };
    const service = new SchematicDevices(library);
    const preparation = service.prepare(['demo:button']);
    await Promise.resolve();
    expect(library.resolve).toHaveBeenCalledOnce();
    service.dispose();
    service.dispose();
    pending.resolve(device);
    await expect(preparation).rejects.toThrow('disposed');
    expect(service.getDeviceSymbol(reference())).toBeUndefined();
    await expect(service.prepare([])).rejects.toThrow('disposed');
    expect(library.dispose).not.toHaveBeenCalled();
  });

  it('clears committed data and cancels resolutions not yet started on disposal', async () => {
    const resolve = vi.fn(async () => device);
    const service = new SchematicDevices({ resolve });
    await service.prepare(['demo:button']);
    const preparation = service.prepare(['demo:other']);
    service.dispose();
    await expect(preparation).rejects.toThrow('disposed');
    expect(resolve).toHaveBeenCalledOnce();
    expect(service.getDeviceName(reference())).toBeUndefined();
  });

  it('injects the resolver token and isolates each editor service', async () => {
    const resolve = vi.fn(async () => device);
    const services = new ServiceCollection();
    services.set(IDeviceLibraryResolver, { resolve });
    services.set(ISchematicDevices, new SyncDescriptor(SchematicDevices));
    const scope = new InstantiationService(services);
    const service = scope.get(ISchematicDevices);
    await service.prepare(['@scope/demo:button']);
    expect(service.getDeviceName(reference('@scope/demo:button'))).toBe('Button');
    const separate = new SchematicDevices({ resolve });
    expect(separate.getDeviceName(reference('@scope/demo:button'))).toBeUndefined();
    await scope.dispose();
    await expect(service.prepare([])).rejects.toThrow('disposed');
  });
});
