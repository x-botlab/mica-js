/**
 * Example: run real firmware on the teaching Cortex-M3 and drive a unified LED.
 *
 * The guest writes the GPIO direction and output registers through MMIO; the
 * device publishes those writes to the shared pin space, the electrical solve
 * runs, and the LED samples the net — all inside one compiled module.
 */
import { Circuit, LED_IR_TYPE, createLedIR } from '../src/index';
import { TEACHING_MCU_IR_TYPE, createTeachingMCUIR } from '../src/unified-ir/examples/teaching-mcu';
import { blinkyFirmware } from './firmware';

/** What {@link run} observed while executing the blinky firmware. */
export interface TeachingMcuBlinkyResult {
  /** Ticks stepped one by one. */
  readonly ticks: number;
  /** On/off transitions of the lamp. */
  readonly lampTransitions: number;
  /** Guest instructions retired. */
  readonly cycles: number;
  /** Whether the guest halted (the blink loop does not). */
  readonly halted: boolean;
  /** Program counter after the run. */
  readonly pc: number;
  /** Final GPIO output word of port A. */
  readonly gpioOut: number;
}

/**
 * Steps the circuit one tick at a time so every lamp transition is observed.
 *
 * @param ticks - Ticks to step; each tick retires `instructionsPerTick`
 *   instructions (8 by default).
 */
export async function run(ticks = 2_000): Promise<TeachingMcuBlinkyResult> {
  const mcu = createTeachingMCUIR('mcu', {
    isa: 'm3',
    firmware: blinkyFirmware(20),
    instructionsPerTick: 8,
  });
  const lamp = createLedIR('led1', { color: 'red' });

  const circuit = await Circuit.create({
    devices: [
      { id: 'mcu', type: TEACHING_MCU_IR_TYPE, description: mcu.device.description },
      { id: 'led1', type: LED_IR_TYPE, description: lamp.device.description },
    ],
    connections: [
      { from: 'mcu.PA0', to: 'led1.anode' },
      { from: 'led1.cathode', to: 'GND' },
    ],
  });

  try {
    const guest = circuit.devices.mcu;
    let lampTransitions = 0;
    let previous = circuit.devices.led1.isOn();

    for (let tick = 0; tick < ticks; tick += 1) {
      circuit.step();
      const current = circuit.devices.led1.isOn();
      if (current !== previous) lampTransitions += 1;
      previous = current;
    }

    return Object.freeze({
      ticks,
      lampTransitions,
      cycles: guest.getCycles(),
      halted: guest.isHalted(),
      pc: guest.getPC(),
      gpioOut: guest.readGPIO('A'),
    });
  } finally {
    circuit.dispose();
  }
}
