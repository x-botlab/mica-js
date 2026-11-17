import { createDeviceBuilder, createJitBlockBuilder, types } from '@mica-js/sdk/model';
import type { BlockIR, DeviceIR } from '@mica-js/sdk/model';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { Board } from '@mica-js/sdk';
import { adaptModelFactory } from '@mica-js/sdk/device';
import type { DeviceFactory } from '@mica-js/sdk/device';
import { activateMachine } from '../../../stm32g431rbt6-core/src/machine';
import type { Machine } from '../../../stm32g431rbt6-core/src/machine';
import {
  advanceI2c,
  i2cDrivers,
  i2cModule,
  i2cSyncPins,
  readI2c,
  writeI2c,
} from '../../../stm32g431rbt6-core/src/i2c';
import { I2C_CONFIGS } from '../../../stm32g431rbt6-core/src/i2c-layout';
import { compileDDL } from '@mica-js/sdk/ddl';
import { loadSourceDevice, resistorModel } from '../harness.ts';

/**
 * 无 CPU 的 I2C 专属 rig：一个自循环 JIT 块每轮推进 1 µs，然后按 `step` 状态执行
 * 一次软件动作（写 CR2/TXDR/ICR 或读 ISR/RXDR）。它不伪造从机，也不直接调用
 * AT24C02/MCP4017 的方法；所有位都经过 PB8/PB7 真实开漏引脚、外部上拉和从机模型。
 * PB6 另外配置为 AF4 + 上拉，用于负向回归：G431 的 PB6 没有 I2C1_SCL，不能被驱动。
 *
 * 这个 rig 用于中央 MCU 适配器并行改动期间独立验收 I2C 状态机；生产集成仍应使用
 * 中央 `PERIPHERALS` 注册后的固件端到端路径。
 */

const TICK = 1_000_000;
const config = I2C_CONFIGS[0]!;
const CR2 = 0x04;
const TXDR = 0x28;
const RXDR = 0x24;
const ICR = 0x1c;

type Body = Parameters<typeof advanceI2c>[0];

const has = (b: Body, value: ReturnType<typeof readI2c>, mask: number) =>
  b.notEqual(
    types.number,
    b.bitAnd(value, b.constant(types.number, mask)),
    b.constant(types.number, 0),
  );

const isr = (b: Body) => i2cModule.read(b, b.constant(types.number, 0x40005418), 4);
const writeReg = (b: Body, offset: number, size: number, value: number): void => {
  writeI2c(b, config, b.constant(types.number, offset), size, b.constant(types.number, value));
};
const setStep = (b: Body, step: number): void => {
  b.writeState('step', b.constant(types.number, step));
};
const fail = (b: Body): void => {
  b.writeState('failed', b.constant(types.number, 1));
};

function rigModel(): DeviceIR {
  const builder = createDeviceBuilder({ name: 'I2cRig' });

  builder.memory({ name: 'code', length: 0x100 });
  builder.memory({ name: 'i2c', length: 0x200 });
  builder.memory({ name: 'periph', length: 0x1000 });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  builder.state({ name: 'step', type: types.number, initial: 0 });
  builder.state({ name: 'failed', type: types.number, initial: 0 });
  builder.state({ name: 'nack', type: types.number, initial: 0 });
  builder.state({ name: 'result', type: types.number, initial: 0 });
  builder.state({ name: 'remaining', type: types.number, initial: 0 });
  builder.state({ name: 'fraction', type: types.number, initial: 0 });
  builder.state({ name: 'counter', type: types.number, initial: 0 });
  for (let index = 0; index <= 9; index += 1)
    builder.state({ name: `g${index}`, type: types.number, initial: 0 });
  for (const port of [0, 1, 2, 3, 4])
    for (const prefix of ['gpioModer', 'gpioOtyper', 'gpioPupdr', 'gpioAfr0', 'gpioAfr1', 'gpioOdr'])
      builder.state({ name: `${prefix}${port}`, type: types.number, initial: 0 });
  for (const [name, initial] of [
    ['gpioSync', 0],
    ['serviceMask', 0],
    ['periphActive', 0],
    ['periphDeadline2', 0],
    ['pendingPs', 0],
    ['tickPs', 1_000_000_000_000],
    ['systickLoad', 0],
    ['txMask', 0],
  ] as const)
    builder.state({ name, type: types.number, initial });
  for (let index = 1; index <= 5; index += 1) {
    builder.state({ name: `tx${index}Active`, type: types.number, initial: 0 });
    builder.state({ name: `tx${index}Remaining`, type: types.number, initial: 0 });
    builder.state({ name: `tx${index}Queue`, type: types.number, initial: 0 });
    builder.state({ name: `tx${index}Count`, type: types.number, initial: 0 });
    builder.state({ name: `tx${index}Period`, type: types.number, initial: 1 });
    builder.state({ name: `tx${index}Publish`, type: types.number, initial: -1 });
  }
  for (const name of ['gpioPowered', 'irqDirty', 'tickActive', 'systickOn'])
    builder.state({ name, type: types.bool, initial: false });
  for (const name of [
    'PB5',
    'PB6',
    'PB7',
    'PB8',
    'PB9',
    'PA14',
    'PA15',
    'PA8',
    'PA9',
    'PC4',
    'PC8',
    'PC9',
    'PC11',
    'PF0',
  ])
    builder.pin({ name, low: 0.8, high: 2.0 });
  builder.pin({ name: 'VDD1' });
  builder.pin({ name: 'VSS1' });

  return builder.finish();
}


function rigBlock(clockHz?: number): BlockIR {
  const builder = createJitBlockBuilder();

  builder.instruction({ pc: 0, nextPc: 0 }, (b) => {
    advanceI2c(b, b.constant(types.number, TICK));
    i2cSyncPins(b, config);
    const step = b.readState('step', types.number);
    const current = isr(b);

    // 0：GPIOB PB8=SCL/PB7=SDA AF4 开漏 + I2C1 100 kHz；PB6 也置 AF4，
    // 但它没有 I2C1_SCL，负向测试要求它始终保持高电平。
    b.if(b.equal(types.number, step, b.constant(types.number, 0)), (run) => {
      const s = run as Body;

      s.store32le('periph', s.constant(types.number, 0x58), s.constant(types.number, 1 << 21));
      if (clockHz !== undefined) {
        s.store32le('periph', s.constant(types.number, 0xa0), s.constant(types.number, 1));
        s.store32le('periph', s.constant(types.number, 0xac), s.constant(types.number, clockHz));
        s.store32le('periph', s.constant(types.number, 0xd0), s.constant(types.number, clockHz));
      }
      s.writeState('gpioModer1', s.constant(types.number, 0x2a000));
      s.writeState('gpioOtyper1', s.constant(types.number, 0x1c0));
      s.writeState('gpioPupdr1', s.constant(types.number, 0x1000));
      s.writeState('gpioAfr01', s.constant(types.number, 0x44000000));
      s.writeState('gpioAfr11', s.constant(types.number, 0x00000004));
      s.writeState('gpioOdr1', s.constant(types.number, 0));
      writeReg(s, 0x10, 4, 0x00304f4f);
      writeReg(s, 0x00, 4, 1);
      setStep(s, 1);
    });

    // EEPROM 字节写：地址 0，数据 0x5A。
    b.if(b.equal(types.number, step, b.constant(types.number, 1)), (run) => {
      writeReg(run as Body, CR2, 4, 0x020220a0);
      setStep(run as Body, 2);
    });
    b.if(b.equal(types.number, step, b.constant(types.number, 2)), (run) => {
      const s = run as Body;

      s.if(has(s, current, 0x02), (hit) => {
        const body = hit as Body;

        writeReg(body, TXDR, 1, 0x00);
        setStep(body, 3);
      });
    });
    b.if(b.equal(types.number, step, b.constant(types.number, 3)), (run) => {
      const s = run as Body;

      s.if(has(s, current, 0x02), (hit) => {
        const body = hit as Body;

        writeReg(body, TXDR, 1, 0x5a);
        setStep(body, 4);
      });
    });
    b.if(b.equal(types.number, step, b.constant(types.number, 4)), (run) => {
      const s = run as Body;

      s.if(has(s, current, 0x20), (hit) => {
        const body = hit as Body;

        writeReg(body, ICR, 4, 0x20);
        setStep(body, 5);
      });
    });

    // 随机读：dummy write 地址 0 → TC → 重复 START 读 1 字节。
    b.if(b.equal(types.number, step, b.constant(types.number, 5)), (run) => {
      writeReg(run as Body, CR2, 4, 0x000120a0);
      setStep(run as Body, 6);
    });
    b.if(b.equal(types.number, step, b.constant(types.number, 6)), (run) => {
      const s = run as Body;

      s.if(has(s, current, 0x02), (hit) => {
        const body = hit as Body;

        writeReg(body, TXDR, 1, 0x00);
        setStep(body, 7);
      });
    });
    b.if(b.equal(types.number, step, b.constant(types.number, 7)), (run) => {
      const s = run as Body;

      s.if(has(s, current, 0x40), (hit) => {
        setStep(hit as Body, 8);
      });
    });
    b.if(b.equal(types.number, step, b.constant(types.number, 8)), (run) => {
      writeReg(run as Body, CR2, 4, 0x020124a0);
      setStep(run as Body, 9);
    });
    b.if(b.equal(types.number, step, b.constant(types.number, 9)), (run) => {
      const s = run as Body;

      s.if(has(s, current, 0x04), (hit) => {
        const body = hit as Body;
        const value = readI2c(body, config, body.constant(types.number, RXDR), 4);
        const ok = body.equal(
          types.number,
          body.bitAnd(value, body.constant(types.number, 0xff)),
          body.constant(types.number, 0x5a),
        );

        body.if(ok, (yes) => setStep(yes as Body, 10), (no) => fail(no as Body));
        setStep(body, 10);
      });
    });
    b.if(b.equal(types.number, step, b.constant(types.number, 10)), (run) => {
      const s = run as Body;

      s.if(has(s, current, 0x20), (hit) => {
        const body = hit as Body;

        writeReg(body, ICR, 4, 0x20);
        setStep(body, 11);
      });
    });

    // MCP4017 写 wiper 0x60。
    b.if(b.equal(types.number, step, b.constant(types.number, 11)), (run) => {
      writeReg(run as Body, CR2, 4, 0x0201205e);
      setStep(run as Body, 12);
    });
    b.if(b.equal(types.number, step, b.constant(types.number, 12)), (run) => {
      const s = run as Body;

      s.if(has(s, current, 0x02), (hit) => {
        const body = hit as Body;

        writeReg(body, TXDR, 1, 0x60);
        setStep(body, 13);
      });
    });
    b.if(b.equal(types.number, step, b.constant(types.number, 13)), (run) => {
      const s = run as Body;

      s.if(has(s, current, 0x20), (hit) => {
        const body = hit as Body;

        writeReg(body, ICR, 4, 0x20);
        setStep(body, 14);
      });
    });

    // MCP4017 读 wiper。
    b.if(b.equal(types.number, step, b.constant(types.number, 14)), (run) => {
      writeReg(run as Body, CR2, 4, 0x0201245e);
      setStep(run as Body, 15);
    });
    b.if(b.equal(types.number, step, b.constant(types.number, 15)), (run) => {
      const s = run as Body;

      s.if(has(s, current, 0x04), (hit) => {
        const body = hit as Body;
        const value = readI2c(body, config, body.constant(types.number, RXDR), 4);
        const ok = body.equal(
          types.number,
          body.bitAnd(value, body.constant(types.number, 0xff)),
          body.constant(types.number, 0x60),
        );

        body.if(ok, (yes) => setStep(yes as Body, 16), (no) => fail(no as Body));
        setStep(body, 16);
      });
    });
    b.if(b.equal(types.number, step, b.constant(types.number, 16)), (run) => {
      const s = run as Body;

      s.if(has(s, current, 0x20), (hit) => {
        const body = hit as Body;

        writeReg(body, ICR, 4, 0x20);
        setStep(body, 17);
      });
    });
    b.if(b.equal(types.number, step, b.constant(types.number, 17)), (run) => {
      (run as Body).stop();
    });

    b.writeState('pc', b.constant(types.number, 0));
    b.elapse(b.constant(types.number, TICK));
  });

  return builder.finish();
}

function registerBlock(): BlockIR {
  const builder = createJitBlockBuilder();

  builder.instruction({ pc: 0, nextPc: 0 }, (b) => {
    writeReg(b, 0x00, 1, 1);          // CR1.PE via byte
    writeReg(b, 0x10, 2, 0x4f4f);     // TIMINGR low half: SCLL=0x4F, SCLH=0x4F
    writeReg(b, 0x12, 2, 0x0030);     // TIMINGR high half: SCLDEL=3
    writeReg(b, 0x08, 4, 0x12345678); // OAR1 word
    writeReg(b, 0x0c, 2, 0xabcd);     // OAR2 half
    writeReg(b, 0x18, 4, 0xffffffff); // ISR is read-only: must stay 0 in memory
    b.writeState(
      'result',
      readI2c(b, config, b.constant(types.number, TXDR), 1),
    );
    b.stop();
  });

  return builder.finish();
}

function timeSplitBlock(): BlockIR {
  const builder = createJitBlockBuilder();

  builder.instruction({ pc: 0, nextPc: 0 }, (b) => {
    const step = b.readState('step', types.number);

    b.if(b.equal(types.number, step, b.constant(types.number, 0)), (run) => {
      const s = run as Body;

      s.store32le('i2c', s.constant(types.number, 0x40), s.constant(types.number, 1));
      s.store32le('i2c', s.constant(types.number, 0x44), s.constant(types.number, 4096));
      s.store32le('i2c', s.constant(types.number, 0x48), s.constant(types.number, 0));
      setStep(s, 1);
    });
    b.if(b.equal(types.number, step, b.constant(types.number, 1)), (run) => {
      const s = run as Body;
      const counter = s.add(s.readState('counter', types.number), s.constant(types.number, 1));

      advanceI2c(s, s.constant(types.number, 100_000_000));
      s.writeState('counter', counter);
      s.if(s.greaterThanOrEqual(counter, s.constant(types.number, 50)), (done) => {
        const body = done as Body;

        body.writeState('remaining', body.load32le('i2c', body.constant(types.number, 0x44)));
        body.writeState('fraction', body.load32le('i2c', body.constant(types.number, 0x48)));
        setStep(body, 2);
      });
    });
    b.if(b.equal(types.number, step, b.constant(types.number, 2)), (run) => {
      (run as Body).stop();
    });
    b.writeState('pc', b.constant(types.number, 0));
    b.elapse(b.constant(types.number, TICK));
  });

  return builder.finish();
}

function nackBlock(): BlockIR {
  const builder = createJitBlockBuilder();

  builder.instruction({ pc: 0, nextPc: 0 }, (b) => {
    advanceI2c(b, b.constant(types.number, TICK));
    const step = b.readState('step', types.number);
    const current = isr(b);

    b.if(b.equal(types.number, step, b.constant(types.number, 0)), (run) => {
      const s = run as Body;

      s.store32le('periph', s.constant(types.number, 0x58), s.constant(types.number, 1 << 21));
      s.writeState('gpioModer1', s.constant(types.number, 0x2a000));
      s.writeState('gpioOtyper1', s.constant(types.number, 0x1c0));
      s.writeState('gpioPupdr1', s.constant(types.number, 0x1000));
      s.writeState('gpioAfr01', s.constant(types.number, 0x44000000));
      s.writeState('gpioAfr11', s.constant(types.number, 0x00000004));
      s.writeState('gpioOdr1', s.constant(types.number, 0));
      writeReg(s, 0x10, 4, 0x00304f4f);
      writeReg(s, 0x00, 4, 1);
      setStep(s, 1);
    });
    b.if(b.equal(types.number, step, b.constant(types.number, 1)), (run) => {
      writeReg(run as Body, CR2, 4, 0x020120fc);
      setStep(run as Body, 2);
    });
    b.if(b.equal(types.number, step, b.constant(types.number, 2)), (run) => {
      const s = run as Body;

      s.if(has(s, current, 0x10), (hit) => {
        const body = hit as Body;

        body.writeState('nack', body.constant(types.number, 1));
        writeReg(body, ICR, 4, 0x10);
        setStep(body, 3);
      });
    });
    b.if(b.equal(types.number, step, b.constant(types.number, 3)), (run) => {
      const s = run as Body;

      s.if(has(s, current, 0x20), (hit) => {
        const body = hit as Body;
        const status = isr(body);

        body.if(
          body.equal(
            types.number,
            body.bitAnd(status, body.constant(types.number, 0x10)),
            body.constant(types.number, 0),
          ),
          (cleared) => (cleared as Body).writeState('nack', (cleared as Body).constant(types.number, 2)),
        );
        writeReg(body, ICR, 4, 0x20);
        setStep(body, 4);
      });
    });
    b.if(b.equal(types.number, step, b.constant(types.number, 4)), (run) => {
      (run as Body).stop();
    });
    b.writeState('pc', b.constant(types.number, 0));
    b.elapse(b.constant(types.number, TICK));
  });

  return builder.finish();
}

function guardBlock(): BlockIR {
  const builder = createJitBlockBuilder();

  builder.instruction({ pc: 0, nextPc: 0 }, (b) => {
    b.store32le('periph', b.constant(types.number, 0x58), b.constant(types.number, 1 << 21));
    writeReg(b, 0x00, 4, 1);              // PE
    writeReg(b, 0x40, 4, 0);              // 0x40 是内部状态窗口，不能别名 CR1
    writeReg(b, 0x29, 1, 0xaa);           // TXDR 高 byte lane：无效
    writeReg(b, 0x28, 1, 0x5a);           // 有效 TXDR 低 byte
    writeReg(b, 0x20, 4, 0xdead);         // PECR 只读
    b.writeState('g6', b.load32le('i2c', b.constant(types.number, 0x58)));
    b.writeState('g7', b.load32le('i2c', b.constant(types.number, 0x50)));
    b.store32le('i2c', b.constant(types.number, 0x58), b.constant(types.number, 2));
    b.store32le('i2c', b.constant(types.number, 0x54), b.constant(types.number, 0x77));
    b.writeState('g0', readI2c(b, config, b.constant(types.number, 0x25), 1));
    b.writeState('g4', b.load32le('i2c', b.constant(types.number, 0x58)));
    b.writeState('g1', readI2c(b, config, b.constant(types.number, 0x24), 1));
    b.writeState('g5', b.load32le('i2c', b.constant(types.number, 0x58)));
    b.writeState('g2', readI2c(b, config, b.constant(types.number, 0x58), 4));
    b.writeState('g3', readI2c(b, config, b.constant(types.number, 0x40), 4));
    b.writeState('g8', b.load32le('i2c', b.constant(types.number, 0x20)));
    b.writeState('g9', b.load32le('i2c', b.constant(types.number, 0x00)));
    b.stop();
  });

  return builder.finish();
}

function timeBlock(): BlockIR {
  const builder = createJitBlockBuilder();

  builder.instruction({ pc: 0, nextPc: 0 }, (b) => {
    const step = b.readState('step', types.number);

    b.if(b.equal(types.number, step, b.constant(types.number, 0)), (run) => {
      const s = run as Body;

      // 直接摆放一个 4096 个 1 ms 周期的 START_SETUP 相位（4.096 s）。
      s.store32le('i2c', s.constant(types.number, 0x40), s.constant(types.number, 1));
      s.store32le('i2c', s.constant(types.number, 0x44), s.constant(types.number, 4096));
      s.store32le('i2c', s.constant(types.number, 0x48), s.constant(types.number, 0));
      setStep(s, 1);
    });
    b.if(b.equal(types.number, step, b.constant(types.number, 1)), (run) => {
      const s = run as Body;

      advanceI2c(s, s.constant(types.number, 5_000_000_000));
      s.writeState('remaining', s.load32le('i2c', s.constant(types.number, 0x44)));
      s.writeState('fraction', s.load32le('i2c', s.constant(types.number, 0x48)));
      setStep(s, 2);
    });
    b.if(b.equal(types.number, step, b.constant(types.number, 2)), (run) => {
      (run as Body).stop();
    });
    b.writeState('pc', b.constant(types.number, 0));
    b.elapse(b.constant(types.number, TICK));
  });

  return builder.finish();
}

interface RigResult {
  readonly board: Board;
  readonly faults: string[];
  readonly levels: {
    readonly scl: readonly number[];
    readonly sda: readonly number[];
    readonly pb6: readonly number[];
  };
  readonly times: {
    readonly scl: readonly number[];
    readonly sda: readonly number[];
    readonly pb6: readonly number[];
  };
  query(instance: string, method: string, params?: unknown): Promise<unknown>;
  state(name: string): unknown;
  memory(name: string): Uint8Array | undefined;
  run(ps: number): void;
  dispose(): void;
}

const PROBE_MODEL = compileDDL(`
device I2cRigProbe {
  pin p(low: 0.8, high: 2.0);
  output channel level: number(capacity: 512, overflow: Overflow.drop_oldest);
  pure fn code(sampled: Logic) -> number {
    if sampled == Logic.high { return 1; }
    if sampled == Logic.low { return 0; }
    return 2;
  }
  process start { level.send(code(p.sample.level)); }
  process changed on p.sample.level { level.send(code(p.sample.level)); }
}
`);

export async function createRig(
  options: {
    readonly nack?: boolean;
    readonly registers?: boolean;
    readonly time?: boolean;
    readonly guards?: boolean;
    readonly timeSplit?: boolean;
    readonly clockFrequency?: number;
    readonly clockHz?: number;
  } = {},
): Promise<RigResult> {
  const [eeprom, pot, pullModel, probeModel] = await Promise.all([
    loadSourceDevice('at24c02'),
    loadSourceDevice('mcp4017'),
    resistorModel(10_000),
    PROBE_MODEL,
  ]);
  const levels = { scl: [] as number[], sda: [] as number[], pb6: [] as number[] };
  const times = { scl: [] as number[], sda: [] as number[], pb6: [] as number[] };
  const captured = new Map<string, { methods: Record<string, (params: never) => unknown> }>();
  let block: BlockIR | undefined;
  const machine: Machine = {
    clockFrequency: options.clockFrequency ?? 16_000_000,
    cyclePs: Math.max(1, Math.round(1_000_000_000_000 / (options.clockFrequency ?? 16_000_000))),
    alternateDrivers: i2cDrivers(),
    peripherals: [i2cModule],
    interruptSources: [],
    profile: 'rig',
  };
  const translate = (): BlockIR => {
    block ??= activateMachine(machine, () => {
      if (options.guards === true) return guardBlock();
      if (options.timeSplit === true) return timeSplitBlock();
      if (options.time === true) return timeBlock();
      if (options.registers === true) return registerBlock();
      if (options.nack === true) return nackBlock();
      return rigBlock(options.clockHz);
    });

    return block;
  };
  const capture =
    (id: string, factory: DeviceFactory): DeviceFactory =>
    (context: Parameters<DeviceFactory>[0]) => {
      const adapter = factory(context) as ReturnType<DeviceFactory> & {
        readonly methods?: Record<string, (params: never) => unknown>;
      };

      captured.set(id, { methods: adapter.methods ?? {} });

      return adapter;
    };
  const idle = () => ({ sync() {}, dispose() {} });
  const rigCreate = (context: {
    attachJit(options: {
      entry: string;
      code: string;
      pc: string;
      translate: () => BlockIR;
    }): { dispose(): void };
    loadBytes(memory: string, bytes: Uint8Array, offset?: number): void;
  }) => {
    context.attachJit({ entry: 'i2c', code: 'code', pc: 'pc', translate });
    context.loadBytes('code', new Uint8Array(0x100));

    return { sync() {}, dispose() {} };
  };
  const entries = [
    { id: 'rig', model: rigModel(), create: rigCreate as never },
    {
      id: 'eeprom',
      model: eeprom.model,
      create: capture(
        'eeprom',
        adaptModelFactory(eeprom.create as never, {}) as unknown as DeviceFactory,
      ),
    },
    {
      id: 'pot',
      model: pot.model,
      create: capture(
        'pot',
        adaptModelFactory(pot.create as never, {}) as unknown as DeviceFactory,
      ),
    },
    {
      id: 'sclProbe',
      model: probeModel,
      create: (() => ({
        sync(batch: {
          readonly to: number;
          readonly outputs: Readonly<Record<string, readonly { readonly value: unknown }[]>>;
        }) {
          for (const message of batch.outputs.level ?? []) {
            levels.scl.push(message.value as number);
            times.scl.push(batch.to);
          }
        },
        dispose() {},
      })) as unknown as DeviceFactory,
    },
    {
      id: 'sdaProbe',
      model: probeModel,
      create: (() => ({
        sync(batch: {
          readonly to: number;
          readonly outputs: Readonly<Record<string, readonly { readonly value: unknown }[]>>;
        }) {
          for (const message of batch.outputs.level ?? []) {
            levels.sda.push(message.value as number);
            times.sda.push(batch.to);
          }
        },
        dispose() {},
      })) as unknown as DeviceFactory,
    },
    {
      id: 'pb6Probe',
      model: probeModel,
      create: (() => ({
        sync(batch: {
          readonly to: number;
          readonly outputs: Readonly<Record<string, readonly { readonly value: unknown }[]>>;
        }) {
          for (const message of batch.outputs.level ?? []) {
            levels.pb6.push(message.value as number);
            times.pb6.push(batch.to);
          }
        },
        dispose() {},
      })) as unknown as DeviceFactory,
    },
    { id: 'pullScl', model: pullModel, create: idle as unknown as DeviceFactory },
    { id: 'pullSda', model: pullModel, create: idle as unknown as DeviceFactory },
  ];
  const board = createBoard(createDeviceLibrary(entries as never), {
    instances: [
      { id: 'rig', type: 'rig' },
      { id: 'eeprom', type: 'eeprom' },
      { id: 'pot', type: 'pot' },
      { id: 'sclProbe', type: 'sclProbe' },
      { id: 'sdaProbe', type: 'sdaProbe' },
      { id: 'pb6Probe', type: 'pb6Probe' },
      { id: 'pullScl', type: 'pullScl' },
      { id: 'pullSda', type: 'pullSda' },
    ],
    nets: [
      {
        id: 'vdd',
        pins: [
          { instance: 'rig', pin: 'VDD1' },
          { instance: 'eeprom', pin: 'vcc' },
          { instance: 'pot', pin: 'vdd' },
          { instance: 'pullScl', pin: 'b' },
          { instance: 'pullSda', pin: 'b' },
        ],
        voltage: 3.3,
      },
      {
        id: 'vss',
        pins: [
          { instance: 'rig', pin: 'VSS1' },
          { instance: 'eeprom', pin: 'gnd' },
          { instance: 'eeprom', pin: 'a0' },
          { instance: 'eeprom', pin: 'a1' },
          { instance: 'eeprom', pin: 'a2' },
          { instance: 'eeprom', pin: 'wp' },
          { instance: 'pot', pin: 'vss' },
          { instance: 'pot', pin: 'b' },
        ],
        voltage: 0,
      },
      {
        id: 'scl',
        pins: [
          { instance: 'rig', pin: 'PB8' },
          { instance: 'eeprom', pin: 'scl' },
          { instance: 'pot', pin: 'scl' },
          { instance: 'pullScl', pin: 'a' },
          { instance: 'sclProbe', pin: 'p' },
        ],
      },
      {
        id: 'sda',
        pins: [
          { instance: 'rig', pin: 'PB7' },
          { instance: 'eeprom', pin: 'sda' },
          { instance: 'pot', pin: 'sda' },
          { instance: 'pullSda', pin: 'a' },
          { instance: 'sdaProbe', pin: 'p' },
        ],
      },
      {
        id: 'pb6',
        pins: [
          { instance: 'rig', pin: 'PB6' },
          { instance: 'pb6Probe', pin: 'p' },
        ],
      },
    ],
  } as never);
  const faults: string[] = [];
  const errors = board.onDidError((error) => faults.push(error.message));
  const rigInstance = (
    board as unknown as {
      readonly instances?: readonly {
        readonly states?: ReadonlyMap<string, unknown>;
        readonly memories?: ReadonlyMap<string, Uint8Array>;
      }[];
    }
  ).instances?.[0];

  return {
    board,
    faults,
    levels,
    times,
    state: (name) => rigInstance?.states?.get(name),
    memory: (name) => rigInstance?.memories?.get(name),
    run: (ps) => board.runUntil(board.time + ps),
    async query(instance, method, params = null) {
      const target = captured.get(instance)?.methods[method];

      if (target === undefined) throw new Error(`unknown method ${instance}.${method}`);

      return await target(params as never);
    },
    dispose: () => {
      errors.dispose();
      board.dispose();
    },
  };
}
