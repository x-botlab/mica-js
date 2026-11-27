/**
 * Fused editor runtime bridge of one workbench (RFC 0025).
 *
 * One simulation worker runs the document, the packages and the models; one presentation worker runs
 * the declared 2D view modules. The editor schedules both and never imports model or author code.
 *
 * Every asynchronous transition is numbered: a preparation, reset or disposal that was superseded
 * never applies its result, and a frame produced for a replaced presentation is closed, not shown.
 */
import { timePs } from '@mica-js/core';
import { Emitter } from '@mica-js/core/lifecycle';
import type { RuntimeDiagnostic } from '@mica-js/sdk/fused';
import type {
  IFusedInstancePresentation,
  IFusedModelClient,
  IFusedOverlayFrame,
  IFusedSessionState,
} from '../protocol';
import { connectFusedWorkbench } from './connection';
import { createFusedDisplay } from './display';
import { createHostModelRouter } from './model';
import type { IFusedDisplayPrepareInput, IFusedRuntime, IFusedRuntimeOptions } from './types';
import type { IFusedWorkerFactories } from './types';
import { FusedBridgeError, mapWireFailure } from '../wire';

const IDLE: IFusedSessionState = Object.freeze({ status: 'idle', simTime: timePs(0) });

/** Creates the runtime bridge of one workbench from a document, a registry and a fixed step. */
export async function createFusedRuntime(options: IFusedRuntimeOptions): Promise<IFusedRuntime> {
  const workers: IFusedWorkerFactories =
    options.workers ?? (await import('../workers')).fusedWorkerFactories;
  const diagnostics = new Emitter<RuntimeDiagnostic>();
  const overlays = new Emitter<IFusedOverlayFrame>();
  const states = new Emitter<IFusedSessionState>();
  const report = (entry: RuntimeDiagnostic): void => {
    diagnostics.fire(entry);
    options.onDiagnostic?.(entry);
  };
  const connection = await connectFusedWorkbench({
    workers,
    registry: options.registry,
    ...(options.audio === undefined ? {} : { audio: options.audio }),
    ...(options.container === undefined ? {} : { container: options.container }),
    ...(options.resolveResource === undefined ? {} : { resolveResource: options.resolveResource }),
    ...(options.programs === undefined ? {} : { programs: options.programs }),
    onDiagnostic: report,
  });
  const models = createHostModelRouter(connection.simulation);
  const displayHost = createFusedDisplay({
    proxy: connection.display,
    onDiagnostic: report,
    onOverlay: (frame) => {
      overlays.fire(frame);
      options.onOverlay?.(frame);
    },
    ...(options.measure === undefined ? {} : { measure: options.measure }),
  });

  let state: IFusedSessionState = IDLE;
  let prepared: readonly IFusedInstancePresentation[] = [];
  let mode: 'edit' | 'run' | undefined;
  let preparation = 0;
  let closed = false;
  let disposal: Promise<void> | undefined;
  const clients = new Map<string, IFusedModelClient>();

  const stopState = connection.simulation.onDidChangeState((next) => setState(next));

  const runtime: IFusedRuntime = {
    audio: connection.audio,
    getState: () => state,
    onDidChangeState: states.event,
    onDidReportDiagnostic: diagnostics.event,
    onDidRenderOverlay: overlays.event,
    getModel,
    display: displayHost.display,
    prepareDisplay,
    resume,
    pause,
    step,
    reset,
    dispose,
  };
  try {
    await prepareDisplay({ mode: options.mode ?? 'edit' });
  } catch (cause) {
    await dispose().catch(() => undefined);
    throw cause;
  }
  return runtime;

  function setState(next: IFusedSessionState): void {
    if (next.status === 'running') connection.audio.resume();
    else connection.audio.suspend();
    if (next.status === state.status && next.simTime === state.simTime) return;
    state = next;
    states.fire(next);
  }

  function assertOpen(): void {
    if (closed) {
      throw new FusedBridgeError('runtime/unavailable-state', 'The fused runtime is disposed.');
    }
  }

  function assertRun(operation: string): void {
    assertOpen();
    if (mode !== 'run') {
      throw new FusedBridgeError(
        'runtime/unavailable-state',
        `${operation} requires a run session; prepare the run mode first.`,
      );
    }
  }

  function getModel(instanceId: string): IFusedModelClient {
    if (closed || mode !== 'run') {
      throw new FusedBridgeError(
        'model/disconnected',
        'No model is mounted: the fused runtime is not in run mode.',
        { instanceId },
      );
    }
    const instance = prepared.find((entry) => entry.instanceId === instanceId);
    if (instance === undefined) {
      throw new FusedBridgeError(
        'model/unknown-instance',
        `No live model for instance "${instanceId}".`,
        { instanceId },
      );
    }
    let client = clients.get(instanceId);
    if (client === undefined) {
      client = models.client(instance);
      clients.set(instanceId, client);
    }
    return client;
  }

  async function prepareDisplay(
    input: IFusedDisplayPrepareInput,
  ): Promise<readonly IFusedInstancePresentation[]> {
    assertOpen();
    const attempt = ++preparation;
    connection.audio.suspend();
    connection.audio.clear();
    const current = (): boolean => !closed && attempt === preparation;
    const described = await mapWireFailure(() =>
      connection.simulation.prepare({ document: options.document, mode: input.mode }),
    );
    if (!current()) return prepared;
    if (input.mode === 'edit') {
      // Edit mode mounts presentation only: the models are released before any view is created.
      await mapWireFailure(() => connection.simulation.dispose());
      if (!current()) return prepared;
    }
    // Factories run before the models exist, so their subscriptions observe the initial events.
    await displayHost.prepare({ mode: input.mode }, described.instances);
    if (!current()) return prepared;
    if (input.mode === 'run') {
      try {
        const loaded = await mapWireFailure(() =>
          connection.simulation.load({
            document: options.document,
            step: options.step,
            ...(options.batchExecution === undefined
              ? {}
              : { batchExecution: options.batchExecution }),
          }),
        );
        if (!current()) return prepared;
        setState(loaded);
      } catch (cause) {
        // The factories of a session that never mounted must not keep drawing a dead model lane.
        await displayHost.prepare({ mode: input.mode }, []).catch(() => undefined);
        throw cause;
      }
    }
    prepared = described.instances;
    mode = input.mode;
    clients.clear();
    // `initialize` runs after the models mounted and delivered their initial events.
    await displayHost.activate();
    if (!current()) return prepared;
    // Static views need an initial frame even when they never invalidate themselves.
    displayHost.display.invalidate();
    if (input.mode === 'run') {
      // A run session starts advancing once every presentation subscribed to its model.
      await mapWireFailure(() => connection.simulation.resume());
    }
    return prepared;
  }

  async function resume(): Promise<void> {
    assertRun('resume');
    await mapWireFailure(() => connection.simulation.resume());
  }

  async function pause(): Promise<void> {
    if (closed || mode !== 'run') return;
    await mapWireFailure(() => connection.simulation.pause());
  }

  async function step(): Promise<void> {
    assertRun('step');
    const next = await mapWireFailure(() => connection.simulation.step());
    setState(next);
  }

  async function reset(): Promise<void> {
    assertRun('reset');
    connection.audio.suspend();
    connection.audio.clear();
    const attempt = ++preparation;
    const current = (): boolean => !closed && attempt === preparation;
    const instances = prepared;
    // The rebuilt presentation subscribes first; the replacement models then deliver initial events.
    await displayHost.prepare({ mode: 'run' }, instances);
    if (!current()) return;
    clients.clear();
    await mapWireFailure(() => connection.simulation.reset());
    if (!current()) return;
    await displayHost.activate();
    if (!current()) return;
    displayHost.display.invalidate();
    await mapWireFailure(() => connection.simulation.resume());
  }

  function dispose(): Promise<void> {
    if (disposal !== undefined) return disposal;
    closed = true;
    connection.audio.dispose();
    disposal = (async () => {
      const problems: unknown[] = [];
      // Presentation first: input stops and views release before the models go away.
      try {
        await displayHost.dispose();
      } catch (cause) {
        problems.push(cause);
      }
      try {
        await mapWireFailure(() => connection.simulation.dispose());
      } catch (cause) {
        problems.push(cause);
      }
      try {
        stopState();
      } catch (cause) {
        problems.push(cause);
      }
      models.dispose();
      try {
        await connection.dispose();
      } catch (cause) {
        problems.push(cause);
      }
      states.dispose();
      diagnostics.dispose();
      overlays.dispose();
      if (problems.length > 0) {
        throw new AggregateError(problems, 'The fused runtime failed to release every resource.');
      }
    })();
    return disposal;
  }
}
