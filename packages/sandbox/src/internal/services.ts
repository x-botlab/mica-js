import { defineRpcService } from '@mica-js/core/rpc';
import type { RpcServiceId } from '@mica-js/core/rpc';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SandboxRpcMethod = (...args: any[]) => any;

export const hostCapabilitiesService: RpcServiceId<Record<string, SandboxRpcMethod>> =
  defineRpcService('host-capabilities');
export const hostControlService: RpcServiceId<Record<string, SandboxRpcMethod>> =
  defineRpcService('host-control');
export const guestService: RpcServiceId<Record<string, SandboxRpcMethod>> =
  defineRpcService('guest');
export const guestControlService: RpcServiceId<Record<string, SandboxRpcMethod>> =
  defineRpcService('guest-control');
