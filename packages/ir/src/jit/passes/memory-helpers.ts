/** Fixtures shared by the J12 memory-pass unit tests. */
import type { IRModule } from '../../types';
import { createLowerContext, lowerFunction } from '../mir';
import type { LowerableFunction } from '../mir';
import type { LowerContext } from '../resolve';
import type { MFunction } from '../mir';
import { assertStepInvariant, verifyMIR } from '../verify';
import type { MemoryPassContext } from './memory-model';

export interface LoweredMemoryFunction {
  readonly fn: MFunction;
  readonly lower: LowerContext;
  readonly context: MemoryPassContext;
}

/** Lower one model function and expose the memory pass context. */
export function lowerMemory(module: IRModule, target: LowerableFunction): LoweredMemoryFunction {
  const lower = createLowerContext(module);
  return {
    fn: lowerFunction(lower, target),
    lower,
    context: { memories: module.memories },
  };
}

/** Verify structure and the S-1 step invariant after one pass. */
export function verifiedMemory(lowered: LoweredMemoryFunction): MFunction {
  verifyMIR(lowered.fn, lowered.lower);
  assertStepInvariant(lowered.fn);
  return lowered.fn;
}

export function countOp(fn: MFunction, op: string): number {
  return fn.blocks.reduce(
    (sum, block) => sum + block.insts.filter((inst) => inst.op === op).length,
    0,
  );
}

export function opsOf(fn: MFunction, op: string) {
  return fn.blocks.flatMap((block) => block.insts.filter((inst) => inst.op === op));
}
