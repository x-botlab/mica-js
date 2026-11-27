import { timePs } from '@mica-js/core';
import { Emitter } from '@mica-js/core/lifecycle';
import { describe, expect, it, vi } from 'vitest';
import { createSimulationControl } from './simulation';
import type { ISimulationRuntime } from './simulation';
import type { FusedSessionStatus, IFusedSessionState } from './runtime/protocol';

function fixture(status: FusedSessionStatus = 'running') {
  const states = new Emitter<IFusedSessionState>();
  let state: IFusedSessionState = { status, simTime: timePs(0) };
  const pause = vi.fn(async () => {
    setState({ status: 'paused', simTime: state.simTime });
  });
  const resume = vi.fn(async () => {
    setState({ status: 'running', simTime: state.simTime });
  });
  const reset = vi.fn(async () => {
    setState({ status: 'running', simTime: timePs(0) });
  });
  function setState(next: IFusedSessionState): void {
    state = next;
    states.fire(next);
  }
  const runtime: ISimulationRuntime = {
    getState: () => state,
    onDidChangeState: states.event,
    pause,
    resume,
    reset,
  };
  return { runtime, setState, pause, resume, reset, dispose: () => states.dispose() };
}

describe('fused simulation control', () => {
  it('restarts the mounted session from the captured bytes', async () => {
    const bench = fixture('paused');
    const changes: Array<FusedSessionStatus | undefined> = [];
    const control = createSimulationControl((status) => changes.push(status));
    control.attach(bench.runtime);

    await control.restart();
    expect(bench.reset).toHaveBeenCalledTimes(1);
    expect(control.status).toBe('running');
    expect(changes).toEqual(['paused', 'running']);

    control.dispose();
    bench.dispose();
  });

  it('mirrors status transitions of the same run session and ignores simulated time', async () => {
    const bench = fixture('running');
    const changes: Array<FusedSessionStatus | undefined> = [];
    const control = createSimulationControl((status) => changes.push(status));
    control.attach(bench.runtime);
    expect(control.status).toBe('running');
    expect(changes).toEqual(['running']);

    // A tick changes only the simulated time: the host must not be asked to update.
    bench.setState({ status: 'running', simTime: timePs(10) });
    expect(changes).toEqual(['running']);

    await control.pause();
    expect(bench.pause).toHaveBeenCalledTimes(1);
    expect(control.status).toBe('paused');
    expect(changes).toEqual(['running', 'paused']);

    // Same-state commands are no-ops and issue no second call into the session.
    await control.pause();
    expect(bench.pause).toHaveBeenCalledTimes(1);

    await control.resume();
    expect(bench.resume).toHaveBeenCalledTimes(1);
    expect(control.status).toBe('running');
    expect(changes).toEqual(['running', 'paused', 'running']);

    await control.resume();
    expect(bench.resume).toHaveBeenCalledTimes(1);

    control.dispose();
    bench.dispose();
  });

  it('reports a fault and stops observing after teardown', () => {
    const bench = fixture('running');
    const changes: Array<FusedSessionStatus | undefined> = [];
    const control = createSimulationControl((status) => changes.push(status));
    control.attach(bench.runtime);

    bench.setState({ status: 'faulted', simTime: timePs(20) });
    expect(control.status).toBe('faulted');
    expect(changes).toEqual(['running', 'faulted']);

    control.dispose();
    bench.setState({ status: 'paused', simTime: timePs(30) });
    expect(control.status).toBeUndefined();
    expect(changes).toEqual(['running', 'faulted']);
    bench.dispose();
  });

  it('rejects commands without a mounted run session and ignores detached state changes', async () => {
    const bench = fixture('running');
    const changes: Array<FusedSessionStatus | undefined> = [];
    const control = createSimulationControl((status) => changes.push(status));
    await expect(control.pause()).rejects.toThrow(/requires a run session/);
    await expect(control.resume()).rejects.toThrow(/requires a run session/);
    await expect(control.restart()).rejects.toThrow(/requires a run session/);

    control.attach(bench.runtime);
    control.detach();
    expect(control.status).toBeUndefined();
    bench.setState({ status: 'paused', simTime: timePs(40) });
    expect(changes).toEqual(['running', undefined]);
    await expect(control.pause()).rejects.toThrow(/requires a run session/);

    control.dispose();
    await expect(control.resume()).rejects.toThrow(/requires an active workbench/);
    bench.dispose();
  });
});
