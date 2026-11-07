/**
 * Integration tests for the guest half of the split runtime.
 *
 * The scene host and its circuit simulators talk over two real `MessageChannel`s, exactly like the
 * browser wiring, so these tests cover what unit tests cannot: the RPC handshake, the direct
 * host↔circuit channel and the main-thread release callback that stops a circuit worker.
 */

import { describe, expect, it } from 'vitest';
import { createRpc } from '@mica-js/core/rpc';
import type { RpcEndpoint } from '@mica-js/core/rpc';
import { SCENE3D_VERSION } from '../../format/version';
import type { Scene3DDocument } from '../../format/document';
import type { AssemblyInstance, ModelEntity, SceneEntity } from '../../entities';
import { createMujocoRuntime } from '../../physics/mujoco-runtime';
import { createOffscreenRenderer } from '../../rendering/renderer.mock';
import {
  sceneHostHost,
  type CircuitSandboxOptions,
  type SceneHostHostContract,
} from '../../runtime/protocol';
import { startCircuitRuntime } from '../circuit/runtime';
import type { CircuitWorkerRuntime } from '../circuit/runtime';
import { startSceneHostRuntime } from './runtime';

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 } as const;

function model(id: string): ModelEntity {
  return {
    id,
    type: 'model',
    position: { x: 0, y: 5, z: 0 },
    rotation: IDENTITY,
    geometry: { type: 'box', size: { x: 1, y: 1, z: 1 } },
    material: { color: '#ffffff', friction: 0.5, restitution: 0 },
    collider: { type: 'sphere', radius: 0.5 },
    physics: { bodyType: 'dynamic', mass: 1 },
  };
}

function assembly(id: string): AssemblyInstance {
  return {
    id,
    type: 'assembly',
    position: { x: 0, y: 0, z: 0 },
    rotation: IDENTITY,
    assembly: 'robots:line-follower',
  };
}

function documentWith(entities: readonly SceneEntity[]): Scene3DDocument {
  return {
    version: SCENE3D_VERSION,
    schematic: 'robot.schematic.json',
    world: { gravity: { x: 0, y: -9.81, z: 0 }, physicsStep: 1000 / 60 },
    entities,
    environment: { ambientLight: { color: '#ffffff', intensity: 1 } },
  };
}

interface Harness {
  readonly runtime: Awaited<ReturnType<typeof startSceneHostRuntime>>;
  readonly steps: number[];
  readonly released: string[];
  readonly created: CircuitSandboxOptions[];
  readonly circuits: Map<string, CircuitWorkerRuntime>;
  readonly mainEndpoint: RpcEndpoint;
  dispose(): Promise<void>;
}

/**
 * Wires a scene-host guest to a fake main thread over a real channel pair.
 *
 * The main thread plays the role `Scene3DClient` plays in the browser: it answers `getDocument`,
 * spawns one circuit guest per request and terminates it when the guest asks for a release. Each
 * circuit gets its own channel because transferring a port detaches it.
 */
async function createHarness(entities: readonly SceneEntity[]): Promise<Harness> {
  const channel = new MessageChannel();
  const mainEndpoint = createRpc(channel.port1);
  const steps: number[] = [];
  const released: string[] = [];
  const created: CircuitSandboxOptions[] = [];
  const circuits = new Map<string, CircuitWorkerRuntime>();

  const services: SceneHostHostContract = {
    getDocument: () => documentWith(entities),
    async createCircuitSandbox(options) {
      created.push(options);
      const circuitChannel = new MessageChannel();
      circuits.set(
        options.name,
        startCircuitRuntime(circuitChannel.port2, {
          step(deltaMs) {
            steps.push(deltaMs);
          },
        }),
      );
      return circuitChannel.port1;
    },
    async releaseCircuitSandbox(name) {
      released.push(name);
      circuits.get(name)?.dispose();
      circuits.delete(name);
    },
  };

  const registration = mainEndpoint.register(sceneHostHost, services, {
    transfer: (member, value) =>
      member === 'createCircuitSandbox' && value instanceof MessagePort ? [value] : [],
  });

  const runtime = await startSceneHostRuntime(channel.port2, {
    createPhysics: () => createMujocoRuntime(),
    createRenderer: () => createOffscreenRenderer(),
  });

  return {
    runtime,
    steps,
    released,
    created,
    circuits,
    mainEndpoint,
    async dispose() {
      await runtime.dispose();
      registration.dispose();
      mainEndpoint.dispose();
      channel.port1.close();
      channel.port2.close();
      for (const circuit of circuits.values()) circuit.dispose();
      circuits.clear();
    },
  };
}

describe('scene host guest wiring', () => {
  it('creates one circuit guest per assembly instance', async () => {
    const harness = await createHarness([model('ball'), assembly('car-1'), assembly('car-2')]);

    expect(harness.created.map((options) => options.name)).toEqual([
      'circuit-car-1',
      'circuit-car-2',
    ]);
    expect(harness.created[0]?.entityId).toBe('car-1');
    expect(harness.created[0]?.assembly).toBe('robots:line-follower');
    expect(harness.created[0]?.schematic).toBe('robot.schematic.json');

    await harness.dispose();
  });

  it('drives every circuit to the barrier before physics advances', async () => {
    const harness = await createHarness([assembly('car-1')]);

    await harness.runtime.host.step(16);

    expect(harness.steps).toEqual([16]);

    await harness.dispose();
  });

  it('releases the circuit worker when an entity is removed', async () => {
    const harness = await createHarness([assembly('car-1')]);

    await harness.runtime.host.removeEntity('car-1');

    expect(harness.released).toEqual(['circuit-car-1']);

    await harness.dispose();
  });

  it('releases every circuit when the host is disposed', async () => {
    const harness = await createHarness([assembly('car-1'), assembly('car-2')]);

    await harness.runtime.host.dispose();

    expect(harness.released.sort()).toEqual(['circuit-car-1', 'circuit-car-2']);

    await harness.dispose();
  });

  it('stops accepting steps after disposal', async () => {
    const harness = await createHarness([assembly('car-1')]);
    await harness.runtime.host.dispose();

    await expect(harness.runtime.host.step(16)).rejects.toThrow();

    await harness.dispose();
  });
});
