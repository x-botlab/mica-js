import { IRConstructionError } from '@mica-js/ir';
import type { DomainInstruction, FunctionBuilder, IRModule, StaticRef, Value } from '@mica-js/ir';
import { DeviceError } from '../errors';
import { isPlainRecord } from '../internal/records';
import type { ConnectionOperations, ConnectionRef, DeviceConnectionDescriptor } from './types';

const APPLY_DEFINITION = {
  operands: [
    { kind: 'static-list', category: 'connection', minLength: 1 },
    { kind: 'value-list', type: 'bool', minLength: 1 },
  ],
  results: [],
} as const;

type ApplyInstruction = DomainInstruction<(typeof APPLY_DEFINITION)['operands'], readonly []>;

const PATCH_FIELDS = new Set(['connection', 'closed']);

/** Instance-scoped author surface for declared connections. */
export interface ConnectionSupport {
  /** Resolve one connection declared by the description; repeated calls share the same handle. */
  declare(id: unknown): ConnectionRef;
  /** Wrap a function declaration so every body (including nested blocks) gets `b.connection`. */
  decorateFunctionRef(ref: object): void;
  /** Install the `connection` operation group on one builder. */
  decorateBuilder(builder: FunctionBuilder): void;
}

export function createConnectionSupport(
  module: IRModule,
  description: ReadonlyMap<string, DeviceConnectionDescriptor>,
  deviceId: string,
): ConnectionSupport {
  const declarations = new Map<string, ConnectionRef>();
  const decoratedRefs = new WeakSet<object>();
  const decoratedBuilders = new WeakSet<FunctionBuilder>();
  let applyInstruction: ApplyInstruction | undefined;

  const instruction = (): ApplyInstruction => {
    applyInstruction ??= module.domainInstruction('connection.apply', APPLY_DEFINITION);
    return applyInstruction;
  };

  const declare = (id: unknown): ConnectionRef => {
    if (typeof id !== 'string' || id.length === 0) {
      throw connectionError(deviceId, 'connection id must be a non-empty string.');
    }
    const existing = declarations.get(id);
    if (existing !== undefined) {
      return existing;
    }
    if (!description.has(id)) {
      throw new DeviceError(
        'device/connection-unknown',
        `Device ${JSON.stringify(deviceId)} connection ${JSON.stringify(id)} is not declared.`,
        { deviceId },
      );
    }
    let ref: StaticRef<'connection'>;
    try {
      ref = module.domainDeclaration('connection', id);
    } catch (cause) {
      throw connectionError(
        deviceId,
        `connection ${JSON.stringify(id)} could not be declared.`,
        cause,
      );
    }
    const connection = ref as ConnectionRef;
    declarations.set(id, connection);
    return connection;
  };

  const apply = (
    builder: FunctionBuilder,
    patch: readonly {
      readonly connection: ConnectionRef;
      readonly closed: Value<'bool'>;
    }[],
  ): undefined => {
    if (!Array.isArray(patch) || patch.length === 0) {
      throw connectionError(deviceId, 'connection.apply requires at least one entry.');
    }
    const refs: ConnectionRef[] = [];
    const closed: Value<'bool'>[] = [];
    const seen = new Set<StaticRef>();
    for (let index = 0; index < patch.length; index += 1) {
      const entry: unknown = patch[index];
      if (!isPlainRecord(entry)) {
        throw connectionError(deviceId, `connection.apply entry ${index} must be an object.`);
      }
      for (const field of Object.keys(entry)) {
        if (!PATCH_FIELDS.has(field)) {
          throw connectionError(
            deviceId,
            `connection.apply entry ${index} has unknown field ${JSON.stringify(field)}.`,
          );
        }
      }
      const connection = entry['connection'];
      const state = entry['closed'];
      if (typeof connection !== 'object' || connection === null) {
        throw connectionError(
          deviceId,
          `connection.apply entry ${index} must reference a connection.`,
        );
      }
      if (typeof state !== 'object' || state === null) {
        throw connectionError(
          deviceId,
          `connection.apply entry ${index} closed must be a bool SSA value.`,
        );
      }
      const ref = connection as ConnectionRef;
      if (seen.has(ref)) {
        throw connectionError(
          deviceId,
          `connection.apply entry ${index} repeats a connection in one patch.`,
        );
      }
      seen.add(ref);
      refs.push(ref);
      closed.push(state as Value<'bool'>);
    }
    try {
      builder.invoke(instruction(), [refs, closed]);
    } catch (cause) {
      if (cause instanceof DeviceError) {
        throw cause;
      }
      throw connectionError(
        deviceId,
        `connection.apply was rejected: ${errorMessage(cause)}`,
        cause,
      );
    }
    return undefined;
  };

  const decorateBuilder = (builder: FunctionBuilder): void => {
    if (decoratedBuilders.has(builder)) {
      return;
    }
    decoratedBuilders.add(builder);
    const operations: ConnectionOperations = Object.freeze({
      apply: (patch: Parameters<ConnectionOperations['apply']>[0]) => apply(builder, patch),
    });
    Object.defineProperty(builder, 'connection', {
      value: operations,
      enumerable: true,
      configurable: false,
      writable: false,
    });
    const originalAt = builder.at;
    Object.defineProperty(builder, 'at', {
      value: (ref: unknown, callback: unknown) =>
        Reflect.apply(originalAt, builder, [
          ref,
          (nested: FunctionBuilder, params: readonly Value[]) => {
            decorateBuilder(nested);
            return Reflect.apply(callback as (...args: unknown[]) => unknown, undefined, [
              nested,
              params,
            ]);
          },
        ]),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  };

  const decorateFunctionRef = (ref: object): void => {
    if (decoratedRefs.has(ref)) {
      return;
    }
    decoratedRefs.add(ref);
    const originalBody = (ref as { body: (...args: unknown[]) => unknown }).body;
    Object.defineProperty(ref, 'body', {
      value: (callback: unknown) =>
        Reflect.apply(originalBody, ref, [
          (builder: FunctionBuilder, params: readonly Value[]) => {
            decorateBuilder(builder);
            return Reflect.apply(callback as (...args: unknown[]) => unknown, undefined, [
              builder,
              params,
            ]);
          },
        ]),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  };

  return Object.freeze({ declare, decorateFunctionRef, decorateBuilder });
}

function connectionError(deviceId: string, message: string, cause?: unknown): DeviceError {
  return new DeviceError(
    'device/connection-invalid',
    `Device ${JSON.stringify(deviceId)} ${message}`,
    { deviceId, ...(cause === undefined ? {} : { cause }) },
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof IRConstructionError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
