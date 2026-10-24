/**
 * Composite scenarios: more devices, richer devices and real firmware.
 *
 * All variants run on the unified pipeline; the head-to-head comparison against
 * the scheduler architecture lives in `unified-simple.bench.ts`.
 */
import { test } from 'vitest';
import { createLedDescription, createMcuDescription } from '../src/unified-ir/compiler';
import { createButtonIR, BUTTON_IR_TYPE } from '../src/unified-ir/devices/button';
import { createLedIR, LED_IR_TYPE } from '../src/unified-ir/devices/led';
import { createTeachingMCUIR, TEACHING_MCU_IR_TYPE } from '../src/unified-ir/examples/teaching-mcu';
import { Circuit } from '../src/unified-ir/runtime';
import { blinkyFirmware } from '../examples/firmware';

/** Ticks per measured op for device-dominated circuits. */
const TICKS = 100_000;

/** Ticks per measured op for the instruction-dominated MCU. */
const MCU_TICKS = 20_000;

/** Instructions retired per tick in the teaching-MCU scenario. */
const INSTRUCTIONS_PER_TICK = 1_000;

const PIN_NAMES = ['PA0', 'PA1', 'PA2', 'PA3', 'PA4', 'PA5', 'PA6', 'PA7'] as const;

/** MCU + eight LEDs: one driver, eight nets, eight loads. */
const eightLeds = await Circuit.create({
  devices: [
    { id: 'mcu', type: 'mcu', description: createMcuDescription({ pins: PIN_NAMES }) },
    ...PIN_NAMES.map((pin) => ({
      id: `led_${pin}`,
      type: 'ideal-led' as const,
      description: createLedDescription(),
    })),
  ],
  connections: PIN_NAMES.flatMap((pin) => [
    { from: `mcu.${pin}`, to: `led_${pin}.anode` },
    { from: `led_${pin}.cathode`, to: 'GND' },
  ]),
});

/** Button + rich LED: a pressed button keeps the switched net high. */
const button = createButtonIR('sw1', { debounceTicks: 2 });
const lamp = createLedIR('led1');
const buttonLed = await Circuit.create({
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
buttonLed.devices.sw1.press();

/** Teaching Cortex-M3 running a real blink loop, driving one LED over GPIO. */
const mcu = createTeachingMCUIR('mcu', {
  isa: 'm3',
  ports: ['A'],
  portWidth: 1,
  firmware: blinkyFirmware(50),
  instructionsPerTick: INSTRUCTIONS_PER_TICK,
});
const mcuLed = await Circuit.create({
  devices: [
    { id: 'mcu', type: TEACHING_MCU_IR_TYPE, description: mcu.device.description },
    { id: 'led1', type: 'ideal-led', description: createLedDescription() },
  ],
  connections: [
    { from: 'mcu.PA0', to: 'led1.anode' },
    { from: 'led1.cathode', to: 'GND' },
  ],
});

/** Subset of a bench result the report needs. */
interface BenchStats {
  readonly throughput: { readonly mean: number };
}

/** Prints throughput and ns/tick for one result. */
function log(label: string, result: BenchStats | undefined, ticksPerOp: number): number {
  if (result === undefined) throw new Error(`bench.compare did not report "${label}"`);
  const ticksPerSecond = result.throughput.mean * ticksPerOp;
  const nsPerTick = 1e9 / ticksPerSecond;
  console.log(
    `[unified-devices.bench] ${label}: ${(ticksPerSecond / 1_000_000).toFixed(1)} M ticks/s ` +
      `(${nsPerTick.toFixed(1)} ns/tick)`,
  );
  return ticksPerSecond;
}

test('more devices: MCU + 8 LEDs and a held button', async ({ bench }) => {
  eightLeds.runBatch(10_000);
  const results = await bench.compare(
    bench('mcu + 8 ideal-leds', () => {
      eightLeds.runBatch(TICKS);
    }),
    bench('button + led-ir', () => {
      buttonLed.runBatch(TICKS);
    }),
    { time: 2_000, warmupTime: 500 },
  );
  log('mcu + 8 ideal-leds', results.get('mcu + 8 ideal-leds'), TICKS);
  log('button + led-ir', results.get('button + led-ir'), TICKS);
});

test('teaching MCU: real firmware, 1000 instructions per tick', async ({ bench }) => {
  mcuLed.runBatch(1_000);
  const result = await bench('teaching-mcu m3 + led', () => {
    mcuLed.runBatch(MCU_TICKS);
  }).run({ time: 4_000, warmupTime: 1_000 });
  log('teaching-mcu m3 + led', result, MCU_TICKS);

  // The guest's own cycle counter is the source of truth for retired
  // instructions, so measure one timed batch instead of assuming that every
  // tick filled its whole instruction slice.
  const guest = mcuLed.devices.mcu;
  const before = guest.getCycles();
  const started = performance.now();
  mcuLed.runBatch(MCU_TICKS);
  const elapsedMs = performance.now() - started;
  const instructions = guest.getCycles() - before;
  console.log(
    `[unified-devices.bench] teaching-mcu m3 instructions: ` +
      `${(instructions / (elapsedMs / 1_000) / 1_000_000).toFixed(1)} M inst/s ` +
      `(${instructions} instructions in ${elapsedMs.toFixed(1)} ms, ` +
      `${INSTRUCTIONS_PER_TICK} per tick slice)`,
  );
});

test('the composite circuits still produce the expected signal', async () => {
  eightLeds.runBatch(1);
  for (const pin of PIN_NAMES) {
    const accessor = eightLeds.devices[`led_${pin}`];
    if (accessor === undefined || !accessor.isOn()) {
      throw new Error(`led_${pin} did not follow mcu.${pin}`);
    }
  }
  buttonLed.runBatch(3); // release the debounce window
  if (!buttonLed.devices.led1.isOn()) {
    throw new Error('the pressed button did not drive the LED');
  }
  mcuLed.runBatch(200);
  if (mcuLed.devices.mcu.isHalted()) {
    throw new Error('the blinky firmware halted unexpectedly');
  }
  eightLeds.dispose();
  buttonLed.dispose();
  mcuLed.dispose();
});
