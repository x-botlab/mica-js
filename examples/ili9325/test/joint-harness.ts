import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { Board } from '@mica-js/sdk';
import { compileDDL } from '@mica-js/sdk/ddl';
import type { DeviceIR } from '@mica-js/sdk/model';

/**
 * STM32G431RBT6 + ILI9325 联合板夹具。
 *
 * 固件 `HAL_06_LCD.bin` 从 `HAL_06_LCD.axf` 的 PT_LOAD 段导出，按 80 MHz 配置时钟。
 * 这里复用真实电气网络、适配器和话题发布，供正确性用例与性能基准共同使用。
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

/** 固件 `SystemClock_Config`：HSI16 → PLL M=2 / N=20 / R=2，SYSCLK = 80 MHz。 */
export const JOINT_CLOCK_FREQUENCY = 80_000_000;
/**
 * 固件 SysTick 每约 200 µs 到期。运行时单次 `runUntil` 不会自动消费同一调用内的多个
 * 轮询边界，因此长窗口必须用不超过该周期的步长推进，否则 `uwTick` 会明显少计。
 */
export const JOINT_TIME_QUANTUM_PS = 200_000_000;

interface Adapter {
  sync(batch: unknown): void;
  dispose(): void;
}

export interface JointInstance {
  readonly memories: Map<string, Uint8Array>;
  readonly states: Map<string, unknown>;
}

interface JointDevices {
  readonly mcuModel: DeviceIR;
  readonly lcdModel: DeviceIR;
  readonly mcuModule: { readonly default: (context: never) => Adapter };
  readonly lcdModule: { readonly default: (context: never) => Adapter };
}

export interface JointBoard {
  readonly board: Board;
  readonly frames: Uint8Array[];
  /** 与 `frames` 一一对应，记录每帧发布瞬间的 GRAM 快照。 */
  readonly frameGramSnapshots: Uint8Array[];
  readonly faults: number[];
  readonly errors: string[];
  readonly mcu: JointInstance;
  readonly lcd: JointInstance;
  /** 以能覆盖每个 SysTick 边界的步长推进到目标仿真时间。 */
  advanceTo(targetPs: number): void;
  dispose(): void;
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

let devicesPromise: Promise<JointDevices> | undefined;

function loadDevices(): Promise<JointDevices> {
  devicesPromise ??= (async () => {
    const [mcuModel, lcdModel, mcuModule, lcdModule] = await Promise.all([
      compileDDL(readFileSync(join(MCU_DIR, 'model.ddl'), 'utf8'), {
        uri: 'mica:devices/stm32g431rbt6/model.ddl',
      }),
      compileDDL(readFileSync(join(ILI_DIR, 'model.ddl'), 'utf8'), {
        uri: 'mica:devices/ili9325/model.ddl',
      }),
      import(pathToFileURL(join(MCU_DIR, 'index.ts')).href),
      import(pathToFileURL(join(ILI_DIR, 'index.ts')).href),
    ]);

    return {
      mcuModel,
      lcdModel,
      mcuModule: mcuModule as JointDevices['mcuModule'],
      lcdModule: lcdModule as JointDevices['lcdModule'],
    };
  })();

  return devicesPromise;
}

function instance(
  instances:
    | Map<string, JointInstance>
    | readonly (JointInstance & { readonly id?: string })[]
    | Record<string, JointInstance>
    | undefined,
  id: string,
): JointInstance | undefined {
  if (instances instanceof Map) return instances.get(id);
  if (Array.isArray(instances))
    return (instances as readonly (JointInstance & { readonly id?: string })[]).find(
      (entry) => entry.id === id,
    );
  return (instances as Record<string, JointInstance> | undefined)?.[id];
}

/** 创建一块全新的联合板；器件模型与适配器模块在进程内只加载一次。 */
export async function createJointBoard(): Promise<JointBoard> {
  const { mcuModel, lcdModel, mcuModule, lcdModule } = await loadDevices();
  const wrap = (module: { readonly default: (context: never) => Adapter }) => (context: never) => {
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
      pins: [...VSS_PINS.map((pin) => ({ instance: 'mcu', pin })), { instance: 'lcd', pin: 'VSS' }],
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
            clockFrequency: JOINT_CLOCK_FREQUENCY,
          },
        },
        { id: 'lcd', type: 'lcd', props: { refreshRate: 60 } },
      ],
      nets,
    } as never,
    // 默认走 throughput（直接后端）：这是运行时的主路径。
  );

  const instances = (
    board as unknown as {
      instances?:
        | Map<string, JointInstance>
        | readonly (JointInstance & { readonly id?: string })[]
        | Record<string, JointInstance>;
    }
  ).instances;
  const mcu = instance(instances, 'mcu');
  const lcd = instance(instances, 'lcd');

  if (mcu === undefined || lcd === undefined) {
    board.dispose();
    throw new Error('joint board: missing mcu or lcd instance');
  }

  const frames: Uint8Array[] = [];
  const frameGramSnapshots: Uint8Array[] = [];
  const faults: number[] = [];
  const errors: string[] = [];
  const subscription = board.topics.onDidReceive((message) => {
    if (message.topic === 'fault') faults.push(message.payload as number);
    else if (message.topic === 'framebuffer') {
      frames.push(message.payload as Uint8Array);
      frameGramSnapshots.push(new Uint8Array(lcd.memories.get('gram')!));
    }
  });
  const diagnostics = board.onDidError((error) => errors.push(`${error.code}: ${error.message}`));

  return {
    board,
    frames,
    frameGramSnapshots,
    faults,
    errors,
    mcu,
    lcd,
    advanceTo(targetPs) {
      while (board.time < targetPs && faults.length === 0 && errors.length === 0) {
        const previous = board.time;
        board.runUntil(Math.min(board.time + JOINT_TIME_QUANTUM_PS, targetPs));
        if (board.time === previous)
          throw new Error(`joint board: time did not advance at ${previous} ps`);
      }
    },
    dispose() {
      subscription.dispose();
      diagnostics.dispose();
      board.dispose();
    },
  };
}
