import { createJitBlockBuilder, types } from '@mica-js/sdk/model';
import type { BlockIR, Value } from '@mica-js/sdk/model';
import { CLOCK, PERIPH, asBody, jumpToValue, number, periph8, setPeriph8, toCycles } from './ir';
import type { Body } from './ir';
import { IRQ_DIRTY, interruptInstructionComplete } from './interrupt';
import type { Machine } from './machine';
import { TICK_BASE } from '../peripherals/layout';
import type { Advance } from '../peripherals/types';

/**
 * 外设节拍：指令块只累积时间与一个门控，真正的推进集中在共享服务块。
 *
 * 指令块每条指令都要生成，而 JIT 按 PC 缓存块，所以推进代码若内联进每个节拍块，块体积
 * 与翻译成本都随 PC 数量放大，而且只要推进里出现采样或引脚意图，整个块就无法进入直接
 * 后端（直接后端给紧循环两个数量级的加速）。这里因此把推进搬到**一个**固定 PC 的
 * 服务块：
 *
 * - 每个指令块末尾：`clockPs += 本条指令的时钟数`；节拍点再读中断脏标志与活动门控，
 *   所有指令都读 UART1 起始位唤醒，任一条件成立就把 PC 转给服务块；
 * - 服务块（`SERVICE_PC`）：一次性推进全部外设、重算活动门控、派发中断，然后跳回
 *   保存的下一条 PC。它含引脚采样与嵌套 redirect，因此永远不会被直接后端接受。
 *
 * 语义与「每个节拍点内联推进」等价：节拍点位置不变，累积的时间精确到皮秒，中断只在
 * 服务块响应，只是推进发生在触发指令**之后**（返回地址因此是运行期值）；UART 起始位
 * 唤醒可以在任意指令尾部触发服务，不必等下一个节拍点。
 *
 * 读时间相关 SFR 的指令还需要「读旧值之前先结算」。这类指令不再把推进内联进指令块：
 * 有待推进时间时保存当前 PC 常量并转到**共享结算块**（`SETTLE_PC`），由它推进一次，
 * 再回到同一条指令重新执行。指令体、计时与外设写因此都只发生一次。
 */

/**
 * 服务块的 PC。选在 IAP15F2K61S2 的 61 KiB 代码空间之外，固件不会执行到这里。
 */
export const SERVICE_PC = 0xfffe;

/** 前置结算块的 PC。与服务块相邻但在代码空间之外，JIT 缓存按 PC 区分两者。 */
export const SETTLE_PC = 0xfffd;

/** `periph` 里的节拍簿记：活动门控字节与保存的返回 PC（低字节在前）。 */
const BUSY = TICK_BASE;
const SAVED_LOW = TICK_BASE + 1;
const SAVED_HIGH = TICK_BASE + 2;

/** 服务期限 state：初始 0，1 表示下一节拍点服务，正数为相对上次结算的 ps。 */
export const SERVICE_DEADLINE = 'serviceDeadline';
/**
 * UART1 起始位唤醒 state（DDL `uart1Wake`）。
 *
 * 由 P3_0 的下降沿反应置位；内核只在指令尾部读取它来请求服务，清除由 UART 负责。
 */
const UART1_WAKE = 'uart1Wake';
/**
 * `refreshService` 合并期限时使用的「无期限」哨兵。
 *
 * 必须大于所有外设可能返回的正期限。当前最长的是 1 MHz、12T、16 位定时器的
 * 65536 × 12 × 10^6 = 786432000000 ps；1e15 仍在安全整数范围内。
 */
const NO_SERVICE_DEADLINE = 1_000_000_000_000_000;

const nonZero = (b: Body, value: Value<number>): Value<boolean> =>
  b.notEqual(types.number, value, number(b, 0));

/** 共享块要返回的 PC：服务块的下一条指令，或结算块要重新执行的当前指令。 */
const savedPc = (b: Body): Value<number> =>
  b.bitOr(b.shiftLeft(periph8(b, SAVED_HIGH), number(b, 8)), periph8(b, SAVED_LOW));

/**
 * 请求服务块：保存顺序执行后的 PC、记下待推进时间，再转到 `SERVICE_PC`。
 *
 * `pending` 在调用处算好：节拍点与普通指令都会先把本条指令的时钟数累加进去。
 */
const requestService = (machine: Machine, b: Body, pending: Value<number>): void => {
  const next = b.readState(machine.pcState, types.number);

  b.writeState(CLOCK, pending);
  setPeriph8(b, SAVED_LOW, next);
  setPeriph8(b, SAVED_HIGH, b.shiftRightUnsigned(next, number(b, 8)));
  b.writeState(machine.pcState, number(b, SERVICE_PC));
};

/**
 * 指令块末尾：累积本条指令的时间，并在节拍点或 UART 起始位唤醒时转给服务块。
 *
 * 空闲（没有外设可能自行变化、没有待派发的中断、也没有 UART 起始位唤醒）时，累积值
 * 直接清零，因此空闲循环在门控为零时只做少量读取与写入，整块仍可直接编译。
 */
export function tickTail(machine: Machine, b: Body, cyclesPs: number): void {
  // 真实固件指令结束：推进 RETI/IE/IP 写后的中断保护窗口。SERVICE/SETTLE 不走这里。
  const irqEligible = interruptInstructionComplete(b);
  const pending = b.add(b.readState(CLOCK, types.number), number(b, cyclesPs));
  const busy = b.load8(PERIPH, number(b, BUSY));
  const wake = b.readState(UART1_WAKE, types.bool);
  // 保护窗口内保留 dirty，但不能把“仅 dirty”当成额外 service 的理由；否则每个被保护
  // 指令都会多进一次服务块。这里用同一次 hold 读取的结果屏蔽 dirty，外设 busy 与
  // UART 唤醒仍照常触发；dirty 本身不清，窗口结束后下一次 tail 自然重新可见。
  const irq = b.select(
    types.number,
    irqEligible,
    (inner) => asBody(inner).load8(PERIPH, number(asBody(inner), IRQ_DIRTY)),
    (inner) => number(asBody(inner), 0),
  );
  // 只有可响应 IRQ、外设活跃或 UART 起始位唤醒时才需要看期限。空闲轮询路径在 gate==0
  // 处短路，不读期限 state、不做时间比较，也不写非零时间；动态成本与旧实现基本一致。
  b.if(
    b.or(b.notEqual(types.number, b.bitOr(irq, busy), number(b, 0)), () => wake),
    (working) => {
      const w = asBody(working);
      const urgent = w.or(wake, (inner) =>
        asBody(inner).or(
          asBody(inner).notEqual(types.number, irq, number(asBody(inner), 0)),
          (deep) =>
            asBody(deep).greaterThanOrEqual(
              pending,
              asBody(deep).readState(SERVICE_DEADLINE, types.number),
            ),
        ),
      );

      w.if(
        urgent,
        (service) => requestService(machine, asBody(service), pending),
        (keeping) => asBody(keeping).writeState(CLOCK, pending),
      );
    },
    (quiet) => asBody(quiet).writeState(CLOCK, number(asBody(quiet), 0)),
  );
}

/**
 * 非节拍点：累积时间；UART 起始位唤醒时仍需请求服务块。
 *
 * 唤醒不能等到下一个稀疏节拍点：长直线代码可能整段没有节拍点，起始位会被整段吞掉。
 * 这里与节拍点一样保存下一条指令的 PC 并转到服务块；未唤醒时只做一次累加。
 */
export function accumulate(machine: Machine, b: Body, cyclesPs: number): void {
  // 非节拍点同样是一条真实固件指令的结束；保护窗口不能只在节拍点推进。
  interruptInstructionComplete(b);
  const pending = b.add(b.readState(CLOCK, types.number), number(b, cyclesPs));
  const wake = b.readState(UART1_WAKE, types.bool);

  b.if(
    wake,
    (service) => requestService(machine, asBody(service), pending),
    (keeping) => asBody(keeping).writeState(CLOCK, pending),
  );
}

/**
 * 重算活动门控与服务期限。
 *
 * `BUSY` 只表示「是否必须保留待推进时间」；`serviceDeadline` 才表示「何时必须进服务块」。
 * 活跃但没有期限能力的外设按原粒度服务（期限 1），避免把采样敏感路径（串口输入、
 * 外部中断、GATE/外部计数、PCA 捕获等）误当成可以跨过的纯计数。
 *
 * 外设 SFR 写入后与每次推进后各算一次。写入时算一次是为了让门控和期限立刻反映新的
 * 配置；推进后算一次是因为推进本身可能让外设转入或退出活动。
 */
export function refreshService(machine: Machine, b: Body): void {
  // 推进代码内部可能通过 SFR 写钩子再次触发；统一结算结束后由 advanceDevices 调用一次。
  if (advancing > 0) return;

  const one = number(b, 1);
  const zero = number(b, 0);
  const sentinel = number(b, NO_SERVICE_DEADLINE);
  let busy = zero;
  let forced = b.constant(types.bool, false);

  for (const peripheral of machine.peripherals) {
    const active = peripheral.active?.(b);

    if (active === undefined) continue;

    busy = b.bitOr(
      busy,
      b.select(
        types.number,
        active,
        () => one,
        () => zero,
      ),
    );
    if (peripheral.deadline === undefined) forced = b.or(forced, () => active);
  }

  setPeriph8(b, BUSY, busy);
  b.if(
    forced,
    (now) => asBody(now).writeState(SERVICE_DEADLINE, one),
    (rest) => {
      const r = asBody(rest);
      const none = number(r, 0);
      let best = sentinel;

      for (const peripheral of machine.peripherals) {
        if (peripheral.deadline === undefined) continue;

        const candidate = peripheral.deadline(r);
        const normalized = r.select(
          types.number,
          r.equal(types.number, candidate, none),
          () => sentinel,
          () => candidate,
        );

        best = r.min(best, normalized);
      }

      // 没有定时服务时写哨兵而不是 0：tickTail 只做 `pending >= deadline`，
      // 不再为每个节拍点额外判断“是否没有期限”。
      r.writeState(SERVICE_DEADLINE, best);
    },
  );
}

/**
 * 构造节拍服务块：推进外设、重算门控、派发中断、回到保存的 PC。
 *
 * 服务块不做任何计时（`elapse(0)`）：时间已经在指令块里按指令时钟数记过。含嵌套
 * redirect 与引脚采样，因此永远不会进入直接后端。
 */
export function buildService(machine: Machine): BlockIR {
  const builder = createJitBlockBuilder();

  machine.sfr.muted(() =>
    builder.instruction({ pc: SERVICE_PC, nextPc: SERVICE_PC }, (b) => {
      const returnPc = savedPc(b);
      const zero = number(b, 0);

      advanceDevices(machine, b);
      b.if(nonZero(b, b.load8(PERIPH, number(b, IRQ_DIRTY))), (take) => {
        machine.irq.dispatch(asBody(take), returnPc);
      });
      jumpToValue(b, returnPc);
      b.elapse(zero);
    }),
  );

  return builder.finish();
}

/**
 * 构造共享结算块：推进外设一次，然后回到保存的 PC 重新执行当前指令。
 *
 * 进入时 `clockPs` 一定大于 0（指令块只在有待推进时间时才转进来）。这里不派发中断：
 * 中断只能由服务块在指令边界响应，前置结算只负责把外设状态推到当前时刻。`elapse(0)`
 * 保证这次额外块切换不再记时；时间账本已由 `advanceDevices` 清零。
 */
export function buildSettle(machine: Machine): BlockIR {
  const builder = createJitBlockBuilder();

  machine.sfr.muted(() =>
    builder.instruction({ pc: SETTLE_PC, nextPc: SETTLE_PC }, (b) => {
      const returnPc = savedPc(b);

      advanceDevices(machine, b);
      jumpToValue(b, returnPc);
      b.elapse(number(b, 0));
    }),
  );

  return builder.finish();
}

/** 翻译期递归保护：推进代码自己也会读 SFR，不能在推进里再嵌一层推进。 */
let advancing = 0;

/**
 * 把累积的时间交给全部外设，并重算活动门控。
 *
 * 节拍服务块与「读外设 SFR 之前的同步」共用：两者都必须看到完全相同的时间账，否则
 * 计数会重复或丢失。
 */
export function advanceDevices(machine: Machine, b: Body): void {
  if (advancing > 0) return;

  const pending = b.readState(CLOCK, types.number);

  advancing += 1;

  try {
    machine.sfr.muted(() => {
      const advance: Advance = {
        elapsedPs: pending,
        cycles: toCycles(b, pending),
        ticks: b.floor(b.divide(pending, number(b, 1000))),
      };

      b.writeState(CLOCK, number(b, 0));
      b.if(b.greaterThan(pending, number(b, 0)), (step) => {
        for (const peripheral of machine.peripherals) peripheral.advance(asBody(step), advance);
      });
    });
  } finally {
    advancing -= 1;
  }

  // 推进期间外设写钩子里的 refreshService 被 advancing 门控跳过；这里统一重算一次。
  machine.sfr.muted(() => refreshService(machine, b));
}

/**
 * 时间相关 SFR 访问前的结算请求。
 *
 * 必须在指令体第一次读锁存器之前调用：`writeBit`/`ANL TCON` 这类读-改-写会先读旧字节，
 * 若等到写钩子才结算，硬件在结算中置起的 TF 等标志会被旧字节回写覆盖。
 *
 * 有待推进时间时不内联 `advanceDevices`：把当前 PC 常量写进节拍区的返回地址，再转到
 * 共享结算块。本条指令的第一条路径到此终止（不执行指令体、不记时、不写硬件）；结算块
 * 推进一次后跳回同一 PC，此时 `clockPs` 已为 0，指令完整执行一次。`clockPs` 为 0 时
 * 不请求结算，普通 ACC/PSW 访问不会走到这里。
 *
 * 传入 `canSkip` 时，只有谓词为假才请求结算。跳过时既不推进外设，也不清 `clockPs`
 * 或重算期限：待推进时间原样留给下一次服务/结算，指令直接读当前锁存值。
 */
export function settleBeforeInstruction(
  machine: Machine,
  b: Body,
  pc: number,
  canSkip?: (b: Body) => Value<boolean>,
): void {
  if (advancing > 0) return;

  const pending = b.readState(CLOCK, types.number);
  const waiting = b.greaterThan(pending, number(b, 0));
  const settle =
    canSkip === undefined
      ? waiting
      : b.and(waiting, (inner) => asBody(inner).not(canSkip(asBody(inner))));

  b.if(settle, (branch) => {
    const body = asBody(branch);

    setPeriph8(body, SAVED_LOW, number(body, pc & 0xff));
    setPeriph8(body, SAVED_HIGH, number(body, (pc >>> 8) & 0xff));
    body.redirect(number(body, SETTLE_PC), number(body, 0));
  });
}
