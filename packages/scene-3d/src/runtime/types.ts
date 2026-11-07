/**
 * Time-synchronisation contracts of the scene runtime (#182).
 *
 * A scene owns one virtual clock. Physics and — once they land — every circuit simulator and the
 * sensor system advance on that single timeline, in lockstep, so no subsystem can observe another
 * one at a different instant. The clock is expressed in milliseconds because it lines up with
 * `world.physicsStep` and with the frame deltas supplied by the host; the circuit layer counts in
 * picoseconds (`TimePs`, `@mica-js/core`), so it converts at its own boundary.
 */

import type { JointTarget, PhysicsRuntime } from '../physics';

/** Virtual time in milliseconds, relative to the start of the scene. */
export type TimeMs = number;

/**
 * One joint command collected from the circuit simulators during a lockstep step.
 *
 * The runtime applies every command as a {@link PhysicsRuntime.setJointTarget} call before the
 * physics step, so all circuits of a frame are visible to the same integration step.
 */
export interface JointCommand {
  /** Joint the command targets. */
  readonly jointId: string;
  /** Command value applied before physics advances. */
  readonly target: JointTarget;
}

/** Options of a `Scene3DRuntime`. */
export interface RuntimeOptions {
  /**
   * Physics runtime the scene advances. The caller owns it and must `initialize()` it before the
   * first step, because initialization is asynchronous and the runtime constructor is not.
   */
  readonly physics: PhysicsRuntime;
  /** Virtual time the clock starts at, in milliseconds; defaults to `0`. */
  readonly startTime?: TimeMs;
}
