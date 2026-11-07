/**
 * `Scene3DClient` — the main-thread half of the split runtime.
 *
 * The client never simulates anything. It owns the visible scene, the user input and the render
 * loop, and forwards every frame to a `Scene3DHost` running in a sandbox:
 *
 * ```
 * step(deltaMs)
 *   1. RPC: host.step(deltaMs)   → one transform batch for every entity
 *   2. view.applyTransforms(batch)
 *   3. view.render()
 * ```
 *
 * Rendering is a port ({@link Scene3DView}) rather than a Three.js dependency of the core, so the
 * orchestration is testable in Node and the Three.js adapter lives in `three-view.ts`.
 *
 * ```ts
 * const client = await Scene3DClient.create({
 *   document,
 *   view: createThreeScene3DView({ canvas }),
 *   createHost: async ({ document }) => {
 *     const sandbox = await createSandbox({ … , capabilities: { getDocument: () => document } });
 *     return createScene3DHostProxy(sandbox);
 *   },
 * });
 *
 * await client.step(1000 / 60);
 * ```
 */

import type { SceneEntity } from '../entities';
import type { Scene3DDocument } from '../format/document';
import {
  Scene3DProtocolError,
  TRANSFORM_STRIDE,
  type Scene3DHostProxy,
  type StepResult,
} from '../runtime/protocol';

/** Visible scene owned by the main thread. */
export interface Scene3DView {
  /** Adds the visual representation of an entity. */
  addEntity(entity: SceneEntity): void;
  /** Removes it and releases its GPU resources. */
  removeEntity(id: string): void;
  /**
   * Applies one transform batch.
   *
   * The batch is in the order entities were added, `TRANSFORM_STRIDE` floats each, column-major.
   */
  applyTransforms(transforms: Float32Array): void;
  /** Draws one frame. */
  render(): void;
  /** Resizes the drawing surface and camera. */
  resize?(width: number, height: number): void;
  /** Releases every view resource; idempotent. */
  dispose(): void;
}

/** Context handed to the host factory. */
export interface Scene3DHostBootstrap {
  /** Document the host must simulate; also the document the sandbox capability serves. */
  readonly document: Scene3DDocument;
}

/** Options of {@link Scene3DClient.create}. */
export interface Scene3DClientOptions {
  /** Document of the scene; its entities are added to the view in order. */
  readonly document: Scene3DDocument;
  /** Main-thread renderer of the scene. The client takes ownership of it. */
  readonly view: Scene3DView;
  /**
   * Boots the `Scene3DHost` sandbox and returns its RPC proxy.
   *
   * The client cannot import a guest entry itself, so the application wires the sandbox here
   * (usually with `createSandbox({ source: { type: 'module', url: hostUrl } })`).
   */
  readonly createHost: (context: Scene3DHostBootstrap) => Promise<Scene3DHostProxy>;
}

/**
 * Main-thread client of a sandboxed simulation host.
 *
 * `step()` is the only method that advances time; `refreshTransforms()` resynchronises the view
 * without stepping, which is useful after a reconnect or a resize.
 */
export class Scene3DClient {
  private readonly sceneDocument: Scene3DDocument;
  private readonly view: Scene3DView;
  private readonly host: Scene3DHostProxy;
  private readonly entityIds: string[] = [];

  private timeMs = 0;
  private completedSteps = 0;
  private disposed = false;
  private stepping = false;

  private constructor(document: Scene3DDocument, view: Scene3DView, host: Scene3DHostProxy) {
    this.sceneDocument = document;
    this.view = view;
    this.host = host;
  }

  /**
   * Boots the host, builds the view and returns a ready client.
   *
   * If view construction fails, the host sandbox is terminated before the error is rethrown.
   */
  public static async create(options: Scene3DClientOptions): Promise<Scene3DClient> {
    assertClientOptions(options);

    const host = await options.createHost({ document: options.document });
    if (typeof host !== 'object' || host === null || typeof host.call !== 'function') {
      throw new TypeError('Scene3DClient.create: createHost() must return a Scene3DHostProxy');
    }

    const client = new Scene3DClient(options.document, options.view, host);
    try {
      for (const entity of options.document.entities) {
        options.view.addEntity(entity);
        client.entityIds.push(entity.id);
      }
    } catch (error) {
      await client.dispose().catch(() => undefined);
      throw error;
    }

    return client;
  }

  /** Virtual time of the last completed host step, in milliseconds. */
  public get currentTime(): number {
    return this.timeMs;
  }

  /** Document the client renders. */
  public get document(): Scene3DDocument {
    return this.sceneDocument;
  }

  /** Number of completed steps. */
  public get stepCount(): number {
    return this.completedSteps;
  }

  /** Number of entities in the current transform batch. */
  public get entityCount(): number {
    return this.entityIds.length;
  }

  /** Whether {@link Scene3DClient.dispose} has run. */
  public get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Advances the simulation by `deltaMs` virtual milliseconds and draws the resulting frame.
   *
   * The host runs the whole lockstep; the client only transports the shared delta and applies the
   * transform batch it gets back.
   */
  public async step(deltaMs: number): Promise<StepResult> {
    this.assertUsable('step');
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      throw new RangeError('Scene3DClient.step: deltaMs must be a finite number >= 0');
    }
    if (this.stepping) {
      throw new Error('Scene3DClient.step: a step is already in progress');
    }

    this.stepping = true;
    try {
      const result = await this.host.call<StepResult>('step', deltaMs);
      const transforms = this.assertStepResult(result);
      this.timeMs = result.timeMs;
      this.completedSteps = result.stepCount;
      this.view.applyTransforms(transforms);
      this.view.render();
      return result;
    } finally {
      this.stepping = false;
    }
  }

  /** Re-reads the transform batch from the host without advancing the simulation. */
  public async refreshTransforms(): Promise<Float32Array> {
    this.assertUsable('refreshTransforms');
    const transforms = await this.host.call<Float32Array>('getTransforms');
    this.view.applyTransforms(this.assertTransforms(transforms));
    this.view.render();
    return transforms;
  }

  /** Adds an entity to the host and to the visible scene. */
  public async addEntity(entity: SceneEntity): Promise<void> {
    this.assertUsable('addEntity');
    assertEntityId(entity);
    if (this.entityIds.includes(entity.id)) {
      throw new Error(`Scene3DClient.addEntity: entity "${entity.id}" already exists`);
    }

    await this.host.call('addEntity', entity);
    try {
      this.view.addEntity(entity);
    } catch (error) {
      await this.host.call('removeEntity', entity.id).catch(() => undefined);
      throw error;
    }
    this.entityIds.push(entity.id);
  }

  /** Removes an entity from the host and from the visible scene. */
  public async removeEntity(id: string): Promise<void> {
    this.assertUsable('removeEntity');
    if (typeof id !== 'string' || id === '') {
      throw new TypeError('Scene3DClient.removeEntity: id must be a non-empty string');
    }

    const index = this.entityIds.indexOf(id);
    if (index === -1) {
      throw new Error(`Scene3DClient.removeEntity: unknown entity "${id}"`);
    }

    await this.host.call('removeEntity', id);
    this.entityIds.splice(index, 1);
    this.view.removeEntity(id);
  }

  /** Resizes the drawing surface; no-op when the view cannot resize. */
  public resize(width: number, height: number): void {
    this.assertUsable('resize');
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new RangeError(
        'Scene3DClient.resize: width and height must be finite positive numbers',
      );
    }
    this.view.resize?.(width, height);
  }

  /**
   * Terminates the host sandbox and releases the view.
   *
   * Idempotent. Both resources are released even when one of them throws; the first failure is
   * rethrown after cleanup.
   */
  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    let failure: unknown;
    let failed = false;

    const terminate =
      typeof this.host.terminate === 'function' ? this.host.terminate.bind(this.host) : undefined;
    if (terminate !== undefined) {
      try {
        await terminate('scene3d client disposed');
      } catch (error) {
        failure = error;
        failed = true;
      }
    }

    try {
      this.view.dispose();
    } catch (error) {
      if (!failed) {
        failure = error;
        failed = true;
      }
    }

    if (failed) throw failure;
  }

  private assertStepResult(result: StepResult): Float32Array {
    if (typeof result !== 'object' || result === null) {
      throw new Scene3DProtocolError('Scene3DClient.step: the host returned an invalid StepResult');
    }
    if (typeof result.timeMs !== 'number' || !Number.isFinite(result.timeMs)) {
      throw new Scene3DProtocolError('Scene3DClient.step: StepResult.timeMs must be finite');
    }
    if (typeof result.stepCount !== 'number' || !Number.isFinite(result.stepCount)) {
      throw new Scene3DProtocolError('Scene3DClient.step: StepResult.stepCount must be finite');
    }
    return this.assertTransforms(result.transforms);
  }

  private assertTransforms(transforms: unknown): Float32Array {
    if (!(transforms instanceof Float32Array)) {
      throw new Scene3DProtocolError(
        'Scene3DClient: the host must return transforms as a Float32Array',
      );
    }
    const expected = this.entityIds.length * TRANSFORM_STRIDE;
    if (transforms.length !== expected) {
      throw new Scene3DProtocolError(
        `Scene3DClient: expected ${String(expected)} transform floats for ` +
          `${String(this.entityIds.length)} entities, received ${String(transforms.length)}`,
      );
    }
    return transforms;
  }

  private assertUsable(action: string): void {
    if (this.disposed) {
      throw new Error(`Scene3DClient.${action}: the client has been disposed`);
    }
  }
}

/**
 * Structural view of a host sandbox handle.
 *
 * `SandboxHandle` satisfies it; declaring it locally keeps this module independent of the sandbox
 * package while still type-checking the adapter in one place.
 */
export interface SandboxScene3DHostHandle {
  call(method: string, ...args: never[]): Promise<unknown>;
  terminate?(reason?: string): Promise<void>;
}

/**
 * Adapts a `SandboxHandle` to {@link Scene3DHostProxy}.
 *
 * ```ts
 * const sandbox = await createSandbox({ … });
 * const client = await Scene3DClient.create({ …, createHost: async () => createScene3DHostProxy(sandbox) });
 * ```
 */
export function createScene3DHostProxy(handle: SandboxScene3DHostHandle): Scene3DHostProxy {
  if (typeof handle !== 'object' || handle === null || typeof handle.call !== 'function') {
    throw new TypeError('createScene3DHostProxy: a sandbox handle is required');
  }

  const terminate =
    typeof handle.terminate === 'function' ? handle.terminate.bind(handle) : undefined;

  return {
    call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
      return handle.call(method, ...(args as never[])) as Promise<T>;
    },
    ...(terminate === undefined ? {} : { terminate: (reason?: string) => terminate(reason) }),
  };
}

function assertClientOptions(options: Scene3DClientOptions): void {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('Scene3DClient: options are required');
  }

  const document = options.document;
  if (typeof document !== 'object' || document === null || !Array.isArray(document.entities)) {
    throw new TypeError('Scene3DClient: options.document with an entities array is required');
  }

  const view = options.view;
  if (
    typeof view !== 'object' ||
    view === null ||
    typeof view.addEntity !== 'function' ||
    typeof view.removeEntity !== 'function' ||
    typeof view.applyTransforms !== 'function' ||
    typeof view.render !== 'function' ||
    typeof view.dispose !== 'function'
  ) {
    throw new TypeError('Scene3DClient: options.view must be a Scene3DView');
  }

  if (typeof options.createHost !== 'function') {
    throw new TypeError('Scene3DClient: options.createHost must be a function');
  }
}

function assertEntityId(value: unknown): asserts value is SceneEntity {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('Scene3DClient.addEntity: an entity object is required');
  }
  const id = (value as { readonly id?: unknown }).id;
  if (typeof id !== 'string' || id === '') {
    throw new TypeError('Scene3DClient.addEntity: entity.id must be a non-empty string');
  }
}
