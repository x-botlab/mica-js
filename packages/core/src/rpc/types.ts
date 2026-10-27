import type { IDisposable } from '../lifecycle';

export interface RpcPort<TTransfer = Transferable> {
  postMessage(message: unknown, transfer?: TTransfer[]): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  start?(): void;
}

export interface RpcOptions {
  /** Zero disables the timeout. A timeout never cancels remote execution. */
  readonly timeoutMs?: number;
  readonly onError?: (error: Error) => void;
}

export interface RpcProxyOptions<TTransfer = Transferable> {
  readonly timeoutMs?: number;
  readonly transfer?: (member: string, args: readonly unknown[]) => readonly TTransfer[];
}

export interface RpcRegistrationOptions<TTransfer = Transferable> {
  /** The value is a method result, or the argument array for an onDidXxx event. */
  readonly transfer?: (member: string, value: unknown) => readonly TTransfer[];
}

declare const rpcServiceIdBrand: unique symbol;

export type RpcServiceId<T extends object> = string & {
  readonly [rpcServiceIdBrand]: T;
};

export function defineRpcService<T extends object>(name: string): RpcServiceId<T> {
  if (typeof name !== 'string' || name.length === 0)
    throw new TypeError('RPC service name must be nonempty');
  return name as RpcServiceId<T>;
}

type RemoteArguments<A extends unknown[]> = {
  [K in keyof A]: A[K] extends (...args: never[]) => unknown ? never : A[K];
};

export type RpcProxy<T extends object> = {
  [
    K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never
  ]: K extends `onDid${string}`
    ? T[K] extends (listener: infer L) => () => void
      ? L extends (...args: never[]) => void
        ? (listener: L) => () => void
        : never
      : never
    : T[K] extends (...args: infer A) => infer R
      ? (...args: RemoteArguments<A>) => Promise<Awaited<R>>
      : never;
};

export interface RpcEndpoint<TTransfer = Transferable> extends IDisposable {
  register<T extends object>(
    serviceId: RpcServiceId<T>,
    implementation: T,
    options?: RpcRegistrationOptions<TTransfer>,
  ): IDisposable;
  getProxy<T extends object>(
    serviceId: RpcServiceId<T>,
    options?: RpcProxyOptions<TTransfer>,
  ): RpcProxy<T>;
  onDidError(listener: (error: Error) => void): () => void;
  onDidClose(listener: () => void): () => void;
}
