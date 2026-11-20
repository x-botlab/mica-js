import { describe, expect, it } from 'vitest';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { createDeviceBuilder, types, validateDeviceIR } from '@mica-js/sdk/model';
import {
  DUMP_RESULT,
  PUSH_PULL_OUTPUTS,
  PUSH_PULL_P2,
  type DeviceAdapter,
  adapt,
  loadDevice,
  readMetadata,
  run,
} from './harness.ts';

/**
 * IAP15F2K61S2 器件包的行为基线。
 *
 * 每个用例都把 `dist/` 里的真实器件实现装进 `@mica-js/simulator` 板：固件经 `firmware` 属性在
 * 创建期装载，口线电平由独立探针采样，LED 亮度由理想 LED 端口读回。内核、JIT 与电气求解都不被 mock。
 *
 * 时序基线：`clockFrequency` 决定每条指令的虚拟时间，指令时钟数来自 `kernel/cycles.ts`
 * （手册 5.2 的 STC15 1T 列）。闪烁用例的周期因此由固件的时钟总数直接算出，而不是写死。
 */

const GPIO_PINS = Array.from({ length: 5 }, (_, port) =>
  Array.from({ length: 8 }, (_, bit) => `P${port}_${bit}`),
).flat();

/** P1 的推挽/模式寄存器：P1M1=91H、P1M0=92H。 */
const P1_PUSH_PULL = [
  0x75,
  0x92,
  0x02, // MOV P1M0,#02H  → P1.1 推挽
  0x75,
  0x91,
  0x00, // MOV P1M1,#00H
];
const P1_OPEN_DRAIN = [
  0x75,
  0x92,
  0x02, // MOV P1M0,#02H
  0x75,
  0x91,
  0x02, // MOV P1M1,#02H  → P1.1 开漏
];
const P1_INPUT_ONLY = [
  0x75,
  0x92,
  0x00, // MOV P1M0,#00H
  0x75,
  0x91,
  0x02, // MOV P1M1,#02H  → P1.1 仅输入
];

const HALT = [0x80, 0xfe]; // SJMP $

/** 只观察 P2 时用的最短前缀。 */
const P2 = PUSH_PULL_P2;

describe('器件声明与产物', () => {
  it('声明 40 根 GPIO、两根供电引脚，模型公开串口收发事件', async () => {
    const metadata = readMetadata('iap15f2k61s2');
    const module = await loadDevice('iap15f2k61s2');

    expect(metadata.publisher).toBe('example');
    expect(metadata.name).toBe('iap15f2k61s2');
    expect(Object.keys(metadata.pins ?? {})).toEqual([...GPIO_PINS, 'VCC', 'GND']);
    expect(Object.keys(metadata.model?.events ?? {}).sort()).toEqual([
      'onDidUart1Rx',
      'onDidUart1Tx',
    ]);
    expect(Object.keys(metadata.model?.methods ?? {}).sort()).toEqual([
      'getSerialStatus',
      'readSerial',
    ]);
    expect(Object.keys(module).sort()).toEqual(['create', 'model']);

    const pins = module.model.declarations.filter((declaration) => declaration.kind === 'pin');

    expect(pins.map((pin) => pin.name)).toEqual([...GPIO_PINS, 'VCC', 'GND']);
  });

  it('清单引脚与模型 IR 完全一致，DDL 不再声明复合固件属性', async () => {
    const metadata = readMetadata('iap15f2k61s2');
    const module = await loadDevice('iap15f2k61s2');
    const pins = module.model.declarations
      .filter((declaration) => declaration.kind === 'pin')
      .map((declaration) => declaration.name)
      .sort();

    expect(Object.keys(metadata.pins ?? {}).sort()).toEqual(pins);
    expect(
      module.model.declarations.some(
        (declaration) => declaration.kind === 'property' && declaration.name === 'firmware',
      ),
    ).toBe(false);
  });
});

describe('固件装载与取指', () => {
  it('二进制映像在创建期装载后从 0000H 取指', async () => {
    const result = await run({
      firmware: Uint8Array.from([...P2, 0x75, 0xa0, 0x55, ...HALT]),
    });

    expect(result.faults).toEqual([]);
    expect(result.p2).toBe(0x55);
  });

  it('复位向量处的 LJMP 生效：0000H 跳到 0030H', async () => {
    const image = new Array<number>(0x30).fill(0);

    image[0] = 0x02; // LJMP 0030H
    image[1] = 0x00;
    image[2] = 0x30;
    [...P2, 0x75, 0xa0, 0xa5, ...HALT].forEach((value, index) => {
      image[0x30 + index] = value;
    });

    const result = await run({ firmware: Uint8Array.from(image) });

    expect(result.p2).toBe(0xa5);
  });

  it('空固件空转：不装载也能推进时间且不报错', async () => {
    // 空固件是一片 NOP：位移多少就翻译多少个块，这里只验证「能推进、不报错」。
    const skipped = await run({ milliseconds: 0.2 });
    const empty = await run({ firmware: new Uint8Array(), milliseconds: 0.2 });

    for (const result of [skipped, empty]) {
      expect(result.faults).toEqual([]);
      // 复位后 P2 是准双向 weak-high；空固件不写锁存，探针应看到 0xFF，而不是 unknown→0。
      expect(result.p2).toBe(0xff);
    }
  });
});

describe('GPIO 四模式', () => {
  it('准双向：锁存 1 释放（上拉读到高）', async () => {
    const result = await run({
      firmware: Uint8Array.from([0x75, 0x90, 0x02, ...HALT]),
      pullUpOhm: 10_000,
    });

    expect(result.signal).toBe(1);
  });

  it('准双向：锁存 0 强下拉', async () => {
    const result = await run({
      firmware: Uint8Array.from([0x75, 0x90, 0x00, ...HALT]),
      pullUpOhm: 10_000,
    });

    expect(result.signal).toBe(0);
  });

  it('推挽：按锁存位输出高低电平', async () => {
    const high = await run({
      firmware: Uint8Array.from([...P1_PUSH_PULL, 0x75, 0x90, 0x02, ...HALT]),
      pullUpOhm: 10_000,
    });
    const low = await run({
      firmware: Uint8Array.from([...P1_PUSH_PULL, 0x75, 0x90, 0x00, ...HALT]),
      pullUpOhm: 10_000,
    });

    expect(high.signal).toBe(1);
    expect(low.signal).toBe(0);
  });

  it('仅输入：锁存 0 也释放', async () => {
    const result = await run({
      firmware: Uint8Array.from([...P1_INPUT_ONLY, 0x75, 0x90, 0x00, ...HALT]),
      pullUpOhm: 10_000,
    });

    expect(result.signal).toBe(1);
  });

  it('开漏：锁存 1 释放、锁存 0 下拉', async () => {
    const released = await run({
      firmware: Uint8Array.from([...P1_OPEN_DRAIN, 0x75, 0x90, 0x02, ...HALT]),
      pullUpOhm: 10_000,
    });
    const pulled = await run({
      firmware: Uint8Array.from([...P1_OPEN_DRAIN, 0x75, 0x90, 0x00, ...HALT]),
      pullUpOhm: 10_000,
    });

    expect(released.signal).toBe(1);
    expect(pulled.signal).toBe(0);
  });

  it('复位时 P0–P4 锁存为 1，P3/P4 无外部上拉时第一条读口即为高', async () => {
    // 不使用 `pullUpOhm`：读口之前也没有 MOV Px,#FFH，确保验证的是复位期引脚意图。
    const p3 = await run({
      firmware: Uint8Array.from([0xe5, 0xb0, 0xf5, 0xa0, ...HALT]), // MOV A,P3; MOV P2,A
      observeP3: true,
    });
    const p4 = await run({
      firmware: Uint8Array.from([0xe5, 0xc0, 0xf5, 0xa0, ...HALT]), // MOV A,P4; MOV P2,A
    });

    expect(p3.p3).toBe(0xff);
    expect(p3.p2).toBe(0xff);
    expect(p4.p2).toBe(0xff);
  });

  it('复位弱上拉可被外部 1 kΩ 强下拉覆盖，不需要先写端口', async () => {
    const result = await run({
      firmware: Uint8Array.from([0xe5, 0xb0, 0xf5, 0xa0, ...HALT]), // MOV A,P3; MOV P2,A
      observeP3: true,
      pullDown: { pin: 'P3_0', resistance: 1_000 },
    });

    expect(result.p3).toBe(0xfe);
    expect(result.p2).toBe(0xfe);
  });

  it('P4 读引脚、锁存 RMW 与外部 low 覆盖', async () => {
    const read = await run({
      firmware: Uint8Array.from([0xe5, 0xc0, 0xf5, 0xa0, ...HALT]), // MOV A,P4; MOV P2,A
    });
    const complement = await run({
      firmware: Uint8Array.from([0xb2, 0xc4, 0xe5, 0xc0, 0xf5, 0xa0, ...HALT]), // CPL P4.4; read
    });
    const pulled = await run({
      firmware: Uint8Array.from([
        0xc2,
        0xc2, // CLR P4.2（锁存 0）
        0xd2,
        0xc2, // SETB P4.2（锁存 1，但外部仍拉低）
        0xe5,
        0xc0, // MOV A,P4
        0xf5,
        0xa0,
        ...HALT,
      ]),
      pullDown: { pin: 'P4_2', resistance: 1_000 },
    });

    expect(read.p2).toBe(0xff);
    expect(complement.p2).toBe(0xef);
    expect(pulled.p2).toBe(0xfb);
  });

  it('P4M0/P4M1 模式位按真实地址生效：仅输入、开漏与推挽', async () => {
    const inputOnly = await run({
      firmware: Uint8Array.from([
        0x75,
        0xb3,
        0x04, // MOV P4M1,#04H → P4.2 仅输入
        0x75,
        0xb4,
        0x00, // MOV P4M0,#00H
        0x75,
        0xc0,
        0x00, // MOV P4,#00H：锁存 0 但仅输入模式释放
        0xe5,
        0xc0, // MOV A,P4
        0xf5,
        0xa0,
        ...HALT,
      ]),
      pullUp: { pin: 'P4_2', resistance: 10_000 },
    });
    const openReleased = await run({
      firmware: Uint8Array.from([
        0x75,
        0xb3,
        0x04, // MOV P4M1,#04H → P4.2 开漏
        0x75,
        0xb4,
        0x04, // MOV P4M0,#04H
        0x75,
        0xc0,
        0xff, // MOV P4,#FFH：锁存 1 释放
        0xe5,
        0xc0,
        0xf5,
        0xa0,
        ...HALT,
      ]),
      pullUp: { pin: 'P4_2', resistance: 10_000 },
    });
    const openPulled = await run({
      firmware: Uint8Array.from([
        0x75,
        0xb3,
        0x04, // MOV P4M1,#04H
        0x75,
        0xb4,
        0x04, // MOV P4M0,#04H
        0x75,
        0xc0,
        0x00, // MOV P4,#00H：开漏锁存 0 下拉
        0xe5,
        0xc0,
        0xf5,
        0xa0,
        ...HALT,
      ]),
      pullUp: { pin: 'P4_2', resistance: 10_000 },
    });
    const pushPullLow = await run({
      firmware: Uint8Array.from([
        0x75,
        0xb3,
        0x00, // MOV P4M1,#00H
        0x75,
        0xb4,
        0x04, // MOV P4M0,#04H → P4.2 推挽
        0x75,
        0xc0,
        0x00, // MOV P4,#00H
        0xe5,
        0xc0,
        0xf5,
        0xa0,
        ...HALT,
      ]),
    });
    const pushPullHigh = await run({
      firmware: Uint8Array.from([
        0x75,
        0xb3,
        0x00,
        0x75,
        0xb4,
        0x04,
        0x75,
        0xc0,
        0xff, // MOV P4,#FFH → 推挽高
        0xe5,
        0xc0,
        0xf5,
        0xa0,
        ...HALT,
      ]),
    });

    expect(inputOnly.p2).toBe(0x04);
    expect(openReleased.p2 & 0x04).toBe(0x04); // 开漏锁存 1 释放，外部上拉拉高 P4.2
    expect(openPulled.p2 & 0x04).toBe(0x00); // 开漏锁存 0 强下拉
    expect(pushPullLow.p2 & 0x04).toBe(0x00);
    expect(pushPullHigh.p2 & 0x04).toBe(0x04); // 推挽高
    expect(pushPullHigh.p2).toBe(0xff);
  });

  it('JBC 读锁存器：latch=1 且 P4.2 被外部强 low 拉低时仍 taken 并清 latch', async () => {
    // P2=AAH 表示第一次 JBC 读 latch 为 1（taken）且已清 latch（第二次不 taken）。
    // P2=55H 是 pin 读的未 taken 路径；P2=ABH 是读了 latch 但未清位的路径。
    const result = await run({
      firmware: Uint8Array.from([
        0x10,
        0xc2,
        0x05, // JBC P4.2,TAKEN (pc 0, target 8)
        0x75,
        0xa0,
        0x55, // MOV P2,#55H（pin 低，未 taken）
        0x80,
        0x0b, // SJMP END (target 19)
        0x10,
        0xc2,
        0x05, // TAKEN: JBC P4.2,STILL_SET (pc 8, target 16)
        0x75,
        0xa0,
        0xaa, // cleared: MOV P2,#0AAH
        0x80,
        0x03, // SJMP END (target 19)
        0x75,
        0xa0,
        0xab, // STILL_SET: MOV P2,#0ABH
        0x80,
        0xfe, // END: SJMP END
      ]),
      pullDown: { pin: 'P4_2', resistance: 1_000 },
    });

    expect(result.p2).toBe(0xaa);
  });

  it('XCH A,P4 取引脚值、写回锁存器', async () => {
    const source = await run({
      firmware: Uint8Array.from([
        0x74,
        0x00, // MOV A,#00H
        0xc5,
        0xc0, // XCH A,P4：源是引脚 0FBH，锁存写入 0
        0xf5,
        0xa0, // MOV P2,A
        ...HALT,
      ]),
      pullDown: { pin: 'P4_2', resistance: 1_000 },
    });
    const latchWrite = await run({
      firmware: Uint8Array.from([
        0x74,
        0x00, // MOV A,#00H
        0xc5,
        0xc0, // XCH A,P4：锁存 P4 变为 0
        0xe5,
        0xc0, // MOV A,P4：读回引脚 0
        0xf5,
        0xa0, // MOV P2,A
        ...HALT,
      ]),
      pullDown: { pin: 'P4_2', resistance: 1_000 },
    });

    expect(source.p2).toBe(0xfb);
    expect(latchWrite.p2).toBe(0x00);
  });
});

/**
 * 外部下拉对照：`run()` 夹具只提供上拉，这里搭一块最小板，把 `P1_1` 经 `resistance`
 * 接到地，再让固件读回该脚并由探针观察 `P2.0`。
 */
async function runWithPullDown(resistance: number): Promise<number> {
  const mcu = await loadDevice('iap15f2k61s2');
  const levels: number[] = [];
  const builder = createDeviceBuilder({ name: `PullDown${resistance}` });

  builder.pin({
    name: 'D',
    initial: (body) =>
      body.returnValue(body.resistor('A', body.constant(types.number, resistance))),
  });
  builder.pin({ name: 'A', initial: (body) => body.returnValue(body.combineIntents()) });
  builder.pin({ name: 'Y', low: 1.5, high: 3.5 });
  builder.channel({
    name: 'level',
    direction: 'output',
    type: types.number,
    capacity: 1,
    overflow: types.overflow.members.drop_oldest,
  });
  builder.start((body) => {
    body.loop((loop) => {
      loop.wait(50_000_000);

      const level = loop.field(loop.readSample('Y'), 'level');
      const high = loop.equal(
        types.logic,
        level,
        loop.constant(types.logic, types.logic.members.high),
      );

      loop.send(
        'level',
        loop.select(
          types.number,
          high,
          (inner) => inner.constant(types.number, 1),
          (inner) => inner.constant(types.number, 0),
        ),
      );
    });
  });

  const firmware = Uint8Array.from([
    0x75,
    0x96,
    0x01, // MOV P2M0,#01H → P2.0 推挽
    0x75,
    0x95,
    0x00, // MOV P2M1,#00H
    0x75,
    0x90,
    0xff, // MOV P1,#0FFH（准双向释放）
    0xa2,
    0x91, // MOV C,P1.1
    0x92,
    0xa0, // MOV P2.0,C
    ...HALT,
  ]);
  const library = createDeviceLibrary([
    { id: 'mcu', model: mcu.model, create: adapt(mcu, { firmware }) },
    {
      id: 'pulldown',
      model: validateDeviceIR(builder.finish()),
      create: (): DeviceAdapter => ({
        sync(batch) {
          const messages = batch.outputs.level ?? [];
          const latest = messages[messages.length - 1];

          if (latest !== undefined) levels.push(latest.value as number);
        },
        dispose() {},
      }),
    },
  ]);
  const board = createBoard(
    library,
    {
      instances: [
        {
          id: 'mcu',
          type: 'mcu',
          props: {
            clockFrequency: 1_000_000,
          },
        },
        { id: 'pulldown', type: 'pulldown' },
      ],
      nets: [
        { id: 'vcc', pins: [{ instance: 'mcu', pin: 'VCC' }], voltage: 5 },
        {
          id: 'gnd',
          pins: [
            { instance: 'mcu', pin: 'GND' },
            { instance: 'pulldown', pin: 'A' },
          ],
          voltage: 0,
        },
        {
          id: 'signal',
          pins: [
            { instance: 'mcu', pin: 'P1_1' },
            { instance: 'pulldown', pin: 'D' },
          ],
        },
        {
          id: 'p20',
          pins: [
            { instance: 'mcu', pin: 'P2_0' },
            { instance: 'pulldown', pin: 'Y' },
          ],
        },
      ],
    },
    { cpuQuantum: 1_000_000 },
  );

  try {
    board.runUntil(1_000_000_000);

    return levels[levels.length - 1] ?? -1;
  } finally {
    board.dispose();
  }
}

describe('口线读回', () => {
  it('MOV A,P1 读的是引脚电平', async () => {
    // P1 全推挽输出高 → 读回 0FFH；把低半字节送到 P2 观察到 0FH。
    const result = await run({
      firmware: Uint8Array.from([
        0x75,
        0x92,
        0xff, // MOV P1M0,#0FFH
        0x75,
        0x91,
        0x00, // MOV P1M1,#00H
        0x75,
        0x90,
        0xff, // MOV P1,#0FFH
        0xe5,
        0x90, // MOV A,P1
        0x54,
        0x0f, // ANL A,#0FH
        ...P2,
        0xf5,
        0xa0, // MOV P2,A
        ...HALT,
      ]),
    });

    expect(result.p2).toBe(0x0f);
  });

  it('准双向锁存 1 且外线浮空：内部 10 kΩ 弱上拉使引脚读回高（0FFH）', async () => {
    // 准双向锁存 1 不是高阻：器件在引脚上保留 10 kΩ 到 VCC 的弱上拉，
    // 没有外部负载时 P1.0–P1.7 都读到高。
    const result = await run({
      firmware: Uint8Array.from([
        0x75,
        0x90,
        0xff, // MOV P1,#0FFH（释放）
        0xe5,
        0x90, // MOV A,P1
        ...P2,
        0xf5,
        0xa0,
        ...HALT,
      ]),
    });

    expect(result.p2).toBe(0xff);
  });

  it('准双向锁存 1 但外线被 1 kΩ 下拉时读引脚得到 0', async () => {
    // 内部 10 kΩ 弱上拉与外部 1 kΩ 下拉分压约 0.45 V，低于 1.5 V 的低电平阈值。
    expect(await runWithPullDown(1_000)).toBe(0);
  });
});

describe('位操作', () => {
  it('SETB 位让准双向口释放，CPL 位按锁存器翻转', async () => {
    const setb = await run({
      firmware: Uint8Array.from([
        ...P1_PUSH_PULL,
        0x75,
        0x90,
        0x00, // 锁存 0 → 驱动低
        0xd2,
        0x91, // SETB P1.1 → 释放，上拉为高
        ...HALT,
      ]),
      pullUpOhm: 10_000,
    });

    const cpl = await run({
      firmware: Uint8Array.from([0xb2, 0x91, ...HALT]), // 复位锁存 1 → CPL 成 0 → 驱动低
      pullUpOhm: 10_000,
    });

    expect(setb.signal).toBe(1);
    expect(cpl.signal).toBe(0);
  });

  it('位地址 00H 落在 20H 单元，位 0–7 拼成一个字节', async () => {
    const result = await run({
      firmware: Uint8Array.from([
        0xd2,
        0x00, // SETB 20H.0
        0xd2,
        0x01,
        0xd2,
        0x02,
        0xd2,
        0x03,
        0xd2,
        0x04,
        0xd2,
        0x05,
        0xd2,
        0x06,
        0xd2,
        0x07,
        ...P2,
        0xe5,
        0x20, // MOV A,20H
        0xf5,
        0xa0,
        ...HALT,
      ]),
    });

    expect(result.p2).toBe(0xff);
  });

  it('JBC 置位时清位并跳转，JB 按引脚电平分支', async () => {
    const jbc = await run({
      firmware: Uint8Array.from([
        ...P2,
        0xd2,
        0x00, // SETB 20H.0
        0x10,
        0x00,
        0x02, // JBC 20H.0,+2
        0x75,
        0xa0,
        0xee, // 跳过：MOV P2,#0EEH
        0x75,
        0xa0,
        0x01, // MOV P2,#1
        ...HALT,
      ]),
    });

    const branch = await run({
      firmware: Uint8Array.from([
        ...P1_PUSH_PULL,
        0x75,
        0x90,
        0x02, // P1.1 推挽高
        0x20,
        0x91,
        0x02, // JB P1.1,+2
        0x74,
        0x00, // 跳过：MOV A,#0
        0x74,
        0x02, // MOV A,#2
        ...P2,
        0xf5,
        0xa0,
        ...HALT,
      ]),
    });

    expect(jbc.p2).toBe(0x01);
    expect(branch.p2).toBe(0x02);
  });
});

describe('调用、栈与循环', () => {
  it('LCALL/RET 回到顺序后继', async () => {
    const prefix = [...P2];
    const call = [0x12, 0x00, 0x00, 0xf5, 0xa0, ...HALT]; // LCALL <addr>; MOV P2,A; SJMP $
    const routineAt = prefix.length + call.length;

    call[1] = (routineAt >> 8) & 0xff;
    call[2] = routineAt & 0xff;

    const result = await run({
      firmware: Uint8Array.from([...prefix, ...call, 0x74, 0x42, 0x22]),
    });

    expect(result.p2).toBe(0x42);
  });

  it('PUSH/POP 用复位后的 SP=07H，显式 SP 同样可用', async () => {
    const defaultStack = await run({
      firmware: Uint8Array.from([
        ...P2,
        0x74,
        0x11,
        0xc0,
        0xe0, // PUSH ACC
        0x74,
        0x22,
        0xd0,
        0xe0, // POP ACC
        0xf5,
        0xa0,
        ...HALT,
      ]),
    });

    const explicitStack = await run({
      firmware: Uint8Array.from([
        ...P2,
        0x75,
        0x81,
        0x40, // MOV SP,#40H
        0x74,
        0x33,
        0xc0,
        0xe0,
        0xd0,
        0xe0,
        0xf5,
        0xa0,
        ...HALT,
      ]),
    });

    expect(defaultStack.p2).toBe(0x11);
    expect(explicitStack.p2).toBe(0x33);
  });

  it('DJNZ 循环与 CJNE 分支', async () => {
    const loop = await run({
      firmware: Uint8Array.from([
        ...P2,
        0x7f,
        0x05, // MOV R7,#5
        0x74,
        0x00, // MOV A,#0
        0x04, // INC A
        0xdf,
        0xfd, // DJNZ R7,-3
        0xf5,
        0xa0,
        ...HALT,
      ]),
    });

    const compare = await run({
      firmware: Uint8Array.from([
        ...P2,
        0x74,
        0x05, // MOV A,#5
        0xb4,
        0x03,
        0x02, // CJNE A,#3,+2
        0x74,
        0xee, // 跳过
        0xf5,
        0xa0, // MOV P2,A → 5
        ...HALT,
      ]),
    });

    expect(loop.p2).toBe(0x05);
    expect(compare.p2).toBe(0x05);
  });
});

describe('数据传送与运算', () => {
  it('MUL/DIV/DA', async () => {
    const multiply = await run({
      firmware: Uint8Array.from([
        ...P2,
        0x74,
        0x0c, // MOV A,#12
        0x75,
        0xf0,
        0x0a, // MOV B,#10
        0xa4, // MUL AB
        0xf5,
        0xa0,
        ...HALT,
      ]),
    });

    const divide = await run({
      firmware: Uint8Array.from([
        ...P2,
        0x74,
        0x0a, // MOV A,#10
        0x75,
        0xf0,
        0x03, // MOV B,#3
        0x84, // DIV AB
        0xf5,
        0xa0, // MOV P2,A → 商 3
        ...HALT,
      ]),
    });

    const decimal = await run({
      firmware: Uint8Array.from([
        ...P2,
        0x74,
        0x56,
        0x24,
        0x27, // ADD A,#27H → 7DH
        0xd4, // DA A → 83H
        0xf5,
        0xa0,
        ...HALT,
      ]),
    });

    expect(multiply.p2).toBe(0x78);
    expect(divide.p2).toBe(0x03);
    expect(decimal.p2).toBe(0x83);
  });

  it('MOVC 查表与 MOVX 往返', async () => {
    const prefix = [...P2];
    const tableAt = prefix.length + 3 + 2 + 1 + 2 + HALT.length; // DPTR(3) + MOV A(2) + MOVC(1) + MOV P2,A(2) + SJMP(2)

    const table = await run({
      firmware: Uint8Array.from([
        ...prefix,
        0x90,
        (tableAt >> 8) & 0xff,
        tableAt & 0xff, // MOV DPTR,#<table>
        0x74,
        0x02, // MOV A,#2
        0x93, // MOVC A,@A+DPTR
        0xf5,
        0xa0,
        ...HALT,
        0xaa,
        0xbb,
        0xcc,
      ]),
    });

    const xram = await run({
      firmware: Uint8Array.from([
        ...prefix,
        0x90,
        0x01,
        0x00, // MOV DPTR,#0100H
        0x74,
        0x5a,
        0xf0, // MOVX @DPTR,A
        0xe4, // CLR A
        0xe0, // MOVX A,@DPTR
        0xf5,
        0xa0,
        ...HALT,
      ]),
    });

    expect(table.p2).toBe(0xcc);
    expect(xram.p2).toBe(0x5a);
  });

  it('MOV direct,direct 按 85H src dst 的顺序传送', async () => {
    const result = await run({
      firmware: Uint8Array.from([
        ...P2,
        0x75,
        0x41,
        0x66, // MOV 41H,#66H
        0x85,
        0x41,
        0x40, // MOV 40H,41H
        0xe5,
        0x40,
        0xf5,
        0xa0,
        ...HALT,
      ]),
    });

    expect(result.p2).toBe(0x66);
  });

  it('SWAP/RLC 结果与 SUBB 的借位标志正确', async () => {
    const swap = await run({
      firmware: Uint8Array.from([...P2, 0x74, 0x5a, 0xc4, 0xf5, 0xa0, ...HALT]),
    });
    const rotate = await run({
      firmware: Uint8Array.from([...P2, 0x74, 0x5a, 0x33, 0xf5, 0xa0, ...HALT]),
    });
    const subtract = await run({
      firmware: Uint8Array.from([
        ...PUSH_PULL_OUTPUTS,
        0x74,
        0x00,
        0xc3,
        0x94,
        0x01,
        ...DUMP_RESULT,
      ]),
      observeP3: true,
    });

    expect(swap.p2).toBe(0xa5);
    expect(rotate.p2).toBe(0xb4);
    // 00H − 01H = FFH，借位与半借位都置位，P(0FFH) = 0：PSW = CY|AC = C0H
    expect(subtract.p2).toBe(0xff);
    expect(subtract.p3).toBe(0xc0);
  });
});

describe('ALU 与参考实现差分', () => {
  /** 参考模型：ADD/ADDC/ORL/ANL/XRL/SUBB 的结果与 PSW。 */
  function reference(
    opcode: number,
    a: number,
    source: number,
    carryIn: boolean,
  ): { readonly a: number; readonly psw: number } {
    const parity = (value: number): number => {
      let rest = value;
      let bit = 0;

      while (rest > 0) {
        bit ^= rest & 1;
        rest >>= 1;
      }

      return bit;
    };

    if (opcode === 0x24 || opcode === 0x34) {
      const carry = opcode === 0x34 && carryIn ? 1 : 0;
      const sum = a + source + carry;
      const result = sum & 0xff;
      const cy = sum > 0xff ? 0x80 : 0;
      const ac = (a & 0x0f) + (source & 0x0f) + carry > 0x0f ? 0x40 : 0;
      const ov = (a ^ result) & (source ^ result) & 0x80 ? 0x04 : 0;

      return { a: result, psw: cy | ac | ov | parity(result) };
    }

    if (opcode === 0x94) {
      const carry = carryIn ? 1 : 0;
      const subtrahend = source + carry;
      const result = (a - subtrahend) & 0xff;
      const cy = a < subtrahend ? 0x80 : 0;
      const ac = (a & 0x0f) < (source & 0x0f) + carry ? 0x40 : 0;
      const ov = (a ^ source) & (a ^ result) & 0x80 ? 0x04 : 0;

      return { a: result, psw: cy | ac | ov | parity(result) };
    }

    const result = opcode === 0x44 ? a | source : opcode === 0x54 ? a & source : a ^ source;

    return { a: result, psw: (carryIn ? 0x80 : 0) | parity(result) };
  }

  it('6 组运算 × 4 个累加器值 × 4 个操作数 × 进位，共 192 例与参考一致', async () => {
    const opcodes = [0x24, 0x34, 0x44, 0x54, 0x64, 0x94];
    const accumulators = [0x00, 0x7f, 0x80, 0xff];
    const operands = [0x01, 0x0f, 0x80, 0xff];
    const mismatches: string[] = [];
    let checked = 0;

    for (const opcode of opcodes) {
      for (const a of accumulators) {
        for (const source of operands) {
          for (const carryIn of [false, true]) {
            const expected = reference(opcode, a, source, carryIn);
            const result = await run({
              firmware: Uint8Array.from([
                ...PUSH_PULL_OUTPUTS,
                carryIn ? 0xd3 : 0xc3, // SETB C / CLR C
                0x74,
                a,
                opcode,
                source,
                ...DUMP_RESULT,
              ]),
              observeP3: true,
              // 固件只有二十几条指令，探针 50 µs 采一次即可覆盖到停机后的引脚电平。
              milliseconds: 0.2,
            });

            checked += 1;

            if (result.p2 !== expected.a || result.p3 !== expected.psw) {
              mismatches.push(
                `${opcode.toString(16)} A=${a.toString(16)} src=${source.toString(16)} cy=${carryIn ? 1 : 0} ` +
                  `→ A=${result.p2.toString(16)} PSW=${result.p3.toString(16)}，` +
                  `期望 A=${expected.a.toString(16)} PSW=${expected.psw.toString(16)}`,
              );
            }
          }
        }
      }
    }

    expect(checked).toBe(192);
    expect(mismatches).toEqual([]);
  }, 900_000);
});

describe('理想 LED 联动', () => {
  it('理想 LED 按数字化电平点亮：推挽高与准双向弱上拉为亮，推挽低与仅输入高阻为灭', async () => {
    const on = await run({
      firmware: Uint8Array.from([...P1_PUSH_PULL, 0x75, 0x90, 0x02, ...HALT]),
      led: true,
    });
    const off = await run({
      firmware: Uint8Array.from([...P1_PUSH_PULL, 0x75, 0x90, 0x00, ...HALT]),
      led: true,
    });
    const released = await run({
      firmware: Uint8Array.from([0x75, 0x90, 0x02, ...HALT]),
      led: true,
    });
    const floating = await run({
      firmware: Uint8Array.from([...P1_INPUT_ONLY, 0x75, 0x90, 0x02, ...HALT]),
      led: true,
    });

    expect(on.brightness).toBeCloseTo(1, 5);
    expect(off.brightness).toBeCloseTo(0, 5);
    // 准双向锁存 1 时内部 10 kΩ 弱上拉把阳极拉到数字化高，LED 因此点亮。
    expect(released.brightness).toBeCloseTo(1, 5);
    // 仅输入模式真正释放引脚；没有外接上拉时阳极悬空，不等同于 Logic.high。
    expect(floating.brightness).toBeCloseTo(0, 5);
  });

  it('stc15-led-blink 固件按 1 MHz 时钟约 16.6 ms 翻转一次', async () => {
    const image = new Array<number>(0x30).fill(0);

    image[0] = 0x02; // LJMP 0030H
    image[1] = 0x00;
    image[2] = 0x30;
    [
      0x75,
      0x91,
      0x00, // MOV P1M1,#00H
      0x75,
      0x92,
      0x02, // MOV P1M0,#02H
      0xb2,
      0x91, // LOOP: CPL P1.1
      0x7f,
      0xc8, // MOV R7,#200
      0x7e,
      0x28, // OUTER: MOV R6,#40
      0xde,
      0xfe, // INNER: DJNZ R6,INNER
      0xdf,
      0xfa, // DJNZ R7,OUTER
      0x80,
      0xf4, // SJMP LOOP
    ].forEach((value, index) => {
      image[0x30 + index] = value;
    });

    const trace: { time: number; brightness: number }[] = [];

    await run({
      firmware: Uint8Array.from(image),
      milliseconds: 120,
      clockFrequency: 1_000_000,
      trace,
      led: true,
    });

    const edges: number[] = [];

    for (let index = 1; index < trace.length; index += 1) {
      const previous = (trace[index - 1] as { brightness: number }).brightness > 0.5;
      const current = (trace[index] as { brightness: number }).brightness > 0.5;

      if (previous !== current) edges.push((trace[index] as { time: number }).time / 1e9);
    }

    expect(edges.length).toBeGreaterThanOrEqual(3);

    const periods = edges.slice(1).map((time, index) => time - (edges[index] as number));

    expect(periods.length).toBeGreaterThanOrEqual(2);

    // 周期 = (CPL bit 3 + MOV R7,#data 2) + 200 × (MOV R6,#data 2 + 40 × DJNZ Rn 4 +
    // DJNZ Rn 4) = 33205 个时钟；1 MHz 下 33.205 ms（时钟数见手册 5.2 的表）。
    const expectedMs = 33.205;

    // 亮度按 500 µs 采样、轨迹按 1 ms 记录，因此允许一个多记录间隔的偏差。
    for (const period of periods) expect(Math.abs(period - expectedMs)).toBeLessThanOrEqual(1.5);
  });
});
