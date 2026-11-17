import { createDeviceBuilder, createJitBlockBuilder, types } from '@mica-js/sdk/model';
import type { JitInstructionBuilder } from '@mica-js/sdk/model';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { JitTranslate } from '@mica-js/sdk/device';
import { describe, expect, it } from 'vitest';
import { activateMachine } from '@mica-js/stm32g431rbt6-core/machine';
import type { Machine } from '@mica-js/stm32g431rbt6-core/machine';
import {
  flashModule,
  readFlash,
  writeFlash,
  writeFlashMemory,
} from '@mica-js/stm32g431rbt6-core/flash';
import {
  FLASH_CR,
  FLASH_CR_EOPIE,
  FLASH_CR_ERRIE,
  FLASH_CR_LOCK,
  FLASH_CR_MER1,
  FLASH_CR_OBL_LAUNCH,
  FLASH_CR_OPTLOCK,
  FLASH_CR_OPTSTRT,
  FLASH_CR_PG,
  FLASH_CR_PER,
  FLASH_CR_STRT,
  FLASH_KEY1,
  FLASH_KEY2,
  FLASH_KEYR,
  FLASH_OPTKEY1,
  FLASH_OPTKEY2,
  FLASH_OPTKEYR,
  FLASH_OPTR,
  FLASH_OPTR_RESET,
  FLASH_PAGE_SIZE,
  FLASH_SR,
  FLASH_SR_BSY,
  FLASH_SR_EOP,
  FLASH_SR_OPERR,
  FLASH_SR_PGAERR,
  FLASH_SR_PGSERR,
  FLASH_SR_PROGERR,
  FLASH_SR_SIZERR,
  FLASH_SR_WRPERR,
  FLASH_WRP1AR,
} from '@mica-js/stm32g431rbt6-core/flash-layout';
import {
  FLASH_BASE_REGISTER,
  FLASH_STATE_MEMORY,
  PENDING_PS,
  TICK_ACTIVE,
  TICK_PS,
} from '@mica-js/stm32g431rbt6-core/layout';
import { RESET_REQUEST } from '@mica-js/stm32g431rbt6-core/system-layout';

/*
 * 闪存控制器单元级执行夹具：直接构造一个 JIT 块，调用真实 `flash.ts` 函数，不经过
 * adapter / NVIC / tick 调度。这样能在其他模块并行开发时验证控制器语义；最终固件级
 * IAP 另外用真实 bin 覆盖。
 */

const MACHINE: Machine = {
  clockFrequency: 16_000_000,
  cyclePs: 62_500,
  alternateDrivers: [],
  peripherals: [],
  interruptSources: [],
  profile: 'flash-rig',
};

function model() {
  const builder = createDeviceBuilder({ name: 'FlashRig' });

  builder.memory({ name: 'code', length: 0x20000 });
  builder.memory({ name: FLASH_STATE_MEMORY, length: 0x100 });
  builder.memory({ name: 'sys', length: 0x200 });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  builder.state({ name: PENDING_PS, type: types.number, initial: 0 });
  builder.state({ name: TICK_PS, type: types.number, initial: 1_000_000_000_000 });
  builder.state({ name: TICK_ACTIVE, type: types.bool, initial: false });
  builder.state({ name: 'periphActive', type: types.number, initial: 0 });
  builder.state({ name: 'periphDeadline8', type: types.number, initial: 0 });
  builder.state({ name: 'serviceMask', type: types.number, initial: 0 });
  builder.state({ name: 'irqDirty', type: types.bool, initial: false });
  builder.state({ name: 'primask', type: types.number, initial: 0 });
  builder.state({ name: 'systickOn', type: types.bool, initial: false });
  builder.state({ name: 'systickLoad', type: types.number, initial: 0 });
  builder.state({ name: 'txMask', type: types.number, initial: 0 });

  return builder.finish();
}

function controllerSequence(body: JitInstructionBuilder): void {
  const flash = FLASH_BASE_REGISTER;
  const pageOffset = FLASH_PAGE_SIZE * 2;

  // 复位映像：LOCK/OPTLOCK 置位，OPTR 为 RDP level 0。
  body.assert(hasFlag(body, flash, FLASH_CR_LOCK, FLASH_CR), (inner) =>
    inner.constant(types.string, 'reset CR must lock the controller'),
  );
  body.assert(hasFlag(body, flash, FLASH_CR_OPTLOCK, FLASH_CR), (inner) =>
    inner.constant(types.string, 'reset CR must lock option bytes'),
  );
  body.assert(
    body.equal(
      types.number,
      readFlash(body, num(body, flash + FLASH_OPTR), 4),
      num(body, FLASH_OPTR_RESET),
    ),
    (inner) => inner.constant(types.string, 'OPTR reset value must match ST production'),
  );

  // reserved/private 读返回 0，写不落到私有影子；不得越界访问 flashState。
  for (const offset of [0x1c, 0x80, 0xfc, 0x100, 0x3fc]) {
    body.assert(
      body.equal(types.number, readFlash(body, num(body, flash + offset), 4), num(body, 0)),
      (inner) => inner.constant(types.string, 'reserved/private read must return 0'),
    );
    writeFlash(body, num(body, flash + offset), 4, num(body, 0xffff_ffff));
    body.assert(
      body.equal(types.number, readFlash(body, num(body, flash + offset), 4), num(body, 0)),
      (inner) => inner.constant(types.string, 'reserved/private write must be ignored'),
    );
  }

  // SR 是 W1C：只清本次写入 lane 的位，不因 RMW 清掉同字节其他已置位标志。
  body.store32le(
    body.memory(FLASH_STATE_MEMORY),
    num(body, FLASH_SR),
    num(body, FLASH_SR_PROGERR | FLASH_SR_WRPERR),
  );
  writeFlash(body, num(body, flash + FLASH_SR), 1, num(body, FLASH_SR_PROGERR));
  body.assert(
    body.equal(
      types.number,
      readFlash(body, num(body, flash + FLASH_SR), 4),
      num(body, FLASH_SR_WRPERR),
    ),
    (inner) => inner.constant(types.string, 'byte W1C must only clear the written lane'),
  );
  writeFlash(body, num(body, flash + FLASH_SR + 1), 1, num(body, 0xff));
  body.assert(
    body.equal(
      types.number,
      readFlash(body, num(body, flash + FLASH_SR), 4),
      num(body, FLASH_SR_WRPERR),
    ),
    (inner) => inner.constant(types.string, 'W1C on another byte must not clear the flag'),
  );
  writeFlash(body, num(body, flash + FLASH_SR), 1, num(body, FLASH_SR_WRPERR));
  body.assert(
    body.equal(types.number, readFlash(body, num(body, flash + FLASH_SR), 4), num(body, 0)),
    (inner) => inner.constant(types.string, 'W1C lane must clear only its flag'),
  );

  // 未解锁写：PGSERR，映像不变。
  writeFlashMemory(body, num(body, pageOffset), 4, num(body, 0xdead_beef));
  body.assert(hasFlag(body, flash, FLASH_SR_PGSERR), (inner) =>
    inner.constant(types.string, 'locked flash write must set PGSERR'),
  );
  body.assert(
    body.equal(
      types.number,
      body.load32le(body.memory('code'), num(body, pageOffset)),
      num(body, 0),
    ),
    (inner) => inner.constant(types.string, 'locked flash write must not change code'),
  );
  writeFlash(body, num(body, flash + FLASH_SR), 4, num(body, FLASH_SR_PGSERR));

  // KEYR 只接受 32 位、字对齐写；字节/错位写忽略，不能解锁。
  writeFlash(body, num(body, flash + FLASH_KEYR), 1, num(body, 0x23));
  writeFlash(body, num(body, flash + FLASH_KEYR + 1), 4, num(body, FLASH_KEY1));
  body.assert(
    body.notEqual(
      types.number,
      body.bitAnd(readFlash(body, num(body, flash + FLASH_CR), 4), num(body, FLASH_CR_LOCK)),
      num(body, 0),
    ),
    (inner) => inner.constant(types.string, 'KEYR byte/misaligned write must not unlock'),
  );

  // KEYR 解锁。
  writeFlash(body, num(body, flash + FLASH_KEYR), 4, num(body, FLASH_KEY1));
  writeFlash(body, num(body, flash + FLASH_KEYR), 4, num(body, FLASH_KEY2));
  body.assert(
    body.equal(
      types.number,
      body.bitAnd(readFlash(body, num(body, flash + FLASH_CR), 4), num(body, FLASH_CR_LOCK)),
      num(body, 0),
    ),
    (inner) => inner.constant(types.string, 'KEYR sequence must clear LOCK'),
  );

  // 页擦除 page 2：刚不到 20 ms 仍 BSY，刚好 20 ms 完成。
  writeFlash(
    body,
    num(body, flash + FLASH_CR),
    4,
    num(body, FLASH_CR_PER | (2 << 3) | FLASH_CR_STRT),
  );
  body.assert(hasFlag(body, flash, FLASH_SR_BSY), (inner) =>
    inner.constant(types.string, 'page erase must start BSY'),
  );
  flashModule.advance!(body, num(body, 19_999_999_999));
  body.assert(hasFlag(body, flash, FLASH_SR_BSY), (inner) =>
    inner.constant(types.string, 'page erase must stay BSY just below 20 ms'),
  );
  flashModule.advance!(body, num(body, 1));
  body.assert(
    body.equal(
      types.number,
      body.bitAnd(readFlash(body, num(body, flash + FLASH_SR), 4), num(body, FLASH_SR_BSY)),
      num(body, 0),
    ),
    (inner) => inner.constant(types.string, 'page erase must clear BSY at 20 ms'),
  );
  body.assert(
    body.equal(types.number, readFlash(body, num(body, flash + FLASH_SR), 4), num(body, 0)),
    (inner) => inner.constant(types.string, 'page erase must not leave errors'),
  );
  body.assert(
    body.equal(
      types.number,
      body.load32le(body.memory('code'), num(body, pageOffset)),
      num(body, 0xffff_ffff),
    ),
    (inner) => inner.constant(types.string, 'page erase must fill 0xFF'),
  );

  // 编程双字 + EOP。
  writeFlash(body, num(body, flash + FLASH_CR), 4, num(body, FLASH_CR_PG | FLASH_CR_EOPIE));
  writeFlashMemory(body, num(body, pageOffset), 4, num(body, 0x1122_3344));
  writeFlashMemory(body, num(body, pageOffset + 4), 4, num(body, 0x5566_7788));
  body.assert(hasFlag(body, flash, FLASH_SR_BSY), (inner) =>
    inner.constant(types.string, 'double word program must start BSY'),
  );
  flashModule.advance!(body, num(body, 1_000_000_000));
  body.assert(
    body.equal(
      types.number,
      body.load32le(body.memory('code'), num(body, pageOffset)),
      num(body, 0x1122_3344),
    ),
    (inner) => inner.constant(types.string, 'double word low half must program'),
  );
  body.assert(hasFlag(body, flash, FLASH_SR_EOP), (inner) =>
    inner.constant(types.string, 'EOPIE must set EOP'),
  );
  body.assert(flashModule.interrupts![0]!.pending(body), (inner) =>
    inner.constant(types.string, 'EOP with EOPIE must assert FLASH IRQ'),
  );

  // 1→0：已编程 double word 再写全 1 必须 PROGERR，原值不变。
  writeFlashMemory(body, num(body, pageOffset), 4, num(body, 0xffff_ffff));
  writeFlashMemory(body, num(body, pageOffset + 4), 4, num(body, 0xffff_ffff));
  body.assert(hasFlag(body, flash, FLASH_SR_PROGERR), (inner) =>
    inner.constant(types.string, 'reprogramming a non-erased double word must set PROGERR'),
  );
  body.assert(
    body.equal(
      types.number,
      body.load32le(body.memory('code'), num(body, pageOffset)),
      num(body, 0x1122_3344),
    ),
    (inner) => inner.constant(types.string, 'PROGERR must preserve the old double word'),
  );
  writeFlash(body, num(body, flash + FLASH_SR), 4, num(body, FLASH_SR_PROGERR | FLASH_SR_EOP));

  // 字节写：SIZERR。
  writeFlashMemory(body, num(body, pageOffset), 1, num(body, 0x12));
  body.assert(hasFlag(body, flash, FLASH_SR_SIZERR), (inner) =>
    inner.constant(types.string, 'byte write must set SIZERR'),
  );
  writeFlash(body, num(body, flash + FLASH_SR), 4, num(body, FLASH_SR_SIZERR));

  // ERRIE=1 时错误同时置 OPERR。
  writeFlash(body, num(body, flash + FLASH_CR), 4, num(body, FLASH_CR_PG | FLASH_CR_ERRIE));
  writeFlashMemory(body, num(body, pageOffset), 4, num(body, 0x0102_0304));
  writeFlashMemory(body, num(body, pageOffset + 4), 4, num(body, 0x0506_0708));
  body.assert(hasFlag(body, flash, FLASH_SR_PROGERR), (inner) =>
    inner.constant(types.string, 'repeat program must set PROGERR'),
  );
  body.assert(hasFlag(body, flash, FLASH_SR_OPERR), (inner) =>
    inner.constant(types.string, 'ERRIE must set OPERR'),
  );
  writeFlash(body, num(body, flash + FLASH_SR), 4, num(body, FLASH_SR_PROGERR | FLASH_SR_OPERR));
  writeFlash(body, num(body, flash + FLASH_CR), 4, num(body, 0));
  writeFlash(body, num(body, flash + FLASH_CR), 4, num(body, FLASH_CR_PG));

  // 对齐错误：首字地址 +4。
  writeFlashMemory(body, num(body, pageOffset + 4), 4, num(body, 0x0102_0304));
  body.assert(hasFlag(body, flash, FLASH_SR_PGAERR), (inner) =>
    inner.constant(types.string, 'unaligned first word must set PGAERR'),
  );
  writeFlash(body, num(body, flash + FLASH_SR), 4, num(body, FLASH_SR_PGAERR));

  // WRP 选项解锁并保护 page 2；对 page 2 编程必须 WRPERR。
  writeFlash(body, num(body, flash + FLASH_OPTKEYR), 4, num(body, FLASH_OPTKEY1));
  writeFlash(body, num(body, flash + FLASH_OPTKEYR), 4, num(body, FLASH_OPTKEY2));
  writeFlash(body, num(body, flash + FLASH_WRP1AR), 4, num(body, 0x0002_0002));
  body.assert(
    body.equal(
      types.number,
      readFlash(body, num(body, flash + FLASH_WRP1AR), 4),
      num(body, 0x0002_0002),
    ),
    (inner) => inner.constant(types.string, 'WRP1AR write must be visible'),
  );
  writeFlashMemory(body, num(body, pageOffset + 8), 4, num(body, 0x0102_0304));
  body.assert(hasFlag(body, flash, FLASH_SR_WRPERR), (inner) =>
    inner.constant(types.string, 'WRP-protected page must set WRPERR'),
  );

  // WRP 存在时全片擦除也必须 WRPERR。
  writeFlash(body, num(body, flash + FLASH_SR), 4, num(body, FLASH_SR_WRPERR));
  body.assert(
    body.equal(types.number, readFlash(body, num(body, flash + FLASH_SR), 4), num(body, 0)),
    (inner) => inner.constant(types.string, 'SR must be clear before mass erase'),
  );
  writeFlash(body, num(body, flash + FLASH_CR), 4, num(body, 0));
  writeFlash(body, num(body, flash + FLASH_CR), 4, num(body, FLASH_CR_MER1 | FLASH_CR_STRT));
  body.assert(body.not(hasFlag(body, flash, FLASH_SR_BSY)), (inner) =>
    inner.constant(types.string, 'mass erase must not start under WRP'),
  );
  body.assert(body.not(hasFlag(body, flash, FLASH_SR_PGSERR)), (inner) =>
    inner.constant(types.string, 'mass abort must be WRPERR, not PGSERR'),
  );
  flashModule.advance!(body, num(body, 1_000_000_000));
  body.assert(hasFlag(body, flash, FLASH_SR_WRPERR), (inner) =>
    inner.constant(types.string, 'mass erase must abort on WRP'),
  );

  // 清 WRP 后全片擦除：刚不到 40 ms 仍 BSY，刚好 40 ms 完成并回 0xFF。
  writeFlash(body, num(body, flash + FLASH_SR), 4, num(body, FLASH_SR_WRPERR));
  writeFlash(body, num(body, flash + FLASH_WRP1AR), 4, num(body, 0x0000_003f));
  writeFlash(body, num(body, flash + FLASH_CR), 4, num(body, FLASH_CR_MER1 | FLASH_CR_STRT));
  body.assert(hasFlag(body, flash, FLASH_SR_BSY), (inner) =>
    inner.constant(types.string, 'mass erase must start BSY'),
  );
  flashModule.advance!(body, num(body, 39_999_999_999));
  body.assert(hasFlag(body, flash, FLASH_SR_BSY), (inner) =>
    inner.constant(types.string, 'mass erase must stay BSY just below 40 ms'),
  );
  flashModule.advance!(body, num(body, 1));
  body.assert(
    body.equal(
      types.number,
      body.bitAnd(readFlash(body, num(body, flash + FLASH_SR), 4), num(body, FLASH_SR_BSY)),
      num(body, 0),
    ),
    (inner) => inner.constant(types.string, 'mass erase must clear BSY at 40 ms'),
  );
  body.assert(
    body.equal(
      types.number,
      body.load32le(body.memory('code'), num(body, 0)),
      num(body, 0xffff_ffff),
    ),
    (inner) => inner.constant(types.string, 'mass erase must fill code from 0'),
  );
  body.assert(
    body.equal(
      types.number,
      body.load32le(body.memory('code'), num(body, 0x1fffc)),
      num(body, 0xffff_ffff),
    ),
    (inner) => inner.constant(types.string, 'mass erase must fill the last word'),
  );

  // 软锁定后写 CR 与 Flash 都不生效；正确 KEYR 可再次解锁。
  writeFlash(body, num(body, flash + FLASH_SR), 4, num(body, 0));
  writeFlash(body, num(body, flash + FLASH_CR), 4, num(body, FLASH_CR_LOCK));
  body.assert(hasFlag(body, flash, FLASH_CR_LOCK, FLASH_CR), (inner) =>
    inner.constant(types.string, 'LOCK must be set-only'),
  );
  writeFlashMemory(body, num(body, pageOffset), 4, num(body, 0x0102_0304));
  body.assert(hasFlag(body, flash, FLASH_SR_PGSERR), (inner) =>
    inner.constant(types.string, 'locked write must be rejected'),
  );
  writeFlash(body, num(body, flash + FLASH_SR), 4, num(body, FLASH_SR_PGSERR));
  writeFlash(body, num(body, flash + FLASH_CR), 4, num(body, 0));
  body.assert(hasFlag(body, flash, FLASH_CR_LOCK, FLASH_CR), (inner) =>
    inner.constant(types.string, 'writing 0 cannot clear LOCK'),
  );
  writeFlash(body, num(body, flash + FLASH_KEYR), 4, num(body, FLASH_KEY1));
  writeFlash(body, num(body, flash + FLASH_KEYR), 4, num(body, FLASH_KEY2));
  body.assert(
    body.equal(
      types.number,
      body.bitAnd(readFlash(body, num(body, flash + FLASH_CR), 4), num(body, FLASH_CR_LOCK)),
      num(body, 0),
    ),
    (inner) => inner.constant(types.string, 'KEYR must unlock after software lock'),
  );

  // OPTKEYR + OPTSTRT：选项编程有有限忙时，完成后清 OPTSTRT。
  writeFlash(body, num(body, flash + FLASH_OPTKEYR), 4, num(body, FLASH_OPTKEY1));
  writeFlash(body, num(body, flash + FLASH_OPTKEYR), 4, num(body, FLASH_OPTKEY2));
  writeFlash(body, num(body, flash + FLASH_OPTR), 4, num(body, FLASH_OPTR_RESET));
  writeFlash(body, num(body, flash + FLASH_CR), 4, num(body, FLASH_CR_OPTSTRT));
  body.assert(hasFlag(body, flash, FLASH_SR_BSY), (inner) =>
    inner.constant(types.string, 'option programming must start BSY'),
  );
  flashModule.advance!(body, num(body, 100_000_000_000));
  body.assert(
    body.equal(
      types.number,
      body.bitAnd(readFlash(body, num(body, flash + FLASH_CR), 4), num(body, FLASH_CR_OPTSTRT)),
      num(body, 0),
    ),
    (inner) => inner.constant(types.string, 'option programming must clear OPTSTRT'),
  );

  // 选项跨“控制器复位”保留：模拟 reset.ts 写入 marker 2，下一次访问复位 CR 但不丢 WRP。
  writeFlash(body, num(body, flash + FLASH_WRP1AR), 4, num(body, 0x0003_0002));
  body.store32le(body.memory(FLASH_STATE_MEMORY), num(body, 0xfc), num(body, 0x464c_5352));
  body.assert(hasFlag(body, flash, FLASH_CR_LOCK, FLASH_CR), (inner) =>
    inner.constant(types.string, 'controller reset marker must re-lock CR'),
  );
  body.assert(
    body.equal(
      types.number,
      readFlash(body, num(body, flash + FLASH_WRP1AR), 4),
      num(body, 0x0003_0002),
    ),
    (inner) => inner.constant(types.string, 'option registers must survive controller reset'),
  );

  // 复位标记清掉 key poison；随后重新解锁，再测试错误序列锁死。
  writeFlash(body, num(body, flash + FLASH_KEYR), 4, num(body, FLASH_KEY1));
  writeFlash(body, num(body, flash + FLASH_KEYR), 4, num(body, FLASH_KEY2));
  body.assert(
    body.equal(
      types.number,
      body.bitAnd(readFlash(body, num(body, flash + FLASH_CR), 4), num(body, FLASH_CR_LOCK)),
      num(body, 0),
    ),
    (inner) => inner.constant(types.string, 'controller reset must clear key poison'),
  );

  // OBL_LAUNCH 走统一 reset sink：设置 sys.RESET_REQUEST，并自清 OBL_LAUNCH。
  writeFlash(body, num(body, flash + FLASH_OPTKEYR), 4, num(body, FLASH_OPTKEY1));
  writeFlash(body, num(body, flash + FLASH_OPTKEYR), 4, num(body, FLASH_OPTKEY2));
  writeFlash(body, num(body, flash + FLASH_CR), 4, num(body, FLASH_CR_OBL_LAUNCH));
  body.assert(
    body.equal(
      types.number,
      body.load32le(body.memory('sys'), num(body, RESET_REQUEST)),
      num(body, 1),
    ),
    (inner) => inner.constant(types.string, 'OBL_LAUNCH must request the shared reset sink'),
  );
  body.assert(
    body.equal(
      types.number,
      body.bitAnd(readFlash(body, num(body, flash + FLASH_CR), 4), num(body, FLASH_CR_OBL_LAUNCH)),
      num(body, 0),
    ),
    (inner) => inner.constant(types.string, 'OBL_LAUNCH must self-clear'),
  );
  body.store32le(body.memory('sys'), num(body, RESET_REQUEST), num(body, 0));

  // 错误钥匙序列 poison 到复位；随后正确 KEY1+KEY2 也不能解锁。
  writeFlash(body, num(body, flash + FLASH_CR), 4, num(body, FLASH_CR_LOCK));
  writeFlash(body, num(body, flash + FLASH_KEYR), 4, num(body, FLASH_KEY1));
  writeFlash(body, num(body, flash + FLASH_KEYR), 4, num(body, 0x1111_2222));
  writeFlash(body, num(body, flash + FLASH_KEYR), 4, num(body, FLASH_KEY1));
  writeFlash(body, num(body, flash + FLASH_KEYR), 4, num(body, FLASH_KEY2));
  body.assert(hasFlag(body, flash, FLASH_CR_LOCK, FLASH_CR), (inner) =>
    inner.constant(types.string, 'wrong key sequence must lock until reset'),
  );

  body.stop();
}

function hasFlag(body: JitInstructionBuilder, flash: number, flag: number, register = FLASH_SR) {
  return body.notEqual(
    types.number,
    body.bitAnd(readFlash(body, num(body, flash + register), 4), num(body, flag)),
    num(body, 0),
  );
}

function num(body: JitInstructionBuilder, value: number) {
  return body.constant(types.number, value);
}

describe('STM32G431RBT6 Flash 控制器', () => {
  it('锁/解锁、20/40 ms BSY、页/全片擦、编程、W1C、保护与选项复位', () => {
    const translate: JitTranslate = (input) =>
      activateMachine(MACHINE, () => {
        const builder = createJitBlockBuilder();

        builder.instruction({ pc: input.pc, nextPc: input.pc }, (body) => {
          controllerSequence(body);
        });

        return builder.finish();
      });

    const library = createDeviceLibrary([
      {
        id: 'flash-rig',
        model: model(),
        create: (context) => {
          const registration = context.attachJit({
            entry: 'flash',
            code: 'code',
            pc: 'pc',
            translate,
          });

          return { sync() {}, dispose: () => registration.dispose() };
        },
      },
    ]);

    const board = createBoard(
      library,
      { instances: [{ id: 'flash-rig', type: 'flash-rig' }], nets: [] },
      { execution: 'precise' },
    );

    try {
      board.runUntil(10);
    } finally {
      board.dispose();
    }
  });
});
