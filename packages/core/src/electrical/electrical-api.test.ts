import { expectTypeOf, it } from 'vitest';
import {
  createFloatingInput,
  ElectricalConflictError,
  resolveElectricalNetwork,
  type ElectricalContribution,
  type ElectricalNetworkInput,
  type ElectricalNetworkResult,
  type ElectricalPinInput,
  type FloatingInput,
  type FloatingInputSample,
} from '../index';

it('preserves the approved root-entrypoint signatures and discriminated physical states', () => {
  expectTypeOf(resolveElectricalNetwork).parameters.toEqualTypeOf<[ElectricalNetworkInput]>();
  expectTypeOf(resolveElectricalNetwork).returns.toEqualTypeOf<ElectricalNetworkResult>();
  expectTypeOf(createFloatingInput).parameters.toEqualTypeOf<[number, string, string]>();
  expectTypeOf(createFloatingInput).returns.toEqualTypeOf<FloatingInput>();
  expectTypeOf<FloatingInput['beginFloating']>().parameters.toEqualTypeOf<
    [supplyVoltage?: number | undefined]
  >();
  expectTypeOf<FloatingInput['beginFloating']>().returns.toEqualTypeOf<void>();
  expectTypeOf<FloatingInput['sample']>().parameters.toEqualTypeOf<
    [supplyVoltage: number, timePs: number, enabled?: boolean | undefined]
  >();
  expectTypeOf<FloatingInput['sample']>().returns.toEqualTypeOf<FloatingInputSample>();
  expectTypeOf<ConstructorParameters<typeof ElectricalConflictError>>().toEqualTypeOf<
    [ElectricalNetworkInput, readonly ElectricalContribution[]]
  >();
  expectTypeOf<ElectricalConflictError['name']>().toEqualTypeOf<'ElectricalConflictError'>();
  expectTypeOf<ElectricalConflictError['network']>().toEqualTypeOf<ElectricalNetworkInput>();
  expectTypeOf<ElectricalConflictError['contributions']>().toEqualTypeOf<
    readonly ElectricalContribution[]
  >();
  expectTypeOf<ElectricalPinInput['mode']>().toEqualTypeOf<
    'high-z' | 'push-pull' | 'open-drain' | 'analog'
  >();
  expectTypeOf<ElectricalPinInput['model']['kind']>().toEqualTypeOf<'ideal-voltage'>();
  expectTypeOf<ElectricalNetworkInput['pins']>().toEqualTypeOf<readonly ElectricalPinInput[]>();
  expectTypeOf<ElectricalPinInput['digitalIntent']>().toEqualTypeOf<boolean | undefined>();
  expectTypeOf<ElectricalPinInput['voltageIntent']>().toEqualTypeOf<number | undefined>();
  expectTypeOf<Extract<ElectricalNetworkResult, { state: 'floating' }>>().toEqualTypeOf<{
    readonly state: 'floating';
    readonly digitalFallback: false;
    readonly contributions: readonly ElectricalContribution[];
  }>();
  expectTypeOf<Extract<FloatingInputSample, { state: 'disabled' }>>().toEqualTypeOf<{
    readonly state: 'disabled';
  }>();
});
