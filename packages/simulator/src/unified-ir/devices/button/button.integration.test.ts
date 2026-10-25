import { describe, expect, it } from 'vitest';
import { createButtonIR, BUTTON_IR_TYPE, type ButtonConfig } from './index';
import { createLedIR, LED_IR_TYPE } from '../led';
import { Circuit } from '../../runtime';
import { createTeachingMCUIR, TEACHING_MCU_IR_TYPE } from '../../examples/teaching-mcu';
import { encodeR, Op, wordsToBytes } from '../../examples/teaching-mcu/teaching-mcu.test-helpers';

/** `sw1` + `led1`; releasing opens the switched net. */
function buttonLedInput(config: ButtonConfig = {}) {
  const button = createButtonIR('sw1', config);
  const led = createLedIR('led1');
  return {
    button,
    led,
    input: {
      devices: [
        { id: 'sw1', type: BUTTON_IR_TYPE, description: button.device.description },
        { id: 'led1', type: LED_IR_TYPE, description: led.device.description },
      ],
      connections: [
        { from: 'sw1.B', to: 'GND' },
        { from: 'sw1.A', to: 'led1.anode' },
        { from: 'led1.cathode', to: 'GND' },
      ],
    },
  } as const;
}

describe('button circuit integration', () => {
  it('drives an LED from the typed accessors', async () => {
    const { input } = buttonLedInput();
    const circuit = await Circuit.create(input);
    try {
      const sw = circuit.devices.sw1;
      const lamp = circuit.devices.led1;
      expect(sw.deviceId).toBe('sw1');
      expect(sw.type).toBe(BUTTON_IR_TYPE);
      expect(sw.terminalA).toBe('A');
      expect(lamp.type).toBe(LED_IR_TYPE);
      expect(lamp.isOn()).toBe(false);

      sw.press();
      circuit.step();
      expect(sw.isPressed()).toBe(true);
      expect(sw.isClosed()).toBe(true);
      expect(sw.getPressCount()).toBe(1);
      expect(circuit.getPin('sw1.A')).toBe(true);
      expect(circuit.getPin('led1.anode')).toBe(true);
      expect(sw.getLineLevel()).toBe(true);
      expect(lamp.isOn()).toBe(true);
      expect(lamp.getBrightness()).toBe(255);

      sw.release();
      circuit.step();
      expect(sw.isPressed()).toBe(false);
      expect(sw.isClosed()).toBe(false);
      expect(circuit.getPin('sw1.A')).toBe(false);
      expect(sw.getLineLevel()).toBe(false);
      expect(lamp.isOn()).toBe(false);
    } finally {
      circuit.dispose();
    }
  });

  it('applies the configured debounce inside the circuit loop', async () => {
    const { input } = buttonLedInput({ debounceTicks: 2 });
    const circuit = await Circuit.create(input);
    try {
      circuit.devices.sw1.press();
      circuit.step();
      expect(circuit.devices.sw1.isClosed()).toBe(false);
      expect(circuit.devices.led1.isOn()).toBe(false);

      circuit.step();
      expect(circuit.devices.sw1.isClosed()).toBe(true);
      expect(circuit.devices.sw1.getPressCount()).toBe(1);
      expect(circuit.devices.led1.isOn()).toBe(true);
    } finally {
      circuit.dispose();
    }
  });

  it('keeps two button/LED pairs independent', async () => {
    const sw1 = createButtonIR('sw1');
    const sw2 = createButtonIR('sw2');
    const led1 = createLedIR('led1');
    const led2 = createLedIR('led2');
    const circuit = await Circuit.create({
      devices: [
        { id: 'sw1', type: BUTTON_IR_TYPE, description: sw1.device.description },
        { id: 'sw2', type: BUTTON_IR_TYPE, description: sw2.device.description },
        { id: 'led1', type: LED_IR_TYPE, description: led1.device.description },
        { id: 'led2', type: LED_IR_TYPE, description: led2.device.description },
      ],
      connections: [
        { from: 'sw1.B', to: 'GND' },
        { from: 'sw2.B', to: 'GND' },
        { from: 'sw1.A', to: 'led1.anode' },
        { from: 'sw2.A', to: 'led2.anode' },
        { from: 'led1.cathode', to: 'GND' },
        { from: 'led2.cathode', to: 'GND' },
      ],
    });
    try {
      circuit.devices.sw1.press();
      circuit.step();
      expect(circuit.devices.led1.isOn()).toBe(true);
      expect(circuit.devices.led2.isOn()).toBe(false);

      circuit.devices.sw1.release();
      circuit.devices.sw2.press();
      circuit.step();
      expect(circuit.devices.led1.isOn()).toBe(false);
      expect(circuit.devices.led2.isOn()).toBe(true);
    } finally {
      circuit.dispose();
    }
  });

  it('feeds a teaching MCU input pin through the electrical solve', async () => {
    const mcu = createTeachingMCUIR('mcu1', {
      ports: ['A'],
      portWidth: 1,
      firmware: wordsToBytes([encodeR(Op.HALT, 0, 0, 0)]),
    });
    const button = createButtonIR('sw1');
    const circuit = await Circuit.create(
      {
        devices: [
          { id: 'mcu1', type: TEACHING_MCU_IR_TYPE, description: mcu.device.description },
          { id: 'sw1', type: BUTTON_IR_TYPE, description: button.device.description },
        ],
        connections: [
          { from: 'sw1.B', to: 'GND' },
          { from: 'sw1.A', to: 'mcu1.PA0' },
        ],
      },
      { electrical: { allowMultiDriver: true } },
    );
    try {
      expect(circuit.devices.mcu1.readPinInput('PA0')).toBe(false);
      circuit.devices.sw1.press();
      circuit.step();
      expect(circuit.getPin('mcu1.PA0')).toBe(true);
      expect(circuit.devices.mcu1.readPinInput('PA0')).toBe(true);
      expect(circuit.devices.sw1.getLineLevel()).toBe(true);

      circuit.devices.sw1.release();
      circuit.step();
      expect(circuit.getPin('mcu1.PA0')).toBe(false);
      expect(circuit.devices.mcu1.readPinInput('PA0')).toBe(false);
    } finally {
      circuit.dispose();
    }
  });

  it('keeps single-step and batch execution semantically identical', async () => {
    const steppedInput = buttonLedInput();
    const batchedInput = buttonLedInput();
    const stepped = await Circuit.create(steppedInput.input);
    const batched = await Circuit.create(batchedInput.input);
    try {
      stepped.devices.sw1.press();
      batched.devices.sw1.press();
      for (let tick = 0; tick < 4; tick += 1) stepped.step();
      batched.runBatch(4);
      expect(stepped.devices.sw1.isClosed()).toBe(batched.devices.sw1.isClosed());
      expect(stepped.devices.sw1.getPressCount()).toBe(batched.devices.sw1.getPressCount());
      expect(stepped.devices.sw1.getHoldTicks()).toBe(batched.devices.sw1.getHoldTicks());
      expect(stepped.devices.sw1.getLineLevel()).toBe(batched.devices.sw1.getLineLevel());
      expect(stepped.devices.led1.isOn()).toBe(batched.devices.led1.isOn());

      stepped.devices.sw1.release();
      batched.devices.sw1.release();
      stepped.step();
      stepped.step();
      batched.runBatch(2);
      expect(stepped.devices.sw1.isClosed()).toBe(batched.devices.sw1.isClosed());
      expect(stepped.devices.led1.isOn()).toBe(batched.devices.led1.isOn());
      expect(stepped.tickCount).toBe(batched.tickCount);
    } finally {
      stepped.dispose();
      batched.dispose();
    }
  });

  it('restores the released position on reset', async () => {
    const { input } = buttonLedInput();
    const circuit = await Circuit.create(input);
    try {
      circuit.devices.sw1.press();
      circuit.step();
      circuit.step();
      expect(circuit.devices.led1.isOn()).toBe(true);
      expect(circuit.devices.sw1.getPressCount()).toBe(1);
      expect(circuit.devices.sw1.getHoldTicks()).toBe(2);

      circuit.reset();
      expect(circuit.devices.sw1.isPressed()).toBe(false);
      expect(circuit.devices.sw1.isClosed()).toBe(false);
      expect(circuit.devices.sw1.getPressCount()).toBe(0);
      expect(circuit.devices.sw1.getHoldTicks()).toBe(0);
      expect(circuit.devices.led1.isOn()).toBe(false);
      expect(circuit.getPin('sw1.A')).toBe(false);

      circuit.step();
      expect(circuit.devices.led1.isOn()).toBe(false);
    } finally {
      circuit.dispose();
    }
  });

  it('honours an initially pressed button', async () => {
    const { input } = buttonLedInput({ initialPressed: true });
    const circuit = await Circuit.create(input);
    try {
      expect(circuit.devices.sw1.isPressed()).toBe(true);
      expect(circuit.devices.sw1.isClosed()).toBe(true);
      expect(circuit.devices.led1.isOn()).toBe(false);
      circuit.step();
      expect(circuit.devices.led1.isOn()).toBe(true);
      expect(circuit.devices.sw1.getPressCount()).toBe(0);
    } finally {
      circuit.dispose();
    }
  });
});
