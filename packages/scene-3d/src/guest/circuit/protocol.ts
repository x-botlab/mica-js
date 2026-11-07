import { defineRpcService } from '@mica-js/core/rpc';
import type {
  CircuitJointCommand,
  CircuitSandboxContract,
  CircuitSensorData,
} from '../../runtime/protocol';

/** RPC surface implemented by one direct circuit guest. */
export interface CircuitGuestContract extends CircuitSandboxContract {
  onDidJointCommand(listener: (command: CircuitJointCommand) => void): () => void;
  sensorData(data: CircuitSensorData): void;
}

export const circuitGuestService = defineRpcService<CircuitGuestContract>('circuit-guest');
