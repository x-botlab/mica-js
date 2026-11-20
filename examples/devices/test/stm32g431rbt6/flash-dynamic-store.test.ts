import { FLASH_BASE_REGISTER, FLASH_SIZE } from '@mica-js/stm32g431rbt6-core/layout';
import {
  FLASH_CR,
  FLASH_CR_PG,
  FLASH_KEY1,
  FLASH_KEY2,
  FLASH_KEYR,
  FLASH_SR,
  FLASH_SR_PGSERR,
} from '@mica-js/stm32g431rbt6-core/flash-layout';
import { describe, expect, it } from 'vitest';
import { clockBoard } from './clock-harness';
import { SystemThumb } from './system-thumb';

const FLASH_BASE = 0x0800_0000;
const SRAM = 0x2000_0000;
const TARGET = 0x900;
const LOW_WORD = 0x4770_2042; // movs r0,#0x42; bx lr
const HIGH_WORD = 0x1234_5678;

function firmware(base: number, inline: boolean): Uint8Array {
  const t = new SystemThumb().vector(3, 'fault');
  const load = (reg: number, value: number) => t.movw(reg, value).movt(reg, value >>> 16);
  const writeFlashReg = (offset: number, value: number) => {
    load(1, value).strWord(1, 4, offset);
  };

  load(4, FLASH_BASE_REGISTER);
  load(5, SRAM);
  load(0, base + TARGET).strWord(0, 5, 0);
  // The address comes back from guest SRAM, not from static register facts.
  t.ldrWord(2, 5, 0);
  load(1, LOW_WORD);
  if (inline) {
    t.half(0xc202); // stmia r2!, {r1}: multi-register path does not defer the store.
    t.ldrWord(2, 5, 0);
  } else t.strWord(1, 2, 0);
  t.ldrWord(0, 2, 0).strWord(0, 5, 4);
  t.ldrWord(0, 4, FLASH_SR).strWord(0, 5, 8);
  writeFlashReg(FLASH_SR, FLASH_SR_PGSERR);
  writeFlashReg(FLASH_KEYR, FLASH_KEY1);
  writeFlashReg(FLASH_KEYR, FLASH_KEY2);
  writeFlashReg(FLASH_CR, FLASH_CR_PG);
  t.ldrWord(2, 5, 0);
  if (inline) {
    load(1, LOW_WORD);
    load(3, HIGH_WORD);
    t.half(0xc20a); // stmia r2!, {r1, r3}
  } else {
    load(1, LOW_WORD).strWord(1, 2, 0);
    load(1, HIGH_WORD).strWord(1, 2, 4);
  }
  // Read through the original dynamic address, then execute through the main mapping.
  t.ldrWord(2, 5, 0);
  t.ldrWord(0, 2, 0).strWord(0, 5, 12);
  t.ldrWord(0, 2, 4).strWord(0, 5, 16);
  // The exclusive upper bound of each window is not another Flash alias.
  load(0, base + FLASH_SIZE).strWord(0, 5, 24);
  t.ldrWord(2, 5, 24).ldrWord(0, 2, 0).strWord(0, 5, 28);
  load(2, FLASH_BASE + TARGET + 1).blx(2);
  t.strWord(0, 5, 20).spin();
  t.mark('fault').bkpt().spin();

  const image = new Uint8Array(TARGET + 8).fill(0xff);
  image.set(t.build());
  return image;
}

describe('STM32G431 dynamic Flash accesses', () => {
  it.each([
    ['main Flash, deferred STR', FLASH_BASE, false],
    ['Flash alias, deferred STR', 0, false],
    ['main Flash, inline STMIA', FLASH_BASE, true],
    ['Flash alias, inline STMIA', 0, true],
  ] as const)(
    'preserves lock and programming semantics through %s',
    async (_name, base, inline) => {
      const rig = await clockBoard({ firmware: firmware(base, inline), execution: 'throughput' });
      const errors: string[] = [];
      const subscription = rig.board.onDidError((error) => errors.push(error.message));

      try {
        rig.run(200_000_000);
        expect(errors).toEqual([]);
        expect(rig.topics.fault ?? []).toEqual([]);
        expect(rig.readSram(4)).toBe(0xffff_ffff);
        expect(rig.readSram(8) & FLASH_SR_PGSERR).toBe(FLASH_SR_PGSERR);
        expect(rig.readSram(12)).toBe(LOW_WORD);
        expect(rig.readSram(16)).toBe(HIGH_WORD);
        expect(rig.readSram(20)).toBe(0x42);
        expect(rig.readSram(28)).toBe(0);
      } finally {
        subscription.dispose();
        rig.dispose();
      }
    },
  );
});
