/**
 * Guards the published entry point: every documented runtime export must stay
 * available, device values travel only through RFC 0017 boundary hooks, and no
 * built-in device model may sneak back in.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  DeviceDescription,
  DeviceInputIo,
  DeviceOutputIo,
  ElectricalFactoryContext,
  SchematicDeviceBinding,
} from './index';
// @ts-expect-error Compiler preparation results are internal.
import type { PreparedElectricalDevice } from './index';
// @ts-expect-error Initialized resource records are internal.
import type { InitializedResistor } from './index';
// @ts-expect-error Device accessors are not part of the runtime surface.
import type { DeviceAccessor } from './index';
import {
  Circuit,
  CircuitError,
  DEVICE_PIN_STRIDE,
  PIN_MODE,
  UNIFIED_PIN_CAPACITY,
  UnifiedIRCompilerError,
  compileCircuit,
  createCircuitFromSchematic,
  createModuleValidation,
  createSchematicCircuit,
  createSchematicDeviceSimulationHost,
  startDeviceSimulationHostGuest,
} from './index';
import { toggleDriverDescription } from './unified-ir/compiler/test-helpers';

describe('public API surface', () => {
  it('exports every documented runtime entry point', () => {
    expect(typeof Circuit).toBe('function');
    expect(typeof CircuitError).toBe('function');
    expect(typeof UnifiedIRCompilerError).toBe('function');
    expect(typeof compileCircuit).toBe('function');
    expect(typeof createCircuitFromSchematic).toBe('function');
    expect(typeof createSchematicCircuit).toBe('function');
    expect(typeof createSchematicDeviceSimulationHost).toBe('function');
    expect(typeof startDeviceSimulationHostGuest).toBe('function');
    expect(typeof createModuleValidation).toBe('function');

    expect(UNIFIED_PIN_CAPACITY).toBe(4096);
    expect(DEVICE_PIN_STRIDE).toBe(512);
    expect(PIN_MODE.pushPull).toBe(1);
  });

  it('keeps compiler preparation internal while exposing factory initialization types', async () => {
    const simulator = await import('./index');
    expect('prepareElectricalDevice' in simulator).toBe(false);
    expect('compileSchematicInput' in simulator).toBe(false);
    expect('deviceBoundaryOf' in simulator).toBe(false);
    expectTypeOf<PreparedElectricalDevice<unknown>>().toBeAny();
    expectTypeOf<InitializedResistor>().toBeAny();
    expectTypeOf<ElectricalFactoryContext['electrical']['initializeResistor']>().toBeCallableWith(
      'body',
      { resistance: 1000, enabled: true },
    );
  });

  it('ships no device models', async () => {
    const simulator = await import('./index');

    for (const name of [
      'createLedDescription',
      'createMcuDescription',
      'createSingleDeviceCircuit',
      'createCircuitDeviceSimulationHost',
      'BUILTIN_DEVICE_KERNELS',
      'BUILTIN_DEVICE_TYPES',
      'builtinDeviceKernel',
      'resolveDeviceDescription',
      'DEFAULT_RAILS',
      'NetworkTopologyAnalyzer',
      'ElectricalSolverGenerator',
      'createPinMemory',
    ]) {
      expect(name in simulator).toBe(false);
    }
  });

  it('exposes no device accessor or electrical readback surface', async () => {
    const simulator = await import('./index');
    for (const name of [
      'DeviceAccessor',
      'DeviceAccessors',
      'DeviceAccessorsOf',
      'DeviceAccessorFactory',
      'DeviceAccessorFactoryContext',
      'DeviceAccessorSurface',
      'ElectricalCurrentTarget',
      'ElectricalDiagnostic',
    ])
      expect(name in simulator).toBe(false);

    expectTypeOf<DeviceAccessor>().toBeAny();
    expectTypeOf<Circuit>().not.toHaveProperty('devices');
    expectTypeOf<Circuit>().not.toHaveProperty('jit');
    expectTypeOf<Circuit>().not.toHaveProperty('getPin');
    expectTypeOf<Circuit>().not.toHaveProperty('getVoltage');
    expectTypeOf<Circuit>().not.toHaveProperty('getCurrent');
    expectTypeOf<Circuit>().not.toHaveProperty('getDiagnostics');
    expectTypeOf<Circuit>().not.toHaveProperty('setPin');

    const circuit = await Circuit.create(
      {
        devices: [{ id: 'drive1', type: 'toggle-driver', description: toggleDriverDescription() }],
        connections: [],
      },
      { electrical: { sources: { VDD: { voltage: 5 } }, interpretation: 'two-state' } },
    );
    try {
      expect(circuit).not.toHaveProperty('devices');
      expect(circuit).not.toHaveProperty('jit');
      expect(circuit).not.toHaveProperty('getState');
    } finally {
      circuit.dispose();
    }
  });

  it('describes devices through topics plus factory-owned boundary hooks', () => {
    const description: DeviceDescription = {
      pins: { out: { kind: 'signal' } },
      factory: () => undefined,
      applyInputs: () => undefined,
      flushOutputs: () => undefined,
    };
    const binding: SchematicDeviceBinding = {
      type: 'caller-device-ir',
      description,
      topics: [{ port: 'value', direction: 'output', type: 'number' }],
    };
    expect(binding.topics?.[0]?.port).toBe('value');
    expectTypeOf(binding.description.applyInputs).toEqualTypeOf<
      ((io: DeviceInputIo) => void) | undefined
    >();
    expectTypeOf(binding.description.flushOutputs).toEqualTypeOf<
      ((io: DeviceOutputIo) => void) | undefined
    >();
    expectTypeOf<SchematicDeviceBinding>().not.toHaveProperty('deliver');
    expectTypeOf<SchematicDeviceBinding>().not.toHaveProperty('read');
  });
});
