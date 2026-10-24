/**
 * Micro benchmarks: the cost of one compile, one tick, one batch, one reset
 * and one accessor call.
 *
 * Every measurement reports nanoseconds per *operation*, where the operation is
 * named in the benchmark label (a compile, a tick, or one thousand calls).
 */
import { test } from 'vitest';
import {
  compileCircuit,
  createLedDescription,
  createMcuDescription,
} from '../src/unified-ir/compiler';
import { createButtonIR, BUTTON_IR_TYPE } from '../src/unified-ir/devices/button';
import { createLedIR, LED_IR_TYPE } from '../src/unified-ir/devices/led';
import { Circuit } from '../src/unified-ir/runtime';

const LED_ONLY_INPUT = {
  devices: [{ id: 'led', type: 'ideal-led', description: createLedDescription() }],
  connections: [],
} as const;

const MCU_LED_INPUT = {
  devices: [
    { id: 'mcu', type: 'mcu', description: createMcuDescription() },
    { id: 'led', type: 'ideal-led', description: createLedDescription() },
  ],
  connections: [
    { from: 'mcu.PA0', to: 'led.anode' },
    { from: 'led.cathode', to: 'GND' },
  ],
} as const;

const ledOnly = await Circuit.create(LED_ONLY_INPUT);
const mcuLed = await Circuit.create(MCU_LED_INPUT);
const button = createButtonIR('sw1', { debounceTicks: 2 });
const richLamp = createLedIR('led1');
const buttonLed = await Circuit.create({
  devices: [
    { id: 'sw1', type: BUTTON_IR_TYPE, description: button.device.description },
    { id: 'led1', type: LED_IR_TYPE, description: richLamp.device.description },
  ],
  connections: [
    { from: 'sw1.B', to: 'GND' },
    { from: 'sw1.A', to: 'led1.anode' },
    { from: 'led1.cathode', to: 'GND' },
  ],
});
buttonLed.devices.sw1.press();

/** Subset of a bench result the report needs. */
interface BenchStats {
  readonly throughput: { readonly mean: number };
}

/**
 * Prints `ns` per measured unit for one benchmark result.
 *
 * @param unitsPerOp - How many units (calls, ticks) one benchmark iteration
 *   performs; the reported number is one unit.
 */
function log(label: string, result: BenchStats | undefined, unitsPerOp = 1): void {
  if (result === undefined) throw new Error(`bench.compare did not report "${label}"`);
  const nsPerOp = 1e9 / result.throughput.mean;
  console.log(`[unified-micro.bench] ${label}: ${(nsPerOp / unitsPerOp).toFixed(1)} ns/unit`);
}

test('compile: one MCU + LED circuit', async ({ bench }) => {
  const result = await bench('compileCircuit(mcu + led)', () => {
    compileCircuit(MCU_LED_INPUT);
  }).run({ time: 1_000, warmupTime: 200 });
  log('compileCircuit(mcu + led)', result, 1);
});

test('single device: step vs. batch', async ({ bench }) => {
  const results = await bench.compare(
    bench('led-only step()', () => {
      ledOnly.step();
    }),
    bench('led-only runBatch(1000)', () => {
      ledOnly.runBatch(1_000);
    }),
    bench('button + led runBatch(1000)', () => {
      buttonLed.runBatch(1_000);
    }),
    { time: 1_000, warmupTime: 200 },
  );
  log('led-only step()', results.get('led-only step()'), 1);
  log('led-only runBatch(1000)', results.get('led-only runBatch(1000)'), 1_000);
  log('button + led runBatch(1000)', results.get('button + led runBatch(1000)'), 1_000);
});

test('teardown: reset restores every memory', async ({ bench }) => {
  mcuLed.runBatch(100);
  const result = await bench('reset() after 100 ticks', () => {
    mcuLed.runBatch(100);
    mcuLed.reset();
  }).run({ time: 1_000, warmupTime: 200 });
  // One reset plus the 100 ticks that give it something to restore.
  log('reset() after 100 ticks', result, 1);
});

test('host surface: accessors and pins', async ({ bench }) => {
  let tick = 0;
  const results = await bench.compare(
    bench('devices.led.isOn() x1000', () => {
      for (let index = 0; index < 1_000; index += 1) mcuLed.devices.led.isOn();
    }),
    bench('getPin("led.anode") x1000', () => {
      for (let index = 0; index < 1_000; index += 1) mcuLed.getPin('led.anode');
    }),
    bench('setPin("mcu.PA0") x1000', () => {
      tick += 1;
      for (let index = 0; index < 1_000; index += 1) {
        mcuLed.setPin('mcu.PA0', (index + tick) % 2 === 0);
      }
    }),
    { time: 1_000, warmupTime: 200 },
  );
  log('devices.led.isOn() x1000', results.get('devices.led.isOn() x1000'), 1_000);
  log('getPin("led.anode") x1000', results.get('getPin("led.anode") x1000'), 1_000);
  log('setPin("mcu.PA0") x1000', results.get('setPin("mcu.PA0") x1000'), 1_000);
});
