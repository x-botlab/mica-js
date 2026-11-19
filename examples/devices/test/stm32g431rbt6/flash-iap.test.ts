import { describe, expect, it } from 'vitest';
import { circuit, firmware } from './harness';

/**
 * Flash IAP：固件从主 Flash 启动，把 IAP 例程复制到 SRAM1 后从 SRAM 执行。
 *
 * 覆盖真实控制器路径：锁定写拒绝、KEYR 解锁、PER+PNB+STRT 页擦除回 0xFF、PG 双字
 * 编程、1→0、EOP、再次擦除后把新 Thumb 代码写入 Flash 并跳转执行。最后一步同时验证
 * guest 写 code 触发的 JIT code 版本失效。
 */
/*
 * 暂不执行：真实 bin 的 IAP 需要同时满足以下条件，当前由中央集成/并行代理收敛：
 * 1. 中央 PERIPHERALS 注册 flashModule；
 * 2. bus 的动态读/写分派把注册模块放在硬编码 FLASH/PWR 后备之前（刷新器写是延迟写，
 *    必然走动态分派；否则 FLASH_KEYR/CR/SR 落到通用后备）；
 * 3. code 代际失效：覆盖初始映像内 PC 后，adapter 的 registerFacts/blockCache/polling
 *    不得复用旧固件事实（见 /tmp/opencode/stm32g431-flash-generation-followup.md）；
 * 4. clock-tree/nvic 的并行 IR_SCOPE 修复。
 * 控制器语义目前没有真实 IR 覆盖用例（`flash-controller.test.ts` 已移除）；此用例保留为
 * 目标验收，额外边界：该固件把 IAP 例程复制到 SRAM 后从 0x20000000 执行；当前 JIT
 * 只在 `code` Flash 取指，SRAM 执行尚未建模，因此启用前仍需中央/引擎决定执行区合同。
 * 条件满足后把 `describe.skip` 改为 `describe`。
 */
describe.skip('STM32G431RBT6 Flash IAP', () => {
  it('从 SRAM 执行解锁、页擦、编程、1→0 并执行新写入的 Flash 代码', async () => {
    const board = await circuit({
      firmware: firmware('flash-iap.bin'),
      clockFrequency: 16_000_000,
      pins: ['PA2'],
    });

    try {
      // 三次擦除各 20 ms、两次编程和轮询；给足仿真时间。
      for (let step = 0; step < 40; step += 1) board.run(10_000_000_000);

      expect(board.faults).toEqual([]);

      const serial = (board.topics['serial2.tx'] as Uint8Array[] | undefined) ?? [];
      const output = serial.flatMap((bytes) => [...bytes]);

      // L=locked write rejected, U=unlock, E=page erase, P=program, N=1→0/PROGERR,
      // R=re-erase, J=jump, I=新写入的 Flash 代码实际执行。
      expect(output).toEqual([0x4c, 0x55, 0x45, 0x50, 0x4e, 0x52, 0x4a, 0x49]);

      const code = board.code;

      // 新代码最终位于 page 62 起始：movs r1,#'I'; str r1,[r0,#0x28]; b .
      expect([...code.subarray(0x1f000, 0x1f008)]).toEqual([
        0x49, 0x21, 0xc0, 0xf8, 0x28, 0x10, 0xfe, 0xe7,
      ]);
      // 1→0 测试后的 double word 已随第二次页擦除回到 0xFF。
      expect([...code.subarray(0x1f008, 0x1f010)]).toEqual(new Array(8).fill(0xff));
    } finally {
      board.dispose();
    }
  });
});
