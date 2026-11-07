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
 *     const sandbox = await createScene3DHostSandbox();
 *     return createScene3DHostProxy(sandbox);
 *   },
 * });
 *
 * await client.step(1000 / 60);
 * ```
 */

import { createRpc } from '@mica-js/core/rpc';
import { SandboxWorker } from '@mica-js/sandbox';
import type { SceneEntity } from '../entities';
import type { BodyMotion, JointTarget } from '../physics';
import type { SensorData } from '../sensors/types';
import type { Scene3DDocument } from '../format/document';
import { circuitGuestWorkerScript } from './host-sandbox';
import {
  Scene3DProtocolError,
  TRANSFORM_STRIDE,
  sceneHostGuest,
  sceneHostHost,
  type Scene3DHostProxy,
  type SceneHostHostContract,
  type CircuitSandboxOptions,
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
  /** Document the host must simulate; also the document the main-thread service provides. */
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
   * (usually with `createScene3DHostSandbox()`).
   */
  readonly createHost: (context: Scene3DHostBootstrap) => Promise<Scene3DHostProxy | SandboxWorker>;
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

    const hostResult = await options.createHost({ document: options.document });
    const host = isSandboxWorker(hostResult)
      ? await createScene3DHostProxy(hostResult, { document: options.document })
      : hostResult;
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

  /** Sets a joint target directly on the sandboxed host. */
  public async setJointTarget(jointId: string, target: JointTarget): Promise<void> {
    this.assertUsable('setJointTarget');
    await this.host.call('setJointTarget', jointId, target);
  }

  /** Reads the most recent sample from every sensor that has produced one. */
  public async readSensors(): Promise<
    readonly { readonly sensorId: string; readonly data: SensorData }[]
  > {
    this.assertUsable('readSensors');
    return this.host.call<readonly { readonly sensorId: string; readonly data: SensorData }[]>(
      'getSensors',
    );
  }

  /** Overrides a body's world-space velocity; requires a physics runtime that supports it. */
  public async setBodyVelocity(bodyId: string, motion: BodyMotion): Promise<void> {
    this.assertUsable('setBodyVelocity');
    await this.host.call('setBodyVelocity', bodyId, motion);
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

/** Minimal injectable host seam used by unit tests and embedders with an existing RPC link. */
export interface Scene3DHostLike {
  call(method: string, ...args: unknown[]): Promise<unknown>;
  terminate?(reason?: string): Promise<void>;
}

/** Options used while connecting a real `SandboxWorker` to the scene host guest. */
export interface Scene3DHostWorkerOptions {
  readonly document: Scene3DDocument;
}

/** Adapts a fake host seam without creating a worker. */
export function createScene3DHostProxy(handle: Scene3DHostLike): Scene3DHostProxy;
/** Wires the scene-host RPC endpoint and its main-thread services. */
export function createScene3DHostProxy(
  worker: SandboxWorker,
  options: Scene3DHostWorkerOptions,
): Promise<Scene3DHostProxy>;
export function createScene3DHostProxy(
  handle: Scene3DHostLike | SandboxWorker,
  options?: Scene3DHostWorkerOptions,
): Scene3DHostProxy | Promise<Scene3DHostProxy> {
  if (isSandboxWorker(handle)) {
    if (options === undefined) {
      throw new TypeError('createScene3DHostProxy: worker options are required');
    }
    return connectScene3DHostProxy(handle, options);
  }
  if (typeof handle !== 'object' || handle === null || typeof handle.call !== 'function') {
    throw new TypeError('createScene3DHostProxy: a host seam is required');
  }
  const terminate =
    typeof handle.terminate === 'function' ? handle.terminate.bind(handle) : undefined;
  return {
    call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
      return handle.call(method, ...args) as Promise<T>;
    },
    ...(terminate === undefined ? {} : { terminate: (reason?: string) => terminate(reason) }),
  };
}

async function connectScene3DHostProxy(
  worker: SandboxWorker,
  options: Scene3DHostWorkerOptions,
): Promise<Scene3DHostProxy> {
  await worker.ready;
  const channel = new MessageChannel();
  const endpoint = createRpc(channel.port1);
  const children = new Map<string, SandboxWorker>();
  let closed = false;
  let markReady: (() => void) | undefined;
  let failReady: ((error: Error) => void) | undefined;
  const guestReady = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  // A guest that throws while booting never calls `ready()`; surface the worker error instead of
  // waiting out the timeout.
  const stopErrorWatch = worker.onError((error) => {
    failReady?.(new Error(`Scene3DHost guest failed to boot: ${error.message}`));
  });

  const hostServices: SceneHostHostContract = {
    getDocument: () => options.document,
    ready: () => {
      markReady?.();
    },
    async createCircuitSandbox(circuitOptions: CircuitSandboxOptions): Promise<MessagePort> {
      const child = new SandboxWorker(circuitGuestWorkerScript, {
        name: circuitOptions.name,
      });
      try {
        await child.ready;
        const childChannel = new MessageChannel();
        children.set(circuitOptions.name, child);
        child.postMessage(null, [childChannel.port2]);
        return childChannel.port1;
      } catch (error) {
        await child.terminate('circuit sandbox failed to start').catch(() => undefined);
        throw error;
      }
    },
    async releaseCircuitSandbox(name: string): Promise<void> {
      const child = children.get(name);
      if (child === undefined) return;
      children.delete(name);
      await child.terminate(`circuit "${name}" released`).catch(() => undefined);
    },
  };

  const registration = endpoint.register(sceneHostHost, hostServices, {
    transfer: (member, value) =>
      member === 'createCircuitSandbox' && isMessagePort(value) ? [value] : [],
  });
  worker.postMessage(null, [channel.port2]);
  try {
    await waitForGuestReady(guestReady);
  } catch (error) {
    stopErrorWatch();
    registration.dispose();
    endpoint.dispose();
    await worker.terminate('scene3d host failed to boot').catch(() => undefined);
    throw error;
  }
  const guest = endpoint.getProxy(sceneHostGuest);
  return {
    call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
      const member = (
        guest as unknown as Record<string, (...values: unknown[]) => Promise<unknown>>
      )[method];
      if (typeof member !== 'function') {
        return Promise.reject(new Error(`Unknown Scene3DHost method: ${method}`));
      }
      return member(...args) as Promise<T>;
    },
    async terminate(reason = 'scene3d client disposed'): Promise<void> {
      if (closed) return;
      closed = true;
      stopErrorWatch();
      registration.dispose();
      endpoint.dispose();
      await Promise.allSettled(
        [...children.values()].map((child) => child.terminate(`parent terminated: ${reason}`)),
      );
      children.clear();
      await worker.terminate(reason);
    },
  };
}

/** How long the main thread waits for the guest to register its RPC surface. */
const GUEST_READY_TIMEOUT_MS = 10_000;

/**
 * Waits for the guest's `ready()` signal.
 *
 * The sandbox forwards a worker boot error through `onError`, but a guest that never boots would
 * otherwise hang the caller, so the wait is bounded.
 */
async function waitForGuestReady(ready: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Scene3DHost guest did not become ready in time')),
          GUEST_READY_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isSandboxWorker(value: unknown): value is SandboxWorker {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ready' in value &&
    typeof (value as { readonly postMessage?: unknown }).postMessage === 'function' &&
    typeof (value as { readonly terminate?: unknown }).terminate === 'function'
  );
}

function isMessagePort(value: unknown): value is MessagePort {
  return typeof MessagePort !== 'undefined' && value instanceof MessagePort;
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
