import type { IRModule } from '@mica-js/ir';
import { createConnectionSupport } from '../connection/builder';
import type { DeviceConnectionDescriptor, DeviceIRDeclarations } from '../connection/types';
import { DeviceError } from '../errors';
import type { DeviceAPI, DevicePropertySnapshot } from '../types';

const DECLARATION_METHODS = new Set<PropertyKey>([
  'state',
  'array',
  'bytes',
  'inbox',
  'func',
  'entry',
  'lifecycle',
]);

/** A factory context plus the kernel-side seal used after the factory returns or throws. */
export interface FactoryContext {
  readonly api: DeviceAPI;
  close(): void;
}

/**
 * Builds the instance-level context. `api.ir` is a restricted proxy over the real IR module:
 * only the declaration methods are visible, and every call fails once the factory has returned.
 */
export function createFactoryContext(
  props: DevicePropertySnapshot,
  module: IRModule,
  deviceId: string,
  connections: ReadonlyMap<string, DeviceConnectionDescriptor>,
): FactoryContext {
  let open = true;
  const failClosed = (operation: string): never => {
    throw new DeviceError(
      'device/factory-closed',
      `Device ${JSON.stringify(deviceId)} factory attempted ${operation} after it returned.`,
      { deviceId },
    );
  };
  const connectionSupport = createConnectionSupport(module, connections, deviceId);
  const ir = new Proxy(module, {
    get(target, property) {
      if (property === 'connection') {
        return (...args: unknown[]): unknown => {
          if (!open) {
            return failClosed(property);
          }
          return connectionSupport.declare(args[0]);
        };
      }
      if (typeof property !== 'string' || !DECLARATION_METHODS.has(property)) {
        return undefined;
      }
      const method: unknown = Reflect.get(target, property, target);
      if (typeof method !== 'function') {
        return undefined;
      }
      return (...args: unknown[]): unknown => {
        if (!open) {
          return failClosed(property);
        }
        const result = Reflect.apply(method, target, args);
        if (
          (property === 'func' || property === 'entry' || property === 'lifecycle') &&
          typeof result === 'object' &&
          result !== null
        ) {
          connectionSupport.decorateFunctionRef(result);
        }
        return result;
      };
    },
    set(_target, property) {
      throw new TypeError(`Device factory context is read-only (${String(property)}).`);
    },
    defineProperty(_target, property) {
      throw new TypeError(`Device factory context is read-only (${String(property)}).`);
    },
    deleteProperty(_target, property) {
      throw new TypeError(`Device factory context is read-only (${String(property)}).`);
    },
    ownKeys() {
      return [];
    },
  });
  const api: DeviceAPI = Object.freeze({
    props,
    ir: ir as unknown as DeviceIRDeclarations,
  });
  return {
    api,
    close() {
      open = false;
    },
  };
}
