import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import {
  CCM,
  CCM_BASE,
  CCM_SIZE,
  CODE,
  FLASH_ALIAS_BASE,
  FLASH_BASE,
  FLASH_SIZE,
  PERIPHERAL_BASE,
  PERIPHERAL_END,
  SRAM,
  SRAM_BASE,
  SRAM_SIZE,
  SYSTEM_BASE,
  SYSTEM_END,
} from './layout';
import {
  asBody,
  num,
  readByte,
  readHalf,
  readWord,
  u32,
  writeByte,
  writeHalf,
  writeWord,
} from './ir';
import type { Body } from './ir';
import { readPeripheral, writePeripheral } from './bus';
import { readSystem, writeSystem } from './nvic';

/**
 * 32 位地址空间的访存分派。
 *
 * Flash 别名（0x00000000）与 0x08000000 指向同一份 `code`；SRAM1/CCM 直接寻址；
 * 外设区交给 `bus.ts`，系统区交给 `nvic.ts`。未映射地址读出 0、写入忽略：固件访问
 * 未建模外设时不会把整块板拖进故障。
 *
 * 区间判定压成一次「减基址后按 32 位无符号比较」：一次减法 + 一次比较代替
 * 「下界与上界各比一次」，并按访问频率排序成 if/else 链，命中即停。
 *
 * 指令编码本身常常已经确定了区间：`ldr [pc, #imm]` 只可能落在 `code`，`push`/`pop`
 * 与所有 SP 相对访存只可能落在 SRAM。这类访问用 `At` 声明静态区间，只发射命中的
 * 那一条路径；否则每条指令都要内联整棵分派树，`pop.w {r2-r11, pc}` 这样的多寄存器
 * 指令会按寄存器数量把树重复十几遍。
 */

/** 编译期已知的访存区间。 */
export type Region = 'code' | 'sram' | 'ccm' | 'peripheral' | 'system';

/** 静态区间声明。`offset` 是区内偏移：给出时按常量偏移发射（地址本身在翻译期已知），
 * 省略时按 `address - 基址` 运行期计算。
 */
export interface At {
  readonly region: Region;
  readonly offset?: number;
}

/**
 * 单寄存器装载的延迟读描述。命中 GPIO IDR 时不在指令块内逐脚拼字，而是把目标寄存器、
 * 宽度与符号扩展记进 state，由 `SERVICE_READ` 组包后写回。
 */
export interface DeferRead {
  readonly target: number;
  readonly signed: boolean;
}

/** `ldr [pc, #imm]` 一类：两个 Flash 别名共用同一份 `code`，偏移按窗口取模。 */
export const CODE_MASK = FLASH_SIZE - 1;

const at = (region: Region, offset?: number): At =>
  offset === undefined ? { region } : { region, offset };

export const atCode = (offset?: number): At => at('code', offset);
export const atSram = (offset?: number): At => at('sram', offset);
export const atCcm = (offset?: number): At => at('ccm', offset);

/** `u32(address - base) < size`：一次减法加一次比较，越界与回绕都自然落到 false。 */
const inRegion = (b: Body, address: Value<number>, base: number, size: number): Value<boolean> =>
  b.lessThan(u32(b, b.subtract(address, num(b, base))), num(b, size));

/** 静态区间内的偏移：常量偏移直接发射，否则按区间基址换算。 */
function regionOffset(b: Body, address: Value<number>, at: At): Value<number> {
  if (at.offset !== undefined) return num(b, at.offset);

  switch (at.region) {
    case 'code':
      return b.bitAnd(address, num(b, CODE_MASK));
    case 'sram':
      return b.subtract(address, num(b, SRAM_BASE));
    case 'ccm':
      return b.subtract(address, num(b, CCM_BASE));
    default:
      return address;
  }
}

/** 命中静态区间时只发射该区间的一条路径。 */
function readAt(
  b: Body,
  address: Value<number>,
  size: number,
  at: At,
  defer?: DeferRead,
): Value<number> | undefined {
  const offset = regionOffset(b, address, at);

  switch (at.region) {
    case 'code':
      return loadWidth(b, CODE, offset, size);
    case 'sram':
      return loadWidth(b, SRAM, offset, size);
    case 'ccm':
      return loadWidth(b, CCM, offset, size);
    case 'peripheral':
      return readPeripheral(b, address, size, defer);
    case 'system':
      return readSystem(b, address, size);
    default:
      return undefined;
  }
}

function writeAt(
  b: Body,
  address: Value<number>,
  size: number,
  value: Value<number>,
  at: At,
): void {
  const offset = regionOffset(b, address, at);

  switch (at.region) {
    case 'code':
      storeWidth(b, CODE, offset, size, value);
      return;
    case 'sram':
      storeWidth(b, SRAM, offset, size, value);
      return;
    case 'ccm':
      storeWidth(b, CCM, offset, size, value);
      return;
    case 'peripheral':
      writePeripheral(b, address, size, value);
      return;
    case 'system':
      writeSystem(b, address, size, value);
  }
}

function loadWidth(b: Body, memory: string, offset: Value<number>, size: number): Value<number> {
  if (size === 1) return readByte(b, memory, offset);
  if (size === 2) return readHalf(b, memory, offset);

  return readWord(b, memory, offset);
}

function storeWidth(
  b: Body,
  memory: string,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  if (size === 1) {
    writeByte(b, memory, offset, value);

    return;
  }

  if (size === 2) {
    writeHalf(b, memory, offset, value);

    return;
  }

  writeWord(b, memory, offset, value);
}

const offsetFrom = (b: Body, address: Value<number>, base: number): Value<number> =>
  b.subtract(address, num(b, base));

export function readMemory(
  b: Body,
  address: Value<number>,
  size: number,
  at?: At,
  defer?: DeferRead,
): Value<number> {
  if (at !== undefined) return readAt(b, address, size, at, defer)!;

  const result = b.local(types.number, 0);

  b.if(
    inRegion(b, address, SRAM_BASE, SRAM_SIZE),
    (ram) => {
      const body = asBody(ram);

      body.setLocal(result, loadWidth(body, SRAM, offsetFrom(body, address, SRAM_BASE), size));
    },
    (other) => {
      const body = asBody(other);

      body.if(
        inRegion(body, address, FLASH_BASE, FLASH_SIZE),
        (flash) => {
          const inner = asBody(flash);

          inner.setLocal(
            result,
            loadWidth(inner, CODE, offsetFrom(inner, address, FLASH_BASE), size),
          );
        },
        (rest) => {
          const inner = asBody(rest);

          inner.if(
            inRegion(inner, address, CCM_BASE, CCM_SIZE),
            (ccm) => {
              const scope = asBody(ccm);

              scope.setLocal(
                result,
                loadWidth(scope, CCM, offsetFrom(scope, address, CCM_BASE), size),
              );
            },
            (next) => {
              const scope = asBody(next);

              scope.if(
                inRegion(scope, address, PERIPHERAL_BASE, PERIPHERAL_END - PERIPHERAL_BASE),
                (periph) => {
                  periph.setLocal(result, readPeripheral(asBody(periph), address, size, defer));
                },
                (after) => {
                  const tail = asBody(after);

                  tail.if(
                    inRegion(tail, address, SYSTEM_BASE, SYSTEM_END - SYSTEM_BASE),
                    (system) => {
                      system.setLocal(result, readSystem(asBody(system), address, size));
                    },
                    (alias) => {
                      const last = asBody(alias);

                      last.if(inRegion(last, address, FLASH_ALIAS_BASE, FLASH_SIZE), (mirror) => {
                        const scope = asBody(mirror);

                        scope.setLocal(
                          result,
                          loadWidth(
                            scope,
                            CODE,
                            offsetFrom(scope, address, FLASH_ALIAS_BASE),
                            size,
                          ),
                        );
                      });
                    },
                  );
                },
              );
            },
          );
        },
      );
    },
  );

  return b.getLocal(result);
}

export function writeMemory(
  b: Body,
  address: Value<number>,
  size: number,
  value: Value<number>,
  at?: At,
  defer = false,
): void {
  if (at !== undefined) {
    writeAt(b, address, size, value, at);

    return;
  }

  b.if(
    inRegion(b, address, SRAM_BASE, SRAM_SIZE),
    (ram) => {
      const body = asBody(ram);

      storeWidth(body, SRAM, offsetFrom(body, address, SRAM_BASE), size, value);
    },
    (other) => {
      const body = asBody(other);

      body.if(
        inRegion(body, address, CCM_BASE, CCM_SIZE),
        (ccm) => {
          const scope = asBody(ccm);

          storeWidth(scope, CCM, offsetFrom(scope, address, CCM_BASE), size, value);
        },
        (rest) => {
          const inner = asBody(rest);

          inner.if(
            inRegion(inner, address, PERIPHERAL_BASE, PERIPHERAL_END - PERIPHERAL_BASE),
            (periph) => {
              writePeripheral(asBody(periph), address, size, value, defer);
            },
            (next) => {
              const scope = asBody(next);

              scope.if(
                inRegion(scope, address, SYSTEM_BASE, SYSTEM_END - SYSTEM_BASE),
                (system) => {
                  writeSystem(asBody(system), address, size, value);
                },
              );
            },
          );
        },
      );
    },
  );
  // Flash 写入（IAP/Flash 编程）未建模：忽略，保留固件映像。
}
