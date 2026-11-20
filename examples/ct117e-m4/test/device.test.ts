import { expect, it } from 'vitest';
import { loadFirmware } from './firmware';
import {
  CT117E_M4_CLEAR_END_PS,
  CT117E_M4_CLEAR_START_PS,
  CT117E_M4_END_TIME_PS,
  CT117E_M4_EXPECTED,
  CT117E_M4_MID_TIME_PS,
  CT117E_M4_TIME_QUANTUM_PS,
  createHarness,
  digest,
  lcdWorkDelta,
  sameBytes,
  sameFrames,
} from './harness';

interface JointAccounting {
  readonly wrLevelChanges: number;
  readonly pixelWrites: number;
  readonly gramStores: number;
  readonly oracleGramStores: number;
  readonly wrSamples: number;
  readonly csSamples: number;
  readonly csLevelChanges: number;
  readonly rsSamples: number;
  readonly rsLevelChanges: number;
  readonly oracleFrames: readonly Uint8Array[];
  readonly oracleGram: Uint16Array;
  readonly fullScreenFills: readonly {
    readonly value: number;
    readonly pixels: number;
    readonly uniform: boolean;
  }[];
}

interface JointOracle {
  readonly board: {
    readonly time: number;
    readonly status: string;
    runUntil(target: number): void;
    dispose(): void;
  };
  readonly frames: readonly Uint8Array[];
  readonly expectedFrames: readonly Uint8Array[];
  readonly frameTimes: readonly number[];
  readonly errors: readonly string[];
  readonly faults: readonly number[];
  readonly lcd: {
    readonly memories: ReadonlyMap<string, Uint8Array>;
    readonly states: ReadonlyMap<string, unknown>;
  };
  readonly mcu: {
    readonly states: ReadonlyMap<string, unknown>;
    readonly memories: ReadonlyMap<string, Uint8Array>;
  };
  advanceTo(target: number): void;
  readAccounting(): JointAccounting | undefined;
  dispose(): void;
}

interface JointHarnessModule {
  createJointBoard(options: {
    readonly firmware: Uint8Array;
    readonly accounting?: boolean;
  }): Promise<JointOracle>;
  gramMatchesOracle(left: Uint8Array, right: Uint16Array): boolean;
}

// 通过变量说明符导入兄弟示例的 oracle，避免把未迁移的夹具源纳入本包类型检查。
const jointSpecifier = new URL('../../devices/test/ili9325/joint-harness.ts', import.meta.url).href;
const { createJointBoard, gramMatchesOracle } = (await import(
  jointSpecifier as string
)) as unknown as JointHarnessModule;

const PANEL_WIDTH = 320;
const PANEL_HEIGHT = 240;

function expectFrameLayout(frames: readonly Uint8Array[]): void {
  for (const [index, frame] of frames.entries()) {
    expect(frame.length, `frame ${index} header`).toBeGreaterThanOrEqual(8);

    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const x = view.getUint16(0, true);
    const y = view.getUint16(2, true);
    const width = view.getUint16(4, true);
    const height = view.getUint16(6, true);

    expect(width, `frame ${index} width`).toBeGreaterThan(0);
    expect(height, `frame ${index} height`).toBeGreaterThan(0);
    expect(x + width, `frame ${index} right edge`).toBeLessThanOrEqual(PANEL_WIDTH);
    expect(y + height, `frame ${index} bottom edge`).toBeLessThanOrEqual(PANEL_HEIGHT);
    expect(frame.length, `frame ${index} body`).toBe(8 + width * height * 2);
  }
}

/**
 * 正式交付产物用例：融合宿主从锁定的发布包装配一个实例。
 *
 * 真实 `HAL_06_LCD.hex` 映像按 80 MHz 从复位推进到 440 ms；固定工作量、最终
 * GRAM、逐帧内容、精确 frameInfo 时间与 MCU 状态同时与分立 joint-harness
 * 对账。oracle 只在正确性用例里运行，不进入任何计时。
 */
it('构建产物单实例运行 HAL_06_LCD.hex 440 ms，并与分立 oracle 逐帧/状态对账', async () => {
  const image = loadFirmware();

  // 先固定固件身份：文件或解析路径变化时，后面的工作量数字不能混用。
  expect(image.length).toBe(10_804);
  expect(image.dataBytes).toBe(10_804);
  expect(image.records).toBe(679);
  expect(image.dataRecords).toBe(676);
  expect(image.base).toBe(0x0800_0000);
  expect(image.end).toBe(0x0800_2a34);
  expect(image.imageSha256).toBe(
    '673d0b78c9376e0bae99761b6285cc2d2e00b3d44c6eefb7cf040a2992945650',
  );
  expect(image.entry).toBe(0x0800_01d9);
  expect(image.resetVector).toBe(0x0800_01ed);

  const oracle = await createJointBoard({ firmware: image.bytes, accounting: true });
  try {
    const actual = await createHarness({ hex: image.hex, captureFrameTimes: true });
    try {
      expect(actual.runtime.getState()).toEqual({ status: 'paused', simTime: 0 });
      oracle.board.runUntil(0);

      await actual.advanceTo(CT117E_M4_MID_TIME_PS);
      oracle.advanceTo(CT117E_M4_MID_TIME_PS);

      expect(actual.runtime.getState()).toEqual({
        status: 'paused',
        simTime: CT117E_M4_MID_TIME_PS,
      });
      expect(actual.errors).toEqual([]);
      expect(actual.faults).toEqual([]);

      const midpoint = actual.workload();

      expect(midpoint).toMatchObject(CT117E_M4_EXPECTED.midpoint);

      const advanceClear = async (timePs: number) => {
        await actual.advanceTo(timePs);
        oracle.advanceTo(timePs);
        const counts = oracle.readAccounting()!;
        return {
          actual: actual.workload(),
          wrChanges: counts.wrLevelChanges,
          gramStores: counts.oracleGramStores,
          frames: counts.oracleFrames.length,
        };
      };
      const before = await advanceClear(CT117E_M4_CLEAR_START_PS);
      const after = await advanceClear(CT117E_M4_CLEAR_END_PS);
      const clear = lcdWorkDelta(before.actual, after.actual);
      expect(clear).toEqual(CT117E_M4_EXPECTED.clear);
      expect(clear).toEqual({
        wrChanges: after.wrChanges - before.wrChanges,
        gramStores: after.gramStores - before.gramStores,
        frames: after.frames - before.frames,
      });

      await actual.advanceTo(CT117E_M4_END_TIME_PS);
      oracle.advanceTo(CT117E_M4_END_TIME_PS);

      expect(actual.runtime.getState()).toEqual({
        status: 'paused',
        simTime: CT117E_M4_END_TIME_PS,
      });
      expect(oracle.board.time).toBe(CT117E_M4_END_TIME_PS);
      expect(oracle.board.status).toBe('ready');
      expect(actual.diagnostics).toEqual([]);
      expect(actual.errors).toEqual([]);
      expect(actual.faults).toEqual([]);
      expect(oracle.errors).toEqual([]);
      expect(oracle.faults).toEqual([]);

      // 1. 固定工作量：漏掉 WR 边沿或 GRAM store 会直接改变这些数字。
      const workload = actual.workload();

      expect(workload.wrChanges).toBe(CT117E_M4_EXPECTED.final.wrChanges);
      expect(workload.gramStores).toBe(CT117E_M4_EXPECTED.final.gramStores);
      expect(workload.frames).toBe(CT117E_M4_EXPECTED.final.frames);
      expect(workload.nonZeroPixels).toBe(CT117E_M4_EXPECTED.final.nonZeroPixels);
      expect(workload.framePixels).toBeGreaterThan(0);

      // 2. 帧矩形合法，载荷长度与头部一致。
      expect(actual.frames).toHaveLength(CT117E_M4_EXPECTED.final.frames);
      expect(actual.frameTimes).toHaveLength(CT117E_M4_EXPECTED.final.frames);
      expectFrameLayout(actual.frames);
      for (let index = 1; index < actual.frameTimes.length; index += 1)
        expect(actual.frameTimes[index]!).toBeGreaterThan(actual.frameTimes[index - 1]!);

      // 3. 融合宿主事件与分立 oracle 的模型输出和发布载荷逐字节相同。
      //    模型发送时刻必须精确一致；宿主事件标注的是接收该帧的步进终点。
      expect(sameFrames(actual.frames, oracle.frames)).toBe(true);
      expect(sameFrames(actual.frames, oracle.expectedFrames)).toBe(true);
      expect(actual.frameTimes).toEqual(oracle.frameTimes);
      expect(actual.deliveryTimes).toEqual(
        oracle.frameTimes.map(
          (time) => Math.ceil(time / CT117E_M4_TIME_QUANTUM_PS) * CT117E_M4_TIME_QUANTUM_PS,
        ),
      );

      // 4. 最终 GRAM / 寄存器文件与分立 ILI9325 模型逐字节相同。
      const gram = actual.memory('gram');

      expect(sameBytes(gram, oracle.lcd.memories.get('gram')!)).toBe(true);
      expect(sameBytes((await actual.framebuffer()).subarray(8), gram)).toBe(true);
      expect(sameBytes(actual.memory('regs'), oracle.lcd.memories.get('regs')!)).toBe(true);
      expect(actual.state('index')).toBe(oracle.lcd.states.get('index'));

      // 5. 独立总线 oracle 再核对一次：MCU intent 计数、像素写与最终图像。
      const accounting = oracle.readAccounting();

      expect(accounting).toBeDefined();

      expect(accounting!.wrLevelChanges).toBe(CT117E_M4_EXPECTED.final.wrChanges);
      expect(accounting!.pixelWrites).toBe(CT117E_M4_EXPECTED.final.gramStores);
      expect(accounting!.gramStores).toBe(CT117E_M4_EXPECTED.final.gramStores);
      expect(accounting!.oracleGramStores).toBe(CT117E_M4_EXPECTED.final.gramStores);
      expect(accounting!.wrSamples).toBe(accounting!.wrLevelChanges);
      expect(accounting!.csSamples).toBe(accounting!.csLevelChanges);
      expect(accounting!.rsSamples).toBe(accounting!.rsLevelChanges);
      expect(accounting!.oracleFrames).toHaveLength(CT117E_M4_EXPECTED.final.frames);
      expect(gramMatchesOracle(gram, accounting!.oracleGram)).toBe(true);
      expect(sameFrames(actual.frames, accounting!.oracleFrames)).toBe(true);
      expect(
        accounting!.fullScreenFills.filter(
          (fill) => fill.value === 0x001f && fill.pixels === 76_800 && fill.uniform,
        ).length,
      ).toBeGreaterThan(0);

      // 6. 核对 MCU 状态和内存；已完成的延迟读可以留下不同的地址暂存值。
      const idleRead =
        actual.state('deferRead') === false && oracle.mcu.states.get('deferRead') === false;
      for (const [name, value] of oracle.mcu.states) {
        if (name === 'deferReadAddress' && idleRead) continue;
        expect.soft(actual.state(name), `MCU state ${name}`).toEqual(value);
      }
      for (const name of ['code', 'sram', 'ccm', 'sys'] as const)
        expect
          .soft(digest(actual.memory(name)), `MCU memory ${name}`)
          .toBe(digest(oracle.mcu.memories.get(name)!));

      // Fused uses the legacy periph slot for FLASH_ACR; the full MCU stores it
      // in flashState and also models control bits beyond the firmware's latency setting.
      const legacyAcr = 0x700;
      const fusedPeriph = actual.memory('periph');
      const jointPeriph = oracle.mcu.memories.get('periph')!;
      const jointFlashState = oracle.mcu.memories.get('flashState')!;
      const view = (bytes: Uint8Array) =>
        new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect
        .soft(sameBytes(fusedPeriph.subarray(0, legacyAcr), jointPeriph.subarray(0, legacyAcr)))
        .toBe(true);
      expect
        .soft(sameBytes(fusedPeriph.subarray(legacyAcr + 4), jointPeriph.subarray(legacyAcr + 4)))
        .toBe(true);
      expect.soft(view(fusedPeriph).getUint32(legacyAcr, true), 'fused FLASH_ACR').toBe(3);
      expect
        .soft(view(jointFlashState).getUint32(0, true) & 0xf, 'joint FLASH_ACR latency')
        .toBe(3);
    } finally {
      await actual.dispose();
    }
  } finally {
    oracle.dispose();
  }
}, 900_000);
