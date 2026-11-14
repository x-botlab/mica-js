import { describe, expect, it } from 'vitest';
import { createJointBoard } from './joint-harness';

/**
 * MCU + LCD 联合仿真：跑 `HAL_06_LCD` 的真实 Keil 固件。
 *
 * 需要显式开启：`MICA_JOINT=1 pnpm exec vitest run test/joint.test.ts`。
 * 用例只推进到 200 µs，足以证明 MCU 经真实 GPIO 把 BSP 初始化序列写进 LCD；完整
 * HAL 延时与首帧发布由 `bench/joint-perf.test.ts` 覆盖。
 */

/**
 * 推进到 200 µs：此时 `REG_932X_Init` 已写完全部电源/时序寄存器并进入第一个
 * `HAL_Delay(200)`。
 */
const TARGET_PS = 200_000_000;

describe.skipIf(!process.env.MICA_JOINT)('MCU + LCD 联合仿真', () => {
  it('HAL_06_LCD 固件经 GPIO 把 BSP 初始化序列写进 ILI9325', async () => {
    const joint = await createJointBoard();
    const { board, frames, faults, errors, lcd } = joint;

    try {
      board.runUntil(0);
      joint.advanceTo(TARGET_PS);

      expect(errors).toEqual([]);
      expect(faults).toEqual([]);
      expect(board.status).toBe('ready');

      const regs = lcd.memories.get('regs')!;
      const view = new DataView(regs.buffer, regs.byteOffset, regs.byteLength);
      const reg = (index: number): number => view.getUint16(index * 2, true);

      // `REG_932X_Init` 的寄存器序列，值与参考 BSP 一一对应。
      expect(reg(0x02)).toBe(0x0700); // 1 行反转
      expect(reg(0x03)).toBe(0x1030); // GRAM 写入方向 + BGR
      expect(reg(0x08)).toBe(0x0207); // 前后肩
      expect(reg(0x11)).toBe(0x0007); // DC1/DC0/VC
      expect(reg(0x51)).toBe(0x00ef); // 窗口水平结束 = 239
      expect(reg(0x53)).toBe(0x013f); // 窗口垂直结束 = 319

      // 命令索引停在最后写入的寄存器，说明命令/数据锁存时序正确。
      expect(lcd.states.get('index')).toBe(0x13);

      // 还没写像素，因此不应有帧。
      expect(frames).toHaveLength(0);
    } finally {
      joint.dispose();
    }
  });
});
