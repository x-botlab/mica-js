import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssemblyDefinition } from '../assembly';
import type {
  AssemblyInstance,
  BodyType,
  ModelEntity,
  PhysicsConfig,
  SceneEntity,
  SensorEntity,
} from '../entities';
import { SCENE3D_VERSION } from '../format';
import type { Scene3DDocument } from '../format';
import type { Vec3d } from '../math';
import { createMujocoRuntime } from '../physics/mujoco-runtime';
import type {
  BodyTransform,
  JointConfig,
  JointState,
  JointTarget,
  PhysicsRuntime,
  RaycastHit,
  RigidBodyConfig,
} from '../physics';
import { OffscreenRendererDisposedError } from '../rendering/renderer';
import type { OffscreenRenderer } from '../rendering/renderer';
import { createOffscreenRenderer } from '../rendering/renderer.mock';
import type { MockOffscreenRenderer } from '../rendering/renderer.mock';
import { Sensor } from '../sensors/base';
import { MockSensor } from '../sensors/base';
import { sensorRegistry } from '../sensors/registry';
import type { SensorData } from '../sensors/types';
import { createScene3DHost } from './host';
import { Scene3DProtocolError } from './protocol';
import type {
  CircuitSandboxFactory,
  CircuitSandboxHandle,
  CircuitSandboxOptions,
  Scene3DCircuitOptions,
  StepResult,
} from './protocol';
import { readBatchTranslation } from './transforms';

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 } as const;

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function model(
  id: string,
  position: Vec3d = { x: 0, y: 10, z: 0 },
  bodyType: BodyType = 'dynamic',
): ModelEntity {
  return {
    id,
    type: 'model',
    position,
    rotation: IDENTITY,
    geometry: { type: 'box', size: { x: 1, y: 1, z: 1 } },
    material: { color: '#ffffff', friction: 0.5, restitution: 0 },
    collider: { type: 'sphere', radius: 0.5 },
    physics: { bodyType, mass: 1 },
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

function documentWith(entities: readonly SceneEntity[], schematic?: string): Scene3DDocument {
  return {
    version: SCENE3D_VERSION,
    ...(schematic === undefined ? {} : { schematic }),
    world: {
      gravity: { x: 0, y: -9.81, z: 0 },
      physicsStep: 1000 / 60,
    },
    entities,
    environment: { ambientLight: { color: '#ffffff', intensity: 1 } },
  };
}

function distanceSensor(id = 'sensor-1', updateRate = 10): SensorEntity {
  return {
    id,
    type: 'sensor',
    position: { x: 0, y: 0, z: 0 },
    rotation: IDENTITY,
    sensorType: 'distance',
    config: { type: 'distance', maxRange: 2, fov: 15, updateRate },
  };
}

function assemblyDefinition(entities: readonly SceneEntity[]): AssemblyDefinition {
  return {
    version: 1,
    name: 'line-follower',
    schematic: 'robot.schematic.json',
    entities,
  };
}

/** Sensor that always throws, used to prove a broken sensor cannot abort a frame. */
class FailingSensor extends Sensor {
  protected update(): SensorData {
    throw new Error('sensor hardware exploded');
  }
}

/** Delegating wrapper that records the calls the host makes, in order. */
class RecordingPhysics implements PhysicsRuntime {
  public readonly log: string[] = [];
  public readonly targets: Array<{ readonly jointId: string; readonly target: JointTarget }> = [];
  public disposed = false;
  private readonly inner = createMujocoRuntime();
  private readonly joints = new Set<string>();

  public constructor(private readonly events: string[] = []) {}

  public async initialize(config: PhysicsConfig): Promise<void> {
    this.log.push('physics.initialize');
    await this.inner.initialize(config);
  }

  public step(deltaMs: number): void {
    this.log.push('physics.step');
    this.events.push('physics.step');
    this.inner.step(deltaMs);
  }

  public addBody(config: RigidBodyConfig): string {
    this.log.push(`physics.addBody:${config.id ?? ''}`);
    return this.inner.addBody(config);
  }

  public addJoint(config: JointConfig): string {
    const id = this.inner.addJoint(config);
    this.joints.add(id);
    return id;
  }

  public setJointTarget(jointId: string, target: JointTarget): void {
    this.log.push(`physics.setJointTarget:${jointId}`);
    this.events.push(`physics.setJointTarget:${jointId}`);
    this.targets.push({ jointId, target });
    // Only delegate for joints the recording runtime actually created, so a host test that targets
    // a made-up joint does not depend on engine validation.
    if (this.joints.has(jointId)) this.inner.setJointTarget(jointId, target);
  }

  public getBodyTransform(bodyId: string): BodyTransform {
    return this.inner.getBodyTransform(bodyId);
  }

  public getJointState(jointId: string): JointState {
    return this.inner.getJointState(jointId);
  }

  public raycast(origin: Vec3d, direction: Vec3d, maxDistance: number): RaycastHit | null {
    return this.inner.raycast(origin, direction, maxDistance);
  }

  public removeBody(bodyId: string): void {
    this.log.push(`physics.removeBody:${bodyId}`);
    this.inner.removeBody(bodyId);
  }

  public dispose(): void {
    this.log.push('physics.dispose');
    this.disposed = true;
    this.inner.dispose();
  }
}

/** Circuit simulator double speaking the direct-MessageChannel protocol. */
class FakeCircuit implements CircuitSandboxHandle {
  public readonly name: string;
  public readonly options: CircuitSandboxOptions;
  public readonly steps: number[] = [];
  public readonly emitted: unknown[] = [];
  public readonly notifications: Array<{
    readonly method: string;
    readonly args: readonly unknown[];
  }> = [];
  public terminated = false;
  public failTerminate = false;
  public failNotify = false;
  private readonly listeners = new Set<(payload: unknown) => void>();
  private readonly onStep:
    ((deltaMs: number, circuit: FakeCircuit) => Promise<void> | void) | undefined;

  public constructor(
    options: CircuitSandboxOptions,
    onStep?: (deltaMs: number, circuit: FakeCircuit) => Promise<void> | void,
  ) {
    this.options = options;
    this.name = options.name;
    this.onStep = onStep;
  }

  public emit(command: unknown): void {
    this.emitted.push(command);
    for (const listener of this.listeners) listener(command);
  }

  public notify(method: string, args: readonly unknown[] = []): void {
    if (this.failNotify) throw new Error(`FakeCircuit "${this.name}": notify failed`);
    this.notifications.push({ method, args });
  }

  public async call(method: string, ...args: unknown[]): Promise<unknown> {
    if (method !== 'step') {
      throw new Error(`FakeCircuit "${this.name}": unknown method "${method}"`);
    }
    const deltaMs = args[0];
    if (typeof deltaMs !== 'number') {
      throw new TypeError(`FakeCircuit "${this.name}": step needs a number`);
    }
    this.steps.push(deltaMs);
    await this.onStep?.(deltaMs, this);
    return undefined;
  }

  public on(type: string, listener: (payload: unknown) => void): () => void {
    if (type !== 'jointCommand') return () => undefined;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public async terminate(): Promise<void> {
    if (this.failTerminate) throw new Error(`FakeCircuit "${this.name}": terminate failed`);
    this.terminated = true;
  }
}

interface CircuitHarness {
  readonly factory: CircuitSandboxFactory;
  readonly created: FakeCircuit[];
}

function createCircuitHarness(
  onStep?: (deltaMs: number, circuit: FakeCircuit) => Promise<void> | void,
): CircuitHarness {
  const created: FakeCircuit[] = [];
  return {
    created,
    factory: async (options) => {
      const circuit = new FakeCircuit(options, onStep);
      created.push(circuit);
      return circuit;
    },
  };
}

interface HostHarness {
  readonly host: Awaited<ReturnType<typeof createScene3DHost>>;
  readonly physics: RecordingPhysics;
  readonly renderer: MockOffscreenRenderer;
}

async function createHost(options: {
  entities: readonly SceneEntity[];
  schematic?: string;
  circuits?: Scene3DCircuitOptions;
  assemblyFor?: (entity: AssemblyInstance, document: Scene3DDocument) => AssemblyDefinition;
  physics?: RecordingPhysics;
  renderer?: MockOffscreenRenderer;
  startTime?: number;
}): Promise<HostHarness> {
  const physics = options.physics ?? new RecordingPhysics();
  const renderer = options.renderer ?? createOffscreenRenderer();
  const host = await createScene3DHost({
    document: documentWith(options.entities, options.schematic),
    physics,
    renderer,
    ...(options.circuits === undefined ? {} : { circuits: options.circuits }),
    ...(options.assemblyFor === undefined ? {} : { assemblyFor: options.assemblyFor }),
    ...(options.startTime === undefined ? {} : { startTime: options.startTime }),
  });
  return { host, physics, renderer };
}

describe('Scene3DHost initialisation', () => {
  it('creates one circuit sandbox per assembly instance, in document order', async () => {
    const circuits = createCircuitHarness();
    const { host } = await createHost({
      entities: [assembly('robot-a'), model('plate'), assembly('robot-b')],
      schematic: 'robot.schematic.json',
      circuits: { createSandbox: circuits.factory },
    });

    expect(circuits.created.map((circuit) => circuit.options.name)).toEqual([
      'circuit-robot-a',
      'circuit-robot-b',
    ]);
    expect(circuits.created.map((circuit) => circuit.options.entityId)).toEqual([
      'robot-a',
      'robot-b',
    ]);
    expect(circuits.created.every((c) => c.options.schematic === 'robot.schematic.json')).toBe(
      true,
    );
    expect(circuits.created.every((c) => c.options.assembly === 'robots:line-follower')).toBe(true);
    expect(host.circuitCount).toBe(2);

    await host.dispose();
  });

  it('lets the resolver override the document schematic per instance', async () => {
    const circuits = createCircuitHarness();
    const { host } = await createHost({
      entities: [assembly('robot-a'), assembly('robot-b')],
      schematic: 'shared.schematic.json',
      circuits: {
        createSandbox: circuits.factory,
        schematicFor: (entity) => `schematics/${entity.id}.json`,
      },
    });

    expect(circuits.created.map((circuit) => circuit.options.schematic)).toEqual([
      'schematics/robot-a.json',
      'schematics/robot-b.json',
    ]);

    await host.dispose();
  });

  it('runs without circuit simulators', async () => {
    const { host } = await createHost({ entities: [model('ball')] });

    expect(host.circuitCount).toBe(0);
    await expect(host.step(16)).resolves.toMatchObject({ timeMs: 16, stepCount: 1 });

    await host.dispose();
  });

  it('initialises physics once and adds one body per model entity', async () => {
    const physics = new RecordingPhysics();
    const { host } = await createHost({
      entities: [model('a'), assembly('robot'), model('b')],
      physics,
    });

    expect(physics.log).toEqual(['physics.initialize', 'physics.addBody:a', 'physics.addBody:b']);
    expect(host.getTransforms()).toHaveLength(3 * 16);

    await host.dispose();
  });

  it('rejects documents with duplicate entity ids and releases the engines', async () => {
    const physics = new RecordingPhysics();
    const renderer = createOffscreenRenderer();

    await expect(
      createScene3DHost({
        document: documentWith([model('a'), model('a')]),
        physics,
        renderer,
      }),
    ).rejects.toThrow(/duplicate entity id/);

    expect(physics.disposed).toBe(true);
    expect(renderer.disposed).toBe(true);
  });

  it('rejects invalid injected engines and start times', async () => {
    const document = documentWith([]);

    await expect(
      createScene3DHost({
        document,
        physics: null as unknown as PhysicsRuntime,
        renderer: createOffscreenRenderer(),
      }),
    ).rejects.toThrow(/physics/);

    await expect(
      createScene3DHost({
        document,
        physics: new RecordingPhysics(),
        renderer: null as unknown as OffscreenRenderer,
      }),
    ).rejects.toThrow(/renderer/);

    await expect(
      createScene3DHost({
        document,
        physics: new RecordingPhysics(),
        renderer: createOffscreenRenderer(),
        startTime: -5,
      }),
    ).rejects.toThrow(RangeError);

    await expect(
      createScene3DHost({
        document: { ...document, version: 2 } as unknown as Scene3DDocument,
        physics: new RecordingPhysics(),
        renderer: createOffscreenRenderer(),
      }),
    ).rejects.toThrow(/unsupported document version/);
  });
});

describe('Scene3DHost lockstep step', () => {
  it('advances every circuit before physics', async () => {
    const events: string[] = [];
    const circuits = createCircuitHarness((deltaMs, circuit) => {
      events.push(`circuit:${circuit.options.entityId}@${deltaMs}`);
    });
    const physics = new RecordingPhysics(events);
    const { host } = await createHost({
      entities: [assembly('robot-a'), assembly('robot-b')],
      circuits: { createSandbox: circuits.factory },
      physics,
    });

    const result = await host.step(16);

    expect(events).toEqual(['circuit:robot-a@16', 'circuit:robot-b@16', 'physics.step']);
    expect(result.timeMs).toBe(16);
    expect(result.stepCount).toBe(1);
    expect(result.collisions).toEqual([]);

    await host.dispose();
  });

  it('waits for the slowest circuit before stepping physics', async () => {
    const events: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const circuits = createCircuitHarness(async (_deltaMs, circuit) => {
      events.push(`circuit:${circuit.options.entityId}`);
      if (circuit.options.entityId === 'robot-b') await gate;
    });
    const physics = new RecordingPhysics(events);
    const { host } = await createHost({
      entities: [assembly('robot-a'), assembly('robot-b')],
      circuits: { createSandbox: circuits.factory },
      physics,
    });

    const pending = host.step(16);
    await flush();

    expect(events).toEqual(['circuit:robot-a', 'circuit:robot-b']);
    expect(physics.log).not.toContain('physics.step');

    release();
    await pending;

    expect(events).toEqual(['circuit:robot-a', 'circuit:robot-b', 'physics.step']);

    await host.dispose();
  });

  it('applies the joint commands collected during the barrier before physics advances', async () => {
    const events: string[] = [];
    const circuits = createCircuitHarness((_deltaMs, circuit) => {
      circuit.emit({ jointId: 'elbow', target: { kind: 'position', value: 0.75 } });
    });
    const physics = new RecordingPhysics(events);
    const { host } = await createHost({
      entities: [assembly('robot')],
      circuits: { createSandbox: circuits.factory },
      physics,
    });

    await host.step(16);

    expect(physics.targets).toEqual([
      { jointId: 'elbow', target: { kind: 'position', value: 0.75 } },
    ]);
    expect(events.indexOf('physics.setJointTarget:elbow')).toBeLessThan(
      events.indexOf('physics.step'),
    );

    await host.dispose();
  });

  it('does not replay commands from an earlier frame', async () => {
    let emitted = false;
    const circuits = createCircuitHarness((_deltaMs, circuit) => {
      if (emitted) return;
      emitted = true;
      circuit.emit({ jointId: 'elbow', target: { kind: 'velocity', value: 2 } });
    });
    const physics = new RecordingPhysics();
    const { host } = await createHost({
      entities: [assembly('robot')],
      circuits: { createSandbox: circuits.factory },
      physics,
    });

    await host.step(16);
    await host.step(16);

    expect(physics.targets).toHaveLength(1);

    await host.dispose();
  });

  it('rejects malformed joint commands without advancing the clock or physics', async () => {
    const events: string[] = [];
    const circuits = createCircuitHarness((_deltaMs, circuit) => {
      circuit.emit({ jointId: 'elbow', target: { kind: 'spin', value: 1 } });
    });
    const physics = new RecordingPhysics(events);
    const { host } = await createHost({
      entities: [assembly('robot')],
      circuits: { createSandbox: circuits.factory },
      physics,
    });

    await expect(host.step(16)).rejects.toThrow(Scene3DProtocolError);
    expect(host.currentTime).toBe(0);
    expect(host.stepCount).toBe(0);
    expect(events).not.toContain('physics.step');

    await host.dispose();
  });

  it('does not advance the clock when a circuit fails, and recovers on retry', async () => {
    let failing = true;
    const circuits = createCircuitHarness(() => {
      if (failing) throw new Error('simulator exploded');
    });
    const { host } = await createHost({
      entities: [assembly('robot')],
      circuits: { createSandbox: circuits.factory },
    });

    await expect(host.step(16)).rejects.toThrow(/circuit "circuit-robot" failed to advance/);
    expect(host.currentTime).toBe(0);
    expect(host.stepCount).toBe(0);

    failing = false;
    await host.step(16);
    expect(host.currentTime).toBe(16);
    expect(host.stepCount).toBe(1);

    await host.dispose();
  });

  it('rejects concurrent steps', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const circuits = createCircuitHarness(() => gate);
    const { host } = await createHost({
      entities: [assembly('robot')],
      circuits: { createSandbox: circuits.factory },
    });

    const pending = host.step(16);
    await flush();

    await expect(host.step(16)).rejects.toThrow(/already in progress/);
    expect(host.getTransforms()).toHaveLength(16);

    release();
    await pending;
    await host.dispose();
  });

  it('rejects invalid deltas', async () => {
    const { host } = await createHost({ entities: [] });

    await expect(host.step(-1)).rejects.toThrow(RangeError);
    await expect(host.step(Number.NaN)).rejects.toThrow(RangeError);
    await expect(host.step(Number.POSITIVE_INFINITY)).rejects.toThrow(RangeError);
    expect(host.currentTime).toBe(0);

    await host.dispose();
  });

  it('honours the start time and counts steps', async () => {
    const { host } = await createHost({ entities: [], startTime: 250 });

    expect(host.currentTime).toBe(250);
    const result = await host.step(50);

    expect(result).toMatchObject({ timeMs: 300, stepCount: 1 });
    expect(host.getState()).toEqual({
      timeMs: 300,
      stepCount: 1,
      entityCount: 0,
      circuitCount: 0,
    });

    await host.dispose();
  });
});

describe('Scene3DHost transform batches', () => {
  it('returns one column-major matrix per entity, in document order', async () => {
    const { host } = await createHost({
      entities: [
        model('falling', { x: 1, y: 10, z: 2 }),
        assembly('robot'),
        model('anchored', { x: 0, y: 5, z: 0 }, 'static'),
      ],
    });

    const result: StepResult = await host.step(16);

    expect(result.transforms).toBeInstanceOf(Float32Array);
    expect(result.transforms).toHaveLength(3 * 16);

    const falling = readBatchTranslation(result.transforms, 0);
    expect(falling.x).toBeCloseTo(1);
    expect(falling.y).toBeLessThan(10);
    expect(falling.z).toBeCloseTo(2);

    // An assembly has no body of its own yet, so its slot stays at the identity matrix.
    const assemblyOffset = 16;
    expect(result.transforms[assemblyOffset]).toBe(1);
    expect(result.transforms[assemblyOffset + 5]).toBe(1);
    expect(result.transforms[assemblyOffset + 10]).toBe(1);
    expect(result.transforms[assemblyOffset + 15]).toBe(1);
    expect(readBatchTranslation(result.transforms, 1)).toEqual({ x: 0, y: 0, z: 0 });

    expect(readBatchTranslation(result.transforms, 2)).toEqual({ x: 0, y: 5, z: 0 });

    await host.dispose();
  });

  it('returns a fresh buffer on every call', async () => {
    const { host } = await createHost({ entities: [model('ball')] });

    const first = host.getTransforms();
    first[0] = 42;
    const second = host.getTransforms();

    expect(second[0]).toBe(1);
    expect(second).not.toBe(first);

    await host.dispose();
  });

  it('extends the batch when an entity is added and shrinks it on removal', async () => {
    const circuits = createCircuitHarness();
    const { host } = await createHost({
      entities: [model('a')],
      circuits: { createSandbox: circuits.factory },
    });

    await host.addEntity(model('b', { x: 0, y: 3, z: 0 }));
    await host.addEntity(assembly('late-robot'));

    expect(host.entityCount).toBe(3);
    expect(host.circuitCount).toBe(1);
    expect(circuits.created.map((c) => c.options.entityId)).toEqual(['late-robot']);
    expect(readBatchTranslation(host.getTransforms(), 1)).toEqual({ x: 0, y: 3, z: 0 });
    await expect(host.addEntity(model('b'))).rejects.toThrow(/already exists/);

    await host.removeEntity('b');
    expect(host.entityCount).toBe(2);
    expect(host.getTransforms()).toHaveLength(2 * 16);

    await host.dispose();
  });

  it('rolls back an added entity when its circuit sandbox cannot start', async () => {
    const failing: CircuitSandboxFactory = async () => {
      throw new Error('schematic unavailable');
    };
    const { host } = await createHost({
      entities: [],
      circuits: { createSandbox: failing },
    });

    await expect(host.addEntity(assembly('robot'))).rejects.toThrow(/schematic unavailable/);

    expect(host.entityCount).toBe(0);
    expect(host.circuitCount).toBe(0);
    expect(host.getTransforms()).toHaveLength(0);

    await host.dispose();
  });
});

describe('Scene3DHost entity removal', () => {
  it('terminates the circuit and removes the rigid body of the entity', async () => {
    const circuits = createCircuitHarness();
    const physics = new RecordingPhysics();
    const { host } = await createHost({
      entities: [assembly('robot'), model('plate')],
      circuits: { createSandbox: circuits.factory },
      physics,
    });

    await host.removeEntity('robot');

    expect(circuits.created[0]?.terminated).toBe(true);
    expect(host.circuitCount).toBe(0);

    await host.removeEntity('plate');
    expect(physics.log).toContain('physics.removeBody:plate');
    expect(host.entityCount).toBe(0);

    await expect(host.removeEntity('plate')).rejects.toThrow(/unknown entity/);

    await host.dispose();
  });

  it('rejects an entity with an unknown type', async () => {
    const { host } = await createHost({ entities: [] });

    await expect(
      host.addEntity({
        id: 'camera',
        type: 'camera',
        position: { x: 0, y: 0, z: 0 },
        rotation: IDENTITY,
      } as unknown as SceneEntity),
    ).rejects.toThrow(/unknown type/);

    await host.dispose();
  });
});

describe('Scene3DHost disposal', () => {
  it('terminates circuits, releases physics and the renderer, and is idempotent', async () => {
    const circuits = createCircuitHarness();
    const renderer = createOffscreenRenderer();
    const surface = renderer.createSurface(2, 2);
    const physics = new RecordingPhysics();
    const { host } = await createHost({
      entities: [assembly('robot'), model('plate')],
      circuits: { createSandbox: circuits.factory },
      physics,
      renderer,
    });

    await host.dispose();

    expect(circuits.created.every((circuit) => circuit.terminated)).toBe(true);
    expect(physics.disposed).toBe(true);
    expect(renderer.disposed).toBe(true);
    expect(() => surface.readPixels()).toThrow(OffscreenRendererDisposedError);
    await expect(host.step(16)).rejects.toThrow(/disposed/);
    expect(() => host.getTransforms()).toThrow(/disposed/);
    await expect(host.dispose()).resolves.toBeUndefined();
  });

  it('releases every resource even when a circuit fails to terminate', async () => {
    const circuits = createCircuitHarness();
    const physics = new RecordingPhysics();
    const { host, renderer } = await createHost({
      entities: [assembly('robot')],
      circuits: { createSandbox: circuits.factory },
      physics,
    });
    const circuit = circuits.created[0];
    if (circuit === undefined) throw new Error('expected a circuit');
    circuit.failTerminate = true;

    await expect(host.dispose()).rejects.toThrow(AggregateError);

    expect(physics.disposed).toBe(true);
    expect(renderer.disposed).toBe(true);
  });
});

describe('Scene3DHost sensors', () => {
  afterEach(() => {
    sensorRegistry.unregister('distance');
    vi.restoreAllMocks();
  });

  function registerDistanceSensor(
    data: SensorData = { type: 'distance', distance: 1.23, timestamp: 0n },
  ) {
    sensorRegistry.unregister('distance');
    sensorRegistry.register('distance', (entity) => new MockSensor(entity, data));
  }

  it('pushes assembly sensor readings to the owning circuit at the configured rate', async () => {
    registerDistanceSensor();
    const circuits = createCircuitHarness();
    const definition = assemblyDefinition([distanceSensor('sensor-1', 10)]);
    const { host } = await createHost({
      entities: [assembly('robot')],
      circuits: { createSandbox: circuits.factory },
      assemblyFor: () => definition,
    });
    const circuit = circuits.created[0];
    if (circuit === undefined) throw new Error('expected a circuit');

    expect(host.sensorCount).toBe(1);

    await host.step(50);
    expect(circuit.notifications).toEqual([
      {
        method: 'sensorData',
        args: [
          {
            sensorId: 'sensor-1',
            data: { type: 'distance', distance: 1.23, timestamp: 50_000_000_000n },
          },
        ],
      },
    ]);

    // 50 ms later the 10 Hz sensor is still inside its 100 ms interval.
    await host.step(50);
    expect(circuit.notifications).toHaveLength(1);

    // 100 ms after the first reading the sensor is due again.
    await host.step(50);
    expect(circuit.notifications).toHaveLength(2);
    expect(circuit.notifications[1]?.args[0]).toMatchObject({
      sensorId: 'sensor-1',
      data: { type: 'distance', timestamp: 150_000_000_000n },
    });

    await host.removeEntity('robot');
    expect(host.sensorCount).toBe(0);

    await host.dispose();
  });

  it('skips unregistered sensor types without failing the scene', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { host } = await createHost({ entities: [distanceSensor('orphan')] });

    expect(host.sensorCount).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to create sensor'),
      expect.any(Error),
    );

    await expect(host.step(16)).resolves.toMatchObject({ timeMs: 16, stepCount: 1 });

    await host.dispose();
  });

  it('isolates sensor update failures and still commits the frame', async () => {
    sensorRegistry.unregister('distance');
    sensorRegistry.register('distance', (entity) => new FailingSensor(entity));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const circuits = createCircuitHarness();
    const definition = assemblyDefinition([distanceSensor('broken')]);
    const { host } = await createHost({
      entities: [assembly('robot')],
      circuits: { createSandbox: circuits.factory },
      assemblyFor: () => definition,
    });

    await expect(host.step(16)).resolves.toMatchObject({ timeMs: 16, stepCount: 1 });

    expect(error).toHaveBeenCalledWith(expect.stringContaining('update failed'), expect.any(Error));
    expect(circuits.created[0]?.notifications).toEqual([]);

    await host.dispose();
  });

  it('isolates circuit notification failures', async () => {
    registerDistanceSensor();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const circuits = createCircuitHarness();
    const definition = assemblyDefinition([distanceSensor('sensor-1')]);
    const { host } = await createHost({
      entities: [assembly('robot')],
      circuits: { createSandbox: circuits.factory },
      assemblyFor: () => definition,
    });
    const circuit = circuits.created[0];
    if (circuit === undefined) throw new Error('expected a circuit');
    circuit.failNotify = true;

    await expect(host.step(16)).resolves.toMatchObject({ timeMs: 16, stepCount: 1 });

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('notification failed'),
      expect.any(Error),
    );

    await host.dispose();
  });

  it('attaches and removes top-level sensors', async () => {
    registerDistanceSensor();
    const { host } = await createHost({ entities: [distanceSensor('scene-sensor')] });

    expect(host.sensorCount).toBe(1);

    await host.addEntity(distanceSensor('late-sensor', 20));
    expect(host.sensorCount).toBe(2);

    await host.removeEntity('late-sensor');
    expect(host.sensorCount).toBe(1);

    await host.removeEntity('scene-sensor');
    expect(host.sensorCount).toBe(0);

    await host.dispose();
  });

  it('converts the host clock to picoseconds for sensor timestamps', async () => {
    registerDistanceSensor();
    const circuits = createCircuitHarness();
    const definition = assemblyDefinition([distanceSensor('sensor-1')]);
    const { host } = await createHost({
      entities: [assembly('robot')],
      circuits: { createSandbox: circuits.factory },
      assemblyFor: () => definition,
      startTime: 1000,
    });

    await host.step(50);

    expect(circuits.created[0]?.notifications[0]?.args[0]).toMatchObject({
      sensorId: 'sensor-1',
      data: { timestamp: 1_050_000_000_000n },
    });

    await host.dispose();
  });
});
