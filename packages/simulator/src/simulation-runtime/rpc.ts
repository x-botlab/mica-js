import { defineRpcService } from '@mica-js/core/rpc';
import type { TimePs } from '@mica-js/core';
import type {
  IPreparedSimulation,
  ISimulationDiagnostic,
  ISimulationMessage,
  ISimulationTickReport,
} from './types';

/** Methods the runtime guest exposes over the primary sandbox RPC channel. */
export interface ISimulationRuntimeRpc {
  load(input: IPreparedSimulation): Promise<void>;
  reset(): Promise<void>;
  tick(dt: TimePs): Promise<ISimulationTickReport>;
  deliver(message: ISimulationMessage): Promise<void>;
  onDidPublish(listener: (message: ISimulationMessage) => void): () => void;
  onDidDiagnostic(listener: (diagnostic: ISimulationDiagnostic) => void): () => void;
  dispose(): Promise<void>;
}

/**
 * Wire name of the prepared simulation runtime.
 *
 * The same id is registered on the primary sandbox RPC channel and on the direct topic port, so a
 * widget guest reaches the running simulation without a second protocol.
 */
export const simulationRuntimeService =
  defineRpcService<ISimulationRuntimeRpc>('simulation-runtime');

/** The data plane the direct topic port exposes: deliveries in, publishes out. */
export interface ISimulationRuntimeTopicRpc {
  deliver(message: ISimulationMessage): Promise<void>;
  onDidPublish(listener: (message: ISimulationMessage) => void): () => void;
}

/** Topic-port view of the same wire service registered by the runtime guest. */
export const simulationRuntimeTopicService =
  defineRpcService<ISimulationRuntimeTopicRpc>('simulation-runtime');

/**
 * Transfer list for one proxy call.
 *
 * Asset bytes and delivered byte payloads are copied by the adapter before the call, so transferring
 * their buffers here never detaches a caller-owned array.
 */
export function simulationRuntimeCallTransfer(
  member: string,
  args: readonly unknown[],
): readonly ArrayBuffer[] {
  if (member === 'deliver') {
    const message = args[0] as ISimulationMessage | undefined;
    return transferableBuffer(message?.payload);
  }
  if (member === 'load') return assetTransferList(args[0]);
  return [];
}

/**
 * Transfer list for one event registration callback.
 *
 * `value` is the callback's argument array (see `RpcRegistrationOptions.transfer`). The guest copies
 * a byte payload before invoking the listener, so the published buffer is safe to transfer.
 */
export function simulationRuntimeEventTransfer(
  member: string,
  value: unknown,
): readonly ArrayBuffer[] {
  if (member !== 'onDidPublish' || !Array.isArray(value)) return [];
  const message = value[0] as ISimulationMessage | undefined;
  return transferableBuffer(message?.payload);
}

function transferableBuffer(payload: unknown): readonly ArrayBuffer[] {
  if (!(payload instanceof Uint8Array)) return [];
  return payload.buffer instanceof ArrayBuffer ? [payload.buffer] : [];
}

function assetTransferList(input: unknown): readonly ArrayBuffer[] {
  if (typeof input !== 'object' || input === null) return [];
  const assets = (input as { readonly assets?: unknown }).assets;
  if (typeof assets !== 'object' || assets === null) return [];
  const buffers = new Set<ArrayBuffer>();
  for (const entries of Object.values(assets)) {
    if (typeof entries !== 'object' || entries === null) continue;
    for (const bytes of Object.values(entries)) {
      if (bytes instanceof Uint8Array && bytes.buffer instanceof ArrayBuffer) {
        buffers.add(bytes.buffer);
      }
    }
  }
  return [...buffers];
}
