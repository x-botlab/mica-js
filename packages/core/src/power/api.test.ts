import { expectTypeOf, it } from 'vitest';
import {
  createPowerRuntime,
  PowerFeedbackError,
  type ConnectionState,
  type ElectricalPinInput,
  type FloatingInput,
  type PowerDefinition,
  type PowerDeviceDefinition,
  type PowerDigitalPinChange,
  type PowerDigitalPinObserver,
  type PowerDigitalSample,
  type PowerDigitalSource,
  type PowerDomainChange,
  type PowerDomainDeclaration,
  type PowerDomainObserver,
  type PowerDomainSnapshot,
  type PowerDomainState,
  type PowerDownReason,
  type PowerFloatingOptions,
  type PowerInputMode,
  type PowerLevels,
  type PowerOptions,
  type PowerPinBinding,
  type PowerPinGate,
  type PowerPinGateReason,
  type PowerRuntime,
  type PowerVoltageSample,
  type PowerVoltageSource,
  type Scheduler,
  type SchedulerInstance,
  type TimePs,
  type TopologyConnectionPatch,
  type TopologyDefinition,
  type TopologyNetwork,
  type TopologyPinRef,
} from '../index';

it('preserves the approved power entrypoint signatures', () => {
  expectTypeOf(createPowerRuntime).parameters.toEqualTypeOf<
    [Scheduler, PowerDefinition, PowerOptions]
  >();
  expectTypeOf(createPowerRuntime).returns.toEqualTypeOf<PowerRuntime>();
  expectTypeOf<PowerRuntime['instance']>().toEqualTypeOf<SchedulerInstance>();
  expectTypeOf<PowerRuntime['inputMode']>().toEqualTypeOf<PowerInputMode>();
  expectTypeOf<PowerRuntime['submit']>().parameters.toEqualTypeOf<
    [patch: TopologyConnectionPatch]
  >();
  expectTypeOf<PowerRuntime['submit']>().returns.toEqualTypeOf<void>();
  expectTypeOf<PowerRuntime['updatePinStates']>().parameters.toEqualTypeOf<
    [states: readonly ElectricalPinInput[]]
  >();
  expectTypeOf<PowerRuntime['updatePinStates']>().returns.toEqualTypeOf<void>();
  expectTypeOf<PowerRuntime['refresh']>().parameters.toEqualTypeOf<
    [pins?: readonly TopologyPinRef[] | undefined]
  >();
  expectTypeOf<PowerRuntime['connectionState']>().parameters.toEqualTypeOf<
    [instanceId: string, connectionId: string]
  >();
  expectTypeOf<PowerRuntime['connectionState']>().returns.toEqualTypeOf<ConnectionState>();
  expectTypeOf<PowerRuntime['networks']>().returns.toEqualTypeOf<readonly TopologyNetwork[]>();
  expectTypeOf<PowerRuntime['networkOf']>().returns.toEqualTypeOf<TopologyNetwork | undefined>();
  expectTypeOf<PowerRuntime['floatingInput']>().returns.toEqualTypeOf<FloatingInput | undefined>();
  expectTypeOf<PowerRuntime['domain']>().parameters.toEqualTypeOf<
    [instanceId: string, domainId: string]
  >();
  expectTypeOf<PowerRuntime['domain']>().returns.toEqualTypeOf<PowerDomainSnapshot>();
  expectTypeOf<PowerRuntime['domains']>().parameters.toEqualTypeOf<
    [instanceId?: string | undefined]
  >();
  expectTypeOf<PowerRuntime['domains']>().returns.toEqualTypeOf<readonly PowerDomainSnapshot[]>();
  expectTypeOf<PowerRuntime['pinGate']>().returns.toEqualTypeOf<PowerPinGate>();
  expectTypeOf<PowerRuntime['pinIntent']>().returns.toEqualTypeOf<ElectricalPinInput>();
  expectTypeOf<PowerRuntime['sampleDigital']>().returns.toEqualTypeOf<PowerDigitalSample>();
  expectTypeOf<PowerRuntime['sampleVoltage']>().returns.toEqualTypeOf<PowerVoltageSample>();
  expectTypeOf<PowerRuntime['observe']>().parameters.toEqualTypeOf<
    [observer: PowerDomainObserver | undefined]
  >();
  expectTypeOf<PowerRuntime['addDigitalPinObserver']>().parameters.toEqualTypeOf<
    [observer: PowerDigitalPinObserver]
  >();
  expectTypeOf<PowerRuntime['addDigitalPinObserver']>().returns.toEqualTypeOf<() => void>();
  expectTypeOf<PowerRuntime['destroy']>().returns.toEqualTypeOf<void>();
});

it('preserves the approved definition, snapshot and option shapes', () => {
  expectTypeOf<PowerOptions['instanceId']>().toEqualTypeOf<string>();
  expectTypeOf<PowerOptions['topologyInstanceId']>().toEqualTypeOf<string | undefined>();
  expectTypeOf<PowerOptions['pinStates']>().toEqualTypeOf<readonly ElectricalPinInput[]>();
  expectTypeOf<PowerOptions['floating']>().toEqualTypeOf<PowerFloatingOptions | undefined>();
  expectTypeOf<PowerOptions['inputMode']>().toEqualTypeOf<PowerInputMode | undefined>();
  expectTypeOf<PowerOptions['maxPropagationRounds']>().toEqualTypeOf<number | undefined>();
  expectTypeOf<PowerOptions['observer']>().toEqualTypeOf<PowerDomainObserver | undefined>();
  expectTypeOf<PowerFloatingOptions['seed']>().toEqualTypeOf<number>();
  expectTypeOf<PowerInputMode>().toEqualTypeOf<'two-state' | 'three-state'>();
  expectTypeOf<PowerDomainState>().toEqualTypeOf<'off' | 'on'>();
  expectTypeOf<PowerDownReason>().toEqualTypeOf<
    'ground-not-ready' | 'supply-indeterminate' | 'dependency-off' | 'below-turn-off'
  >();
  expectTypeOf<PowerLevels['low']>().toEqualTypeOf<number>();
  expectTypeOf<PowerLevels['high']>().toEqualTypeOf<number>();
  expectTypeOf<PowerPinBinding['powerDomain']>().toEqualTypeOf<string | undefined>();
  expectTypeOf<PowerPinBinding['levels']>().toEqualTypeOf<PowerLevels | undefined>();
  expectTypeOf<PowerDomainDeclaration['supply']>().toEqualTypeOf<string>();
  expectTypeOf<PowerDomainDeclaration['ground']>().toEqualTypeOf<string>();
  expectTypeOf<PowerDomainDeclaration['voltage']['turnOn']>().toEqualTypeOf<number>();
  expectTypeOf<PowerDomainDeclaration['voltage']['turnOff']>().toEqualTypeOf<number>();
  expectTypeOf<PowerDomainDeclaration['dependsOn']>().toEqualTypeOf<
    readonly string[] | undefined
  >();
  expectTypeOf<PowerDeviceDefinition['powerDomains']>().toEqualTypeOf<
    Readonly<Record<string, PowerDomainDeclaration>>
  >();
  expectTypeOf<PowerDeviceDefinition['pins']>().toEqualTypeOf<
    Readonly<Record<string, PowerPinBinding>> | undefined
  >();
  expectTypeOf<PowerDefinition['topology']>().toEqualTypeOf<TopologyDefinition>();
  expectTypeOf<PowerDefinition['devices']>().toEqualTypeOf<readonly PowerDeviceDefinition[]>();
  expectTypeOf<PowerDomainSnapshot['voltage']>().toEqualTypeOf<number | null>();
  expectTypeOf<PowerDomainSnapshot['state']>().toEqualTypeOf<PowerDomainState>();
  expectTypeOf<PowerDomainSnapshot['groundReady']>().toEqualTypeOf<boolean>();
  expectTypeOf<PowerDomainSnapshot['dependenciesReady']>().toEqualTypeOf<boolean>();
  expectTypeOf<PowerDomainChange['timePs']>().toEqualTypeOf<TimePs>();
  expectTypeOf<PowerDomainChange['previousState']>().toEqualTypeOf<PowerDomainState>();
  expectTypeOf<PowerDomainChange['reasons']>().toEqualTypeOf<readonly PowerDownReason[]>();
  expectTypeOf<PowerPinGate['domainId']>().toEqualTypeOf<string | null>();
  expectTypeOf<PowerPinGate['reason']>().toEqualTypeOf<PowerPinGateReason>();
  expectTypeOf<PowerPinGateReason>().toEqualTypeOf<
    'powered' | 'opening' | 'domain-off' | 'no-domain'
  >();
  expectTypeOf<PowerDigitalSample['value']>().toEqualTypeOf<0 | 1>();
  expectTypeOf<PowerDigitalSample['source']>().toEqualTypeOf<PowerDigitalSource>();
  expectTypeOf<PowerDigitalSource>().toEqualTypeOf<
    'sampled' | 'floating' | 'threshold-range' | 'gated'
  >();
  expectTypeOf<PowerVoltageSample['voltage']>().toEqualTypeOf<number>();
  expectTypeOf<PowerVoltageSample['source']>().toEqualTypeOf<PowerVoltageSource>();
  expectTypeOf<PowerVoltageSource>().toEqualTypeOf<'sampled' | 'floating' | 'gated'>();
  expectTypeOf<PowerDomainObserver['onPowerDomainChange']>().parameters.toEqualTypeOf<
    [changes: readonly PowerDomainChange[], snapshot: readonly PowerDomainSnapshot[]]
  >();
  expectTypeOf<PowerDomainObserver['onPowerDomainChange']>().returns.toEqualTypeOf<void>();
  expectTypeOf<PowerDigitalPinChange['instanceId']>().toEqualTypeOf<string>();
  expectTypeOf<PowerDigitalPinChange['pinName']>().toEqualTypeOf<string>();
  expectTypeOf<PowerDigitalPinChange['sample']>().toEqualTypeOf<PowerDigitalSample>();
  expectTypeOf<PowerDigitalPinObserver['onDigitalPinChange']>().parameters.toEqualTypeOf<
    [changes: readonly PowerDigitalPinChange[]]
  >();
  expectTypeOf<PowerDigitalPinObserver['onDigitalPinChange']>().returns.toEqualTypeOf<void>();
});

it('exposes diagnostics on PowerFeedbackError', () => {
  expectTypeOf<PowerFeedbackError['timePs']>().toEqualTypeOf<TimePs>();
  expectTypeOf<PowerFeedbackError['rounds']>().toEqualTypeOf<number>();
  expectTypeOf<PowerFeedbackError['maxRounds']>().toEqualTypeOf<number>();
  expectTypeOf<PowerFeedbackError['domains']>().toEqualTypeOf<readonly PowerDomainSnapshot[]>();
  expectTypeOf<PowerFeedbackError>().toMatchTypeOf<Error>();
});
