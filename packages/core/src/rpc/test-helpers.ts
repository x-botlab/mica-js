import { defineRpcService } from './types';
import type { RpcServiceId } from './types';

/**
 * Wire name shared by tests that exercise several service shapes on one token.
 *
 * `defineRpcService` brands the token with its service type, which is what production code wants.
 * The wire protocol only cares about the name, so these tests reuse one name across shapes and cast
 * the brand away instead of declaring a token per shape.
 */
export function sharedService<T extends object = never>(name: string): RpcServiceId<T> {
  return defineRpcService<Record<string, (...args: never[]) => unknown>>(
    name,
  ) as unknown as RpcServiceId<T>;
}
