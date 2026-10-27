import { createRpc, defineRpcService } from './index';
import type { RpcEndpoint, RpcProxy } from './index';
import type { IDisposable } from '../lifecycle';

declare const rpc: RpcEndpoint;
declare const worker: Worker;
createRpc(worker);
interface Service {
  value: number;
  sync(value: number): number;
  asyncMethod(): Promise<string>;
  withCallback(callback: () => void): void;
  onDidData(listener: (value: number) => void): () => void;
  onDidInvalid(): Promise<void>;
}
const service = defineRpcService<Service>('service');
const proxy: RpcProxy<Service> = rpc.getProxy(service);
const sync: Promise<number> = proxy.sync(1);
const asyncMethod: Promise<string> = proxy.asyncMethod();
const stop: () => void = proxy.onDidData((value) => {
  const number: number = value;
  void number;
});
const registration: IDisposable = rpc.register(service, {} as Service);
// @ts-expect-error Service endpoints require a typed service token.
rpc.getProxy<Service>('service');
// @ts-expect-error Service registrations require a typed service token.
rpc.register('service', {} as Service);
void [sync, asyncMethod, stop, registration];
// @ts-expect-error Remote calls always return promises.
const invalid: number = proxy.sync(1);
void invalid;
// @ts-expect-error Non-method properties are not remotely accessible.
proxy.value();
// @ts-expect-error Callback functions belong in onDidXxx subscriptions, not RPC arguments.
proxy.withCallback(() => undefined);
// @ts-expect-error Events require a listener and synchronous unsubscribe signature.
proxy.onDidInvalid();
// @ts-expect-error Service registrations are disposable objects, not cleanup functions.
registration();
