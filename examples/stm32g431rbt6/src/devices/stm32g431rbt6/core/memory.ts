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
 */

/** `u32(address - base) < size`：一次减法加一次比较，越界与回绕都自然落到 false。 */
const inRegion = (b: Body, address: Value<number>, base: number, size: number): Value<boolean> =>
  b.lessThan(u32(b, b.subtract(address, num(b, base))), num(b, size));

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

export function readMemory(b: Body, address: Value<number>, size: number): Value<number> {
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
                  periph.setLocal(result, readPeripheral(asBody(periph), address, size));
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
): void {
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
              writePeripheral(asBody(periph), address, size, value);
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
