import type { IRModule } from '@mica-js/ir';
import {
  UnifiedIRCompilerError,
  type CompiledCircuitMemory,
  type CompiledNetlist,
  type GlobalConnectionMap,
  type GlobalObserverMap,
  type GlobalPinMap,
} from '../types';
import { createConnectionLowering, type ConnectionLowering } from './connection-lower';
import type { PowerGating } from '../power';
import {
  createObserverLowering,
  type LoweredObserver,
  type ObserverLowering,
} from './observe-lower';

export { createConnectionLowering } from './connection-lower';
export type {
  ConnectionClosed,
  ConnectionLowering,
  ConnectionLoweringContext,
  ConnectionPatchEntry,
  ConnectionSolverRuntime,
} from './connection-lower';
export { createObserverLowering, emitObserverDetection } from './observe-lower';
export type {
  LoweredObserver,
  ObserverActivation,
  ObserverLowering,
  ObserverLoweringContext,
} from './observe-lower';

/** Domain instructions this pass removes from the generated module. */
export const LOWERED_DOMAIN_INSTRUCTIONS: readonly string[] = Object.freeze([
  'connection.apply',
  'observe.configure',
]);

/** Everything the pass reads from the earlier compilation stages. */
export interface LoweringContext {
  readonly module: IRModule;
  readonly memory: CompiledCircuitMemory;
  readonly netlist: CompiledNetlist;
  readonly pins: GlobalPinMap;
  readonly connections: GlobalConnectionMap;
  readonly observers: GlobalObserverMap;
  /** Power-domain gating; a domain that is off releases its drivers. */
  readonly power?: PowerGating;
}

/** Lowering surfaces device generation emits through. */
export interface DomainLoweringSurface {
  readonly connections: ConnectionLowering;
  readonly observers: ObserverLowering;
}

/** What the pass hands to the main loop generator. */
export interface LoweredDomainProgram {
  readonly connections: ConnectionLowering;
  /** Activated observations, in declaration order. */
  readonly observers: readonly LoweredObserver[];
}

/** Contract of a domain lowering pass. */
export interface DomainLoweringPass {
  /**
   * Verifies that no domain instruction survived generation and returns the
   * programs the main loop still has to emit.
   *
   * @throws {UnifiedIRCompilerError} when a `connection.apply` or
   *   `observe.configure` instruction is still present.
   */
  run(module: IRModule): LoweredDomainProgram;
}

/**
 * Lowers `connection.apply` and `observe.configure` to core IR.
 *
 * The pass is created before device generation because the IR builder offers no
 * way to rewrite a closed function body: a domain instruction must be lowered
 * while its block is still open. Device behaviours therefore emit through
 * {@link DomainLoweringSurface} (`api.connection` / `api.observe`), and
 * {@link run} proves afterwards that no domain instruction reached the module.
 * The two pieces left for later — the connection group solvers and the observer
 * edge detection — are either declared here or returned to the main loop.
 */
export class DomainInstructionLowering implements DomainLoweringPass, DomainLoweringSurface {
  readonly connections: ConnectionLowering;
  readonly observers: ObserverLowering;

  constructor(context: LoweringContext) {
    this.connections = createConnectionLowering({
      module: context.module,
      memory: context.memory,
      netlist: context.netlist,
      pins: context.pins,
      connections: context.connections,
      ...(context.power === undefined ? {} : { power: context.power }),
    });
    this.observers = createObserverLowering({
      memory: context.memory,
      observers: context.observers,
    });
  }

  run(module: IRModule): LoweredDomainProgram {
    const residual = findDomainInstructions(module);
    if (residual.length > 0) {
      const details = residual
        .map((entry) => `- ${entry.op} in "${entry.functionName}"`)
        .join('\n');
      throw new UnifiedIRCompilerError(
        'invalid-ir',
        `Domain instruction lowering left ${residual.length} instruction(s) behind:\n${details}`,
      );
    }
    return Object.freeze({
      connections: this.connections,
      observers: this.observers.programs,
    });
  }
}

/** Scans every generated body for a domain instruction that was not lowered. */
export function findDomainInstructions(
  module: IRModule,
): readonly { readonly functionName: string; readonly op: string }[] {
  const names = new Set(LOWERED_DOMAIN_INSTRUCTIONS);
  const found: { functionName: string; op: string }[] = [];
  for (const fn of module.functions) {
    const body = fn.body;
    if (body === undefined) continue;
    for (const block of body.blocks) {
      for (const instruction of block.instructions) {
        if (names.has(instruction.op)) found.push({ functionName: fn.name, op: instruction.op });
      }
    }
  }
  return Object.freeze(found);
}
