import type { DomainInstruction, IRModule } from '@mica-js/ir';

export const PIN_INSTRUCTION_NAMES = [
  'pin.configure',
  'pin.write_digital',
  'pin.sample_digital',
] as const;

export type PinInstructionName = (typeof PIN_INSTRUCTION_NAMES)[number];

export const PIN_MODE_CODES = {
  'high-z': 0,
  'push-pull': 1,
  'open-drain': 2,
  analog: 3,
} as const;

export const PIN_PULL_CODES = {
  none: 0,
  up: 1,
  down: 2,
} as const;

export type PinMode = keyof typeof PIN_MODE_CODES;
export type PinPull = keyof typeof PIN_PULL_CODES;

type PinStatic = { readonly kind: 'static'; readonly category: 'pin' };
type PinLiteral = { readonly kind: 'literal' };
type PinBoolValue = { readonly kind: 'value'; readonly type: 'bool' };
type ConfigureOperands = readonly [PinStatic, PinLiteral, PinLiteral, PinLiteral];
type WriteOperands = readonly [PinStatic, PinBoolValue];
type SampleOperands = readonly [PinStatic];

export interface PinInstructionSet {
  readonly configure: DomainInstruction<ConfigureOperands, readonly []>;
  readonly writeDigital: DomainInstruction<WriteOperands, readonly []>;
  readonly sampleDigital: DomainInstruction<SampleOperands, readonly ['u32']>;
}

/** Declares the pin instruction subset confirmed for #55 (#25 / #8). */
export function declarePinInstructions(module: IRModule): PinInstructionSet {
  return {
    configure: module.domainInstruction<ConfigureOperands, readonly []>('pin.configure', {
      operands: [
        { kind: 'static', category: 'pin' },
        { kind: 'literal' },
        { kind: 'literal' },
        { kind: 'literal' },
      ],
      results: [],
    }),
    writeDigital: module.domainInstruction<WriteOperands, readonly []>('pin.write_digital', {
      operands: [
        { kind: 'static', category: 'pin' },
        { kind: 'value', type: 'bool' },
      ],
      results: [],
    }),
    sampleDigital: module.domainInstruction<SampleOperands, readonly ['u32']>(
      'pin.sample_digital',
      {
        operands: [{ kind: 'static', category: 'pin' }],
        results: ['u32'],
      },
    ),
  };
}
