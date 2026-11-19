import { createJitBlockBuilder, types } from '@mica-js/sdk/model';
import type { BlockIR, Local, Value } from '@mica-js/sdk/model';
import type { JitTranslate, JitTranslateInput } from '@mica-js/sdk/device';
import { MethodError } from '@mica-js/sdk/device';
import type { JitDelay, JitPolling } from '@mica-js/sdk/device';
import {
  CAPTURE,
  CAPTURE_ENTRY_SIZE,
  CAPTURE_HEAD,
  CAPTURE_PENDING,
  CAPTURE_RESUME,
  CAPTURE_SLOTS,
  CAPTURE_TAIL,
  CODE,
  CPU_CYCLE_PS,
  DEFER_READ,
  DEFER_READ_ADDRESS,
  DEFER_READ_MODULE,
  DEFER_READ_OFFSET,
  DEFER_READ_PORT,
  DEFER_READ_SIGNED,
  DEFER_READ_SIZE,
  DEFER_READ_TARGET,
  DEFER_WRITE,
  DEFER_WRITE_ADDR,
  DEFER_WRITE_MODULE,
  DEFER_WRITE_SIZE,
  DEFER_WRITE_VALUE,
  FLASH_ALIAS_BASE,
  FLASH_BASE,
  FLASH_SIZE,
  GPIO_SYNC,
  GPIO_WRITE,
  GPIO_WRITE_ADDR,
  GPIO_WRITE_SIZE,
  GPIO_WRITE_VALUE,
  IRQ_DIRTY,
  NOW_PS,
  PENDING_PS,
  SERVICE_ADVANCE_BASE,
  SERVICE_CAPTURE,
  SERVICE_CAPTURE_BIT,
  SERVICE_CORE_WRITE_BASE,
  SERVICE_ALL,
  SERVICE_MODULE_READ_BASE,
  SERVICE_MODULE_WRITE_BASE,
  SERVICE_DEFER_READ,
  SERVICE_DEFER_WRITE,
  SERVICE_DISPATCH,
  SERVICE_IRQ,
  SERVICE_FLASH_WRITE,
  SERVICE_SYSTEM_WRITE,
  SERVICE_GPIO_WRITE,
  SERVICE_MASK,
  SERVICE_PIN_SYNC,
  SERVICE_RESUME,
  SYSTICK_ON,
  TICK_ACTIVE,
  TICK_PS,
  TX_MASK,
} from '@mica-js/stm32g431rbt6-core/layout';
import {
  asBody,
  bool,
  boolAnd,
  boolBit,
  boolOr,
  clearService,
  num,
  syncIrqService,
  signExtendDynamic,
  writeReg,
} from '@mica-js/stm32g431rbt6-core/ir';
import type { Body } from '@mica-js/stm32g431rbt6-core/ir';
import { decode, guard } from '@mica-js/stm32g431rbt6-core/decode';
import type { Instruction, KnownRegs } from '@mica-js/stm32g431rbt6-core/decode';
import { activateMachine } from '@mica-js/stm32g431rbt6-core/machine';
import type { Machine } from '@mica-js/stm32g431rbt6-core/machine';
import {
  gpioOffsetOf,
  gpioPortOf,
  readIdrDeferred,
  syncPort,
  writeGpioDynamic,
  writeGpioPort,
} from '@mica-js/stm32g431rbt6-core/gpio';
import { writeFlashMemory } from '@mica-js/stm32g431rbt6-core/flash';
import { clockConfigKey } from '@mica-js/stm32g431rbt6-core/clock-tree';
import { writeSystem } from '@mica-js/stm32g431rbt6-core/nvic';
import {
  deferModuleWrite,
  writeFlashRegisterAt,
  writeGenericRegisterAt,
  writePwrRegisterAt,
  writeRccAt,
  writeServiceMemory,
  writeUsartAt,
} from '@mica-js/stm32g431rbt6-core/bus';
import { advanceSystick } from '@mica-js/stm32g431rbt6-core/systick';
import { advanceUsart, usartDrivers } from '@mica-js/stm32g431rbt6-core/usart';
import {
  isTimerCaptureArmedOnPin,
  observeTimerInputByPin,
  timerCaptureInputsOnPin,
} from '@mica-js/stm32g431rbt6-core/tim';
import {
  advanceServiceSlot,
  schedulePeripheralAdvances,
} from '@mica-js/stm32g431rbt6-core/tick';
import { PERIPHERALS, alternateDriversOf } from '@mica-js/stm32g431rbt6-core/peripherals';
import { validatePeripheralModules } from '@mica-js/stm32g431rbt6-core/peripheral';
import { dispatchExceptions } from '@mica-js/stm32g431rbt6-core/nvic';
import { createRegisterFacts } from '@mica-js/stm32g431rbt6-core/register-facts';
import { cpuWaitPolling, waitExceptionReturnPc } from '@mica-js/stm32g431rbt6-core/wait';
import type { RegisterFacts } from '@mica-js/stm32g431rbt6-core/register-facts';
import { SerialLog } from '../../shared/serial';

/** 静态分析只要求可读的字节序列；JIT 的借用视图与模型内存快照都满足。 */
interface CodeImage {
  readonly length: number;
  readonly [index: number]: number | undefined;
}

/**
 * STM32G431RBT6 的器件实现。
 *
 * JIT 按 PC 翻译一段连续的 Thumb/Thumb-2 指令。外设推进、异常派发与 GPIO 引脚意图都
 * **不内联进指令块**，而是集中在一组固定 PC 的服务块里：
 *
 * 1. 指令块：逐条发射数据通路，每条指令前把 pc 复位成它的顺序后继、每条之后调用
 *    `tick`；`pc` 被分支或服务块改写后，后续指令由守卫跳过；块尾只 `elapse` 一次；
 * 2. 服务块：`SERVICE_TICK` 推进 SysTick 与 USART 并派发中断；`SERVICE_GPIO + port`
 *    执行延迟的 GPIO 寄存器写并刷新该端口；`SERVICE_SYNC` 只刷新标记过的端口。
 *
 * 批处理把精确模式下「每条指令一次调度往返」摊到一个块里。每条指令前把 `pc` 复位为
 * 顺序后继，既让守卫只需比较一次 `pc`，也让 `tick` 沿用「`pc` 就是服务返回位置」的
 * 约定：写成非顺序后继的指令（分支、异常返回）被服务打断时，服务块会返回到分支目标。
 *
 * 指令块因此只剩几百个 IR 操作，整段直接程序能留在 V8 的优化范围内；服务块按需翻译
 * （只用到 GPIOA 的固件不会付其它端口的代码体积）。块内只用 state 读写、8 位访存、
 * `if`/`select` 与算术运算。
 */

const DEFAULT_CLOCK_FREQUENCY = 16_000_000;
const MIN_CLOCK_FREQUENCY = 1_000;
const MAX_CLOCK_FREQUENCY = 170_000_000;
const PICOSECONDS_PER_SECOND = 1_000_000_000_000;

/** 服务块的 PC 段：落在 Flash 取指窗口（0–0x1FFFF）之外，固件不会执行到这里。 */
const SERVICE_TICK = 0x20000;
/** 每个 GPIO 端口一个服务块：`SERVICE_GPIO + port`。只翻译实际用到的端口。 */
const SERVICE_GPIO = 0x20010;
/** 只刷新引脚意图（USART 使能/复用变化）时的服务块。 */
const SERVICE_SYNC = 0x20020;
/** GPIO IDR 延迟读的组包服务块：逐脚采样只在这一点翻译一次。 */
const SERVICE_READ = 0x20030;
/** 非 GPIO 外设写的延迟执行服务块：寄存器读改写链只在这里翻译一次。 */
const SERVICE_WRITE = 0x20040;
/** 只有未屏蔽的待扫描中断才进入完整的 NVIC 扫描。 */
const SERVICE_IRQ_SCAN = 0x20064;

/**
 * 一个块的复杂度预算。纯 ALU/NOP/静态访存计 1，有静态地址的外设访问计 2，未知
 * 地址内存分派计 5。块体是单个 `InstructionIR`，direct 后端无法在 body 内再分片；
 * 用权重而不是固定条数，才能让热点轻量函数合块，同时不让动态访存撑爆 shard。
 */
const MAX_BATCH_COST = 36;
/** 防御性硬上限；按重量预算通常远早于此收块。 */
const MAX_BATCH_INSTRUCTIONS = 36;

/** 本轮先接描述表里的两路捕获；pinId 是 FIFO 中的稳定下标。 */
const CAPTURE_PINS = ['PA15', 'PB4'] as const;

for (const pin of CAPTURE_PINS)
  if (timerCaptureInputsOnPin(pin).length === 0)
    throw new Error(`stm32g431rbt6: capture pin ${pin} is missing from TIM descriptor`);

const isServicePc = (pc: number): boolean =>
  pc === SERVICE_TICK ||
  pc === SERVICE_CAPTURE ||
  pc === SERVICE_SYNC ||
  pc === SERVICE_READ ||
  pc === SERVICE_WRITE ||
  pc === SERVICE_DISPATCH ||
  pc === SERVICE_IRQ_SCAN ||
  pc === SERVICE_FLASH_WRITE ||
  pc === SERVICE_SYSTEM_WRITE ||
  (pc >= SERVICE_CORE_WRITE_BASE && pc < SERVICE_CORE_WRITE_BASE + 8) ||
  (pc >= SERVICE_GPIO && pc < SERVICE_GPIO + 5) ||
  (pc >= SERVICE_ADVANCE_BASE && pc < SERVICE_ADVANCE_BASE + 16) ||
  (pc >= SERVICE_MODULE_WRITE_BASE && pc < SERVICE_MODULE_WRITE_BASE + 32) ||
  (pc >= SERVICE_MODULE_READ_BASE && pc < SERVICE_MODULE_READ_BASE + 32);

function clockFrequency(value: unknown): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_CLOCK_FREQUENCY &&
    value <= MAX_CLOCK_FREQUENCY
    ? Math.round(value)
    : DEFAULT_CLOCK_FREQUENCY;
}

function hseFrequency(value: unknown): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 1_000_000 &&
    value <= 50_000_000
    ? Math.round(value)
    : 0;
}

function createMachine(frequency: number, hse: number): Machine {
  validatePeripheralModules(PERIPHERALS);

  return {
    clockFrequency: frequency,
    cyclePs: Math.max(1, Math.round(PICOSECONDS_PER_SECOND / frequency)),
    hseFrequency: hse,
    dynamicClock: true,
    deferDynamicFlashStore: true,
    alternateDrivers: [...usartDrivers(), ...alternateDriversOf(PERIPHERALS)],
    peripherals: PERIPHERALS,
    interruptSources: PERIPHERALS.flatMap((peripheral) => peripheral.interrupts ?? []),
    profile: 'mcu',
  };
}

/**
 * 每个块把耗时累加进 `pendingPs`，再判一次「要不要服务」；条件成立时把 PC 转给对应
 * 的服务块。
 *
 * 判断只看三个东西：时间是否到粒度（`pendingPs` / `tickPs` / `tickActive`）、是否有中
 * 断待扫描（`irqDirty` 与 `primask`），以及 `serviceMask` 里是否有待执行的延迟请求。
 * 延迟请求的触发点很多（GPIO 写、IDR 读、外设写、引脚刷新），逐位读会在每条指令上
 * 付九次 state 读；归并成一个字后只剩一次。
 *
 * 粒度由 `refreshTick` 依据外设配置维护：空闲时放大到 1 s，SysTick 周期或 USART 位
 * 时长更短时自动收紧。
 *
 * `withTime` 只有批次最后一条指令为真：批量内非末条指令只判「有延迟请求」（单槽状态
 * 必须逐条取走），时间条件推到批尾。推迟量最多是「批内指令数 − 1」个周期（80 MHz、
 * 8 条一批时不到 90 ns），远小于最小节拍粒度 1 µs。
 */
function tickValue(
  machine: Machine,
  b: Body,
  current: Value<number>,
  cyclePs: Value<number>,
  withTime: boolean,
): Value<number> {
  const pending = b.add(current, cyclePs);
  // 服务位可能在当前批次执行期间由引脚 reaction 置位；必须在批次尾重新读取，
  // 不能沿用块首快照，否则捕获边沿会等到 TIM 已越过其时间才被服务。
  const mask = b.readState(SERVICE_MASK, types.number);
  // 没有需要按时间推进的外设时，时间累积本身没有意义，跳过服务块。
  const due = !withTime
    ? undefined
    : boolAnd(
        b,
        b.greaterThanOrEqual(pending, b.readState(TICK_PS, types.number)),
        b.readState(TICK_ACTIVE, types.bool),
      );
  const deferred = b.notEqual(types.number, b.bitAnd(mask, num(b, SERVICE_ALL)), num(b, 0));
  const capturePending = b.notEqual(
    types.number,
    b.readState(CAPTURE_PENDING, types.number),
    num(b, 0),
  );
  const normal = due === undefined ? deferred : boolOr(b, due, deferred);
  const need = boolOr(b, normal, capturePending);

  b.if(need, (service) => {
    const body = asBody(service);
    const routeMask = body.readState(SERVICE_MASK, types.number);
    const wrote = boolBit(body, routeMask, SERVICE_GPIO_WRITE);

    // 服务块将在下一块读取累加器；批级累加只在真正需要服务时提前写回。
    body.writeState(PENDING_PS, pending);
    // 引擎在块体之前已经把 pc 写成顺序后继（或分支目标），它就是服务块要回到的位置。
    body.writeState(SERVICE_RESUME, body.readState('pc', types.number));
    // 待执行的 GPIO 写先落地，延迟读与延迟写再各执行一次，最后才是引脚刷新与节拍。
    body.if(
      wrote,
      (hit) => {
        const inner = asBody(hit);

        inner.writeState(
          'pc',
          inner.add(
            num(inner, SERVICE_GPIO),
            gpioPortOf(inner, inner.readState(GPIO_WRITE_ADDR, types.number)),
          ),
        );
      },
      (afterGpio) => {
        const first = asBody(afterGpio);

        first.if(
          boolBit(first, routeMask, SERVICE_DEFER_READ),
          (read) => {
            asBody(read).writeState('pc', num(asBody(read), SERVICE_READ));
          },
          (afterRead) => {
            const second = asBody(afterRead);

            second.if(
              boolBit(second, routeMask, SERVICE_DEFER_WRITE),
              (write) => {
                asBody(write).writeState('pc', num(asBody(write), SERVICE_WRITE));
              },
              (next) => {
                const inner = asBody(next);

                inner.if(
                  boolBit(inner, routeMask, SERVICE_PIN_SYNC),
                  (pins) => {
                    asBody(pins).writeState('pc', num(asBody(pins), SERVICE_SYNC));
                  },
                  (tickUp) => {
                    const dispatch = asBody(tickUp);

                    dispatch.if(
                      boolBit(dispatch, routeMask, SERVICE_CAPTURE_BIT),
                      (capture) => {
                        asBody(capture).writeState('pc', num(asBody(capture), SERVICE_CAPTURE));
                      },
                      (tick) => {
                        asBody(tick).writeState('pc', num(asBody(tick), SERVICE_TICK));
                      },
                    );
                  },
                );
              },
            );
          },
        );
      },
    );
  });

  return pending;
}

function tick(machine: Machine, b: Body, cyclePs: Value<number>, withTime = true): void {
  const pending = tickValue(machine, b, b.readState(PENDING_PS, types.number), cyclePs, withTime);

  b.writeState(PENDING_PS, pending);
}

/**
 * 服务块。五种入口共用同一套尾部（跳回保存的 PC）：
 * - `SERVICE_TICK`：把累积的时间交给 SysTick 与 USART，并派发中断；
 * - `SERVICE_GPIO + port`：执行延迟的 GPIO 寄存器写并刷新该端口的引脚意图；
 * - `SERVICE_SYNC`：只刷新标记过的端口（USART 使能/复用变化）；
 * - `SERVICE_READ`：为延迟的 GPIO IDR 读逐脚组包并写回目标寄存器；
 * - `SERVICE_WRITE`：执行延迟的非 GPIO 外设写。
 *
 * 每个服务块都是独立 PC，只有真正被跳转到时才会翻译。`elapse(0)` 不推进时间。
 */
function dispatchIrq(body: Body, taken: Local<boolean>): void {
  body.if(
    boolAnd(
      body,
      body.readState(IRQ_DIRTY, types.bool),
      body.equal(types.number, body.readState('primask', types.number), num(body, 0)),
    ),
    (ready) => {
      ready.writeState('pc', num(asBody(ready), SERVICE_IRQ_SCAN));
      ready.setLocal(taken, bool(asBody(ready), true));
    },
    (idle) => clearService(asBody(idle), SERVICE_IRQ),
  );
}

/**
 * 消费 capture FIFO：每条边沿带 lo/hi 绝对时间、pinId 与 level；按 head→tail 顺序
 * 调用 TIM owner 的 `observeTimerInputByPin`。`observe` 内部先 sync 到边沿时间，再
 * 捕获；因此必须在 SERVICE_TICK 的 `advanceTimers` 之前执行。
 */
function drainCapture(body: Body): void {
  const head = body.local(types.number, body.readState(CAPTURE_HEAD, types.number));

  body.while(
    (test) =>
      test.notEqual(
        types.number,
        test.getLocal(head),
        test.readState(CAPTURE_TAIL, types.number),
      ),
    (loop) => {
      const scope = asBody(loop);
      const slot = scope.bitAnd(scope.getLocal(head), num(scope, CAPTURE_SLOTS - 1));
      const base = scope.multiply(slot, num(scope, CAPTURE_ENTRY_SIZE));
      const timeLo = scope.load32le(CAPTURE, base);
      const timeHi = scope.load32le(CAPTURE, scope.add(base, num(scope, 4)));
      const timePs = scope.add(
        timeLo,
        scope.multiply(timeHi, num(scope, 4294967296)),
      );
      const pinId = scope.load8(CAPTURE, scope.add(base, num(scope, 8)));
      const level = scope.notEqual(
        types.number,
        scope.load8(CAPTURE, scope.add(base, num(scope, 9))),
        num(scope, 0),
      );

      scope.if(
        scope.equal(types.number, pinId, num(scope, 0)),
        (hit) => {
          observeTimerInputByPin(asBody(hit), CAPTURE_PINS[0]!, timePs, level);
        },
        (other) => {
          const pb4 = asBody(other);

          pb4.if(
            pb4.equal(types.number, pinId, num(pb4, 1)),
            (hit) => {
              observeTimerInputByPin(asBody(hit), CAPTURE_PINS[1]!, timePs, level);
            },
            () => {},
          );
        },
      );

      const next = scope.add(scope.getLocal(head), num(scope, 1));

      scope.setLocal(head, next);
      scope.writeState(CAPTURE_HEAD, next);
    },
  );

  body.writeState(CAPTURE_PENDING, num(body, 0));
  clearService(body, SERVICE_CAPTURE_BIT);
}

function buildCaptureService(body: Body): void {
  drainCapture(body);
}

/** 如有待消费边沿，先在当前时刻排空 FIFO 再重试本服务块。 */
function withCaptureDrained(
  body: Body,
  pc: number,
  taken: Local<boolean>,
  run: (b: Body) => void,
): void {
  body.if(
    body.notEqual(types.number, body.readState(CAPTURE_PENDING, types.number), num(body, 0)),
    (pending) => {
      const scope = asBody(pending);

      scope.writeState(CAPTURE_RESUME, num(scope, pc));
      scope.writeState('pc', num(scope, SERVICE_CAPTURE));
      scope.setLocal(taken, bool(scope, true));
    },
    (ready) => run(asBody(ready)),
  );
}

function buildService(machine: Machine, pc: number): BlockIR {
  const builder = createJitBlockBuilder();

  builder.instruction({ pc, nextPc: pc }, (body) => {
    const resume = body.readState(SERVICE_RESUME, types.number);
    const taken = body.local(types.bool, false);

    if (pc === SERVICE_CAPTURE) {
      const captureResume = body.readState(CAPTURE_RESUME, types.number);

      buildCaptureService(body);
      body.writeState('pc', captureResume);
      body.setLocal(taken, bool(body, true));
    } else if (pc === SERVICE_TICK) {
      withCaptureDrained(body, pc, taken, (body) => {
        // 捕获边沿必须先于 TIM advance 消费，否则 observe 会拒绝已越过的边沿。
        const pending = body.readState(PENDING_PS, types.number);

        body.writeState(PENDING_PS, num(body, 0));
        body.if(body.greaterThan(pending, num(body, 0)), (step) => {
          const scope = asBody(step);

          // 模块的输入捕获/RTC/超时读取绝对时间；必须在 advance 之前累计。
          scope.writeState(NOW_PS, scope.add(scope.readState(NOW_PS, types.number), pending));
          scope.if(scope.readState(SYSTICK_ON, types.bool), (running) => {
            advanceSystick(asBody(running), pending);
          });
          scope.if(
            scope.notEqual(types.number, scope.readState(TX_MASK, types.number), num(scope, 0)),
            (sending) => {
              advanceUsart(asBody(sending), pending, USART_TX_CHANNELS);
            },
          );
          scope.if(schedulePeripheralAdvances(scope, pending), (scheduled) => {
            asBody(scheduled).setLocal(taken, bool(asBody(scheduled), true));
          });
        });
        body.if(
          body.getLocal(taken),
          () => {},
          (normal) => dispatchIrq(asBody(normal), taken),
        );
      });
    } else if (pc === SERVICE_IRQ_SCAN) {
      body.setLocal(taken, dispatchExceptions(body, waitExceptionReturnPc(body, resume)));
      syncIrqService(body);
    } else if (pc === SERVICE_DISPATCH) {
      dispatchIrq(body, taken);
    } else if (pc === SERVICE_SYNC) {
      syncMarkedPorts(body);
    } else if (pc === SERVICE_READ) {
      // 幂等保护：只有登记位仍有效时才写回，重复派发也不会重复执行。
      body.if(body.readState(DEFER_READ, types.bool), (pending) => {
        const scope = asBody(pending);
        const module = scope.readState(DEFER_READ_MODULE, types.number);

        scope.if(
          scope.notEqual(types.number, module, num(scope, -1)),
          (registered) => {
            const inner = asBody(registered);

            inner.writeState(
              'pc',
              inner.add(num(inner, SERVICE_MODULE_READ_BASE), module),
            );
            inner.setLocal(taken, bool(inner, true));
          },
          (gpio) => {
            const inner = asBody(gpio);
            const port = inner.readState(DEFER_READ_PORT, types.number);
            const offset = inner.readState(DEFER_READ_OFFSET, types.number);
            const target = inner.readState(DEFER_READ_TARGET, types.number);
            const size = inner.readState(DEFER_READ_SIZE, types.number);
            const signed = inner.readState(DEFER_READ_SIGNED, types.bool);
            const value = readIdrDeferred(inner, port, offset, size, signed);

            inner.writeState(DEFER_READ, bool(inner, false));
            clearService(inner, SERVICE_DEFER_READ);
            writeDeferredReg(inner, target, value);
          },
        );
      });
    } else if (pc === SERVICE_WRITE) {
      // 幂等保护：有登记时才写，写完立即清标志；重复派发不会重复执行写。
      body.if(body.readState(DEFER_WRITE, types.bool), (pending) => {
        const scope = asBody(pending);
        const address = scope.readState(DEFER_WRITE_ADDR, types.number);
        const size = scope.readState(DEFER_WRITE_SIZE, types.number);
        const value = scope.readState(DEFER_WRITE_VALUE, types.number);
        const diverted = scope.local(types.bool, false);

        deferModuleWrite(scope, address, diverted);
        scope.if(scope.getLocal(diverted), (registered) => {
          asBody(registered).setLocal(taken, bool(asBody(registered), true));
        }, (normal) => {
          const inner = asBody(normal);

          const writeAtWidth = (body: Body, accessSize: 1 | 2 | 4): void => {
            const flash = body.local(types.bool, false);

            writeServiceMemory(body, address, accessSize, value, flash);
            body.if(
              body.getLocal(flash),
              (flashHit) => {
                asBody(flashHit).setLocal(taken, bool(asBody(flashHit), true));
              },
              (clear) => {
                const scope = asBody(clear);

                scope.writeState(DEFER_WRITE, bool(scope, false));
                scope.writeState(DEFER_WRITE_MODULE, num(scope, -1));
                clearService(scope, SERVICE_DEFER_WRITE);
              },
            );
          };

          // 宽度是运行期值，按 1/2/4 各展开一条写路径；Flash 代码写再转独立服务块。
          inner.if(
            inner.equal(types.number, size, num(inner, 1)),
            (byte) => writeAtWidth(asBody(byte), 1),
            (wide) => {
              const next = asBody(wide);

              next.if(
                next.equal(types.number, size, num(next, 2)),
                (half) => writeAtWidth(asBody(half), 2),
                (word) => writeAtWidth(asBody(word), 4),
              );
            },
          );
        });
      });
    } else if (pc >= SERVICE_ADVANCE_BASE && pc < SERVICE_ADVANCE_BASE + 16) {
      withCaptureDrained(body, pc, taken, (ready) => {
        advanceServiceSlot(ready, pc, resume);
        ready.setLocal(taken, bool(ready, true));
      });
    } else if (pc >= SERVICE_CORE_WRITE_BASE && pc < SERVICE_CORE_WRITE_BASE + 8) {
      const kind = pc - SERVICE_CORE_WRITE_BASE;

      body.if(body.readState(DEFER_WRITE, types.bool), (pending) => {
        const scope = asBody(pending);
        const address = scope.readState(DEFER_WRITE_ADDR, types.number);
        const size = scope.readState(DEFER_WRITE_SIZE, types.number);
        const value = scope.readState(DEFER_WRITE_VALUE, types.number);
        const run = (body2: Body, accessSize: 1 | 2 | 4): void => {
          if (kind === 0) writeRccAt(body2, address, accessSize, value);
          else if (kind === 1) writeGpioDynamic(body2, address, accessSize, value);
          else if (kind === 2) writeUsartAt(body2, address, accessSize, value);
          else if (kind === 3) writeFlashRegisterAt(body2, address, accessSize, value);
          else if (kind === 4) writePwrRegisterAt(body2, address, accessSize, value);
          else writeGenericRegisterAt(body2, address, accessSize, value);
        };

        scope.writeState(DEFER_WRITE, bool(scope, false));
        scope.writeState(DEFER_WRITE_MODULE, num(scope, -1));
        clearService(scope, SERVICE_DEFER_WRITE);
        scope.if(
          scope.equal(types.number, size, num(scope, 1)),
          (byte) => run(asBody(byte), 1),
          (wide) => {
            const next = asBody(wide);

            next.if(
              next.equal(types.number, size, num(next, 2)),
              (half) => run(asBody(half), 2),
              (word) => run(asBody(word), 4),
            );
          },
        );
      });
    } else if (pc === SERVICE_SYSTEM_WRITE) {
      body.if(body.readState(DEFER_WRITE, types.bool), (pending) => {
        const scope = asBody(pending);
        const address = scope.readState(DEFER_WRITE_ADDR, types.number);
        const size = scope.readState(DEFER_WRITE_SIZE, types.number);
        const value = scope.readState(DEFER_WRITE_VALUE, types.number);

        scope.writeState(DEFER_WRITE, bool(scope, false));
        scope.writeState(DEFER_WRITE_MODULE, num(scope, -1));
        clearService(scope, SERVICE_DEFER_WRITE);
        // size 是运行期值；按 1/2/4 展开。
        scope.if(
          scope.equal(types.number, size, num(scope, 1)),
          (byte) => writeSystem(asBody(byte), address, 1, value),
          (wide) => {
            const next = asBody(wide);

            next.if(
              next.equal(types.number, size, num(next, 2)),
              (half) => writeSystem(asBody(half), address, 2, value),
              (word) => writeSystem(asBody(word), address, 4, value),
            );
          },
        );
      });
    } else if (pc === SERVICE_FLASH_WRITE) {
      body.if(body.readState(DEFER_WRITE, types.bool), (pending) => {
        const scope = asBody(pending);
        const address = scope.readState(DEFER_WRITE_ADDR, types.number);
        const size = scope.readState(DEFER_WRITE_SIZE, types.number);
        const value = scope.readState(DEFER_WRITE_VALUE, types.number);
        const offset = scope.select(
          types.number,
          scope.greaterThanOrEqual(address, num(scope, FLASH_BASE)),
          (direct) => {
            const body = asBody(direct);

            return body.subtract(address, num(body, FLASH_BASE));
          },
          (alias) => {
            const body = asBody(alias);

            return body.bitAnd(address, num(body, FLASH_SIZE - 1));
          },
        );

        scope.writeState(DEFER_WRITE, bool(scope, false));
        scope.writeState(DEFER_WRITE_MODULE, num(scope, -1));
        clearService(scope, SERVICE_DEFER_WRITE);
        scope.if(
          scope.equal(types.number, size, num(scope, 1)),
          (byte) => writeFlashMemory(asBody(byte), offset, 1, value),
          (wide) => {
            const next = asBody(wide);

            next.if(
              next.equal(types.number, size, num(next, 2)),
              (half) => writeFlashMemory(asBody(half), offset, 2, value),
              (word) => writeFlashMemory(asBody(word), offset, 4, value),
            );
          },
        );
      });
    } else if (
      pc >= SERVICE_MODULE_WRITE_BASE &&
      pc < SERVICE_MODULE_WRITE_BASE + 32
    ) {
      const module = machine.peripherals[pc - SERVICE_MODULE_WRITE_BASE];

      if (module !== undefined)
        body.if(body.readState(DEFER_WRITE, types.bool), (pending) => {
          const scope = asBody(pending);
          const address = scope.readState(DEFER_WRITE_ADDR, types.number);
          const size = scope.readState(DEFER_WRITE_SIZE, types.number);
          const value = scope.readState(DEFER_WRITE_VALUE, types.number);

          scope.writeState(DEFER_WRITE, bool(scope, false));
          scope.writeState(DEFER_WRITE_MODULE, num(scope, -1));
          clearService(scope, SERVICE_DEFER_WRITE);
          scope.if(
            scope.equal(types.number, size, num(scope, 1)),
            (byte) => module.write(asBody(byte), address, 1, value),
            (wide) => {
              const next = asBody(wide);

              next.if(
                next.equal(types.number, size, num(next, 2)),
                (half) => module.write(asBody(half), address, 2, value),
                (word) => module.write(asBody(word), address, 4, value),
              );
            },
          );
        });
    } else if (
      pc >= SERVICE_MODULE_READ_BASE &&
      pc < SERVICE_MODULE_READ_BASE + 32
    ) {
      const module = machine.peripherals[pc - SERVICE_MODULE_READ_BASE];

      if (module !== undefined)
        body.if(body.readState(DEFER_READ, types.bool), (pending) => {
          const scope = asBody(pending);
          const address = scope.readState(DEFER_READ_ADDRESS, types.number);
          const target = scope.readState(DEFER_READ_TARGET, types.number);
          const size = scope.readState(DEFER_READ_SIZE, types.number);
          const signed = scope.readState(DEFER_READ_SIGNED, types.bool);
          const result = scope.local(types.number, num(scope, 0));

          scope.if(
            scope.equal(types.number, size, num(scope, 1)),
            (byte) => byte.setLocal(result, module.read(asBody(byte), address, 1)),
            (wide) => {
              const next = asBody(wide);

              next.if(
                next.equal(types.number, size, num(next, 2)),
                (half) => half.setLocal(result, module.read(asBody(half), address, 2)),
                (word) => word.setLocal(result, module.read(asBody(word), address, 4)),
              );
            },
          );

          const raw = scope.getLocal(result);
          const value = scope.select(
            types.number,
            signed,
            (yes) =>
              signExtendDynamic(
                asBody(yes),
                raw,
                asBody(yes).multiply(size, num(asBody(yes), 8)),
              ),
            () => raw,
          );

          scope.writeState(DEFER_READ, bool(scope, false));
          scope.writeState(DEFER_READ_MODULE, num(scope, -1));
          clearService(scope, SERVICE_DEFER_READ);
          writeDeferredReg(scope, target, value);
        });
    } else {
      const port = pc - SERVICE_GPIO;
      const address = body.readState(GPIO_WRITE_ADDR, types.number);
      const value = body.readState(GPIO_WRITE_VALUE, types.number);
      const size = body.readState(GPIO_WRITE_SIZE, types.number);
      const offset = gpioOffsetOf(body, address);
      const changed = body.local(types.number, num(body, 0));

      body.if(
        body.equal(types.number, size, num(body, 1)),
        (byte) => {
          const scope = asBody(byte);

          scope.setLocal(changed, writeGpioPort(scope, port, offset, 1, value));
        },
        (half) => {
          const next = asBody(half);

          next.if(
            next.equal(types.number, size, num(next, 2)),
            (two) => {
              const scope = asBody(two);

              scope.setLocal(changed, writeGpioPort(scope, port, offset, 2, value));
            },
            (word) => {
              const scope = asBody(word);

              scope.setLocal(changed, writeGpioPort(scope, port, offset, 4, value));
            },
          );
        },
      );
      body.writeState(GPIO_WRITE, num(body, 0));
      clearService(body, SERVICE_GPIO_WRITE);
      // 本次 GPIO 写的变化位已由 writeGpioPort 精确算出，直接同步；仅 USART 等
      // 无引脚位信息的刷新才继续走 SERVICE_SYNC / GPIO_SYNC。
      body.if(body.notEqual(types.number, body.getLocal(changed), num(body, 0)), (sync) => {
        const scope = asBody(sync);

        syncPort(scope, port, scope.getLocal(changed));
      });
    }
    body.if(
      body.getLocal(taken),
      () => {},
      (back) => {
        asBody(back).writeState('pc', resume);
      },
    );
    body.elapse(num(body, 0));
  });

  return builder.finish();
}

/** 延迟读的目标寄存器在运行期才知道，按寄存器号展开一条写入链。 */
function writeDeferredReg(b: Body, index: Value<number>, value: Value<number>): void {
  for (let register = 0; register < 16; register += 1) {
    b.if(b.equal(types.number, index, num(b, register)), (hit) => {
      writeReg(asBody(hit), register, value);
    });
  }
}

/** 刷新所有被标记的端口，然后清空标记。 */
function syncMarkedPorts(b: Body): void {
  for (let port = 0; port < 5; port += 1) {
    b.if(boolBit(b, b.readState(GPIO_SYNC, types.number), 1 << port), (mark) => {
      // 非 CPU 写触发的刷新（USART 复用/使能）没有引脚位信息，按整端口处理。
      syncPort(asBody(mark), port, num(asBody(mark), 0xffff));
    });
  }
  b.writeState(GPIO_SYNC, num(b, 0));
  clearService(b, SERVICE_PIN_SYNC);
}

function cacheKey(
  code: JitTranslateInput['code'],
  pc: number,
  size: number,
  cyclePs: number,
  config: string,
): string {
  let bytes = '';

  // 取指用 0x1ffff 内的偏移，但缓存键必须带逻辑 PC：固件可以经 0 地址别名
  // （0x00000000 起）或 0x08000000 起取同一段代码，两者是不同的执行位置。
  for (let offset = 0; offset < size; offset += 1)
    bytes += (code[((pc & 0x1ffff) + offset) & 0x1ffff] ?? 0).toString(16).padStart(2, '0');

  return `${config}:${cyclePs}:${pc}:${bytes}`;
}

const blockCache = new Map<string, BlockIR>();
const BLOCK_CACHE_LIMIT = 8192;

const HAL_DELAY_POLL = 'halDelayPoll';
const HAL_DELAY_CONSUME = 'halDelayConsume';
const HAL_DELAY_WAIT_PS = 'halDelayWaitPs';
const HAL_DELAY_ADVANCE = 'halDelayAdvance';

const halfIn = (bytes: CodeImage, offset: number): number =>
  (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);

/** Decode the signed byte offset of a Thumb-2 BL at `offset`. */
function thumbBlTarget(bytes: CodeImage, offset: number, pc: number): number | undefined {
  const first = halfIn(bytes, offset);
  const second = halfIn(bytes, offset + 2);

  if ((first & 0xf800) !== 0xf000 || (second & 0xd000) !== 0xd000) return undefined;
  const sign = (first >>> 10) & 1;
  const j1 = (second >>> 13) & 1;
  const j2 = (second >>> 11) & 1;
  const i1 = ~(j1 ^ sign) & 1;
  const i2 = ~(j2 ^ sign) & 1;
  const immediate =
    sign * 0x1000000 +
    i1 * 0x800000 +
    i2 * 0x400000 +
    (first & 0x3ff) * 0x1000 +
    (second & 0x7ff) * 2;

  return (pc + 4 + ((immediate << 7) >> 7)) >>> 0;
}

/**
 * Match the exact HAL_GetTick stub shape used by this firmware: load an SRAM base from a
 * literal, load the tick word at offset 8 through that same register, then return. Inline
 * tick readers and other literal+load loops are deliberately not guessed.
 */
function isTickReader(bytes: CodeImage, address: number): boolean {
  const offset = address & 0x1ffff;
  const literal = halfIn(bytes, offset);
  const load = halfIn(bytes, offset + 2);
  const returnFromCall = halfIn(bytes, offset + 4);
  const register = (literal >>> 8) & 7;
  const literalOffset = ((address + 4) & ~3) + ((literal & 0xff) << 2);
  const tickBase =
    (bytes[literalOffset & 0x1ffff] ?? 0) |
    ((bytes[(literalOffset + 1) & 0x1ffff] ?? 0) << 8) |
    ((bytes[(literalOffset + 2) & 0x1ffff] ?? 0) << 16) |
    ((bytes[(literalOffset + 3) & 0x1ffff] ?? 0) << 24);
  const inSram = tickBase >= 0x20000000 && tickBase <= 0x20005800 - 8;

  return (
    (literal & 0xf800) === 0x4800 &&
    (load & 0xf800) === 0x6800 &&
    (load & 7) === register &&
    ((load >>> 3) & 7) === register &&
    // LDR word immediate is imm5 * 4; the HAL tick reader loads [base + 8].
    ((load >>> 6) & 0x1f) === 2 &&
    inSram &&
    returnFromCall === 0x4770
  );
}

/**
 * Find the common CMSIS HAL_Delay wait shape:
 *
 *   loop: bl HAL_GetTick
 *         subs delta, tick, started
 *         cmp delta, delay
 *         bcc loop
 *
 * The polling declaration is installed on `loop`, where the runtime can park before the
 * next HAL_GetTick call. Firmware is usually linked at 0x08000000, but the flash alias at
 * zero executes identical bytes, so declarations are emitted for both logical PCs.
 */
function halDelayPolling(firmware: CodeImage | undefined): JitPolling[] {
  if (firmware === undefined || firmware.length < 12) return [];
  const found = new Set<number>();
  const limit = Math.min(firmware.length, 0x20000) - 10;

  for (let offset = 0; offset <= limit; offset += 2) {
    for (const base of [FLASH_BASE, FLASH_ALIAS_BASE]) {
      const pc = (base + offset) >>> 0;
      const target = thumbBlTarget(firmware, offset, pc);
      if (target === undefined || !isTickReader(firmware, target)) continue;

      const subs = halfIn(firmware, offset + 4);
      const compare = halfIn(firmware, offset + 6);
      const branch = halfIn(firmware, offset + 8);
      if (
        (subs & 0xfe00) !== 0x1a00 ||
        (subs & 7) !== ((subs >>> 3) & 7) ||
        (compare & 0xffc0) !== 0x4280 ||
        (branch & 0xff00) !== 0xd300
      )
        continue;
      const displacement = ((branch & 0xff) << 24) >> 23;
      if ((pc + 12 + displacement) >>> 0 !== pc) continue;
      found.add(pc);
    }
  }

  return [...found]
    .sort((left, right) => left - right)
    .map((pc) => ({
      pc,
      predicate: HAL_DELAY_POLL,
      consume: HAL_DELAY_CONSUME,
      wait: { delay: HAL_DELAY_WAIT_PS, advance: HAL_DELAY_ADVANCE },
    }));
}

/**
 * `subs rN, #imm8` immediately followed by `bne` back to itself is the classic busy-wait
 * delay loop: every round only decrements rN and re-tests it, so the runtime may collapse
 * whole rounds into one time advance. Anything else (16-bit `subs` only, straight-line
 * neighbour, self-target) keeps the ordinary path.
 */
function delayLoopAt(
  code: JitTranslateInput['code'],
  fetchPc: number,
  pc: number,
  size: number,
  cyclePs: number,
): JitDelay | undefined {
  if (size !== 2) return undefined;
  const half = (offset: number): number =>
    (code[offset & 0x1ffff] ?? 0) | ((code[(offset + 1) & 0x1ffff] ?? 0) << 8);
  const first = half(fetchPc);
  let register: number;
  if ((first & 0xfe00) === 0x1e00) {
    // SUBS Rd, Rn, #imm3: the counter must be both source and destination and step by one,
    // otherwise a round does not consume exactly one count.
    if ((first & 7) !== ((first >> 3) & 7) || ((first >> 6) & 7) !== 1) return undefined;
    register = first & 7;
  } else if ((first & 0xf800) === 0x3800) {
    // SUBS Rd, #imm8
    if ((first & 0xff) !== 1) return undefined;
    register = first & 7;
  } else return undefined;
  const second = half(fetchPc + 2);
  if ((second & 0xff00) !== 0xd100) return undefined;
  const displacement = (((second & 0xff) << 24) >> 24) * 2;
  if ((pc + size + 4 + displacement) >>> 0 !== pc) return undefined;

  // 折算直接推进 `frame.time`，而本器件的外设靠 `pendingPs` 累加器计时：不带 `pending`
  // 的折算会让 SysTick/USART 永远等不到节拍（`uwTick` 不增长，`HAL_Delay` 死循环）。
  return {
    counter: `r${register}`,
    cycles: 2 * cyclePs,
    pending: { state: PENDING_PS, period: TICK_PS, active: TICK_ACTIVE },
  };
}

/**
 * `b .` 的编码（`11100 imm11`，位移指回自身）。这类块除了一次 `pc` 写入之外没有可观察
 * 效果，因此落在下一次服务节拍之前的轮次可以折成一次时间推进。
 */
function selfBranchAt(
  code: JitTranslateInput['code'],
  fetchPc: number,
  pc: number,
  size: number,
): boolean {
  if (size !== 2) return false;
  const half = (code[fetchPc] ?? 0) | ((code[(fetchPc + 1) & 0x1ffff] ?? 0) << 8);
  if ((half & 0xf800) !== 0xe000) return false;
  return (((pc + 4 + (((half & 0x7ff) << 21) >> 21) * 2) >>> 0) & 0xfffffffe) === (pc & 0xfffffffe);
}

/**
 * 自旋折算。`b .` 每轮只写一次 `pc`，`pendingPs` 之外的累加没有副作用，于是把 `tickPs`
 * 之前的整段轮次一次记进 `pendingPs` 与本次 elapse：折算后的累积值与逐轮执行完全相同，
 * `tick` 里 `due` 首次为真的轮次不变，服务块、SysTick 推进与中断派发的时刻也不变。
 *
 * 折算后本块的 elapse 变长，届时由运行时按推进目标与下一事件切分，因此时间不会越过任何
 * 待处理事件；外部事件引起的 CPU 重新观察最多晚一个服务节拍（`tickPs`），与逐轮执行时
 * `due` 的粒度相同。
 *
 * 与时间无关的"立刻就要服务"条件成立时不折算——它们不随轮次消失，折算只会把本该发生在
 * 本轮的服务推迟。IT 块里的 `b` 可能被掩码掉，同样保持逐轮执行；节拍未激活时 `tickPs`
 * 只是上限而非真实节拍，折算会跨过观察窗口，因此也保持逐轮执行。
 */
function foldSpin(b: Body, cycles: Value<number>, total: Local<number>): void {
  const pending = b.readState(PENDING_PS, types.number);
  // 纯自旋折算不能跨过外部引脚捕获边沿：foldSpin 会把整段等待预记进
  // pendingPs/elapse，runtime continuation 要等到 due 才能选新 PC，外部 reaction
  // 即使改了 pc 也会被续体压住。捕获 armed 时退回逐周期路径，由 serviceMask/
  // SERVICE_CAPTURE 在真实边沿立即接管；未 armed 的 GPIO/HAL 热路径仍保留折算。
  const captureArmed = boolOr(
    b,
    isTimerCaptureArmedOnPin(b, 'PA15'),
    isTimerCaptureArmedOnPin(b, 'PB4'),
  );
  const busy = boolOr(
    b,
    captureArmed,
    boolOr(
      b,
      boolOr(
        b,
        boolAnd(
        b,
        b.readState(IRQ_DIRTY, types.bool),
        b.equal(types.number, b.readState('primask', types.number), num(b, 0)),
      ),
      b.notEqual(types.number, b.readState(GPIO_WRITE, types.number), num(b, 0)),
    ),
    boolOr(
      b,
      b.notEqual(types.number, b.readState(GPIO_SYNC, types.number), num(b, 0)),
        b.notEqual(types.number, b.readState('itState', types.number), num(b, 0)),
      ),
    ),
  );
  b.if(boolAnd(b, b.readState(TICK_ACTIVE, types.bool), b.not(busy)), (free) => {
    const scope = asBody(free);
    const room = scope.subtract(
      scope.subtract(scope.readState(TICK_PS, types.number), pending),
      cycles,
    );
    scope.if(scope.greaterThanOrEqual(room, cycles), (enough) => {
      const inner = asBody(enough);
      const extra = inner.multiply(inner.floor(inner.divide(room, cycles)), cycles);

      inner.writeState(PENDING_PS, inner.add(pending, extra));
      inner.setLocal(total, inner.add(cycles, extra));
    });
  });
}

/** 一个批次里的一条指令：地址、译码结果与取下一条指令的位置。 */
interface Segment {
  readonly pc: number;
  readonly size: 2 | 4;
  readonly cycles: number;
  readonly instruction: Instruction;
}

/** 半字取指；与 `decode` 的窗口取模一致。 */
const halfAt = (code: JitTranslateInput['code'], offset: number): number =>
  (code[offset & 0x1ffff] ?? 0) | ((code[(offset + 1) & 0x1ffff] ?? 0) << 8);

/** 一条 Thumb 指令的长度（按首半字判断 16/32 位）。 */
const sizeAt = (code: JitTranslateInput['code'], offset: number): number => {
  const h1 = halfAt(code, offset);

  return h1 >= 0xe800 ? 4 : 2;
};

/** IT 掩码覆盖的指令条数：左移到低 4 位全 0 需要几次。 */
function itCountOf(mask: number): number {
  let count = 1;

  while (count < 4 && ((mask << count) & 0xf) !== 0) count += 1;

  return count;
}

/**
 * 翻译期估计 `pc` 处还剩多少条受 IT 控制的指令。
 *
 * 批首通常就是分支目标或上一批的顺延，IT 状态为零；但只要 IT 块内有一条指令触发服务，
 * `SERVICE_RESUME` 就会落到 IT 块中间，批首于是带着非零 ITSTATE。无法从 pc 单独确定时，
 * 向后扫描最多 18 字节（IT 本身 2 字节 + 4 条 4 字节指令）找「覆盖 pc 的 IT」并取**最大**
 * 剩余条数。
 *
 * 多估是安全的：没有活动 IT 时 `guard()` 只读一次 `itState`、不执行任何条件逻辑；少估会
 * 把条件指令当成无条件执行。
 */
function itRemainingAt(code: JitTranslateInput['code'], pc: number): number {
  let remaining = 0;

  for (let back = 2; back <= 18; back += 2) {
    const start = (pc - back) >>> 0;
    const h1 = halfAt(code, start);

    if ((h1 & 0xff00) !== 0xbf00) continue;
    const mask = h1 & 0xf;

    if (mask === 0 || ((h1 >> 4) & 0xf) === 0xf) continue;
    const count = itCountOf(mask);
    let cursor = (start + 2) >>> 0;

    for (let index = 0; index < count; index += 1) {
      if (cursor === pc) {
        remaining = Math.max(remaining, count - index);
        break;
      }
      if (cursor > pc) break;
      cursor = (cursor + sizeAt(code, cursor)) >>> 0;
    }
  }

  return remaining;
}

/**
 * 从 `pc` 起收集一个连续的指令批。
 *
 * 收块规则：
 * - 自旋 `b .` 与忙等循环头必须独占或收尾一个块：直接后端的轮次折算按块首 PC 查
 *   `delays`，把它们放进批中间会让折算失效；
 * - 写 pc 或改变 GPIO 输出引脚之后收块（`endsBatch`）：前者避免编译死代码，后者让
 *   宿主电气边界看到完整脉冲（例如 LCD 的 WR 边沿）；
 * - 按复杂度预算而非固定条数收块，轻量静态指令仍可连续合块；
 * - 不在 IT 块中间收块。IT 状态于是可以在翻译期静态跟踪，只有真正受 IT 控制的指令
 *   才需要 IT 守卫包装，普通指令不必为它付三次 `if` 与一次 `itState` 读写。
 */
function collectBatch(
  code: JitTranslateInput['code'],
  pc: number,
  cyclePs: number,
  limit: number,
  firmwareLength: number,
  entryRegs?: KnownRegs,
): readonly Segment[] {
  const segments: Segment[] = [];
  let cursor = pc;
  let batchCost = 0;
  const knownRegs = entryRegs?.slice() ?? Array<number | undefined>(16).fill(undefined);
  // 批首的 IT 状态必须查一次：服务返回可能落在 IT 块中间（见 `itRemainingAt`）。
  let itRemaining = itRemainingAt(code, pc);

  while (segments.length < limit || itRemaining > 0) {
    const fetchPc = cursor & 0x1ffff;
    const decoded = decode(code, cursor, knownRegs, firmwareLength, itRemaining > 0);

    if (itRemaining === 0 && segments.length > 0) {
      if (selfBranchAt(code, fetchPc, cursor, decoded.size)) break;
      if (delayLoopAt(code, fetchPc, cursor, decoded.size, cyclePs) !== undefined) break;
    }
    const inIt = itRemaining > 0;
    const instruction = inIt ? guard(decoded) : decoded;
    const cost = !instruction.mayService ? 1 : instruction.dynamicMemory === true ? 5 : 2;

    if (!inIt && segments.length > 0 && batchCost + cost > MAX_BATCH_COST) break;

    segments.push({
      pc: cursor,
      size: decoded.size,
      cycles: decoded.cycles,
      instruction,
    });
    batchCost += cost;
    if (inIt) itRemaining -= 1;
    if (decoded.itCount > 0) itRemaining = decoded.itCount;
    if (itRemaining > 0) {
      cursor = (cursor + decoded.size) >>> 0;
      continue;
    }
    if (segments.length === 1 && selfBranchAt(code, fetchPc, cursor, decoded.size)) break;
    if (decoded.endsBatch) break;
    cursor = (cursor + decoded.size) >>> 0;
    if (isServicePc(cursor)) break;
  }

  return segments;
}

const createTranslate =
  (
    machine: Machine,
    delays: Map<number, JitDelay>,
    firmwareLength: number,
    registerFacts: () => RegisterFacts | undefined,
  ): JitTranslate =>
  (input) => {
    const pc = input.pc >>> 0;
    const config = activateMachine(machine, clockConfigKey);
    const service = isServicePc(pc);
    const fetchPc = pc & 0x1ffff;
    const segments = service
      ? []
      : collectBatch(
          input.code,
          pc,
          machine.cyclePs,
          MAX_BATCH_INSTRUCTIONS,
          firmwareLength,
          registerFacts()?.at(pc),
        );
    const first = segments[0];

    if (first !== undefined) {
      const declared = delayLoopAt(input.code, fetchPc, pc, first.size, machine.cyclePs);

      // 同一 PC 重新翻译（例如 Flash 被 IAP 覆盖）时必须撤销旧循环声明；块缓存键
      // 带当前字节，能保证这里看到的是新代码。
      if (declared !== undefined) delays.set(pc, declared);
      else delays.delete(pc);
    } else delays.delete(pc);
    const size = segments.reduce((total, segment) => total + segment.size, 0);
    // 批首的 IT 状态来自「pc 之前的字节」，不在块字节速记内，必须进缓存键。
    const itState = service ? 0 : itRemainingAt(input.code, pc);
    const key = service
      ? `service:${config}:${machine.cyclePs}:${pc}`
      : `${itState}:${cacheKey(input.code, pc, size, machine.cyclePs, config)}`;
    const cached = blockCache.get(key);

    if (cached !== undefined) return cached;

    const block = activateMachine(machine, () => {
      if (service) return buildService(machine, pc);

      const head = segments[0]!;
      const tail = segments[segments.length - 1]!;
      const batchNextPc = (tail.pc + tail.size) >>> 0;
      const builder = createJitBlockBuilder();

      builder.instruction({ pc, nextPc: batchNextPc }, (body) => {
        const cyclePs = body.readState(CPU_CYCLE_PS, types.number);

        if (segments.length === 1) {
          const cycles = body.multiply(num(body, head.cycles), cyclePs);
          const spins = selfBranchAt(input.code, fetchPc, pc, head.size);
          const total = spins ? body.local(types.number, cycles) : undefined;

          body.if(
            body.readState('halted', types.bool),
            (stopped) => {
              const scope = asBody(stopped);

              scope.writeState('pc', scope.readState('faultPc', types.number));
            },
            (run) => {
              const scope = asBody(run);

              head.instruction.emit(scope, head.pc);
              if (total !== undefined) foldSpin(scope, cycles, total);
              tick(machine, scope, cycles);
            },
          );
          body.elapse(total === undefined ? cycles : body.getLocal(total));

          return;
        }

        // 每条指令前把 pc 复位成它的顺序后继：指令若分支/异常返回，pc 会变成目标；
        // 若服务块接手，pc 会变成服务 PC。两种情况都让守卫停掉后续指令，而 `tick`
        // 继续把当前 pc 当作服务返回位置，与单条指令块的语义完全一致。
        const running = body.local(types.bool, body.not(body.readState('halted', types.bool)));
        const total = body.local(types.number, num(body, 0));
        const pending = body.local(types.number, body.readState(PENDING_PS, types.number));
        let cumulative = 0;
        let deferredCycles = 0;

        for (let index = 0; index < segments.length; index += 1) {
          const segment = segments[index]!;
          const last = index === segments.length - 1;
          const cycleCount = segment.cycles;
          const mayService = segment.instruction.mayService;
          // 批次末条始终检查 serviceMask：静态内联 GPIO 写在极端电源跳变时留下的
          // SERVICE_GPIO_SYNC 即使前面没有 mayService 指令，也会在这里被结算。
          const mustCheck = last || mayService || segment.instruction.endsBatch;

          cumulative += cycleCount;
          deferredCycles += cycleCount;
          const nextPc = (segment.pc + segment.size) >>> 0;
          const step = cumulative;
          const tickCycles = deferredCycles;

          if (mustCheck) deferredCycles = 0;

          body.if(body.getLocal(running), (run) => {
            const scope = asBody(run);

            scope.setLocal(total, scope.multiply(num(scope, step), cyclePs));
            scope.writeState('pc', num(scope, nextPc));
            segment.instruction.emit(scope, segment.pc);
            if (mustCheck) {
              scope.setLocal(
                pending,
                tickValue(
                  machine,
                  scope,
                  scope.getLocal(pending),
                  scope.multiply(num(scope, tickCycles), cyclePs),
                  last,
                ),
              );
            }
            // 纯寄存器/静态 SRAM 指令既不改变控制流也不会触发服务，下一条无需重新
            // 检查 halted 与 pc；只有可能进入服务块或批次结束的指令才更新守卫。
            if (!last && mustCheck)
              scope.setLocal(
                running,
                boolAnd(
                  scope,
                  scope.not(scope.readState('halted', types.bool)),
                  scope.equal(
                    types.number,
                    scope.readState('pc', types.number),
                    num(scope, nextPc),
                  ),
                ),
              );
          });
        }

        // 进入块时已 halt：本批一条指令都不执行，但仍按整批周期推进时间，避免 JIT
        // 在没有任何时间事件的情况下空转。
        const batchCycles = body.multiply(num(body, cumulative), cyclePs);

        body.if(body.equal(types.number, body.getLocal(total), num(body, 0)), (stopped) => {
          const scope = asBody(stopped);

          scope.setLocal(total, batchCycles);
        });
        // 整个批只写回一次内部累加器；中途真正进入服务块时 tickValue 会先写回当时的值。
        body.writeState(PENDING_PS, body.getLocal(pending));
        body.if(body.readState('halted', types.bool), (stopped) => {
          const scope = asBody(stopped);

          scope.writeState('pc', scope.readState('faultPc', types.number));
        });
        body.elapse(body.getLocal(total));
      });

      return builder.finish();
    });

    if (blockCache.size >= BLOCK_CACHE_LIMIT) blockCache.delete(blockCache.keys().next().value!);
    blockCache.set(key, block);

    return block;
  };

const SERIAL_CAPACITY = 4096;

const SERIAL_CHANNELS = {
  'uart1Tx': { output: 'uart1Tx', event: 'onDidUart1Tx' },
  'uart2Tx': { output: 'uart2Tx', event: 'onDidUart2Tx' },
  'uart3Tx': { output: 'uart3Tx', event: 'onDidUart3Tx' },
  'uart4Tx': { output: 'uart4Tx', event: 'onDidUart4Tx' },
  'lpuart1Tx': { output: 'lpuart1Tx', event: 'onDidLpuart1Tx' },
} as const;

const USART_TX_CHANNELS: Readonly<Record<number, SerialChannel>> = {
  1: 'uart1Tx',
  2: 'uart2Tx',
  3: 'uart3Tx',
  4: 'uart4Tx',
  5: 'lpuart1Tx',
};

type SerialChannel = keyof typeof SERIAL_CHANNELS;

function channelOf(name: string): SerialChannel {
  if (name in SERIAL_CHANNELS) return name as SerialChannel;
  throw new MethodError('serial/unknown-channel', `Unknown serial channel: ${name}`, {
    channel: name,
  });
}

function cursorOf(cursor: number): number {
  if (!Number.isSafeInteger(cursor) || cursor < 0)
    throw new MethodError(
      'serial/invalid-cursor',
      'Serial cursor must be a nonnegative safe integer',
      Number.isFinite(cursor) ? { cursor } : null,
    );
  return cursor;
}

export const create: DeviceFactory = (context) => {
  const frequency = clockFrequency(context.props.clockFrequency);
  const machine = createMachine(frequency, hseFrequency(context.props.hseFrequency));
  const firmware = context.props.firmware;
  const prepared = firmware === null ? undefined : new Uint8Array(FLASH_SIZE);
  const segments: { readonly offset: number; readonly data: Uint8Array }[] = [];
  let loadedEnd = 0;

  if (firmware !== null && prepared !== undefined) {
    for (const segment of firmware.segments) {
      if (segment.addressSpace !== 'code')
        throw new Error(`Unsupported firmware address space: ${segment.addressSpace}`);
      if (segment.data.length === 0) throw new Error('Firmware segment must not be empty');

      const offset = segment.address - FLASH_BASE;
      const end = offset + segment.data.length;

      if (!Number.isSafeInteger(offset) || offset < 0 || end > FLASH_SIZE)
        throw new RangeError(
          `Firmware segment 0x${segment.address.toString(16)}..0x${(segment.address + segment.data.length).toString(16)} is outside the code address space`,
        );

      const data = segment.data.slice();

      prepared.set(data, offset);
      segments.push({ offset, data });
      loadedEnd = Math.max(loadedEnd, end);
    }
  }

  const delays = new Map<number, JitDelay>();
  let registerFacts: RegisterFacts | undefined;
  // JIT 必须在 loadBytes 之前绑定 code 内存；轮询点只能从同一份按绝对地址映射、
  // 保留空洞的 Flash 预备映像分析，装载后立即用模型内存快照复核。
  const analysis = prepared === undefined ? undefined : prepared.subarray(0, loadedEnd);
  // 注意：以下 registerFacts / polling 仍基于装载时的初始映像。IAP 覆盖初始 PC 的
  // 代际失效需要引擎提供 code revision（或在 Flash 写边界做精确撤销）；当前尚未接
  // 该合同，IAP 全链路也因 SRAM 执行未建模而保持关闭。不要用“固件里没搜到解锁常量”
  // 推断代码不可变——这是不 sound 的。
  context.attachJit({
    entry: 'cpu',
    code: CODE,
    pc: 'pc',
    polling:
      analysis === undefined
        ? []
        : [
            ...halDelayPolling(analysis),
            ...cpuWaitPolling(analysis, loadedEnd, [FLASH_BASE, FLASH_ALIAS_BASE]),
          ],
    translate: createTranslate(machine, delays, loadedEnd, () => registerFacts),
    delays,
  });

  for (const segment of segments) context.loadBytes(CODE, segment.data, segment.offset);

  if (prepared !== undefined) {
    // 模型内存是 JIT 实际取指的唯一来源；快照与预备映像不一致时拒绝运行，避免把
    // 非连续镜像错误地拼接成分析输入。
    const snapshot = context.memory.code.slice();

    for (let index = 0; index < loadedEnd; index += 1)
      if (snapshot[index] !== prepared[index])
        throw new Error(`Firmware load mismatch at code offset 0x${index.toString(16)}`);

    registerFacts = createRegisterFacts(snapshot.subarray(0, loadedEnd), loadedEnd);
  }

  const serial = new Map<SerialChannel, SerialLog>();

  for (const channel of Object.keys(SERIAL_CHANNELS) as SerialChannel[])
    serial.set(channel, new SerialLog(SERIAL_CAPACITY));

  let lastFault = -1;

  const methods: DeviceMethods = {
    readSerial: (params) => {
      const log = serial.get(channelOf(params.channel));

      if (log === undefined) throw new Error('Serial log invariant');

      return log.read(cursorOf(params.cursor));
    },
    getSerialStatus: (params) => {
      const log = serial.get(channelOf(params.channel));

      if (log === undefined) throw new Error('Serial log invariant');

      return log.status();
    },
    getLastFault: () => lastFault,
  };

  const publish = (channel: SerialChannel, messages: readonly { readonly value: number }[]) => {
    if (messages.length === 0) return;

    const log = serial.get(channel)!;
    const event = context.events[SERIAL_CHANNELS[channel].event];

    for (const message of messages) {
      const data = Uint8Array.of(message.value & 0xff);
      const { cursor } = log.append(data);

      event.fire({ cursor, data });
    }
  };

  return {
    methods,
    sync(batch) {
      publish('uart1Tx', batch.outputs.uart1Tx);
      publish('uart2Tx', batch.outputs.uart2Tx);
      publish('uart3Tx', batch.outputs.uart3Tx);
      publish('uart4Tx', batch.outputs.uart4Tx);
      publish('lpuart1Tx', batch.outputs.lpuart1Tx);

      for (const message of batch.outputs.fault) {
        lastFault = message.value;
        context.events.onDidFault.fire(lastFault);
      }
    },
    dispose() {},
  };
};
