import { describe, expect, it } from 'vitest';
import {
  createScheduler,
  createTopologyRuntime,
  ElectricalConflictError,
  SchedulerError,
  type ElectricalPinInput,
  type Scheduler,
  type TopologyConnectionPatch,
  type TopologyDefinition,
  type TopologyRuntime,
} from '@mica-js/core';
import { createIRModule, validateIR, type FunctionBuilder, type Value } from '@mica-js/ir';
import { parseDeviceDescription } from '../description';
import { DeviceError, type DeviceErrorCode } from '../errors';
import { createDeviceInstance } from '../lifecycle/instance';
import { createValidationPolicy } from '../lifecycle/policy';
import { loadedModule } from '../lifecycle/test-helpers';
import type { DeviceAPI, DeviceFactory } from '../types';
import type { ConnectionRef, DeviceConnectionDescriptor } from './types';

const MODEL = {
  kind: 'ideal-voltage' as const,
  minVoltage: 0,
  maxVoltage: 5,
  lowVoltage: 0,
  highVoltage: 5,
};

const BUTTON = {
  pins: { A: { kind: 'signal' }, B: { kind: 'signal' } },
  connections: { contact: { pins: ['A', 'B'], initial: 'open' } },
};

const RELAY = {
  pins: {
    COM: { kind: 'signal' },
    NO: { kind: 'signal' },
    NC: { kind: 'signal' },
  },
  connections: {
    'normally-open': { pins: ['COM', 'NO'], initial: 'open' },
    'normally-closed': { pins: ['COM', 'NC'], initial: 'closed' },
  },
};

const TWO_CONNECTIONS = {
  pins: { A: { kind: 'signal' }, B: { kind: 'signal' }, C: { kind: 'signal' } },
  connections: {
    first: { pins: ['A', 'B'], initial: 'open' },
    second: { pins: ['B', 'C'], initial: 'open' },
  },
};

function pinState(
  instanceId: string,
  pinName: string,
  driver: { readonly high: boolean } | undefined = undefined,
): ElectricalPinInput {
  return {
    instanceId,
    pinName,
    powerReady: true,
    mode: driver === undefined ? 'high-z' : 'push-pull',
    outputEnabled: driver !== undefined,
    pull: 'none',
    model: MODEL,
    ...(driver === undefined ? {} : { digitalIntent: driver.high }),
  };
}

function parse(raw: Record<string, unknown>) {
  return parseDeviceDescription(raw, { name: 'acme:button' });
}

function definitionFor(raw: Record<string, unknown>, instanceId = 'button'): TopologyDefinition {
  const description = parse(raw);
  return {
    pins: Object.keys(raw['pins'] as Record<string, unknown>).map((pinName) => ({
      instanceId,
      pinName,
      kind: 'signal' as const,
    })),
    wires: [],
    connections: [...description.connections.values()].map((connection) => ({
      instanceId,
      connectionId: connection.key,
      pins: connection.pins,
      initial: connection.initial,
    })),
  };
}

function createTopology(
  scheduler: Scheduler,
  raw: Record<string, unknown>,
  instanceId = 'button',
  driver?: { readonly high: boolean },
): TopologyRuntime {
  const definition = definitionFor(raw, instanceId);
  return createTopologyRuntime(scheduler, definition, {
    instanceId: `topology:${instanceId}`,
    pinStates: definition.pins.map((pin) => pinState(pin.instanceId, pin.pinName, driver)),
  });
}

function setup(factory: DeviceFactory, raw: Record<string, unknown> = BUTTON) {
  const scheduler = createScheduler();
  const topology = createTopology(scheduler, raw);
  const instance = createDeviceInstance(loadedModule(factory, parse(raw)), scheduler, {
    instanceId: 'button',
    connections: { topology },
  });
  return { scheduler, topology, instance };
}

function recorded(topology: TopologyRuntime): {
  readonly host: TopologyRuntime;
  readonly calls: readonly TopologyConnectionPatch[];
} {
  const calls: TopologyConnectionPatch[] = [];
  const host: TopologyRuntime = {
    instance: topology.instance,
    submit: (patch) => {
      calls.push(patch);
      topology.submit(patch);
    },
    updatePinStates: (states) => topology.updatePinStates(states),
    refresh: (pins) => topology.refresh(pins),
    connectionState: (instanceId, connectionId) =>
      topology.connectionState(instanceId, connectionId),
    networks: () => topology.networks(),
    networkOf: (pin) => topology.networkOf(pin),
    floatingInput: (pin) => topology.floatingInput(pin),
    destroy: () => topology.destroy(),
  };
  return { host, calls };
}

function deviceError(run: () => unknown, code: DeviceErrorCode): DeviceError {
  try {
    run();
  } catch (error) {
    if (error instanceof DeviceError && error.code === code) {
      return error;
    }
    throw error;
  }
  throw new Error(`Expected ${code}`);
}

function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null) {
    if (current instanceof DeviceError) codes.push(current.code);
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}

function createApplying(
  scheduler: Scheduler,
  topology: TopologyRuntime,
  body: (builder: FunctionBuilder<readonly []>, api: DeviceAPI) => void,
  instanceId = 'button',
): ReturnType<typeof createDeviceInstance> {
  const factory: DeviceFactory = (api) => {
    const initialize = api.ir.lifecycle('initialize', []);
    initialize.body((builder) => {
      body(builder, api);
      builder.return([]);
    });
    return { initialize };
  };
  return createDeviceInstance(loadedModule(factory, parse(BUTTON)), scheduler, {
    instanceId,
    connections: { topology },
  });
}

describe('device connection author API', () => {
  it('switches one contact through the real builder, kernel and topology', () => {
    const factory: DeviceFactory = (api: DeviceAPI) => {
      const initialize = api.ir.lifecycle('initialize', []);
      const reset = api.ir.lifecycle('reset', []);
      const contact = api.ir.connection('contact');
      initialize.body((b) => {
        b.connection.apply([{ connection: contact, closed: b.const('bool', true) }]);
        b.return([]);
      });
      reset.body((b) => {
        b.connection.apply([{ connection: contact, closed: b.const('bool', false) }]);
        b.return([]);
      });
      return { initialize, reset };
    };
    const { scheduler, topology, instance } = setup(factory);

    expect(topology.connectionState('button', 'contact')).toBe('open');
    scheduler.start();
    expect(instance.state).toBe('ready');
    expect(topology.connectionState('button', 'contact')).toBe('closed');

    instance.reset();
    scheduler.start();
    expect(topology.connectionState('button', 'contact')).toBe('open');
    instance.reset();
    scheduler.start();
    expect(topology.connectionState('button', 'contact')).toBe('open');
  });

  it('applies a two-contact relay patch once and atomically', () => {
    const factory: DeviceFactory = (api: DeviceAPI) => {
      const initialize = api.ir.lifecycle('initialize', []);
      const no = api.ir.connection('normally-open');
      const nc = api.ir.connection('normally-closed');
      initialize.body((b) => {
        b.connection.apply([
          { connection: no, closed: b.const('bool', true) },
          { connection: nc, closed: b.const('bool', false) },
        ]);
        b.return([]);
      });
      return { initialize };
    };
    const scheduler = createScheduler();
    const topology = createTopology(scheduler, RELAY);
    const { host, calls } = recorded(topology);
    const instance = createDeviceInstance(loadedModule(factory, parse(RELAY)), scheduler, {
      instanceId: 'button',
      connections: { topology: host },
    });
    expect(instance.state).toBe('initializing');

    scheduler.step();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.connections).toEqual([
      { connectionId: 'normally-open', state: 'closed' },
      { connectionId: 'normally-closed', state: 'open' },
    ]);
    // The patch is queued, not resolved, while the device entry is still running.
    expect(topology.connectionState('button', 'normally-open')).toBe('open');
    expect(topology.connectionState('button', 'normally-closed')).toBe('closed');

    scheduler.step();
    expect(topology.connectionState('button', 'normally-open')).toBe('closed');
    expect(topology.connectionState('button', 'normally-closed')).toBe('open');
  });

  it('keeps the old topology visible until the control phase', () => {
    const factory: DeviceFactory = (api: DeviceAPI) => {
      const initialize = api.ir.lifecycle('initialize', []);
      const contact = api.ir.connection('contact');
      initialize.body((b) => {
        b.connection.apply([{ connection: contact, closed: b.const('bool', true) }]);
        b.return([]);
      });
      return { initialize };
    };
    const { scheduler, topology } = setup(factory);

    scheduler.step();
    expect(topology.connectionState('button', 'contact')).toBe('open');
    scheduler.step();
    expect(topology.connectionState('button', 'contact')).toBe('closed');
    expect(scheduler.now).toBe(0);
  });

  it('applies from an ordinary event entry at the next control phase', () => {
    const factory: DeviceFactory = (api: DeviceAPI) => {
      const initialize = api.ir.lifecycle('initialize', []);
      const applyEvent = api.ir.entry('apply-event', []);
      const contact = api.ir.connection('contact');
      applyEvent.body((b) => {
        b.connection.apply([{ connection: contact, closed: b.const('bool', true) }]);
        b.return([]);
      });
      initialize.body((b) => {
        b.event.at(applyEvent, b.event.now(), []);
        b.return([]);
      });
      return { initialize };
    };
    const { scheduler, topology } = setup(factory);

    scheduler.step();
    expect(topology.connectionState('button', 'contact')).toBe('open');
    scheduler.step();
    expect(topology.connectionState('button', 'contact')).toBe('open');
    scheduler.step();
    expect(topology.connectionState('button', 'contact')).toBe('closed');
  });

  it('captures bool operands before later instructions change their source', () => {
    const factory: DeviceFactory = (api: DeviceAPI) => {
      const initialize = api.ir.lifecycle('initialize', []);
      const flag = api.ir.state('flag', 'bool', false);
      const contact = api.ir.connection('contact');
      initialize.body((b) => {
        b.connection.apply([{ connection: contact, closed: b.state.load(flag) }]);
        b.state.store(flag, b.const('bool', true));
        b.return([]);
      });
      return { initialize };
    };
    const { scheduler, topology } = setup(factory);

    scheduler.start();
    expect(topology.connectionState('button', 'contact')).toBe('open');
  });

  it('selects different patches through a bool branch', () => {
    const factory: DeviceFactory = (api: DeviceAPI) => {
      const initialize = api.ir.lifecycle('initialize', []);
      const reset = api.ir.lifecycle('reset', []);
      const selected = api.ir.state('selected', 'bool', false);
      const first = api.ir.connection('first');
      const second = api.ir.connection('second');
      const applyBranch = (b: FunctionBuilder<readonly []>) => {
        const off = b.block([]);
        const on = b.block([]);
        b.branch(b.state.load(selected), { target: on, args: [] }, { target: off, args: [] });
        b.at(on, (nested) => {
          nested.connection.apply([
            { connection: first, closed: nested.const('bool', true) },
            { connection: second, closed: nested.const('bool', false) },
          ]);
          nested.return([]);
        });
        b.at(off, (nested) => {
          nested.connection.apply([
            { connection: first, closed: nested.const('bool', false) },
            { connection: second, closed: nested.const('bool', true) },
          ]);
          nested.return([]);
        });
      };
      initialize.body((b) => {
        applyBranch(b);
      });
      reset.body((b) => {
        b.state.store(selected, b.const('bool', true));
        applyBranch(b);
      });
      return { initialize, reset };
    };
    const { scheduler, topology, instance } = setup(factory, TWO_CONNECTIONS);

    scheduler.start();
    expect(topology.connectionState('button', 'first')).toBe('open');
    expect(topology.connectionState('button', 'second')).toBe('closed');

    instance.reset();
    scheduler.start();
    expect(topology.connectionState('button', 'first')).toBe('closed');
    expect(topology.connectionState('button', 'second')).toBe('open');
  });

  it('uses the same operation group inside ordinary functions and calls', () => {
    const factory: DeviceFactory = (api: DeviceAPI) => {
      const initialize = api.ir.lifecycle('initialize', []);
      const drive = api.ir.func('drive', { params: ['bool'], results: [] });
      const contact = api.ir.connection('contact');
      drive.body((b, [closed]) => {
        b.connection.apply([{ connection: contact, closed }]);
        b.return([]);
      });
      initialize.body((b) => {
        b.call(drive, [b.const('bool', true)]);
        b.call(drive, [b.const('bool', false)]);
        b.call(drive, [b.const('bool', true)]);
        b.return([]);
      });
      return { initialize };
    };
    const { scheduler, topology } = setup(factory);

    scheduler.start();
    expect(topology.connectionState('button', 'contact')).toBe('closed');
  });

  it('keeps same-time patch submission order stable', () => {
    const factory: DeviceFactory = (api: DeviceAPI) => {
      const initialize = api.ir.lifecycle('initialize', []);
      const first = api.ir.connection('first');
      const second = api.ir.connection('second');
      initialize.body((b) => {
        b.connection.apply([{ connection: first, closed: b.const('bool', true) }]);
        b.connection.apply([{ connection: second, closed: b.const('bool', true) }]);
        b.return([]);
      });
      return { initialize };
    };
    const scheduler = createScheduler();
    const topology = createTopology(scheduler, TWO_CONNECTIONS);
    const { host, calls } = recorded(topology);
    createDeviceInstance(loadedModule(factory, parse(TWO_CONNECTIONS)), scheduler, {
      instanceId: 'button',
      connections: { topology: host },
    });

    scheduler.step();
    expect(calls.map((patch) => patch.connections[0]!.connectionId)).toEqual(['first', 'second']);
    scheduler.start();
    expect(topology.connectionState('button', 'first')).toBe('closed');
    expect(topology.connectionState('button', 'second')).toBe('closed');
  });

  it('submits patches from two instances in stable creation order', () => {
    const factory: DeviceFactory = (api: DeviceAPI) => {
      const initialize = api.ir.lifecycle('initialize', []);
      const first = api.ir.connection('first');
      initialize.body((b) => {
        b.connection.apply([{ connection: first, closed: b.const('bool', true) }]);
        b.return([]);
      });
      return { initialize };
    };
    const scheduler = createScheduler();
    const left = definitionFor(TWO_CONNECTIONS, 'left');
    const right = definitionFor(TWO_CONNECTIONS, 'right');
    const topology = createTopologyRuntime(
      scheduler,
      {
        pins: [...left.pins, ...right.pins],
        wires: [],
        connections: [...left.connections, ...right.connections],
      },
      {
        instanceId: 'topology:shared',
        pinStates: [...left.pins, ...right.pins].map((pin) =>
          pinState(pin.instanceId, pin.pinName),
        ),
      },
    );
    const { host, calls } = recorded(topology);
    for (const instanceId of ['left', 'right']) {
      createDeviceInstance(loadedModule(factory, parse(TWO_CONNECTIONS)), scheduler, {
        instanceId,
        connections: { topology: host },
      });
    }

    scheduler.start();
    expect(calls.map((patch) => patch.instanceId)).toEqual(['left', 'right']);
    expect(topology.connectionState('left', 'first')).toBe('closed');
    expect(topology.connectionState('right', 'first')).toBe('closed');
    expect(topology.connectionState('left', 'second')).toBe('open');
    expect(topology.connectionState('right', 'second')).toBe('open');
  });

  it('faults on an electrical conflict without rolling back the committed topology', () => {
    const factory: DeviceFactory = (api: DeviceAPI) => {
      const initialize = api.ir.lifecycle('initialize', []);
      const contact = api.ir.connection('contact');
      initialize.body((b) => {
        b.connection.apply([{ connection: contact, closed: b.const('bool', true) }]);
        b.return([]);
      });
      return { initialize };
    };
    const scheduler = createScheduler();
    const definition = definitionFor(BUTTON);
    const topology = createTopologyRuntime(scheduler, definition, {
      instanceId: 'topology:button',
      pinStates: [
        pinState('button', 'A', { high: true }),
        pinState('button', 'B', { high: false }),
      ],
    });
    const instance = createDeviceInstance(loadedModule(factory, parse(BUTTON)), scheduler, {
      instanceId: 'button',
      connections: { topology },
    });

    expect(() => scheduler.start()).toThrow(SchedulerError);
    expect(instance.state).toBe('faulted');
    expect(scheduler.error?.cause).toBeInstanceOf(ElectricalConflictError);
    expect(topology.connectionState('button', 'contact')).toBe('closed');
  });
});

describe('device connection diagnostics', () => {
  it('rejects apply without a bound topology at creation', () => {
    const factory: DeviceFactory = (api: DeviceAPI) => {
      const initialize = api.ir.lifecycle('initialize', []);
      const contact = api.ir.connection('contact');
      initialize.body((b) => {
        b.connection.apply([{ connection: contact, closed: b.const('bool', true) }]);
        b.return([]);
      });
      return { initialize };
    };
    const scheduler = createScheduler();
    deviceError(
      () =>
        createDeviceInstance(loadedModule(factory, parse(BUTTON)), scheduler, {
          instanceId: 'button',
        }),
      'device/connection-unavailable',
    );
  });

  it('rejects a connection missing from the bound topology', () => {
    const factory: DeviceFactory = (api: DeviceAPI) => {
      const initialize = api.ir.lifecycle('initialize', []);
      const contact = api.ir.connection('contact');
      initialize.body((b) => {
        b.connection.apply([{ connection: contact, closed: b.const('bool', true) }]);
        b.return([]);
      });
      return { initialize };
    };
    const scheduler = createScheduler();
    const definition = definitionFor(BUTTON);
    const topology = createTopologyRuntime(
      scheduler,
      { ...definition, connections: [] },
      {
        instanceId: 'topology:button',
        pinStates: definition.pins.map((pin) => pinState(pin.instanceId, pin.pinName)),
      },
    );
    const error = deviceError(
      () =>
        createDeviceInstance(loadedModule(factory, parse(BUTTON)), scheduler, {
          instanceId: 'button',
          connections: { topology },
        }),
      'device/connection-unknown',
    );
    expect(error.deviceId).toBe('acme:button');
  });

  it('rejects empty, duplicate, non-bool and cross-instance patches before commit', () => {
    const fresh = () => {
      const scheduler = createScheduler();
      const topology = createTopology(scheduler, BUTTON);
      return { scheduler, topology };
    };

    {
      const { scheduler, topology } = fresh();
      deviceError(
        () => createApplying(scheduler, topology, (b) => b.connection.apply([])),
        'device/connection-invalid',
      );
      expect(topology.connectionState('button', 'contact')).toBe('open');
    }

    {
      const { scheduler, topology } = fresh();
      deviceError(
        () =>
          createApplying(scheduler, topology, (b, api) => {
            const contact = api.ir.connection('contact');
            b.connection.apply([
              { connection: contact, closed: b.const('bool', true) },
              { connection: contact, closed: b.const('bool', false) },
            ]);
          }),
        'device/connection-invalid',
      );
      expect(topology.connectionState('button', 'contact')).toBe('open');
    }

    {
      const { scheduler, topology } = fresh();
      deviceError(
        () =>
          createApplying(scheduler, topology, (b, api) => {
            const contact = api.ir.connection('contact');
            b.connection.apply([
              {
                connection: contact,
                closed: b.const('u32', 1) as unknown as Value<'bool'>,
              },
            ]);
          }),
        'device/connection-invalid',
      );
      expect(topology.connectionState('button', 'contact')).toBe('open');
    }

    {
      let retained: ConnectionRef | undefined;
      const firstScheduler = createScheduler();
      const firstTopology = createTopology(firstScheduler, BUTTON, 'first');
      createApplying(
        firstScheduler,
        firstTopology,
        (_b, api) => {
          retained = api.ir.connection('contact');
        },
        'first',
      );
      expect(retained).toBeDefined();

      const { scheduler, topology } = fresh();
      deviceError(
        () =>
          createApplying(scheduler, topology, (b) => {
            b.connection.apply([{ connection: retained!, closed: b.const('bool', true) }]);
          }),
        'device/connection-invalid',
      );
      expect(topology.connectionState('button', 'contact')).toBe('open');
    }
  });

  it('returns one handle per id and closes the declaration surface after the factory', () => {
    let retained: DeviceAPI | undefined;
    let first: ConnectionRef | undefined;
    let second: ConnectionRef | undefined;
    setup((api) => {
      retained = api;
      first = api.ir.connection('contact');
      second = api.ir.connection('contact');
      return {};
    });
    expect(first).toBe(second);
    expect(() => retained!.ir.connection('contact')).toThrowError(
      expect.objectContaining({ code: 'device/factory-closed' }),
    );
  });

  it('rejects an undeclared connection id at declaration time', () => {
    const scheduler = createScheduler();
    const topology = createTopology(scheduler, BUTTON);
    const error = deviceError(
      () =>
        createDeviceInstance(
          loadedModule((api) => {
            api.ir.connection('missing');
            return {};
          }, parse(BUTTON)),
          scheduler,
          { instanceId: 'button', connections: { topology } },
        ),
      'device/connection-unknown',
    );
    expect(error.message).toContain('missing');
  });

  it('does not grant or validate forged connection declarations', () => {
    const module = createIRModule();
    const first = module.domainDeclaration('connection', 'ghost');
    const second = module.domainDeclaration('connection', 'phantom');
    const instruction = module.domainInstruction('connection.apply', {
      operands: [
        { kind: 'static-list', category: 'connection', minLength: 1 },
        { kind: 'value-list', type: 'bool', minLength: 1 },
      ],
      results: [],
    });
    const run = module.entry('run', []);
    run.body((b) => {
      b.invoke(instruction, [
        [first, second],
        [b.const('bool', true), b.const('bool', false)],
      ]);
      b.return([]);
    });

    const denied = validateIR(module, createValidationPolicy(module));
    expect(denied.ok).toBe(false);
    expect(denied.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'unauthorized-resource',
    );

    const description: ReadonlyMap<string, DeviceConnectionDescriptor> = new Map([
      ['ghost', { key: 'ghost', pins: ['A', 'B'] as const, initial: 'open' }],
      ['phantom', { key: 'phantom', pins: ['A', 'B'] as const, initial: 'open' }],
    ]);
    expect(validateIR(module, createValidationPolicy(module, description)).ok).toBe(true);
  });

  it('rejects mismatched and duplicate connection lists in supplied IR', () => {
    const module = createIRModule();
    const first = module.domainDeclaration('connection', 'ghost');
    const second = module.domainDeclaration('connection', 'phantom');
    const instruction = module.domainInstruction('connection.apply', {
      operands: [
        { kind: 'static-list', category: 'connection', minLength: 1 },
        { kind: 'value-list', type: 'bool', minLength: 1 },
      ],
      results: [],
    });
    const run = module.entry('run', []);
    run.body((b) => {
      b.invoke(instruction, [[first, second], [b.const('bool', true)]]);
      b.return([]);
    });
    const description: ReadonlyMap<string, DeviceConnectionDescriptor> = new Map([
      ['ghost', { key: 'ghost', pins: ['A', 'B'] as const, initial: 'open' }],
      ['phantom', { key: 'phantom', pins: ['A', 'B'] as const, initial: 'open' }],
    ]);
    const mismatch = validateIR(module, createValidationPolicy(module, description));
    expect(mismatch.ok).toBe(false);
    expect(mismatch.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'domain-validation',
    );

    const duplicate = createIRModule();
    const only = duplicate.domainDeclaration('connection', 'ghost');
    const duplicateInstruction = duplicate.domainInstruction('connection.apply', {
      operands: [
        { kind: 'static-list', category: 'connection', minLength: 1 },
        { kind: 'value-list', type: 'bool', minLength: 1 },
      ],
      results: [],
    });
    const duplicateRun = duplicate.entry('run', []);
    duplicateRun.body((b) => {
      b.invoke(duplicateInstruction, [
        [only, only],
        [b.const('bool', true), b.const('bool', false)],
      ]);
      b.return([]);
    });
    const duplicateResult = validateIR(
      duplicate,
      createValidationPolicy(duplicate, new Map([['ghost', description.get('ghost')!]])),
    );
    expect(duplicateResult.ok).toBe(false);
    expect(duplicateResult.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'domain-validation',
    );
  });

  it('rejects further patches after the topology is destroyed without rollback', () => {
    const factory: DeviceFactory = (api: DeviceAPI) => {
      const initialize = api.ir.lifecycle('initialize', []);
      const reset = api.ir.lifecycle('reset', []);
      const contact = api.ir.connection('contact');
      initialize.body((b) => {
        b.connection.apply([{ connection: contact, closed: b.const('bool', true) }]);
        b.return([]);
      });
      reset.body((b) => {
        b.connection.apply([{ connection: contact, closed: b.const('bool', false) }]);
        b.return([]);
      });
      return { initialize, reset };
    };
    const { scheduler, topology, instance } = setup(factory);
    scheduler.start();
    expect(topology.connectionState('button', 'contact')).toBe('closed');

    instance.reset();
    topology.destroy();
    expect(() => scheduler.start()).toThrow(SchedulerError);
    expect(instance.state).toBe('faulted');
    expect(errorCodes(scheduler.error)).toContain('device/connection-unavailable');
  });

  it('keeps a committed patch when a later submit is rejected', () => {
    const factory: DeviceFactory = (api: DeviceAPI) => {
      const initialize = api.ir.lifecycle('initialize', []);
      const reset = api.ir.lifecycle('reset', []);
      const contact = api.ir.connection('contact');
      initialize.body((b) => {
        b.connection.apply([{ connection: contact, closed: b.const('bool', true) }]);
        b.return([]);
      });
      reset.body((b) => {
        b.connection.apply([{ connection: contact, closed: b.const('bool', false) }]);
        b.return([]);
      });
      return { initialize, reset };
    };
    const scheduler = createScheduler();
    const topology = createTopology(scheduler, BUTTON);
    let submits = 0;
    const host: TopologyRuntime = {
      instance: topology.instance,
      submit: (patch) => {
        submits += 1;
        if (submits === 2) {
          throw new SchedulerError('execution-failed', 'injected submit failure', {
            timePs: scheduler.now,
          });
        }
        topology.submit(patch);
      },
      updatePinStates: (states) => topology.updatePinStates(states),
      refresh: (pins) => topology.refresh(pins),
      connectionState: (instanceId, connectionId) =>
        topology.connectionState(instanceId, connectionId),
      networks: () => topology.networks(),
      networkOf: (pin) => topology.networkOf(pin),
      floatingInput: (pin) => topology.floatingInput(pin),
      destroy: () => topology.destroy(),
    };
    const instance = createDeviceInstance(loadedModule(factory, parse(BUTTON)), scheduler, {
      instanceId: 'button',
      connections: { topology: host },
    });
    scheduler.start();
    expect(topology.connectionState('button', 'contact')).toBe('closed');

    instance.reset();
    expect(() => scheduler.start()).toThrow(SchedulerError);
    expect(instance.state).toBe('faulted');
    expect(errorCodes(scheduler.error)).toContain('device/connection-unavailable');
    expect(topology.connectionState('button', 'contact')).toBe('closed');
  });

  it('does not apply a queued connection after the device is destroyed', () => {
    const factory: DeviceFactory = (api: DeviceAPI) => {
      const initialize = api.ir.lifecycle('initialize', []);
      const contact = api.ir.connection('contact');
      initialize.body((b) => {
        b.connection.apply([{ connection: contact, closed: b.const('bool', true) }]);
        b.return([]);
      });
      return { initialize };
    };
    const { scheduler, topology, instance } = setup(factory);
    instance.destroy();
    scheduler.start();
    expect(topology.connectionState('button', 'contact')).toBe('open');
  });
});
