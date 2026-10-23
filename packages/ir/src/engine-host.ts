import type { CapturedExecutor, EngineSetup, Target } from './engine-setup';
import { IRProviderError } from './errors';
import { evaluateFloatInstruction } from './float';
import { toNumber } from './float-ieee';
import { IRExecutionError } from './interpreter';
import type { IRExecutionContext, IRExecutionLocation } from './interpreter';
import type { ProviderArtifact } from './provider';
import { isFloatType } from './runtime';
import { evaluateScalarInstruction } from './scalar';
import type { IRStorage } from './storage';
import { IRStorageError } from './storage';
import type {
  ArrayRef,
  BlockDefinition,
  BytesOutputRef,
  BytesRef,
  Endian,
  EntryRef,
  FunctionDefinition,
  InstructionNode,
  NumericType,
  OutputRef,
  ProviderRef,
  ReadableBytesRef,
  RuntimeScalar,
  ScalarType,
  StateRef,
  StaticRef,
  Value,
  WritableBytesRef,
} from './types';

/**
 * Capture one host or literal value into the exact SSA representation of `type`. Every value that
 * crosses into SSA — arguments, executor results, event times, bridge results — uses this.
 */
export function captureArgument(type: ScalarType, value: RuntimeScalar): RuntimeScalar {
  const input = { type } as Value;
  const node: InstructionNode = {
    op: 'select',
    operands: [
      { kind: 'ssa', value: { type: 'bool' } as Value<'bool'> },
      { kind: 'ssa', value: input },
      { kind: 'ssa', value: input },
    ],
    results: [input],
  };
  const result = usesFloat(node)
    ? evaluateFloatInstruction(node, [true, value, value])
    : evaluateScalarInstruction(node, [true, value, value] as readonly (boolean | number)[]);
  return typeof result === 'object'
    ? Object.freeze({ type: result.type, bits: result.bits })
    : result;
}

export function eventTime(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new TypeError('Event time must be a finite integer number of picoseconds');
  }
  if (value < 0 || value > 7_200_000_000_000_000) {
    throw new RangeError('Event time is outside [0, 7_200_000_000_000_000]');
  }
  return value === 0 ? 0 : value;
}

export function eventId(value: unknown, allowZero: boolean): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError('Event ID must be a u32 integer');
  }
  if (value < (allowZero ? 0 : 1) || value > 0xffffffff) {
    throw new RangeError('Event ID is outside its u32 range');
  }
  return value === 0 ? 0 : value;
}

export function sameResultTypes(a: readonly ScalarType[], b: readonly ScalarType[]): boolean {
  return a.length === b.length && a.every((type, index) => type === b[index]);
}

/** Pre-execution validation: frozen context plus captured arguments. */
export function prepareExecution(
  setup: EngineSetup,
  target: Target,
  args: readonly RuntimeScalar[],
  context: IRExecutionContext,
): { fn: FunctionDefinition; context: IRExecutionContext; inputs: RuntimeScalar[] } {
  const fn = setup.functions.get(target);
  if (fn === undefined) {
    throw new IRExecutionError('invalid-target', 'Target does not belong to this interpreter');
  }
  if (
    context === null ||
    typeof context !== 'object' ||
    typeof context.instanceId !== 'string' ||
    context.instanceId.length === 0 ||
    !Number.isSafeInteger(context.virtualTime) ||
    context.virtualTime < 0
  ) {
    throw new IRExecutionError(
      'invalid-argument',
      'Expected instanceId and non-negative safe integer virtualTime',
    );
  }
  const capturedContext = Object.freeze({
    instanceId: context.instanceId,
    virtualTime: context.virtualTime === 0 ? 0 : context.virtualTime,
  });
  let inputs: RuntimeScalar[];
  try {
    if (!Array.isArray(args) || args.length !== fn.params.length) {
      throw new Error('Arguments must match the target signature');
    }
    inputs = fn.params.map((type, index) => captureArgument(type, args[index]!));
  } catch (cause) {
    throw new IRExecutionError('invalid-argument', 'Invalid execution arguments', {
      context: capturedContext,
      cause,
    });
  }
  return { fn, context: capturedContext, inputs };
}

export function invokeExecutor(
  executor: CapturedExecutor,
  node: InstructionNode,
  operands: readonly RuntimeScalar[],
  context: IRExecutionContext,
): readonly RuntimeScalar[] {
  const result: unknown = executor.execute(
    Object.freeze({
      instruction: node,
      operands: Object.freeze([...operands]),
      context,
    }),
  );
  if (result === null || typeof result !== 'object') {
    throw new TypeError(`Executor "${executor.op}" must return an array of scalar values`);
  }
  if (!Array.isArray(result) || result.length !== node.results.length) {
    throw new TypeError(
      `Executor "${executor.op}" must return ${node.results.length} result value(s)`,
    );
  }
  return result.map((value, index) =>
    captureArgument(node.results[index]!.type, value as RuntimeScalar),
  );
}

export function invokeEvent(
  setup: EngineSetup,
  node: InstructionNode,
  operands: readonly RuntimeScalar[],
): readonly RuntimeScalar[] {
  const host = setup.eventHost!;
  switch (node.op) {
    case 'event.now':
      return [captureArgument('f64', eventTime(host.now()))];
    case 'event.at': {
      const target = reference(node, 0) as EntryRef;
      const fn = setup.functions.get(target)!;
      const captured = Object.freeze(
        fn.params.map((type, index) => captureArgument(type, operands[index + 1]!)),
      );
      const raw = captureArgument('f64', operands[0]!);
      const deadline = eventTime(typeof raw === 'object' ? toNumber(raw) : raw);
      if (deadline < eventTime(host.now())) {
        throw new RangeError('Event deadline cannot be before host.now()');
      }
      return [eventId(host.at(target, deadline, captured), false)];
    }
    case 'event.cancel':
      host.cancel(eventId(operands[0], true));
      return [];
    default:
      throw new Error('Expected a core event instruction');
  }
}

export function invokeOutput(
  setup: EngineSetup,
  node: InstructionNode,
  operands: readonly RuntimeScalar[],
  context: IRExecutionContext,
): readonly RuntimeScalar[] {
  const host = setup.bridge!;
  const ref = reference(node, 0);
  const definition = setup.outputs.get(ref);
  if (definition === undefined) {
    throw new Error('Bridge output is not declared in this module');
  }
  if (node.op === 'bridge.send') {
    if (definition.kind !== 'scalar-output') {
      throw new Error('bridge.send requires a scalar output');
    }
    if (operands.length !== definition.params.length) {
      throw new Error('bridge.send arguments do not match its output signature');
    }
    const payload = operands.map((value, index) => {
      const type = definition.params[index]!;
      return type === 'f32' || type === 'f64'
        ? typeof value === 'object'
          ? toNumber(value)
          : value
        : (value as boolean | number);
    });
    return [
      captureArgument(
        'bool',
        host.send(ref as OutputRef, Object.freeze(payload), context.virtualTime),
      ),
    ];
  }
  if (definition.kind !== 'bytes-output') {
    throw new Error('bridge.send_bytes requires a bytes output');
  }
  const length = operands[1] as number;
  if (length > definition.maxBytes) {
    throw new RangeError(
      `bridge.send_bytes length ${length} exceeds maxBytes ${definition.maxBytes}`,
    );
  }
  const bytes = setup.storage.readVersionedBytes(
    reference(node, 1) as ReadableBytesRef,
    operands[0] as number,
    length,
  ).bytes;
  return [
    captureArgument('bool', host.sendBytes(ref as BytesOutputRef, bytes, context.virtualTime)),
  ];
}

/** Storage and scalar core instructions; the caller has already excluded events and bridge. */
export function evaluateStorageOrScalar(
  node: InstructionNode,
  operands: readonly RuntimeScalar[],
  storage: IRStorage,
): readonly RuntimeScalar[] {
  switch (node.op) {
    case 'state.load':
      return [storage.loadState(reference(node, 0) as StateRef)];
    case 'state.store':
      storage.storeState(reference(node, 0) as StateRef, operands[0]!);
      return [];
    case 'array.load':
      return [storage.loadArray(reference(node, 0) as ArrayRef, operands[0] as number)];
    case 'array.store':
      storage.storeArray(reference(node, 0) as ArrayRef, operands[0] as number, operands[1]!);
      return [];
    case 'bytes.load':
      return [
        storage.loadBytes(
          literal(node, 0) as NumericType,
          literal(node, 1) as Endian,
          reference(node, 2) as ReadableBytesRef,
          operands[0] as number,
        ),
      ];
    case 'bytes.store':
      storage.storeBytes(
        literal(node, 0) as NumericType,
        literal(node, 1) as Endian,
        reference(node, 2) as WritableBytesRef,
        operands[0] as number,
        operands[1]!,
      );
      return [];
    case 'resource.fill_bytes':
      storage.fillBytes(
        reference(node, 0) as BytesRef,
        operands[0] as number,
        operands[1] as number,
        operands[2] as number,
      );
      return [];
    case 'resource.update_bytes':
      storage.updateBytes(
        reference(node, 0) as BytesRef,
        operands[0] as number,
        reference(node, 2) as ReadableBytesRef,
        operands[1] as number,
        operands[2] as number,
      );
      return [];
    case 'bytes.copy':
      storage.copy(
        reference(node, 0) as WritableBytesRef,
        operands[0] as number,
        reference(node, 2) as ReadableBytesRef,
        operands[1] as number,
        operands[2] as number,
      );
      return [];
    default:
      return [
        usesFloat(node)
          ? evaluateFloatInstruction(node, operands)
          : evaluateScalarInstruction(node, operands as readonly (boolean | number)[]),
      ];
  }
}

/** Checkpoint invalidation recovery: materialize, verify, then capture the new frame inputs. */
export function recoverCheckpoint(
  setup: EngineSetup,
  current: FunctionDefinition,
  provider: ProviderRef,
  key: readonly RuntimeScalar[],
  args: readonly RuntimeScalar[],
): { artifact: ProviderArtifact; inputs: RuntimeScalar[] } {
  const artifact = setup.providers.materialize(provider, [...key]);
  if (!setup.storage.validateDependencies(artifact.dependencies)) {
    throw new IRProviderError(
      'recovery-failed',
      `Recovery target for checkpoint in "${current.name}" still has stale dependencies`,
    );
  }
  if (!sameResultTypes(artifact.fn.results, current.results)) {
    throw new IRProviderError(
      'recovery-failed',
      `Recovery target for checkpoint in "${current.name}" has a different result layout`,
    );
  }
  const inputs = artifact.fn.params.map((type, index) => captureArgument(type, args[index]!));
  return { artifact, inputs };
}

/** Unified error wrapping; `callStack` runs outermost first. */
export function wrapExecutionError(
  cause: unknown,
  context: IRExecutionContext,
  callStack: readonly IRExecutionLocation[],
  steps: number,
): IRExecutionError {
  const code =
    cause instanceof IRExecutionError
      ? cause.code
      : cause instanceof IRProviderError
        ? 'provider-failed'
        : cause instanceof IRStorageError
          ? 'storage-failed'
          : 'evaluation-failed';
  return new IRExecutionError(
    code,
    cause instanceof Error ? cause.message : 'IR execution failed',
    {
      context,
      ...(callStack.length > 0 ? { location: callStack[callStack.length - 1]! } : {}),
      callStack,
      steps,
      ...(cause instanceof IRProviderError && cause.diagnostics.length > 0
        ? { diagnostics: cause.diagnostics }
        : {}),
      cause,
    },
  );
}

export function makeLocation(
  functionIndex: number,
  fn: FunctionDefinition,
  blockIndex: number,
  block: BlockDefinition,
  instructionIndex: number | undefined,
): IRExecutionLocation {
  return Object.freeze({
    functionIndex,
    functionName: fn.name,
    blockIndex,
    blockId: block.id,
    ...(instructionIndex === undefined ? { terminator: true as const } : { instructionIndex }),
  });
}

export function reference(node: InstructionNode, index: number): StaticRef {
  const operand = node.operands[index]!;
  if (operand.kind !== 'static') throw new Error('Expected a validated static operand');
  return operand.ref;
}

function literal(node: InstructionNode, index: number): boolean | number | string {
  const operand = node.operands[index]!;
  if (operand.kind !== 'literal') throw new Error('Expected a validated literal operand');
  return operand.value;
}

function usesFloat(node: InstructionNode): boolean {
  return (
    node.results.some((value) => isFloatType(value.type)) ||
    node.operands.some((operand) => operand.kind === 'ssa' && isFloatType(operand.value.type))
  );
}
