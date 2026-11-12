import type { Factory } from './model.ddl';
import { createJitBlockBuilder, types } from '@mica-js/sdk/model';
import type { BlockIR, Local } from '@mica-js/sdk/model';
import type { JitTranslate, JitTranslateInput } from '@mica-js/sdk/device';
import {
  CODE,
  GPIO_PIN_MASK,
  GPIO_SYNC,
  GPIO_WRITE,
  GPIO_WRITE_ADDR,
  GPIO_WRITE_SIZE,
  GPIO_WRITE_VALUE,
  IRQ_DIRTY,
  PENDING_PS,
  SERVICE_RESUME,
  SYSTICK_ON,
  TICK_ACTIVE,
  TICK_PS,
  TX_MASK,
} from './core/layout';
import { asBody, boolAnd, boolBit, boolOr, num } from './core/ir';
import type { Body } from './core/ir';
import { decode } from './core/decode';
import { activateMachine } from './core/machine';
import type { Machine } from './core/machine';
import { gpioOffsetOf, gpioPortOf, syncPort, writeGpioPort } from './core/gpio';
import { advanceSystick } from './core/systick';
import { advanceUsart, usartDrivers } from './core/usart';
import { dispatchExceptions } from './core/nvic';

/**
 * STM32G431RBT6 的器件实现。
 *
 * JIT 按 PC 翻译一条 Thumb/Thumb-2 指令。外设推进、异常派发与 GPIO 引脚意图都**不内联
 * 进指令块**，而是集中在一组固定 PC 的服务块里：
 *
 * 1. 指令块：指令数据通路 → 把本块耗时累加进 `pendingPs` → 若累积到一次节拍、有中断
 *    待扫描、或有延迟的 GPIO 写/引脚刷新，就把 PC 转给对应服务块；最后顶层 `elapse`；
 * 2. 服务块：`SERVICE_TICK` 推进 SysTick 与 USART 并派发中断；`SERVICE_GPIO + port`
 *    执行延迟的 GPIO 寄存器写并刷新该端口；`SERVICE_SYNC` 只刷新标记过的端口。
 *
 * 指令块因此只剩 200 个左右的 IR 操作，整段直接程序能留在 V8 的优化范围内；服务块按
 * 需翻译（只用到 GPIOA 的固件不会付其它端口的代码体积）。块内只用 state 读写、8 位
 * 访存、`if`/`select` 与算术运算。
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

const isServicePc = (pc: number): boolean =>
  pc === SERVICE_TICK || pc === SERVICE_SYNC || (pc >= SERVICE_GPIO && pc < SERVICE_GPIO + 5);

function clockFrequency(value: unknown): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_CLOCK_FREQUENCY &&
    value <= MAX_CLOCK_FREQUENCY
    ? Math.round(value)
    : DEFAULT_CLOCK_FREQUENCY;
}

function createMachine(frequency: number): Machine {
  return {
    clockFrequency: frequency,
    cyclePs: Math.max(1, Math.round(PICOSECONDS_PER_SECOND / frequency)),
    alternateDrivers: usartDrivers(),
  };
}

/**
 * 每个块只把耗时累加进 `pendingPs`，再和 `tickPs` 比一次；越过粒度、或有中断待扫描、
 * 或有延迟的 GPIO 写/引脚刷新时，把 PC 转给对应的服务块。
 *
 * 粒度由 `refreshTick` 依据外设配置维护：空闲时放大到 64 µs，SysTick 周期或 USART 位
 * 时长更短时自动收紧，因此指令块里不再需要判断「要不要按时间推进」。
 */
function tick(machine: Machine, b: Body, cyclePs: number): void {
  const pending = b.add(b.readState(PENDING_PS, types.number), num(b, cyclePs));
  // 没有需要按时间推进的外设时，时间累积本身没有意义，跳过服务块。
  const due = boolAnd(
    b,
    b.greaterThanOrEqual(pending, b.readState(TICK_PS, types.number)),
    b.readState(TICK_ACTIVE, types.bool),
  );
  const unmasked = b.equal(types.number, b.readState('primask', types.number), num(b, 0));
  const irqUp = boolAnd(b, b.readState(IRQ_DIRTY, types.bool), unmasked);
  const pinUp = b.notEqual(types.number, b.readState(GPIO_SYNC, types.number), num(b, 0));
  const wrote = b.notEqual(types.number, b.readState(GPIO_WRITE, types.number), num(b, 0));

  b.writeState(PENDING_PS, pending);
  b.if(boolOr(b, boolOr(b, due, irqUp), boolOr(b, pinUp, wrote)), (service) => {
    const body = asBody(service);

    // 引擎在块体之前已经把 pc 写成顺序后继（或分支目标），它就是服务块要回到的位置。
    body.writeState(SERVICE_RESUME, body.readState('pc', types.number));
    body.if(
      wrote,
      (hit) => {
        const scope = asBody(hit);

        scope.writeState(
          'pc',
          scope.add(
            num(scope, SERVICE_GPIO),
            gpioPortOf(scope, scope.readState(GPIO_WRITE_ADDR, types.number)),
          ),
        );
      },
      (next) => {
        const scope = asBody(next);

        scope.if(
          pinUp,
          (pins) => {
            asBody(pins).writeState('pc', num(asBody(pins), SERVICE_SYNC));
          },
          (tick) => {
            asBody(tick).writeState('pc', num(asBody(tick), SERVICE_TICK));
          },
        );
      },
    );
  });
}

/**
 * 服务块。三种入口共用同一套尾部（跳回保存的 PC）：
 * - `SERVICE_TICK`：把累积的时间交给 SysTick 与 USART，并派发中断；
 * - `SERVICE_GPIO + port`：执行延迟的 GPIO 寄存器写并刷新该端口的引脚意图；
 * - `SERVICE_SYNC`：只刷新标记过的端口（USART 使能/复用变化）。
 *
 * 每个服务块都是独立 PC，只有真正被跳转到时才会翻译。结尾是 `elapse(0)`，因此永远
 * 不会进入直接后端。
 */
function buildService(machine: Machine, pc: number): BlockIR {
  const builder = createJitBlockBuilder();

  builder.instruction({ pc, nextPc: pc }, (body) => {
    const resume = body.readState(SERVICE_RESUME, types.number);
    const taken = body.local(types.bool, false);

    if (pc === SERVICE_TICK) {
      const pending = body.readState(PENDING_PS, types.number);

      body.writeState(PENDING_PS, num(body, 0));
      body.if(body.greaterThan(pending, num(body, 0)), (step) => {
        const scope = asBody(step);

        scope.if(scope.readState(SYSTICK_ON, types.bool), (running) => {
          advanceSystick(asBody(running), pending);
        });
        scope.if(
          scope.notEqual(types.number, scope.readState(TX_MASK, types.number), num(scope, 0)),
          (sending) => {
            advanceUsart(asBody(sending), pending);
          },
        );
      });
      body.if(body.readState(IRQ_DIRTY, types.bool), (dirty) => {
        const scope = asBody(dirty);

        scope.if(
          scope.equal(types.number, scope.readState('primask', types.number), num(scope, 0)),
          (allowed) => {
            const inner = asBody(allowed);

            inner.setLocal(taken, dispatchExceptions(inner, resume));
          },
        );
      });
    } else if (pc === SERVICE_SYNC) {
      syncMarkedPorts(body);
    } else {
      const port = pc - SERVICE_GPIO;
      const address = body.readState(GPIO_WRITE_ADDR, types.number);
      const value = body.readState(GPIO_WRITE_VALUE, types.number);
      const size = body.readState(GPIO_WRITE_SIZE, types.number);
      const offset = gpioOffsetOf(body, address);

      body.if(
        body.equal(types.number, size, num(body, 1)),
        (byte) => {
          writeGpioPort(asBody(byte), port, offset, 1, value);
        },
        (half) => {
          const next = asBody(half);

          next.if(
            next.equal(types.number, size, num(next, 2)),
            (two) => {
              writeGpioPort(asBody(two), port, offset, 2, value);
            },
            (word) => {
              writeGpioPort(asBody(word), port, offset, 4, value);
            },
          );
        },
      );
      body.writeState(GPIO_WRITE, num(body, 0));
      body.if(boolBit(body, body.readState(GPIO_SYNC, types.number), 1 << port), (sync) => {
        const scope = asBody(sync);

        syncPort(scope, port, scope.readState(GPIO_PIN_MASK, types.number));
        scope.writeState(GPIO_PIN_MASK, num(scope, 0));
        scope.writeState(
          GPIO_SYNC,
          scope.bitAnd(scope.readState(GPIO_SYNC, types.number), num(scope, ~(1 << port))),
        );
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

/** 刷新所有被标记的端口，然后清空标记。 */
function syncMarkedPorts(b: Body): void {
  for (let port = 0; port < 5; port += 1) {
    b.if(boolBit(b, b.readState(GPIO_SYNC, types.number), 1 << port), (mark) => {
      // 非 CPU 写触发的刷新（USART 复用/使能）没有引脚位信息，按整端口处理。
      syncPort(asBody(mark), port, num(asBody(mark), 0xffff));
    });
  }
  b.writeState(GPIO_SYNC, num(b, 0));
}

function cacheKey(
  code: JitTranslateInput['code'],
  pc: number,
  size: number,
  cyclePs: number,
): string {
  let bytes = '';

  for (let offset = 0; offset < size; offset += 1)
    bytes += (code[(pc + offset) & 0x1ffff] ?? 0).toString(16);

  return `${cyclePs}:${pc}:${bytes}`;
}

const blockCache = new Map<string, BlockIR>();
const BLOCK_CACHE_LIMIT = 8192;

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
): { counter: string; cycles: number } | undefined {
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
  return { counter: `r${register}`, cycles: 2 * cyclePs };
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
function foldSpin(b: Body, cycles: number, total: Local<number>): void {
  const pending = b.readState(PENDING_PS, types.number);
  const busy = boolOr(
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
  );
  b.if(boolAnd(b, b.readState(TICK_ACTIVE, types.bool), b.not(busy)), (free) => {
    const scope = asBody(free);
    const room = scope.subtract(
      scope.subtract(scope.readState(TICK_PS, types.number), pending),
      num(scope, cycles),
    );
    scope.if(scope.greaterThanOrEqual(room, num(scope, cycles)), (enough) => {
      const inner = asBody(enough);
      const extra = inner.multiply(
        inner.floor(inner.divide(room, num(inner, cycles))),
        num(inner, cycles),
      );

      inner.writeState(PENDING_PS, inner.add(pending, extra));
      inner.setLocal(total, inner.add(num(inner, cycles), extra));
    });
  });
}

const createTranslate =
  (machine: Machine, delays: Map<number, { counter: string; cycles: number }>): JitTranslate =>
  (input) => {
    const pc = input.pc >>> 0;
    const service = isServicePc(pc);
    const fetchPc = pc & 0x1ffff;
    const instruction = service ? undefined : decode(input.code, fetchPc);
    if (instruction !== undefined) {
      const declared = delayLoopAt(input.code, fetchPc, pc, instruction.size, machine.cyclePs);
      if (declared !== undefined) delays.set(pc, declared);
    }
    const key = service
      ? `service:${machine.cyclePs}:${pc}`
      : cacheKey(input.code, fetchPc, instruction!.size, machine.cyclePs);
    const cached = blockCache.get(key);

    if (cached !== undefined) return cached;

    const block = activateMachine(machine, () => {
      if (service) return buildService(machine, pc);

      const builder = createJitBlockBuilder();
      const cycles = instruction!.cycles * machine.cyclePs;
      const spins = selfBranchAt(input.code, fetchPc, pc, instruction!.size);

      builder.instruction({ pc, nextPc: (pc + instruction!.size) >>> 0 }, (body) => {
        const total = spins ? body.local(types.number, num(body, cycles)) : undefined;

        body.if(
          body.readState('halted', types.bool),
          () => {},
          (run) => {
            const scope = asBody(run);

            instruction!.emit(scope, pc);
            if (total !== undefined) foldSpin(scope, cycles, total);
            tick(machine, scope, cycles);
          },
        );
        body.elapse(total === undefined ? num(body, cycles) : body.getLocal(total));
      });

      return builder.finish();
    });

    if (blockCache.size >= BLOCK_CACHE_LIMIT) blockCache.delete(blockCache.keys().next().value!);
    blockCache.set(key, block);

    return block;
  };

const create: Factory = (context) => {
  const frequency = clockFrequency(context.props.clockFrequency);
  const machine = createMachine(frequency);
  const firmware = context.props.firmware;

  const delays = new Map<number, { counter: string; cycles: number }>();
  context.attachJit({
    entry: 'cpu',
    code: CODE,
    pc: 'pc',
    translate: createTranslate(machine, delays),
    delays,
  });

  if (firmware !== undefined && firmware.length > 0) context.loadBytes(CODE, firmware.slice());

  return {
    sync(batch) {
      for (const message of batch.outputs.uart1Tx)
        context.topics.publish('serial1.tx', message.value);
      for (const message of batch.outputs.uart2Tx)
        context.topics.publish('serial2.tx', message.value);
      for (const message of batch.outputs.uart3Tx)
        context.topics.publish('serial3.tx', message.value);
      for (const message of batch.outputs.fault) context.topics.publish('fault', message.value);
    },
    dispose() {},
  };
};

export default create;
