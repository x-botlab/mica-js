import { describe, expect, it } from 'vitest';
import {
  JOINT_440MS_EXPECTED,
  JOINT_FULL_FRAME_PIXELS,
  createJointBoard,
  gramMatchesOracle,
  nonZeroGramPixels,
  sameBytes,
} from './joint-harness';

/**
 * MCU + LCD 联合仿真：跑 `HAL_06_LCD` 的真实 Keil 固件。
 *
 * 需要显式开启：`MICA_JOINT=1 pnpm exec vitest run test/ili9325/joint.test.ts`。
 * 200 µs 用例证明 MCU 经真实 GPIO 把 BSP 初始化序列写进 LCD；440 ms 用例用独立
 * MCU intent 计数与 GRAM oracle 对账整条写路径，漏掉 WR 边沿会直接失败。
 */

/**
 * 推进到 200 µs：此时 `REG_932X_Init` 已写完全部电源/时序寄存器并进入第一个
 * `HAL_Delay(200)`。
 */
const INIT_PS = 200_000_000;
/** 220 ms：仍在 BSP 的延时序列内，检查初始化边沿，尚未写入 GRAM。 */
const MID_PS = 220_000_000_000;
/** 440 ms：覆盖整屏清屏、后续绘图与多帧发布。 */
const END_PS = 440_000_000_000;
const CLEAR_COLOR = JOINT_440MS_EXPECTED.clearColor;
const FULL_FRAME_PIXELS = JOINT_FULL_FRAME_PIXELS;

describe.skipIf(!process.env.MICA_JOINT)('MCU + LCD 联合仿真', () => {
  it('HAL_06_LCD 固件经 GPIO 把 BSP 初始化序列写进 ILI9325', async () => {
    const joint = await createJointBoard({ accounting: true });
    const { board, frames, faults, errors, lcd } = joint;

    try {
      board.runUntil(0);
      joint.advanceTo(INIT_PS);

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

      // 初始化阶段的每条 MCU WR 边沿都已经到达 LCD；还没有写像素。
      const accounting = joint.readAccounting()!;

      expect(accounting.wrLevelChanges).toBeGreaterThan(0);
      expect(accounting.wrSamples).toBe(accounting.wrLevelChanges);
      expect(accounting.csSamples).toBe(accounting.csLevelChanges);
      expect(accounting.rsSamples).toBe(accounting.rsLevelChanges);
      expect(accounting.dataSamples).toBeGreaterThanOrEqual(accounting.dataBitLevelChanges);
      expect(accounting.pixelWrites).toBe(0);
      expect(accounting.gramStores).toBe(0);
      expect(accounting.oracleGramStores).toBe(0);

      // 还没写像素，因此不应有帧。
      expect(frames).toHaveLength(0);
      expect(joint.expectedFrames).toHaveLength(0);
    } finally {
      joint.dispose();
    }
  });

  it('440 ms 默认路径逐边沿对账，覆盖蓝底清屏和白色十字', async () => {
    const joint = await createJointBoard({ accounting: true });
    const { board, frames, faults, errors, lcd } = joint;

    try {
      board.runUntil(0);
      joint.advanceTo(MID_PS);

      // 初始化的命令已经到达 LCD，但 HAL_Delay 结束前不会写入像素。
      const midway = joint.readAccounting()!;

      expect(midway.wrLevelChanges).toBeGreaterThan(0);
      expect(midway.wrSamples).toBe(midway.wrLevelChanges);
      expect(midway.pixelWrites).toBe(0);
      expect(midway.gramStores).toBe(0);
      expect(midway.oracleGramStores).toBe(0);
      expect(frames).toHaveLength(0);

      joint.advanceTo(END_PS);

      expect(errors).toEqual([]);
      expect(faults).toEqual([]);
      expect(board.status).toBe('ready');
      expect(board.time).toBe(END_PS);

      const accounting = joint.readAccounting()!;

      // 1. MCU 发出的每个 WR/CS/RS 电平变化都必须在 LCD sample 上可见。
      // 旧路径只有 482 个 WR sample、136 次 GRAM store，会在这里失败。
      expect(accounting.wrLevelChanges).toBe(JOINT_440MS_EXPECTED.wrLevelChanges);
      expect(accounting.selectedRises).toBe(JOINT_440MS_EXPECTED.selectedRises);
      expect(accounting.wrSamples).toBe(JOINT_440MS_EXPECTED.wrLevelChanges);
      expect(accounting.csSamples).toBe(accounting.csLevelChanges);
      expect(accounting.rsSamples).toBe(accounting.rsLevelChanges);
      // 数据脚同电平但不同驱动强度的重发不算漏沿；不允许 sample 少于 intent 电平变化。
      expect(accounting.dataSamples).toBeGreaterThanOrEqual(accounting.dataBitLevelChanges);

      // 2. 每个 0x22 数据写都必须真正落到 GRAM，且独立 oracle 得到同样的写次数。
      expect(accounting.pixelWrites).toBe(JOINT_440MS_EXPECTED.pixelWrites);
      expect(accounting.gramStores).toBe(JOINT_440MS_EXPECTED.gramStores);
      expect(accounting.oracleGramStores).toBe(JOINT_440MS_EXPECTED.gramStores);

      // 3. 最终图像与独立 MCU oracle 逐像素一致，不依赖 LCD 自身的下游复制。
      const gram = lcd.memories.get('gram')!;

      expect(gramMatchesOracle(gram, accounting.oracleGram)).toBe(true);
      expect(nonZeroGramPixels(gram)).toBe(JOINT_440MS_EXPECTED.nonZeroPixels);

      // 4. 固件的整屏清屏（LCD_Clear(Blue)）在 oracle 中必须是 76,800 个 0x001F。
      const clears = accounting.fullScreenFills.filter(
        (fill) => fill.value === CLEAR_COLOR && fill.pixels === FULL_FRAME_PIXELS && fill.uniform,
      );

      expect(clears.length).toBeGreaterThan(0);

      // 5. 发布帧必须等于模型在帧体发送时刻交给适配器的载荷；帧矩形合法。
      // 这里不再拿 runUntil 末尾的 GRAM 快照比较，避免同一量子内后续绘图让下游自比较失效。
      expect(frames).toHaveLength(JOINT_440MS_EXPECTED.frames);
      expect(joint.expectedFrames).toHaveLength(frames.length);
      expect(frames.every((frame, index) => sameBytes(frame, joint.expectedFrames[index]!))).toBe(
        true,
      );

      // 6. 每个矩形的每个像素都等于发送时刻的独立总线 oracle。
      // 60 Hz 合帧可能把清屏与随后绘图合入同一帧，因此不要求发布纯色整屏帧。
      expect(accounting.oracleFrames).toHaveLength(frames.length);
      expect(
        frames.every((frame, index) => sameBytes(frame, accounting.oracleFrames[index]!)),
      ).toBe(true);
    } finally {
      joint.dispose();
    }
  }, 900_000);
});
