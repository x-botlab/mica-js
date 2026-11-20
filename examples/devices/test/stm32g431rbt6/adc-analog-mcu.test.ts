import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { Board } from '@mica-js/sdk';
import { compileDDL } from '@mica-js/sdk/ddl';
import { createDeviceBuilder, types } from '@mica-js/sdk/model';
import type { DeviceIR } from '@mica-js/sdk/model';
import { describe, expect, it } from 'vitest';
import { asBody } from '@mica-js/stm32g431rbt6-core/ir';
import { adaptDevice } from './harness';

/**
 * DAC1 / OPAMP1 在主 MCU 生产模型上的动态接线回归。
 *
 * 不使用 test-local 外设 profile：由标准主 adapter 与生产 `PERIPHERALS` 运行真实
 * `model.ddl`/JIT；外部电阻分压源是独立器件，连接到 MCU 的真实 PA1/PA4/VREFP 引脚。
 * 固件只配置 GPIO/OPAMP/DAC，输出刷新由生产模拟外设的 10 µs 活动槽完成。
 */

const DEVICE_DIR = join(import.meta.dirname, '..', '..', 'stm32g431rbt6', 'src');

const [module, model] = await Promise.all([
  import(pathToFileURL(join(DEVICE_DIR, 'index.ts')).href) as Promise<{ create: unknown }>,
  compileDDL(readFileSync(join(DEVICE_DIR, 'model.ddl'), 'utf8'), {
    uri: 'mica:devices/stm32g431rbt6/model.ddl',
  }),
]);

class Thumb {
  readonly #halves: number[] = [];

  #half(value: number): this {
    this.#halves.push(value & 0xffff);

    return this;
  }

  #dword(first: number, second: number): this {
    return this.#half(first).#half(second);
  }

  movw(rd: number, immediate: number): this {
    const value = immediate & 0xffff;

    return this.#dword(
      0xf240 | (((value >>> 11) & 1) << 10) | ((value >>> 12) & 0xf),
      (((value >>> 8) & 7) << 12) | (rd << 8) | (value & 0xff),
    );
  }

  movt(rd: number, immediate: number): this {
    const value = immediate & 0xffff;

    return this.#dword(
      0xf2c0 | (((value >>> 11) & 1) << 10) | ((value >>> 12) & 0xf),
      (((value >>> 8) & 7) << 12) | (rd << 8) | (value & 0xff),
    );
  }

  movs(rd: number, immediate: number): this {
    return this.#half(0x2000 | (rd << 8) | (immediate & 0xff));
  }

  strWord(rt: number, rn: number, offset: number): this {
    return this.#dword(0xf8c0 | rn, (rt << 12) | (offset & 0xfff));
  }

  spin(): this {
    return this.#half(0xe7fe);
  }

  build(): Uint8Array {
    const image = new Uint8Array(8 + this.#halves.length * 2);
    const view = new DataView(image.buffer);

    view.setUint32(0, 0x2000_5000, true);
    view.setUint32(4, 0x0800_0009, true);
    this.#halves.forEach((value, index) => view.setUint16(8 + index * 2, value, true));

    return image;
  }
}

function opampFollowerFirmware(): Uint8Array {
  return new Thumb()
    .movw(0, 0x0000)
    .movt(0, 0x4800)
    .movw(1, 0x003c) // PA1/PA2 analog
    .strWord(1, 0, 0)
    .movw(0, 0x0300)
    .movt(0, 0x4001)
    .movw(1, 0x0061) // EN=1, VMSEL=3 follower, VPSEL=0(PA1)
    .strWord(1, 0, 0)
    .spin()
    .build();
}

function dacFirmware(): Uint8Array {
  return new Thumb()
    .movw(0, 0x0000)
    .movt(0, 0x4800)
    .movw(1, 0x0300) // PA4 analog
    .strWord(1, 0, 0)
    .movw(0, 0x0800)
    .movt(0, 0x5000)
    .movs(1, 1) // DAC EN1
    .strWord(1, 0, 0)
    .movw(1, 2048)
    .strWord(1, 0, 8) // DHR12R1
    .spin()
    .build();
}

function sourceModel(name: string, initial: number): DeviceIR {
  const builder = createDeviceBuilder({ name });
  const intent = (body: {
    resistor(to: string, resistance: number): unknown;
    combineIntents(...values: unknown[]): unknown;
  }, level: number): unknown => {
    if (level === 0) return body.combineIntents(body.resistor('vcc', 30_000), body.resistor('gnd', 10_000));
    if (level === 1) return body.combineIntents(body.resistor('vcc', 10_000), body.resistor('gnd', 10_000));
    if (level === 2) return body.combineIntents(body.resistor('vcc', 10_000), body.resistor('gnd', 30_000));
    if (level === 3) return body.combineIntents(body.resistor('vcc', 1), body.resistor('gnd', 1_000_000_000));
    return body.combineIntents(body.resistor('vcc', 1_000_000_000), body.resistor('gnd', 1));
  };

  builder.pin({
    name: 'y',
    initial: (body) => body.returnValue(intent(body as never, initial) as never),
  });
  builder.pin({ name: 'vcc' });
  builder.pin({ name: 'gnd' });
  builder.channel({ name: 'ratio', direction: 'input', type: types.number, capacity: 4 });
  builder.start((body) => {
    body.loop((loop) => {
      const level = loop.receive('ratio', types.number);

      for (const value of [0, 1, 2, 3, 4])
        loop.if(
          loop.equal(types.number, level, loop.constant(types.number, value)),
          (hit) => asBody(hit).writeIntent('y', intent(asBody(hit) as never, value) as never),
        );
    });
  });

  return builder.finish();
}

interface AnalogBoard {
  readonly runtime: Board;
  readonly inputs: Record<string, { send(value: number): void }>;
  sample(pin: string): { readonly voltage: number | null; readonly status: string };
}

function board(firmware: Uint8Array, sources: readonly { pin: string; initial: number }[]): AnalogBoard {
  const sourceHandles: Record<string, { send(value: number): void }> = {};
  const entries: {
    id: string;
    model: DeviceIR;
    create: (context: never) => { sync(): void; dispose(): void };
  }[] = [
    {
      id: 'mcu',
      model,
      create: adaptDevice(module, { firmware }) as never,
    },
  ];
  const instances: { id: string; type: string; props?: Record<string, number> }[] = [
    { id: 'mcu', type: 'mcu', props: { clockFrequency: 16_000_000 } },
  ];
  const nets: {
    id: string;
    pins: { instance: string; pin: string }[];
    voltage?: number;
  }[] = [
    {
      id: 'vdd',
      voltage: 3.3,
      pins: ['VDD1', 'VDD2', 'VDD3', 'VDD4', 'VDDA', 'VBAT'].map((pin) => ({
        instance: 'mcu',
        pin,
      })),
    },
    {
      id: 'vss',
      voltage: 0,
      pins: ['VSS1', 'VSS2', 'VSS3', 'VSS4', 'VSSA'].map((pin) => ({
        instance: 'mcu',
        pin,
      })),
    },
  ];

  for (const source of sources) {
    const id = `src_${source.pin}`;

    entries.push({
      id,
      model: sourceModel(`Source_${source.pin}`, source.initial),
      create: (context: never) => {
        const typed = context as unknown as {
          inputs: { ratio: { send(value: number): void } };
        };

        sourceHandles[source.pin] = typed.inputs.ratio;

        return { sync() {}, dispose() {} };
      },
    });
    instances.push({ id, type: id });
    nets.push({
      id: `net_${source.pin}`,
      pins: [
        { instance: 'mcu', pin: source.pin },
        { instance: id, pin: 'y' },
      ],
    });
    nets.push({ id: `vcc_${source.pin}`, voltage: 3.3, pins: [{ instance: id, pin: 'vcc' }] });
    nets.push({ id: `gnd_${source.pin}`, voltage: 0, pins: [{ instance: id, pin: 'gnd' }] });
  }

  const runtime = createBoard(createDeviceLibrary(entries as never), {
    instances: instances as never,
    nets: nets as never,
  });
  const instance = (
    runtime as unknown as {
      readonly instances: readonly {
        readonly pins: ReadonlyMap<
          string,
          { readonly sample: { readonly voltage: number | null; readonly status: string } }
        >;
      }[];
    }
  ).instances[0]!;

  return {
    runtime,
    inputs: sourceHandles,
    sample: (pin) => instance.pins.get(pin)!.sample,
  };
}

describe('DAC/OPAMP 主 MCU 动态接线', () => {
  it('OPAMP follower 跟随 PA1，VREFP 掉电后释放 PA2', () => {
    const circuit = board(opampFollowerFirmware(), [
      { pin: 'PA1', initial: 0 },
      { pin: 'VREFP', initial: 3 },
    ]);

    try {
      circuit.runtime.runUntil(0);
      circuit.runtime.runUntil(100_000_000);
      expect(circuit.sample('PA2').voltage).toBeCloseTo(0.825, 4);

      circuit.inputs.PA1!.send(1);
      circuit.runtime.runUntil(circuit.runtime.time + 100_000_000);
      expect(circuit.sample('PA2').voltage).toBeCloseTo(1.65, 4);

      circuit.inputs.VREFP!.send(4);
      circuit.runtime.runUntil(circuit.runtime.time + 100_000_000);
      expect(circuit.sample('PA2').status).toBe('floating');
    } finally {
      circuit.runtime.dispose();
    }
  });

  it('DAC 输出 2048/4096 VREFP；VREFP 掉电后释放 PA4', () => {
    const circuit = board(dacFirmware(), [{ pin: 'VREFP', initial: 3 }]);

    try {
      circuit.runtime.runUntil(0);
      circuit.runtime.runUntil(100_000_000);
      expect(circuit.sample('PA4').voltage).toBeCloseTo(1.65, 4);

      circuit.inputs.VREFP!.send(4);
      circuit.runtime.runUntil(circuit.runtime.time + 100_000_000);
      expect(circuit.sample('PA4').status).toBe('floating');
    } finally {
      circuit.runtime.dispose();
    }
  });
});
