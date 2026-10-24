/**
 * U04 performance measurement.
 *
 * LED and button are tick-driven devices, so the throughput path is the
 * generated batch loop: one engine call advances the whole circuit. The legacy
 * scheduler architecture is event-driven (a quiet button schedules no work),
 * which makes a tick-for-tick speedup meaningless for these two devices; the
 * useful comparison is the unified LED against the built-in `ideal-led` kernel
 * it replaces.
 *
 * The thresholds are deliberately conservative so the test measures structure
 * (one host entry per batch) instead of machine speed.
 */
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
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
  it('runs the unified LED at batch throughput comparable to the built-in kernel', async () => {
    const unified = await Circuit.create(unifiedLedInput());
    const builtin = await Circuit.create(builtinLedInput());
    try {
      expect(unified.devices.led1.isOn()).toBe(false);
      expect(builtin.devices.led1.isOn()).toBe(false);
      const unifiedMs = measure(unified, TICKS);
      const builtinMs = measure(builtin, TICKS);
      const unifiedRate = TICKS / (unifiedMs / 1000);
      const builtinRate = TICKS / (builtinMs / 1000);
      console.log(
        [
          `unified LED: ${(unifiedRate / 1e6).toFixed(2)} M ticks/s (${unifiedMs.toFixed(1)} ms)`,
          `built-in ideal-led: ${(builtinRate / 1e6).toFixed(2)} M ticks/s (${builtinMs.toFixed(1)} ms)`,
          `ratio: ${(unifiedRate / builtinRate).toFixed(2)}x`,
        ].join('\n'),
      );
      expect(unifiedMs).toBeGreaterThan(0);
      expect(unifiedRate).toBeGreaterThan(200_000);
      expect(builtinRate).toBeGreaterThan(200_000);
      // The richer LED must stay in the same order of magnitude.
      expect(unifiedRate).toBeGreaterThan(builtinRate / 10);
    } finally {
      unified.dispose();
      builtin.dispose();
    }
  });

  it('runs a button + LED circuit at batch throughput', async () => {
    const circuit = await Circuit.create(buttonLedInput());
    try {
      circuit.devices.sw1.press();
      const milliseconds = measure(circuit, TICKS);
      const rate = TICKS / (milliseconds / 1000);
      console.log(
        `button + LED: ${(rate / 1e6).toFixed(2)} M ticks/s (${milliseconds.toFixed(1)} ms)`,
      );
      expect(milliseconds).toBeGreaterThan(0);
      expect(rate).toBeGreaterThan(200_000);
      expect(circuit.devices.led1.isOn()).toBe(true);
      expect(circuit.devices.sw1.getHoldTicks()).toBeGreaterThan(TICKS - WARMUP_TICKS - 2);
    } finally {
      circuit.dispose();
    }
  });
});
