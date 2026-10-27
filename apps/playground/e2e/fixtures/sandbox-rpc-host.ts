import { createRpc } from '../../../../packages/core/src/rpc';
import { SandboxWorker } from '../../../../packages/sandbox/src';
import guestCode from 'virtual:sandbox-rpc-guest';
import { hostService, guestService, sandboxService } from './sandbox-rpc-types';
import type { BitmapValue, FixtureRpc, GuestService, SandboxService } from './sandbox-rpc-types';

async function connect() {
  const errors: string[] = [];
  const sandbox = new SandboxWorker(
    { type: 'module', code: guestCode },
    { name: 'sandbox-rpc-fixture', captureConsole: false },
  );
  const sandboxPort = await sandbox.ready;
  const sandboxRpc = createRpc(sandboxPort, {
    timeoutMs: 3000,
    onError: (error) => errors.push(String(error)),
  });
  const channel = new MessageChannel();
  const rpc = createRpc(channel.port1, {
    timeoutMs: 3000,
    onError: (error) => errors.push(String(error)),
  }) as FixtureRpc;
  const ticks = new Set<() => void>();
  const registration = rpc.register(hostService, {
    echo(value: string) {
      return `host:${value}`;
    },
    onDidTick(listener: () => void) {
      ticks.add(listener);
      return () => {
        ticks.delete(listener);
      };
    },
  });
  const guest = rpc.getProxy<GuestService>(guestService);
  const sandboxApi = sandboxRpc.getProxy<SandboxService>(sandboxService, {
    transfer: (_member, args) => [args[0] as MessagePort],
  });
  const terminate = async () => {
    try {
      await sandbox.terminate('browser integration complete');
    } finally {
      // MessagePort does not reliably signal remote worker destruction. The owner must
      // explicitly dispose RPC and close its transport when terminating the sandbox.
      registration.dispose();
      rpc.dispose();
      sandboxRpc.dispose();
      channel.port1.close();
      channel.port2.close();
    }
  };
  try {
    const handshake = await sandboxApi.connect(channel.port2);
    return { sandbox, rpc, guest, handshake, ticks, terminate, errors };
  } catch (error) {
    await terminate();
    throw error;
  }
}

export async function basic() {
  const session = await connect();
  const { guest } = session;
  let unsubscribe = () => {};
  try {
    const order: string[] = [];
    unsubscribe = guest.onDidValue((value) => order.push(`event:${value}`));
    const listenerCount = await guest.listenerCount();
    const sum = await guest.add(17, 25);
    const hostReply = await guest.callHost('roundtrip');
    const response = await guest.emit('first');
    order.push(`response:${response}`);
    unsubscribe();
    unsubscribe();
    const remaining = await guest.listenerCount();
    await guest.emit('after-unsubscribe');
    return {
      handshake: session.handshake,
      sum,
      hostReply,
      order,
      listenerCount,
      remaining,
      errors: session.errors,
    };
  } finally {
    unsubscribe();
    await session.terminate();
  }
}

export async function lifecycle() {
  const session = await connect();
  try {
    // Same-port barrier: the guest subscribes to the host before callHost sends its call.
    await session.guest.callHost('barrier');
    const subscriptionsBefore = session.ticks.size;
    const pending = session.guest.waitForever().then(
      () => 'unexpected resolution',
      (error: Error) => error.name,
    );
    await session.guest.add(1, 1);
    await session.terminate();
    const pendingError = await pending;
    const afterDispose = await session.guest.add(1, 2).then(
      () => 'unexpected resolution',
      (error: Error) => error.name,
    );
    await session.terminate();
    return {
      subscriptionsBefore,
      subscriptionsAfter: session.ticks.size,
      pendingError,
      afterDispose,
      state: session.sandbox.state,
    };
  } finally {
    await session.terminate();
  }
}

export async function transfers() {
  const session = await connect();
  const received: ImageBitmap[] = [];
  let unsubscribe = () => {};
  try {
    const result = await session.guest.bitmap();
    received.push(result.bitmap);
    const resultSize = [result.bitmap.width, result.bitmap.height];
    // Width zero proves transfer/detachment, not merely structured cloning.
    const widthsAfterResult = await session.guest.bitmapWidths();
    if (widthsAfterResult[0] !== 0) {
      return {
        supported: false,
        reason:
          'register transfer callback is not implemented: method result was cloned, not transferred',
      };
    }
    const canvas = new OffscreenCanvas(3, 2);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Missing 2D context');
    context.drawImage(result.bitmap, 0, 0);
    const pixel = [...context.getImageData(0, 0, 1, 1).data];
    const eventSizes: number[][] = [];
    unsubscribe = session.guest.onDidBitmap(({ bitmap }) => {
      received.push(bitmap);
      eventSizes.push([bitmap.width, bitmap.height]);
    });
    await session.guest.emitBitmap();
    const widthsAfterEvent = await session.guest.bitmapWidths();
    const outgoingCanvas = new OffscreenCanvas(7, 4);
    if (!outgoingCanvas.getContext('2d')) throw new Error('Missing 2D context');
    const outgoing = outgoingCanvas.transferToImageBitmap();
    received.push(outgoing);
    const proxy = session.rpc.getProxy<GuestService>(guestService, {
      transfer(member, args) {
        return member === 'inspectBitmap' ? [(args as [BitmapValue])[0].bitmap] : [];
      },
    });
    const argumentWidth = await proxy.inspectBitmap({ bitmap: outgoing });
    return {
      supported: true,
      resultSize,
      pixel,
      eventSizes,
      widthsAfterResult,
      widthsAfterEvent,
      argumentWidth,
      outgoingWidth: outgoing.width,
    };
  } finally {
    unsubscribe();
    for (const bitmap of received) bitmap.close();
    await session.terminate();
  }
}
