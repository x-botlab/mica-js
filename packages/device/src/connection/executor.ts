import { SchedulerError, type TopologyRuntime } from '@mica-js/core';
import type {
  IRInstructionExecution,
  IRInstructionExecutor,
  IRModule,
  StaticRef,
} from '@mica-js/ir';
import { DeviceError } from '../errors';
import type { DeviceConnectionDescriptor } from './types';

export interface ConnectionExecutionOptions {
  readonly module: IRModule;
  readonly description: ReadonlyMap<string, DeviceConnectionDescriptor>;
  readonly instanceId: string;
  readonly deviceId: string;
  readonly topology: TopologyRuntime | undefined;
}

/**
 * Verifies link-time connection grants and returns the executor for the declared
 * `connection.apply` instruction. Returns `undefined` when the program never applies a
 * connection. A program that applies connections without a topology is rejected.
 */
export function prepareConnectionExecution(
  options: ConnectionExecutionOptions,
): IRInstructionExecutor | undefined {
  const applied = collectAppliedConnections(options.module);
  if (applied.size === 0) {
    return undefined;
  }
  const topology = options.topology;
  if (topology === undefined) {
    throw new DeviceError(
      'device/connection-unavailable',
      `Device ${JSON.stringify(options.deviceId)} applies connections but no topology is bound.`,
      { deviceId: options.deviceId },
    );
  }
  const declarations = connectionDeclarations(options.module);
  for (const ref of applied) {
    const name = declarations.get(ref);
    if (name === undefined || !options.description.has(name)) {
      throw new DeviceError(
        'device/connection-unknown',
        `Device ${JSON.stringify(options.deviceId)} applies a connection that is not declared by this instance.`,
        { deviceId: options.deviceId },
      );
    }
    try {
      topology.connectionState(options.instanceId, name);
    } catch (cause) {
      throw new DeviceError(
        'device/connection-unknown',
        `Device ${JSON.stringify(options.deviceId)} connection ${JSON.stringify(name)} is not declared by the bound topology.`,
        { deviceId: options.deviceId, cause },
      );
    }
  }
  const names = declarations;
  return Object.freeze({
    op: 'connection.apply',
    execute(request: IRInstructionExecution): readonly [] {
      return apply(request, names, options);
    },
  });
}

function apply(
  request: IRInstructionExecution,
  names: ReadonlyMap<StaticRef, string>,
  options: ConnectionExecutionOptions,
): readonly [] {
  const { instruction, operands, context } = request;
  if (context.instanceId !== options.instanceId) {
    throw unavailable(options, 'the execution instance does not own this connection executor.');
  }
  const refs = instruction.operands[0];
  const values = instruction.operands[1];
  if (
    refs?.kind !== 'static-list' ||
    values?.kind !== 'ssa-list' ||
    refs.refs.length !== values.values.length ||
    operands.length !== refs.refs.length
  ) {
    throw invalid(options, 'connection.apply operands do not describe one complete patch.');
  }
  const connections: { readonly connectionId: string; readonly state: 'open' | 'closed' }[] = [];
  for (let index = 0; index < refs.refs.length; index += 1) {
    const name = names.get(refs.refs[index]!);
    if (name === undefined) {
      throw new DeviceError(
        'device/connection-unknown',
        `Device ${JSON.stringify(options.deviceId)} connection.apply references an unknown connection.`,
        { deviceId: options.deviceId },
      );
    }
    const closed = operands[index];
    if (typeof closed !== 'boolean') {
      throw invalid(options, `connection.apply value ${index} is not a bool.`);
    }
    connections.push({ connectionId: name, state: closed ? 'closed' : 'open' });
  }
  try {
    options.topology!.submit({ instanceId: options.instanceId, connections });
  } catch (cause) {
    if (cause instanceof DeviceError) {
      throw cause;
    }
    if (cause instanceof RangeError) {
      throw new DeviceError(
        'device/connection-unknown',
        `Device ${JSON.stringify(options.deviceId)} connection patch was rejected by the topology: ${errorMessage(cause)}`,
        { deviceId: options.deviceId, cause },
      );
    }
    throw unavailable(
      options,
      cause instanceof SchedulerError
        ? 'the bound topology is unavailable.'
        : `the topology rejected the patch: ${errorMessage(cause)}`,
      cause,
    );
  }
  return [];
}

function collectAppliedConnections(module: IRModule): ReadonlySet<StaticRef> {
  const refs = new Set<StaticRef>();
  for (const fn of module.functions) {
    for (const block of fn.body?.blocks ?? []) {
      for (const node of block.instructions) {
        if (node.op !== 'connection.apply') continue;
        const operand = node.operands[0];
        if (operand?.kind === 'static-list') {
          for (const ref of operand.refs) refs.add(ref);
        }
      }
    }
  }
  return refs;
}

function connectionDeclarations(module: IRModule): ReadonlyMap<StaticRef, string> {
  const declarations = new Map<StaticRef, string>();
  for (const declaration of module.domainDeclarations) {
    if (declaration.kind === 'connection') {
      declarations.set(declaration.ref, declaration.name);
    }
  }
  return declarations;
}

function invalid(options: ConnectionExecutionOptions, message: string): DeviceError {
  return new DeviceError(
    'device/connection-invalid',
    `Device ${JSON.stringify(options.deviceId)} ${message}`,
    { deviceId: options.deviceId },
  );
}

function unavailable(
  options: ConnectionExecutionOptions,
  message: string,
  cause?: unknown,
): DeviceError {
  return new DeviceError(
    'device/connection-unavailable',
    `Device ${JSON.stringify(options.deviceId)} ${message}`,
    { deviceId: options.deviceId, ...(cause === undefined ? {} : { cause }) },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
