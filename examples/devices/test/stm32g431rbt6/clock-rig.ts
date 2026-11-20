import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { JitTranslate } from '@mica-js/sdk/device';
import { createDeviceBuilder, types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { asBody, num } from '@mica-js/stm32g431rbt6-core/ir';
import type { Body } from '@mica-js/stm32g431rbt6-core/ir';
import { activateMachine } from '@mica-js/stm32g431rbt6-core/machine';
import type { Machine } from '@mica-js/stm32g431rbt6-core/machine';

/**
 * 只包含 RCC/PWR 翻译逻辑的合成夹具。
 *
 * 真实器件此刻仍被并行集成改动；时钟树的数学与 IR 需要独立可复现的验证。这里把
 * `writeRcc`/`readRcc`/`readPwr` 直接放进一个只声明 `periph`/`sys` 的极小设备，
 * 用一个 `emit` 回调描述“固件”的寄存器序列，然后读回缓存与状态。它不经过 GPIO、
 * USART 引脚或总线分派，因此测的就是时钟/PWR 模型本身。
 */

export interface ClockRigOptions {
  /** 描述固件对 RCC/PWR 的寄存器访问。 */
  readonly emit: (b: Body) => void;
  /** 在 emit 之前写入 `periph` 的初始寄存器内容（例如 BRR/CR1）。 */
  readonly init?: (b: Body) => void;
  readonly hseFrequency?: number;
  readonly clockFrequency?: number;
  /** 默认 true；false 用于验证仍使用 boot `machine().cyclePs` 的旧接口。 */
  readonly dynamicClock?: boolean;
}

export interface ClockRig {
  readonly states: ReadonlyMap<string, unknown>;
  readonly periph: Uint8Array;
  run(durationPs: number): void;
  dispose(): void;
}

export interface ClockTimeOptions {
  /** 首次执行时写入 RCC/USART 配置；之后只按 clockHz 推进时间。 */
  readonly configure?: (b: Body) => void;
  /** 每次“CPU 步”消耗的 1e12/clockHz 皮秒；必须是运行期可读的时钟。 */
  readonly clockHz?: (b: Body) => Value<number>;
  /** 直接给出每步的皮秒数（例如 USART 位时长状态）；优先于 clockHz。 */
  readonly periodPs?: (b: Body) => Value<number>;
  readonly hseFrequency?: number;
  readonly clockFrequency?: number;
}

export interface ClockTimeRig {
  readonly states: ReadonlyMap<string, unknown>;
  readonly periph: Uint8Array;
  readonly steps: number;
  readonly time: number;
  run(durationPs: number): void;
  dispose(): void;
}

/** 合成设备需要声明的 USART 位时长状态（updateUsartBitPeriod 的写入目标）。 */
const USART_PERIOD_STATES = [1, 2, 3, 4, 5].map((index) => `tx${index}Period`);

export function clockRig(options: ClockRigOptions): ClockRig {
  const frequency = options.clockFrequency ?? 16_000_000;
  const cyclePs = Math.max(1, Math.round(1_000_000_000_000 / frequency));
  const builder = createDeviceBuilder({ name: 'ClockRig' });

  builder.memory({ name: 'code', length: 16 });
  builder.memory({ name: 'periph', length: 0x1000 });
  builder.memory({ name: 'sys', length: 0x200 });
  // SPI/I2C 的私有状态由各自模块持有；时钟分支测试只读内部相位/周期字段。
  builder.memory({ name: 'spi', length: 0x400 });
  builder.memory({ name: 'i2c', length: 0x400 });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  builder.state({ name: 'cpuCyclePs', type: types.number, initial: cyclePs });
  for (let index = 0; index < 16; index += 1)
    builder.state({ name: `o${index}`, type: types.number, initial: 0 });
  for (const name of USART_PERIOD_STATES) builder.state({ name, type: types.number, initial: 1 });

  const machine = {
    clockFrequency: frequency,
    cyclePs,
    dynamicClock: options.dynamicClock ?? true,
    alternateDrivers: [],
    peripherals: [],
    interruptSources: [],
    profile: 'clock-rig',
    hseFrequency: options.hseFrequency,
    clockResetHooks: false,
  } as Machine;

  const translate: JitTranslate = (_input, block) => {
    block.instruction({ pc: 0, nextPc: 0 }, (body) => {
      activateMachine(machine, () => {
        // 真实 RCC 写入发生在 bus 的嵌套 if/else 里；这里刻意套一层 if，确保
        // clock-tree 的 select/if 回调不依赖“顶层 builder 恰好是 active”的假设。
        body.if(body.constant(types.bool, true), (nested) => {
          const scope = asBody(nested);

          options.init?.(scope);
          options.emit(scope);
        });
      });
      body.stop();
    });

    return block.finish();
  };

  const runtime = createBoard(
    createDeviceLibrary([
      {
        id: 'rig',
        model: builder.finish(),
        create: (context) => {
          context.attachJit({ entry: 'rig', code: 'code', pc: 'pc', translate });
          context.loadBytes('code', new Uint8Array(16));

          return { sync() {}, dispose() {} };
        },
      },
    ]),
    { instances: [{ id: 'rig', type: 'rig' }], nets: [] },
  );
  const instance = (
    runtime as unknown as {
      readonly instances: readonly {
        readonly states: ReadonlyMap<string, unknown>;
        readonly memories: ReadonlyMap<string, Uint8Array>;
      }[];
    }
  ).instances[0]!;

  return {
    states: instance.states,
    periph: instance.memories.get('periph') ?? new Uint8Array(0x1000),
    run: (durationPs) => runtime.runUntil(durationPs),
    dispose: () => runtime.dispose(),
  };
}

/**
 * 时钟→真实仿真时间的探针：一块只有 `steps` 计数器的极小 JIT 设备，每次执行
 * `elapse(1e12 / clockHz)`。它验证的是“读取时钟缓存后真正推进的板级时间”，
 * 而不是只比较缓存里的 Hz 数字。中央的 CPU/USART/TIM 接线应采用同一时钟来源。
 */
export function clockTimeRig(options: ClockTimeOptions): ClockTimeRig {
  const builder = createDeviceBuilder({ name: 'ClockTimeRig' });

  builder.memory({ name: 'code', length: 16 });
  builder.memory({ name: 'periph', length: 0x1000 });
  builder.memory({ name: 'sys', length: 0x200 });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  builder.state({ name: 'steps', type: types.number, initial: 0 });
  builder.state({ name: 'configured', type: types.bool, initial: false });
  for (const name of USART_PERIOD_STATES) builder.state({ name, type: types.number, initial: 1 });

  const frequency = options.clockFrequency ?? 16_000_000;
  const machine = {
    clockFrequency: frequency,
    cyclePs: Math.max(1, Math.round(1_000_000_000_000 / frequency)),
    alternateDrivers: [],
    peripherals: [],
    interruptSources: [],
    profile: 'clock-time-rig',
    hseFrequency: options.hseFrequency,
    clockResetHooks: false,
  } as Machine;

  const translate: JitTranslate = (_input, block) => {
    block.instruction({ pc: 0, nextPc: 0 }, (body) => {
      activateMachine(machine, () => {
        body.if(body.not(body.readState('configured', types.bool)), (first) => {
          const scope = asBody(first);

          options.configure?.(scope);
          scope.writeState('configured', true);
        });
        const period =
          options.periodPs !== undefined
            ? options.periodPs(body)
            : (() => {
                const hz = options.clockHz!(body);

                return body.select(
                  types.number,
                  body.greaterThan(hz, num(body, 0)),
                  (inner) =>
                    inner.floor(inner.divide(inner.constant(types.number, 1_000_000_000_000), hz)),
                  (inner) => inner.constant(types.number, 1),
                );
              })();

        body.writeState('steps', body.add(body.readState('steps', types.number), num(body, 1)));
        body.elapse(period);
      });
    });

    return block.finish();
  };

  const runtime = createBoard(
    createDeviceLibrary([
      {
        id: 'time',
        model: builder.finish(),
        create: (context) => {
          context.attachJit({ entry: 'time', code: 'code', pc: 'pc', translate });
          context.loadBytes('code', new Uint8Array(16));

          return { sync() {}, dispose() {} };
        },
      },
    ]),
    { instances: [{ id: 'time', type: 'time' }], nets: [] },
  );
  const instance = (
    runtime as unknown as {
      readonly instances: readonly { readonly states: ReadonlyMap<string, unknown> }[];
    }
  ).instances[0]!;

  return {
    states: instance.states,
    periph:
      (
        runtime as unknown as {
          readonly instances: readonly { readonly memories: ReadonlyMap<string, Uint8Array> }[];
        }
      ).instances[0]!.memories.get('periph') ?? new Uint8Array(0x1000),
    get steps() {
      return instance.states.get('steps') as number;
    },
    get time() {
      return runtime.time;
    },
    run: (durationPs) => runtime.runUntil(runtime.time + durationPs),
    dispose: () => runtime.dispose(),
  };
}
