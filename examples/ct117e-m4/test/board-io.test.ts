import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createHarness } from './harness';

const MS = 1_000_000_000;
const halfPeriod = (position: number) => Math.LN2 * (100 + position * 10_000) * 100_000;
const timerCounts = (position: number) => (2 * halfPeriod(position)) / 12_500; // 80 MHz.

it('runs the netlisted board I/O from firmware in the released single instance', async () => {
  const hex = await readFile(new URL('./fixtures/board-io.hex', import.meta.url));
  const board = await createHarness({ hex, stepPs: MS / 4 });
  const ram = board.memory('sram');
  const view = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
  const word = (index: number) => view.getUint32(index * 4, true);
  const { methods } = board.model;
  const button = (id: number, pressed: boolean) => methods['setButton']!({ id, pressed });
  const leds = () => methods['getLedState']!(null);
  const eeprom = async () => {
    const dump = await methods['readEeprom']!(null);
    if (!(dump instanceof Uint8Array)) throw new TypeError('Expected EEPROM snapshot');
    return dump;
  };
  const period = (index: number, position: number) =>
    expect(
      Math.abs(word(index) - timerCounts(position)),
      `capture slot ${index}: ${word(index)}`,
    ).toBeLessThanOrEqual(1);

  try {
    await board.advanceTo(MS / 4);
    expect(word(0)).toBe(1);
    expect(word(1)).toBe(15);
    expect(await leds()).toBe(0);
    expect(await eeprom()).toEqual(new Uint8Array(256));
    expect(await methods['getWiper']!(null)).toBe(0x3f);

    await methods['setPotentiometer']!({ id: 1, position: 0.25 });
    await methods['setPotentiometer']!({ id: 2, position: 0.75 });
    await button(3, true);
    await button(4, true);
    await button(1, true);
    await board.advanceTo(MS / 2);
    expect(word(2)).toBe(2);
    expect(await leds()).toBe(0x5a); // LE high; MCU drives PC8–PC15.

    await button(2, true);
    await board.advanceTo(MS);
    expect(board.diagnostics).toEqual([]);
    expect(board.errors).toEqual([]);
    expect(board.faults).toEqual([]);
    expect(word(3)).toBe(0x9325);
    expect(await leds()).toBe(0x6c); // Captured LCD D8–D15; later MCU writes do not change Q.
    expect(Array.from({ length: 6 }, (_, i) => word(4 + i))).toEqual([0, 0x7f, 0x5a, 0, 7, 0x10]);
    const dump = await eeprom();
    expect(dump[0]).toBe(0xc3);
    expect(dump[7]).toBe(0x5a);
    dump[7] = 0;
    expect((await eeprom())[7]).toBe(0x5a);
    expect(await methods['getWiper']!(null)).toBe(0x10);
    const rwb = (100_000 * 0x10) / 127 + 100;
    expect([word(10), word(11), word(12), word(13)]).toEqual([
      Math.round(4095 * 0.25),
      Math.round(4095 * 0.75),
      Math.round((4095 * rwb) / (10_000 + rwb)),
      1,
    ]);
    await board.advanceTo(4 * MS);
    period(15, 0.5);
    period(17, 0.5);
    expect([word(18), word(19)]).toEqual([5, 5]); // Every rising edge, not just the last pair.

    await methods['setTimerPotentiometer']!({ id: 1, position: 0.2 });
    await methods['setTimerPotentiometer']!({ id: 2, position: 0.8 });
    await board.advanceTo(10 * MS);
    period(15, 0.2);
    period(17, 0.8);
    await board.advanceTo(18 * MS);
    expect((await board.framebuffer()).subarray(8).some((byte) => byte !== 0)).toBe(true);

    await button(1, false);
    await button(2, false);
    await button(3, false);
    await button(4, false);
    const captures = [word(18), word(19)];
    await methods['setReset']!(true);
    await board.advanceTo(19 * MS);
    expect(board.state('halted')).toBe(true);
    expect(word(0)).toBe(1);
    expect([word(18), word(19)]).toEqual(captures);
    await methods['setReset']!(false);
    await board.advanceTo(36 * MS);
    expect(word(0)).toBe(2);
    expect(word(1)).toBe(15);
    expect((await board.framebuffer()).subarray(8).every((byte) => byte === 0)).toBe(true);
    expect(await leds()).toBe(0x6c);
    expect((await eeprom())[7]).toBe(0x5a);
    expect(await methods['getWiper']!(null)).toBe(0x10);
    expect(board.instance.jits).toHaveLength(1);
    expect(board.diagnostics).toEqual([]);
    expect(board.errors).toEqual([]);
    expect(board.faults).toEqual([]);
  } finally {
    await board.dispose();
  }
});
