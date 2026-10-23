/**
 * Iterative heap tier (J7): runs one IR function and its whole call tree on an
 * explicit frame stack, so arbitrary IR recursion never grows the JavaScript
 * stack.
 *
 * The compiled prologue calls this through `rt.deep` once
 * `maxCompiledDepth` compiled frames are live. Instruction semantics are
 * delegated to the same `engine-host` entry points as the reference
 * interpreter, so the two engines cannot drift; only frame bookkeeping and step
 * accounting (shared with `JitRuntime`) live here.
 *
 * Arguments arrive in MIR representation and results leave in MIR
 * representation, matching a compiled function's calling convention.
 */
import type { EngineSetup } from '../engine-setup';
import {
  captureArgument,
  evaluateStorageOrScalar,
  invokeEvent,
  invokeExecutor,
  invokeOutput,
  makeLocation,
  recoverCheckpoint,
  reference,
} from '../engine-host';
import { IRProviderError } from '../errors';
import { IRExecutionError } from '../interpreter';
import type { IRExecutionLocation } from '../interpreter';
import type { ProviderArtifact } from '../provider';
import { isFloatType } from '../runtime';
import type {
  BlockDefinition,
  FloatBits,
  FloatType,
  FunctionDefinition,
  FunctionRef,
  InstructionNode,
  ProviderRef,
  RuntimeScalar,
  ScalarType,
  Value,
} from '../types';
import { fromBoundary, toBoundary } from './float-runtime';
import type { FloatValue } from './float-runtime';
import { JitUnwind } from './runtime-core';
import type { JitRuntime } from './runtime-core';

/** One function the deep fallback can enter, keyed by its compiled index. */
export interface HeapEntry {
  readonly fn: FunctionDefinition;
  readonly functionIndex: number;
  readonly artifact: ProviderArtifact | undefined;
}

interface HeapFrame {
  readonly fn: FunctionDefinition;
  readonly functionIndex: number;
  readonly artifact: ProviderArtifact | undefined;
  block: BlockDefinition;
  position: number;
  readonly values: Map<Value, RuntimeScalar>;
}

/** Optional engine hooks for artifacts materialized while the heap tier runs. */
export interface HeapRunOptions {
  /**
   * Called once for every artifact the heap tier dispatches to (including a
   * checkpoint recovery target), before its frame is entered. The engine uses
   * it to register the artifact for `artifactWarmup` and tiering.
   */
  readonly onArtifact?: (artifact: ProviderArtifact, providerIndex: number) => void;
}

function notifyArtifact(
  setup: EngineSetup,
  options: HeapRunOptions | undefined,
  artifact: ProviderArtifact,
  provider: ProviderRef,
): void {
  if (options?.onArtifact === undefined) return;
  const providerIndex = setup.model.providers.findIndex(
    (definition) => definition.ref === provider,
  );
  options.onArtifact(artifact, providerIndex);
}

/**
 * Run `entry` with `args` (MIR representation) using `runtime` for step
 * accounting and `setup` for storage, providers and host hooks.
 */
export function runHeapFunction(
  setup: EngineSetup,
  runtime: JitRuntime,
  entry: HeapEntry,
  args: readonly unknown[],
  options?: HeapRunOptions,
): unknown {
  const context = runtime.context;
  // The heap tier is part of the tiering ladder: a hot function that only
  // ever runs here still triggers its tier-2 compilation. Artifacts count
  // through `artifactWarmup` instead, so they are excluded.
  if (entry.artifact === undefined) runtime.noteEntry(entry.functionIndex);
  const frames: HeapFrame[] = [
    frameFor(
      entry,
      args.map((value, index) => toArgument(entry.fn.params[index]!, value)),
    ),
  ];
  try {
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      // Same order as the reference loop: hard limit, then observer/budget, then
      // the step itself. The location is only needed by the error path.
      runtime.limitReached(undefined);
      runtime.steps += 1;
      const node = frame.block.instructions[frame.position];
      if (node !== undefined) {
        if (node.op === 'checkpoint') {
          checkpoint(setup, frame, node, frames, options);
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
          const callee = setup.functions.get(reference(node, 0) as FunctionRef)!;
          const calleeIndex = setup.indices.get(callee)!;
          runtime.noteEntry(calleeIndex);
          frames.push(
            frameFor(
              {
                fn: callee,
                functionIndex: calleeIndex,
                artifact: undefined,
              },
              operands,
            ),
          );
          continue;
        }
        const executor = setup.executors?.get(node.op);
        let values: readonly RuntimeScalar[];
        if (executor !== undefined) {
          runtime.beforeHost();
          values = invokeExecutor(executor, node, operands, context);
          runtime.afterHost();
        } else if (node.op.startsWith('event.')) {
          runtime.beforeHost();
          values = invokeEvent(setup, node, operands);
          runtime.afterHost();
        } else if (node.op.startsWith('bridge.')) {
          runtime.beforeHost();
          values = invokeOutput(setup, node, operands, context);
          runtime.afterHost();
        } else {
          values = evaluateStorageOrScalar(node, operands, setup.storage);
        }
        node.results.forEach((value, index) => frame.values.set(value, values[index]!));
        frame.position += 1;
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
          const types = frame.fn.results;
          const values = term.values.map((value) => read(frame, value));
          frames.pop();
          const caller = frames[frames.length - 1];
          if (caller === undefined) return toResults(types, values, runtime);
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
          runtime.beforeHost();
          const artifact = setup.providers.materialize(term.provider, key);
          runtime.afterHost();
          notifyArtifact(setup, options, artifact, term.provider);
          const inputs = artifact.fn.params.map((type, index) =>
            captureArgument(type, args[index]!),
          );
          frames.pop();
          frames.push(generatedFrame(artifact, inputs));
          break;
        }
      }
    }
    throw new Error('Execution ended without returning');
  } catch (cause) {
    if (cause instanceof JitUnwind) throw cause;
    const unwind = new JitUnwind(cause, runtime.steps);
    for (let index = frames.length - 1; index >= 0; index -= 1) {
      unwind.frames.push(locationOf(setup, frames[index]!));
    }
    throw unwind;
  }
}

function frameFor(entry: HeapEntry, args: readonly RuntimeScalar[]): HeapFrame {
  const block = entry.fn.body!.entry;
  return {
    fn: entry.fn,
    functionIndex: entry.functionIndex,
    artifact: entry.artifact,
    block,
    position: 0,
    values: new Map(block.params.map((param, index) => [param, args[index]!])),
  };
}

function generatedFrame(artifact: ProviderArtifact, args: readonly RuntimeScalar[]): HeapFrame {
  return frameFor({ fn: artifact.fn, functionIndex: artifact.index, artifact }, args);
}

/**
 * A legal recovery boundary: valid dependencies continue with the next
 * instruction; invalid ones abandon the rest of this artifact and tail-dispatch
 * `key`/`args` to the target.
 */
function checkpoint(
  setup: EngineSetup,
  frame: HeapFrame,
  node: InstructionNode,
  frames: HeapFrame[],
  options: HeapRunOptions | undefined,
): void {
  const artifact = frame.artifact;
  if (artifact === undefined) {
    throw new IRProviderError('recovery-failed', 'checkpoint executed outside a provider artifact');
  }
  if (setup.storage.validateDependencies(artifact.dependencies)) {
    frame.position += 1;
    return;
  }
  const provider = reference(node, 0) as ProviderRef;
  const key = listValues(frame, node, 1);
  const args = listValues(frame, node, 2);
  const recovered = recoverCheckpoint(setup, frame.fn, provider, key, args);
  notifyArtifact(setup, options, recovered.artifact, provider);
  frames.pop();
  frames.push(generatedFrame(recovered.artifact, recovered.inputs));
}

function locationOf(setup: EngineSetup, frame: HeapFrame): IRExecutionLocation {
  return makeLocation(
    frame.functionIndex,
    frame.fn,
    frame.fn.body!.blocks.indexOf(frame.block),
    frame.block,
    frame.position < frame.block.instructions.length ? frame.position : undefined,
  );
}

function read(frame: HeapFrame, value: Value): RuntimeScalar {
  const result = frame.values.get(value);
  if (result === undefined) throw new Error('SSA value was not bound');
  return result;
}

function listValues(frame: HeapFrame, node: InstructionNode, index: number): RuntimeScalar[] {
  const operand = node.operands[index];
  if (operand?.kind !== 'ssa-list') throw new Error('Expected a validated ssa-list operand');
  return operand.values.map((value) => read(frame, value));
}

function enterBlock(frame: HeapFrame, block: BlockDefinition, args: readonly Value[]): void {
  // Read the entire edge before assigning any parameter (including self-backedges).
  const values = args.map((value) => read(frame, value));
  block.params.forEach((param, index) => frame.values.set(param, values[index]!));
  frame.block = block;
  frame.position = 0;
}

/** MIR argument -> boundary value (the reference loop works on boundary values). */
function toArgument(type: ScalarType, value: unknown): RuntimeScalar {
  if (isFloatType(type)) return toBoundary(type as FloatType, value as FloatValue) as RuntimeScalar;
  return value as RuntimeScalar;
}

/** Boundary result -> MIR value, following a compiled function's convention. */
function toResults(
  types: readonly ScalarType[],
  values: readonly RuntimeScalar[],
  runtime: JitRuntime,
): unknown {
  if (types.length === 0) return undefined;
  if (types.length === 1) return toResult(types[0]!, values[0]!);
  values.forEach((value, index) => {
    runtime.ret[index] = toResult(types[index]!, value);
  });
  return undefined;
}

function toResult(type: ScalarType, value: RuntimeScalar): unknown {
  if (isFloatType(type)) return fromBoundary(type as FloatType, value as FloatBits);
  return value;
}
