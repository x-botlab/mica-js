import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import {
  CODE,
  FLASH_BASE_REGISTER,
  FLASH_STATE_MEMORY,
  IRQ_DIRTY,
  PeripheralSlot,
  SERVICE_IRQ,
  SYS,
  periphDeadlineState,
} from './layout';
import type { AccessSize } from './layout';
import {
  FLASH_ACR,
  FLASH_ACR_RESET,
  FLASH_BUSY_KIND,
  FLASH_BUSY_MASS_ERASE,
  FLASH_BUSY_NONE,
  FLASH_BUSY_OPTION,
  FLASH_BUSY_PAGE,
  FLASH_BUSY_PAGE_ERASE,
  FLASH_BUSY_PROGRAM,
  FLASH_CR,
  FLASH_CR_EOPIE,
  FLASH_CR_ERRIE,
  FLASH_CR_FSTPG,
  FLASH_CR_LOCK,
  FLASH_CR_MER1,
  FLASH_CR_OBL_LAUNCH,
  FLASH_CR_OPTSTRT,
  FLASH_CR_OPTLOCK,
  FLASH_CR_PG,
  FLASH_CR_PNB_MASK,
  FLASH_CR_PNB_SHIFT,
  FLASH_CR_PER,
  FLASH_CR_RDERRIE,
  FLASH_CR_RESET,
  FLASH_CR_SEC_PROT1,
  FLASH_CR_STRT,
  FLASH_DOUBLE_WORD_SIZE,
  FLASH_ECCR,
  FLASH_ECCR_RESET,
  FLASH_EXCEPTION,
  FLASH_KEY1,
  FLASH_KEY2,
  FLASH_KEYR,
  FLASH_KEY_STAGE,
  FLASH_MASS_ERASE_PS,
  FLASH_OPTION_PS,
  FLASH_OPTKEY1,
  FLASH_OPTKEY2,
  FLASH_OPTKEYR,
  FLASH_OPTKEY_STAGE,
  FLASH_OPTR,
  FLASH_OPTR_RESET,
  FLASH_PAGE_COUNT,
  FLASH_PAGE_ERASE_PS,
  FLASH_PAGE_SIZE,
  FLASH_PCROP1ER,
  FLASH_PCROP1ER_RESET,
  FLASH_PCROP1SR,
  FLASH_PCROP1SR_RESET,
  FLASH_PDKEY1,
  FLASH_PDKEY2,
  FLASH_PDKEYR,
  FLASH_PDKEY_STAGE,
  FLASH_PENDING_ADDRESS,
  FLASH_PENDING_VALUE,
  FLASH_PROGRAM_PS,
  FLASH_SEC1R,
  FLASH_SEC1R_RESET,
  FLASH_SR,
  FLASH_SR_BSY,
  FLASH_SR_EOP,
  FLASH_SR_ERRORS,
  FLASH_SR_OPERR,
  FLASH_SR_PGAERR,
  FLASH_SR_PGSERR,
  FLASH_SR_PROGERR,
  FLASH_SR_RDERR,
  FLASH_SR_RESET,
  FLASH_SR_SIZERR,
  FLASH_SR_W1C,
  FLASH_SR_WRPERR,
  FLASH_SIZE,
  FLASH_WRP1AR,
  FLASH_WRP1AR_RESET,
  FLASH_WRP1BR,
  FLASH_WRP1BR_RESET,
} from './flash-layout';
import {
  asBody,
  bool,
  boolAnd,
  boolOr,
  markService,
  num,
  readWord,
  readWordAt,
  syncIrqService,
  u32,
  writeWord,
  writeWordAt,
} from './ir';
import type { Body } from './ir';
import {
  deactivatePeripheralSlot,
  setPeripheralActive,
  type InterruptSource,
  type PeripheralModule,
} from './peripheral';
import { refreshTick } from './tick';
import { FLASH_RESET_MARKER, RESET_CAUSE_OBL_LAUNCH } from './reset';
import { RESET_CAUSE, RESET_REQUEST } from './system-layout';

/**
 * STM32G431RBT6 主 Flash 控制器（RM0440 category 2）。
 *
 * 128 KiB 单 bank、64 页 × 2 KiB；编程以 64 位双字为单位（两次 32 位写），擦除按页或
 * 全片。控制器映像放在专用 `flashState` memory；`memory.ts` 的 code 写分支把 guest
 * store 交给 `writeFlashMemory`，只有解锁并置 PG 后才真正写 `code`。写 `code` 会触发
 * 引擎已有的 code 版本失效，不需要 host 绕过固件装载合同。
 *
 * 忙时延由 `advance` 在共享 tick 中推进；模块不另建计时器。读 Flash 在 BSY 期间不
 * stall：IAP 代码应从 SRAM 执行（与 RM0440 的 read-while-write 限制一致）。
 */

/** 私有偏移 `flashState[0xfc]`：0=未初始化，1=已初始化，2=控制器复位但保留选项。 */
const FLASH_INIT = 0xfc;
const FLASH_INIT_DONE = 0x464c_5348;
const FLASH_INIT_RESET = FLASH_RESET_MARKER;

const NO_PENDING_ADDRESS = 0xffff_ffff;
const FLASH_WORD = 4;
/** 错误解锁序列后的阶段：保持到系统复位，正确钥匙也不能再解锁。 */
const FLASH_KEY_POISONED = 3;

const readReg = (b: Body, offset: number): Value<number> =>
  readWordAt(b, FLASH_STATE_MEMORY, offset);
const writeReg = (b: Body, offset: number, value: Value<number>): void => {
  writeWordAt(b, FLASH_STATE_MEMORY, offset, u32(b, value));
};

const readPrivate = (b: Body, offset: number): Value<number> =>
  readWordAt(b, FLASH_STATE_MEMORY, offset);
const writePrivate = (b: Body, offset: number, value: Value<number>): void => {
  writeWordAt(b, FLASH_STATE_MEMORY, offset, u32(b, value));
};

const extract = (
  b: Body,
  word: Value<number>,
  offset: Value<number>,
  size: number,
): Value<number> => {
  if (size === 4) return word;

  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));

  return b.bitAnd(b.shiftRightUnsigned(word, shift), num(b, size === 2 ? 0xffff : 0xff));
};

const merge = (
  b: Body,
  current: Value<number>,
  value: Value<number>,
  offset: Value<number>,
  size: number,
): Value<number> => {
  if (size === 4) return u32(b, value);

  const width = size === 2 ? 0xffff : 0xff;
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));
  const placed = b.shiftLeft(b.bitAnd(u32(b, value), num(b, width)), shift);
  const mask = b.shiftLeft(num(b, width), shift);

  return u32(b, b.bitOr(b.bitAnd(current, b.bitNot(mask)), placed));
};

function resetControllerRegisters(b: Body): void {
  writeReg(b, FLASH_ACR, num(b, FLASH_ACR_RESET));
  writeReg(b, FLASH_SR, num(b, FLASH_SR_RESET));
  writeReg(b, FLASH_CR, num(b, FLASH_CR_RESET));
  writeReg(b, FLASH_ECCR, num(b, FLASH_ECCR_RESET));
}

function resetPrivate(b: Body): void {
  writePrivate(b, FLASH_KEY_STAGE, num(b, 0));
  writePrivate(b, FLASH_OPTKEY_STAGE, num(b, 0));
  writePrivate(b, FLASH_PDKEY_STAGE, num(b, 0));
  writePrivate(b, FLASH_PENDING_ADDRESS, num(b, NO_PENDING_ADDRESS));
  writePrivate(b, FLASH_PENDING_VALUE, num(b, 0));
  writePrivate(b, FLASH_BUSY_KIND, num(b, FLASH_BUSY_NONE));
  writePrivate(b, FLASH_BUSY_PAGE, num(b, 0));
}

/**
 * `flashState` 是普通 memory，DDL 没有寄存器初值语法。第一次访问控制器时写入复位
 * 映像；复位代理可写私有标记 2，让下一次访问只复位控制器、保留 OPTR/WRP/PCROP/SEC1R。
 */
function ensureInitialized(b: Body): void {
  const marker = readPrivate(b, FLASH_INIT);

  b.if(
    b.equal(types.number, marker, num(b, 0)),
    (fresh) => {
      const scope = asBody(fresh);

      resetControllerRegisters(scope);
      writeReg(scope, FLASH_OPTR, num(scope, FLASH_OPTR_RESET));
      writeReg(scope, FLASH_PCROP1SR, num(scope, FLASH_PCROP1SR_RESET));
      writeReg(scope, FLASH_PCROP1ER, num(scope, FLASH_PCROP1ER_RESET));
      writeReg(scope, FLASH_WRP1AR, num(scope, FLASH_WRP1AR_RESET));
      writeReg(scope, FLASH_WRP1BR, num(scope, FLASH_WRP1BR_RESET));
      writeReg(scope, FLASH_SEC1R, num(scope, FLASH_SEC1R_RESET));
      resetPrivate(scope);
      writePrivate(scope, FLASH_INIT, num(scope, FLASH_INIT_DONE));
    },
    (existing) => {
      const scope = asBody(existing);

      scope.if(scope.equal(types.number, marker, num(scope, FLASH_INIT_RESET)), (reset) => {
        const inner = asBody(reset);

        resetControllerRegisters(inner);
        resetPrivate(inner);
        writePrivate(inner, FLASH_INIT, num(inner, FLASH_INIT_DONE));
      });
    },
  );
}

/** 只有 EOP/OPERR/RDERR 且对应使能位为 1 时才把 FLASH 中断挂到 NVIC。 */
function refreshFlashIrq(b: Body): void {
  const cr = readReg(b, FLASH_CR);
  const sr = readReg(b, FLASH_SR);
  const on = (enable: number, flag: number): Value<boolean> =>
    boolAnd(
      b,
      b.notEqual(types.number, b.bitAnd(cr, num(b, enable)), num(b, 0)),
      b.notEqual(types.number, b.bitAnd(sr, num(b, flag)), num(b, 0)),
    );
  const asserted = boolOr(
    b,
    boolOr(b, on(FLASH_CR_EOPIE, FLASH_SR_EOP), on(FLASH_CR_ERRIE, FLASH_SR_OPERR)),
    on(FLASH_CR_RDERRIE, FLASH_SR_RDERR),
  );

  b.if(asserted, (active) => {
    const scope = asBody(active);

    scope.writeState(IRQ_DIRTY, bool(scope, true));
    syncIrqService(scope);
  });
}

function setStatus(b: Body, mask: number): void {
  writeReg(b, FLASH_SR, b.bitOr(readReg(b, FLASH_SR), num(b, mask)));
  refreshFlashIrq(b);
}

function clearStatus(b: Body, mask: Value<number>): void {
  writeReg(b, FLASH_SR, b.bitAnd(readReg(b, FLASH_SR), b.bitNot(mask)));
  refreshFlashIrq(b);
}

/** 错误完成：置具体错误位；ERRIE 时再置 OPERR。 */
function fail(b: Body, mask: number): void {
  setStatus(b, mask);

  b.if(
    b.notEqual(types.number, b.bitAnd(readReg(b, FLASH_CR), num(b, FLASH_CR_ERRIE)), num(b, 0)),
    (enabled) => setStatus(asBody(enabled), FLASH_SR_OPERR),
  );
}

/** 用运行期循环把一个 code 区间写成 0xFF；服务块冷路径，IR 体积与区间大小无关。 */
function eraseCode(b: Body, start: Value<number>, length: number): void {
  const offset = b.local(types.number, start);
  const end = b.local(types.number, b.add(start, num(b, length)));

  b.while(
    (test) => test.lessThan(test.getLocal(offset), test.getLocal(end)),
    (body) => {
      const scope = asBody(body);

      writeWord(scope, CODE, scope.getLocal(offset), num(scope, 0xffff_ffff));
      scope.setLocal(offset, scope.add(scope.getLocal(offset), num(scope, FLASH_WORD)));
    },
  );
}

function completeOperation(b: Body): void {
  const kind = readPrivate(b, FLASH_BUSY_KIND);
  const page = readPrivate(b, FLASH_BUSY_PAGE);

  b.if(b.equal(types.number, kind, num(b, FLASH_BUSY_PAGE_ERASE)), (pageErase) => {
    const scope = asBody(pageErase);

    eraseCode(scope, scope.multiply(page, num(scope, FLASH_PAGE_SIZE)), FLASH_PAGE_SIZE);
  });

  b.if(b.equal(types.number, kind, num(b, FLASH_BUSY_MASS_ERASE)), (massErase) => {
    const scope = asBody(massErase);

    eraseCode(scope, num(scope, 0), FLASH_SIZE);
  });

  const cr = readReg(b, FLASH_CR);
  const kept = b.bitAnd(readReg(b, FLASH_SR), num(b, ~FLASH_SR_BSY));
  const eop = b.select(
    types.number,
    b.notEqual(types.number, b.bitAnd(cr, num(b, FLASH_CR_EOPIE)), num(b, 0)),
    (inner) => inner.constant(types.number, FLASH_SR_EOP),
    (inner) => inner.constant(types.number, 0),
  );

  writeReg(b, FLASH_SR, b.bitOr(kept, eop));
  writeReg(b, FLASH_CR, b.bitAnd(cr, num(b, ~(FLASH_CR_STRT | FLASH_CR_OPTSTRT))));
  writePrivate(b, FLASH_BUSY_KIND, num(b, FLASH_BUSY_NONE));
  writePrivate(b, FLASH_PENDING_ADDRESS, num(b, NO_PENDING_ADDRESS));
  deactivatePeripheralSlot(b, PeripheralSlot.Flash);
  refreshTick(b);
  refreshFlashIrq(b);
}

function startOperation(b: Body, kind: number, durationPs: number, page: Value<number>): void {
  writePrivate(b, FLASH_BUSY_KIND, num(b, kind));
  writePrivate(b, FLASH_BUSY_PAGE, page);
  writeReg(b, FLASH_SR, b.bitOr(readReg(b, FLASH_SR), num(b, FLASH_SR_BSY)));
  setPeripheralActive(b, PeripheralSlot.Flash, true);
  // ps 可能超过 2^32（页擦 20 ms、全片 40 ms），不能经 u32。共享 deadline state 是
  // number，直接作为剩余时间的唯一来源；refreshTick 读取同一个 state。
  b.writeState(periphDeadlineState(PeripheralSlot.Flash), num(b, durationPs));
  refreshTick(b);
}

function regionCoversPage(b: Body, register: Value<number>, page: Value<number>): Value<boolean> {
  const start = b.bitAnd(register, num(b, 0x3f));
  const end = b.bitAnd(b.shiftRightUnsigned(register, num(b, 16)), num(b, 0x3f));

  return boolAnd(
    b,
    b.lessThanOrEqual(start, end),
    boolAnd(
      b,
      b.lessThan(page, num(b, FLASH_PAGE_COUNT)),
      boolAnd(b, b.greaterThanOrEqual(page, start), b.lessThanOrEqual(page, end)),
    ),
  );
}

function regionCoversDoubleWord(
  b: Body,
  startRegister: Value<number>,
  endRegister: Value<number>,
  offset: Value<number>,
): Value<boolean> {
  const start = b.bitAnd(startRegister, num(b, 0x7fff));
  const end = b.bitAnd(endRegister, num(b, 0x7fff));
  const doubleWord = b.shiftRightUnsigned(offset, num(b, 3));

  return boolAnd(
    b,
    b.lessThanOrEqual(start, end),
    boolAnd(b, b.greaterThanOrEqual(doubleWord, start), b.lessThanOrEqual(doubleWord, end)),
  );
}

function securableCoversPage(b: Body, sec1r: Value<number>, page: Value<number>): Value<boolean> {
  const size = b.bitAnd(sec1r, num(b, 0x7f));

  return boolAnd(
    b,
    b.greaterThan(size, num(b, 0)),
    b.lessThan(
      page,
      b.select(
        types.number,
        b.lessThan(size, num(b, FLASH_PAGE_COUNT)),
        () => size,
        (inner) => inner.constant(types.number, FLASH_PAGE_COUNT),
      ),
    ),
  );
}

function protectedPageValue(b: Body, page: Value<number>): Value<boolean> {
  const securable = boolAnd(
    b,
    b.notEqual(types.number, b.bitAnd(readReg(b, FLASH_CR), num(b, FLASH_CR_SEC_PROT1)), num(b, 0)),
    securableCoversPage(b, readReg(b, FLASH_SEC1R), page),
  );

  return boolOr(
    b,
    boolOr(
      b,
      regionCoversPage(b, readReg(b, FLASH_WRP1AR), page),
      regionCoversPage(b, readReg(b, FLASH_WRP1BR), page),
    ),
    securable,
  );
}

function protectedDoubleWord(b: Body, offset: Value<number>): Value<boolean> {
  const page = b.shiftRightUnsigned(offset, num(b, 11));

  return boolOr(
    b,
    protectedPageValue(b, page),
    regionCoversDoubleWord(b, readReg(b, FLASH_PCROP1SR), readReg(b, FLASH_PCROP1ER), offset),
  );
}

/** 全片擦除只要任一页受 WRP/PCROP/securable 保护就整体中止。 */
function anyProtectedPage(b: Body): Value<boolean> {
  const page = b.local(types.number, 0);
  const hit = b.local(types.bool, false);
  const pcropEnabled = b.lessThanOrEqual(
    b.bitAnd(readReg(b, FLASH_PCROP1SR), num(b, 0x7fff)),
    b.bitAnd(readReg(b, FLASH_PCROP1ER), num(b, 0x7fff)),
  );

  b.if(pcropEnabled, (enabled) => asBody(enabled).setLocal(hit, bool(asBody(enabled), true)));

  b.while(
    (test) => test.lessThan(test.getLocal(page), test.constant(types.number, FLASH_PAGE_COUNT)),
    (body) => {
      const scope = asBody(body);

      scope.if(protectedPageValue(scope, scope.getLocal(page)), (protectedPage) => {
        const inner = asBody(protectedPage);

        inner.setLocal(hit, bool(inner, true));
      });
      scope.setLocal(page, scope.add(scope.getLocal(page), num(scope, 1)));
    },
  );

  return b.getLocal(hit);
}

function readyForOperation(b: Body): Value<boolean> {
  return b.equal(
    types.number,
    b.bitAnd(readReg(b, FLASH_SR), num(b, FLASH_SR_ERRORS | FLASH_SR_BSY)),
    num(b, 0),
  );
}

/** 编程数据入口：只由 memory.ts 的 code 写分支调用。 */
export function writeFlashMemory(
  b: Body,
  offset: Value<number>,
  size: AccessSize,
  value: Value<number>,
): void {
  ensureInitialized(b);

  const cr = readReg(b, FLASH_CR);
  const busy = b.notEqual(
    types.number,
    b.bitAnd(readReg(b, FLASH_SR), num(b, FLASH_SR_BSY)),
    num(b, 0),
  );
  const pg = b.notEqual(types.number, b.bitAnd(cr, num(b, FLASH_CR_PG)), num(b, 0));

  b.if(
    busy,
    () => {},
    (idle) => {
      const body = asBody(idle);

      body.if(
        pg,
        (programming) => {
          const scope = asBody(programming);
          const blocked = boolOr(
            scope,
            boolOr(
              scope,
              scope.notEqual(
                types.number,
                scope.bitAnd(cr, num(scope, FLASH_CR_PER | FLASH_CR_MER1)),
                num(scope, 0),
              ),
              scope.notEqual(
                types.number,
                scope.bitAnd(cr, num(scope, FLASH_CR_FSTPG)),
                num(scope, 0),
              ),
            ),
            scope.notEqual(
              types.number,
              scope.bitAnd(readReg(scope, FLASH_SR), num(scope, FLASH_SR_ERRORS)),
              num(scope, 0),
            ),
          );

          scope.if(
            blocked,
            (bad) => fail(asBody(bad), FLASH_SR_PGSERR),
            (ok) => {
              const next = asBody(ok);

              next.if(
                next.notEqual(types.number, next.constant(types.number, size), num(next, 4)),
                (sized) => fail(asBody(sized), FLASH_SR_SIZERR),
                (word) => programWord(asBody(word), offset, value),
              );
            },
          );
        },
        (notProgramming) => {
          // PG=0 时写主存储：RM0440 规定置 PGSERR，映像不变。锁定写同样走这里。
          fail(asBody(notProgramming), FLASH_SR_PGSERR);
        },
      );
    },
  );
}

function programWord(b: Body, offset: Value<number>, value: Value<number>): void {
  const pending = readPrivate(b, FLASH_PENDING_ADDRESS);

  b.if(
    b.equal(types.number, pending, num(b, NO_PENDING_ADDRESS)),
    (first) => {
      const scope = asBody(first);

      scope.if(
        scope.notEqual(
          types.number,
          scope.bitAnd(offset, num(scope, FLASH_DOUBLE_WORD_SIZE - 1)),
          num(scope, 0),
        ),
        (misaligned) => fail(asBody(misaligned), FLASH_SR_PGAERR),
        (aligned) => {
          const inner = asBody(aligned);

          inner.if(
            protectedDoubleWord(inner, offset),
            (protectedWord) => {
              fail(asBody(protectedWord), FLASH_SR_WRPERR);
            },
            (writable) => {
              const target = asBody(writable);

              writePrivate(target, FLASH_PENDING_ADDRESS, u32(target, offset));
              writePrivate(target, FLASH_PENDING_VALUE, u32(target, value));
            },
          );
        },
      );
    },
    (second) => {
      const scope = asBody(second);
      const expected = scope.add(pending, num(scope, FLASH_DOUBLE_WORD_SIZE / 2));

      scope.if(
        scope.notEqual(types.number, offset, expected),
        (wrong) => {
          const body = asBody(wrong);

          fail(body, FLASH_SR_PGAERR);
          writePrivate(body, FLASH_PENDING_ADDRESS, num(body, NO_PENDING_ADDRESS));
        },
        (matching) => {
          const inner = asBody(matching);
          const firstValue = readPrivate(inner, FLASH_PENDING_VALUE);
          const low = readWord(inner, CODE, pending);
          const high = readWord(inner, CODE, inner.add(pending, num(inner, 4)));
          const erased = boolAnd(
            inner,
            inner.equal(types.number, low, num(inner, 0xffff_ffff)),
            inner.equal(types.number, high, num(inner, 0xffff_ffff)),
          );
          const zero = boolAnd(
            inner,
            inner.equal(types.number, firstValue, num(inner, 0)),
            inner.equal(types.number, value, num(inner, 0)),
          );
          const blocked = boolAnd(inner, inner.not(erased), inner.not(zero));

          inner.if(
            blocked,
            (programmed) => {
              const body = asBody(programmed);

              fail(body, FLASH_SR_PROGERR);
              writePrivate(body, FLASH_PENDING_ADDRESS, num(body, NO_PENDING_ADDRESS));
            },
            (program) => {
              const body = asBody(program);

              writeWord(body, CODE, pending, body.bitAnd(low, firstValue));
              writeWord(body, CODE, body.add(pending, num(body, 4)), body.bitAnd(high, value));
              writePrivate(body, FLASH_PENDING_ADDRESS, num(body, NO_PENDING_ADDRESS));
              startOperation(body, FLASH_BUSY_PROGRAM, FLASH_PROGRAM_PS, num(body, 0));
            },
          );
        },
      );
    },
  );
}

function writeCr(b: Body, value: Value<number>): void {
  const current = readReg(b, FLASH_CR);
  const busy = b.notEqual(
    types.number,
    b.bitAnd(readReg(b, FLASH_SR), num(b, FLASH_SR_BSY)),
    num(b, 0),
  );

  b.if(
    busy,
    () => {},
    (idle) => {
      const body = asBody(idle);

      body.if(
        body.notEqual(types.number, body.bitAnd(value, num(body, FLASH_CR_LOCK)), num(body, 0)),
        (lock) => {
          const scope = asBody(lock);

          writeReg(
            scope,
            FLASH_CR,
            scope.bitOr(
              scope.bitAnd(
                current,
                num(
                  scope,
                  ~(
                    FLASH_CR_PG |
                    FLASH_CR_PER |
                    FLASH_CR_MER1 |
                    FLASH_CR_FSTPG |
                    FLASH_CR_STRT |
                    FLASH_CR_OPTSTRT
                  ),
                ),
              ),
              num(scope, FLASH_CR_LOCK | FLASH_CR_OPTLOCK),
            ),
          );
          writePrivate(scope, FLASH_PENDING_ADDRESS, num(scope, NO_PENDING_ADDRESS));
          // 软锁定让下一次 KEYR 可以重新解锁；错误序列的 poison 必须保持到复位。
          for (const stageOffset of [FLASH_KEY_STAGE, FLASH_OPTKEY_STAGE]) {
            scope.if(
              scope.notEqual(
                types.number,
                readPrivate(scope, stageOffset),
                num(scope, FLASH_KEY_POISONED),
              ),
              (clear) => writePrivate(asBody(clear), stageOffset, num(asBody(clear), 0)),
            );
          }
        },
        (noLock) => {
          const scope = asBody(noLock);

          scope.if(
            scope.notEqual(
              types.number,
              scope.bitAnd(current, num(scope, FLASH_CR_LOCK)),
              num(scope, 0),
            ),
            () => {},
            (unlocked) => {
              const open = asBody(unlocked);
              const writable =
                FLASH_CR_PG |
                FLASH_CR_PER |
                FLASH_CR_MER1 |
                FLASH_CR_PNB_MASK |
                FLASH_CR_FSTPG |
                FLASH_CR_EOPIE |
                FLASH_CR_ERRIE |
                FLASH_CR_RDERRIE |
                FLASH_CR_SEC_PROT1;
              const next = open.bitOr(
                open.bitAnd(current, num(open, ~writable)),
                open.bitAnd(value, num(open, writable)),
              );
              const withLock = open.bitOr(
                open.bitOr(next, open.bitAnd(value, num(open, FLASH_CR_OPTLOCK))),
                // SEC_PROT1 与 LOCK/OPTLOCK 一样只置位，不能由软件清零。
                open.bitAnd(current, num(open, FLASH_CR_SEC_PROT1)),
              );
              const startErase = open.notEqual(
                types.number,
                open.bitAnd(value, num(open, FLASH_CR_STRT)),
                num(open, 0),
              );
              const startOption = open.notEqual(
                types.number,
                open.bitAnd(value, num(open, FLASH_CR_OPTSTRT)),
                num(open, 0),
              );
              const launchOption = open.notEqual(
                types.number,
                open.bitAnd(value, num(open, FLASH_CR_OBL_LAUNCH)),
                num(open, 0),
              );

              writeReg(open, FLASH_CR, withLock);

              open.if(startErase, (erase) => handleErase(asBody(erase), withLock));
              open.if(startOption, (option) => handleOptionStart(asBody(option), withLock));
              open.if(launchOption, (launch) => handleOptionLaunch(asBody(launch), withLock));

              open.if(
                open.equal(types.number, open.bitAnd(next, num(open, FLASH_CR_PG)), num(open, 0)),
                (notProgram) => {
                  const inner = asBody(notProgram);

                  writePrivate(inner, FLASH_PENDING_ADDRESS, num(inner, NO_PENDING_ADDRESS));
                },
              );
            },
          );
        },
      );
    },
  );
}

function handleErase(b: Body, cr: Value<number>): void {
  const mode = b.bitAnd(cr, num(b, FLASH_CR_PG | FLASH_CR_FSTPG | FLASH_CR_PER | FLASH_CR_MER1));
  const page = b.bitAnd(b.shiftRightUnsigned(cr, num(b, FLASH_CR_PNB_SHIFT)), num(b, 0x7f));
  const validPageMode = b.equal(types.number, mode, num(b, FLASH_CR_PER));
  const validMassMode = b.equal(types.number, mode, num(b, FLASH_CR_MER1));

  b.if(
    b.not(readyForOperation(b)),
    (bad) => fail(asBody(bad), FLASH_SR_PGSERR),
    (ready) => {
      const scope = asBody(ready);

      scope.if(
        validPageMode,
        (pageErase) => {
          const body = asBody(pageErase);

          body.if(
            protectedPageValue(body, page),
            (protectedPage) => {
              fail(asBody(protectedPage), FLASH_SR_WRPERR);
            },
            (writable) => {
              const target = asBody(writable);

              target.if(
                target.lessThan(page, num(target, FLASH_PAGE_COUNT)),
                (valid) => {
                  const inner = asBody(valid);

                  writeReg(
                    inner,
                    FLASH_CR,
                    inner.bitOr(readReg(inner, FLASH_CR), num(inner, FLASH_CR_STRT)),
                  );
                  startOperation(inner, FLASH_BUSY_PAGE_ERASE, FLASH_PAGE_ERASE_PS, page);
                },
                (invalid) => fail(asBody(invalid), FLASH_SR_PGSERR),
              );
            },
          );
        },
        (notPage) => {
          const body = asBody(notPage);

          body.if(
            validMassMode,
            (massErase) => {
              const scope2 = asBody(massErase);

              scope2.if(
                anyProtectedPage(scope2),
                (protectedAny) => {
                  fail(asBody(protectedAny), FLASH_SR_WRPERR);
                },
                (writable) => {
                  const target = asBody(writable);

                  writeReg(
                    target,
                    FLASH_CR,
                    target.bitOr(readReg(target, FLASH_CR), num(target, FLASH_CR_STRT)),
                  );
                  startOperation(
                    target,
                    FLASH_BUSY_MASS_ERASE,
                    FLASH_MASS_ERASE_PS,
                    num(target, 0),
                  );
                },
              );
            },
            (invalidMode) => {
              // STRT 且 PER/MER1 都没有置位属于 RM0440 的未定义行为；模型 choose no-op。
              // 同时置位或与 PG/FSTPG 混用属于序列错误。
              const invalid = asBody(invalidMode);

              invalid.if(
                invalid.equal(types.number, mode, invalid.constant(types.number, 0)),
                () => {},
                (conflict) => fail(asBody(conflict), FLASH_SR_PGSERR),
              );
            },
          );
        },
      );
    },
  );
}

function handleOptionStart(b: Body, cr: Value<number>): void {
  const locked = b.notEqual(types.number, b.bitAnd(cr, num(b, FLASH_CR_OPTLOCK)), num(b, 0));

  b.if(
    locked,
    () => {},
    (unlocked) => {
      const scope = asBody(unlocked);

      scope.if(
        readyForOperation(scope),
        (ready) => {
          const body = asBody(ready);

          writeReg(
            body,
            FLASH_CR,
            body.bitOr(readReg(body, FLASH_CR), num(body, FLASH_CR_OPTSTRT)),
          );
          startOperation(body, FLASH_BUSY_OPTION, FLASH_OPTION_PS, num(body, 0));
        },
        (bad) => fail(asBody(bad), FLASH_SR_PGSERR),
      );
    },
  );
}

/**
 * RM0440 的 OBL_LAUNCH 会触发系统复位。选项加载请求交给 reset.ts 的统一复位入口
 *（与 NRST/SYSRESETREQ 共用 `applyReset`）；复位保留 flashState 的选项区，只重置控制器。
 */
function handleOptionLaunch(b: Body, cr: Value<number>): void {
  const locked = b.notEqual(types.number, b.bitAnd(cr, num(b, FLASH_CR_OPTLOCK)), num(b, 0));

  b.if(
    locked,
    () => {},
    (unlocked) => {
      const scope = asBody(unlocked);

      writeReg(scope, FLASH_CR, scope.bitAnd(cr, num(scope, ~FLASH_CR_OBL_LAUNCH)));
      // 与 NRST/SYSRESETREQ 共用 SERVICE_TICK 的 resetPending → applyPendingReset；
      // 只在服务边界复位，避免在 CR 写分支里内联整段 applyReset。
      writeWordAt(scope, SYS, RESET_CAUSE, num(scope, RESET_CAUSE_OBL_LAUNCH));
      writeWordAt(scope, SYS, RESET_REQUEST, num(scope, 1));
      // resetPending 在 SERVICE_TICK 开头检查；用一个服务位把 PC 拉到该节拍点。
      markService(scope, SERVICE_IRQ);
    },
  );
}

/**
 * 选项寄存器是模型持久化的行为影子：`applyReset` 保留 0x20..0x7F，因此 WRP/PCROP/SEC1R
 * 跨 NRST 保留；但它不是物理 option byte 编程：未实现双字/补码校验、RDP Level 1/2
 * 安全加载、PCROP 读保护和 OTP。WRP/PCROP/SEC 只按当前寄存器值做写/擦保护检查。
 */
function writeOptionRegister(b: Body, offset: number, value: Value<number>): void {
  const busy = b.notEqual(
    types.number,
    b.bitAnd(readReg(b, FLASH_SR), num(b, FLASH_SR_BSY)),
    num(b, 0),
  );

  b.if(
    busy,
    () => {},
    (idle) => {
      const body = asBody(idle);

      body.if(
        body.notEqual(
          types.number,
          body.bitAnd(readReg(body, FLASH_CR), num(body, FLASH_CR_OPTLOCK)),
          num(body, 0),
        ),
        () => {},
        (unlocked) => writeReg(asBody(unlocked), offset, value),
      );
    },
  );
}

function writeKey(
  b: Body,
  value: Value<number>,
  stageOffset: number,
  key1: number,
  key2: number,
): void {
  const stage = readPrivate(b, stageOffset);
  const clearMask =
    stageOffset === FLASH_KEY_STAGE
      ? FLASH_CR_LOCK
      : stageOffset === FLASH_OPTKEY_STAGE
        ? FLASH_CR_OPTLOCK
        : 0;
  const requiresLockClear = stageOffset === FLASH_OPTKEY_STAGE;

  // poison 后任何钥匙都无效，直到 resetPrivate 在系统复位时清 0。
  b.if(
    b.equal(types.number, stage, num(b, FLASH_KEY_POISONED)),
    () => {},
    (notPoisoned) => {
      const scope = asBody(notPoisoned);

      scope.if(
        scope.equal(types.number, stage, num(scope, 2)),
        () => {},
        (active) => {
          const inner = asBody(active);
          // OPTKEYR 在 LOCK 未清时忽略；这不是“错误序列”，不 poison。
          const blocked = requiresLockClear
            ? inner.notEqual(
                types.number,
                inner.bitAnd(readReg(inner, FLASH_CR), num(inner, FLASH_CR_LOCK)),
                num(inner, 0),
              )
            : bool(inner, false);

          inner.if(
            blocked,
            () => {},
            (allowed) => {
              const body = asBody(allowed);

              body.if(
                body.equal(types.number, value, num(body, key1)),
                (first) => writePrivate(asBody(first), stageOffset, num(asBody(first), 1)),
                (notFirst) => {
                  const next = asBody(notFirst);

                  next.if(
                    boolAnd(
                      next,
                      next.equal(types.number, stage, num(next, 1)),
                      next.equal(types.number, value, num(next, key2)),
                    ),
                    (second) => {
                      const open = asBody(second);

                      writePrivate(open, stageOffset, num(open, 2));
                      if (clearMask !== 0)
                        writeReg(
                          open,
                          FLASH_CR,
                          open.bitAnd(readReg(open, FLASH_CR), num(open, ~clearMask)),
                        );
                    },
                    (wrong) => {
                      // RM0440：任何错误序列锁定 FLASH_CR 到下一次系统复位。
                      // 用 poison 阶段而不是清 0，避免后续正确 KEY1/KEY2 误解锁。
                      writePrivate(
                        asBody(wrong),
                        stageOffset,
                        num(asBody(wrong), FLASH_KEY_POISONED),
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
}

const READABLE_REGISTERS: readonly { readonly offset: number; readonly writeOnly?: boolean }[] = [
  { offset: FLASH_ACR },
  { offset: FLASH_PDKEYR, writeOnly: true },
  { offset: FLASH_KEYR, writeOnly: true },
  { offset: FLASH_OPTKEYR, writeOnly: true },
  { offset: FLASH_SR },
  { offset: FLASH_CR },
  { offset: FLASH_ECCR },
  { offset: FLASH_OPTR },
  { offset: FLASH_PCROP1SR },
  { offset: FLASH_PCROP1ER },
  { offset: FLASH_WRP1AR },
  { offset: FLASH_WRP1BR },
  { offset: FLASH_SEC1R },
];

export function readFlash(b: Body, address: Value<number>, size: number): Value<number> {
  ensureInitialized(b);

  const offset = b.subtract(address, num(b, FLASH_BASE_REGISTER));
  const wordOffset = b.bitAnd(offset, num(b, 0x3fc));
  const result = b.local(types.number, 0);

  // 只读取白名单内的可见寄存器；0x80..0xff 私有影子和 0x100..0x3ff reserved 返回 0，
  // 不按 offset 直接访问 flashState（memory 只有 0x100，且私有区不可见）。
  const step = (body: Body, index: number): void => {
    const register = READABLE_REGISTERS[index];

    if (register === undefined) return;

    body.if(
      body.equal(types.number, wordOffset, num(body, register.offset)),
      (hit) => {
        const scope = asBody(hit);

        scope.setLocal(
          result,
          register.writeOnly === true
            ? num(scope, 0)
            : readWordAt(scope, FLASH_STATE_MEMORY, register.offset),
        );
      },
      (next) => step(asBody(next), index + 1),
    );
  };

  step(b, 0);

  return extract(b, b.getLocal(result), offset, size);
}

interface RegisterHandler {
  readonly offset: number;
  readonly requiresWord?: boolean;
  readonly write: (b: Body, offset: Value<number>, size: AccessSize, value: Value<number>) => void;
}

/** 把按字节/半字写入的 lane 合入寄存器当前字；只在白名单 handler 内读取当前字。 */
const writeMerged =
  (offset: number, apply: (b: Body, value: Value<number>) => void): RegisterHandler['write'] =>
  (b, addressOffset, size, value) => {
    apply(b, merge(b, readReg(b, offset), value, addressOffset, size));
  };

/** W1C/写一清零位只来自本次写入的 lane，不来自 RMW 后的整字。 */
function shiftedLane(
  b: Body,
  offset: Value<number>,
  size: AccessSize,
  value: Value<number>,
): Value<number> {
  if (size === 4) return u32(b, value);

  const width = size === 2 ? 0xffff : 0xff;
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));

  return b.shiftLeft(b.bitAnd(u32(b, value), num(b, width)), shift);
}

function writeSr(b: Body, offset: Value<number>, size: AccessSize, value: Value<number>): void {
  clearStatus(b, b.bitAnd(shiftedLane(b, offset, size, value), num(b, FLASH_SR_W1C)));
}

function writeEccr(b: Body, offset: Value<number>, size: AccessSize, value: Value<number>): void {
  const clear = b.bitAnd(shiftedLane(b, offset, size, value), num(b, 0xc000_0000));

  writeReg(b, FLASH_ECCR, b.bitAnd(readReg(b, FLASH_ECCR), b.bitNot(clear)));
}

const REGISTER_HANDLERS: readonly RegisterHandler[] = [
  { offset: FLASH_ACR, write: writeMerged(FLASH_ACR, (b, value) => writeReg(b, FLASH_ACR, value)) },
  {
    offset: FLASH_PDKEYR,
    requiresWord: true,
    write: (b, _offset, _size, value) =>
      writeKey(b, value, FLASH_PDKEY_STAGE, FLASH_PDKEY1, FLASH_PDKEY2),
  },
  {
    offset: FLASH_KEYR,
    requiresWord: true,
    write: (b, _offset, _size, value) =>
      writeKey(b, value, FLASH_KEY_STAGE, FLASH_KEY1, FLASH_KEY2),
  },
  {
    offset: FLASH_OPTKEYR,
    requiresWord: true,
    write: (b, _offset, _size, value) =>
      writeKey(b, value, FLASH_OPTKEY_STAGE, FLASH_OPTKEY1, FLASH_OPTKEY2),
  },
  { offset: FLASH_CR, write: writeMerged(FLASH_CR, writeCr) },
  {
    offset: FLASH_OPTR,
    write: writeMerged(FLASH_OPTR, (b, value) => writeOptionRegister(b, FLASH_OPTR, value)),
  },
  {
    offset: FLASH_PCROP1SR,
    write: writeMerged(FLASH_PCROP1SR, (b, value) => writeOptionRegister(b, FLASH_PCROP1SR, value)),
  },
  {
    offset: FLASH_PCROP1ER,
    write: writeMerged(FLASH_PCROP1ER, (b, value) => writeOptionRegister(b, FLASH_PCROP1ER, value)),
  },
  {
    offset: FLASH_WRP1AR,
    write: writeMerged(FLASH_WRP1AR, (b, value) => writeOptionRegister(b, FLASH_WRP1AR, value)),
  },
  {
    offset: FLASH_WRP1BR,
    write: writeMerged(FLASH_WRP1BR, (b, value) => writeOptionRegister(b, FLASH_WRP1BR, value)),
  },
  {
    offset: FLASH_SEC1R,
    write: writeMerged(FLASH_SEC1R, (b, value) => writeOptionRegister(b, FLASH_SEC1R, value)),
  },
];

export function writeFlash(
  b: Body,
  address: Value<number>,
  size: AccessSize,
  value: Value<number>,
): void {
  ensureInitialized(b);

  const offset = b.subtract(address, num(b, FLASH_BASE_REGISTER));
  const wordOffset = b.bitAnd(offset, num(b, 0x3fc));

  const step = (body: Body, index: number): void => {
    const handler = REGISTER_HANDLERS[index];

    if (handler === undefined) return;

    body.if(
      body.equal(types.number, wordOffset, num(body, handler.offset)),
      (branch) => {
        const target = asBody(branch);

        if (handler.requiresWord !== true) {
          handler.write(target, offset, size, value);

          return;
        }

        // KEYR/OPTKEYR/PDKEYR 只有 32 位、字对齐写才是合法序列；其它宽度/偏移忽略。
        target.if(
          boolAnd(
            target,
            target.equal(types.number, target.constant(types.number, size), num(target, 4)),
            target.equal(types.number, target.bitAnd(offset, num(target, 3)), num(target, 0)),
          ),
          (legal) => handler.write(asBody(legal), offset, size, value),
        );
      },
      (next) => step(asBody(next), index + 1),
    );
  };

  // SR/ECCR 是 W1C，必须使用本次写入的 lane；不能先与当前值 RMW 再清零。
  b.if(
    b.equal(types.number, wordOffset, num(b, FLASH_SR)),
    (sr) => writeSr(asBody(sr), offset, size, value),
    (notSr) => {
      const inner = asBody(notSr);

      inner.if(
        inner.equal(types.number, wordOffset, num(inner, FLASH_ECCR)),
        (ecc) => writeEccr(asBody(ecc), offset, size, value),
        (rest) => step(asBody(rest), 0),
      );
    },
  );
}

function flashPending(b: Body): Value<boolean> {
  const cr = readReg(b, FLASH_CR);
  const sr = readReg(b, FLASH_SR);
  const enabled = (mask: number): Value<boolean> =>
    b.notEqual(types.number, b.bitAnd(cr, num(b, mask)), num(b, 0));
  const raised = (mask: number): Value<boolean> =>
    b.notEqual(types.number, b.bitAnd(sr, num(b, mask)), num(b, 0));

  return boolOr(
    b,
    boolOr(
      b,
      boolAnd(b, enabled(FLASH_CR_EOPIE), raised(FLASH_SR_EOP)),
      boolAnd(b, enabled(FLASH_CR_ERRIE), raised(FLASH_SR_OPERR)),
    ),
    boolAnd(b, enabled(FLASH_CR_RDERRIE), raised(FLASH_SR_RDERR)),
  );
}

const flashInterrupt: InterruptSource = {
  exception: FLASH_EXCEPTION,
  pendingIsPure: true,
  pending: flashPending,
  // 标志保持到 ISR 自己 W1C；源保持有效时 NVIC 会再次进入，和真实电平中断一致。
  acknowledge: () => {},
};

/** 忙操作的时延推进；由共享 tick 对所有活跃模块调用。 */
function advance(b: Body, elapsedPs: Value<number>): void {
  const busy = b.notEqual(types.number, readPrivate(b, FLASH_BUSY_KIND), num(b, FLASH_BUSY_NONE));

  b.if(busy, (running) => {
    const body = asBody(running);
    const remaining = body.readState(periphDeadlineState(PeripheralSlot.Flash), types.number);

    body.if(
      body.greaterThan(remaining, elapsedPs),
      (waiting) => {
        const scope = asBody(waiting);
        const left = scope.subtract(remaining, elapsedPs);

        // 保持 number 精度：页擦/全片擦的 ps 值超过 2^32。
        scope.writeState(periphDeadlineState(PeripheralSlot.Flash), left);
      },
      (done) => completeOperation(asBody(done)),
    );
  });
}

export const flashModule: PeripheralModule = {
  id: 'flash',
  ranges: [{ base: FLASH_BASE_REGISTER, size: 0x400 }],
  read: readFlash,
  write: writeFlash,
  slot: PeripheralSlot.Flash,
  advance,
  interrupts: [flashInterrupt],
};
