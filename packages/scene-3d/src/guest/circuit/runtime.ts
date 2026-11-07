import { createRpc } from '@mica-js/core/rpc';
import type { RpcEndpoint } from '@mica-js/core/rpc';
import type { CircuitJointCommand, CircuitSensorData } from '../../runtime/protocol';
import type { CircuitGuestContract } from './protocol';
import { circuitGuestService } from './protocol';

export interface CircuitRuntimeOptions {
  readonly createEndpoint?: (port: MessagePort) => RpcEndpoint;
  readonly step?: (deltaMs: number) => Promise<void> | void;
  readonly sensorData?: (data: CircuitSensorData) => Promise<void> | void;
}

export interface CircuitWorkerRuntime {
  readonly endpoint: RpcEndpoint;
  emitJointCommand(command: CircuitJointCommand): void;
  dispose(): void;
}

/** Starts a circuit guest directly on the port entangled with its scene host. */
export function startCircuitRuntime(
  port: MessagePort,
  options: CircuitRuntimeOptions = {},
): CircuitWorkerRuntime {
  const endpoint = options.createEndpoint?.(port) ?? createRpc(port);
  const listeners = new Set<(command: CircuitJointCommand) => void>();
  const service: CircuitGuestContract = {
    async step(deltaMs) {
      await options.step?.(deltaMs);
    },
    onDidJointCommand(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sensorData(data) {
      void options.sensorData?.(data);
    },
  };
  const registration = endpoint.register(circuitGuestService, service);
  return {
    endpoint,
    emitJointCommand(command) {
      for (const listener of [...listeners]) listener(command);
    },
    dispose() {
      registration.dispose();
      endpoint.dispose();
      port.close();
    },
  };
}
