/**
 * Deterministic scene runtime with lockstep time synchronisation (#182).
 *
 * Every subsystem of a scene shares one virtual clock. A frame advances in a fixed order and
 * physics only moves once all circuit simulators have reached the same target time, which keeps
 * electrical state and rigid-body state consistent and makes a step sequence replayable.
 */

import type { PhysicsRuntime } from '../physics';
import type { JointCommand, RuntimeOptions, TimeMs } from './types';

/**
 * Scene simulation host.
 *
 * The runtime owns the virtual clock and drives the {@link PhysicsRuntime}; the future sensor
 * system (#192) and circuit simulator sandboxes (#214) plug into the same clock. Bodies and joints
 * are created and read through {@link Scene3DRuntime.physics}, matching the design where the
 * document only carries initial poses.
 *
 * ```ts
 * const physics = createMujocoRuntime();
 * await physics.initialize({ bodyType: 'dynamic' });
 *
 * const runtime = new Scene3DRuntime({ physics });
 * await runtime.step(1000 / 60);
 * runtime.getCurrentTime(); // 16.666…
 * ```
 */
export class Scene3DRuntime {
  /** Physics engine advanced by every {@link Scene3DRuntime.step}. */
  public readonly physics: PhysicsRuntime;

  private timeMs: TimeMs;

  public constructor(options: RuntimeOptions) {
    if (options === null || typeof options !== 'object' || options.physics === undefined) {
      throw new TypeError('Scene3DRuntime: options.physics is required');
    }

    const startTime = options.startTime ?? 0;
    if (!Number.isFinite(startTime) || startTime < 0) {
      throw new RangeError('Scene3DRuntime: startTime must be a finite number >= 0');
    }

    this.physics = options.physics;
    this.timeMs = startTime;
  }

  /** Virtual time of the last fully completed step, in milliseconds. */
  public get currentTime(): TimeMs {
    return this.timeMs;
  }

  /** Virtual time of the last fully completed step, in milliseconds. */
  public getCurrentTime(): TimeMs {
    return this.timeMs;
  }

  /**
   * Advances the whole scene by `deltaMs` virtual milliseconds using the lockstep model.
   *
   * All subsystems move to the same target time (`currentTime + deltaMs`) before physics is
   * allowed to advance, and the phases always run in this order:
   *
   * 1. collect sensor data — empty until the sensor system lands (#192);
   * 2. advance every circuit simulator to the target time and await all of them — empty until
   *    simulator sandboxes land (#214);
   * 3. collect the joint commands those simulators published;
   * 4. apply the commands as joint targets;
   * 5. advance physics by the same `deltaMs`;
   * 6. commit the target time to {@link Scene3DRuntime.currentTime}.
   *
   * The clock is written last, so a phase that throws leaves the runtime at the previous fully
   * synchronised time and the caller can retry the frame. Because the phase order and the physics
   * delta are fixed, the same initial state advanced by the same sequence of `deltaMs` values
   * always produces the same poses and joint states.
   *
   * @param deltaMs Virtual milliseconds to advance; must be finite and non-negative.
   * @throws RangeError when `deltaMs` is not a finite number greater than or equal to `0`.
   */
  public async step(deltaMs: TimeMs): Promise<void> {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      throw new RangeError('Scene3DRuntime.step: deltaMs must be a finite number >= 0');
    }

    const targetTime = this.timeMs + deltaMs;

    // 1. Collect sensor data. TODO: #192 — the sensor system is not wired in yet, so the frame
    //    starts from an empty snapshot.
    // 2. Advance circuit simulator(s) to `targetTime` and await all of them. TODO: #214 — there
    //    are no simulator sandboxes yet, so the lockstep barrier has nothing to wait for.
    // 3. Collect the commands the simulators published while advancing. TODO: #214.
    const commands: readonly JointCommand[] = [];

    // 4. Apply the collected commands before physics integrates anything, so every circuit sees
    //    the same integration step.
    this.applyCommands(commands);

    // 5. Physics advances by exactly the delta the other subsystems were given.
    this.physics.step(deltaMs);

    // 6. Commit the shared target time only after every phase succeeded.
    this.timeMs = targetTime;
  }

  /** Applies one joint target per command, in collection order. */
  private applyCommands(commands: readonly JointCommand[]): void {
    for (const command of commands) {
      this.physics.setJointTarget(command.jointId, command.target);
    }
  }
}
