import { createRpc } from '../../../../packages/core/src/rpc';
import type { GuestContext } from '../../../../packages/sandbox/src/types';
import { guestService, hostService } from './sandbox-rpc-types';
import type { BitmapValue, FixtureRpc, HostService } from './sandbox-rpc-types';

export function setup(ctx: GuestContext) {
  let rpc: FixtureRpc | undefined;
  let port: MessagePort | undefined;
  let cleanup = () => {};
  const listeners = new Set<(value: string) => void>();
  const bitmapListeners = new Set<(value: BitmapValue) => void>();
  const bitmaps: ImageBitmap[] = [];
  ctx.signal.addEventListener(
    'abort',
    () => {
      cleanup();
      rpc?.dispose();
      port?.close();
      for (const bitmap of bitmaps) bitmap.close();
    },
    { once: true },
  );

  function makeBitmap(): BitmapValue {
    const canvas = new OffscreenCanvas(3, 2);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Missing 2D context');
    context.fillStyle = '#ff0000';
    context.fillRect(0, 0, 3, 2);
    const bitmap = canvas.transferToImageBitmap();
    bitmaps.push(bitmap);
    return { bitmap };
  }

  return {
    connect(transferred: MessagePort) {
      port = transferred;
      rpc = createRpc(port) as FixtureRpc;
      const host = rpc.getProxy<HostService>(hostService);
      const unsubscribe = host.onDidTick(() => {});
      const registration = rpc.register(
        guestService,
        {
          add(a: number, b: number) {
            return a + b;
          },
          emit(value: string) {
            for (const listener of listeners) listener(value);
            return `returned:${value}`;
          },
          onDidValue(listener: (value: string) => void) {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
          listenerCount() {
            return listeners.size;
          },
          callHost(value: string) {
            return host.echo(value);
          },
          waitForever() {
            return new Promise<never>(() => {});
          },
          bitmap: makeBitmap,
          emitBitmap() {
            for (const listener of bitmapListeners) listener(makeBitmap());
          },
          onDidBitmap(listener: (value: BitmapValue) => void) {
            bitmapListeners.add(listener);
            return () => {
              bitmapListeners.delete(listener);
            };
          },
          inspectBitmap(value: BitmapValue) {
            const width = value.bitmap.width;
            value.bitmap.close();
            return width;
          },
          bitmapWidths() {
            return bitmaps.map((bitmap) => bitmap.width);
          },
        },
        {
          transfer(member, value) {
            if (member === 'bitmap') return [(value as BitmapValue).bitmap];
            if (member === 'onDidBitmap') return [(value as [BitmapValue])[0].bitmap];
            return [];
          },
        },
      );
      cleanup = () => {
        unsubscribe();
        registration.dispose();
      };
      return {
        connected: port instanceof MessagePort,
        origin: self.origin,
        document: typeof document,
      };
    },
  };
}
