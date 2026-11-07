import { describe, expect, it } from 'vitest';
import type { AssemblyInstance, ModelEntity } from '../entities';
import { SCENE3D_VERSION } from '../format';
import type { Scene3DDocument } from '../format';
import { createMujocoRuntime } from '../physics/mujoco-runtime';
import { createOffscreenRenderer } from '../rendering/renderer.mock';
import { registerScene3DHost, bootstrapScene3DHost } from './bootstrap';
import type { Scene3DHostAPI } from './host';
import {
  createChildCircuitOptions,
  getGuestSandbox,
  optionalInvoke,
  parseCircuitSource,
} from './guest';
import type { GuestChildSandboxOptions, GuestSandboxLike } from './guest';
import { Scene3DProtocolError } from './protocol';
import type { CircuitSandboxHandle, StepResult } from './protocol';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function model(id: string): ModelEntity {
  return {
    id,
    type: 'model',
    position: { x: 0, y: 1, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    geometry: { type: 'sphere', radius: 0.2 },
    material: { friction: 0.4, restitution: 0 },
    collider: { type: 'sphere', radius: 0.2 },
    physics: { bodyType: 'dynamic', mass: 1 },
  };
}

function documentWith(entities: Scene3DDocument['entities']): Scene3DDocument {
  return {
    version: SCENE3D_VERSION,
    world: { gravity: { x: 0, y: -9.81, z: 0 }, physicsStep: 1000 / 60 },
    entities,
    environment: { ambientLight: { color: '#ffffff', intensity: 1 } },
  };
}

class FakeSandbox implements GuestSandboxLike {
  public readonly exported: Record<string, (...args: never[]) => unknown> = {};
  public readonly invocations: Array<{ readonly name: string; readonly args: readonly unknown[] }> =
    [];
  public readonly children: GuestChildSandboxOptions[] = [];
  public readonly log: Console = console;
  public readonly signal: AbortSignal;
  public childHandle: unknown = {
    name: 'circuit',
    call: async () => undefined,
    on: () => () => undefined,
    terminate: async () => undefined,
  };

  public constructor(
    private readonly document: unknown,
    controller: AbortController,
  ) {
    this.signal = controller.signal;
  }

  public async invoke<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
    this.invocations.push({ name, args });
    if (name === 'getDocument') return this.document as T;
    throw Object.assign(new Error(`unknown capability "${name}"`), {
      code: 'capability-not-found',
    });
  }

  public export(methods: Record<string, (...args: never[]) => unknown>): void {
    Object.assign(this.exported, methods);
  }

  public async createChildSandbox<T = unknown>(options: GuestChildSandboxOptions): Promise<T> {
    this.children.push(options);
    return this.childHandle as T;
  }
}

function createSandbox(document: unknown): { sandbox: FakeSandbox; controller: AbortController } {
  const controller = new AbortController();
  return { sandbox: new FakeSandbox(document, controller), controller };
}

describe('bootstrapScene3DHost', () => {
  it('reads the document, boots the host and exports the RPC surface', async () => {
    const { sandbox } = createSandbox(documentWith([model('ball')]));

    const host = await bootstrapScene3DHost({
      sandbox,
      createPhysics: () => createMujocoRuntime(),
      createRenderer: () => createOffscreenRenderer(),
      startTime: 10,
    });

    expect(sandbox.invocations.map((call) => call.name)).toEqual(['getDocument']);
    expect(Object.keys(sandbox.exported).sort()).toEqual([
      'addEntity',
      'dispose',
      'getState',
      'getTransforms',
      'removeEntity',
      'step',
    ]);
    expect(host.currentTime).toBe(10);

    const step = sandbox.exported.step as (deltaMs: number) => Promise<StepResult>;
    const result = await step(16);

    expect(result.timeMs).toBe(26);
    expect(result.transforms).toHaveLength(16);

    const getState = sandbox.exported.getState as () => { stepCount: number };
    expect(getState().stepCount).toBe(1);

    await host.dispose();
  });

  it('wires circuit simulators through the child sandbox factory', async () => {
    const circuit = {
      name: 'circuit-robot',
      call: async () => undefined,
      on: () => () => undefined,
      terminate: async () => undefined,
    } satisfies CircuitSandboxHandle;
    const assemblyEntity: AssemblyInstance = {
      id: 'robot',
      type: 'assembly',
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      assembly: 'robots:line-follower',
    };
    const { sandbox } = createSandbox(documentWith([assemblyEntity]));
    sandbox.childHandle = circuit;

    const host = await bootstrapScene3DHost({
      sandbox,
      createPhysics: () => createMujocoRuntime(),
      createRenderer: () => createOffscreenRenderer(),
      circuits: createChildCircuitOptions(sandbox, { type: 'module', url: 'circuit.js' }),
    });

    expect(sandbox.children).toHaveLength(1);
    expect(sandbox.children[0]?.name).toBe('circuit-robot');
    expect(host.circuitCount).toBe(1);

    await host.dispose();
  });

  it('rejects a missing or malformed document', async () => {
    const missing = createSandbox(undefined);
    await expect(
      bootstrapScene3DHost({
        sandbox: missing.sandbox,
        createPhysics: () => createMujocoRuntime(),
        createRenderer: () => createOffscreenRenderer(),
      }),
    ).rejects.toThrow(/getDocument/);

    const malformed = createSandbox({ version: 1 });
    await expect(
      bootstrapScene3DHost({
        sandbox: malformed.sandbox,
        createPhysics: () => createMujocoRuntime(),
        createRenderer: () => createOffscreenRenderer(),
      }),
    ).rejects.toThrow(/Scene3DDocument/);
  });

  it('disposes the host when the sandbox is terminated', async () => {
    const { sandbox, controller } = createSandbox(documentWith([]));
    const host = await bootstrapScene3DHost({
      sandbox,
      createPhysics: () => createMujocoRuntime(),
      createRenderer: () => createOffscreenRenderer(),
    });

    controller.abort();
    await flush();

    await expect(host.step(16)).rejects.toThrow(/disposed/);
    await expect(host.dispose()).resolves.toBeUndefined();
  });
});

describe('registerScene3DHost', () => {
  it('validates scalar RPC arguments', async () => {
    const { sandbox } = createSandbox(documentWith([]));
    const host = await bootstrapScene3DHost({
      sandbox,
      createPhysics: () => createMujocoRuntime(),
      createRenderer: () => createOffscreenRenderer(),
    });

    const step = sandbox.exported.step as (value: unknown) => unknown;
    expect(() => step('16')).toThrow(TypeError);

    const stepNumber = sandbox.exported.step as (value: number) => Promise<StepResult>;
    await expect(stepNumber(Number.NaN)).rejects.toThrow(RangeError);

    const removeEntity = sandbox.exported.removeEntity as (value: unknown) => unknown;
    expect(() => removeEntity('')).toThrow(TypeError);

    await host.dispose();
  });

  it('propagates host failures to the RPC caller', async () => {
    const sandbox = new FakeSandbox(documentWith([]), new AbortController());
    const host: Scene3DHostAPI = {
      step: async () => {
        throw new Scene3DProtocolError('boom');
      },
      addEntity: async () => undefined,
      removeEntity: async () => undefined,
      getTransforms: () => new Float32Array(0),
      getState: () => ({ timeMs: 0, stepCount: 0, entityCount: 0, circuitCount: 0 }),
      dispose: async () => undefined,
      currentTime: 0,
      stepCount: 0,
      entityCount: 0,
      circuitCount: 0,
    };

    registerScene3DHost(sandbox, host);

    const step = sandbox.exported.step as (deltaMs: number) => Promise<StepResult>;
    await expect(step(16)).rejects.toThrow('boom');
  });
});

describe('guest helpers', () => {
  it('reads $sandbox from the scope and reports a clear error otherwise', () => {
    const { sandbox } = createSandbox(documentWith([]));

    expect(getGuestSandbox({ $sandbox: sandbox })).toBe(sandbox);
    expect(() => getGuestSandbox({})).toThrow(/\$sandbox is not available/);
    expect(() => getGuestSandbox(null)).toThrow(/\$sandbox is not available/);
  });

  it('treats only capability-not-found as an absent optional capability', async () => {
    const { sandbox } = createSandbox(documentWith([]));

    await expect(optionalInvoke(sandbox, 'getCircuitSource')).resolves.toBeNull();

    const failing = new FakeSandbox(documentWith([]), new AbortController());
    failing.invoke = async () => {
      throw new Error('network down');
    };
    await expect(optionalInvoke(failing, 'getCircuitSource')).rejects.toThrow('network down');
  });

  it('parses circuit sources', () => {
    expect(parseCircuitSource({ type: 'module', url: 'circuit.js' })).toEqual({
      type: 'module',
      url: 'circuit.js',
    });
    expect(parseCircuitSource({ type: 'script', code: 'postMessage(1)' })).toEqual({
      type: 'script',
      code: 'postMessage(1)',
    });
    expect(parseCircuitSource(null)).toBeNull();
    expect(parseCircuitSource({ type: 'worker' })).toBeNull();
    expect(parseCircuitSource({ type: 'module' })).toBeNull();
    expect(parseCircuitSource({ type: 'module', url: '' })).toBeNull();
  });

  it('creates child circuit sandboxes with per-instance capabilities', async () => {
    const { sandbox } = createSandbox(documentWith([]));
    sandbox.childHandle = {
      name: 'circuit-robot',
      call: async () => undefined,
      on: () => () => undefined,
      terminate: async () => undefined,
    };
    const circuits = createChildCircuitOptions(sandbox, { type: 'module', url: 'circuit.js' });

    const handle = await circuits.createSandbox({
      name: 'circuit-robot',
      entityId: 'robot',
      assembly: 'robots:line-follower',
      schematic: 'robot.schematic.json',
    });

    expect(handle.name).toBe('circuit-robot');
    const child = sandbox.children[0];
    expect(child?.name).toBe('circuit-robot');
    expect(child?.source).toEqual({ type: 'module', url: 'circuit.js' });

    const capabilities = child?.capabilities ?? {};
    expect(capabilities.getEntityId?.()).toBe('robot');
    expect(capabilities.getAssembly?.()).toBe('robots:line-follower');
    expect(capabilities.getSchematic?.()).toBe('robot.schematic.json');
  });
});
