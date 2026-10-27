import { defineRpcService } from '../../../../packages/core/src/rpc';
import type { RpcEndpoint, RpcServiceId } from '../../../../packages/core/src/rpc';

export interface BitmapValue {
  bitmap: ImageBitmap;
}

export interface HostService {
  echo(value: string): string;
  onDidTick(listener: () => void): () => void;
}

export interface SandboxService {
  connect(transferred: MessagePort): { connected: boolean; origin: string; document: string };
}

export interface GuestService {
  add(a: number, b: number): number;
  emit(value: string): string;
  onDidValue(listener: (value: string) => void): () => void;
  listenerCount(): number;
  callHost(value: string): string | Promise<string>;
  waitForever(): never | Promise<never>;
  bitmap(): BitmapValue;
  emitBitmap(): void;
  onDidBitmap(listener: (value: BitmapValue) => void): () => void;
  inspectBitmap(value: BitmapValue): number;
  bitmapWidths(): number[];
}

export const hostService: RpcServiceId<HostService> = defineRpcService('host');
export const sandboxService: RpcServiceId<SandboxService> = defineRpcService('guest');
export const guestService: RpcServiceId<GuestService> = defineRpcService('guest');
export type FixtureRpc = RpcEndpoint;
