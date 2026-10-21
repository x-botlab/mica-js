import { describe, expect, it } from 'vitest';
import { ElectricalConflictError } from '../electrical/electrical';
import type { ElectricalPinInput } from '../electrical/electrical-types';
import { createFloatingInput } from '../electrical/floating-input';
import { createScheduler } from '../scheduler/scheduler';
import { SchedulerError } from '../scheduler/scheduler-error';
import type { Scheduler, SchedulerTarget } from '../scheduler/scheduler-types';
import { createTopologyRuntime } from './topology';
import type {
  ConnectionState,
  TopologyDefinition,
  TopologyOptions,
  TopologyRuntime,
} from './topology-types';

const MODEL = Object.freeze({
  kind: 'ideal-voltage' as const,
  minVoltage: 0,
  maxVoltage: 5,
  lowVoltage: 0,
  highVoltage: 5,
});

type PinOverrides = Partial<Omit<ElectricalPinInput, 'instanceId' | 'pinName'>>;

function pinState(
  instanceId: string,
  pinName: string,
  overrides: PinOverrides = {},
): ElectricalPinInput {
  return {
    instanceId,
    pinName,
    powerReady: true,
    mode: 'high-z',
    outputEnabled: false,
    pull: 'none',
    model: MODEL,
    ...overrides,
  };
}

function pushPull(instanceId: string, pinName: string, high: boolean): ElectricalPinInput {
  return pinState(instanceId, pinName, {
    mode: 'push-pull',
    outputEnabled: true,
    digitalIntent: high,
  });
}

function signal(instanceId: string, pinName: string): { instanceId: string; pinName: string } {
  return { instanceId, pinName };
}

function runtimes(
  definition: TopologyDefinition,
  states: readonly ElectricalPinInput[],
  extra: Partial<Omit<TopologyOptions, 'instanceId' | 'pinStates'>> = {},
): { scheduler: Scheduler; runtime: TopologyRuntime } {
  const scheduler = createScheduler();
  const runtime = createTopologyRuntime(scheduler, definition, {
    instanceId: 'topology',
    pinStates: states,
    ...extra,
  });
  return { scheduler, runtime };
}

function networkOf(runtime: TopologyRuntime, instanceId: string, pinName: string) {
  const network = runtime.networkOf(signal(instanceId, pinName));
  expect(network).toBeDefined();
  return network!;
}

function floatingOf(runtime: TopologyRuntime, instanceId: string, pinName: string) {
  const input = runtime.floatingInput(signal(instanceId, pinName));
  expect(input).toBeDefined();
  return input!;
}

function target(name: string, kind: 'event' | 'control'): SchedulerTarget {
  return { name, kind, params: [] };
}

function expectInvalidDefinition(value: unknown, expected: new (...args: never[]) => Error): void {
  const scheduler = createScheduler();
  expect(() =>
    createTopologyRuntime(scheduler, value as TopologyDefinition, {
      instanceId: 'topology',
      pinStates: [],
    }),
  ).toThrow(expected);
}

describe('topology components', () => {
  it('joins external wires, closed internal connections, cycles and parallel paths', () => {
    const definition: TopologyDefinition = {
      pins: [
        { instanceId: 'a', pinName: 'A', kind: 'signal' },
        { instanceId: 'a', pinName: 'B', kind: 'signal' },
        { instanceId: 'a', pinName: 'GND', kind: 'gnd' },
        { instanceId: 'b', pinName: 'C', kind: 'signal' },
        { instanceId: 'b', pinName: 'D', kind: 'signal' },
        { instanceId: 'b', pinName: 'VCC', kind: 'power' },
        { instanceId: 'c', pinName: 'X', kind: 'signal' },
      ],
      wires: [
        { wireId: 'w1', pins: [signal('a', 'A'), signal('a', 'B')] },
        {
          wireId: 'w2',
          pins: [signal('b', 'C'), signal('b', 'D'), signal('b', 'VCC')],
          globalGnd: true,
        },
        {
          wireId: 'w3',
          pins: [signal('a', 'B'), signal('a', 'GND'), signal('b', 'C')],
        },
      ],
      connections: [
        { instanceId: 'a', connectionId: 'one', pins: ['A', 'B'], initial: 'closed' },
        { instanceId: 'a', connectionId: 'two', pins: ['A', 'B'], initial: 'closed' },
        { instanceId: 'b', connectionId: 'three', pins: ['C', 'D'] },
      ],
    };
    const { runtime } = runtimes(
      definition,
      definition.pins.map((pin) => pinState(pin.instanceId, pin.pinName)),
    );

    const networks = runtime.networks();
    expect(networks).toHaveLength(2);
    expect(networks[0]?.networkId).toBe('net:a/A');
    expect(networks[0]?.pins).toEqual([
      signal('a', 'A'),
      signal('a', 'B'),
      signal('a', 'GND'),
      signal('b', 'C'),
      signal('b', 'D'),
      signal('b', 'VCC'),
    ]);
    expect(networks[0]?.groundReady).toBe(true);
    expect(networks[0]?.result?.state).toBe('floating');
    expect(networks[1]?.networkId).toBe('net:c/X');
    expect(networks[1]?.groundReady).toBe(false);
    expect(runtime.connectionState('b', 'three')).toBe('open');
    expect(Object.isFrozen(networks)).toBe(true);
    expect(Object.isFrozen(networks[0]?.pins)).toBe(true);
  });

  it('merges and splits one network while leaving unrelated results untouched', () => {
    const definition: TopologyDefinition = {
      pins: [
        { instanceId: 'a', pinName: 'A', kind: 'signal' },
        { instanceId: 'a', pinName: 'B', kind: 'signal' },
        { instanceId: 'b', pinName: 'C', kind: 'signal' },
        { instanceId: 'b', pinName: 'D', kind: 'signal' },
        { instanceId: 'c', pinName: 'X', kind: 'signal' },
      ],
      wires: [
        { wireId: 'w1', pins: [signal('a', 'A'), signal('b', 'C')] },
        { wireId: 'w2', pins: [signal('a', 'B'), signal('b', 'D')] },
      ],
      connections: [{ instanceId: 'a', connectionId: 'sw', pins: ['A', 'B'] }],
    };
    const { scheduler, runtime } = runtimes(
      definition,
      definition.pins.map((pin) => pinState(pin.instanceId, pin.pinName)),
    );
    const untouched = networkOf(runtime, 'c', 'X');

    expect(runtime.networks().map((network) => network.networkId)).toEqual([
      'net:a/A',
      'net:a/B',
      'net:c/X',
    ]);

    runtime.submit({ instanceId: 'a', connections: [{ connectionId: 'sw', state: 'closed' }] });
    scheduler.start();
    expect(runtime.networks().map((network) => network.networkId)).toEqual(['net:a/A', 'net:c/X']);
    expect(networkOf(runtime, 'a', 'A').pins).toEqual([
      signal('a', 'A'),
      signal('a', 'B'),
      signal('b', 'C'),
      signal('b', 'D'),
    ]);
    expect(networkOf(runtime, 'c', 'X')).toEqual(untouched);

    runtime.submit({ instanceId: 'a', connections: [{ connectionId: 'sw', state: 'open' }] });
    scheduler.start();
    expect(runtime.networks().map((network) => network.networkId)).toEqual([
      'net:a/A',
      'net:a/B',
      'net:c/X',
    ]);
  });

  it('collapses a three-pin cycle into one deterministic component', () => {
    const definition: TopologyDefinition = {
      pins: [
        { instanceId: 'x', pinName: 'A', kind: 'signal' },
        { instanceId: 'x', pinName: 'B', kind: 'signal' },
        { instanceId: 'x', pinName: 'C', kind: 'signal' },
      ],
      wires: [
        { wireId: 'w1', pins: [signal('x', 'A'), signal('x', 'B')] },
        { wireId: 'w2', pins: [signal('x', 'B'), signal('x', 'C')] },
        { wireId: 'w3', pins: [signal('x', 'C'), signal('x', 'A')] },
      ],
      connections: [
        { instanceId: 'x', connectionId: 'parallel', pins: ['A', 'B'], initial: 'closed' },
      ],
    };
    const { runtime } = runtimes(
      definition,
      definition.pins.map((pin) => pinState(pin.instanceId, pin.pinName)),
    );
    expect(runtime.networks()).toHaveLength(1);
    expect(runtime.networks()[0]?.pins).toEqual([
      signal('x', 'A'),
      signal('x', 'B'),
      signal('x', 'C'),
    ]);
  });

  it('keeps network identities unambiguous for delimiter-bearing names', () => {
    const definition: TopologyDefinition = {
      pins: [
        { instanceId: 'a', pinName: 'b/c', kind: 'signal' },
        { instanceId: 'a/b', pinName: 'c', kind: 'signal' },
        { instanceId: 'a%2Fb', pinName: 'c', kind: 'signal' },
      ],
      wires: [],
      connections: [],
    };
    const { runtime } = runtimes(
      definition,
      definition.pins.map((pin) => pinState(pin.instanceId, pin.pinName)),
    );
    const ids = runtime.networks().map((network) => network.networkId);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual(['net:a%252Fb/c', 'net:a%2Fb/c', 'net:a/b%2Fc']);
  });

  it('computes ground readiness only when a gnd pin reaches the explicit global GND', () => {
    const definition: TopologyDefinition = {
      pins: [
        { instanceId: 'g', pinName: 'GND', kind: 'gnd' },
        { instanceId: 'g', pinName: 'N', kind: 'gnd' },
        { instanceId: 'g', pinName: 'P', kind: 'signal' },
        { instanceId: 'm', pinName: 'Q', kind: 'signal' },
      ],
      wires: [
        { wireId: 'w1', pins: [signal('g', 'P'), signal('m', 'Q')], globalGnd: true },
        { wireId: 'w2', pins: [signal('g', 'GND'), signal('g', 'N')] },
      ],
      connections: [{ instanceId: 'g', connectionId: 'link', pins: ['P', 'N'] }],
    };
    const { scheduler, runtime } = runtimes(
      definition,
      definition.pins.map((pin) => pinState(pin.instanceId, pin.pinName)),
    );

    expect(networkOf(runtime, 'm', 'Q').groundReady).toBe(false);
    expect(networkOf(runtime, 'g', 'GND').groundReady).toBe(false);

    runtime.submit({ instanceId: 'g', connections: [{ connectionId: 'link', state: 'closed' }] });
    scheduler.start();
    expect(networkOf(runtime, 'm', 'Q').groundReady).toBe(true);
    expect(networkOf(runtime, 'g', 'GND').groundReady).toBe(true);

    runtime.submit({ instanceId: 'g', connections: [{ connectionId: 'link', state: 'open' }] });
    scheduler.start();
    expect(networkOf(runtime, 'm', 'Q').groundReady).toBe(false);
  });
});

describe('topology patches', () => {
  function spdt(): {
    definition: TopologyDefinition;
    scheduler: Scheduler;
    runtime: TopologyRuntime;
  } {
    const definition: TopologyDefinition = {
      pins: [
        { instanceId: 'relay', pinName: 'COM', kind: 'signal' },
        { instanceId: 'relay', pinName: 'NC', kind: 'signal' },
        { instanceId: 'relay', pinName: 'NO', kind: 'signal' },
        { instanceId: 'ext', pinName: 'C', kind: 'signal' },
        { instanceId: 'ext', pinName: 'N', kind: 'signal' },
        { instanceId: 'ext', pinName: 'O', kind: 'signal' },
      ],
      wires: [
        { wireId: 'wc', pins: [signal('relay', 'COM'), signal('ext', 'C')] },
        { wireId: 'wn', pins: [signal('relay', 'NC'), signal('ext', 'N')] },
        { wireId: 'wo', pins: [signal('relay', 'NO'), signal('ext', 'O')] },
      ],
      connections: [
        {
          instanceId: 'relay',
          connectionId: 'nc',
          pins: ['COM', 'NC'],
          initial: 'closed',
        },
        { instanceId: 'relay', connectionId: 'no', pins: ['COM', 'NO'] },
      ],
    };
    const { scheduler, runtime } = runtimes(
      definition,
      definition.pins.map((pin) => pinState(pin.instanceId, pin.pinName)),
    );
    return { definition, scheduler, runtime };
  }

  it('applies all touches of one patch atomically', () => {
    const { scheduler, runtime } = spdt();
    expect(networkOf(runtime, 'relay', 'COM').pins).toEqual(
      expect.arrayContaining([signal('relay', 'NC'), signal('ext', 'N')]),
    );

    runtime.submit({
      instanceId: 'relay',
      connections: [
        { connectionId: 'nc', state: 'open' },
        { connectionId: 'no', state: 'closed' },
      ],
    });
    scheduler.start();

    expect(runtime.connectionState('relay', 'nc')).toBe('open');
    expect(runtime.connectionState('relay', 'no')).toBe('closed');
    expect(networkOf(runtime, 'relay', 'COM').pins).toEqual([
      signal('ext', 'C'),
      signal('ext', 'O'),
      signal('relay', 'COM'),
      signal('relay', 'NO'),
    ]);
    expect(networkOf(runtime, 'relay', 'NC').pins).toEqual([
      signal('ext', 'N'),
      signal('relay', 'NC'),
    ]);
  });

  it('does not expose a patch before the next control phase', () => {
    const { scheduler, runtime } = spdt();
    const observed: ConnectionState[] = [];
    const eventTarget = target('A', 'event');
    const host = scheduler.addInstance({
      instanceId: 'host',
      targets: [eventTarget],
      executor: {
        execute(executed) {
          if (executed.name !== 'A') return;
          observed.push(runtime.connectionState('relay', 'nc'));
          runtime.submit({
            instanceId: 'relay',
            connections: [{ connectionId: 'nc', state: 'open' }],
          });
          observed.push(runtime.connectionState('relay', 'nc'));
        },
      },
    });
    host.at(eventTarget, 0, []);

    scheduler.start();
    expect(observed).toEqual(['closed', 'closed']);
    expect(runtime.connectionState('relay', 'nc')).toBe('open');
  });

  it('shows ordinary feedback to the next ordinary entry at the same time', () => {
    const { scheduler, runtime } = spdt();
    const observed: ConnectionState[] = [];
    const aTarget = target('A', 'event');
    const bTarget = target('B', 'event');
    const host = scheduler.addInstance({
      instanceId: 'host',
      targets: [aTarget, bTarget],
      executor: {
        execute(executed) {
          if (executed.name === 'A') {
            runtime.submit({
              instanceId: 'relay',
              connections: [{ connectionId: 'nc', state: 'open' }],
            });
            return;
          }
          observed.push(runtime.connectionState('relay', 'nc'));
        },
      },
    });
    host.at(aTarget, 0, []);
    host.at(bTarget, 0, []);

    scheduler.start();
    expect(observed).toEqual(['open']);
  });

  it('runs control feedback in a later control round before ordinary work', () => {
    const { scheduler, runtime } = spdt();
    const observed: ConnectionState[] = [];
    const first = target('first', 'control');
    const second = target('second', 'control');
    const after = target('after', 'control');
    const host = scheduler.addInstance({
      instanceId: 'host',
      targets: [first, second, after],
      executor: {
        execute(executed) {
          if (executed.name === 'first') {
            runtime.submit({
              instanceId: 'relay',
              connections: [{ connectionId: 'nc', state: 'open' }],
            });
            scheduler.enqueueControl(host, after, []);
            return;
          }
          if (executed.name === 'second') {
            observed.push(runtime.connectionState('relay', 'nc'));
            return;
          }
          observed.push(runtime.connectionState('relay', 'nc'));
        },
      },
    });
    scheduler.enqueueControl(host, first, []);
    scheduler.enqueueControl(host, second, []);

    scheduler.start();
    expect(observed).toEqual(['closed', 'open']);
  });

  it('keeps same-instant patch submission order stable', () => {
    const first = spdt();
    first.runtime.submit({
      instanceId: 'relay',
      connections: [{ connectionId: 'nc', state: 'open' }],
    });
    first.runtime.submit({
      instanceId: 'relay',
      connections: [{ connectionId: 'nc', state: 'closed' }],
    });
    first.scheduler.start();
    expect(first.runtime.connectionState('relay', 'nc')).toBe('closed');

    const second = spdt();
    second.runtime.submit({
      instanceId: 'relay',
      connections: [{ connectionId: 'nc', state: 'open' }],
    });
    second.runtime.submit({
      instanceId: 'relay',
      connections: [{ connectionId: 'nc', state: 'closed' }],
    });
    second.runtime.submit({
      instanceId: 'relay',
      connections: [{ connectionId: 'nc', state: 'open' }],
    });
    second.scheduler.start();
    expect(second.runtime.connectionState('relay', 'nc')).toBe('open');
  });

  it('treats a fully idempotent patch as an inactive resolution point', () => {
    const definition: TopologyDefinition = {
      pins: [
        { instanceId: 'a', pinName: 'A', kind: 'signal' },
        { instanceId: 'a', pinName: 'B', kind: 'signal' },
      ],
      wires: [],
      connections: [{ instanceId: 'a', connectionId: 'sw', pins: ['A', 'B'] }],
    };
    let supplyCalls = 0;
    const { scheduler, runtime } = runtimes(definition, [pinState('a', 'A'), pinState('a', 'B')], {
      floating: {
        seed: 12345,
        supplyVoltage: () => {
          supplyCalls += 1;
          return undefined;
        },
      },
    });
    expect(supplyCalls).toBe(2);

    runtime.submit({ instanceId: 'a', connections: [{ connectionId: 'sw', state: 'open' }] });
    scheduler.start();
    expect(supplyCalls).toBe(2);
  });

  it('rejects invalid patches without queuing or partially committing', () => {
    const { scheduler, runtime } = spdt();
    const submit = (patch: unknown) => (runtime.submit as (value: unknown) => void)(patch);

    expect(() => submit({ instanceId: 'relay', connections: [] })).toThrow(RangeError);
    expect(() =>
      submit({
        instanceId: 'relay',
        connections: [
          { connectionId: 'nc', state: 'open' },
          { connectionId: 'nc', state: 'closed' },
        ],
      }),
    ).toThrow(TypeError);
    expect(() =>
      submit({
        instanceId: 'relay',
        connections: [{ connectionId: 'missing', state: 'closed' }],
      }),
    ).toThrow(RangeError);
    expect(() =>
      submit({
        instanceId: 'missing',
        connections: [{ connectionId: 'nc', state: 'closed' }],
      }),
    ).toThrow(RangeError);
    expect(() =>
      submit({
        instanceId: 'relay',
        connections: [{ connectionId: 'nc', state: 'half' }],
      }),
    ).toThrow(TypeError);
    expect(() =>
      submit({
        instanceId: 'relay',
        connections: [
          { connectionId: 'nc', state: 'open' },
          { connectionId: 'missing', state: 'closed' },
        ],
      }),
    ).toThrow(RangeError);

    expect(scheduler.start().executed).toBe(0);
    expect(runtime.connectionState('relay', 'nc')).toBe('closed');
    expect(runtime.connectionState('relay', 'no')).toBe('open');
  });

  it('keeps committed connection states when electrical resolution conflicts', () => {
    const definition: TopologyDefinition = {
      pins: [
        { instanceId: 'a', pinName: 'P', kind: 'signal' },
        { instanceId: 'a', pinName: 'Q', kind: 'signal' },
        { instanceId: 'a', pinName: 'S', kind: 'signal' },
        { instanceId: 'a', pinName: 'T', kind: 'signal' },
      ],
      wires: [],
      connections: [
        { instanceId: 'a', connectionId: 'sw', pins: ['P', 'Q'] },
        { instanceId: 'a', connectionId: 'other', pins: ['S', 'T'] },
      ],
    };
    const { scheduler, runtime } = runtimes(definition, [
      pushPull('a', 'P', true),
      pushPull('a', 'Q', false),
      pinState('a', 'S'),
      pinState('a', 'T'),
    ]);

    runtime.submit({
      instanceId: 'a',
      connections: [{ connectionId: 'other', state: 'closed' }],
    });
    scheduler.start();
    expect(runtime.connectionState('a', 'other')).toBe('closed');

    runtime.submit({ instanceId: 'a', connections: [{ connectionId: 'sw', state: 'closed' }] });
    expect(() => scheduler.start()).toThrow(SchedulerError);
    expect(scheduler.state).toBe('faulted');
    expect(scheduler.error?.code).toBe('execution-failed');
    expect(scheduler.error?.cause).toBeInstanceOf(ElectricalConflictError);
    const conflict = scheduler.error?.cause as ElectricalConflictError;
    expect(conflict.network.networkId).toBe('net:a/P');
    expect(conflict.contributions).toHaveLength(2);

    expect(runtime.connectionState('a', 'sw')).toBe('closed');
    expect(runtime.connectionState('a', 'other')).toBe('closed');
    expect(networkOf(runtime, 'a', 'P').pins).toEqual([signal('a', 'P'), signal('a', 'Q')]);
    expect(networkOf(runtime, 'a', 'P').result).toBeUndefined();
    expect(networkOf(runtime, 'a', 'S').result?.state).toBe('floating');
    expect(scheduler.error?.code).toBe('execution-failed');
    let resumed: unknown;
    try {
      scheduler.start();
    } catch (error) {
      resumed = error;
    }
    expect(resumed).toBeInstanceOf(SchedulerError);
    expect((resumed as SchedulerError).code).toBe('scheduler-faulted');
  });
});

describe('topology pin states', () => {
  it('resolves pin updates only at the queued control phase', () => {
    const definition: TopologyDefinition = {
      pins: [{ instanceId: 'a', pinName: 'A', kind: 'signal' }],
      wires: [],
      connections: [],
    };
    const { scheduler, runtime } = runtimes(definition, [pinState('a', 'A')]);
    expect(networkOf(runtime, 'a', 'A').result?.state).toBe('floating');

    runtime.updatePinStates([
      pinState('a', 'A', {
        mode: 'push-pull',
        outputEnabled: true,
        digitalIntent: true,
      }),
    ]);
    expect(networkOf(runtime, 'a', 'A').result?.state).toBe('floating');

    scheduler.start();
    const result = networkOf(runtime, 'a', 'A').result;
    expect(result?.state).toBe('driven');
    if (result?.state !== 'driven') throw new Error('expected driven');
    expect(result.voltage).toBe(5);
  });

  it('rejects unknown or duplicate pin updates and requires complete initial states', () => {
    const definition: TopologyDefinition = {
      pins: [
        { instanceId: 'a', pinName: 'A', kind: 'signal' },
        { instanceId: 'a', pinName: 'B', kind: 'signal' },
      ],
      wires: [],
      connections: [],
    };
    const scheduler = createScheduler();
    expect(() =>
      createTopologyRuntime(scheduler, definition, {
        instanceId: 'topology',
        pinStates: [pinState('a', 'A')],
      }),
    ).toThrow(RangeError);

    const { runtime } = runtimes(definition, [pinState('a', 'A'), pinState('a', 'B')]);
    expect(() => runtime.updatePinStates([pinState('a', 'missing')])).toThrow(RangeError);
    expect(() => runtime.updatePinStates([pinState('a', 'A'), pinState('a', 'A')])).toThrow(
      TypeError,
    );
  });

  it('reports an electrical conflict from a pin update without rolling back committed state', () => {
    const definition: TopologyDefinition = {
      pins: [
        { instanceId: 'a', pinName: 'P', kind: 'signal' },
        { instanceId: 'a', pinName: 'Q', kind: 'signal' },
      ],
      wires: [{ wireId: 'w', pins: [signal('a', 'P'), signal('a', 'Q')] }],
      connections: [],
    };
    const { scheduler, runtime } = runtimes(definition, [pinState('a', 'P'), pinState('a', 'Q')]);
    runtime.updatePinStates([pushPull('a', 'P', true), pushPull('a', 'Q', false)]);
    expect(() => scheduler.start()).toThrow(SchedulerError);
    expect(scheduler.state).toBe('faulted');
    expect(scheduler.error?.cause).toBeInstanceOf(ElectricalConflictError);
    expect(networkOf(runtime, 'a', 'P').result).toBeUndefined();
    expect(runtime.networks()).toHaveLength(1);
  });
});

describe('topology floating integration', () => {
  function floatingFixture(options: {
    supply: () => number | undefined;
    samplingEnabled?: () => boolean;
  }): { scheduler: Scheduler; runtime: TopologyRuntime } {
    const definition: TopologyDefinition = {
      pins: [
        { instanceId: 'a', pinName: 'A', kind: 'signal' },
        { instanceId: 'a', pinName: 'C', kind: 'signal' },
        { instanceId: 'b', pinName: 'B', kind: 'signal' },
      ],
      wires: [{ wireId: 'w', pins: [signal('a', 'C'), signal('b', 'B')] }],
      connections: [{ instanceId: 'a', connectionId: 'sw', pins: ['A', 'C'] }],
    };
    return runtimes(
      definition,
      [pinState('a', 'A'), pinState('a', 'C'), pushPull('b', 'B', true)],
      {
        floating: {
          seed: 12345,
          supplyVoltage: options.supply,
          ...(options.samplingEnabled === undefined
            ? {}
            : { samplingEnabled: options.samplingEnabled }),
        },
      },
    );
  }

  it('registers a floating episode and starts a new one after returning from driven', () => {
    const { scheduler, runtime } = floatingFixture({ supply: () => 3.3 });
    const reference = createFloatingInput(12345, 'a', 'A');
    reference.beginFloating(3.3);

    const floating = floatingOf(runtime, 'a', 'A');
    expect(floating.sample(3.3, 0)).toEqual(reference.sample(3.3, 0));

    runtime.submit({ instanceId: 'a', connections: [{ connectionId: 'sw', state: 'closed' }] });
    scheduler.start();
    expect(networkOf(runtime, 'a', 'A').result?.state).toBe('driven');

    runtime.submit({ instanceId: 'a', connections: [{ connectionId: 'sw', state: 'open' }] });
    scheduler.start();
    expect(networkOf(runtime, 'a', 'A').result?.state).toBe('floating');

    reference.beginFloating(3.3);
    expect(floating.sample(3.3, 100)).toEqual(reference.sample(3.3, 100));
  });

  it('does not start a new episode when floating networks merge or split', () => {
    const definition: TopologyDefinition = {
      pins: [
        { instanceId: 'a', pinName: 'A', kind: 'signal' },
        { instanceId: 'a', pinName: 'B', kind: 'signal' },
      ],
      wires: [],
      connections: [{ instanceId: 'a', connectionId: 'sw', pins: ['A', 'B'] }],
    };
    const { scheduler, runtime } = runtimes(definition, [pinState('a', 'A'), pinState('a', 'B')], {
      floating: { seed: 12345, supplyVoltage: () => 3.3 },
    });
    const reference = createFloatingInput(12345, 'a', 'A');
    reference.beginFloating(3.3);

    runtime.submit({ instanceId: 'a', connections: [{ connectionId: 'sw', state: 'closed' }] });
    scheduler.start();
    expect(networkOf(runtime, 'a', 'A').pins).toHaveLength(2);
    runtime.submit({ instanceId: 'a', connections: [{ connectionId: 'sw', state: 'open' }] });
    scheduler.start();

    const floating = floatingOf(runtime, 'a', 'A');
    expect(floating.sample(3.3, 0)).toEqual(reference.sample(3.3, 0));
    expect(floating.sample(3.3, 1000)).toEqual(reference.sample(3.3, 1000));
  });

  it('counts episodes while sampling is disabled and initializes V0 at the recovery point', () => {
    let supply: number | undefined;
    let enabled = false;
    const { scheduler, runtime } = floatingFixture({
      supply: () => supply,
      samplingEnabled: () => enabled,
    });
    const reference = createFloatingInput(12345, 'a', 'A');
    reference.beginFloating();

    runtime.submit({ instanceId: 'a', connections: [{ connectionId: 'sw', state: 'closed' }] });
    scheduler.start();
    runtime.submit({ instanceId: 'a', connections: [{ connectionId: 'sw', state: 'open' }] });
    scheduler.start();
    reference.beginFloating();

    scheduler.start({ until: 100 });
    expect(scheduler.now).toBe(100);

    enabled = true;
    supply = 1.5;
    runtime.refresh([signal('a', 'A')]);
    scheduler.start();
    reference.sample(1.5, 100);

    supply = 5;
    const actual = floatingOf(runtime, 'a', 'A').sample(5, 200);
    expect(actual).toEqual(reference.sample(5, 200));
    if (actual.state !== 'ready') throw new Error('expected ready floating sample');
    expect(actual.voltage).toBeLessThanOrEqual(5);
  });

  it('applies a patch at the scheduler time it was submitted from', () => {
    const { scheduler, runtime } = floatingFixture({ supply: () => 3.3 });
    const eventTarget = target('at100', 'event');
    const host = scheduler.addInstance({
      instanceId: 'host',
      targets: [eventTarget],
      executor: {
        execute(executed) {
          if (executed.name === 'at100') {
            runtime.submit({
              instanceId: 'a',
              connections: [{ connectionId: 'sw', state: 'closed' }],
            });
          }
        },
      },
    });
    host.at(eventTarget, 100, []);
    scheduler.start();

    expect(scheduler.now).toBe(100);
    expect(networkOf(runtime, 'a', 'A').result?.state).toBe('driven');

    runtime.submit({ instanceId: 'a', connections: [{ connectionId: 'sw', state: 'open' }] });
    scheduler.start();
    const reference = createFloatingInput(12345, 'a', 'A');
    reference.beginFloating(3.3);
    reference.beginFloating(3.3);
    expect(floatingOf(runtime, 'a', 'A').sample(3.3, 100)).toEqual(reference.sample(3.3, 100));
  });

  it('returns undefined floating inputs when floating is not configured', () => {
    const definition: TopologyDefinition = {
      pins: [{ instanceId: 'a', pinName: 'A', kind: 'signal' }],
      wires: [],
      connections: [],
    };
    const { runtime } = runtimes(definition, [pinState('a', 'A')]);
    expect(runtime.floatingInput(signal('a', 'A'))).toBeUndefined();
  });
});

describe('topology validation and lifecycle', () => {
  it('rejects malformed definitions', () => {
    expectInvalidDefinition(
      {
        pins: [
          { instanceId: 'a', pinName: 'A', kind: 'signal' },
          { instanceId: 'a', pinName: 'A', kind: 'signal' },
        ],
        wires: [],
        connections: [],
      },
      TypeError,
    );
    expectInvalidDefinition(
      { pins: [{ instanceId: 'a', pinName: 'A', kind: 'analog' }], wires: [], connections: [] },
      TypeError,
    );
    expectInvalidDefinition(
      {
        pins: [{ instanceId: 'a', pinName: 'A', kind: 'signal' }],
        wires: [{ wireId: 'w', pins: [] }],
        connections: [],
      },
      RangeError,
    );
    expectInvalidDefinition(
      {
        pins: [{ instanceId: 'a', pinName: 'A', kind: 'signal' }],
        wires: [{ wireId: 'w', pins: [signal('a', 'A')] }],
        connections: [{ instanceId: 'a', connectionId: 'c', pins: ['A', 'A'] }],
      },
      TypeError,
    );
    expectInvalidDefinition(
      {
        pins: [{ instanceId: 'a', pinName: 'A', kind: 'signal' }],
        wires: [],
        connections: [{ instanceId: 'missing', connectionId: 'c', pins: ['A', 'B'] }],
      },
      RangeError,
    );
    expectInvalidDefinition(
      {
        pins: [{ instanceId: 'a', pinName: 'A', kind: 'signal' }],
        wires: [],
        connections: [{ instanceId: 'a', connectionId: 'c', pins: ['A', 'B'] }],
      },
      RangeError,
    );
    expectInvalidDefinition(
      {
        pins: [
          { instanceId: 'a', pinName: 'A', kind: 'signal' },
          { instanceId: 'a', pinName: 'B', kind: 'signal' },
        ],
        wires: [],
        connections: [{ instanceId: 'a', connectionId: 'c', pins: ['A', 'B'], initial: 'maybe' }],
      },
      TypeError,
    );
    expectInvalidDefinition(
      {
        pins: [{ instanceId: 'a', pinName: 'A', kind: 'signal', extra: true }],
        wires: [],
        connections: [],
      },
      TypeError,
    );
    expectInvalidDefinition(
      {
        pins: [{ instanceId: 'a', pinName: 'A', kind: 'signal' }],
        wires: [{ wireId: 'w', pins: [signal('a', 'A')], globalGnd: undefined }],
        connections: [],
      },
      TypeError,
    );
  });

  it('rejects malformed options and floating configuration', () => {
    const definition: TopologyDefinition = {
      pins: [{ instanceId: 'a', pinName: 'A', kind: 'signal' }],
      wires: [],
      connections: [],
    };
    const scheduler = createScheduler();
    expect(() =>
      createTopologyRuntime(scheduler, definition, {
        instanceId: 'topology',
        pinStates: [pinState('a', 'A'), pinState('a', 'A')],
      }),
    ).toThrow(TypeError);
    expect(() =>
      createTopologyRuntime(scheduler, definition, {
        instanceId: 'topology',
        pinStates: [pinState('a', 'missing')],
      }),
    ).toThrow(RangeError);
    expect(() =>
      createTopologyRuntime(scheduler, definition, {
        instanceId: 'topology',
        pinStates: [pinState('a', 'A')],
        floating: { seed: -1, supplyVoltage: () => 3.3 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      createTopologyRuntime(scheduler, definition, {
        instanceId: 'topology',
        pinStates: [pinState('a', 'A')],
        floating: { seed: 1.5, supplyVoltage: () => 3.3 },
      }),
    ).toThrow(TypeError);
    expect(() =>
      createTopologyRuntime(scheduler, definition, {
        instanceId: 'topology',
        pinStates: [pinState('a', 'A')],
        floating: { seed: 1, supplyVoltage: 3.3 } as never,
      }),
    ).toThrow(TypeError);
  });

  it('rejects unknown query references and supports idempotent destroy', () => {
    const definition: TopologyDefinition = {
      pins: [{ instanceId: 'a', pinName: 'A', kind: 'signal' }],
      wires: [],
      connections: [],
    };
    const { runtime } = runtimes(definition, [pinState('a', 'A')]);
    expect(() => runtime.networkOf(signal('a', 'missing'))).toThrow(RangeError);
    expect(() => runtime.floatingInput(signal('a', 'missing'))).toThrow(RangeError);
    expect(() => runtime.connectionState('a', 'missing')).toThrow(RangeError);

    runtime.destroy();
    runtime.destroy();
    expect(() => runtime.refresh()).toThrow(SchedulerError);
  });
});
