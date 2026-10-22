import type { DomainInstruction, IRModule } from '@mica-js/ir';

export const OBSERVE_INSTRUCTION_NAMES = ['observe.configure'] as const;

export type ObserveInstructionName = (typeof OBSERVE_INSTRUCTION_NAMES)[number];

/** #25 edge encoding: 0 is reserved for state observation and is rejected for digital edges. */
export const OBSERVE_EDGE_CODES = {
  rising: 1,
  falling: 2,
  both: 3,
} as const;

export type ObserveEdgeCode = (typeof OBSERVE_EDGE_CODES)[keyof typeof OBSERVE_EDGE_CODES];

type ObserverStatic = { readonly kind: 'static'; readonly category: 'observe' };
type EnabledLiteral = { readonly kind: 'literal' };
type EdgeLiteral = { readonly kind: 'literal' };
type ConfigureOperands = readonly [ObserverStatic, EnabledLiteral, EdgeLiteral];

export interface ObserveInstructionSet {
  readonly configure: DomainInstruction<ConfigureOperands, readonly []>;
}

/** Declares the digital observation subset confirmed for #56 (#8 / #25). */
export function declareObserveInstructions(module: IRModule): ObserveInstructionSet {
  return {
    configure: module.domainInstruction<ConfigureOperands, readonly []>('observe.configure', {
      operands: [{ kind: 'static', category: 'observe' }, { kind: 'literal' }, { kind: 'literal' }],
      results: [],
    }),
  };
}
