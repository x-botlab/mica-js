import { expectTypeOf, it } from 'vitest';
import {
  createTopologyRuntime,
  type ConnectionState,
  type ElectricalNetworkResult,
  type ElectricalPinInput,
  type FloatingInput,
  type Scheduler,
  type SchedulerInstance,
  type TopologyConnectionPatch,
  type TopologyDefinition,
  type TopologyExternalWire,
  type TopologyFloatingOptions,
  type TopologyNetwork,
  type TopologyOptions,
  type TopologyPinRef,
  type TopologyRuntime,
} from '../index';

it('preserves the approved topology entrypoint signatures', () => {
  expectTypeOf(createTopologyRuntime).parameters.toEqualTypeOf<
    [Scheduler, TopologyDefinition, TopologyOptions]
  >();
  expectTypeOf(createTopologyRuntime).returns.toEqualTypeOf<TopologyRuntime>();
  expectTypeOf<TopologyRuntime['instance']>().toEqualTypeOf<SchedulerInstance>();
  expectTypeOf<TopologyRuntime['submit']>().parameters.toEqualTypeOf<
    [patch: TopologyConnectionPatch]
  >();
  expectTypeOf<TopologyRuntime['submit']>().returns.toEqualTypeOf<void>();
  expectTypeOf<TopologyRuntime['updatePinStates']>().parameters.toEqualTypeOf<
    [states: readonly ElectricalPinInput[]]
  >();
  expectTypeOf<TopologyRuntime['refresh']>().parameters.toEqualTypeOf<
    [pins?: readonly TopologyPinRef[] | undefined]
  >();
  expectTypeOf<TopologyRuntime['connectionState']>().parameters.toEqualTypeOf<
    [instanceId: string, connectionId: string]
  >();
  expectTypeOf<TopologyRuntime['connectionState']>().returns.toEqualTypeOf<ConnectionState>();
  expectTypeOf<TopologyRuntime['networks']>().returns.toEqualTypeOf<readonly TopologyNetwork[]>();
  expectTypeOf<TopologyRuntime['networkOf']>().returns.toEqualTypeOf<TopologyNetwork | undefined>();
  expectTypeOf<TopologyRuntime['floatingInput']>().returns.toEqualTypeOf<
    FloatingInput | undefined
  >();
  expectTypeOf<TopologyRuntime['destroy']>().returns.toEqualTypeOf<void>();
  expectTypeOf<TopologyNetwork['result']>().toEqualTypeOf<ElectricalNetworkResult | undefined>();
  expectTypeOf<TopologyNetwork['pins']>().toEqualTypeOf<readonly TopologyPinRef[]>();
  expectTypeOf<TopologyOptions['floating']>().toEqualTypeOf<TopologyFloatingOptions | undefined>();
  expectTypeOf<TopologyExternalWire['globalGnd']>().toEqualTypeOf<boolean | undefined>();
  expectTypeOf<ConnectionState>().toEqualTypeOf<'open' | 'closed'>();
});
