/**
 * Guards the published entry point: every documented runtime export must stay
 * available and the typed accessor surface must keep inferring per-device
 * accessors from the literal device type.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  ButtonIRAccessor,
  DeviceAccessor,
  LedAccessor,
  LedIRAccessor,
  StorageAccessor,
} from './index';
import {
  BUTTON_IR_TYPE,
  Circuit,
  CircuitError,
  DEFAULT_TOPIC_CAPACITY,
  DEVICE_PIN_STRIDE,
  FLOATING_ALGORITHM,
  LED_IR_TYPE,
  PIN_MODE,
  PIN_PULL,
  TICK_PS,
  TOPIC_STRING_MAX_BYTES,
  UNIFIED_PIN_CAPACITY,
  UnifiedIRCompilerError,
  compileBoardTopology,
  compileCircuit,
  compileSchematicToCircuit,
  createButtonIR,
  createCircuitExecutor,
  createCircuitFromSchematic,
  createIdealButtonDescription,
  createIdealRelayDescription,
  createLedDescription,
  createLedIR,
  createMcuDescription,
  createSingleDeviceCircuit,
  fromIRArgs,
  hashFloatingState,
  hashTopology,
  resolveExampleDevice,
  sampleFloating,
  toIRArgs,
  topicPayloadParams,
} from './index';

describe('public API surface', () => {
  it('exports every documented runtime entry point', () => {
    expect(typeof Circuit).toBe('function');
    expect(typeof CircuitError).toBe('function');
    expect(typeof UnifiedIRCompilerError).toBe('function');
    expect(typeof compileCircuit).toBe('function');
    expect(typeof createCircuitFromSchematic).toBe('function');
    expect(typeof createSingleDeviceCircuit).toBe('function');
    expect(typeof createLedDescription).toBe('function');
    expect(typeof createMcuDescription).toBe('function');
    expect(typeof createLedIR).toBe('function');
    expect(typeof createButtonIR).toBe('function');
    expect(typeof compileSchematicToCircuit).toBe('function');
    expect(typeof compileBoardTopology).toBe('function');
    expect(typeof createCircuitExecutor).toBe('function');
    expect(typeof resolveExampleDevice).toBe('function');
    expect(typeof createIdealButtonDescription).toBe('function');
    expect(typeof createIdealRelayDescription).toBe('function');
    expect(typeof toIRArgs).toBe('function');
    expect(typeof fromIRArgs).toBe('function');
    expect(typeof topicPayloadParams).toBe('function');
    expect(typeof sampleFloating).toBe('function');
    expect(typeof hashFloatingState).toBe('function');
    expect(typeof hashTopology).toBe('function');

    expect(LED_IR_TYPE).toBe('led-ir');
    expect(BUTTON_IR_TYPE).toBe('button-ir');
    expect(UNIFIED_PIN_CAPACITY).toBe(256);
    expect(DEVICE_PIN_STRIDE).toBe(32);
    expect(PIN_MODE.pushPull).toBe(1);
    expect(PIN_MODE.openDrain).toBe(2);
    expect(PIN_PULL.up).toBe(1);
    expect(PIN_PULL.down).toBe(2);
    expect(TICK_PS).toBe(1_000_000);
    expect(FLOATING_ALGORITHM).toBe('mica-floating-v2');
    expect(DEFAULT_TOPIC_CAPACITY).toBe(64);
    expect(topicPayloadParams('boolean')).toEqual(['bool']);
    expect(TOPIC_STRING_MAX_BYTES).toBe(32);
  });

  it('infers the type-specific accessor from a literal device type', async () => {
    const lamp = createLedIR('led1');
    const button = createButtonIR('sw1');
    const circuit = await Circuit.create({
      devices: [
        { id: 'led1', type: LED_IR_TYPE, description: lamp.device.description },
        { id: 'sw1', type: BUTTON_IR_TYPE, description: button.device.description },
      ],
      connections: [
        { from: 'sw1.B', to: 'GND' },
        { from: 'sw1.A', to: 'led1.anode' },
        { from: 'led1.cathode', to: 'GND' },
      ],
    });

    expectTypeOf(circuit.devices.led1).toEqualTypeOf<LedIRAccessor>();
    expectTypeOf(circuit.devices.sw1).toEqualTypeOf<ButtonIRAccessor>();
    expectTypeOf<LedAccessor>().toMatchTypeOf<DeviceAccessor>();
    expectTypeOf<StorageAccessor>().toHaveProperty('loadState');

    circuit.devices.sw1.press();
    circuit.runBatch(3);
    expect(circuit.devices.led1.isOn()).toBe(true);
    expect(circuit.devices.sw1.getPressCount()).toBe(1);
    circuit.dispose();
  });

  it('drives a built-in device pair through the default kernels', async () => {
    const circuit = await createSingleDeviceCircuit('mcu', { pins: ['PA0'] });
    circuit.runBatch(2);
    expect(circuit.devices.device.readPin('PA0')).toBe(false);
    circuit.dispose();
  });
});
