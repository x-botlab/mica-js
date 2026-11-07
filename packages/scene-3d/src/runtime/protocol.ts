/**
 * Wire protocol between the main thread and the simulation host (#214).
 *
 * Two channels exist, and neither of them routes through the main thread:
 *
 * ```
 * Scene3DClient ──RPC──▶ Scene3DHost ──MessageChannel──▶ Circuit simulator
 *   (main thread)         (sandbox)                        (child sandbox)
 * ```
 *
 * - **Client ↔ host** is an RPC surface: `step`, `addEntity`, `removeEntity`, `getTransforms`,
 *   `getState` and `dispose`. Every payload is plain data or a typed array so it survives
 *   structured cloning; transform batches are one `Float32Array` instead of one message per
 *   entity.
 * - **Host ↔ circuit** is a direct `MessageChannel` opened by `a direct MessageChannel`
 *  . The child calls `step()` on the lockstep barrier and emits `jointCommand` events while
 *   it advances; the host buffers them and applies them before the physics step. Sensor frames go
 *   the other way: after physics advances, the host notifies the circuit that owns the sensor with
 *   a `sensorData` payload.
 */

import { defineRpcService } from '@mica-js/core/rpc';
import type { AssemblyInstance, SceneEntity } from '../entities';
import type { Scene3DDocument } from '../format/document';
import type { JointTarget } from '../physics';
import type { SensorData } from '../sensors/types';

/** Number of floats per entity in a transform batch, matching `THREE.Matrix4.elements`. */
export const TRANSFORM_STRIDE = 16;

/** Methods the host exposes to {@link Scene3DHostProxy.call}. */
export const SCENE3D_HOST_METHODS = [
  'step',
  'addEntity',
  'removeEntity',
  'getTransforms',
  'getState',
  'dispose',
] as const;

/** Name of one host RPC method. */
export type Scene3DHostMethod = (typeof SCENE3D_HOST_METHODS)[number];

/** RPC service exposed by the scene-host guest to its main-thread client. */
export const sceneHostGuest = defineRpcService<Scene3DHostContract>('scene-host-guest');

/** RPC service exposed by the main thread to the scene-host guest. */
export const sceneHostHost = defineRpcService<SceneHostHostContract>('scene-host-host');

/** A contact reported by the physics engine during the last step. */
export interface CollisionEvent {
  /** First body of the contact. */
  readonly bodyA: string;
  /** Second body of the contact, or the world when it has no body id. */
  readonly bodyB: string;
  /** Normal impulse in N·s. */
  readonly impulse: number;
}

/** Snapshot counters of a host, cheap enough to poll every frame. */
export interface Scene3DHostState {
  /** Virtual time in milliseconds after the last completed step. */
  readonly timeMs: number;
  /** Number of completed steps. */
  readonly stepCount: number;
  /** Entities currently simulated, in transform-batch order. */
  readonly entityCount: number;
  /** Circuit simulator sandboxes currently attached. */
  readonly circuitCount: number;
}

/** Result of one lockstep step. */
export interface StepResult {
  /**
   * World transform of every entity, column-major, `TRANSFORM_STRIDE` floats each, in the order
   * the entities were added (document order first, then `addEntity` order). Entities without a
   * rigid body keep an identity matrix.
   */
  readonly transforms: Float32Array;

  /**
   * Contacts of this step.
   *
   * Always empty today: `PhysicsRuntime` cannot report contacts yet. It is part of the payload so
   * the client and the adapter do not change when contacts land.
   */
  readonly collisions: readonly CollisionEvent[];

  /** Virtual time in milliseconds after this step. */
  readonly timeMs: number;
  /** Number of completed steps, including this one. */
  readonly stepCount: number;
}

/**
 * Host API as seen from the main thread.
 *
 * `Scene3DHost` implements it directly; the guest registers it on `sceneHostGuest`.
 */
export interface Scene3DHostContract {
  /** Advances physics and every circuit simulator by the same virtual delta. */
  step(deltaMs: number): Promise<StepResult>;
  /** Adds an entity to the live scene. */
  addEntity(entity: SceneEntity): Promise<void>;
  /** Removes an entity and releases its circuit sandbox. */
  removeEntity(id: string): Promise<void>;
  /** Reads the whole transform batch without advancing the simulation. */
  getTransforms(): Float32Array;
  /** Reads the clock and entity counters. */
  getState(): Scene3DHostState;
  /** Terminates circuit sandboxes and releases physics and rendering resources. */
  dispose(): Promise<void>;
}

/**
 * Minimal RPC handle the client needs.
 *
 * A The host proxy is an RPC proxy created by `@mica-js/scene-3d/client`.
 */
export interface Scene3DHostProxy {
  /** Calls one host method. */
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
  /** Terminates the host sandbox; when omitted the client can only dispose the host itself. */
  terminate?(reason?: string): Promise<void>;
}

/** Main-thread services used by the scene-host guest. */
export interface SceneHostHostContract {
  /** Returns the document captured by the main-thread client. */
  getDocument(): Scene3DDocument;
  /** Creates a circuit guest and transfers its direct RPC port to the scene-host guest. */
  createCircuitSandbox(options: CircuitSandboxOptions): Promise<MessagePort>;
  /**
   * Terminates the circuit worker the main thread created for `name`.
   *
   * The guest owns the direct channel, not the worker: closing the port silences the channel but
   * leaves the worker alive, so removing an entity mid-session has to ask the main thread to stop
   * it. Resolves when the worker is gone or was already unknown.
   */
  releaseCircuitSandbox(name: string): Promise<void>;
}

/** Joint command a circuit simulator emits while it advances. */
export interface CircuitJointCommand {
  /** Joint the command targets. */
  readonly jointId: string;
  /** Command applied before physics advances. */
  readonly target: JointTarget;
}

/** Event a circuit simulator emits over its direct channel to the host. */
export const CIRCUIT_EVENT_JOINT_COMMAND = 'jointCommand';

/** Notification the host sends to a circuit simulator when a sensor produces a reading. */
export const CIRCUIT_EVENT_SENSOR_DATA = 'sensorData';

/** Method the host calls on a circuit simulator during the lockstep barrier. */
export const CIRCUIT_METHOD_STEP = 'step';

/** Payload of {@link CIRCUIT_EVENT_SENSOR_DATA}. */
export interface CircuitSensorData {
  /** Identity of the sensor that produced the reading, matching `SensorEntity.id`. */
  readonly sensorId: string;
  /** Reading taken at the host's current virtual time. */
  readonly data: SensorData;
}

/** Circuit simulator API, called directly over the `MessageChannel` opened by the host guest. */
export interface CircuitSandboxContract {
  /** Advances the circuit by `deltaMs` virtual milliseconds. */
  step(deltaMs: number): Promise<void>;
}

/**
 * Structural view of a direct circuit RPC handle.
 */
export interface CircuitSandboxHandle {
  /** Diagnostic name of the child sandbox. */
  readonly name?: string;
  /** Calls a method the child exported. */
  call(method: string, ...args: unknown[]): Promise<unknown>;
  /** Subscribes to an event the child emits; returns an unsubscribe function. */
  on(type: string, listener: (payload: unknown) => void): () => void;
  /**
   * Sends a one-way notification to the child.
   *
   * Optional so a test double can omit it; the host then skips sensor frames for that circuit.
   */
  notify?(
    method: string,
    args?: readonly unknown[],
    transfer?: readonly Transferable[],
  ): void | Promise<void>;
  /** Terminates the child; terminates its worker and releases its resources. */
  terminate(reason?: string): Promise<void>;
}

/** Description of one circuit sandbox the host wants to create. */
export interface CircuitSandboxOptions {
  /** Unique diagnostic name, `circuit-<entityId>`. */
  readonly name: string;
  /** Assembly instance the simulator belongs to. */
  readonly entityId: string;
  /** Assembly definition reference of the instance, `package:name`. */
  readonly assembly: string;
  /** Schematic bound to this instance, when one could be resolved. */
  readonly schematic?: string;
}

/** Creates a direct circuit guest for one simulator. */
export type CircuitSandboxFactory = (
  options: CircuitSandboxOptions,
) => Promise<CircuitSandboxHandle>;

/** Circuit wiring of a host. Omit it to run a physics-only scene. */
export interface Scene3DCircuitOptions {
  /** Creates one direct circuit guest per assembly instance. */
  readonly createCircuitSandbox: CircuitSandboxFactory;
  /**
   * Resolves the schematic an assembly instance loads. Defaults to `document.schematic`, the
   * schematic shared with the 2D canvas, because an `.assembly.json` definition is not part of the
   * document yet.
   */
  readonly schematicFor?: (
    entity: AssemblyInstance,
    document: { readonly schematic?: string },
  ) => string | undefined;
}

/** Thrown when a peer breaks the wire contract. */
export class Scene3DProtocolError extends Error {
  public constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'Scene3DProtocolError';
  }
}
