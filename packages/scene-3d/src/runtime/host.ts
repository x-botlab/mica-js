/**
 * Scene simulation host, designed to run inside a sandbox Worker (#214).
 *
 * The host owns everything that must not touch the DOM:
 *
 * ```
 * step(deltaMs)
 *   1. hand the delta to every circuit simulator          ─┐
 *   2. lockstep barrier: await all of them                ─┘ (#214)
 *   3. collect the joint commands they emitted
 *   4. apply the commands to the physics runtime
 *   5. advance physics by the same delta
 *   6. read the sensors that are due and notify their circuits
 *   7. commit the virtual clock and return one transform batch
 * ```
 *
 * The clock is committed last, so a failing phase leaves the host at the previous fully
 * synchronised time and the client can retry the frame. The class itself is environment-neutral:
 * the physics engine, the offscreen renderer and the circuit sandbox factory are injected, which is
 * what lets the guest runtime and injected renderer implementations` compose it at build time.
 *
 * ```ts
 * const host = await createScene3DHost({ document, physics, renderer });
 * const { transforms } = await host.step(1000 / 60);
 * ```
 */

import type { AssemblyDefinition } from '../assembly';
import { BODY_TYPES, ENTITY_TYPES } from '../entities';
import type {
  AssemblyInstance,
  EntityType,
  ModelEntity,
  SceneEntity,
  SensorEntity,
} from '../entities';
import { SCENE3D_VERSION } from '../format';
import type { Scene3DDocument } from '../format/document';
import { JOINT_TARGET_KINDS } from '../physics';
import type { JointTarget, JointTargetKind, PhysicsRuntime, RigidBodyConfig } from '../physics';
import type { OffscreenRenderer } from '../rendering/renderer';
import { createDefaultSensorRegistry } from '../sensors/defaults';
import { SensorRegistry } from '../sensors/registry';
import type { Sensor } from '../sensors/base';
import { PS_PER_MILLISECOND } from '../sensors/types';
import type { SensorData } from '../sensors/types';
import {
  CIRCUIT_EVENT_JOINT_COMMAND,
  CIRCUIT_EVENT_SENSOR_DATA,
  CIRCUIT_METHOD_STEP,
  Scene3DProtocolError,
  type CircuitJointCommand,
  type CircuitSandboxHandle,
  type CircuitSandboxOptions,
  type CircuitSensorData,
  type CollisionEvent,
  type Scene3DCircuitOptions,
  type Scene3DHostContract,
  type Scene3DHostState,
  type StepResult,
} from './protocol';
import { readTransformBatch } from './transforms';

export { TRANSFORM_STRIDE } from './protocol';

/** Contacts reported by this host; collisions are not modelled by `PhysicsRuntime` yet. */
const NO_COLLISIONS: readonly CollisionEvent[] = Object.freeze([]);

/** One live circuit simulator sandbox plus the commands it emitted during the current step. */
interface CircuitSlot {
  /** Diagnostic name passed to the circuit factory. */
  readonly name: string;
  /** Assembly instance the simulator belongs to. */
  readonly entityId: string;
  /** Direct MessageChannel handle to the child sandbox. */
  readonly handle: CircuitSandboxHandle;
  /** Detaches the `jointCommand` listener. */
  readonly unsubscribe: () => void;
  /** Payloads received since the current step started. */
  readonly commands: unknown[];
}

/** One sensor runtime plus the assembly whose circuit receives its readings. */
interface SensorSlot {
  /** Unique key: top-level sensors use their id, assembly sensors are scoped by the instance. */
  readonly key: string;
  /** Sensor runtime created by the registry. */
  readonly sensor: Sensor;
  /** Entity identity of the sensor inside its owning scope. */
  readonly entityId: string;
  /** Assembly instance that owns the sensor, or `null` for a top-level sensor. */
  readonly assemblyId: string | null;
}

/** Options of {@link Scene3DHost.create}. */
export interface Scene3DHostOptions {
  /** Document the host simulates; its entity order defines the transform batch order. */
  readonly document: Scene3DDocument;
  /** Physics engine advanced by every step. The host takes ownership of it. */
  readonly physics: PhysicsRuntime;
  /** Offscreen renderer used by camera sensors; the host takes ownership of it. */
  readonly renderer: OffscreenRenderer;
  /** Circuit simulators to attach; omit for a physics-only scene. */
  readonly circuits?: Scene3DCircuitOptions;
  /** Sensor factories used by this host; defaults to the built-in sensor registry. */
  readonly sensors?: SensorRegistry;
  /**
   * Resolves the definition of an assembly instance.
   *
   * The scene document stores only a reference (`package:name`); the loader that owns the
   * `.assembly.json` files injects this hook. The host uses it to create the sensors declared by
   * the definition. Omit it to simulate an assembly's circuit without its sensors — the host does
   * not read assembly files itself.
   */
  readonly assemblyFor?: (
    entity: AssemblyInstance,
    document: Scene3DDocument,
  ) => AssemblyDefinition | undefined;
  /** Virtual time the host starts at, in milliseconds; defaults to `0`. */
  readonly startTime?: number;
}

/** Host API returned by {@link createScene3DHost}. */
export interface Scene3DHostAPI extends Scene3DHostContract {
  /** Virtual time of the last fully synchronised step, in milliseconds. */
  readonly currentTime: number;
  /** Number of completed steps. */
  readonly stepCount: number;
  /** Entities currently simulated, in transform-batch order. */
  readonly entityCount: number;
  /** Circuit simulator sandboxes currently attached. */
  readonly circuitCount: number;
}

/**
 * Creates a host and runs its asynchronous initialisation: physics world, initial bodies and one
 * circuit sandbox per assembly instance.
 *
 * The host owns `physics` and `renderer`: if initialisation fails it disposes both before
 * rethrowing, and {@link Scene3DHost.dispose} releases them later.
 */
export async function createScene3DHost(options: Scene3DHostOptions): Promise<Scene3DHost> {
  return Scene3DHost.create(options);
}

/** Simulation host. Prefer {@link createScene3DHost}, which performs initialisation. */
export class Scene3DHost implements Scene3DHostAPI {
  private readonly document: Scene3DDocument;
  private readonly physics: PhysicsRuntime;
  private readonly renderer: OffscreenRenderer;
  private readonly circuitOptions: Scene3DCircuitOptions | undefined;
  private readonly sensorRegistry: SensorRegistry;
  private readonly assemblyFor:
    | ((entity: AssemblyInstance, document: Scene3DDocument) => AssemblyDefinition | undefined)
    | undefined;
  private readonly entities: SceneEntity[] = [];
  private readonly bodies = new Map<string, string>();
  private readonly circuits = new Map<string, CircuitSlot>();
  private readonly sensors: SensorSlot[] = [];

  private timeMs: number;
  private completedSteps = 0;
  private disposed = false;
  private stepping = false;
  private mutating = false;

  private constructor(options: Scene3DHostOptions) {
    this.document = options.document;
    this.physics = options.physics;
    this.renderer = options.renderer;
    this.circuitOptions = options.circuits;
    this.sensorRegistry =
      options.sensors ?? createDefaultSensorRegistry({ document: this.document });
    this.assemblyFor = options.assemblyFor;
    this.timeMs = options.startTime ?? 0;
  }

  /** Creates, initialises and returns a host. See {@link createScene3DHost}. */
  public static async create(options: Scene3DHostOptions): Promise<Scene3DHost> {
    assertHostOptions(options);
    const host = new Scene3DHost(options);
    try {
      await host.initialize();
    } catch (error) {
      await host.dispose().catch(() => undefined);
      throw error;
    }
    return host;
  }

  /** Virtual time of the last fully synchronised step, in milliseconds. */
  public get currentTime(): number {
    return this.timeMs;
  }

  /** Number of completed steps. */
  public get stepCount(): number {
    return this.completedSteps;
  }

  /** Entities currently simulated, in transform-batch order. */
  public get entityCount(): number {
    return this.entities.length;
  }

  /** Circuit simulator sandboxes currently attached. */
  public get circuitCount(): number {
    return this.circuits.size;
  }

  /** Sensor runtimes currently attached, across the scene and every assembly instance. */
  public get sensorCount(): number {
    return this.sensors.length;
  }

  /**
   * Advances every subsystem by `deltaMs` virtual milliseconds.
   *
   * @throws {RangeError} when `deltaMs` is not a finite number greater than or equal to `0`.
   * @throws {Scene3DProtocolError} when a circuit simulator fails or emits a malformed command.
   */
  public async step(deltaMs: number): Promise<StepResult> {
    this.assertUsable('step');
    assertDelta(deltaMs);
    this.assertIdle('step');

    this.stepping = true;
    const targetTime = this.timeMs + deltaMs;
    try {
      // A command belongs to the step that produced it; drop anything left by a failed frame.
      for (const slot of this.circuits.values()) slot.commands.length = 0;

      // Phase 1 + 2: every circuit advances to the same target time and the barrier waits for all.
      await this.advanceCircuits(deltaMs);

      // Phase 3: collect what they published while advancing.
      const commands = this.collectJointCommands();

      // Phase 4: apply the commands before physics integrates anything, so every circuit sees the
      // same integration step.
      for (const command of commands) {
        this.physics.setJointTarget(command.jointId, command.target);
      }

      // Phase 5: physics advances by exactly the delta the circuits were given.
      this.physics.step(deltaMs);

      // Phase 6: read every sensor that is due and notify the circuit that owns it. Sensor
      // failures are isolated: a broken sensor or circuit must not abort the frame.
      await this.publishSensorData(targetTime);

      // Phase 7: commit the clock only after every phase succeeded.
      this.timeMs = targetTime;
      this.completedSteps++;

      return {
        transforms: this.readTransforms(),
        collisions: NO_COLLISIONS,
        timeMs: this.timeMs,
        stepCount: this.completedSteps,
      };
    } finally {
      this.stepping = false;
    }
  }

  /** Reads the batch of all entity transforms without advancing the simulation. */
  public getTransforms(): Float32Array {
    this.assertUsable('getTransforms');
    return this.readTransforms();
  }

  /** Reads the clock and entity counters without advancing the simulation. */
  public getState(): Scene3DHostState {
    this.assertUsable('getState');
    return {
      timeMs: this.timeMs,
      stepCount: this.completedSteps,
      entityCount: this.entities.length,
      circuitCount: this.circuits.size,
    };
  }

  /** Adds an entity, creating its rigid body and — for assemblies — its circuit sandbox. */
  public async addEntity(entity: SceneEntity): Promise<void> {
    this.assertUsable('addEntity');
    this.assertIdle('addEntity');
    assertSceneEntity(entity, 'Scene3DHost.addEntity');
    if (this.entities.some((existing) => existing.id === entity.id)) {
      throw new Error(`Scene3DHost.addEntity: entity "${entity.id}" already exists`);
    }

    this.mutating = true;
    try {
      this.entities.push(entity);
      try {
        this.attachBody(entity);
        if (isAssemblyInstance(entity)) {
          await this.attachAssembly(entity);
        } else if (isSensorEntity(entity)) {
          this.attachSensor(entity, null);
        }
      } catch (error) {
        this.detachBody(entity.id);
        this.removeSensorsFor(entity.id);
        this.entities.pop();
        throw error;
      }
    } finally {
      this.mutating = false;
    }
  }

  /** Removes an entity, its rigid body and its circuit sandbox. */
  public async removeEntity(id: string): Promise<void> {
    this.assertUsable('removeEntity');
    this.assertIdle('removeEntity');
    if (typeof id !== 'string' || id === '') {
      throw new TypeError('Scene3DHost.removeEntity: id must be a non-empty string');
    }

    const index = this.entities.findIndex((entity) => entity.id === id);
    const entity = index === -1 ? undefined : this.entities[index];
    if (entity === undefined) {
      throw new Error(`Scene3DHost.removeEntity: unknown entity "${id}"`);
    }

    this.mutating = true;
    const failures: unknown[] = [];
    try {
      const slot = this.circuits.get(id);
      if (slot !== undefined) {
        this.circuits.delete(id);
        slot.unsubscribe();
        try {
          await slot.handle.terminate(`entity "${id}" removed`);
        } catch (error) {
          failures.push(error);
        }
      }

      this.removeSensorsFor(id);
      this.detachBody(id);
      this.entities.splice(index, 1);
    } finally {
      this.mutating = false;
    }

    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Scene3DHost.removeEntity: the circuit sandbox of "${id}" failed to terminate`,
      );
    }
  }

  /**
   * Terminates every circuit sandbox and releases physics and rendering resources.
   *
   * Idempotent. Every resource is released even when one of them throws; the first failures are
   * collected into an `AggregateError` raised after cleanup.
   */
  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    const slots = Array.from(this.circuits.values());
    this.circuits.clear();
    for (const slot of slots) slot.unsubscribe();

    const failures: unknown[] = [];
    const results = await Promise.allSettled(
      slots.map((slot) => slot.handle.terminate('scene host disposed')),
    );
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason);
    }

    try {
      this.physics.dispose();
    } catch (error) {
      failures.push(error);
    }
    try {
      this.renderer.dispose();
    } catch (error) {
      failures.push(error);
    }

    this.bodies.clear();
    this.sensors.length = 0;
    this.entities.length = 0;

    if (failures.length > 0) {
      throw new AggregateError(failures, 'Scene3DHost.dispose: some resources failed to release');
    }
  }

  private async initialize(): Promise<void> {
    // The generic `PhysicsConfig` has no gravity field yet; the real MuJoCo adapter will take
    // document.world.gravity directly. See #180.
    await this.physics.initialize({ bodyType: 'dynamic' });

    for (const entity of this.document.entities) {
      assertSceneEntity(entity, 'Scene3DHost.create');
      if (this.entities.some((existing) => existing.id === entity.id)) {
        throw new Error(`Scene3DHost.create: duplicate entity id "${entity.id}"`);
      }
      this.entities.push(entity);
      this.attachBody(entity);
      if (isSensorEntity(entity)) this.attachSensor(entity, null);
    }

    for (const entity of this.document.entities) {
      if (isAssemblyInstance(entity)) await this.attachAssembly(entity);
    }
  }

  private async advanceCircuits(deltaMs: number): Promise<void> {
    const slots = Array.from(this.circuits.values());
    await Promise.all(slots.map((slot) => this.advanceCircuit(slot, deltaMs)));
  }

  private async advanceCircuit(slot: CircuitSlot, deltaMs: number): Promise<void> {
    try {
      await slot.handle.call(CIRCUIT_METHOD_STEP, deltaMs);
    } catch (error) {
      throw new Scene3DProtocolError(`Scene3DHost.step: circuit "${slot.name}" failed to advance`, {
        cause: error,
      });
    }
  }

  private collectJointCommands(): readonly CircuitJointCommand[] {
    const commands: CircuitJointCommand[] = [];
    for (const slot of this.circuits.values()) {
      for (const payload of slot.commands) {
        const command = parseJointCommand(payload);
        if (command === null) {
          throw new Scene3DProtocolError(
            `Scene3DHost.step: circuit "${slot.name}" emitted an invalid jointCommand`,
          );
        }
        commands.push(command);
      }
    }
    return commands;
  }

  private attachBody(entity: SceneEntity): void {
    if (!isModelEntity(entity)) return;
    const bodyId = this.physics.addBody(toRigidBodyConfig(entity));
    this.bodies.set(entity.id, bodyId);
  }

  private detachBody(entityId: string): void {
    const bodyId = this.bodies.get(entityId);
    if (bodyId === undefined) return;
    this.bodies.delete(entityId);
    // `removeBody` is optional in the physics contract; a runtime without it keeps the body in the
    // engine even though the host stops reporting it. See #180.
    this.physics.removeBody?.(bodyId);
  }

  private async attachCircuit(entity: AssemblyInstance): Promise<void> {
    const circuits = this.circuitOptions;
    if (circuits === undefined) return;

    const schematic = circuits.schematicFor?.(entity, this.document) ?? this.document.schematic;
    const options: CircuitSandboxOptions = {
      name: circuitName(entity.id),
      entityId: entity.id,
      assembly: assemblyReference(entity),
      ...(schematic === undefined ? {} : { schematic }),
    };

    const handle = await circuits.createCircuitSandbox(options);
    const commands: unknown[] = [];
    let unsubscribe: () => void;
    try {
      unsubscribe = handle.on(CIRCUIT_EVENT_JOINT_COMMAND, (payload) => {
        // Buffer only: commands are applied after every circuit reaches the barrier, which keeps
        // the step deterministic regardless of channel arrival order (#214).
        commands.push(payload);
      });
    } catch (error) {
      await handle.terminate(`circuit "${options.name}" failed to attach`).catch(() => undefined);
      throw error;
    }

    this.circuits.set(entity.id, {
      name: options.name,
      entityId: entity.id,
      handle,
      unsubscribe,
      commands,
    });
  }

  /** Attaches the circuit (when circuits are configured) and the sensors of an assembly. */
  private async attachAssembly(entity: AssemblyInstance): Promise<void> {
    await this.attachCircuit(entity);
    this.attachAssemblySensors(entity);
  }

  /**
   * Creates one runtime per sensor declared by the assembly definition.
   *
   * The definition is resolved through {@link Scene3DHostOptions.assemblyFor}; without that hook
   * the host has no way to read `.assembly.json` and simply skips the assembly's sensors.
   */
  private attachAssemblySensors(entity: AssemblyInstance): void {
    const definition = this.resolveAssemblyDefinition(entity);
    if (definition === undefined) return;

    const entities: unknown = definition.entities;
    if (!Array.isArray(entities)) return;
    for (const candidate of entities as readonly SceneEntity[]) {
      if (isSensorEntity(candidate)) this.attachSensor(candidate, entity.id);
    }
  }

  /**
   * Creates one sensor runtime and remembers which circuit should receive its readings.
   *
   * A factory that is missing or throws is reported and skipped: one unsupported sensor must not
   * prevent the rest of the scene from simulating.
   */
  private attachSensor(entity: SensorEntity, assemblyId: string | null): void {
    const key = assemblyId === null ? `scene:${entity.id}` : `${assemblyId}:${entity.id}`;
    if (this.sensors.some((slot) => slot.key === key)) return;

    try {
      const sensor = this.sensorRegistry.create(entity);
      this.sensors.push({ key, sensor, entityId: entity.id, assemblyId });
    } catch (error) {
      console.warn(`Scene3DHost: Failed to create sensor ${entity.id}:`, error);
    }
  }

  /** Drops the top-level sensor an entity declares, or the sensors an assembly owns. */
  private removeSensorsFor(id: string): void {
    for (let index = this.sensors.length - 1; index >= 0; index--) {
      const slot = this.sensors[index];
      if (slot === undefined) continue;
      const ownsSlot = slot.assemblyId === null && slot.entityId === id;
      if (ownsSlot || slot.assemblyId === id) {
        this.sensors.splice(index, 1);
      }
    }
  }

  /**
   * Phase 6: reads every sensor that is due and notifies the owning circuit.
   *
   * A sensor that throws, or a circuit that rejects the notification, only loses its own reading;
   * the frame still commits. Sensors with no owning circuit (top-level scene sensors) are sampled
   * but not published — the scene-level circuit is not part of the host yet.
   */
  private async publishSensorData(currentTimeMs: number): Promise<void> {
    if (this.sensors.length === 0) return;
    const currentTimePs = millisecondsToPs(currentTimeMs);

    for (const slot of this.sensors) {
      let data: SensorData | null;
      try {
        data = slot.sensor.tryUpdate(this.physics, currentTimePs);
      } catch (error) {
        console.error(`Scene3DHost.step: Sensor ${slot.sensor.id} update failed:`, error);
        continue;
      }
      if (data === null || slot.assemblyId === null) continue;

      const circuit = this.circuits.get(slot.assemblyId);
      if (circuit === undefined) continue;
      const handle = circuit.handle;
      if (handle.notify === undefined) continue;

      const payload: CircuitSensorData = { sensorId: slot.sensor.id, data };
      try {
        await handle.notify(CIRCUIT_EVENT_SENSOR_DATA, [payload]);
      } catch (error) {
        console.error(
          `Scene3DHost.step: Circuit ${circuit.name} sensor notification failed:`,
          error,
        );
      }
    }
  }

  /** Resolves an instance's definition through the injected loader, then inline definitions. */
  private resolveAssemblyDefinition(entity: AssemblyInstance): AssemblyDefinition | undefined {
    const resolved = this.assemblyFor?.(entity, this.document);
    if (resolved !== undefined) return resolved;

    // Compatibility with documents that embed the definition in the instance. The documented
    // format uses a `package:name` reference and a separate `.assembly.json` file.
    const reference: unknown = entity.assembly;
    if (typeof reference !== 'object' || reference === null) return undefined;
    const entities = (reference as { readonly entities?: unknown }).entities;
    return Array.isArray(entities) ? (reference as AssemblyDefinition) : undefined;
  }

  private readTransforms(): Float32Array {
    return readTransformBatch(this.entities, (entityId) => this.bodies.get(entityId), this.physics);
  }

  private assertUsable(action: string): void {
    if (this.disposed) {
      throw new Error(`Scene3DHost.${action}: the host has been disposed`);
    }
  }

  private assertIdle(action: string): void {
    if (this.stepping) {
      throw new Error(`Scene3DHost.${action}: a step is already in progress`);
    }
    if (this.mutating) {
      throw new Error(`Scene3DHost.${action}: another mutation is already in progress`);
    }
  }
}

/** Diagnostic name of the circuit sandbox belonging to an assembly instance. */
function circuitName(entityId: string): string {
  return `circuit-${entityId}`;
}

/** `SceneEntity` is a base interface rather than a union, so narrowing needs explicit guards. */
function isModelEntity(entity: SceneEntity): entity is ModelEntity {
  return entity.type === 'model';
}

function isAssemblyInstance(entity: SceneEntity): entity is AssemblyInstance {
  return entity.type === 'assembly';
}

function isSensorEntity(entity: SceneEntity): entity is SensorEntity {
  return entity.type === 'sensor';
}

/**
 * Reads the assembly reference of an instance.
 *
 * The format stores a `package:name` string; a legacy document may embed the definition object
 * directly, in which case its `name` (or the instance id) identifies the simulator.
 */
function assemblyReference(entity: AssemblyInstance): string {
  const reference: unknown = entity.assembly;
  if (typeof reference === 'string' && reference !== '') return reference;
  if (typeof reference === 'object' && reference !== null) {
    const name = (reference as { readonly name?: unknown }).name;
    if (typeof name === 'string' && name !== '') return name;
  }
  return entity.id;
}

/** Converts virtual milliseconds to whole picoseconds without going through a float total. */
function millisecondsToPs(milliseconds: number): bigint {
  const whole = Math.floor(milliseconds);
  const fraction = milliseconds - whole;
  return BigInt(whole) * PS_PER_MILLISECOND + BigInt(Math.round(fraction * 1e9));
}

/** Validates a `jointCommand` payload arriving from a circuit simulator. */
function parseJointCommand(payload: unknown): CircuitJointCommand | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as { readonly jointId?: unknown; readonly target?: unknown };
  if (typeof record.jointId !== 'string' || record.jointId === '') return null;

  const target = record.target;
  if (typeof target !== 'object' || target === null) return null;
  const command = target as { readonly kind?: unknown; readonly value?: unknown };
  if (typeof command.kind !== 'string') return null;
  if (!JOINT_TARGET_KINDS.includes(command.kind as JointTargetKind)) return null;
  if (typeof command.value !== 'number' || !Number.isFinite(command.value)) return null;

  const kind = command.kind as JointTargetKind;
  const value = command.value;
  const parsed: JointTarget =
    kind === 'position'
      ? { kind: 'position', value }
      : kind === 'velocity'
        ? { kind: 'velocity', value }
        : { kind: 'torque', value };
  return { jointId: record.jointId, target: parsed };
}

/** Maps a model entity onto the physics runtime contract. */
function toRigidBodyConfig(entity: ModelEntity): RigidBodyConfig {
  const physics = entity.physics;
  return {
    id: entity.id,
    bodyType: physics.bodyType,
    position: entity.position,
    rotation: entity.rotation,
    collider: entity.collider,
    friction: entity.material.friction,
    restitution: entity.material.restitution,
    ...(physics.mass === undefined ? {} : { mass: physics.mass }),
    ...(physics.velocity === undefined ? {} : { velocity: physics.velocity }),
    ...(physics.angularVelocity === undefined ? {} : { angularVelocity: physics.angularVelocity }),
    ...(physics.constraints === undefined ? {} : { constraints: physics.constraints }),
  };
}

/** Checks the injected engines before any of them is used. */
function assertHostOptions(options: Scene3DHostOptions): void {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('Scene3DHost: options are required');
  }

  const document = options.document;
  if (typeof document !== 'object' || document === null || !Array.isArray(document.entities)) {
    throw new TypeError('Scene3DHost: options.document with an entities array is required');
  }
  if (document.version !== SCENE3D_VERSION) {
    throw new RangeError(
      `Scene3DHost: unsupported document version ${String(document.version)}; ` +
        `expected ${String(SCENE3D_VERSION)}`,
    );
  }
  if (typeof document.world !== 'object' || document.world === null) {
    throw new TypeError('Scene3DHost: options.document.world is required');
  }

  const physics = options.physics as Partial<PhysicsRuntime> | undefined;
  if (
    typeof physics !== 'object' ||
    physics === null ||
    typeof physics.initialize !== 'function' ||
    typeof physics.step !== 'function' ||
    typeof physics.addBody !== 'function' ||
    typeof physics.setJointTarget !== 'function' ||
    typeof physics.getBodyTransform !== 'function' ||
    typeof physics.dispose !== 'function'
  ) {
    throw new TypeError('Scene3DHost: options.physics must be a PhysicsRuntime');
  }

  const renderer = options.renderer;
  if (
    typeof renderer !== 'object' ||
    renderer === null ||
    typeof renderer.createSurface !== 'function' ||
    typeof renderer.dispose !== 'function'
  ) {
    throw new TypeError('Scene3DHost: options.renderer must be an OffscreenRenderer');
  }

  if (options.circuits !== undefined) {
    if (
      typeof options.circuits !== 'object' ||
      options.circuits === null ||
      typeof options.circuits.createCircuitSandbox !== 'function'
    ) {
      throw new TypeError('Scene3DHost: options.circuits.createCircuitSandbox must be a function');
    }
  }

  if (options.assemblyFor !== undefined && typeof options.assemblyFor !== 'function') {
    throw new TypeError('Scene3DHost: options.assemblyFor must be a function');
  }

  const startTime = options.startTime;
  if (startTime !== undefined && (!Number.isFinite(startTime) || startTime < 0)) {
    throw new RangeError('Scene3DHost: startTime must be a finite number >= 0');
  }
}

/** Validates a document or RPC entity before it touches the engines. */
function assertSceneEntity(value: unknown, context: string): asserts value is SceneEntity {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`${context}: an entity must be an object`);
  }

  const entity = value as {
    readonly id?: unknown;
    readonly type?: unknown;
    readonly position?: unknown;
    readonly rotation?: unknown;
    readonly assembly?: unknown;
    readonly physics?: unknown;
    readonly collider?: unknown;
    readonly material?: unknown;
  };

  if (typeof entity.id !== 'string' || entity.id === '') {
    throw new TypeError(`${context}: entity.id must be a non-empty string`);
  }
  if (typeof entity.type !== 'string' || !ENTITY_TYPES.includes(entity.type as EntityType)) {
    throw new TypeError(`${context}: entity "${entity.id}" has an unknown type`);
  }
  assertVec3(entity.position, `${context}: entity "${entity.id}".position`);
  assertQuaternion(entity.rotation, `${context}: entity "${entity.id}".rotation`);

  if (entity.type === 'assembly') {
    const reference: unknown = entity.assembly;
    const inline =
      typeof reference === 'object' &&
      reference !== null &&
      Array.isArray((reference as { readonly entities?: unknown }).entities);
    if (!inline && (typeof reference !== 'string' || reference === '')) {
      throw new TypeError(`${context}: assembly "${entity.id}" needs an assembly reference`);
    }
  }

  if (entity.type === 'model') {
    const physics = entity.physics as { readonly bodyType?: unknown } | undefined;
    if (typeof physics !== 'object' || physics === null) {
      throw new TypeError(`${context}: model "${entity.id}" needs a physics payload`);
    }
    if (
      typeof physics.bodyType !== 'string' ||
      !BODY_TYPES.includes(physics.bodyType as ModelEntity['physics']['bodyType'])
    ) {
      throw new TypeError(`${context}: model "${entity.id}" has an unknown body type`);
    }
    if (typeof entity.collider !== 'object' || entity.collider === null) {
      throw new TypeError(`${context}: model "${entity.id}" needs a collider`);
    }
    if (typeof entity.material !== 'object' || entity.material === null) {
      throw new TypeError(`${context}: model "${entity.id}" needs a material`);
    }
  }
}

function assertVec3(value: unknown, label: string): void {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`${label} must be a Vec3d`);
  }
  const vector = value as { readonly x?: unknown; readonly y?: unknown; readonly z?: unknown };
  if (
    typeof vector.x !== 'number' ||
    typeof vector.y !== 'number' ||
    typeof vector.z !== 'number' ||
    !Number.isFinite(vector.x) ||
    !Number.isFinite(vector.y) ||
    !Number.isFinite(vector.z)
  ) {
    throw new TypeError(`${label} must be a Vec3d of finite numbers`);
  }
}

function assertQuaternion(value: unknown, label: string): void {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`${label} must be a Quaternion`);
  }
  const quaternion = value as {
    readonly x?: unknown;
    readonly y?: unknown;
    readonly z?: unknown;
    readonly w?: unknown;
  };
  if (
    typeof quaternion.x !== 'number' ||
    typeof quaternion.y !== 'number' ||
    typeof quaternion.z !== 'number' ||
    typeof quaternion.w !== 'number' ||
    !Number.isFinite(quaternion.x) ||
    !Number.isFinite(quaternion.y) ||
    !Number.isFinite(quaternion.z) ||
    !Number.isFinite(quaternion.w)
  ) {
    throw new TypeError(`${label} must be a Quaternion of finite numbers`);
  }
}

function assertDelta(deltaMs: number): void {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) {
    throw new RangeError('Scene3DHost.step: deltaMs must be a finite number >= 0');
  }
}
