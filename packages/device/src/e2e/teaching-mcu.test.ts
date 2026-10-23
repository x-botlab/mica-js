import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  createPowerRuntime,
  createScheduler,
  type ElectricalPinInput,
  type PowerDefinition,
  type PowerRuntime,
  type Scheduler,
  type TopologyDefinition,
} from '@mica-js/core';
import type { EntryRef, StateRef } from '@mica-js/ir';
import {
  createDeviceInstance,
  loadDeviceModule,
  parseDeviceDescription,
  type DeviceAPI,
  type DeviceFactory,
  type DeviceInstance,
  type DeviceIRDeclarations,
  type IDeviceProvider,
  type LoadedDeviceModule,
} from '../index';
import { TEACHING_MCU_DEVICE_ID, exampleProvider, readExampleDescription } from './test-helpers';

const MCU_EXAMPLE = new URL('../../examples/teaching-mcu/teaching-mcu.js', import.meta.url);
const DEFAULT_FIRMWARE = Object.freeze([0x10, 1, 0x10, 2, 0x30, 8, 0x00, 0x00, 0x10, 4, 0x20, 0]);

function patchUnit0(overrides: Readonly<Record<number, number>>): Uint8Array {
  const bytes = Uint8Array.from(DEFAULT_FIRMWARE.slice(0, 8));
  for (const [index, value] of Object.entries(overrides)) {
    bytes[Number(index)] = value;
  }
  return bytes;
}

interface Trace {
  /** Provider generation calls per key (PC), in generation order. */
  readonly generations: Map<number, number>;
  readonly generatedKeys: number[];
  readonly states: Map<string, StateRef>;
  readonly entries: Map<string, EntryRef>;
  api?: DeviceAPI;
}

interface Instrumented {
  readonly loaded: LoadedDeviceModule;
  readonly trace: Trace;
}

/**
 * Wraps the factory's declaration surface only to observe it. The real factory body, Provider
 * callback, IR validation/linking, scheduler, pins and messaging all stay in the tested path.
 */
function instrument(loaded: LoadedDeviceModule): Instrumented {
  const trace: Trace = {
    generations: new Map(),
    generatedKeys: [],
    states: new Map(),
    entries: new Map(),
  };
  const factory: DeviceFactory = (api) => {
    const target = api.ir;
    const ir = new Proxy(target, {
      get(declarations, property, receiver) {
        if (property === 'state') {
          const declare = Reflect.get(declarations, property, declarations) as (
            name: string,
            type: string,
            initial: unknown,
          ) => StateRef;
          return (name: string, type: string, initial: unknown) => {
            const ref = declare(name, type, initial);
            trace.states.set(name, ref);
            return ref;
          };
        }
        if (property === 'entry') {
          const declare = Reflect.get(declarations, property, declarations) as (
            name: string,
            params: readonly string[],
          ) => EntryRef;
          return (name: string, params: readonly string[]) => {
            const ref = declare(name, params);
            trace.entries.set(name, ref);
            return ref;
          };
        }
        if (property === 'provider') {
          const declare = Reflect.get(declarations, property, declarations) as (
            name: string,
            descriptor: unknown,
            generate: (gen: never, key: readonly number[]) => unknown,
          ) => unknown;
          return (
            name: string,
            descriptor: unknown,
            generate: (gen: never, key: readonly number[]) => unknown,
          ) =>
            declare(name, descriptor, (gen, key) => {
              const address = key[0]!;
              trace.generatedKeys.push(address);
              trace.generations.set(address, (trace.generations.get(address) ?? 0) + 1);
              return generate(gen, key);
            });
        }
        const value: unknown = Reflect.get(declarations, property, receiver);
        return typeof value === 'function' ? value.bind(declarations) : value;
      },
    }) as DeviceIRDeclarations;
    const wrapped: DeviceAPI = { ...api, ir };
    trace.api = wrapped;
    return loaded.factory(wrapped);
  };
  return { loaded: { ...loaded, factory }, trace };
}

const MODEL = Object.freeze({
  kind: 'ideal-voltage' as const,
  minVoltage: 0,
  maxVoltage: 5,
  lowVoltage: 0,
  highVoltage: 5,
});

function pinState(
  instanceId: string,
  pinName: string,
  overrides: Partial<ElectricalPinInput> = {},
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

/** Small host board: the MCU's GPIO drives a pulled-down sense net on the board domain. */
function createGpioBoard(scheduler: Scheduler): PowerRuntime {
  const topology: TopologyDefinition = {
    pins: [
      { instanceId: 'board', pinName: 'VCC', kind: 'power' },
      { instanceId: 'board', pinName: 'GND', kind: 'gnd' },
      { instanceId: 'board', pinName: 'SENSE', kind: 'signal' },
      { instanceId: 'mcu', pinName: 'GPIO', kind: 'signal' },
    ],
    wires: [
      {
        wireId: 'ground',
        pins: [{ instanceId: 'board', pinName: 'GND' }],
        globalGnd: true,
      },
      {
        wireId: 'gpio',
        pins: [
          { instanceId: 'mcu', pinName: 'GPIO' },
          { instanceId: 'board', pinName: 'SENSE' },
        ],
      },
    ],
    connections: [],
  };
  const power: PowerDefinition = {
    topology,
    devices: [
      {
        instanceId: 'board',
        powerDomains: {
          logic: { supply: 'VCC', ground: 'GND', voltage: { turnOn: 3, turnOff: 2 } },
        },
        pins: { SENSE: { powerDomain: 'logic' } },
      },
    ],
  };
  return createPowerRuntime(scheduler, power, {
    instanceId: 'mcu-power',
    pinStates: [
      pinState('board', 'VCC', {
        mode: 'analog',
        outputEnabled: true,
        voltageIntent: 5,
      }),
      pinState('board', 'GND'),
      pinState('board', 'SENSE', { pull: 'down' }),
      pinState('mcu', 'GPIO'),
    ],
  });
}

interface McuContext {
  readonly scheduler: Scheduler;
  readonly power: PowerRuntime;
  readonly device: DeviceInstance;
  readonly trace: Trace;
  runUntil(timePs: number): void;
  /** Runs the single posted/message entry and flushes same-time control work. */
  runOneEntry(): void;
  sampleGpio(): 0 | 1;
  loadU32(name: string): number;
  loadBool(name: string): boolean;
  storeU32(name: string, value: number): void;
  postStep(): Promise<void>;
}

async function withTeachingMcu(
  run: (context: McuContext) => void | Promise<void>,
  options: { readonly code?: string } = {},
): Promise<void> {
  const scheduler = createScheduler();
  const power = createGpioBoard(scheduler);
  const loaded =
    options.code === undefined
      ? await loadDeviceModule(TEACHING_MCU_DEVICE_ID, exampleProvider())
      : await loadModifiedExample(options.code);
  const instrumented = instrument(loaded);
  const device = createDeviceInstance(instrumented.loaded, scheduler, {
    instanceId: 'mcu',
    pinHost: power,
    updateResources: ['firmware'],
  });
  const state = (name: string): StateRef => {
    const ref = instrumented.trace.states.get(name);
    if (ref === undefined) {
      throw new Error(`Missing state ${name}`);
    }
    return ref;
  };
  const context: McuContext = {
    scheduler,
    power,
    device,
    trace: instrumented.trace,
    runUntil(timePs: number): void {
      const result = scheduler.start({ until: timePs });
      if (scheduler.state === 'faulted') {
        throw scheduler.error ?? new Error('Scheduler faulted without an error');
      }
      expect(result.timePs).toBe(timePs);
    },
    runOneEntry(): void {
      scheduler.step();
      if (scheduler.state === 'faulted') {
        throw scheduler.error ?? new Error('Scheduler faulted without an error');
      }
      scheduler.start({ until: scheduler.now });
    },
    sampleGpio(): 0 | 1 {
      return power.sampleDigital({ instanceId: 'board', pinName: 'SENSE' }).value;
    },
    loadU32(name: string): number {
      return device.storage.loadState(state(name) as StateRef<'u32'>);
    },
    loadBool(name: string): boolean {
      return device.storage.loadState(state(name) as StateRef<'bool'>);
    },
    storeU32(name: string, value: number): void {
      device.storage.storeState(state(name) as StateRef<'u32'>, value);
    },
    async postStep(): Promise<void> {
      const step = instrumented.trace.entries.get('step');
      if (step === undefined || instrumented.trace.api === undefined) {
        throw new Error('The teaching MCU did not declare its step entry');
      }
      await instrumented.trace.api.post(step as EntryRef<readonly []>, []);
    },
  };
  try {
    await run(context);
  } finally {
    device.destroy();
    power.destroy();
  }
}

async function loadModifiedExample(code: string): Promise<LoadedDeviceModule> {
  const raw = await readExampleDescription(TEACHING_MCU_DEVICE_ID);
  const provider: IDeviceProvider = {
    resolve(deviceId) {
      if (deviceId !== TEACHING_MCU_DEVICE_ID) return undefined;
      return {
        definition: parseDeviceDescription(raw, { name: deviceId }),
        code,
      };
    },
  };
  return loadDeviceModule(TEACHING_MCU_DEVICE_ID, provider);
}

function generationCount(trace: Trace, key: number): number {
  return trace.generations.get(key) ?? 0;
}

describe('teaching MCU Provider and firmware updates (#62)', () => {
  it('follows the block, PC, R0, GPIO and event-time trajectory', async () => {
    await withTeachingMcu((context) => {
      context.runUntil(0);
      expect(context.device.state).toBe('ready');
      expect(context.loadU32('r0')).toBe(3);
      expect(context.loadU32('pc')).toBe(8);
      expect(context.loadBool('stopped')).toBe(false);
      expect(context.loadBool('guestFault')).toBe(false);
      expect(context.sampleGpio()).toBe(1);
      // B0 is ADD, ADD, JNZ. Only key 0 is generated at 0 ps.
      expect(context.trace.generatedKeys).toEqual([0]);

      context.runUntil(30_000);
      expect(context.loadU32('r0')).toBe(7);
      expect(context.loadU32('pc')).toBe(0);
      expect(context.sampleGpio()).toBe(1);
      expect(context.trace.generatedKeys).toEqual([0, 8]);

      context.runUntil(50_000);
      expect(context.loadU32('r0')).toBe(10);
      expect(context.loadU32('pc')).toBe(8);
      expect(context.sampleGpio()).toBe(0);
      // B0 was reused at 50,000 ps.
      expect(context.trace.generatedKeys).toEqual([0, 8]);

      context.runUntil(80_000);
      expect(context.loadU32('r0')).toBe(14);
      expect(context.loadU32('pc')).toBe(0);
      expect(context.sampleGpio()).toBe(0);
      expect(context.trace.generatedKeys).toEqual([0, 8]);
      expect(generationCount(context.trace, 0)).toBe(1);
      expect(generationCount(context.trace, 8)).toBe(1);
    });
  });

  it('regenerates B0 after an 8 B unit update, reuses B8 and keeps B6 conservatively stale', async () => {
    await withTeachingMcu(async (context) => {
      // Start nonzero so every B0 JNZ takes the PC 8 edge.
      context.storeU32('r0', 1);
      context.runUntil(50_000);
      expect(context.loadU32('r0')).toBe(11);
      expect(generationCount(context.trace, 0)).toBe(1);
      expect(generationCount(context.trace, 8)).toBe(1);

      // Let the already scheduled 80,000 ps entry dispatch B6 instead of B8, caching HALT and
      // leaving no pending successor.
      context.storeU32('pc', 6);
      context.runUntil(80_000);
      expect(context.loadBool('stopped')).toBe(true);
      expect(context.loadBool('guestFault')).toBe(false);
      expect(generationCount(context.trace, 6)).toBe(1);
      expect(context.scheduler.start({ maxEntries: 5 }).reason).toBe('empty');

      // Only unit 0 changes: bytes 0..7 with firmware[3] 0x02 -> 0x05.
      context.device.deliver('firmwarePatch', patchUnit0({ 3: 5 }), {
        simTime: context.scheduler.now,
      });

      // B8 lives in unit 1 and must be reused even though it is requested again.
      context.storeU32('pc', 8);
      await context.postStep();
      context.runOneEntry();
      expect(context.loadU32('r0')).toBe(15);
      expect(context.loadU32('pc')).toBe(0);
      expect(generationCount(context.trace, 8)).toBe(1);

      // A host-forced step is a white-box probe after HALT; the model itself scheduled nothing.
      // B6's bytes 6..7 did not change, but they share unit 0: conservative invalidation.
      context.storeU32('pc', 6);
      await context.postStep();
      context.runOneEntry();
      expect(context.loadBool('stopped')).toBe(true);
      expect(generationCount(context.trace, 6)).toBe(2);

      // B0 is regenerated on demand with ADD #5, then reused from the cache.
      context.storeU32('pc', 0);
      await context.postStep();
      context.runOneEntry();
      expect(context.loadU32('r0')).toBe(21);
      expect(context.loadU32('pc')).toBe(8);
      expect(generationCount(context.trace, 0)).toBe(2);
      context.storeU32('pc', 0);
      await context.postStep();
      context.runOneEntry();
      expect(context.loadU32('r0')).toBe(27);
      expect(generationCount(context.trace, 0)).toBe(2);
    });
  });

  it('evaluates the JNZ condition at run time and wraps u32 addition', async () => {
    await withTeachingMcu((context) => {
      // 0xFFFF_FFFE + 1 + 2 wraps to 1; the JNZ condition is evaluated from this value.
      context.storeU32('r0', 0xffff_fffe);
      context.runUntil(0);
      expect(context.loadU32('r0')).toBe(1);
      expect(context.loadU32('pc')).toBe(8);
      expect(generationCount(context.trace, 0)).toBe(1);
    });
  });

  it('takes the false JNZ edge at run time and stops at HALT', async () => {
    await withTeachingMcu(async (context) => {
      context.runUntil(0);
      expect(context.loadU32('pc')).toBe(8);
      context.device.deliver('firmwarePatch', patchUnit0({ 1: 0, 3: 0 }), {
        simTime: context.scheduler.now,
      });
      context.storeU32('r0', 0);
      context.storeU32('pc', 0);
      await context.postStep();
      context.runUntil(0);
      expect(context.loadU32('r0')).toBe(0);
      expect(context.loadU32('pc')).toBe(6);
      expect(context.loadBool('stopped')).toBe(false);
      expect(generationCount(context.trace, 0)).toBe(2);

      context.runUntil(30_000);
      expect(context.loadBool('stopped')).toBe(true);
      expect(context.loadBool('guestFault')).toBe(false);
      expect(generationCount(context.trace, 6)).toBe(1);
      // HALT does not schedule another step entry.
      expect(context.scheduler.start({ maxEntries: 5 }).reason).toBe('empty');
      expect(context.scheduler.now).toBe(30_000);
    });
  });

  it('reports missing firmware, illegal addresses and illegal instructions as guest faults', async () => {
    await withTeachingMcu((context) => {
      // PC at the capacity cannot complete a two-byte fetch.
      context.storeU32('pc', 12);
      context.runUntil(0);
      expect(context.loadBool('stopped')).toBe(true);
      expect(context.loadBool('guestFault')).toBe(true);
      expect(generationCount(context.trace, 12)).toBe(1);
      expect(context.scheduler.start({ maxEntries: 5 }).reason).toBe('empty');
    });

    await withTeachingMcu((context) => {
      // Odd PC is not an instruction boundary.
      context.storeU32('pc', 13);
      context.runUntil(0);
      expect(context.loadBool('stopped')).toBe(true);
      expect(context.loadBool('guestFault')).toBe(true);
      expect(generationCount(context.trace, 13)).toBe(1);
    });

    await withTeachingMcu(async (context) => {
      context.runUntil(0);
      context.device.deliver('firmwarePatch', patchUnit0({ 0: 0x77, 1: 0 }), {
        simTime: context.scheduler.now,
      });
      context.storeU32('pc', 0);
      await context.postStep();
      context.runUntil(0);
      expect(context.loadBool('stopped')).toBe(true);
      expect(context.loadBool('guestFault')).toBe(true);
      // The initial B0 and the regenerated fault block.
      expect(generationCount(context.trace, 0)).toBe(2);
    });
  });

  it('treats a HALT instruction as a clean stop without scheduling a successor', async () => {
    await withTeachingMcu((context) => {
      context.storeU32('pc', 6);
      context.runUntil(0);
      expect(context.loadBool('stopped')).toBe(true);
      expect(context.loadBool('guestFault')).toBe(false);
      expect(context.trace.generatedKeys).toEqual([6]);
      expect(context.scheduler.start({ maxEntries: 5 }).reason).toBe('empty');
      expect(context.scheduler.now).toBe(0);
    });
  });

  it.each([
    { label: '256 B units', unitBytes: 256 },
    { label: 'whole-resource units', unitBytes: undefined },
  ])('invalidates conservatively with $label', async ({ unitBytes }) => {
    const source = await readFile(MCU_EXAMPLE, 'utf8');
    const code =
      unitBytes === undefined
        ? source.replace('\n    unitBytes: 8,', '')
        : source.replace('unitBytes: 8', `unitBytes: ${String(unitBytes)}`);
    expect(code).not.toBe(source);

    await withTeachingMcu(
      (context) => {
        context.storeU32('r0', 1);
        context.runUntil(80_000);
        expect(generationCount(context.trace, 0)).toBe(1);
        expect(generationCount(context.trace, 8)).toBe(1);

        // firmware[3] changes, but B0 and B8 now share one version unit.
        context.device.deliver('firmwarePatch', patchUnit0({ 3: 5 }), {
          simTime: context.scheduler.now,
        });
        context.runUntil(100_000);
        expect(generationCount(context.trace, 0)).toBe(2);
        expect(context.loadU32('r0')).toBe(21);

        // B8 must be regenerated even though bytes 8..11 did not change.
        context.runUntil(130_000);
        expect(generationCount(context.trace, 8)).toBe(2);
        expect(context.loadU32('r0')).toBe(25);
      },
      { code },
    );
  });
});
