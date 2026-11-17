import { createDeviceBuilder, createJitBlockBuilder, types } from '@mica-js/sdk/model';
import type { BlockIR, DeviceIR } from '@mica-js/sdk/model';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { Board } from '@mica-js/sdk';
import { activateMachine } from '../../../stm32g431rbt6-core/src/machine';
import type { Machine } from '../../../stm32g431rbt6-core/src/machine';
import { advanceSpi, readSpi, spiDrivers, spiModule, spiRequestedTickPs, spiSyncPins, writeSpi } from '../../../stm32g431rbt6-core/src/spi';
import { SPI_CONFIGS } from '../../../stm32g431rbt6-core/src/spi-layout';

/**
 * SPI1 专属 rig：PA5 SCK、PA7 MOSI、PA6 MISO 在板级短接做真实全双工回环。
 * 每个 JIT 块推进一个半 SCK 周期；测试只通过 SPI 寄存器读写，不直接调用移位内部。
 */

const TICK = 1_000_000;
const config = SPI_CONFIGS[0]!;
const SR = 0x08;
const DR = 0x0c;

type Body = Parameters<typeof advanceSpi>[0];

function rigModel(): DeviceIR {
  const builder = createDeviceBuilder({ name: 'SpiRig' });

  builder.memory({ name: 'code', length: 0x100 });
  builder.memory({ name: 'spi', length: 0x200 });
  builder.memory({ name: 'periph', length: 0x1000 });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  builder.state({ name: 'step', type: types.number, initial: 0 });
  builder.state({ name: 'result', type: types.number, initial: 0 });
  builder.state({ name: 'fraction', type: types.number, initial: 0 });
  builder.state({ name: 'counter', type: types.number, initial: 0 });
  for (let index = 0; index <= 8; index += 1)
    builder.state({ name: `g${index}`, type: types.number, initial: 0 });
  for (const port of [0, 1, 2, 3, 4])
    for (const prefix of ['gpioModer', 'gpioOtyper', 'gpioPupdr', 'gpioAfr0', 'gpioAfr1', 'gpioOdr'])
      builder.state({ name: `${prefix}${port}`, type: types.number, initial: 0 });
  for (const [name, initial] of [
    ['gpioSync', 0],
    ['serviceMask', 0],
    ['periphActive', 0],
    ['periphDeadline3', 0],
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
    'PA5',
    'PA6',
    'PA7',
    'PB3',
    'PB4',
    'PB5',
    'PB13',
    'PB14',
    'PB15',
    'PF1',
    'PA10',
    'PA11',
    'PC10',
    'PC11',
    'PC12',
    'VDD1',
    'VSS1',
  ]) {
    if (name.startsWith('P')) builder.pin({ name, low: 0.8, high: 2.0 });
    else builder.pin({ name });
  }

  return builder.finish();
}

function rigBlock(cr1: number, cr2: number, data: number, size: number): BlockIR {
  const builder = createJitBlockBuilder();

  builder.instruction({ pc: 0, nextPc: 0 }, (b) => {
    advanceSpi(b, b.constant(types.number, TICK));
    spiSyncPins(b, config);
    const step = b.readState('step', types.number);

    b.if(b.equal(types.number, step, b.constant(types.number, 0)), (run) => {
      const s = run as Body;

      s.store32le('periph', s.constant(types.number, 0x60), s.constant(types.number, 1 << 12));
      s.writeState('gpioModer0', s.constant(types.number, 0x0000a800));
      s.writeState('gpioOtyper0', s.constant(types.number, 0));
      s.writeState('gpioPupdr0', s.constant(types.number, 0));
      s.writeState('gpioAfr00', s.constant(types.number, 0x55500000));
      writeSpi(s, config, s.constant(types.number, 0x00), 4, s.constant(types.number, cr1));
      writeSpi(s, config, s.constant(types.number, 0x04), 4, s.constant(types.number, cr2));
      writeSpi(s, config, s.constant(types.number, DR), size, s.constant(types.number, data));
      s.writeState('step', s.constant(types.number, 1));
    });

    b.if(b.equal(types.number, step, b.constant(types.number, 1)), (run) => {
      const s = run as Body;
      const status = readSpi(s, config, s.constant(types.number, SR), 4);

      s.if(
        s.notEqual(
          types.number,
          s.bitAnd(status, s.constant(types.number, 1)),
          s.constant(types.number, 0),
        ),
        (hit) => {
          const body = hit as Body;

          body.writeState(
            'result',
            readSpi(body, config, body.constant(types.number, DR), size),
          );
          body.writeState('step', body.constant(types.number, 2));
        },
      );
    });

    b.if(b.equal(types.number, step, b.constant(types.number, 2)), (run) => {
      (run as Body).stop();
    });

    b.writeState('pc', b.constant(types.number, 0));
    b.elapse(b.constant(types.number, TICK));
  });

  return builder.finish();
}

function ovrBlock(cr1: number, cr2: number, first: number, second: number, size: number): BlockIR {
  const builder = createJitBlockBuilder();

  builder.instruction({ pc: 0, nextPc: 0 }, (b) => {
    advanceSpi(b, b.constant(types.number, TICK));
    spiSyncPins(b, config);
    const step = b.readState('step', types.number);

    b.if(b.equal(types.number, step, b.constant(types.number, 0)), (run) => {
      const s = run as Body;

      s.store32le('periph', s.constant(types.number, 0x60), s.constant(types.number, 1 << 12));
      s.writeState('gpioModer0', s.constant(types.number, 0x0000a800));
      s.writeState('gpioOtyper0', s.constant(types.number, 0));
      s.writeState('gpioPupdr0', s.constant(types.number, 0));
      s.writeState('gpioAfr00', s.constant(types.number, 0x55500000));
      writeSpi(s, config, s.constant(types.number, 0x00), 4, s.constant(types.number, cr1));
      writeSpi(s, config, s.constant(types.number, 0x04), 4, s.constant(types.number, cr2));
      writeSpi(s, config, s.constant(types.number, DR), size, s.constant(types.number, first));
      s.writeState('step', s.constant(types.number, 1));
    });
    b.if(b.equal(types.number, step, b.constant(types.number, 1)), (run) => {
      const s = run as Body;
      const status = readSpi(s, config, s.constant(types.number, SR), 4);

      s.if(
        s.notEqual(
          types.number,
          s.bitAnd(status, s.constant(types.number, 1)),
          s.constant(types.number, 0),
        ),
        (hit) => {
          const body = hit as Body;

          writeSpi(body, config, body.constant(types.number, DR), size, body.constant(types.number, second));
          body.writeState('step', body.constant(types.number, 2));
        },
      );
    });
    b.if(b.equal(types.number, step, b.constant(types.number, 2)), (run) => {
      const s = run as Body;
      const status = readSpi(s, config, s.constant(types.number, SR), 4);

      s.if(
        s.notEqual(
          types.number,
          s.bitAnd(status, s.constant(types.number, 0x40)),
          s.constant(types.number, 0),
        ),
        (hit) => {
          const body = hit as Body;

          body.writeState('result', body.constant(types.number, 1));
          body.writeState('step', body.constant(types.number, 3));
        },
      );
    });
    // 只读 SR：OVR 必须仍为 1（不能仅凭 SR 读清除）。
    b.if(b.equal(types.number, step, b.constant(types.number, 3)), (run) => {
      const s = run as Body;
      const status = readSpi(s, config, s.constant(types.number, SR), 4);

      s.if(
        s.notEqual(
          types.number,
          s.bitAnd(status, s.constant(types.number, 0x40)),
          s.constant(types.number, 0),
        ),
        (hit) => {
          const body = hit as Body;

          body.writeState('result', body.constant(types.number, 2));
          body.writeState('step', body.constant(types.number, 4));
        },
      );
    });
    // 只读 DR：仍不能清除 OVR。
    b.if(b.equal(types.number, step, b.constant(types.number, 4)), (run) => {
      const s = run as Body;

      readSpi(s, config, s.constant(types.number, DR), 1);
      s.writeState('step', s.constant(types.number, 5));
    });
    // 读 DR 后再读 SR：OVR 清除。
    b.if(b.equal(types.number, step, b.constant(types.number, 5)), (run) => {
      const s = run as Body;

      readSpi(s, config, s.constant(types.number, SR), 4);
      s.writeState('step', s.constant(types.number, 6));
    });
    // 下一次 SR 读应看到 OVR 已清。
    b.if(b.equal(types.number, step, b.constant(types.number, 6)), (run) => {
      const s = run as Body;
      const status = readSpi(s, config, s.constant(types.number, SR), 4);

      s.if(
        s.equal(
          types.number,
          s.bitAnd(status, s.constant(types.number, 0x40)),
          s.constant(types.number, 0),
        ),
        (cleared) => (cleared as Body).writeState('result', (cleared as Body).constant(types.number, 3)),
      );
      s.writeState('step', s.constant(types.number, 7));
    });
    b.if(b.equal(types.number, step, b.constant(types.number, 7)), (run) => {
      (run as Body).stop();
    });
    b.writeState('pc', b.constant(types.number, 0));
    b.elapse(b.constant(types.number, TICK));
  });

  return builder.finish();
}

function timeBlock(cr1: number, cr2: number): BlockIR {
  const builder = createJitBlockBuilder();

  builder.instruction({ pc: 0, nextPc: 0 }, (b) => {
    const step = b.readState('step', types.number);

    b.if(b.equal(types.number, step, b.constant(types.number, 0)), (run) => {
      const s = run as Body;

      s.store32le('periph', s.constant(types.number, 0x60), s.constant(types.number, 1 << 12));
      s.writeState('gpioModer0', s.constant(types.number, 0x0000a800));
      s.writeState('gpioAfr00', s.constant(types.number, 0x55500000));
      writeSpi(s, config, s.constant(types.number, 0x00), 4, s.constant(types.number, cr1));
      writeSpi(s, config, s.constant(types.number, 0x04), 4, s.constant(types.number, cr2));
      writeSpi(s, config, s.constant(types.number, DR), 1, s.constant(types.number, 0x5a));
      s.writeState('step', s.constant(types.number, 1));
    });
    b.if(b.equal(types.number, step, b.constant(types.number, 1)), (run) => {
      const s = run as Body;

      advanceSpi(s, s.constant(types.number, 5_000_000_000));
      s.writeState('result', s.load32le('spi', s.constant(types.number, 0x44)));
      s.writeState('step', s.constant(types.number, 2));
    });
    b.if(b.equal(types.number, step, b.constant(types.number, 2)), (run) => {
      (run as Body).stop();
    });
    b.writeState('pc', b.constant(types.number, 0));
    b.elapse(b.constant(types.number, TICK));
  });

  return builder.finish();
}

function timeSplitBlock(cr1: number, cr2: number): BlockIR {
  const builder = createJitBlockBuilder();

  builder.instruction({ pc: 0, nextPc: 0 }, (b) => {
    const step = b.readState('step', types.number);

    b.if(b.equal(types.number, step, b.constant(types.number, 0)), (run) => {
      const s = run as Body;

      s.store32le('periph', s.constant(types.number, 0x60), s.constant(types.number, 1 << 12));
      s.writeState('gpioModer0', s.constant(types.number, 0x0000a800));
      s.writeState('gpioAfr00', s.constant(types.number, 0x55500000));
      writeSpi(s, config, s.constant(types.number, 0x00), 4, s.constant(types.number, cr1));
      writeSpi(s, config, s.constant(types.number, 0x04), 4, s.constant(types.number, cr2));
      writeSpi(s, config, s.constant(types.number, DR), 1, s.constant(types.number, 0x5a));
      s.writeState('step', s.constant(types.number, 1));
    });
    b.if(b.equal(types.number, step, b.constant(types.number, 1)), (run) => {
      const s = run as Body;
      const counter = s.add(s.readState('counter', types.number), s.constant(types.number, 1));

      advanceSpi(s, s.constant(types.number, 100_000_000));
      s.writeState('counter', counter);
      s.if(s.greaterThanOrEqual(counter, s.constant(types.number, 50)), (done) => {
        const body = done as Body;

        body.writeState('result', body.load32le('spi', body.constant(types.number, 0x44)));
        body.writeState('fraction', body.load32le('spi', body.constant(types.number, 0x48)));
        body.writeState('step', body.constant(types.number, 2));
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

function clockBlock(
  cr1: number,
  cr2: number,
  data: number,
  size: number,
  clockHz?: number,
): BlockIR {
  const builder = createJitBlockBuilder();

  builder.instruction({ pc: 0, nextPc: 0 }, (b) => {
    b.store32le('periph', b.constant(types.number, 0x60), b.constant(types.number, 1 << 12));
    if (clockHz !== undefined) {
      b.store32le('periph', b.constant(types.number, 0xa0), b.constant(types.number, 1));
      b.store32le('periph', b.constant(types.number, 0xb0), b.constant(types.number, clockHz));
    }
    writeSpi(b, config, b.constant(types.number, 0x00), 4, b.constant(types.number, cr1));
    writeSpi(b, config, b.constant(types.number, 0x04), 4, b.constant(types.number, cr2));
    writeSpi(b, config, b.constant(types.number, DR), size, b.constant(types.number, data));
    b.writeState('result', spiRequestedTickPs(b));
    b.stop();
  });

  return builder.finish();
}

function guardBlock(): BlockIR {
  const builder = createJitBlockBuilder();

  builder.instruction({ pc: 0, nextPc: 0 }, (b) => {
    writeSpi(b, config, b.constant(types.number, 0x00), 4, b.constant(types.number, 0x7c));
    writeSpi(b, config, b.constant(types.number, 0x04), 4, b.constant(types.number, 0x0700));
    writeSpi(b, config, b.constant(types.number, 0x40), 4, b.constant(types.number, 0));
    b.writeState('g0', b.load32le('spi', b.constant(types.number, 0x00)));
    b.store32le('spi', b.constant(types.number, 0x5c), b.constant(types.number, 6));
    b.store32le('spi', b.constant(types.number, 0x58), b.constant(types.number, 0x77));
    b.writeState('g1', readSpi(b, config, b.constant(types.number, 0x0d), 1));
    b.writeState('g4', b.load32le('spi', b.constant(types.number, 0x5c)));
    b.writeState('g2', readSpi(b, config, b.constant(types.number, 0x0c), 1));
    readSpi(b, config, b.constant(types.number, 0x08), 4);
    b.writeState('g5', b.load32le('spi', b.constant(types.number, 0x5c)));
    writeSpi(b, config, b.constant(types.number, 0x0e), 1, b.constant(types.number, 0x5a));
    b.writeState('g6', b.load32le('spi', b.constant(types.number, 0x40)));
    writeSpi(b, config, b.constant(types.number, 0x0c), 1, b.constant(types.number, 0x5a));
    b.writeState('g7', b.load32le('spi', b.constant(types.number, 0x40)));
    b.writeState('g8', readSpi(b, config, b.constant(types.number, 0x40), 4));
    b.stop();
  });

  return builder.finish();
}

interface SpiRigResult {
  readonly board: Board;
  readonly faults: string[];
  result(): unknown;
  state(name: string): unknown;
  run(ps: number): void;
  dispose(): void;
}

export async function createSpiRig(
  options: {
    readonly cr1: number;
    readonly cr2: number;
    readonly data: number;
    readonly size: number;
    readonly second?: number;
    readonly clockFrequency?: number;
    readonly time?: boolean;
    readonly guards?: boolean;
    readonly timeSplit?: boolean;
    readonly clock?: boolean;
    readonly clockHz?: number;
  },
): Promise<SpiRigResult> {
  let block: BlockIR | undefined;
  const machine: Machine = {
    clockFrequency: options.clockFrequency ?? 16_000_000,
    cyclePs: Math.max(1, Math.round(1_000_000_000_000 / (options.clockFrequency ?? 16_000_000))),
    alternateDrivers: spiDrivers(),
    peripherals: [spiModule],
    interruptSources: [],
    profile: 'spi-rig',
  };
  const translate = (): BlockIR => {
    block ??= activateMachine(machine, () => {
      if (options.clock === true) return clockBlock(options.cr1, options.cr2, options.data, options.size, options.clockHz);
      if (options.guards === true) return guardBlock();
      if (options.timeSplit === true) return timeSplitBlock(options.cr1, options.cr2);
      if (options.time === true) return timeBlock(options.cr1, options.cr2);
      return options.second === undefined
        ? rigBlock(options.cr1, options.cr2, options.data, options.size)
        : ovrBlock(options.cr1, options.cr2, options.data, options.second, options.size);
    });

    return block;
  };
  const rigCreate = (context: {
    attachJit(options: {
      entry: string;
      code: string;
      pc: string;
      translate: () => BlockIR;
    }): { dispose(): void };
    loadBytes(memory: string, bytes: Uint8Array, offset?: number): void;
  }) => {
    context.attachJit({ entry: 'spi', code: 'code', pc: 'pc', translate });
    context.loadBytes('code', new Uint8Array(0x100));

    return { sync() {}, dispose() {} };
  };
  const board = createBoard(
    createDeviceLibrary([
      { id: 'rig', model: rigModel(), create: rigCreate as never },
    ] as never),
    {
      instances: [{ id: 'rig', type: 'rig' }],
      nets: [
        {
          id: 'vdd',
          pins: [{ instance: 'rig', pin: 'VDD1' }],
          voltage: 3.3,
        },
        { id: 'vss', pins: [{ instance: 'rig', pin: 'VSS1' }], voltage: 0 },
        {
          id: 'loop',
          pins: [
            { instance: 'rig', pin: 'PA7' },
            { instance: 'rig', pin: 'PA6' },
          ],
        },
        { id: 'sck', pins: [{ instance: 'rig', pin: 'PA5' }] },
      ],
    } as never,
  );
  const faults: string[] = [];
  const errors = board.onDidError((error) => faults.push(error.message));
  const instance = (
    board as unknown as {
      readonly instances?: readonly { readonly states?: ReadonlyMap<string, unknown> }[];
    }
  ).instances?.[0];

  return {
    board,
    faults,
    result: () => instance?.states?.get('result'),
    state: (name) => instance?.states?.get(name),
    run: (ps) => board.runUntil(board.time + ps),
    dispose: () => {
      errors.dispose();
      board.dispose();
    },
  };
}
