/**
 * Guards the published entry point: every documented runtime export must stay
 * available, the generic accessor surface must stay generic, and no built-in
 * device model may sneak back in.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { DeviceAccessor, SchematicDeviceBinding } from './index';
import {
  Circuit,
  CircuitError,
  DEVICE_PIN_STRIDE,
  PIN_MODE,
  UNIFIED_PIN_CAPACITY,
  UnifiedIRCompilerError,
  compileCircuit,
  createCircuitDeviceSimulationHost,
  createCircuitFromSchematic,
  createModuleValidation,
  createSchematicCircuit,
  createSchematicDeviceSimulationHost,
  startDeviceSimulationHostGuest,
} from './index';
import { lampSinkDescription, toggleDriverDescription } from './unified-ir/compiler/test-helpers';

describe('public API surface', () => {
  it('exports every documented runtime entry point', () => {
    expect(typeof Circuit).toBe('function');
    expect(typeof CircuitError).toBe('function');
    expect(typeof UnifiedIRCompilerError).toBe('function');
    expect(typeof compileCircuit).toBe('function');
    expect(typeof createCircuitFromSchematic).toBe('function');
    expect(typeof createSchematicCircuit).toBe('function');
    expect(typeof createCircuitDeviceSimulationHost).toBe('function');
    expect(typeof createSchematicDeviceSimulationHost).toBe('function');
    expect(typeof startDeviceSimulationHostGuest).toBe('function');
    expect(typeof createModuleValidation).toBe('function');

    expect(UNIFIED_PIN_CAPACITY).toBe(256);
    expect(DEVICE_PIN_STRIDE).toBe(32);
    expect(PIN_MODE.pushPull).toBe(1);
  });

  it('ships no device models', async () => {
    const simulator = await import('./index');

    for (const name of [
      'createLedDescription',
      'createMcuDescription',
      'createSingleDeviceCircuit',
      'BUILTIN_DEVICE_KERNELS',
      'BUILTIN_DEVICE_TYPES',
      'builtinDeviceKernel',
      'resolveDeviceDescription',
    ]) {
      expect(name in simulator).toBe(false);
    }
  });

  it('keeps the generic accessor surface for caller-supplied devices', async () => {
    const circuit = await Circuit.create({
      devices: [
        { id: 'drive1', type: 'toggle-driver', description: toggleDriverDescription() },
        { id: 'sink1', type: 'lamp-sink', description: lampSinkDescription() },
      ],
      connections: [
        { from: 'drive1.PA0', to: 'sink1.anode' },
        { from: 'sink1.cathode', to: 'GND' },
      ],
    });

    expectTypeOf(circuit.devices.sink1).toEqualTypeOf<DeviceAccessor>();
    expectTypeOf(circuit.devices.drive1).toEqualTypeOf<DeviceAccessor>();

    circuit.runBatch(1);
    expect(circuit.devices.sink1.getState('lamp')).toBe(true);
    circuit.dispose();
  });

  it('describes devices through the caller-supplied binding contract', () => {
    const binding: SchematicDeviceBinding = {
      type: 'caller-device-ir',
      description: toggleDriverDescription(),
      topics: [{ port: 'value', direction: 'output', type: 'number' }],
      read: () => 1,
    };
    expect(binding.topics?.[0]?.port).toBe('value');
    expectTypeOf(binding.read).toEqualTypeOf<
      ((accessor: DeviceAccessor, port: string) => unknown) | undefined
    >();
  });
});
