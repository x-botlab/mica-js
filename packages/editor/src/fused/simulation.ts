/**
 * Host-only pause/resume of the fused workbench run session.
 *
 * The workbench owns the runtime and serializes mode transitions; this control only mirrors the
 * status of the attached session and forwards pause/resume. Pausing keeps the session mounted:
 * models, views and subscriptions stay as they are, and only simulated time stops advancing.
 */
import type { Disposable, Event } from '@mica-js/core/lifecycle';
import type { FusedSessionStatus, IFusedSessionState } from './runtime/protocol';

/** Runtime surface one host control drives; the full runtime bridge satisfies it. */
export interface ISimulationRuntime {
  getState(): IFusedSessionState;
  readonly onDidChangeState: Event<IFusedSessionState>;
  pause(): Promise<void>;
  resume(): Promise<void>;
}

/** Commands and state a host observes while a run session is mounted. */
export interface IFusedSimulationControl {
  /** Status of the attached run session; `undefined` when no session is mounted. */
  readonly status: FusedSessionStatus | undefined;
  /** Attaches the run session this control drives, replacing any previous session. */
  attach(runtime: ISimulationRuntime): void;
  /** Detaches the session; later state changes of it are ignored. */
  detach(): void;
  /** Stops advancement once the session acknowledged it; a no-op while already paused. */
  pause(): Promise<void>;
  /** Restarts advancement once the session acknowledged it; a no-op while already running. */
  resume(): Promise<void>;
  dispose(): void;
}

/**
 * Creates the host control of one workbench run session.
 *
 * Only status transitions reach `onDidChangeStatus`; simulated time changes are ignored, so a host
 * is never asked to update once per simulated tick.
 */
export function createSimulationControl(
  onDidChangeStatus: (status: FusedSessionStatus | undefined) => void,
): IFusedSimulationControl {
  let runtime: ISimulationRuntime | undefined;
  let subscription: Disposable | undefined;
  let status: FusedSessionStatus | undefined;
  let closed = false;

  function publish(next: FusedSessionStatus | undefined): void {
    if (next === status) return;
    status = next;
    if (!closed) onDidChangeStatus(next);
  }

  function detach(): void {
    subscription?.dispose();
    subscription = undefined;
    runtime = undefined;
    publish(undefined);
  }

  function requireSession(operation: 'pause' | 'resume'): ISimulationRuntime {
    if (closed) throw new Error(`simulation.${operation} requires an active workbench`);
    if (runtime === undefined) throw new Error(`simulation.${operation} requires a run session`);
    return runtime;
  }

  return {
    get status() {
      return status;
    },
    attach(next) {
      if (closed) throw new Error('The simulation control is disposed');
      detach();
      runtime = next;
      subscription = next.onDidChangeState((state) => {
        if (runtime !== next) return;
        publish(state.status);
      });
      publish(next.getState().status);
    },
    detach,
    async pause() {
      const active = requireSession('pause');
      if (status === 'paused') return;
      await active.pause();
      if (runtime === active && !closed) publish(active.getState().status);
    },
    async resume() {
      const active = requireSession('resume');
      if (status === 'running') return;
      await active.resume();
      if (runtime === active && !closed) publish(active.getState().status);
    },
    dispose() {
      if (closed) return;
      closed = true;
      subscription?.dispose();
      subscription = undefined;
      runtime = undefined;
      status = undefined;
    },
  };
}
