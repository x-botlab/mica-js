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
  TeachingMCUAccessor,
} from './index';
import {
  BUTTON_IR_TYPE,
  Circuit,
  CircuitError,
  DEVICE_PIN_STRIDE,
  LED_IR_TYPE,
  PIN_MODE,
  TEACHING_MCU_IR_TYPE,
  UNIFIED_PIN_CAPACITY,
  UnifiedIRCompilerError,
  compileCircuit,
  createButtonIR,
  createCircuitFromSchematic,
  createLedDescription,
  createLedIR,
  createMcuDescription,
  createSingleDeviceCircuit,
  createTeachingMCUIR,
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
    expect(typeof createTeachingMCUIR).toBe('function');

    expect(LED_IR_TYPE).toBe('led-ir');
    expect(BUTTON_IR_TYPE).toBe('button-ir');
    expect(TEACHING_MCU_IR_TYPE).toBe('teaching-mcu-ir');
    expect(UNIFIED_PIN_CAPACITY).toBe(256);
    expect(DEVICE_PIN_STRIDE).toBe(32);
    expect(PIN_MODE.pushPull).toBe(1);
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
    expectTypeOf<TeachingMCUAccessor>().toMatchTypeOf<DeviceAccessor>();
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
