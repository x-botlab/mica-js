import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import {
  FLASH,
  PERIPH,
  SFR,
  SFR_IAP_ADDRH,
  SFR_IAP_ADDRL,
  SFR_IAP_CMD,
  SFR_IAP_CONTR,
  SFR_IAP_DATA,
  SFR_IAP_TRIG,
  asBody,
  number,
  periph8,
  periph16,
  periph32,
  readSfr,
  setPeriph8,
  setPeriph16,
  setPeriph32,
  setSfrBit,
  sfrBitIsSet,
  writeSfr,
} from '../kernel/ir';
import type { Body } from '../kernel/ir';
import { IAP_BASE } from './layout';
import type { Clock, Peripheral } from './types';

/**
 * IAP / EEPROM（Data Flash）字节读、字节编程与扇区擦除。
 *
 * 手册第 9 章：IAP_DATA/IAP_ADDRH/IAP_ADDRL/IAP_CMD 决定操作，向 IAP_TRIG 先写 5AH 再写
 * A5H 触发；IAP_CONTR 的 IAPEN 允许操作，WT2:WT0 选择 CPU 等待时间。EEPROM 按 512 字节
 * 分扇区，擦除只能整扇区进行，编程只能把 1 写成 0（因此与现有值按位与）。
 *
 * 时序模型：手册里 CPU 在执行 IAP 命令期间停顿；本模型没有停顿原语，于是把命令排成
 * 待执行状态，由 `advance` 按 IAP_CONTR 的等待时间推进，到时再修改 `flash`。读命令的
 * 等待只有 2 个时钟，触发它的 MOV 指令本身有 3 个时钟，因此紧随其后的 `MOV A,IAP_DATA`
 * 一定能读到新值。待执行期间再次触发会被忽略（真实硬件此时 CPU 处于停顿状态，不可能
 * 发出新命令）。
 *
 * 状态（`IAP_BASE` = 0x80）：
 * - 0x80 标志：bit0 已收到 5AH，bit4–5 待执行命令
 * - 0x81 触发时锁存的 IAP_DATA
 * - 0x82–0x83 触发时锁存的地址
 * - 0x84–0x87 剩余等待时间（纳秒，32 位）；擦除时低 16 位复用为扇区内下标
 */

/** `flash` 只有 1 KiB；地址越界按手册置 CMD_FAIL。 */
const FLASH_SIZE = 0x400;
/** 扇区 512 字节。 */
const SECTOR_SIZE = 512;
const SECTOR_MASK = ~(SECTOR_SIZE - 1) & 0xffff;

const IAP_FLAGS = IAP_BASE;
const IAP_DATA_SAVED = IAP_BASE + 1;
const IAP_ADDRESS = IAP_BASE + 2;
const IAP_REMAINING = IAP_BASE + 4;

const FLAG_ARMED = 0x01;
const PENDING_MASK = 0x30;
const COMMAND_SHIFT = 4;

const CMD_READ = 1;
const CMD_PROGRAM = 2;
const CMD_ERASE = 3;

const TRIGGER_FIRST = 0x5a;
const TRIGGER_SECOND = 0xa5;

const CMD_FAIL_BIT = 3;
const ISPEN_BIT = 7;

/** 等待时间表（手册 9.1），下标是 IAP_CONTR 的 WT2:WT0。 */
const PROGRAM_CLOCKS = [1760, 1320, 1100, 660, 330, 165, 110, 55] as const;
const ERASE_CLOCKS = [672384, 504288, 420240, 252144, 126072, 63036, 42024, 21012] as const;

const nanoseconds = (clocks: number, cyclePs: number): number =>
  Math.max(1, Math.round((clocks * cyclePs) / 1000));

const storeLatch = (b: Body, address: number, value: Value<number>): void => {
  b.store8(SFR, number(b, address & 0x7f), value);
};

const flagIsSet = (b: Body, flag: number): Value<boolean> =>
  b.notEqual(types.number, b.bitAnd(periph8(b, IAP_FLAGS), number(b, flag)), number(b, 0));

const pendingIsSet = (b: Body): Value<boolean> => flagIsSet(b, PENDING_MASK);

/** 结束当前触发序列：只清 bit0，保留待执行命令。 */
const resetTrigger = (b: Body): void => {
  setPeriph8(b, IAP_FLAGS, b.bitAnd(periph8(b, IAP_FLAGS), number(b, 0xfe)));
};

/** 按 IAP_CONTR 的 WT2:WT0 选等待时间（纳秒）。 */
const scheduleWait = (b: Body, wait: Value<number>, table: readonly number[]): void => {
  b.match(
    wait,
    table.map((value, index) => ({
      pattern: index,
      emit: (arm) => setPeriph32(arm, IAP_REMAINING, number(arm, value)),
    })),
    (otherwise) => setPeriph32(otherwise, IAP_REMAINING, number(otherwise, table[0]!)),
  );
};

/** 到点后真正修改 `flash`。 */
const completePending = (b: Body): void => {
  const flags = periph8(b, IAP_FLAGS);
  const command = b.bitAnd(b.shiftRightUnsigned(flags, number(b, COMMAND_SHIFT)), number(b, 3));
  const address = periph16(b, IAP_ADDRESS);
  const data = periph8(b, IAP_DATA_SAVED);

  // 先清命令，再落盘：擦除循环要复用剩余时间字段。
  setPeriph8(b, IAP_FLAGS, b.bitAnd(flags, number(b, 0x0f)));

  b.if(b.equal(types.number, command, number(b, CMD_READ)), (read) => {
    const body = asBody(read);

    writeSfr(body, SFR_IAP_DATA, body.load8(FLASH, address));
  });
  b.if(b.equal(types.number, command, number(b, CMD_PROGRAM)), (program) => {
    const body = asBody(program);

    body.store8(FLASH, address, body.bitAnd(body.load8(FLASH, address), data));
  });
  b.if(b.equal(types.number, command, number(b, CMD_ERASE)), (erase) => {
    const body = asBody(erase);
    const base = body.bitAnd(address, number(body, SECTOR_MASK));

    setPeriph16(body, IAP_REMAINING, number(body, 0));
    body.while(
      (test) =>
        test.lessThan(
          test.load16le(PERIPH, test.constant(types.number, IAP_REMAINING)),
          test.constant(types.number, SECTOR_SIZE),
        ),
      (emit) => {
        const index = periph16(emit, IAP_REMAINING);

        emit.store8(FLASH, emit.add(base, index), emit.constant(types.number, 0xff));
        setPeriph16(emit, IAP_REMAINING, emit.add(index, number(emit, 1)));
      },
    );
  });
};

/** 校验地址、锁存参数并排入等待。 */
const runCommand = (b: Body, programNs: readonly number[], eraseNs: readonly number[]): void => {
  const command = b.bitAnd(readSfr(b, SFR_IAP_CMD), number(b, 3));
  const address = b.bitOr(
    b.shiftLeft(readSfr(b, SFR_IAP_ADDRH), number(b, 8)),
    readSfr(b, SFR_IAP_ADDRL),
  );
  const inRange = b.lessThan(address, number(b, FLASH_SIZE));

  // 待机模式（MS1:MS0 = 00）不动作。
  b.if(b.notEqual(types.number, command, number(b, 0)), (active) => {
    const body = asBody(active);

    body.if(
      inRange,
      (valid) => {
        const ok = asBody(valid);
        const wait = ok.bitAnd(readSfr(ok, SFR_IAP_CONTR), number(ok, 7));

        setPeriph8(ok, IAP_DATA_SAVED, readSfr(ok, SFR_IAP_DATA));
        setPeriph16(ok, IAP_ADDRESS, address);

        // 字节读只有 2 个时钟的等待，短于触发它的两条 MOV（各 3 个时钟），真实硬件
        // 里 CPU 会在 IAP 期间停顿，因此这里当场读回，避免「读到的还是上一次的数据」。
        ok.if(ok.equal(types.number, command, number(ok, CMD_READ)), (read) =>
          writeSfr(asBody(read), SFR_IAP_DATA, asBody(read).load8(FLASH, address)),
        );
        // 编程与擦除耗时远长于一条指令，排入待执行状态由 `advance` 完成。
        const pending = (inner: Body, table: readonly number[]): void => {
          setPeriph8(
            inner,
            IAP_FLAGS,
            inner.bitOr(
              inner.bitAnd(periph8(inner, IAP_FLAGS), number(inner, 0x0f)),
              inner.shiftLeft(command, number(inner, COMMAND_SHIFT)),
            ),
          );
          scheduleWait(inner, wait, table);
        };

        ok.if(ok.equal(types.number, command, number(ok, CMD_PROGRAM)), (program) =>
          pending(asBody(program), programNs),
        );
        ok.if(ok.equal(types.number, command, number(ok, CMD_ERASE)), (erase) =>
          pending(asBody(erase), eraseNs),
        );
      },
      // 非法地址：手册规定置 CMD_FAIL，需由软件清零。
      (invalid) => setSfrBit(asBody(invalid), SFR_IAP_CONTR, CMD_FAIL_BIT, true),
    );
  });
};

/** 收到 A5H 且序列完整：IAPEN=1 且没有待执行命令时才真正执行。 */
const fireTrigger = (b: Body, programNs: readonly number[], eraseNs: readonly number[]): void => {
  b.if(sfrBitIsSet(b, SFR_IAP_CONTR, ISPEN_BIT), (enabled) => {
    const body = asBody(enabled);

    body.if(body.not(pendingIsSet(body)), (free) => runCommand(asBody(free), programNs, eraseNs));
  });
};

export function createIap(clock: Clock): Peripheral {
  const programNs = PROGRAM_CLOCKS.map((clocks) => nanoseconds(clocks, clock.cyclePs));
  const eraseNs = ERASE_CLOCKS.map((clocks) => nanoseconds(clocks, clock.cyclePs));

  return {
    id: 'iap',
    writes: [SFR_IAP_TRIG],
    onWrite(b, address, value) {
      if (address !== SFR_IAP_TRIG) return;

      const isFollowUp = b.notEqual(types.number, value, number(b, TRIGGER_FIRST));

      b.if(b.not(isFollowUp), (first) => {
        const body = asBody(first);

        setPeriph8(
          body,
          IAP_FLAGS,
          body.bitOr(body.bitAnd(periph8(body, IAP_FLAGS), number(body, 0xf0)), number(body, 1)),
        );
      });
      b.if(isFollowUp, (second) => {
        const body = asBody(second);
        const armed = flagIsSet(body, FLAG_ARMED);

        // 先结束触发序列（只清 bit0，不碰待执行命令），再决定是否执行。
        resetTrigger(body);
        body.if(body.equal(types.number, value, number(body, TRIGGER_SECOND)), (fire) => {
          const inner = asBody(fire);

          inner.if(armed, (run) => fireTrigger(asBody(run), programNs, eraseNs));
        });
      });

      storeLatch(b, SFR_IAP_TRIG, number(b, 0));
    },
    /** 有未完成的 IAP 命令时才需要推进。 */
    active(b) {
      return pendingIsSet(b);
    },
    advance(b, advance) {
      b.if(pendingIsSet(b), (running) => {
        const body = asBody(running);
        const left = body.subtract(periph32(body, IAP_REMAINING), advance.ticks);

        setPeriph32(body, IAP_REMAINING, body.max(left, number(body, 0)));
        body.if(body.lessThanOrEqual(left, number(body, 0)), (done) =>
          completePending(asBody(done)),
        );
      });
    },
  };
}
