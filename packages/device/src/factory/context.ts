import type {
  BytesOutputRef,
  BytesRef,
  EntryRef,
  InboxRef,
  IRModule,
  OutputRef,
  ScalarArgs,
  ScalarType,
} from '@mica-js/ir';
import { createConnectionSupport } from '../connection/builder';
import type { DeviceConnectionDescriptor } from '../connection/types';
import { DeviceError } from '../errors';
import type { MessagingController } from '../messaging/controller';
import type { ObserveDomain } from '../observe/domain';
import type { PinDomain } from '../pins/domain';
import type {
  DeviceAPI,
  DeviceIRDeclarations,
  DevicePropertySnapshot,
  ObserverRef,
  PinRef,
  TopicPayload,
} from '../types';
import type { FifoDomain } from '../topic/fifo';

const DECLARATION_METHODS = new Set<PropertyKey>([
  'state',
  'array',
  'bytes',
  'inbox',
  'func',
  'entry',
  'lifecycle',
  'provider',
  'output',
  'outputBytes',
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
  messaging: MessagingController,
  pins: PinDomain,
  observes: ObserveDomain,
  connections: ReadonlyMap<string, DeviceConnectionDescriptor>,
  fifos: FifoDomain,
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
      if (property === 'pin') {
        return (id: unknown): PinRef => {
          if (!open) {
            return failClosed('pin');
          }
          return pins.catalog.declare(module, id, deviceId);
        };
      }
      if (property === 'observeDigital') {
        return (...args: unknown[]): ObserverRef => {
          if (!open) {
            return failClosed('observeDigital');
          }
          return observes.declare(module, args[0], args[1]);
        };
      }
      if (property === 'connection') {
        return (...args: unknown[]): unknown => {
          if (!open) {
            return failClosed(property);
          }
          return connectionSupport.declare(args[0]);
        };
      }
      if (property === 'fifo') {
        return (name: unknown, descriptor: unknown): unknown => {
          if (!open) {
            return failClosed('fifo');
          }
          return fifos.declare(module, name, descriptor);
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
        const result = Reflect.apply(
          method,
          target,
          property === 'bytes' ? captureBytesArgs(args, deviceId) : args,
        );
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
    subscribe: (port: string, callback: unknown) => messaging.subscribe(port, callback),
    publish: (port: string, payload: TopicPayload) => messaging.publish(port, payload),
    post: <P extends readonly ScalarType[]>(entry: EntryRef<P>, args: ScalarArgs<P>) =>
      messaging.post(entry, args),
    postBytes: (entry: EntryRef<readonly ['u32', 'u32']>, inbox: InboxRef, bytes: Uint8Array) =>
      messaging.postBytes(entry, inbox, bytes),
    onOutput: ((output: OutputRef | BytesOutputRef, callback: unknown) =>
      messaging.onOutput(output, callback)) as DeviceAPI['onOutput'],
    updateBytes: (resource: BytesRef, offset: number, bytes: Uint8Array) =>
      messaging.updateBytes(resource, offset, bytes),
  });
  return {
    api,
    close() {
      open = false;
      messaging.closeRegistrations();
    },
  };
}

/**
 * RFC 0017 declares a byte memory by length (`api.ir.bytes(name, length)`); the IR declaration
 * takes initial bytes and options, so the capacity form becomes a zero-filled writable memory.
 */
function captureBytesArgs(args: readonly unknown[], deviceId: string): readonly unknown[] {
  const [name, initialOrLength] = args;
  if (typeof initialOrLength !== 'number') {
    return args;
  }
  if (!Number.isSafeInteger(initialOrLength) || initialOrLength < 0) {
    throw new DeviceError(
      'schema/invalid-value',
      `Device ${JSON.stringify(deviceId)} bytes ${JSON.stringify(String(name))} length must be a non-negative safe integer.`,
      { deviceId },
    );
  }
  return [name, new Uint8Array(initialOrLength), { readonly: false }];
}
