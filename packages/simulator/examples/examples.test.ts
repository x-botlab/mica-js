/**
 * Runs every documented example, prints a one-line summary and asserts the
 * behaviour the documentation promises. `pnpm examples` executes this file.
 */
import { describe, expect, it } from 'vitest';
import { run as runBenchmark } from './benchmark';
import { run as runButtonLed } from './button-led';
import { run as runLedBlink } from './led-blink';
import { run as runTeachingMcuBlinky } from './teaching-mcu-blinky';

describe('documented examples', () => {
  it('led-blink: the lamp follows the toggling MCU', async () => {
    const result = await runLedBlink();
    console.log(
      `led-blink: ${result.transitions} transitions in 10 steps, ` +
        `lamp=${result.lampOnAfterBatch ? 'on' : 'off'} after ${result.ticks} ticks`,
    );
    expect(result.samples).toHaveLength(10);
    // The lamp starts dark, so every one of the 10 steps flips it.
    expect(result.transitions).toBe(10);
    expect(result.ticks).toBe(1_000_010n);
    expect(result.lampOnAfterBatch).toBe(false); // even tick count leaves PA0 low
  });

  it('button-led: a debounced press switches the lamp', async () => {
    const result = await runButtonLed();
    console.log(
      `button-led: lamp on after press=${result.lampOnAfterPress}, ` +
        `off after release=${!result.lampOnAfterRelease}, presses=${result.pressCount}`,
    );
    expect(result.lampOnAfterPress).toBe(true);
    expect(result.closedWhilePressed).toBe(true);
    expect(result.pressCount).toBe(1);
    expect(result.lampOnAfterRelease).toBe(false);
  });

  it('teaching-mcu-blinky: firmware toggles the lamp through MMIO', async () => {
    const result = await runTeachingMcuBlinky();
    console.log(
      `teaching-mcu-blinky: ${result.lampTransitions} transitions, ` +
        `${result.cycles} instructions, pc=0x${result.pc.toString(16)}`,
    );
    expect(result.lampTransitions).toBeGreaterThanOrEqual(10);
    expect(result.halted).toBe(false);
    expect(result.cycles).toBeGreaterThan(0);
  });

  it('benchmark: the batch path sustains millions of ticks per second', async () => {
    const result = await runBenchmark(1_000_000, 2);
    console.log(
      `benchmark: ${(result.ticksPerSecond / 1_000_000).toFixed(1)} M ticks/s ` +
        `(${result.nsPerTick.toFixed(1)} ns/tick)`,
    );
    expect(result.ticksPerSecond).toBeGreaterThan(1_000_000);
    expect(result.nsPerTick).toBeLessThan(1_000);
  });
});
