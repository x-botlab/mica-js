import { describe, expect, it } from 'vitest';
import { createLedDescription, createMcuDescription } from '../../compiler';
import { Circuit } from '../../runtime';
import { createLedIR, LED_IR_TYPE } from './index';

function unifiedMcuLedInput() {
  const led = createLedIR('led1');
  return {
    devices: [
      { id: 'mcu1', type: 'mcu' as const, description: createMcuDescription() },
      { id: 'led1', type: LED_IR_TYPE, description: led.device.description },
    ],
    connections: [
      { from: 'mcu1.PA0', to: 'led1.anode' },
      { from: 'led1.cathode', to: 'GND' },
    ],
  } as const;
}

function builtinMcuLedInput() {
  return {
    devices: [
      { id: 'mcu1', type: 'mcu' as const, description: createMcuDescription() },
      { id: 'led1', type: 'ideal-led' as const, description: createLedDescription() },
    ],
    connections: [
      { from: 'mcu1.PA0', to: 'led1.anode' },
      { from: 'led1.cathode', to: 'GND' },
    ],
  } as const;
}

describe('LED circuit integration', () => {
  it('creates a circuit with the typed LED accessor', async () => {
    const led = createLedIR('led1', { color: 'green', maxBrightness: 100 });
    const circuit = await Circuit.create({
      devices: [{ id: 'led1', type: LED_IR_TYPE, description: led.device.description }],
      connections: [],
    });
    const accessor = circuit.devices.led1;
    expect(accessor.deviceId).toBe('led1');
    expect(accessor.type).toBe(LED_IR_TYPE);
    expect(accessor.pinNames).toEqual(['anode', 'cathode']);
    expect(accessor.color).toBe('green');
    expect(accessor.maxBrightness).toBe(100);
    expect(accessor.isOn()).toBe(false);
    expect(accessor.getLevel()).toBe(100);

    accessor.setBrightness(25);
    expect(accessor.getLevel()).toBe(25);
    accessor.setBrightness(0);
    expect(accessor.isOn()).toBe(false);
    circuit.dispose();
  });

  it('matches the built-in ideal-led kernel tick for tick', async () => {
    const unified = await Circuit.create(unifiedMcuLedInput());
    const builtin = await Circuit.create(builtinMcuLedInput());
    try {
      for (let tick = 0; tick < 20; tick += 1) {
        unified.step();
        builtin.step();
        const on = unified.devices.led1.isOn();
        expect(on).toBe(builtin.devices.led1.isOn());
        expect(unified.devices.led1.getBrightness()).toBe(on ? 255 : 0);
        expect(unified.getPin('led1.anode')).toBe(builtin.getPin('led1.anode'));
      }
    } finally {
      unified.dispose();
      builtin.dispose();
    }
  });

  it('keeps single-step and batch execution semantically identical', async () => {
    const stepped = await Circuit.create(unifiedMcuLedInput());
    const batched = await Circuit.create(unifiedMcuLedInput());
    try {
      stepped.runBatch(7);
      for (let tick = 0; tick < 7; tick += 1) batched.step();
      expect(stepped.devices.led1.isOn()).toBe(batched.devices.led1.isOn());
      expect(stepped.devices.led1.getBrightness()).toBe(batched.devices.led1.getBrightness());
      expect(stepped.tickCount).toBe(batched.tickCount);
    } finally {
      stepped.dispose();
      batched.dispose();
    }
  });

  it('restores the configured intensity on reset', async () => {
    const led = createLedIR('led1', { initialBrightness: 80 });
    const circuit = await Circuit.create({
      devices: [
        {
          id: 'mcu1',
          type: 'mcu' as const,
          description: createMcuDescription(),
        },
        { id: 'led1', type: LED_IR_TYPE, description: led.device.description },
      ],
      connections: [
        { from: 'mcu1.PA0', to: 'led1.anode' },
        { from: 'led1.cathode', to: 'GND' },
      ],
    });
    try {
      circuit.step();
      expect(circuit.devices.led1.isOn()).toBe(true);
      circuit.devices.led1.setBrightness(10);
      expect(circuit.devices.led1.getLevel()).toBe(10);
      circuit.reset();
      expect(circuit.devices.led1.getLevel()).toBe(80);
      expect(circuit.devices.led1.isOn()).toBe(false);
      circuit.step();
      expect(circuit.devices.led1.isOn()).toBe(true);
      expect(circuit.devices.led1.getBrightness()).toBe(80);
    } finally {
      circuit.dispose();
    }
  });
});
