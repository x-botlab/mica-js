import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { Board } from '@mica-js/sdk';
import type { DeviceBatch, DeviceContext, InputChannel } from '@mica-js/sdk/device';
import { compileDDL } from '@mica-js/sdk/ddl';
import { adaptDevice, circuit } from './harness';

const DEVICE_DIR = join(import.meta.dirname, '..', '..', 'stm32g431rbt6', 'src');
const [module, model] = await Promise.all([
  import(pathToFileURL(join(DEVICE_DIR, 'index.ts')).href) as Promise<{
    create: unknown;
  }>,
  compileDDL(readFileSync(join(DEVICE_DIR, 'model.ddl'), 'utf8'), {
    uri: 'mica:devices/stm32g431rbt6/model.ddl',
  }),
]);

const PROBE_MODEL = `
device GpioProbe {
  pin p(low: 0.8, high: 2.0);
  output channel level: number(capacity: 64, overflow: Overflow.drop_oldest);
  fn report() {
    if p.sample.level == Logic.high { level.send(1); }
    else if p.sample.level == Logic.low { level.send(0); }
    else { level.send(2); }
  }
  process start { report(); }
  reaction changed on p.sample.level as (previous, next) { report(); }
}
`;

const SOURCE_MODEL = `
device PowerSource(outputResistance: number default 25, initialLevel: number default 2) {
  pin y;
  pin vcc;
  pin gnd;
  input channel level: number(capacity: 8, overflow: Overflow.drop_oldest);
  state wanted: number = initialLevel;
  fn apply() {
    if wanted == 1 { y.intent <- [resistor(to: vcc, resistance: outputResistance)]; }
    else if wanted == 0 { y.intent <- [resistor(to: gnd, resistance: outputResistance)]; }
    else { y.intent <- []; }
  }
  process start { apply(); loop { wanted = await level.receive(); apply(); } }
}
`;

const probeModel = await compileDDL(PROBE_MODEL);
const sourceModel = await compileDDL(SOURCE_MODEL);

// 配置 PA5 为推挽输出并置高，之后只执行 `b .`，不再产生 GPIO 写。
const STATIC_HIGH_PA5 = new Uint8Array([
  0x00, 0x58, 0x00, 0x20, 0x09, 0x00, 0x00, 0x08, 0x41, 0xf2, 0x00, 0x00, 0xc4, 0xf2, 0x02, 0x00,
  0x01, 0x21, 0x81, 0x64, 0x40, 0xf2, 0x00, 0x00, 0xc4, 0xf6, 0x00, 0x00, 0x40, 0xf2, 0x00, 0x41,
  0x01, 0x60, 0x20, 0x21, 0x81, 0x61, 0xfe, 0xe7,
]);

const BSRR_SET_BSRR_CLEAR = new Uint8Array([
  0x00, 0x58, 0x00, 0x20, 0x09, 0x00, 0x00, 0x08, 0x41, 0xf2, 0x00, 0x00, 0xc4, 0xf2, 0x02, 0x00,
  0x01, 0x21, 0x81, 0x64, 0x40, 0xf2, 0x00, 0x00, 0xc4, 0xf6, 0x00, 0x00, 0x41, 0xf2, 0x00, 0x41,
  0x01, 0x60, 0x60, 0x21, 0x81, 0x61, 0x20, 0x21, 0x81, 0x62, 0xfe, 0xe7,
]);

const VDD = ['VDD2', 'VDD3', 'VDD4', 'VDDA', 'VREFP', 'VBAT'] as const;
const VSS = ['VSS1', 'VSS2', 'VSS3', 'VSS4', 'VSSA'] as const;

interface PowerBoard {
  readonly board: Board;
  readonly latestLevel: () => number;
  readonly setSupply: (on: boolean) => void;
}

interface PowerBoardOptions {
  readonly initialSupplyOn?: boolean;
}

function createPowerBoard(firmware: Uint8Array, options: PowerBoardOptions = {}): PowerBoard {
  let latestLevel = 2;
  let supply: InputChannel<number> | undefined;
  const probe = () => ({
    sync(batch: DeviceBatch<{ readonly level?: readonly { readonly value: unknown }[] }>) {
      const messages = batch.outputs.level;
      const message = messages?.[messages.length - 1];

      if (message !== undefined) latestLevel = Number(message.value);
    },
    dispose() {},
  });
  const powerSource = (
    context: DeviceContext<object, { readonly level: InputChannel<number> }>,
  ) => {
    supply = context.inputs.level;

    return { sync() {}, dispose() {} };
  };
  const board = createBoard(
    createDeviceLibrary([
      { id: 'mcu', model, create: adaptDevice(module, { firmware }) as never },
      { id: 'probe', model: probeModel, create: probe as never },
      { id: 'power', model: sourceModel, create: powerSource as never },
    ]),
    {
      instances: [
        { id: 'mcu', type: 'mcu', props: { clockFrequency: 1_000_000 } },
        { id: 'probe', type: 'probe' },
        {
          id: 'power',
          type: 'power',
          props: { initialLevel: options.initialSupplyOn === true ? 1 : 2 },
        },
      ],
      nets: [
        { id: 'vcc', voltage: 3.3, pins: [{ instance: 'power', pin: 'vcc' }] },
        {
          id: 'vss',
          voltage: 0,
          pins: [
            { instance: 'power', pin: 'gnd' },
            ...VSS.map((pin) => ({ instance: 'mcu', pin })),
          ],
        },
        {
          id: 'vdd1',
          pins: [
            { instance: 'mcu', pin: 'VDD1' },
            { instance: 'power', pin: 'y' },
          ],
        },
        {
          id: 'vdd-other',
          voltage: 3.3,
          pins: VDD.map((pin) => ({ instance: 'mcu', pin })),
        },
        {
          id: 'pa5',
          pins: [
            { instance: 'mcu', pin: 'PA5' },
            { instance: 'probe', pin: 'p' },
          ],
        },
      ],
    },
    { execution: 'throughput' },
  );

  board.runUntil(0);

  return {
    board,
    latestLevel: () => latestLevel,
    setSupply(on) {
      if (supply === undefined) throw new Error('Power source input was not bound');
      supply.send(on ? 1 : 2);
    },
  };
}

describe('GPIO 端口同步边界', () => {
  it('BSRR 置位后 BRR 能清零目标脚，且保留未清零脚', async () => {
    const board = await circuit({
      firmware: BSRR_SET_BSRR_CLEAR,
      clockFrequency: 1_000_000,
    });

    try {
      board.run(1_000_000_000);
      expect(board.faults).toEqual([]);
      expect(board.levels.PA5).toBe(0);
      expect(board.levels.PA6).toBe(1);
      // BSRR set 后紧跟 BRR clear：两个边沿都必须经过宿主电气边界，不能被合块吞掉。
      expect(board.history.PA5).toEqual([2, 0, 1, 0]);
      expect(board.history.PA6).toEqual([2, 0, 1]);
    } finally {
      board.dispose();
    }
  });

  it('初次上电会在固件首次执行前后建立正确的输出 intent', () => {
    const power = createPowerBoard(STATIC_HIGH_PA5, { initialSupplyOn: true });

    try {
      power.board.runUntil(1_000_000_000);
      expect(power.latestLevel()).toBe(1);
    } finally {
      power.board.dispose();
    }
  });
});
