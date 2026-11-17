import { describe, expect, it } from 'vitest';
import { assemble } from '../../../ct107d/test/fixtures/8051/assemble.ts';
import { createSourceHarness } from './source-harness.ts';

/**
 * RETI / IE 写保护窗口回归。
 *
 * 用软件置位 TI 制造一个持续 pending 的 UART 中断；ISR 只递增 IRAM 计数，不清 TI。
 * 若 RETI 后没有真实指令窗口，主循环计数不增长；窗口正确时每次中断之间至少执行一条
 * 真实固件指令。IE 写测试用 CLR TI 作为受保护指令：窗口缺失时 ISR 会抢在 CLR 前执行。
 */

const US = 1_000_000;
const IRAM_MAIN = 0x30;
const IRAM_ISR = 0x31;

async function run(firmware: Uint8Array, durationMs = 2) {
  const harness = await createSourceHarness({
    firmware,
    clockFrequency: 1_000_000,
  });

  try {
    harness.board.runUntil(durationMs * 1000 * US);
    const instance = (
      harness.board as unknown as {
        readonly instances: readonly {
          readonly memories: ReadonlyMap<string, Uint8Array>;
          readonly states: ReadonlyMap<string, number>;
        }[];
      }
    ).instances[0]!;
    const iram = instance.memories.get('iram');

    if (iram === undefined) throw new Error('missing iram');

    return {
      main: iram[IRAM_MAIN]!,
      isr: iram[IRAM_ISR]!,
      pc: instance.states.get('pc')!,
      faults: [...harness.faults],
    };
  } finally {
    harness.dispose();
  }
}

const RETI_LOOP = (isr: string): Uint8Array =>
  assemble(`
    ORG 0x0000
    LJMP main
    ORG 0x0023
${isr}
    ORG 0x0100
  main:
    MOV SCON,#00H
    SETB TI
    MOV IE,#90H
  loop:
    INC 30H
    SJMP loop
  `);

describe('kernel interrupt protection window', () => {
  it('RETI permits at least one real instruction with an odd RETI address', async () => {
    // RETI at 0x25 (odd): INC 30H/31H are two-byte instructions.
    const result = await run(RETI_LOOP('    INC 31H\n    RETI'));

    expect(result.faults).toEqual([]);
    expect(result.isr).toBeGreaterThan(10);
    expect(result.main).toBeGreaterThan(10);
  });

  it('RETI permits at least one real instruction with an even RETI address', async () => {
    // NOP at 0x23, INC 31H at 0x24, RETI at 0x26 (even).
    const result = await run(RETI_LOOP('    NOP\n    INC 31H\n    RETI'));

    expect(result.faults).toEqual([]);
    expect(result.isr).toBeGreaterThan(10);
    expect(result.main).toBeGreaterThan(10);
  });

  it('IE write protects the next instruction: CLR TI clears the pending request first', async () => {
    const result = await run(
      assemble(`
        ORG 0x0000
        LJMP main
        ORG 0x00F0
        main:
          MOV SCON,#00H
          SETB TI
          LJMP entry
        ORG 0x0100
        entry:
          MOV IE,#90H
          CLR TI
        done:
          SJMP done
        ORG 0x0023
          INC 31H
          RETI
      `),
      0.05,
    );

    expect(result.faults).toEqual([]);
    // 没有 IE 写窗口时，MOV IE 之后的服务会在 CLR TI 之前进入 ISR。
    expect(result.isr).toBe(0);
  });

  it('pending IRQ survives the IE write window and is serviced afterwards', async () => {
    const result = await run(
      assemble(`
        ORG 0x0000
        LJMP main
        ORG 0x00F0
        main:
          MOV SCON,#00H
          SETB TI
          LJMP entry
        ORG 0x0100
        entry:
          MOV IE,#90H
        done:
          SJMP done
        ORG 0x0023
          INC 31H
          RETI
      `),
      0.05,
    );

    expect(result.faults).toEqual([]);
    // 窗口内保留 dirty；窗口结束后必须重新扫到 TI，不能静默丢掉请求。
    expect(result.isr).toBeGreaterThan(0);
  });
});
