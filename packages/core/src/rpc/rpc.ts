import { toDisposable } from '../lifecycle';
import { isRpcMessage } from './protocol';
import type { RpcMessage } from './protocol';
import type {
  RpcEndpoint,
  RpcOptions,
  RpcPort,
  RpcProxy,
  RpcProxyOptions,
  RpcRegistrationOptions,
  RpcServiceId,
} from './types';

type Callable = (...args: unknown[]) => unknown;
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};
type Registration<TTransfer> = {
  implementation: object;
  options: RpcRegistrationOptions<TTransfer>;
};
type Subscription<TTransfer> = {
  registration: Registration<TTransfer>;
  stop: (() => void) | undefined;
};

function rpcError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

function findMethod(service: object, member: string): Callable {
  if (['constructor', '__proto__', 'prototype', 'then'].includes(member)) {
    throw rpcError('MethodNotFound', `Method is not exposed: ${member}`);
  }
  // Inspect descriptors so remote member lookup never invokes an accessor.
  for (
    let owner = service;
    owner && owner !== Object.prototype;
    owner = Object.getPrototypeOf(owner)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, member);
    if (descriptor) {
      if (typeof descriptor.value === 'function') return descriptor.value;
      break;
    }
  }
  throw rpcError('MethodNotFound', `Method is not callable: ${member}`);
}

export function createRpc<TTransfer = Transferable>(
  port: RpcPort<TTransfer>,
  options: RpcOptions = {},
): RpcEndpoint<TTransfer> {
  const config = options;
  const defaultTimeout = validateTimeout(config.timeoutMs ?? 0);
  const services = new Map<string, Registration<TTransfer>>();
  const pending = new Map<number, Pending>();
  const listeners = new Map<number, Callable>();
  const subscriptions = new Map<number, Subscription<TTransfer>>();
  const errorListeners = new Set<(error: Error) => void>();
  const closeListeners = new Set<() => void>();
  let nextId = 0;
  let lastIncomingId = 0;
  let closed = false;

  function report(error: unknown): void {
    const failure = asError(error);
    for (const listener of [config.onError, ...errorListeners]) {
      try {
        listener?.(failure);
      } catch {
        /* Error observers must not interrupt cleanup. */
      }
    }
  }

  function ensureOpen(): void {
    if (closed) throw rpcError('RpcDisconnectedError', 'RPC endpoint is closed');
  }

  function allocateId(): number {
    if (nextId === Number.MAX_SAFE_INTEGER) throw new RangeError('RPC request IDs exhausted');
    return ++nextId;
  }

  function send(message: RpcMessage, transfer?: readonly TTransfer[]): void {
    ensureOpen();
    port.postMessage(message, transfer ? [...transfer] : undefined);
  }

  function settle(id: number): Pending | undefined {
    const entry = pending.get(id);
    pending.delete(id);
    if (entry?.timer !== undefined) clearTimeout(entry.timer);
    return entry;
  }

  function request(
    message: Extract<RpcMessage, { kind: 'call' | 'listen' }>,
    timeout: number,
    transfer?: readonly TTransfer[],
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer =
        timeout > 0
          ? setTimeout(() => {
              settle(message.id)?.reject(
                rpcError('RpcTimeoutError', `RPC ${message.service}.${message.member} timed out`),
              );
            }, timeout)
          : undefined;
      pending.set(message.id, { resolve, reject, timer });
      try {
        send(message, transfer);
      } catch (error) {
        settle(message.id)?.reject(asError(error));
      }
    });
  }

  function removeSubscription(id: number): void {
    const subscription = subscriptions.get(id);
    subscriptions.delete(id);
    try {
      subscription?.stop?.();
    } catch (error) {
      report(error);
    }
  }

  function sendFailure(kind: 'error' | 'subscription-error', id: number, error: unknown): void {
    if (closed) return;
    const failure = asError(error);
    try {
      send({ kind, id, name: failure.name, message: failure.message });
    } catch (sendError) {
      report(sendError);
      disconnect();
    }
  }

  function shutdown(): void {
    if (closed) return;
    closed = true;
    port.removeEventListener('message', receive);
    port.removeEventListener('close', shutdown);
    port.removeEventListener('messageerror', disconnect);
    for (const id of pending.keys()) {
      settle(id)?.reject(rpcError('RpcDisconnectedError', 'RPC endpoint is closed'));
    }
    listeners.clear();
    for (const id of subscriptions.keys()) removeSubscription(id);
    services.clear();
    for (const listener of [...closeListeners]) {
      try {
        listener();
      } catch (error) {
        report(error);
      }
    }
    closeListeners.clear();
    errorListeners.clear();
  }

  function disconnect(): void {
    if (closed) return;
    try {
      send({ kind: 'close' });
    } catch (error) {
      report(error);
    }
    shutdown();
  }

  async function execute(message: Extract<RpcMessage, { kind: 'call' | 'listen' }>): Promise<void> {
    try {
      const registration = services.get(message.service);
      if (!registration) throw rpcError('ServiceNotFound', `Unknown service: ${message.service}`);
      const service = registration.implementation;
      const method = findMethod(service, message.member);
      if (message.kind === 'listen') {
        if (!/^onDid[A-Z]/.test(message.member)) {
          throw rpcError('InvalidSubscription', 'Event members must start with onDid');
        }
        const subscription: Subscription<TTransfer> = { registration, stop: undefined };
        subscriptions.set(message.id, subscription);
        const unsubscribe = method.call(service, (...args: unknown[]) => {
          if (closed || subscriptions.get(message.id) !== subscription) return;
          try {
            send(
              { kind: 'event', id: message.id, args },
              registration.options.transfer?.(message.member, args),
            );
          } catch (error) {
            removeSubscription(message.id);
            sendFailure('subscription-error', message.id, error);
          }
        });
        if (typeof unsubscribe !== 'function') {
          throw rpcError(
            'InvalidSubscription',
            'Event registration must return an unsubscribe function',
          );
        }
        subscription.stop = unsubscribe as () => void;
        if (subscriptions.get(message.id) !== subscription) subscription.stop();
        if (!closed) send({ kind: 'result', id: message.id, value: undefined });
      } else {
        if (/^onDid[A-Z]/.test(message.member))
          throw rpcError('InvalidCall', 'Event members require a subscription');
        const value = await method.apply(service, message.args);
        if (!closed)
          send(
            { kind: 'result', id: message.id, value },
            registration.options.transfer?.(message.member, value),
          );
      }
    } catch (error) {
      if (message.kind === 'listen') removeSubscription(message.id);
      sendFailure('error', message.id, error);
    }
  }

  function receive(event: Event): void {
    const message: unknown = (event as MessageEvent).data;
    if (!isRpcMessage(message)) {
      report(rpcError('RpcProtocolError', 'Malformed RPC message'));
      return;
    }
    switch (message.kind) {
      case 'call':
      case 'listen':
        if (message.id <= lastIncomingId) {
          report(rpcError('RpcProtocolError', 'Request IDs must increase'));
          return;
        }
        lastIncomingId = message.id;
        void execute(message);
        break;
      case 'unlisten':
        removeSubscription(message.id);
        break;
      case 'result':
        settle(message.id)?.resolve(message.value);
        break;
      case 'error':
        settle(message.id)?.reject(rpcError(message.name, message.message));
        break;
      case 'subscription-error': {
        const failure = rpcError(message.name, message.message);
        const active = listeners.delete(message.id);
        const entry = settle(message.id);
        if (entry) entry.reject(failure);
        else if (active) report(failure);
        break;
      }
      case 'event':
        try {
          listeners.get(message.id)?.(...message.args);
        } catch (error) {
          report(error);
        }
        break;
      case 'close':
        shutdown();
        break;
    }
  }

  port.addEventListener('message', receive);
  port.addEventListener('close', shutdown);
  port.addEventListener('messageerror', disconnect);
  port.start?.();

  return {
    register<T extends object>(
      serviceId: RpcServiceId<T>,
      implementation: T,
      registrationOptions = {},
    ) {
      ensureOpen();
      const name = validateServiceId(serviceId);
      if (implementation === null || typeof implementation !== 'object') {
        throw new TypeError('RPC services must be objects');
      }
      if (services.has(name)) throw new Error(`Service already registered: ${name}`);
      const registration: Registration<TTransfer> = {
        implementation,
        options: registrationOptions,
      };
      services.set(name, registration);
      return toDisposable(() => {
        if (services.get(name) !== registration) return;
        services.delete(name);
        for (const [id, subscription] of subscriptions) {
          if (subscription.registration === registration) {
            removeSubscription(id);
            sendFailure(
              'subscription-error',
              id,
              rpcError('ServiceUnregistered', `Service unregistered: ${name}`),
            );
          }
        }
      });
    },
    getProxy<T extends object>(
      serviceId: RpcServiceId<T>,
      proxyOptions: RpcProxyOptions<TTransfer> = {},
    ): RpcProxy<T> {
      const service = validateServiceId(serviceId);
      const timeout = validateTimeout(proxyOptions.timeoutMs ?? defaultTimeout);
      const members = new Map<string, Callable>();
      return new Proxy(Object.create(null), {
        get(_target, member) {
          if (typeof member !== 'string' || member === 'then') return undefined;
          if (!members.has(member)) {
            members.set(
              member,
              /^onDid[A-Z]/.test(member)
                ? (listener: unknown) => {
                    ensureOpen();
                    if (typeof listener !== 'function')
                      throw new TypeError('Expected an event listener');
                    const id = allocateId();
                    listeners.set(id, listener as Callable);
                    void request({ kind: 'listen', id, service, member, args: [] }, timeout).catch(
                      (error) => {
                        listeners.delete(id);
                        if (!closed) {
                          try {
                            send({ kind: 'unlisten', id });
                          } catch (sendError) {
                            report(sendError);
                          }
                        }
                        report(error);
                      },
                    );
                    const disposable = toDisposable(() => {
                      if (!listeners.delete(id)) return;
                      settle(id)?.resolve(undefined);
                      if (!closed) {
                        try {
                          send({ kind: 'unlisten', id });
                        } catch (error) {
                          report(error);
                        }
                      }
                    });
                    return () => disposable.dispose();
                  }
                : async (...args: unknown[]) => {
                    ensureOpen();
                    return request(
                      { kind: 'call', id: allocateId(), service, member, args },
                      timeout,
                      proxyOptions.transfer?.(member, args),
                    );
                  },
            );
          }
          return members.get(member);
        },
      }) as RpcProxy<T>;
    },
    onDidError(listener) {
      if (closed) return () => {};
      errorListeners.add(listener);
      return () => {
        errorListeners.delete(listener);
      };
    },
    onDidClose(listener) {
      if (closed) {
        listener();
        return () => {};
      }
      closeListeners.add(listener);
      return () => {
        closeListeners.delete(listener);
      };
    },
    dispose: disconnect,
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function validateServiceId(serviceId: RpcServiceId<object>): string {
  if (typeof serviceId !== 'string' || serviceId.length === 0)
    throw new TypeError('RPC service name must be nonempty');
  return serviceId;
}

function validateTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new RangeError('RPC timeout must be an integer between 0 and 2147483647');
  }
  return value;
}
