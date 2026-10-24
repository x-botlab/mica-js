/**
 * Example: a debounced push button switching a unified-IR LED.
 *
 * `press()` / `release()` model the raw contact position; the button kernel
 * applies the configured debounce inside the generated tick, and the LED
 * samples the solved net in the same step.
 */
import { Circuit, BUTTON_IR_TYPE, LED_IR_TYPE, createButtonIR, createLedIR } from '../src/index';

/** What {@link run} observed while pressing the button. */
export interface ButtonLedResult {
  /** Lamp state after the debounce window following `press()`. */
  readonly lampOnAfterPress: boolean;
  /** Lamp state after the debounce window following `release()`. */
  readonly lampOnAfterRelease: boolean;
  /** Debounced contact state while pressed. */
  readonly closedWhilePressed: boolean;
  /** Completed press edges counted by the button. */
  readonly pressCount: number;
}

/** Presses a debounced button for a few ticks and releases it again. */
export async function run(): Promise<ButtonLedResult> {
  const button = createButtonIR('sw1', { debounceTicks: 2 });
  const lamp = createLedIR('led1');

  const circuit = await Circuit.create({
    devices: [
      { id: 'sw1', type: BUTTON_IR_TYPE, description: button.device.description },
      { id: 'led1', type: LED_IR_TYPE, description: lamp.device.description },
    ],
    connections: [
      { from: 'sw1.B', to: 'GND' },
      { from: 'sw1.A', to: 'led1.anode' },
      { from: 'led1.cathode', to: 'GND' },
    ],
  });

  try {
    const sw = circuit.devices.sw1;

    sw.press();
    circuit.runBatch(3);
    const lampOnAfterPress = circuit.devices.led1.isOn();
    const closedWhilePressed = sw.isClosed();
    const pressCount = sw.getPressCount();

    sw.release();
    circuit.runBatch(3);
    const lampOnAfterRelease = circuit.devices.led1.isOn();

    return Object.freeze({
      lampOnAfterPress,
      lampOnAfterRelease,
      closedWhilePressed,
      pressCount,
    });
  } finally {
    circuit.dispose();
  }
}
