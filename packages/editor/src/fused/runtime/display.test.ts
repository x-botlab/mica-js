import { describe, expect, it } from 'vitest';
import { createFusedDisplay } from './host/display';
import type {
  IFusedInstancePresentation,
  IFusedOverlayFrame,
  IFusedRenderRequest,
  IFusedViewInput,
} from './protocol';

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

const INSTANCE: IFusedInstancePresentation = {
  instanceId: INSTANCE_ID,
  device: 'test:asset',
  lock: { id: 'test:asset', version: '1.0.0', integrity: `sha256:${'0'.repeat(64)}` },
  geometry: {
    sizing: 'flexible',
    bounds: { x: -1, y: -1, width: 8, height: 8 },
    bodyBounds: { x: 0, y: 0, width: 6, height: 6 },
    pins: {},
  },
  view: 'view.js',
  props: {},
  methods: [],
  events: [],
};

const INPUT: IFusedViewInput = {
  type: 'pointerdown',
  position: { x: 0, y: 0 },
  button: 0,
  buttons: 1,
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(cause: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (cause: unknown) => void = () => {};
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

interface FakeProxy {
  readonly calls: string[];
  readonly renders: Deferred<IFusedOverlayFrame | undefined>[];
  readonly failures: Deferred<void>[];
  onDidInvalidate(listener: (change: { instanceId: string }) => void): () => void;
  prepare(request: unknown): Promise<void>;
  activate(): Promise<void>;
  render(request: IFusedRenderRequest): Promise<IFusedOverlayFrame | undefined>;
  input(instanceId: string, event: IFusedViewInput): Promise<void>;
  release(instanceId: string): void;
  dispose(): Promise<void>;
}

function fakeProxy(): FakeProxy {
  const calls: string[] = [];
  const renders: Deferred<IFusedOverlayFrame | undefined>[] = [];
  const failures: Deferred<void>[] = [];
  return {
    calls,
    renders,
    failures,
    onDidInvalidate() {
      return () => {};
    },
    async prepare() {
      calls.push('prepare');
    },
    async activate() {
      calls.push('activate');
    },
    render(request) {
      calls.push(`render:${request.generation}`);
      const pending = deferred<IFusedOverlayFrame | undefined>();
      renders.push(pending);
      return pending.promise;
    },
    input() {
      calls.push('input');
      const pending = deferred<void>();
      failures.push(pending);
      return pending.promise;
    },
    release() {
      calls.push('release');
    },
    async dispose() {
      calls.push('dispose');
    },
  };
}

function frame(generation: number, bitmap: unknown): IFusedOverlayFrame {
  return {
    instanceId: INSTANCE_ID,
    generation,
    width: 8,
    height: 8,
    scale: 1,
    bitmap: bitmap as ImageBitmap,
  };
}

class FakeBitmap {
  closed = false;
  close(): void {
    this.closed = true;
  }
}

describe('fused display host', () => {
  it('reports a transport input failure once per instance instead of swallowing it', async () => {
    const proxy = fakeProxy();
    const diagnostics: Array<{ code: string; message: string; instanceId?: string }> = [];
    const host = createFusedDisplay({
      proxy: proxy as never,
      onDiagnostic: (entry) => diagnostics.push(entry),
    });
    await host.prepare({ mode: 'edit' }, [INSTANCE]);

    // The guest reports author callback failures itself; a rejection here is a lost call.
    host.display.input(INSTANCE_ID, INPUT);
    host.display.input(INSTANCE_ID, INPUT);
    for (const failure of proxy.failures) failure.reject(new Error('model lane closed'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(diagnostics).toEqual([
      {
        code: 'runtime/presentation-failed',
        message: 'model lane closed',
        instanceId: INSTANCE_ID,
      },
    ]);
    await host.dispose();
  });

  it('hands a delivered bitmap to the caller only and closes the superseded frame', async () => {
    const scope = globalThis as { ImageBitmap?: unknown };
    const original = scope.ImageBitmap;
    scope.ImageBitmap = FakeBitmap;
    try {
      const proxy = fakeProxy();
      const frames: IFusedOverlayFrame[] = [];
      const host = createFusedDisplay({
        proxy: proxy as never,
        onOverlay: (entry) => frames.push(entry),
      });
      await host.prepare({ mode: 'run' }, [INSTANCE]);

      const layout = { width: 8, height: 8, scale: 1 };
      const first = host.display.render(INSTANCE_ID, layout);
      const second = host.display.render(INSTANCE_ID, layout);
      const stale = new FakeBitmap();
      const delivered = new FakeBitmap();
      proxy.renders[1]!.resolve(frame(2, delivered));
      const latest = await second;
      proxy.renders[0]!.resolve(frame(1, stale));
      expect(await first).toBeUndefined();

      expect(latest?.generation).toBe(2);
      expect(frames).toHaveLength(1);
      // The runtime never closes a bitmap it delivered; the caller owns it.
      expect(delivered.closed).toBe(false);
      // A frame that lost the race is released instead of leaking.
      expect(stale.closed).toBe(true);
      await host.dispose();
      expect(delivered.closed).toBe(false);
    } finally {
      if (original === undefined) delete scope.ImageBitmap;
      else scope.ImageBitmap = original;
    }
  });
});
