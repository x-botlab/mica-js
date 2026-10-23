/**
 * Shared fixtures for the scalar pass tests.
 *
 * These helpers lower a builder function to MIR and assert both structural
 * verification and the S-1 step invariant after every pass.
 */
import { createLowerContext, lowerFunction } from '../mir';
import type { LowerableFunction, MFunction } from '../mir';
import { assertStepInvariant, verifyMIR } from '../verify';
import type { IRModule } from '../../types';

/** Lower one function from `module` to MIR. */
export function lower(module: IRModule, fn: LowerableFunction): MFunction {
  return lowerFunction(createLowerContext(module), fn);
}

/** Assert verifier and step invariants; returns the function for chaining. */
export function verified(fn: MFunction): MFunction {
  verifyMIR(fn);
  assertStepInvariant(fn);
  return fn;
}

/** All instructions of an opcode, in block order. */
export function instructionsOf(fn: MFunction, op: string): import('../mir').MInst[] {
  return fn.blocks.flatMap((block) => block.insts.filter((inst) => inst.op === op));
}

/** Number of instructions of an opcode. */
export function countOf(fn: MFunction, op: string): number {
  return instructionsOf(fn, op).length;
}

/** Block ids in function order. */
export function blockIds(fn: MFunction): number[] {
  return fn.blocks.map((block) => block.id);
}
