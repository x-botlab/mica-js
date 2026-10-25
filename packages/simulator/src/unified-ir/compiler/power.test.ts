import { describe, expect, it } from 'vitest';
import { createMcuDescription } from './device-gen';
import {
  GlobalResourceAllocator,
  UnifiedIRCompilerError,
  compileCircuit,
  type CircuitCompilationInput,
  type DeviceConfig,
  type UnifiedIRCompilerErrorCode,
} from './index';
import { createIRModule } from '@mica-js/ir';

/** Test-only MCU description with two declared power domains (RFC 0007). */
function poweredMcu(id = 'mcu1', pins: readonly string[] = ['PA0']): DeviceConfig {
  const descriptions = Object.fromEntries(
    pins.map((name) => [name, Object.freeze({ direction: 'output' as const })]),
  );
  return {
    id,
    type: 'powered-mcu',
    description: {
      pins: descriptions,
      powerDomains: [
        { name: 'vdd', voltage: 3.3 },
        { name: 'vbat', voltage: 3 },
      ],
      behaviors: { initialize: () => {} },
    },
  };
}

function expectCompilerError(
  run: () => unknown,
  code: UnifiedIRCompilerErrorCode,
): UnifiedIRCompilerError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(UnifiedIRCompilerError);
    const compilerError = error as UnifiedIRCompilerError;
    expect(compilerError.code).toBe(code);
    return compilerError;
  }
  throw new Error('Expected UnifiedIRCompilerError.');
}

describe('power domain allocation', () => {
  it('packs one slot per domain in declaration order and binds pins', () => {
    const module = createIRModule();
    const allocation = new GlobalResourceAllocator(module).allocate([
      poweredMcu('mcu1'),
      { id: 'mcu2', type: 'teaching-mcu', description: createMcuDescription() },
      poweredMcu('mcu3'),
    ]);

    expect(allocation.powerDomains.totalDomains).toBe(4);
    expect(allocation.powerDomains.slots.map((slot) => `${slot.deviceId}.${slot.name}`)).toEqual([
      'mcu1.vdd',
      'mcu1.vbat',
      'mcu3.vdd',
      'mcu3.vbat',
    ]);
    expect(allocation.powerDomains.slots.map((slot) => slot.voltage)).toEqual([3.3, 3, 3.3, 3]);
    expect([...allocation.powerDomains.primary]).toEqual([
      ['mcu1', 0],
      ['mcu3', 2],
    ]);

    // Every pin of a device with domains inherits the primary one.
    const mcu1Pin = allocation.pins.pins.get('mcu1.PA0');
    expect(mcu1Pin).toBeDefined();
    expect(allocation.powerDomains.pinDomains.get(mcu1Pin as number)).toBe(0);
    expect(allocation.powerDomains.pinDomains.size).toBe(2);

    // The domains are one `power_ready` array, seeded powered.
    const ready = allocation.memory.powerReady;
    expect(ready).toBeDefined();
    const memory = module.memories.find((entry) => entry.ref === ready);
    expect(memory?.name).toBe('power_ready');
    expect(memory?.initial).toEqual([true, true, true, true]);
  });

  it('binds a pin to the domain it names', () => {
    const module = createIRModule();
    const allocation = new GlobalResourceAllocator(module).allocate([
      {
        id: 'mcu1',
        type: 'powered-mcu',
        description: {
          pins: {
            MAIN: { direction: 'output' as const },
            BACKUP: { direction: 'output' as const, powerDomain: 'vbat' },
          },
          powerDomains: [
            { name: 'vdd', voltage: 3.3 },
            { name: 'vbat', voltage: 3 },
          ],
          behaviors: { initialize: () => {} },
        },
      },
    ]);

    expect(allocation.powerDomains.pinDomains.get(allocation.pins.pins.get('mcu1.MAIN')!)).toBe(0);
    expect(allocation.powerDomains.pinDomains.get(allocation.pins.pins.get('mcu1.BACKUP')!)).toBe(
      1,
    );
  });

  it('declares no power_ready memory when no device declares a domain', () => {
    const module = createIRModule();
    const allocation = new GlobalResourceAllocator(module).allocate([
      { id: 'mcu1', type: 'teaching-mcu', description: createMcuDescription() },
    ]);

    expect(allocation.powerDomains.totalDomains).toBe(0);
    expect(allocation.memory.powerReady).toBeUndefined();
    expect(module.memories.some((entry) => entry.name === 'power_ready')).toBe(false);
  });

  it('rejects malformed declarations and undeclared pin bindings', () => {
    const input = (description: DeviceConfig['description']): CircuitCompilationInput => ({
      devices: [{ id: 'mcu1', type: 'powered-mcu', description }],
      connections: [],
    });

    expectCompilerError(
      () =>
        compileCircuit(
          input({
            pins: { PA0: { direction: 'output' } },
            powerDomains: [
              { name: 'vdd', voltage: 3.3 },
              { name: 'vdd', voltage: 3 },
            ],
            behaviors: { initialize: () => {} },
          }),
        ),
      'invalid-input',
    );
    expectCompilerError(
      () =>
        compileCircuit(
          input({
            pins: { PA0: { direction: 'output' } },
            powerDomains: [{ name: 'vdd', voltage: 0 }],
            behaviors: { initialize: () => {} },
          }),
        ),
      'invalid-input',
    );
    expectCompilerError(
      () =>
        compileCircuit(
          input({
            pins: { PA0: { direction: 'output', powerDomain: 'vbat' } },
            powerDomains: [{ name: 'vdd', voltage: 3.3 }],
            behaviors: { initialize: () => {} },
          }),
        ),
      'invalid-input',
    );
  });

  it('publishes the declared domains in the circuit metadata', () => {
    const compiled = compileCircuit({
      devices: [poweredMcu('mcu1')],
      connections: [],
    });

    const metadata = compiled.deviceMap.get('mcu1');
    expect(metadata?.powerDomains.size).toBe(2);
    expect([...metadata!.powerDomains.keys()]).toEqual(['vdd', 'vbat']);
    expect(metadata?.powerDomains.get('vbat')?.voltage).toBe(3);
    expect(compiled.powerDomains.totalDomains).toBe(2);
  });
});
