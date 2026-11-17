import { describe, expect, it } from 'vitest';
import {
  FLASH_ACR_RESET,
  FLASH_CR_LOCK,
  FLASH_CR_OPTLOCK,
  FLASH_CR_RESET,
  FLASH_OPTR_NBOOT0,
  FLASH_OPTR_NBOOT1,
  FLASH_OPTR_NSWBOOT0,
  FLASH_OPTR_RESET,
  FLASH_PAGE_COUNT,
  FLASH_PAGE_SIZE,
  FLASH_SEC1R_BOOT_LOCK,
  FLASH_SIZE,
  bootRegionOf,
  pcropProtectedOffset,
  securablePage,
  writeProtectedPage,
} from '@mica-js/stm32g431rbt6-core/flash-layout';

/** RM0440 category 2 的 128 KiB 页/保护/启动布局，和真实复位值。 */
describe('STM32G431RBT6 Flash 布局与启动策略', () => {
  it('128 KiB 是单 bank、64 页 × 2 KiB', () => {
    expect(FLASH_SIZE).toBe(0x20000);
    expect(FLASH_PAGE_SIZE).toBe(0x800);
    expect(FLASH_PAGE_COUNT).toBe(64);
  });

  it('复位时 CR 同时锁住主存储与选项字节，OPTR 为 RDP level 0', () => {
    expect(FLASH_CR_RESET & FLASH_CR_LOCK).not.toBe(0);
    expect(FLASH_CR_RESET & FLASH_CR_OPTLOCK).not.toBe(0);
    expect(FLASH_ACR_RESET).toBe(0x0004_0601);
    expect(FLASH_OPTR_RESET & 0xff).toBe(0xaa);
    expect(FLASH_OPTR_RESET & FLASH_OPTR_NBOOT1).not.toBe(0);
    expect(FLASH_OPTR_RESET & FLASH_OPTR_NSWBOOT0).not.toBe(0);
    expect(FLASH_OPTR_RESET & FLASH_OPTR_NBOOT0).not.toBe(0);
  });

  it('按 RM0440 Table 5 选择主 Flash / SRAM1 / 系统存储区', () => {
    const flash = FLASH_OPTR_RESET;
    const sram = (flash & ~FLASH_OPTR_NBOOT1) | FLASH_OPTR_NBOOT0 | FLASH_OPTR_NSWBOOT0;
    const system = flash | FLASH_OPTR_NSWBOOT0;

    // nSWBOOT0=1 → BOOT0 来自 PB8。
    expect(bootRegionOf(flash, 0, false)).toBe('flash');
    expect(bootRegionOf(flash, 0, true)).toBe('system');
    expect(bootRegionOf(sram, 0, true)).toBe('sram');
    expect(bootRegionOf(system, 0, true)).toBe('system');

    // nSWBOOT0=0 → BOOT0 来自 nBOOT0 的反值（nBOOT0=1 强制 BOOT0=0）。
    const softwareBoot = flash & ~FLASH_OPTR_NSWBOOT0;
    expect(bootRegionOf(softwareBoot, 0, true)).toBe('flash');
    expect(bootRegionOf(softwareBoot, 0, false)).toBe('flash');
    const softwareBoot0 = softwareBoot & ~FLASH_OPTR_NBOOT0;
    expect(bootRegionOf(softwareBoot0, 0, false)).toBe('system');
    expect(bootRegionOf(softwareBoot0 & ~FLASH_OPTR_NBOOT1, 0, true)).toBe('sram');

    // BOOT_LOCK 强制主 Flash。
    expect(bootRegionOf(system, FLASH_SEC1R_BOOT_LOCK, true)).toBe('flash');
  });

  it('WRP 按页、PCROP 按双字、securable 从页 0 起算', () => {
    expect(writeProtectedPage({ wrp1ar: 0x0003_0002, wrp1br: 0x0000_003f }, 2)).toBe(true);
    expect(writeProtectedPage({ wrp1ar: 0x0003_0002, wrp1br: 0x0000_003f }, 4)).toBe(false);
    expect(writeProtectedPage({ wrp1ar: 0x0000_003f, wrp1br: 0x0000_003f }, 0)).toBe(false);

    expect(pcropProtectedOffset({ pcrop1sr: 2, pcrop1er: 3 }, 0x10)).toBe(true);
    expect(pcropProtectedOffset({ pcrop1sr: 2, pcrop1er: 3 }, 0x08)).toBe(false);
    expect(pcropProtectedOffset({ pcrop1sr: 0x7fff, pcrop1er: 0 }, 0)).toBe(false);

    expect(securablePage(3, 2)).toBe(true);
    expect(securablePage(3, 3)).toBe(false);
    expect(securablePage(0, 0)).toBe(false);
  });
});
