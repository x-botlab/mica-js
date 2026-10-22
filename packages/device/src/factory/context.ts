import type {
  BytesOutputRef,
  BytesRef,
  EntryRef,
  InboxRef,
  IRDeclarations,
  IRModule,
  OutputRef,
  ScalarArgs,
  ScalarType,
} from '@mica-js/ir';
import { DeviceError } from '../errors';
import type { MessagingController } from '../messaging/controller';
import type { DeviceAPI, DevicePropertySnapshot, TopicPayload } from '../types';

const DECLARATION_METHODS = new Set<PropertyKey>([
  'state',
  'array',
  'bytes',
  'inbox',
  'func',
  'entry',
  'lifecycle',
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
): FactoryContext {
  let open = true;
  const failClosed = (operation: string): never => {
    throw new DeviceError(
      'device/factory-closed',
      `Device ${JSON.stringify(deviceId)} factory attempted ${operation} after it returned.`,
      { deviceId },
    );
  };
  const ir = new Proxy(module, {
    get(target, property) {
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
        return Reflect.apply(method, target, args);
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
    ir: ir as unknown as IRDeclarations,
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
