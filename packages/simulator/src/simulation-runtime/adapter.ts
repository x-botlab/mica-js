import { toDisposable } from '@mica-js/core/lifecycle';
import { createRpc } from '@mica-js/core/rpc';
import type { RpcEndpoint } from '@mica-js/core/rpc';
import type { SandboxWorker } from '@mica-js/sandbox';
import { copyBytePayload } from './payload';
import { simulationRuntimeCallTransfer, simulationRuntimeService } from './rpc';
import type { IPreparedSimulation, ISimulationMessage, ISimulationRuntime } from './types';

/** Startup options of the worker-backed runtime adapter. */
export interface ISimulationRuntimeWorkerOptions {
  /**
   * Extra port transferred after the RPC port.
   *
   * The guest registers the `simulation-runtime` data plane on it; the caller keeps the other end
   * so a widget guest can deliver and subscribe without the host relaying.
   */
  readonly topicPort?: MessagePort;
}

/**
 * Builds an `ISimulationRuntime` that runs inside one sandbox worker.
 *
 * The adapter owns the worker: it starts the RPC channel, forwards the optional topic port, and
 * terminates the worker on `dispose`. The worker receives only `MessagePort`s, so device modules
 * are imported and executed inside the guest, never on the editor thread.
 */
export async function createSimulationRuntimeFromWorker(
  worker: SandboxWorker,
  options: ISimulationRuntimeWorkerOptions = {},
): Promise<ISimulationRuntime> {
  let channel: MessageChannel | undefined;
  let endpoint: RpcEndpoint | undefined;
  let posted = false;
  const topicPort = options.topicPort;
  try {
    await worker.ready;
    channel = new MessageChannel();
    endpoint = createRpc(channel.port1);
    const ports: MessagePort[] = [channel.port2];
    if (topicPort !== undefined) ports.push(topicPort);
    worker.postMessage(null, ports);
    posted = true;
  } catch (error) {
    endpoint?.dispose();
    if (!posted) {
      closePort(channel?.port1);
      closePort(channel?.port2);
      closePort(topicPort);
    }
    await worker.terminate('simulation runtime failed to start').catch(() => undefined);
    throw error;
  }
  if (endpoint === undefined || channel === undefined) {
    await worker.terminate('simulation runtime failed to start').catch(() => undefined);
    throw new Error('Simulation runtime RPC endpoint was not created.');
  }

  const rpc = endpoint;
  const guest = rpc.getProxy(simulationRuntimeService, {
    transfer: simulationRuntimeCallTransfer,
  });
  let disposed = false;

  return {
    load: (input: IPreparedSimulation) => guest.load(copyPreparedSimulation(input)),
    reset: () => guest.reset(),
    tick: (dt) => guest.tick(dt),
    deliver: (message: ISimulationMessage) => guest.deliver(copyMessage(message)),
    onDidPublish: (listener) => toDisposable(guest.onDidPublish(listener)),
    onDidDiagnostic: (listener) => toDisposable(guest.onDidDiagnostic(listener)),
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      try {
        await guest.dispose();
      } catch {
        // The worker may already be gone; teardown below still has to run.
      } finally {
        rpc.dispose();
        closePort(channel.port1);
        if (!posted) {
          closePort(channel.port2);
          closePort(topicPort);
        }
        await worker.terminate('disposed').catch(() => undefined);
      }
    },
  };
}

function copyPreparedSimulation(input: IPreparedSimulation): IPreparedSimulation {
  if (input.assets === undefined) return input;
  const assets: Record<string, Record<string, Uint8Array>> = {};
  for (const [symbolId, entries] of Object.entries(input.assets)) {
    const copies: Record<string, Uint8Array> = {};
    for (const [src, bytes] of Object.entries(entries)) copies[src] = new Uint8Array(bytes);
    assets[symbolId] = copies;
  }
  return { ...input, assets };
}

function copyMessage(message: ISimulationMessage): ISimulationMessage {
  const payload = copyBytePayload(message.payload);
  return payload === message.payload ? message : { ...message, payload };
}

function closePort(port: MessagePort | undefined): void {
  try {
    port?.close();
  } catch {
    // Already detached by a transfer; the receiving side owns it now.
  }
}
