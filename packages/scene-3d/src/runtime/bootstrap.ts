/**
 * Guest bootstrap shared by every `host.*` entry.
 *
 * The environment entries only choose *implementations* — physics engine, offscreen renderer and
 * circuit sandbox factory. Everything else lives here: fetching the document, creating the host,
 * exposing its RPC surface through `$sandbox.export()` and releasing children when the sandbox is
 * terminated.
 */

import type { SceneEntity } from '../entities';
import type { Scene3DDocument } from '../format/document';
import type { PhysicsRuntime } from '../physics';
import type { OffscreenRenderer } from '../rendering/renderer';
import { createScene3DHost, type Scene3DHostAPI, type Scene3DHostOptions } from './host';
import type { Scene3DCircuitOptions } from './protocol';
import type { GuestSandboxLike } from './guest';

/** Injection points of {@link bootstrapScene3DHost}. */
export interface Scene3DHostBootstrapOptions {
  /** `$sandbox` of the current guest. */
  readonly sandbox: GuestSandboxLike;
  /** Creates the physics engine (MuJoCo WASM in production, the in-memory runtime today). */
  readonly createPhysics: () => PhysicsRuntime;
  /** Creates the offscreen renderer of this environment. */
  readonly createRenderer: () => OffscreenRenderer;
  /** Circuit simulator wiring; omit for a physics-only host. */
  readonly circuits?: Scene3DCircuitOptions;
  /** Virtual start time in milliseconds. */
  readonly startTime?: number;
}

/**
 * Boots a `Scene3DHost` inside a sandbox guest.
 *
 * 1. reads the initial document through the `getDocument` capability;
 * 2. creates physics and rendering through the environment factories;
 * 3. creates the host (initial bodies + one circuit sandbox per assembly instance);
 * 4. exports `step`, `addEntity`, `removeEntity`, `getTransforms`, `getState` and `dispose`;
 * 5. disposes the host when the sandbox is terminated.
 */
export async function bootstrapScene3DHost(
  options: Scene3DHostBootstrapOptions,
): Promise<Scene3DHostAPI> {
  const { sandbox } = options;

  const document = await sandbox.invoke<Scene3DDocument>('getDocument');
  assertDocument(document);

  const hostOptions: Scene3DHostOptions = {
    document,
    physics: options.createPhysics(),
    renderer: options.createRenderer(),
    ...(options.circuits === undefined ? {} : { circuits: options.circuits }),
    ...(options.startTime === undefined ? {} : { startTime: options.startTime }),
  };

  const host = await createScene3DHost(hostOptions);

  try {
    registerScene3DHost(sandbox, host);
  } catch (error) {
    await host.dispose().catch(() => undefined);
    throw error;
  }

  return host;
}

/**
 * Publishes the host RPC surface on `$sandbox` and hooks termination.
 *
 * Arguments arrive untyped from another thread, so scalars are checked here; the host validates
 * everything else (deltas, entity shapes, protocol payloads).
 */
export function registerScene3DHost(sandbox: GuestSandboxLike, host: Scene3DHostAPI): void {
  sandbox.export({
    step: (deltaMs: unknown) => host.step(assertNumber(deltaMs, 'step.deltaMs')),
    addEntity: (entity: unknown) => host.addEntity(entity as SceneEntity),
    removeEntity: (id: unknown) => host.removeEntity(assertString(id, 'removeEntity.id')),
    getTransforms: () => host.getTransforms(),
    getState: () => host.getState(),
    dispose: () => host.dispose(),
  });

  sandbox.signal?.addEventListener(
    'abort',
    () => {
      // Terminating the sandbox also terminates its children; disposing here releases physics,
      // the renderer and any child that survived the parent's teardown.
      void host.dispose().catch((error: unknown) => {
        sandbox.log?.error('Scene3DHost: failed to dispose after termination', error);
      });
    },
    { once: true },
  );
}

function assertDocument(value: unknown): asserts value is Scene3DDocument {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Array.isArray((value as { entities?: unknown }).entities)
  ) {
    throw new TypeError('Scene3DHost: the getDocument capability must return a Scene3DDocument');
  }
}

function assertNumber(value: unknown, label: string): number {
  if (typeof value !== 'number') {
    throw new TypeError(`Scene3DHost RPC: ${label} must be a number`);
  }
  return value;
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`Scene3DHost RPC: ${label} must be a non-empty string`);
  }
  return value;
}
