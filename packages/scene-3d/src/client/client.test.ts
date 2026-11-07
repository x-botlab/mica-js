import { describe, expect, it } from 'vitest';
import type { ModelEntity, SceneEntity } from '../entities';
import { SCENE3D_VERSION } from '../format';
import type { Scene3DDocument } from '../format';
import { Scene3DProtocolError, TRANSFORM_STRIDE } from '../runtime/protocol';
import type { Scene3DHostProxy, StepResult } from '../runtime/protocol';
import { createScene3DHostProxy, Scene3DClient } from './client';
import type { SandboxScene3DHostHandle, Scene3DView } from './client';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function model(id: string): ModelEntity {
  return {
    id,
    type: 'model',
    position: { x: 0, y: 1, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    geometry: { type: 'box', size: { x: 1, y: 1, z: 1 } },
    material: { friction: 0.5, restitution: 0 },
    collider: { type: 'box', size: { x: 1, y: 1, z: 1 } },
    physics: { bodyType: 'dynamic', mass: 1 },
  };
}

function documentWith(
  entities: readonly SceneEntity[] = [model('a'), model('b')],
): Scene3DDocument {
  return {
    version: SCENE3D_VERSION,
    world: { gravity: { x: 0, y: -9.81, z: 0 }, physicsStep: 1000 / 60 },
    entities,
    environment: { ambientLight: { color: '#ffffff', intensity: 1 } },
  };
}

function transformBatch(count: number, y = 1): Float32Array {
  const batch = new Float32Array(count * TRANSFORM_STRIDE);
  for (let index = 0; index < count; index++) {
    const offset = index * TRANSFORM_STRIDE;
    batch[offset] = 1;
    batch[offset + 5] = 1;
    batch[offset + 10] = 1;
    batch[offset + 13] = y;
    batch[offset + 15] = 1;
  }
  return batch;
}

function stepResult(transforms: Float32Array, timeMs = 16, stepCount = 1): StepResult {
  return { transforms, collisions: [], timeMs, stepCount };
}

class RecordingView implements Scene3DView {
  public readonly added: string[] = [];
  public readonly removed: string[] = [];
  public readonly batches: Float32Array[] = [];
  public readonly resizes: Array<readonly [number, number]> = [];
  public renders = 0;
  public disposed = false;
  public failAdd = false;

  public addEntity(entity: SceneEntity): void {
    if (this.failAdd) throw new Error('view could not add entity');
    this.added.push(entity.id);
  }

  public removeEntity(id: string): void {
    this.removed.push(id);
  }

  public applyTransforms(transforms: Float32Array): void {
    this.batches.push(transforms);
  }

  public render(): void {
    this.renders++;
  }

  public resize(width: number, height: number): void {
    this.resizes.push([width, height]);
  }

  public dispose(): void {
    this.disposed = true;
  }
}

class FakeHost implements Scene3DHostProxy {
  public readonly calls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = [];
  public terminated = false;
  public terminateReason: string | undefined;
  public failTerminate = false;
  public handler: (method: string, args: readonly unknown[]) => unknown = () => undefined;

  public async call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    this.calls.push({ method, args });
    return (await this.handler(method, args)) as T;
  }

  public async terminate(reason?: string): Promise<void> {
    if (this.failTerminate) throw new Error('terminate failed');
    this.terminated = true;
    this.terminateReason = reason;
  }
}

async function createClient(
  options: {
    entities?: readonly SceneEntity[];
    host?: FakeHost;
    view?: RecordingView;
  } = {},
): Promise<{
  client: Scene3DClient;
  view: RecordingView;
  host: FakeHost;
  document: Scene3DDocument;
}> {
  const view = options.view ?? new RecordingView();
  const host = options.host ?? new FakeHost();
  const document = documentWith(options.entities);
  const client = await Scene3DClient.create({
    document,
    view,
    createHost: async () => host,
  });
  return { client, view, host, document };
}

describe('Scene3DClient creation', () => {
  it('adds every document entity to the view in order without touching the host', async () => {
    const { client, view, host } = await createClient();

    expect(view.added).toEqual(['a', 'b']);
    expect(host.calls).toEqual([]);
    expect(client.entityCount).toBe(2);
    expect(client.currentTime).toBe(0);
    expect(client.stepCount).toBe(0);
    expect(client.isDisposed).toBe(false);
  });

  it('rejects an invalid view, document or host factory', async () => {
    await expect(
      Scene3DClient.create({
        document: documentWith([]),
        view: {} as unknown as Scene3DView,
        createHost: async () => new FakeHost(),
      }),
    ).rejects.toThrow(/Scene3DView/);

    await expect(
      Scene3DClient.create({
        document: {} as unknown as Scene3DDocument,
        view: new RecordingView(),
        createHost: async () => new FakeHost(),
      }),
    ).rejects.toThrow(/document/);

    await expect(
      Scene3DClient.create({
        document: documentWith([]),
        view: new RecordingView(),
        createHost: null as unknown as () => Promise<Scene3DHostProxy>,
      }),
    ).rejects.toThrow(/createHost/);
  });

  it('rejects a host factory that returns something other than a proxy', async () => {
    await expect(
      Scene3DClient.create({
        document: documentWith([]),
        view: new RecordingView(),
        createHost: async () => ({}) as unknown as Scene3DHostProxy,
      }),
    ).rejects.toThrow(/Scene3DHostProxy/);
  });

  it('terminates the host and disposes the view when view construction fails', async () => {
    const view = new RecordingView();
    view.failAdd = true;
    const host = new FakeHost();

    await expect(
      Scene3DClient.create({ document: documentWith(), view, createHost: async () => host }),
    ).rejects.toThrow(/view could not add entity/);

    expect(host.terminated).toBe(true);
    expect(view.disposed).toBe(true);
  });
});

describe('Scene3DClient stepping', () => {
  it('sends the delta to the host, applies the batch and draws one frame', async () => {
    const { client, view, host } = await createClient();
    const batch = transformBatch(2, 3);
    host.handler = () => stepResult(batch, 16, 1);

    const result = await client.step(16);

    expect(host.calls).toEqual([{ method: 'step', args: [16] }]);
    expect(view.batches).toEqual([batch]);
    expect(view.renders).toBe(1);
    expect(result).toEqual({ transforms: batch, collisions: [], timeMs: 16, stepCount: 1 });
    expect(client.currentTime).toBe(16);
    expect(client.stepCount).toBe(1);
  });

  it('rejects invalid deltas locally', async () => {
    const { client, host } = await createClient();

    await expect(client.step(-1)).rejects.toThrow(RangeError);
    await expect(client.step(Number.NaN)).rejects.toThrow(RangeError);
    expect(host.calls).toEqual([]);
  });

  it('rejects a concurrent step', async () => {
    const { client, host } = await createClient();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    host.handler = async () => {
      await gate;
      return stepResult(transformBatch(2), 16, 1);
    };

    const pending = client.step(16);
    await flush();

    await expect(client.step(16)).rejects.toThrow(/already in progress/);

    release();
    await pending;
  });

  it('rejects a batch of the wrong length without rendering', async () => {
    const { client, view, host } = await createClient();
    host.handler = () => stepResult(transformBatch(1));

    await expect(client.step(16)).rejects.toThrow(Scene3DProtocolError);
    expect(view.renders).toBe(0);
    expect(client.currentTime).toBe(0);
  });

  it('rejects a batch that is not a Float32Array', async () => {
    const { client, host } = await createClient();
    host.handler = () => ({
      transforms: [1, 2, 3],
      collisions: [],
      timeMs: 16,
      stepCount: 1,
    });

    await expect(client.step(16)).rejects.toThrow(/Float32Array/);
  });

  it('rejects a result without a finite clock', async () => {
    const { client, host } = await createClient();
    host.handler = () => ({
      transforms: transformBatch(2),
      collisions: [],
      timeMs: Number.NaN,
      stepCount: 1,
    });

    await expect(client.step(16)).rejects.toThrow(/timeMs/);
  });

  it('refreshes transforms without stepping the host', async () => {
    const { client, view, host } = await createClient();
    const batch = transformBatch(2, 7);
    host.handler = () => batch;

    const transforms = await client.refreshTransforms();

    expect(host.calls).toEqual([{ method: 'getTransforms', args: [] }]);
    expect(transforms).toBe(batch);
    expect(view.batches).toEqual([batch]);
    expect(view.renders).toBe(1);
    expect(client.stepCount).toBe(0);
  });
});

describe('Scene3DClient entities', () => {
  it('adds an entity to the host before the view', async () => {
    const { client, view, host } = await createClient({ entities: [model('a')] });
    const added = model('b');

    await client.addEntity(added);

    expect(host.calls).toEqual([{ method: 'addEntity', args: [added] }]);
    expect(view.added).toEqual(['a', 'b']);
    expect(client.entityCount).toBe(2);
  });

  it('rejects duplicate ids without calling the host', async () => {
    const { client, host } = await createClient();

    await expect(client.addEntity(model('a'))).rejects.toThrow(/already exists/);
    expect(host.calls).toEqual([]);
  });

  it('rolls the host back when the view rejects an entity', async () => {
    const { client, view, host } = await createClient({ entities: [model('a')] });
    view.failAdd = true;

    await expect(client.addEntity(model('b'))).rejects.toThrow(/view could not add entity/);

    expect(host.calls).toEqual([
      { method: 'addEntity', args: [model('b')] },
      { method: 'removeEntity', args: ['b'] },
    ]);
    expect(client.entityCount).toBe(1);
  });

  it('removes an entity from the host and the view', async () => {
    const { client, view, host } = await createClient();

    await client.removeEntity('b');

    expect(host.calls).toEqual([{ method: 'removeEntity', args: ['b'] }]);
    expect(view.removed).toEqual(['b']);
    expect(client.entityCount).toBe(1);
  });

  it('rejects removal of an unknown entity without calling the host', async () => {
    const { client, host } = await createClient();

    await expect(client.removeEntity('missing')).rejects.toThrow(/unknown entity/);
    expect(host.calls).toEqual([]);
  });

  it('forwards resizes to the view', async () => {
    const { client, view } = await createClient();

    client.resize(640, 480);

    expect(view.resizes).toEqual([[640, 480]]);
  });
});

describe('Scene3DClient disposal', () => {
  it('terminates the host, disposes the view and is idempotent', async () => {
    const { client, view, host } = await createClient();

    await client.dispose();

    expect(host.terminated).toBe(true);
    expect(host.terminateReason).toBe('scene3d client disposed');
    expect(view.disposed).toBe(true);
    expect(client.isDisposed).toBe(true);
    await expect(client.step(16)).rejects.toThrow(/disposed/);
    await expect(client.dispose()).resolves.toBeUndefined();
  });

  it('disposes the view even when the host fails to terminate', async () => {
    const { client, view, host } = await createClient();
    host.failTerminate = true;

    await expect(client.dispose()).rejects.toThrow(/terminate failed/);

    expect(view.disposed).toBe(true);
    expect(client.isDisposed).toBe(true);
  });

  it('works with a host proxy that cannot terminate a sandbox', async () => {
    const view = new RecordingView();
    const host: Scene3DHostProxy = {
      call: (async () => stepResult(transformBatch(0))) as Scene3DHostProxy['call'],
    };
    const client = await Scene3DClient.create({
      document: documentWith([]),
      view,
      createHost: async () => host,
    });

    await expect(client.dispose()).resolves.toBeUndefined();
    expect(view.disposed).toBe(true);
  });
});

describe('createScene3DHostProxy', () => {
  it('adapts call and terminate of a sandbox handle', async () => {
    const calls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = [];
    let terminated = false;
    const handle: SandboxScene3DHostHandle = {
      async call(method, ...args) {
        calls.push({ method, args });
        return 42;
      },
      async terminate() {
        terminated = true;
      },
    };

    const proxy = createScene3DHostProxy(handle);

    await expect(proxy.call('step', 16)).resolves.toBe(42);
    expect(calls).toEqual([{ method: 'step', args: [16] }]);

    await proxy.terminate?.('done');
    expect(terminated).toBe(true);
  });

  it('omits terminate when the handle cannot terminate', async () => {
    const proxy = createScene3DHostProxy({ call: async () => undefined });

    expect(proxy.terminate).toBeUndefined();
  });

  it('rejects a missing handle', () => {
    expect(() => createScene3DHostProxy(null as unknown as SandboxScene3DHostHandle)).toThrow(
      TypeError,
    );
  });
});
