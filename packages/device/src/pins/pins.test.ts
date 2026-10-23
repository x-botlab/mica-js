import { describe, expect, it, vi } from 'vitest';
import type { ElectricalPinInput } from '@mica-js/core';
import {
  createIRModule,
  IRConstructionError,
  IRExecutionError,
  type EntryRef,
  type IRModule,
  type StateRef,
} from '@mica-js/ir';
import { DeviceError } from '../errors';
import { createValidationPolicy } from '../lifecycle/policy';
import type { DevicePinDescriptor, DevicePinHost } from '../types';
import { PinDomain } from './domain';
import { ENGINES } from '../testing/engines';

describe.each(ENGINES)('$name engine', ({ create }) => {
  const MODEL = Object.freeze({
    kind: 'ideal-voltage' as const,
    minVoltage: 0,
    maxVoltage: 5,
    lowVoltage: 0,
    highVoltage: 5,
  });

  function pin(
    kind: DevicePinDescriptor['kind'],
    key: string,
    extra: Partial<DevicePinDescriptor> = {},
  ): DevicePinDescriptor {
    return { key, kind, side: 'left', ...extra };
  }

  function setup(
    descriptors: Readonly<Record<string, DevicePinDescriptor>> = {
      OUT: pin('signal', 'OUT'),
      IN: pin('signal', 'IN'),
      VDD: pin('power', 'VDD'),
    },
  ) {
    const moduleRef: { current?: IRModule } = {};
    const domain = new PinDomain(
      new Map(Object.entries(descriptors)),
      () => moduleRef.current!,
      'acme:pins',
    );
    const module = createIRModule({ builderExtensions: [domain.extension] });
    moduleRef.current = module;
    domain.instructions();
    return { module, domain };
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

  function fakeHost(sample: 0 | 1 = 1): {
    readonly host: DevicePinHost;
    readonly submissions: ElectricalPinInput[];
    readonly samples: ReturnType<typeof vi.fn>;
  } {
    const submissions: ElectricalPinInput[] = [];
    const samples = vi.fn(() => ({ value: sample, ready: true, source: 'sampled' as const }));
    return {
      submissions,
      samples,
      host: {
        pinIntent: (ref) => intent(ref.pinName),
        updatePinStates: (states) => {
          submissions.push(...states);
        },
        sampleDigital: samples,
      },
    };
  }

  function interpreterFor(module: IRModule, domain: PinDomain, host: DevicePinHost | undefined) {
    const runtime = domain.createRuntime('dev', host);
    const references = domain.references(module);
    runtime.assertReady(references);
    runtime.prepare(references);
    return {
      runtime,
      interpreter: create(module, {
        validation: createValidationPolicy(module, new Map(), domain.validators()),
        executors: runtime.executors(),
      }),
    };
  }

  function executeEntry(
    module: IRModule,
    domain: PinDomain,
    host: DevicePinHost | undefined,
    target: EntryRef,
  ) {
    const { interpreter } = interpreterFor(module, domain, host);
    interpreter.execute(target, [], { instanceId: 'dev', virtualTime: 0 });
    return interpreter;
  }

  describe('pin declarations and builder operations', () => {
    it('rejects unknown and invalid pin ids', () => {
      const { module, domain } = setup();
      expect(() => domain.catalog.declare(module, 'NOPE', 'acme:pins')).toThrowError(DeviceError);
      try {
        domain.catalog.declare(module, 'NOPE', 'acme:pins');
      } catch (error) {
        expect((error as DeviceError).code).toBe('device/pin-unknown');
      }
      expect(() => domain.catalog.declare(module, '', 'acme:pins')).toThrowError(DeviceError);
    });

    it('returns the same static ref for repeated declarations', () => {
      const { module, domain } = setup();
      const first = domain.catalog.declare(module, 'OUT', 'acme:pins');
      const second = domain.catalog.declare(module, 'OUT', 'acme:pins');
      expect(second).toBe(first);
    });

    it('lowers configure/write/sample to explicit instructions and executes them', () => {
      const { module, domain } = setup();
      const out = domain.catalog.declare(module, 'OUT', 'acme:pins');
      const result = module.state('result', 'u32', 0);
      const entry = module.entry('run', []);
      entry.body((b) => {
        b.pin.configure(out, { mode: 'push-pull', outputEnabled: true, pull: 'none' });
        b.pin.writeDigital(out, b.const('bool', true));
        b.state.store(result, b.pin.sampleDigital(out));
        b.return([]);
      });
      const { host, submissions, samples } = fakeHost(1);
      const interpreter = executeEntry(module, domain, host, entry);
      expect(submissions.map((item) => item.mode)).toEqual(['high-z', 'push-pull', 'push-pull']);
      expect(submissions[1]).toMatchObject({ outputEnabled: true, pull: 'none' });
      expect(submissions[2]).toMatchObject({
        outputEnabled: true,
        digitalIntent: true,
        model: MODEL,
      });
      expect(samples).toHaveBeenCalledWith({ instanceId: 'dev', pinName: 'OUT' });
      expect(interpreter.storage.loadState(result)).toBe(1);
    });

    it('stores the canonical u32 sample value in IR state', () => {
      const { module, domain } = setup();
      const out = domain.catalog.declare(module, 'OUT', 'acme:pins');
      const result: StateRef<'u32'> = module.state('result', 'u32', 99);
      const entry = module.entry('run', []);
      entry.body((b) => {
        b.state.store(result, b.pin.sampleDigital(out));
        b.return([]);
      });
      const interpreter = executeEntry(module, domain, fakeHost(0).host, entry);
      expect(interpreter.storage.loadState(result)).toBe(0);
    });

    it('rejects non-signal pins in the builder', () => {
      const { module, domain } = setup();
      const vdd = domain.catalog.declare(module, 'VDD', 'acme:pins');
      const entry = module.entry('run', []);
      expect(() =>
        entry.body((b) => {
          b.pin.writeDigital(vdd, b.const('bool', true));
          b.return([]);
        }),
      ).toThrow(IRConstructionError);
    });

    it('rejects type and configuration errors in the builder', () => {
      const { module, domain } = setup();
      const out = domain.catalog.declare(module, 'OUT', 'acme:pins');
      const wrongType = module.entry('wrongType', []);
      expect(() =>
        wrongType.body((b) => {
          // @ts-expect-error digital output requires a bool SSA value
          b.pin.writeDigital(out, b.const('u32', 1));
          b.return([]);
        }),
      ).toThrow(IRConstructionError);
      const badMode = module.entry('badMode', []);
      expect(() =>
        badMode.body((b) => {
          b.pin.configure(out, {
            mode: 'totally-invalid' as never,
            outputEnabled: true,
            pull: 'none',
          });
          b.return([]);
        }),
      ).toThrow(IRConstructionError);
    });

    it('rejects refs from another IR module', () => {
      const first = setup();
      const second = setup();
      const foreign = second.domain.catalog.declare(second.module, 'OUT', 'acme:pins');
      const entry = first.module.entry('run', []);
      expect(() =>
        entry.body((b) => {
          b.pin.writeDigital(foreign, b.const('bool', true));
          b.return([]);
        }),
      ).toThrow(IRConstructionError);
    });

    it('validates config literals and pin kinds at link time', () => {
      const { module, domain } = setup();
      const out = domain.catalog.declare(module, 'OUT', 'acme:pins');
      const vdd = domain.catalog.declare(module, 'VDD', 'acme:pins');
      const instructions = domain.instructions();
      module.entry('badConfig', []).body((b) => {
        b.invoke(instructions.configure, [out, 4, true, 0]);
        b.return([]);
      });
      module.entry('badPin', []).body((b) => {
        b.invoke(instructions.sampleDigital, [vdd]);
        b.return([]);
      });
      const validation = createValidationPolicy(module, new Map(), domain.validators());
      try {
        create(module, { validation });
        throw new Error('Expected validation failure');
      } catch (error) {
        expect(error).toBeInstanceOf(IRExecutionError);
        const diagnostics = (error as IRExecutionError).diagnostics;
        expect(diagnostics.some((item) => item.code === 'domain-validation')).toBe(true);
        expect(diagnostics.some((item) => item.message.includes('mode must be an integer'))).toBe(
          true,
        );
        expect(diagnostics.some((item) => item.message.includes('does not support I/O'))).toBe(
          true,
        );
      }
    });

    it('requires a host when pin instructions reference pins', () => {
      const { module, domain } = setup();
      const out = domain.catalog.declare(module, 'OUT', 'acme:pins');
      module.entry('run', []).body((b) => {
        b.pin.sampleDigital(out);
        b.return([]);
      });
      const runtime = domain.createRuntime('dev', undefined);
      expect(() => runtime.assertReady(domain.references(module))).toThrowError(DeviceError);
      try {
        runtime.assertReady(domain.references(module));
      } catch (error) {
        expect((error as DeviceError).code).toBe('device/pin-io-unavailable');
      }
    });

    it('collects and sorts referenced pin ids', () => {
      const { module, domain } = setup();
      const out = domain.catalog.declare(module, 'OUT', 'acme:pins');
      const input = domain.catalog.declare(module, 'IN', 'acme:pins');
      module.entry('run', []).body((b) => {
        b.pin.sampleDigital(out);
        b.pin.sampleDigital(input);
        b.return([]);
      });
      expect(domain.references(module)).toEqual(['IN', 'OUT']);
    });
  });
});
