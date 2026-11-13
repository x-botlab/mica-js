import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { compileDDL } from '@mica-js/sdk/ddl';
import type { DeviceIR } from '@mica-js/sdk/model';
import { describe, expect, it } from 'vitest';

/**
 * MCU + LCD 联合仿真：跑 `HAL_06_LCD` 的真实 Keil 固件。
 *
 * 固件 `test/fixtures/HAL_06_LCD.bin` 从 `HAL_06_LCD.axf` 的 PT_LOAD 段导出（10,804
 * 字节，初始 SP=0x20000418、复位向量=0x080001ED）。它按 80 MHz 配置时钟
 * （HSI16 → PLL M=2 / N=20 / R=2），因此 `clockFrequency` 必须是 80 MHz——否则
 * `HAL_Delay` 的 `uwTick` 换算对不上。
 *
 * 需要显式开启：`MICA_JOINT=1 pnpm exec vitest run test/joint.test.ts`。
 * 固件里累计有 4 秒以上的 `HAL_Delay`，完整跑完代价很高；用例只推进到足以证明
 * 「MCU 经真实 GPIO 把 BSP 初始化序列写进 LCD」为止。
 */

const ILI_DIR = join(import.meta.dirname, '..', 'src', 'devices', 'ili9325');
const MCU_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  'stm32g431rbt6',
  'src',
  'devices',
  'stm32g431rbt6',
);
const FIRMWARE = join(import.meta.dirname, 'fixtures', 'HAL_06_LCD.bin');

/** `SystemClock_Config`：HSI16 → PLL M=2 / N=20 / R=2，SYSCLK = 80 MHz。 */
const CLOCK_FREQUENCY = 80_000_000;
/**
 * 推进到 200 µs：此时 `REG_932X_Init` 已写完全部电源/时序寄存器并进入第一个
 * `HAL_Delay(200)`。再往前就要等 200 ms 的延时，代价远大于验证价值。
 */
const TARGET_PS = 200_000_000;
const SLICE_PS = 5_000_000;

interface Adapter {
  sync(batch: unknown): void;
  dispose(): void;
}

interface InstanceView {
  readonly memories: Map<string, Uint8Array>;
  readonly states: Map<string, unknown>;
}

const DATA_BITS = Array.from({ length: 16 }, (_, index) => index);
/** CT117E-M4 的 LCD 控制线接法（`lcd.c` 的 `LCD_CtrlLinesConfig`）。 */
const CONTROL_LINES: readonly (readonly [mcu: string, lcd: string])[] = [
  ['PB5', 'WR'],
  ['PB8', 'RS'],
  ['PB9', 'CS'],
  ['PA8', 'RD'],
];
const VDD_PINS = ['VDD1', 'VDD2', 'VDD3', 'VDD4', 'VDDA', 'VREFP', 'VBAT'];
const VSS_PINS = ['VSS1', 'VSS2', 'VSS3', 'VSS4', 'VSSA'];

describe.skipIf(!process.env.MICA_JOINT)('MCU + LCD 联合仿真', () => {
  it('HAL_06_LCD 固件经 GPIO 把 BSP 初始化序列写进 ILI9325', async () => {
    const [mcuModel, lcdModel, mcuModule, lcdModule] = (await Promise.all([
      compileDDL(readFileSync(join(MCU_DIR, 'model.ddl'), 'utf8'), {
        uri: 'mica:devices/stm32g431rbt6/model.ddl',
      }),
      compileDDL(readFileSync(join(ILI_DIR, 'model.ddl'), 'utf8'), {
        uri: 'mica:devices/ili9325/model.ddl',
      }),
      import(pathToFileURL(join(MCU_DIR, 'index.ts')).href),
      import(pathToFileURL(join(ILI_DIR, 'index.ts')).href),
    ])) as unknown as [
      DeviceIR,
      DeviceIR,
      { default: (context: never) => Adapter },
      { default: (context: never) => Adapter },
    ];

    const faults: number[] = [];
    const errors: string[] = [];
    const frames: Uint8Array[] = [];
    const wrap = (module: { default: (context: never) => Adapter }) => (context: never) => {
      const adapter = module.default(context);

      return { sync: (batch: unknown) => adapter.sync(batch), dispose: () => adapter.dispose() };
    };

    const nets = [
      {
        id: 'vdd',
        voltage: 3.3,
        pins: [
          ...VDD_PINS.map((pin) => ({ instance: 'mcu', pin })),
          { instance: 'lcd', pin: 'VDD' },
          // 参考程序不驱动 RST，板级把它接在 VDD 上。
          { instance: 'lcd', pin: 'RST' },
        ],
      },
      {
        id: 'vss',
        voltage: 0,
        pins: [
          ...VSS_PINS.map((pin) => ({ instance: 'mcu', pin })),
          { instance: 'lcd', pin: 'VSS' },
        ],
      },
      ...DATA_BITS.map((bit) => ({
        id: `d${bit}`,
        pins: [
          { instance: 'mcu', pin: `PC${bit}` },
          { instance: 'lcd', pin: `D${bit}` },
        ],
      })),
      ...CONTROL_LINES.map(([mcuPin, lcdPin]) => ({
        id: lcdPin.toLowerCase(),
        pins: [
          { instance: 'mcu', pin: mcuPin },
          { instance: 'lcd', pin: lcdPin },
        ],
      })),
    ];

    const board = createBoard(
      createDeviceLibrary([
        { id: 'mcu', model: mcuModel, create: wrap(mcuModule) as never },
        { id: 'lcd', model: lcdModel, create: wrap(lcdModule) as never },
      ] as never),
      {
        instances: [
          {
            id: 'mcu',
            type: 'mcu',
            props: {
              firmware: new Uint8Array(readFileSync(FIRMWARE)),
              clockFrequency: CLOCK_FREQUENCY,
            },
          },
          { id: 'lcd', type: 'lcd', props: { refreshRate: 60 } },
        ],
        nets,
      } as never,
      // 默认走 throughput（直接后端）：这是运行时的主路径。
    );

    const subscription = board.topics.onDidReceive((message) => {
      if (message.topic === 'fault') faults.push(message.payload as number);
      else if (message.topic === 'framebuffer') frames.push(message.payload as Uint8Array);
    });
    const diagnostics = board.onDidError((error) => errors.push(`${error.code}: ${error.message}`));

    try {
      board.runUntil(0);

      while (board.time < TARGET_PS && faults.length === 0)
        board.runUntil(Math.min(board.time + SLICE_PS, TARGET_PS));

      expect(errors).toEqual([]);
      expect(faults).toEqual([]);
      expect(board.status).toBe('ready');

      // 固件执行到了 LCD 驱动：读 LCD 实例的寄存器后备区。
      const internal = board as unknown as {
        instances?:
          Map<string, InstanceView> | readonly InstanceView[] | Record<string, InstanceView>;
      };
      const raw = internal.instances;
      const lcd =
        raw instanceof Map
          ? raw.get('lcd')
          : Array.isArray(raw)
            ? (raw as readonly (InstanceView & { id?: string })[]).find(
                (entry) => entry.id === 'lcd',
              )
            : (raw as Record<string, InstanceView> | undefined)?.['lcd'];

      expect(lcd).toBeDefined();

      const regs = lcd!.memories.get('regs')!;
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
      expect(lcd!.states.get('index')).toBe(0x13);

      // 还没写像素，因此不应有帧。
      expect(frames).toHaveLength(0);
    } finally {
      subscription.dispose();
      diagnostics.dispose();
      board.dispose();
    }
  });
});
