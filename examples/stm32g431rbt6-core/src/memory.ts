import { types } from '@mica-js/sdk/model';
import type { JitFunctionBuilder, Value } from '@mica-js/sdk/model';
import {
  CCM,
  CCM_BASE,
  CCM_SIZE,
  CODE,
  FLASH_ALIAS_BASE,
  FLASH_BASE,
  FLASH_SIZE,
  GPIO_BASE,
  GPIO_PORT_STRIDE,
  PERIPHERAL_BASE,
  PERIPHERAL_END,
  SRAM,
  SRAM_BASE,
  SRAM_SIZE,
  SYSTEM_BASE,
  SYSTEM_END,
} from './layout';
import type { AccessSize } from './layout';
import {
  asBody,
  boolOr,
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
import { readPeripheral, registerDeferredWrite, writePeripheral } from './bus';
import {
  GPIO_BRR,
  GPIO_BSRR,
  canInlineStaticGpioWrite,
  inlineStaticGpioWriteChangesPin,
} from './gpio';
import { readSystem, writeSystem } from './nvic';
import { writeFlashMemory } from './flash';
import { machine } from './machine';

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
export type Region = 'code' | 'sram' | 'ccm' | 'peripheral' | 'system' | 'none';

/** 静态区间声明。`offset` 是区内偏移：给出时按常量偏移发射（地址本身在翻译期已知），
 * 省略时按 `address - 基址` 运行期计算。
 */
export interface At {
  readonly region: Region;
  readonly offset?: number;
  /** 翻译期已经证明的具体地址；存在时静态消解整棵区间分派树。 */
  readonly address?: number;
  /** 翻译期已经证明的写入常量；仅对写访问有意义。 */
  readonly value?: number;
  /** 静态地址的区间标志，便于分析与后续优化直接读取。 */
  readonly code?: boolean;
  readonly sram?: boolean;
  readonly ccm?: boolean;
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

/** 按 32 位地址空间把具体地址归类到唯一的静态访问区间。 */
export function regionOfAddress(address: number): Region {
  const addr = address >>> 0;

  if ((addr - SRAM_BASE) >>> 0 < SRAM_SIZE) return 'sram';
  if ((addr - FLASH_BASE) >>> 0 < FLASH_SIZE) return 'code';
  if ((addr - CCM_BASE) >>> 0 < CCM_SIZE) return 'ccm';
  if ((addr - PERIPHERAL_BASE) >>> 0 < PERIPHERAL_END - PERIPHERAL_BASE) return 'peripheral';
  if ((addr - SYSTEM_BASE) >>> 0 < SYSTEM_END - SYSTEM_BASE) return 'system';
  if ((addr - FLASH_ALIAS_BASE) >>> 0 < FLASH_SIZE) return 'code';

  return 'none';
}

/** 为翻译期已知的具体地址生成静态访存描述。 */
export const atAddress = (address: number, value?: number): At => {
  const addr = address >>> 0;
  const region = regionOfAddress(addr);

  return {
    region,
    address: addr,
    ...(value === undefined ? {} : { value: value >>> 0 }),
    code: region === 'code',
    sram: region === 'sram',
    ccm: region === 'ccm',
  };
};

/** 具体地址对应的已建模 GPIO 端口；端口 4 不存在，端口 5 对应 GPIOF。 */
function gpioPortAt(address: number): number | undefined {
  const relative = (address - GPIO_BASE) >>> 0;
  const port = relative >>> 10;

  if (relative >= GPIO_PORT_STRIDE * 6) return undefined;
  if (port === 0 || port === 1 || port === 2 || port === 3 || port === 5) return port;

  return undefined;
}

/** 该访问是否仍可能触发外设服务；动态地址必须保守地返回 true。 */
export function atMayService(
  at: At | undefined,
  access: 'read' | 'write',
  size: AccessSize = 4,
): boolean {
  if (at === undefined) return true;

  const region = at.address === undefined ? at.region : regionOfAddress(at.address);

  if (region === 'system') return true;
  if (region !== 'peripheral' || at.address === undefined) return region === 'peripheral';

  if (gpioPortAt(at.address) === undefined) return true;

  const offset = (at.address - GPIO_BASE) & 0x3ff;
  const wordOffset = offset & 0x3c;

  // BSRR/BRR 读回恒为零。IDR 写以及最多两根候选引脚的静态 BSRR/BRR 写由
  // deferGpioWrite 原地处理；极端电源跳变留下的同步请求由批次末尾的 tickValue 结算。
  if (access === 'read' && (wordOffset === GPIO_BSRR || wordOffset === GPIO_BRR)) return false;
  if (access === 'write' && canInlineStaticGpioWrite(at.address, size, at.value)) return false;

  return true;
}

/** 一次访存对批次控制流的附加影响。 */
export interface AccessEffects {
  boundaryAfter: boolean;
}

/** 该静态写之后是否必须结束基本块，让宿主电气边界看到引脚变化。 */
export function atEndsBatch(
  at: At | undefined,
  access: 'read' | 'write',
  size: AccessSize = 4,
): boolean {
  return (
    access === 'write' &&
    at?.address !== undefined &&
    inlineStaticGpioWriteChangesPin(at.address, size, at.value)
  );
}

/** 查询访问是否触发服务，并累计静态 GPIO 输出边沿所需的批次边界。 */
export function atAccessEffects(
  at: At | undefined,
  access: 'read' | 'write',
  size: AccessSize,
  effects: AccessEffects,
): boolean {
  if (atEndsBatch(at, access, size)) effects.boundaryAfter = true;

  return atMayService(at, access, size);
}

/** GPIO BSRR/BRR 是只写寄存器，读回值恒为 0。 */
export function gpioReadsAsZero(address: number): boolean {
  const addr = address >>> 0;

  if (gpioPortAt(addr) === undefined) return false;
  const register = (addr - GPIO_BASE) & (GPIO_PORT_STRIDE - 1);

  return register === 0x18 || register === 0x28;
}

/** `u32(address - base) < size`：一次减法加一次比较，越界与回绕都自然落到 false。 */
const inRegion = (b: Body, address: Value<number>, base: number, size: number): Value<boolean> =>
  b.lessThan(u32(b, b.subtract(address, num(b, base))), num(b, size));

// Keep both window bounds, but lower the shared Flash operation only once. Both
// bases are aligned to FLASH_SIZE, so the low bits are the same bank offset.
const inFlash = (b: Body, address: Value<number>): Value<boolean> =>
  boolOr(
    b,
    inRegion(b, address, FLASH_BASE, FLASH_SIZE),
    inRegion(b, address, FLASH_ALIAS_BASE, FLASH_SIZE),
  );

const systemReadName = (size: number): string => `mcuReadSystem${size}`;
const systemWriteName = (size: AccessSize): string => `mcuWriteSystem${size}`;

/** Reuse NVIC/SCB/SysTick emitters with the same active Machine as translation. */
export function buildSystemAccessFunctions(builder: JitFunctionBuilder): void {
  const address = { name: 'systemAddress', type: types.number } as const;
  const value = { name: 'systemValue', type: types.number } as const;
  for (const size of [1, 2, 4] as const) {
    builder.fn(
      { name: systemReadName(size), params: [address], returns: types.number },
      (body, args) => body.returnValue(readSystem(asBody(body), args.systemAddress, size)),
    );
    builder.fn({ name: systemWriteName(size), params: [address, value] }, (body, args) => {
      writeSystem(asBody(body), args.systemAddress, size, args.systemValue);
    });
  }
}

/** 静态区间内的偏移：常量偏移直接发射，否则按区间基址换算。 */
function regionOffset(b: Body, address: Value<number>, at: At): Value<number> {
  if (at.offset !== undefined) return num(b, at.offset);

  const region = at.address === undefined ? at.region : regionOfAddress(at.address);

  if (at.address !== undefined) {
    if (region === 'code') return num(b, at.address & CODE_MASK);
    if (region === 'sram') return num(b, (at.address - SRAM_BASE) >>> 0);
    if (region === 'ccm') return num(b, (at.address - CCM_BASE) >>> 0);

    return num(b, at.address);
  }

  switch (region) {
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
  const region = at.address === undefined ? at.region : regionOfAddress(at.address);
  const offset = regionOffset(b, address, at);

  switch (region) {
    case 'code':
      return loadWidth(b, CODE, offset, size);
    case 'sram':
      return loadWidth(b, SRAM, offset, size);
    case 'ccm':
      return loadWidth(b, CCM, offset, size);
    case 'peripheral':
      return readPeripheral(b, address, size, defer, at.address);
    case 'system':
      return readSystem(b, address, size);
    case 'none':
      return num(b, 0);
  }
}

function writeAt(
  b: Body,
  address: Value<number>,
  size: AccessSize,
  value: Value<number>,
  at: At,
  defer: boolean,
): void {
  const region = at.address === undefined ? at.region : regionOfAddress(at.address);
  const offset = regionOffset(b, address, at);

  switch (region) {
    case 'code':
      // Guest store 只有通过已解锁的 Flash 控制器才会改变映像；写 `code` 同时触发
      // 引擎的 code 版本失效。
      writeFlashMemory(b, offset, size, value);
      return;
    case 'sram':
      storeWidth(b, SRAM, offset, size, value);
      return;
    case 'ccm':
      storeWidth(b, CCM, offset, size, value);
      return;
    case 'peripheral':
      writePeripheral(b, address, size, value, defer, at.address, at.value);
      return;
    case 'system':
      writeSystem(b, address, size, value);
      return;
    case 'none':
      return;
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
  defer: DeferRead | false = false,
  at?: At,
): Value<number> {
  const deferred = defer || undefined;

  if (at !== undefined) return readAt(b, address, size, at, deferred)!;

  const sharedSystem =
    (size === 1 || size === 2 || size === 4) && machine().shareDynamicSystemAccess === true;
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
        inFlash(body, address),
        (flash) => {
          const inner = asBody(flash);

          inner.setLocal(
            result,
            loadWidth(inner, CODE, inner.bitAnd(address, num(inner, CODE_MASK)), size),
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
                  periph.setLocal(result, readPeripheral(asBody(periph), address, size, deferred));
                },
                (after) => {
                  const tail = asBody(after);

                  tail.if(
                    inRegion(tail, address, SYSTEM_BASE, SYSTEM_END - SYSTEM_BASE),
                    (system) => {
                      system.setLocal(
                        result,
                        sharedSystem
                          ? system.callValue(systemReadName(size), types.number, address)
                          : readSystem(asBody(system), address, size),
                      );
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
  size: AccessSize,
  value: Value<number>,
  defer = false,
  at?: At,
): void {
  if (at !== undefined) {
    writeAt(b, address, size, value, at, defer);

    return;
  }

  // Keep the possible code write out of the SRAM hot block. The Flash service still
  // performs the actual write and triggers the normal code-version invalidation.
  const deferFlash = defer && machine().deferDynamicFlashStore === true;

  b.if(
    inRegion(b, address, SRAM_BASE, SRAM_SIZE),
    (ram) => {
      const body = asBody(ram);

      storeWidth(body, SRAM, offsetFrom(body, address, SRAM_BASE), size, value);
    },
    (other) => {
      const body = asBody(other);

      body.if(
        inFlash(body, address),
        (flash) => {
          const scope = asBody(flash);

          if (deferFlash) registerDeferredWrite(scope, address, size, value);
          else writeFlashMemory(scope, scope.bitAnd(address, num(scope, CODE_MASK)), size, value);
        },
        (notFlash) => {
          const scope = asBody(notFlash);

          scope.if(
            inRegion(scope, address, CCM_BASE, CCM_SIZE),
            (ccm) => {
              const inner = asBody(ccm);

              storeWidth(inner, CCM, offsetFrom(inner, address, CCM_BASE), size, value);
            },
            (rest) => {
              const inner = asBody(rest);

              inner.if(
                inRegion(inner, address, PERIPHERAL_BASE, PERIPHERAL_END - PERIPHERAL_BASE),
                (periph) => {
                  writePeripheral(asBody(periph), address, size, value, defer);
                },
                (next) => {
                  const tail = asBody(next);

                  tail.if(
                    inRegion(tail, address, SYSTEM_BASE, SYSTEM_END - SYSTEM_BASE),
                    (system) => {
                      if (machine().shareDynamicSystemAccess)
                        system.call(systemWriteName(size), address, value);
                      else writeSystem(asBody(system), address, size, value);
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
}
