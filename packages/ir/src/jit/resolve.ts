/**
 * Static reference resolution for the JIT MIR (J5).
 *
 * Lowering replaces every `static` operand of a validated instruction with a
 * plain integer index. The meaning of that index depends on the operation;
 * see {@link LowerContext}. Reference objects themselves stay reachable
 * through {@link LowerContext.constants} so code generation never needs the
 * object graph at run time.
 *
 * Resolution only accepts `validateIR`-approved models: anything else is an
 * internal error and throws a plain `Error`.
 */
import type {
  IRModule,
  InstructionNode,
  MemoryDefinition,
  ProviderDefinition,
  OutputDefinition,
  StaticRef,
  FunctionDefinition,
  Terminator,
} from '../types';

export type LowerModel = Pick<
  IRModule,
  'memories' | 'functions' | 'providers' | 'outputs' | 'domainDeclarations' | 'instructions'
>;

/** Everything lowering needs to turn one model function into MIR. */
export interface LowerContext {
  /** Validated model snapshot; lists define the meaning of every resolved index. */
  readonly model: LowerModel;
  /** Executor table order; `Op.Executor` instructions resolve to an index here (-1 if absent). */
  readonly executors: readonly string[];
  /** Constant table shared by every function lowered from this context. */
  readonly constants: unknown[];
  /** Interning map for {@link constants}; also used for static references. */
  readonly constantIndices: Map<unknown, number>;
  readonly memoryIndices: ReadonlyMap<StaticRef, number>;
  readonly functionIndices: ReadonlyMap<StaticRef, number>;
  readonly providerIndices: ReadonlyMap<StaticRef, number>;
  readonly outputIndices: ReadonlyMap<StaticRef, number>;
  readonly executorIndices: ReadonlyMap<string, number>;
}

function indexBy<T>(items: readonly T[], key: (item: T) => StaticRef): Map<StaticRef, number> {
  const result = new Map<StaticRef, number>();
  items.forEach((item, index) => {
    result.set(key(item), index);
  });
  return result;
}

/**
 * Build the shared lowering context. `executors` fixes the executor-table
 * order that `Op.Executor.refs[0]` refers to; it must match the runtime table
 * used by the generated code.
 */
export function createLowerContext(
  model: LowerModel,
  executors: readonly string[] = [],
): LowerContext {
  const executorIndices = new Map<string, number>();
  executors.forEach((op, index) => {
    if (executorIndices.has(op)) {
      throw new Error(`MIR lowering failed: executor "${op}" is listed more than once`);
    }
    executorIndices.set(op, index);
  });
  return {
    model,
    executors: [...executors],
    constants: [],
    constantIndices: new Map<unknown, number>(),
    memoryIndices: indexBy<MemoryDefinition>(model.memories, (memory) => memory.ref),
    functionIndices: indexBy<FunctionDefinition>(model.functions, (fn) => fn.ref),
    providerIndices: indexBy<ProviderDefinition>(model.providers, (provider) => provider.ref),
    outputIndices: indexBy<OutputDefinition>(model.outputs, (output) => output.ref),
    executorIndices,
  };
}

/** Intern one compile-time constant (static ref, FloatBits object, trap code, ...). */
export function internConstant(ctx: LowerContext, value: unknown): number {
  const existing = ctx.constantIndices.get(value);
  if (existing !== undefined) return existing;
  const index = ctx.constants.length;
  ctx.constants.push(value);
  ctx.constantIndices.set(value, index);
  return index;
}

/** Read the `static` operand at `index`; the caller has already validated the shape. */
export function staticOperand(node: InstructionNode, index: number): StaticRef {
  const operand = node.operands[index];
  if (operand?.kind !== 'static') {
    throw new Error(`MIR lowering failed: ${node.op} operand ${index} must be a static reference`);
  }
  return operand.ref;
}

function resolved(map: ReadonlyMap<StaticRef, number>, ref: StaticRef, label: string): number {
  const index = map.get(ref);
  if (index === undefined) {
    throw new Error(`MIR lowering failed: ${label} is not declared by this module`);
  }
  return index;
}

/**
 * Resolve a `call` target to its model function index. The index follows the
 * snapshot's `functions` array, which is also the index of `rt.fns`.
 */
export function resolveCall(ctx: LowerContext, node: InstructionNode): number {
  if (node.op !== 'call') {
    throw new Error(`MIR lowering failed: ${node.op} is not a call instruction`);
  }
  return resolved(ctx.functionIndices, staticOperand(node, 0), `${node.op} target`);
}

/** Resolve a `checkpoint` provider reference to the model provider index. */
export function resolveCheckpoint(ctx: LowerContext, node: InstructionNode): number {
  if (node.op !== 'checkpoint') {
    throw new Error(`MIR lowering failed: ${node.op} is not a checkpoint instruction`);
  }
  return resolved(ctx.providerIndices, staticOperand(node, 0), 'checkpoint target');
}

/** Resolve a `dispatch` provider reference to the model provider index. */
export function resolveDispatch(ctx: LowerContext, provider: StaticRef): number {
  return resolved(ctx.providerIndices, provider, 'dispatch target');
}

/** Resolve an `event.at` entry reference to its model function index. */
export function resolveEntry(ctx: LowerContext, node: InstructionNode): number {
  if (node.op !== 'event.at') {
    throw new Error(`MIR lowering failed: ${node.op} is not an event.at instruction`);
  }
  const index = resolved(ctx.functionIndices, staticOperand(node, 0), 'event.at target');
  if (ctx.model.functions[index]?.category !== 'entry') {
    throw new Error('MIR lowering failed: event.at target is not an entry function');
  }
  return index;
}

/** Resolve a memory reference operand to the model `memories` index. */
export function resolveMemory(ctx: LowerContext, node: InstructionNode, index: number): number {
  return resolved(ctx.memoryIndices, staticOperand(node, index), `${node.op} resource`);
}

/** Resolve a bridge output reference operand to the model `outputs` index. */
export function resolveOutput(ctx: LowerContext, node: InstructionNode, index: number): number {
  const output = resolved(ctx.outputIndices, staticOperand(node, index), `${node.op} target`);
  const expected = node.op === 'bridge.send_bytes' ? 'bytes-output' : 'scalar-output';
  if (ctx.model.outputs[output]?.kind !== expected) {
    throw new Error(`MIR lowering failed: ${node.op} target must be a ${expected}`);
  }
  return output;
}

/**
 * Resolve a domain instruction to the captured executor table index.
 *
 * A missing executor is not a lowering failure: the reference interpreter only
 * reports `unsupported-instruction` when the instruction actually executes.
 * `-1` preserves that timing for generated code.
 */
export function resolveExecutor(ctx: LowerContext, op: string): number {
  return ctx.executorIndices.get(op) ?? -1;
}

/** Resolve the provider of a `dispatch` terminator. */
export function resolveDispatchTerminator(ctx: LowerContext, term: Terminator): number {
  if (term.kind !== 'dispatch') {
    throw new Error(`MIR lowering failed: ${term.kind} is not a dispatch terminator`);
  }
  return resolveDispatch(ctx, term.provider);
}

/** Intern the string code of a `trap` terminator; MIR keeps only the table index. */
export function resolveTrapCode(ctx: LowerContext, code: string): number {
  return internConstant(ctx, code);
}
