import { describe, expect, it } from 'vitest';
import type { ElectricalPinInput, PowerDigitalPinChange, PowerDigitalSample } from '@mica-js/core';
import {
  createIRModule,
  validateIR,
  type IRModule,
  type RuntimeScalar,
  type ScalarType,
} from '@mica-js/ir';
import { DeviceError } from '../errors';
import { createValidationPolicy } from '../lifecycle/policy';
import { PinDomain } from '../pins/domain';
import type { DevicePinDescriptor, DevicePinHost } from '../types';
import { ObserveDomain } from './domain';
import type { ObserveRuntime } from './runtime';
import { ENGINES } from '../testing/engines';

describe.each(ENGINES)('$name engine', ({ create }) => {
  const MODEL = Object.freeze({
    kind: 'ideal-voltage' as const,
    minVoltage: 0,
    maxVoltage: 5,
    lowVoltage: 0,
    highVoltage: 5,
  });

  function pin(kind: DevicePinDescriptor['kind'], key: string): DevicePinDescriptor {
    return { key, kind, side: 'left' };
  }

  function setup() {
    const moduleRef: { current?: IRModule } = {};
    const pins = new PinDomain(
      new Map([
        ['IN', pin('signal', 'IN')],
        ['CAP', pin('signal', 'CAP')],
        ['VDD', pin('power', 'VDD')],
      ]),
      () => moduleRef.current!,
      'acme:observe',
    );
    const observes = new ObserveDomain(pins.catalog, () => moduleRef.current!, 'acme:observe');
    const module = createIRModule({ builderExtensions: [pins.extension, observes.extension] });
    moduleRef.current = module;
    pins.instructions();
    observes.instructions();
    return { module, pins, observes };
  }

  function emptyEntry(module: IRModule, name: string, params: readonly ScalarType[]) {
    const entry = module.entry(name, params);
    entry.body((b) => b.return([]));
    return entry;
  }

  function intent(pinName: string): ElectricalPinInput {
    return {
      instanceId: 'dev',
      pinName,
      powerReady: true,
      mode: 'high-z',
      outputEnabled: false,
      pull: 'none',
      model: MODEL,
    };
  }

  interface FakeHost {
    readonly host: DevicePinHost;
    setSample(
      pinName: string,
      value: 0 | 1,
      options?: {
        readonly ready?: boolean;
        readonly source?: 'sampled' | 'floating' | 'threshold-range' | 'gated';
      },
    ): void;
    disposeCalls(): number;
  }

  function fakeHost(initial: readonly string[] = ['IN', 'CAP']): FakeHost {
    const samples = new Map<string, PowerDigitalSample>(
      initial.map((name) => [name, { value: 0 as const, ready: true, source: 'sampled' as const }]),
    );
    let observer:
      { onDigitalPinChange(changes: readonly PowerDigitalPinChange[]): void } | undefined;
    let disposed = 0;
    return {
      host: {
        pinIntent: (ref) => intent(ref.pinName),
        updatePinStates: () => undefined,
        sampleDigital: (ref) => {
          const sample = samples.get(ref.pinName);
          if (sample === undefined) throw new Error(`missing sample ${ref.pinName}`);
          return sample;
        },
        addDigitalPinObserver: (value) => {
          observer = value as typeof observer;
          return () => {
            disposed += 1;
            observer = undefined;
          };
        },
      },
      setSample(pinName, value, options = {}) {
        const sample = {
          value,
          ready: options.ready ?? true,
          source: options.source ?? 'sampled',
        };
        samples.set(pinName, sample);
        observer?.onDigitalPinChange([{ instanceId: 'dev', pinName, sample }]);
      },
      disposeCalls: () => disposed,
    };
  }

  interface Enqueued {
    readonly target: object;
    readonly args: readonly RuntimeScalar[];
  }

  function runtimeFor(
    observes: ObserveDomain,
    host: DevicePinHost | undefined,
  ): { readonly runtime: ObserveRuntime; readonly enqueued: Enqueued[] } {
    const runtime = observes.createRuntime('dev', host);
    runtime.assertReady();
    const enqueued: Enqueued[] = [];
    runtime.attach({
      enqueueMessage(target, args) {
        enqueued.push({ target, args });
        return enqueued.length;
      },
    });
    runtime.register();
    return { runtime, enqueued };
  }

  function interpreterFor(
    module: IRModule,
    pins: PinDomain,
    observes: ObserveDomain,
    runtime: ObserveRuntime,
  ) {
    return create(module, {
      validation: createValidationPolicy(module, new Map(), [
        ...pins.validators(),
        ...observes.validators(),
      ]),
      executors: runtime.executors(),
    });
  }

  function expectCode(run: () => unknown, code: DeviceError['code']): void {
    let caught: unknown;
    try {
      run();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DeviceError);
    expect((caught as DeviceError).code).toBe(code);
  }

  describe('observation declarations and instructions', () => {
    it('lowers configure with the approved edge encoding and validates the target signature', () => {
      const { module, pins, observes } = setup();
      const trigger = pins.catalog.declare(module, 'IN', 'acme:observe');
      const capture = pins.catalog.declare(module, 'CAP', 'acme:observe');
      const onEdge = module.entry('onEdge', ['u8', 'u32']);
      onEdge.body((b) => b.return([]));
      const observer = observes.declare(module, 'edge', {
        trigger,
        captures: [capture],
        target: onEdge,
      });
      const enable = module.entry('enable', []);
      enable.body((b) => {
        b.observe.configure(observer, { enabled: true, edges: 'both' });
        b.return([]);
      });
      const configure = module.functions
        .flatMap((fn) => fn.body?.blocks ?? [])
        .flatMap((block) => block.instructions)
        .find((instruction) => instruction.op === 'observe.configure');
      expect(configure?.operands).toEqual([
        { kind: 'static', ref: observer },
        { kind: 'literal', value: true },
        { kind: 'literal', value: 3 },
      ]);
      expect(
        validateIR(
          module,
          createValidationPolicy(module, new Map(), [
            ...pins.validators(),
            ...observes.validators(),
          ]),
        ).ok,
      ).toBe(true);
      expect(() => observes.assertReady(module)).not.toThrow();

      const host = fakeHost();
      const { runtime } = runtimeFor(observes, host.host);
      interpreterFor(module, pins, observes, runtime).execute(enable, [], {
        instanceId: 'dev',
        virtualTime: 0,
      });
    });

    it('rejects unknown, cross-device and non-signal observation pins', () => {
      const { module, pins, observes } = setup();
      const vdd = pins.catalog.declare(module, 'VDD', 'acme:observe');
      const onEdge = emptyEntry(module, 'onEdge', ['u8']);
      expectCode(
        () =>
          observes.declare(module, 'power', {
            trigger: vdd,
            captures: [],
            target: onEdge,
          }),
        'device/observe-pin',
      );
      expectCode(
        () =>
          observes.declare(module, 'capture', {
            trigger: pins.catalog.declare(module, 'IN', 'acme:observe'),
            captures: [vdd],
            target: onEdge,
          }),
        'device/observe-pin',
      );
      expectCode(
        () =>
          observes.declare(module, 'unknown', {
            trigger: { unknown: true } as never,
            captures: [],
            target: onEdge,
          }),
        'device/observe-pin',
      );
    });

    it('rejects duplicate names, invalid descriptors and mismatched targets at link', () => {
      const { module, pins, observes } = setup();
      const trigger = pins.catalog.declare(module, 'IN', 'acme:observe');
      const onEdge = emptyEntry(module, 'onEdge', ['u8']);
      observes.declare(module, 'edge', { trigger, captures: [], target: onEdge });
      expectCode(
        () => observes.declare(module, 'edge', { trigger, captures: [], target: onEdge }),
        'device/observe-binding',
      );
      expectCode(
        () => observes.declare(module, 'bad', { trigger, captures: 'no', target: onEdge }),
        'device/observe-binding',
      );
      expectCode(
        () => observes.declare(module, 'extra', { trigger, captures: [], target: onEdge, nope: 1 }),
        'device/observe-binding',
      );

      const short = emptyEntry(module, 'short', ['u8', 'u32']);
      observes.declare(module, 'observeShort', { trigger, captures: [], target: short as never });
      expectCode(() => observes.assertReady(module), 'device/observe-binding');

      const second = setup();
      const lifecycle = second.module.lifecycle('init', ['u8']);
      expectCode(
        () =>
          second.observes.declare(second.module, 'lifecycle', {
            trigger: second.pins.catalog.declare(second.module, 'IN', 'acme:observe'),
            captures: [],
            target: lifecycle,
          }),
        'device/observe-binding',
      );
    });

    it('rejects invalid builder configurations with observe-config', () => {
      const { module, pins, observes } = setup();
      const trigger = pins.catalog.declare(module, 'IN', 'acme:observe');
      const onEdge = emptyEntry(module, 'onEdge', ['u8']);
      const observer = observes.declare(module, 'edge', { trigger, captures: [], target: onEdge });
      const unknown = module.entry('unknownObserver', []);
      expectCode(
        () =>
          unknown.body((b) => {
            b.observe.configure({ other: true } as never, { enabled: true, edges: 'rising' });
            b.return([]);
          }),
        'device/observe-config',
      );
      const badEdge = module.entry('badEdge', []);
      expectCode(
        () =>
          badEdge.body((b) => {
            b.observe.configure(observer, { enabled: true, edges: 'state' as never });
            b.return([]);
          }),
        'device/observe-config',
      );
      const badEnabled = module.entry('badEnabled', []);
      expectCode(
        () =>
          badEnabled.body((b) => {
            b.observe.configure(observer, { enabled: 1 as never, edges: 'rising' });
            b.return([]);
          }),
        'device/observe-config',
      );
    });

    it('rejects edges=0 through the instruction validator', () => {
      const { module, pins, observes } = setup();
      const trigger = pins.catalog.declare(module, 'IN', 'acme:observe');
      const onEdge = emptyEntry(module, 'onEdge', ['u8']);
      const observer = observes.declare(module, 'edge', { trigger, captures: [], target: onEdge });
      const run = module.entry('run', []);
      run.body((b) => {
        b.invoke(observes.instructions().configure, [observer, true, 0]);
        b.return([]);
      });
      const result = validateIR(
        module,
        createValidationPolicy(module, new Map(), [...pins.validators(), ...observes.validators()]),
      );
      expect(result.ok).toBe(false);
      expect(result.diagnostics.map((diagnostic) => diagnostic.message).join('\n')).toMatch(
        /1, 2, or 3/,
      );
    });
  });

  describe('observation runtime baseline and delivery', () => {
    it('initializes without a false edge, selects edges, and fixes capture payloads', () => {
      const { module, pins, observes } = setup();
      const trigger = pins.catalog.declare(module, 'IN', 'acme:observe');
      const capture = pins.catalog.declare(module, 'CAP', 'acme:observe');
      const onEdge = emptyEntry(module, 'onEdge', ['u8', 'u32']);
      const observer = observes.declare(module, 'edge', {
        trigger,
        captures: [capture],
        target: onEdge,
      });
      const enable = module.entry('enable', []);
      enable.body((b) => {
        b.observe.configure(observer, { enabled: true, edges: 'both' });
        b.return([]);
      });
      const host = fakeHost();
      const { runtime, enqueued } = runtimeFor(observes, host.host);
      const interpreter = interpreterFor(module, pins, observes, runtime);
      interpreter.execute(enable, [], { instanceId: 'dev', virtualTime: 0 });
      expect(enqueued).toEqual([]);

      host.setSample('CAP', 1);
      host.setSample('IN', 1);
      expect(enqueued).toEqual([{ target: onEdge, args: [1, 1] }]);
      host.setSample('CAP', 0);
      expect(enqueued[0]!.args).toEqual([1, 1]);

      host.setSample('IN', 0);
      expect(enqueued.at(-1)!.args).toEqual([2, 0]);
      host.setSample('IN', 0);
      expect(enqueued).toHaveLength(2);
    });

    it('does not report an edge for the level present at first enable', () => {
      const { module, pins, observes } = setup();
      const trigger = pins.catalog.declare(module, 'IN', 'acme:observe');
      const onEdge = emptyEntry(module, 'onEdge', ['u8']);
      const observer = observes.declare(module, 'edge', { trigger, captures: [], target: onEdge });
      const enable = module.entry('enable', []);
      enable.body((b) => {
        b.observe.configure(observer, { enabled: true, edges: 'both' });
        b.return([]);
      });
      const host = fakeHost();
      host.setSample('IN', 1);
      const { runtime, enqueued } = runtimeFor(observes, host.host);
      interpreterFor(module, pins, observes, runtime).execute(enable, [], {
        instanceId: 'dev',
        virtualTime: 0,
      });
      expect(enqueued).toHaveLength(0);
      host.setSample('IN', 0);
      expect(enqueued).toEqual([{ target: onEdge, args: [2] }]);
    });

    it('rebuilds the baseline on explicit configure, disable and gating recovery', () => {
      const { module, pins, observes } = setup();
      const trigger = pins.catalog.declare(module, 'IN', 'acme:observe');
      const onEdge = emptyEntry(module, 'onEdge', ['u8']);
      const observer = observes.declare(module, 'edge', { trigger, captures: [], target: onEdge });
      const configureBoth = module.entry('configureBoth', []);
      configureBoth.body((b) => {
        b.observe.configure(observer, { enabled: true, edges: 'both' });
        b.return([]);
      });
      const disable = module.entry('disable', []);
      disable.body((b) => {
        b.observe.configure(observer, { enabled: false, edges: 'both' });
        b.return([]);
      });
      const host = fakeHost();
      const { runtime, enqueued } = runtimeFor(observes, host.host);
      const interpreter = interpreterFor(module, pins, observes, runtime);
      interpreter.execute(configureBoth, [], { instanceId: 'dev', virtualTime: 0 });

      host.setSample('IN', 1);
      expect(enqueued).toHaveLength(1);
      interpreter.execute(configureBoth, [], { instanceId: 'dev', virtualTime: 0 });
      expect(enqueued).toHaveLength(1);
      host.setSample('IN', 0);
      expect(enqueued).toHaveLength(2);

      interpreter.execute(disable, [], { instanceId: 'dev', virtualTime: 0 });
      host.setSample('IN', 1);
      expect(enqueued).toHaveLength(2);
      interpreter.execute(configureBoth, [], { instanceId: 'dev', virtualTime: 0 });
      expect(enqueued).toHaveLength(2);

      host.setSample('IN', 0, { ready: false, source: 'gated' });
      host.setSample('IN', 1, { ready: true, source: 'sampled' });
      expect(enqueued).toHaveLength(2);
      host.setSample('IN', 0);
      expect(enqueued).toHaveLength(3);
    });

    it('treats floating and indeterminate intervals as baseline rebuilds', () => {
      const { module, pins, observes } = setup();
      const trigger = pins.catalog.declare(module, 'IN', 'acme:observe');
      const onEdge = emptyEntry(module, 'onEdge', ['u8']);
      const observer = observes.declare(module, 'edge', { trigger, captures: [], target: onEdge });
      const enable = module.entry('enable', []);
      enable.body((b) => {
        b.observe.configure(observer, { enabled: true, edges: 'both' });
        b.return([]);
      });
      const host = fakeHost();
      const { runtime, enqueued } = runtimeFor(observes, host.host);
      interpreterFor(module, pins, observes, runtime).execute(enable, [], {
        instanceId: 'dev',
        virtualTime: 0,
      });

      host.setSample('IN', 0, { source: 'floating' });
      host.setSample('IN', 1, { source: 'sampled' });
      expect(enqueued).toHaveLength(0);
      host.setSample('IN', 0, { source: 'threshold-range' });
      host.setSample('IN', 1, { source: 'sampled' });
      expect(enqueued).toHaveLength(0);
      host.setSample('IN', 0, { source: 'sampled' });
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]!.args).toEqual([2]);
    });

    it('delivers in declaration order and unsubscribes on release', () => {
      const { module, pins, observes } = setup();
      const trigger = pins.catalog.declare(module, 'IN', 'acme:observe');
      const first = emptyEntry(module, 'first', ['u8']);
      const second = emptyEntry(module, 'second', ['u8']);
      const firstObserver = observes.declare(module, 'observeFirst', {
        trigger,
        captures: [],
        target: first,
      });
      const secondObserver = observes.declare(module, 'observeSecond', {
        trigger,
        captures: [],
        target: second,
      });
      const enable = module.entry('enable', []);
      enable.body((b) => {
        b.observe.configure(firstObserver, { enabled: true, edges: 'rising' });
        b.observe.configure(secondObserver, { enabled: true, edges: 'rising' });
        b.return([]);
      });
      const host = fakeHost();
      const { runtime, enqueued } = runtimeFor(observes, host.host);
      interpreterFor(module, pins, observes, runtime).execute(enable, [], {
        instanceId: 'dev',
        virtualTime: 0,
      });
      host.setSample('IN', 1);
      expect(enqueued.map((entry) => entry.target)).toEqual([first, second]);
      runtime.release();
      expect(host.disposeCalls()).toBe(1);
      host.setSample('IN', 0);
      host.setSample('IN', 1);
      expect(enqueued).toHaveLength(2);
    });
  });
});
