/**
 * U04 performance observations.
 *
 * LED and button are tick-driven devices, so the throughput path is the
 * generated batch loop: one engine call advances the whole circuit. The legacy
 * scheduler architecture is event-driven (a quiet button schedules no work),
 * which makes a tick-for-tick speedup meaningless for these two devices; the
 * useful comparison is the unified LED against the built-in `ideal-led` kernel
 * it replaces.
 *
 * This file only reports numbers: there are no thresholds and no assertions,
 * because performance must never decide whether a test run passes. It is
 * excluded from `pnpm test` and runs on demand with `pnpm test:perf`. Device
 * behaviour is covered by `led.test.ts` / `button.test.ts`.
 */
import { performance } from 'node:perf_hooks';
import { describe, it } from 'vitest';
import { createLedDescription, createMcuDescription } from '../compiler';
import { Circuit } from '../runtime';
import { createButtonIR, BUTTON_IR_TYPE } from './button';
import { createLedIR, LED_IR_TYPE } from './led';

const TICKS = 200_000;
const WARMUP_TICKS = 1_000;

function unifiedLedInput() {
  return {
    devices: [
      { id: 'mcu1', type: 'mcu' as const, description: createMcuDescription() },
      { id: 'led1', type: LED_IR_TYPE, description: createLedIR('led1').device.description },
    ],
    connections: [
      { from: 'mcu1.PA0', to: 'led1.anode' },
      { from: 'led1.cathode', to: 'GND' },
    ],
  } as const;
}

function builtinLedInput() {
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

function buttonLedInput() {
  const button = createButtonIR('sw1');
  const led = createLedIR('led1');
  return {
    devices: [
      { id: 'sw1', type: BUTTON_IR_TYPE, description: button.device.description },
      { id: 'led1', type: LED_IR_TYPE, description: led.device.description },
    ],
    connections: [
      { from: 'sw1.B', to: 'GND' },
      { from: 'sw1.A', to: 'led1.anode' },
      { from: 'led1.cathode', to: 'GND' },
    ],
  } as const;
}

function measure(circuit: Circuit, ticks: number): number {
  circuit.runBatch(WARMUP_TICKS);
  const start = performance.now();
  circuit.runBatch(ticks);
  return performance.now() - start;
}

describe('simple device performance', () => {
  it('reports unified LED throughput next to the built-in kernel', async () => {
    const unified = await Circuit.create(unifiedLedInput());
    const builtin = await Circuit.create(builtinLedInput());
    try {
      const unifiedMs = measure(unified, TICKS);
      const builtinMs = measure(builtin, TICKS);
      const unifiedRate = TICKS / (unifiedMs / 1000);
      const builtinRate = TICKS / (builtinMs / 1000);
      console.log(
        [
          `unified LED: ${(unifiedRate / 1e6).toFixed(2)} M ticks/s (${unifiedMs.toFixed(1)} ms), lamp=${unified.devices.led1.isOn() ? 'on' : 'off'}`,
          `built-in ideal-led: ${(builtinRate / 1e6).toFixed(2)} M ticks/s (${builtinMs.toFixed(1)} ms), lamp=${builtin.devices.led1.isOn() ? 'on' : 'off'}`,
          `ratio: ${(unifiedRate / builtinRate).toFixed(2)}x`,
        ].join('\n'),
      );
    } finally {
      unified.dispose();
      builtin.dispose();
    }
  });

  it('reports button + LED throughput', async () => {
    const circuit = await Circuit.create(buttonLedInput());
    try {
      circuit.devices.sw1.press();
      const milliseconds = measure(circuit, TICKS);
      const rate = TICKS / (milliseconds / 1000);
      console.log(
        `button + LED: ${(rate / 1e6).toFixed(2)} M ticks/s (${milliseconds.toFixed(1)} ms), ` +
          `lamp=${circuit.devices.led1.isOn() ? 'on' : 'off'}, hold=${circuit.devices.sw1.getHoldTicks()}`,
      );
    } finally {
      circuit.dispose();
    }
  });
});
