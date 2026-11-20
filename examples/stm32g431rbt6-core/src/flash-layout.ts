/**
 * STM32G431RBT6 主 Flash 与 Flash 控制器（RM0440 category 2，5.3/5.7）的静态布局。
 *
 * 128 KiB 主存储为单 bank、64 页 × 2 KiB；编程粒度是 64 位双字（两次 32 位写），
 * ECC 8 位/双字。这里只放与执行无关的常量与复位值，寄存器行为在 `flash.ts`。
 */

import { FLASH_BASE, FLASH_SIZE } from './layout';

export { FLASH_BASE, FLASH_SIZE };

/** 主存储单 bank：64 页 × 2 KiB。 */
export const FLASH_PAGE_SIZE = 0x800;
export const FLASH_PAGE_COUNT = FLASH_SIZE / FLASH_PAGE_SIZE;
export const FLASH_BANK_COUNT = 1;

/** 编程粒度：一个 64 位双字，由两次 32 位写完成。 */
export const FLASH_DOUBLE_WORD_SIZE = 8;
export const FLASH_WORD_SIZE = 4;

/** 控制器寄存器在专用 `flashState` memory 内的字节偏移。 */
export const FLASH_ACR = 0x00;
export const FLASH_PDKEYR = 0x04;
export const FLASH_KEYR = 0x08;
export const FLASH_OPTKEYR = 0x0c;
export const FLASH_SR = 0x10;
export const FLASH_CR = 0x14;
export const FLASH_ECCR = 0x18;
export const FLASH_OPTR = 0x20;
export const FLASH_PCROP1SR = 0x24;
export const FLASH_PCROP1ER = 0x28;
export const FLASH_WRP1AR = 0x2c;
export const FLASH_WRP1BR = 0x30;
export const FLASH_SEC1R = 0x70;

/** 不属于固件可见寄存器映像的控制器影子。 */
export const FLASH_KEY_STAGE = 0x80;
export const FLASH_OPTKEY_STAGE = 0x84;
export const FLASH_PDKEY_STAGE = 0x88;
/** 待完成的编程首字地址；`0xffff_ffff` 表示没有待完成双字。 */
export const FLASH_PENDING_ADDRESS = 0x8c;
export const FLASH_PENDING_VALUE = 0x90;
/** 忙操作类型：0 空闲、1 编程、2 页擦除、3 全片擦除、4 选项字节。 */
export const FLASH_BUSY_KIND = 0x94;
export const FLASH_BUSY_PAGE = 0x9c;

export const FLASH_BUSY_NONE = 0;
export const FLASH_BUSY_PROGRAM = 1;
export const FLASH_BUSY_PAGE_ERASE = 2;
export const FLASH_BUSY_MASS_ERASE = 3;
export const FLASH_BUSY_OPTION = 4;

/** 解锁序列。 */
export const FLASH_KEY1 = 0x45670123;
export const FLASH_KEY2 = 0xcdef89ab;
export const FLASH_OPTKEY1 = 0x08192a3b;
export const FLASH_OPTKEY2 = 0x4c5d6e7f;
export const FLASH_PDKEY1 = 0x04152637;
export const FLASH_PDKEY2 = 0xfafbfcfd;

/** FLASH_SR（RM0440 5.7.5）。 */
export const FLASH_SR_EOP = 1 << 0;
export const FLASH_SR_OPERR = 1 << 1;
export const FLASH_SR_PROGERR = 1 << 3;
export const FLASH_SR_WRPERR = 1 << 4;
export const FLASH_SR_PGAERR = 1 << 5;
export const FLASH_SR_SIZERR = 1 << 6;
export const FLASH_SR_PGSERR = 1 << 7;
export const FLASH_SR_MISSERR = 1 << 8;
export const FLASH_SR_FASTERR = 1 << 9;
export const FLASH_SR_RDERR = 1 << 14;
export const FLASH_SR_OPTVERR = 1 << 15;
export const FLASH_SR_BSY = 1 << 16;

/** 编程/擦除错误位；任意一位残留时开始新操作会置 PGSERR。 */
export const FLASH_SR_ERRORS =
  FLASH_SR_PROGERR |
  FLASH_SR_WRPERR |
  FLASH_SR_PGAERR |
  FLASH_SR_SIZERR |
  FLASH_SR_PGSERR |
  FLASH_SR_MISSERR |
  FLASH_SR_FASTERR;
/** 可 W1C 的状态位；BSY 只读。 */
export const FLASH_SR_W1C =
  FLASH_SR_EOP |
  FLASH_SR_OPERR |
  FLASH_SR_PROGERR |
  FLASH_SR_WRPERR |
  FLASH_SR_PGAERR |
  FLASH_SR_SIZERR |
  FLASH_SR_PGSERR |
  FLASH_SR_MISSERR |
  FLASH_SR_FASTERR |
  FLASH_SR_RDERR |
  FLASH_SR_OPTVERR;

/** FLASH_CR（RM0440 5.7.6；category 2 的 PNB 为 bit9..3，7 位）。 */
export const FLASH_CR_PG = 1 << 0;
export const FLASH_CR_PER = 1 << 1;
export const FLASH_CR_MER1 = 1 << 2;
export const FLASH_CR_PNB_SHIFT = 3;
export const FLASH_CR_PNB_MASK = 0x7f << FLASH_CR_PNB_SHIFT;
export const FLASH_CR_STRT = 1 << 16;
export const FLASH_CR_OPTSTRT = 1 << 17;
export const FLASH_CR_FSTPG = 1 << 18;
export const FLASH_CR_EOPIE = 1 << 24;
export const FLASH_CR_ERRIE = 1 << 25;
export const FLASH_CR_RDERRIE = 1 << 26;
export const FLASH_CR_OBL_LAUNCH = 1 << 27;
export const FLASH_CR_SEC_PROT1 = 1 << 28;
export const FLASH_CR_OPTLOCK = 1 << 30;
export const FLASH_CR_LOCK = 1 << 31;

/** FLASH_OPTR（RM0440 5.7.8）。 */
export const FLASH_OPTR_RDP_MASK = 0xff;
export const FLASH_OPTR_RDP_LEVEL0 = 0xaa;
export const FLASH_OPTR_RDP_LEVEL2 = 0xcc;
export const FLASH_OPTR_NBOOT1 = 1 << 23;
export const FLASH_OPTR_NSWBOOT0 = 1 << 26;
export const FLASH_OPTR_NBOOT0 = 1 << 27;

/** FLASH_WRP1AR / WRP1BR 的页号字段（category 2 为 6 位）。 */
export const FLASH_WRP_START_MASK = 0x3f;
export const FLASH_WRP_END_SHIFT = 16;
export const FLASH_WRP_END_MASK = 0x3f;

/** FLASH_PCROP1SR / PCROP1ER 的双字偏移字段（15 位）。 */
export const FLASH_PCROP_STRT_MASK = 0x7fff;
export const FLASH_PCROP_END_MASK = 0x7fff;
export const FLASH_PCROP_RDP = 0x80000000;

/** FLASH_SEC1R：BOOT_LOCK 与 securable area 页数。 */
export const FLASH_SEC1R_BOOT_LOCK = 1 << 16;
export const FLASH_SEC1R_SIZE_MASK = 0x7f;

/** FLASH 全局中断：FLASH_IRQn = 4 → 异常号 20。 */
export const FLASH_EXCEPTION = 20;

/**
 * 复位值。`OPTR` 取 ST production 的 RDP=0xAA、BOR=0、nBOOT1/nSWBOOT0/nBOOT0=1
 * 组合；`CR` 同时锁住主存储与选项字节。
 */
export const FLASH_ACR_RESET = 0x0004_0601;
export const FLASH_SR_RESET = 0;
export const FLASH_CR_RESET = 0xc000_0000;
export const FLASH_ECCR_RESET = 0;
export const FLASH_OPTR_RESET = 0xffef_f8aa;
export const FLASH_PCROP1SR_RESET = 0x0000_7fff;
export const FLASH_PCROP1ER_RESET = 0;
export const FLASH_WRP1AR_RESET = 0x0000_003f;
export const FLASH_WRP1BR_RESET = 0x0000_003f;
export const FLASH_SEC1R_RESET = 0;

/** 忙操作时延；真实器件为微秒到几十毫秒量级，模型取 datasheet 量级。 */
export const FLASH_PROGRAM_PS = 50_000_000; // 50 µs
export const FLASH_PAGE_ERASE_PS = 20_000_000_000; // 20 ms
export const FLASH_MASS_ERASE_PS = 40_000_000_000; // 40 ms
export const FLASH_OPTION_PS = 40_000_000_000; // 40 ms

/** 页号必须落在主存储内。 */
export const flashPageValid = (page: number): boolean =>
  Number.isInteger(page) && page >= 0 && page < FLASH_PAGE_COUNT;

/** 双字地址必须是 8 字节对齐且落在主存储内。 */
export const flashDoubleWordAligned = (offset: number): boolean =>
  (offset & (FLASH_DOUBLE_WORD_SIZE - 1)) === 0 &&
  offset >= 0 &&
  offset + FLASH_DOUBLE_WORD_SIZE <= FLASH_SIZE;

export type BootRegion = 'flash' | 'sram' | 'system';

/**
 * RM0440 Table 5 的启动区域选择（最小真实策略）。
 *
 * BOOT0 在 `nSWBOOT0=1` 时来自 PB8 引脚，否则来自 `OPTR.nBOOT0`；`nBOOT1=0`
 * 且 BOOT0=1 选择 SRAM1，`nBOOT1=1` 且 BOOT0=1 选择系统存储区。`BOOT_LOCK=1`
 * 强制主 Flash。系统存储区在本模型不伪装 bootloader，只报告区域。
 */
export function bootRegionOf(optr: number, sec1r: number, boot0Pin: boolean): BootRegion {
  const value = optr >>> 0;

  if (((sec1r >>> 0) & FLASH_SEC1R_BOOT_LOCK) !== 0) return 'flash';

  // nSWBOOT0=1：BOOT0 来自 PB8 引脚；nSWBOOT0=0：BOOT0 来自 nBOOT0 的反值。
  const boot0 = (value & FLASH_OPTR_NSWBOOT0) !== 0 ? boot0Pin : (value & FLASH_OPTR_NBOOT0) === 0;

  if (!boot0) return 'flash';

  return (value & FLASH_OPTR_NBOOT1) === 0 ? 'sram' : 'system';
}

/** WRP 区域是否覆盖某一页；start > end 或超出页范围视为未启用。 */
export function writeProtectedPage(
  registers: {
    readonly wrp1ar: number;
    readonly wrp1br: number;
  },
  page: number,
): boolean {
  for (const register of [registers.wrp1ar, registers.wrp1br]) {
    const start = (register >>> 0) & FLASH_WRP_START_MASK;
    const end = ((register >>> FLASH_WRP_END_SHIFT) >>> 0) & FLASH_WRP_END_MASK;

    if (
      start <= end &&
      start < FLASH_PAGE_COUNT &&
      end < FLASH_PAGE_COUNT &&
      page >= start &&
      page <= end
    )
      return true;
  }

  return false;
}

/** PCROP 区域是否覆盖某个双字偏移（PCROP 以双字为粒度）。 */
export function pcropProtectedOffset(
  registers: {
    readonly pcrop1sr: number;
    readonly pcrop1er: number;
  },
  offset: number,
): boolean {
  const start = (registers.pcrop1sr >>> 0) & FLASH_PCROP_STRT_MASK;
  const end = (registers.pcrop1er >>> 0) & FLASH_PCROP_END_MASK;

  if (start > end) return false;

  const doubleWord = (offset >>> 0) >>> 3;

  return doubleWord >= start && doubleWord <= end;
}

/** securable area 是否覆盖某一页（SEC_SIZE1 = 起始处页数）。 */
export function securablePage(sec1r: number, page: number): boolean {
  const size = (sec1r >>> 0) & FLASH_SEC1R_SIZE_MASK;

  return size > 0 && page >= 0 && page < Math.min(size, FLASH_PAGE_COUNT);
}
