import type { EngineSetup } from './engine-setup';
import { prepareEngine } from './engine-setup';
import {
  captureArgument,
  evaluateStorageOrScalar,
  invokeEvent,
  invokeExecutor,
  invokeOutput,
  makeLocation,
  prepareExecution,
  recoverCheckpoint,
  reference,
  wrapExecutionError,
} from './engine-host';
import { IRProviderError } from './errors';
import type { ProviderArtifact } from './provider';
import type { IRStorage } from './storage';
import type {
  BlockDefinition,
  BytesOutputRef,
  EntryRef,
  FunctionDefinition,
  FunctionRef,
  InstructionNode,
  IRModule,
  LifecycleRef,
  OutputRef,
  ProviderRef,
  RuntimeScalar,
  Value,
} from './types';
import type { IRDiagnostic, IRValidationOptions } from './validation-types';

type Target = FunctionRef | EntryRef | LifecycleRef;

export interface IREventHost {
  now(): number;
  at(target: EntryRef, deadline: number, args: readonly RuntimeScalar[]): number;
  cancel(id: number): void;
}

export interface IRStepObserver {
  beforeStep(context: IRExecutionContext): void;
}

/**
 * Batch step-accounting protocol. The host must guarantee:
 * - `consume(ctx, n)` is equivalent to `n` consecutive `consume(ctx, 1)` calls for a positive
 *   safe integer `n`;
 * - `remaining(ctx)` never over-reports: when it returns `r`, the next `r` consecutive
 *   `consume(ctx, 1)` calls all succeed;
 * - neither method reads or writes IR storage, and neither re-enters `execute`.
 *
 * An engine may merge several steps into one `consume` call and may call `remaining` at any time.
 */
export interface IRStepBudget {
  remaining(context: IRExecutionContext): number;
  consume(context: IRExecutionContext, steps: number): void;
}

/**
 * Host-side sink for the explicit `bridge.send` / `bridge.send_bytes` instructions.
 * Calls happen at the instruction, after the payload and virtual time are captured;
 * the host owns bounded queues and returns `false` when they are full.
 */
export interface IRBridgeHost {
  send(output: OutputRef, payload: readonly (boolean | number)[], timePs: number): boolean;
  sendBytes(output: BytesOutputRef, bytes: Uint8Array, timePs: number): boolean;
}

/** One validated domain instruction presented to its trusted executor. */
export interface IRInstructionExecution {
  readonly instruction: InstructionNode;
  /** Resolved SSA operands in node operand order; list operands are flattened. */
  readonly operands: readonly RuntimeScalar[];
  readonly context: IRExecutionContext;
}

/**
 * Trusted synchronous executor for one declared domain instruction. Returning values must match
 * the instruction's declared result types; `void` instructions return an empty array.
 */
export interface IRInstructionExecutor {
  readonly op: string;
  execute(request: IRInstructionExecution): readonly RuntimeScalar[];
}

export interface IRInterpreterOptions {
  readonly validation: IRValidationOptions;
  readonly maxSteps?: number;
  readonly eventHost?: IREventHost;
  readonly stepObserver?: IRStepObserver;
  readonly stepBudget?: IRStepBudget;
  readonly bridge?: IRBridgeHost;
  readonly executors?: readonly IRInstructionExecutor[];
}

export interface IRExecutionContext {
  readonly instanceId: string;
  readonly virtualTime: number;
}

export interface IRExecutionResult {
  readonly values: readonly RuntimeScalar[];
  readonly steps: number;
}

export interface IRInterpreter {
  readonly storage: IRStorage;
  execute(
    target: Target,
    args: readonly RuntimeScalar[],
    context: IRExecutionContext,
  ): IRExecutionResult;
}

export type IRExecutionErrorCode =
  | 'invalid-options'
  | 'validation-failed'
  | 'invalid-target'
  | 'invalid-argument'
  | 'budget-exhausted'
  | 'trap'
  | 'evaluation-failed'
  | 'storage-failed'
  | 'unsupported-instruction'
  | 'instance-faulted'
  | 'provider-failed';

export interface IRExecutionLocation {
  readonly functionIndex: number;
  readonly functionName: string;
  readonly blockIndex: number;
  readonly blockId: number;
  readonly instructionIndex?: number;
  readonly terminator?: true;
}

export interface IRExecutionErrorDetails {
  readonly context?: IRExecutionContext;
  readonly location?: IRExecutionLocation;
  readonly callStack?: readonly IRExecutionLocation[];
  readonly steps?: number;
  readonly diagnostics?: readonly IRDiagnostic[];
  readonly cause?: unknown;
}

export class IRExecutionError extends Error {
  override readonly name = 'IRExecutionError';
  readonly context: IRExecutionContext | undefined;
  readonly location: IRExecutionLocation | undefined;
  readonly callStack: readonly IRExecutionLocation[];
  readonly steps: number;
  readonly diagnostics: readonly IRDiagnostic[];
  override readonly cause: unknown;

  constructor(
    readonly code: IRExecutionErrorCode,
    message: string,
    details: IRExecutionErrorDetails = {},
  ) {
    super(message, { cause: details.cause });
    this.context = details.context;
    this.location = details.location;
    this.callStack = details.callStack ?? [];
    this.steps = details.steps ?? 0;
    this.diagnostics = details.diagnostics ?? [];
    this.cause = details.cause;
  }
}

interface Frame {
  readonly fn: FunctionDefinition;
  readonly functionIndex: number;
  readonly values: Map<Value, RuntimeScalar>;
  /** Present only for provider artifact frames; `checkpoint` checks this dependency set. */
  readonly artifact?: ProviderArtifact;
  block: BlockDefinition;
  position: number;
}

export function createIRInterpreter(
  module: IRModule,
  options: IRInterpreterOptions,
): IRInterpreter {
  return new Interpreter(prepareEngine(module, options));
}

class Interpreter implements IRInterpreter {
  readonly #setup: EngineSetup;
  readonly storage: IRStorage;
  #faulted = false;

  constructor(setup: EngineSetup) {
    this.#setup = setup;
    this.storage = setup.storage;
    Object.freeze(this);
  }

  execute(
    target: Target,
    args: readonly RuntimeScalar[],
    context: IRExecutionContext,
  ): IRExecutionResult {
    if (this.#faulted) {
      throw new IRExecutionError(
        'instance-faulted',
        'The interpreter faulted; rebuild the instance',
      );
    }
    const {
      fn,
      context: capturedContext,
      inputs,
    } = prepareExecution(this.#setup, target, args, context);
    const frames = [this.frame(fn, inputs)];
    let steps = 0;
    try {
      while (frames.length > 0) {
        const frame = frames[frames.length - 1]!;
        if (steps >= this.#setup.maxSteps) {
          throw new IRExecutionError(
            'budget-exhausted',
            `Execution exceeded ${this.#setup.maxSteps} reference IR steps`,
          );
        }
        if (this.#setup.stepObserver !== undefined) {
          this.#setup.stepObserver.beforeStep(capturedContext);
        } else if (this.#setup.stepBudget !== undefined) {
          this.#setup.stepBudget.consume(capturedContext, 1);
        }
        steps += 1;
        const node = frame.block.instructions[frame.position];
        if (node !== undefined) {
          if (node.op === 'checkpoint') {
            this.checkpoint(frame, node, frames);
            continue;
          }
          const operands = node.operands.flatMap((operand) => {
            if (operand.kind === 'ssa') return [read(frame, operand.value)];
            if (operand.kind === 'ssa-list') {
              return operand.values.map((value) => read(frame, value));
            }
            return [];
          });
          if (node.op === 'call') {
            const callee = this.#setup.functions.get(reference(node, 0) as FunctionRef)!;
            frames.push(this.frame(callee, operands));
          } else {
            const executor = this.#setup.executors?.get(node.op);
            const values =
              executor !== undefined
                ? invokeExecutor(executor, node, operands, capturedContext)
                : node.op.startsWith('event.')
                  ? invokeEvent(this.#setup, node, operands)
                  : node.op.startsWith('bridge.')
                    ? invokeOutput(this.#setup, node, operands, capturedContext)
                    : evaluateStorageOrScalar(node, operands, this.storage);
            node.results.forEach((value, index) => frame.values.set(value, values[index]!));
            frame.position += 1;
          }
          continue;
        }
        const term = frame.block.terminator!;
        switch (term.kind) {
          case 'jump':
            enterBlock(frame, term.target, term.args);
            break;
          case 'branch': {
            const edge = read(frame, term.condition) === true ? term.yes : term.no;
            enterBlock(frame, edge.target, edge.args);
            break;
          }
          case 'return': {
            const values = term.values.map((value) => read(frame, value));
            frames.pop();
            const caller = frames[frames.length - 1];
            if (caller === undefined)
              return Object.freeze({ values: Object.freeze(values), steps });
            const call = caller.block.instructions[caller.position]!;
            call.results.forEach((value, index) => caller.values.set(value, values[index]!));
            caller.position += 1;
            break;
          }
          case 'trap':
            throw new IRExecutionError('trap', `IR trap: ${term.code}`);
          case 'dispatch': {
            const key = term.key.map((value) => read(frame, value));
            const args = term.args.map((value) => read(frame, value));
            const artifact = this.#setup.providers.materialize(term.provider, key);
            // The artifact replaces this frame: dispatch is a tail transfer that keeps the
            // current entry, budget, and virtual time, and its return reaches our caller.
            const inputs = artifact.fn.params.map((type, index) =>
              captureArgument(type, args[index]!),
            );
            frames.pop();
            frames.push(this.generatedFrame(artifact, inputs));
            break;
          }
        }
      }
      throw new Error('Execution ended without returning');
    } catch (cause) {
      this.#faulted = true;
      const callStack = Object.freeze(frames.map((frame) => this.location(frame)));
      throw wrapExecutionError(cause, capturedContext, callStack, steps);
    }
  }

  private frame(fn: FunctionDefinition, args: readonly RuntimeScalar[]): Frame {
    const block = fn.body!.entry;
    return {
      fn,
      functionIndex: this.#setup.indices.get(fn)!,
      block,
      position: 0,
      values: new Map(block.params.map((param, index) => [param, args[index]!])),
    };
  }

  private generatedFrame(artifact: ProviderArtifact, args: readonly RuntimeScalar[]): Frame {
    const block = artifact.fn.body!.entry;
    return {
      fn: artifact.fn,
      functionIndex: artifact.index,
      artifact,
      block,
      position: 0,
      values: new Map(block.params.map((param, index) => [param, args[index]!])),
    };
  }

  /**
   * A legal recovery boundary: valid dependencies continue with the next instruction; invalid
   * ones abandon the rest of this artifact and tail-dispatch `key`/`args` to the target. The
   * replaced frame means no instruction after the checkpoint runs twice and no effect is undone.
   */
  private checkpoint(frame: Frame, node: InstructionNode, frames: Frame[]): void {
    const artifact = frame.artifact;
    if (artifact === undefined) {
      throw new IRProviderError(
        'recovery-failed',
        'checkpoint executed outside a provider artifact',
      );
    }
    if (this.storage.validateDependencies(artifact.dependencies)) {
      frame.position += 1;
      return;
    }
    const provider = reference(node, 0) as ProviderRef;
    const key = listValues(frame, node, 1);
    const args = listValues(frame, node, 2);
    const { artifact: recovered, inputs } = recoverCheckpoint(
      this.#setup,
      frame.fn,
      provider,
      key,
      args,
    );
    frames.pop();
    frames.push(this.generatedFrame(recovered, inputs));
  }

  private location(frame: Frame): IRExecutionLocation {
    return makeLocation(
      frame.functionIndex,
      frame.fn,
      frame.fn.body!.blocks.indexOf(frame.block),
      frame.block,
      frame.position < frame.block.instructions.length ? frame.position : undefined,
    );
  }
}

function read(frame: Frame, value: Value): RuntimeScalar {
  const result = frame.values.get(value);
  if (result === undefined) throw new Error('SSA value was not bound');
  return result;
}

function listValues(frame: Frame, node: InstructionNode, index: number): RuntimeScalar[] {
  const operand = node.operands[index];
  if (operand?.kind !== 'ssa-list') throw new Error('Expected a validated ssa-list operand');
  return operand.values.map((value) => read(frame, value));
}

function enterBlock(frame: Frame, block: BlockDefinition, args: readonly Value[]): void {
  // Read the entire edge before assigning any parameter (including self-backedges).
  const values = args.map((value) => read(frame, value));
  block.params.forEach((param, index) => frame.values.set(param, values[index]!));
  frame.block = block;
  frame.position = 0;
}
