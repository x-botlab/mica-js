/**
 * Example: blink a unified-IR LED from the built-in MCU kernel.
 *
 * The built-in `mcu` kernel toggles every output pin once per tick, so the
 * lamp follows `PA0` on every step. The same circuit is then advanced by one
 * million ticks with a single engine call.
 *
 * ```sh
 * pnpm --filter @mica-js/simulator examples
 * ```
 */
import { Circuit, createLedIR, createMcuDescription, LED_IR_TYPE } from '../src/index';

/** What {@link run} observed while blinking. */
export interface LedBlinkResult {
  /** Lamp samples taken one per `step()`. */
  readonly samples: readonly boolean[];
  /** Number of on/off transitions seen in `samples`. */
  readonly transitions: number;
  /** Lamp state after the one-million-tick batch. */
  readonly lampOnAfterBatch: boolean;
  /** Total ticks completed. */
  readonly ticks: bigint;
}

/** Builds the circuit, steps it 10 times and then runs a 1M-tick batch. */
export async function run(): Promise<LedBlinkResult> {
  const lamp = createLedIR('led1', { color: 'green' });

  const circuit = await Circuit.create({
    devices: [
      { id: 'mcu1', type: 'mcu', description: createMcuDescription() },
      { id: 'led1', type: LED_IR_TYPE, description: lamp.device.description },
    ],
    connections: [
      { from: 'mcu1.PA0', to: 'led1.anode' },
      { from: 'led1.cathode', to: 'GND' },
    ],
  });

  try {
    const samples: boolean[] = [];
    let transitions = 0;
    let previous = circuit.devices.led1.isOn();
    for (let tick = 0; tick < 10; tick += 1) {
      circuit.step();
      const current = circuit.devices.led1.isOn();
      if (current !== previous) transitions += 1;
      previous = current;
      samples.push(current);
    }

    circuit.runBatch(1_000_000);

    return Object.freeze({
      samples: Object.freeze(samples),
      transitions,
      lampOnAfterBatch: circuit.devices.led1.isOn(),
      ticks: circuit.tickCount,
    });
  } finally {
    circuit.dispose();
  }
}
