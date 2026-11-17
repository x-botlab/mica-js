import type { Factory } from './model.ddl';
import { createJitBlockBuilder } from '@mica-js/sdk/model';
import type { BlockIR } from '@mica-js/sdk/model';
import type { JitTranslate, JitTranslateInput } from '@mica-js/sdk/device';
import { CODE, SFR_SBUF, SFR_SCON } from './kernel/ir';
import { InterruptController, watchInterruptEnables } from './kernel/interrupt';
import { activateMachine } from './kernel/machine';
import type { Machine } from './kernel/machine';
import { SfrHooks } from './kernel/sfr-hooks';
import { decode } from './kernel/decode';
import {
  SERVICE_PC,
  SETTLE_PC,
  accumulate,
  buildService,
  buildSettle,
  refreshService,
  settleBeforeInstruction,
  tickTail,
} from './kernel/tick';
import { createPeripherals, SYNC_ON_READ } from './peripherals';
import { canSkipUart1Sync } from './peripherals/uart';
import { readPin, readPort } from './peripherals/ports';
import type { Clock } from './peripherals/types';

/**
 * STC15F2K60S2 系列（IAP15F2K61S2）的器件实现。
 *
 * 内核：`kernel/` 负责取指、译码、PSW/ALU、寻址与中断响应，把一条 8051 指令在翻译期
 * 展开成一条 IR 指令分组。外设：`peripherals/` 负责端口、定时器、串口、ADC、PCA、
 * SPI、IAP/EEPROM 与看门狗；每个外设在指令边界按经过的仿真时间推进，并在 SFR 写入后
 * 更新内部状态，因此不需要运行期操作码表或宿回调。
 *
 * 时间基准：每条指令按 STC15 1T 内核的时钟数 `elapse`，`clockPs` 保存「已经记过时间、
 * 但还没交给外设」的皮秒数；外设按两次节拍之间的时间差换算计数，避免把绝对时间累加进
 * binary64 的大数区间。中断只在指令边界响应，与硬件「当前指令完成后响应」一致。
 */

const DEFAULT_CLOCK_FREQUENCY = 11_059_200;
const MIN_CLOCK_FREQUENCY = 1_000_000;
const MAX_CLOCK_FREQUENCY = 40_000_000;
const PICOSECONDS_PER_SECOND = 1_000_000_000_000;

function clockFrequency(value: unknown): number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= MIN_CLOCK_FREQUENCY &&
    value <= MAX_CLOCK_FREQUENCY
    ? value
    : DEFAULT_CLOCK_FREQUENCY;
}

function createMachine(clock: Clock): Machine {
  const sfr = new SfrHooks();
  const irq = new InterruptController();
  const peripherals = createPeripherals(clock);

  for (const peripheral of peripherals) {
    for (const address of peripheral.writes ?? [])
      if (peripheral.onWrite !== undefined) {
        const hook = peripheral.onWrite.bind(peripheral);

        sfr.onWrite(address, hook);
      }

    for (const address of peripheral.reads ?? [])
      if (peripheral.onRead !== undefined) {
        const hook = peripheral.onRead.bind(peripheral);

        sfr.onRead(address, hook);
      }
  }

  for (const address of [0xa8, 0xb8, 0xb5, 0xb7, 0xb6])
    sfr.onWrite(address, (b, target) => watchInterruptEnables(b, target));

  for (const peripheral of peripherals) irq.register(...(peripheral.interrupts ?? []));

  const timedReads = new Set<number>(SYNC_ON_READ);
  const timedWrites = new Set<number>();
  for (const peripheral of peripherals)
    if (peripheral.id !== 'ports')
      for (const address of peripheral.writes ?? []) timedWrites.add(address);
  // 中断允许/优先级写入会改变可响应性与期限重算时机；它们不在外设 writes 里。
  for (const address of [0xa8, 0xb5, 0xb6, 0xb7, 0xb8]) timedWrites.add(address);

  let accessProbe: { reads: Set<number>; writes: Set<number> } | undefined;
  const machine: Machine = {
    clockFrequency: clock.frequency,
    cyclePs: clock.cyclePs,
    pcState: 'pc',
    sfr,
    irq,
    peripherals,
    ports: { readPort, readPin },
    timedReads,
    timedWrites,
    beginAccessProbe() {
      accessProbe = { reads: new Set(), writes: new Set() };
    },
    endAccessProbe() {
      const probe = accessProbe ?? { reads: new Set<number>(), writes: new Set<number>() };

      accessProbe = undefined;

      return probe;
    },
    noteSfrRead(address) {
      if (sfr.withinHook) return;

      accessProbe?.reads.add(address & 0xff);
    },
    noteSfrWrite(address) {
      if (sfr.withinHook) return;

      accessProbe?.writes.add(address & 0xff);
    },
  };

  // 外设 SFR 写入后立即重算活动门控与期限：门控/期限因此总是最新的，空闲的节拍点
  // 不必进服务块。端口锁存/口模式不参与，写端口时重算只会把整段门控表达式展开进
  // 每个端口写块；这里跳过 ports，端口写入只重算引脚意图。
  for (const peripheral of peripherals)
    if (peripheral.id !== 'ports')
      for (const address of peripheral.writes ?? [])
        sfr.onWrite(address, (b) => refreshService(machine, b));

  // 读时间相关 SFR 的指令由翻译器在指令体之前请求共享结算块（`SETTLE_PC`）：
  // 结算块执行后 `clockPs` 归零，指令再完整执行一次。只读 SCON/SBUF 且 UART1
  // 空闲谓词为真时会跳过这次结算，此时指令直接读当前锁存值，`clockPs` 保留到
  // 下一次服务/结算。这里不能再注册读同步钩子：它会把整段 `advanceDevices`
  // 内联回每个 timed 指令块，抵消共享结算块。

  return machine;
}

/**
 * 外设推进的节拍。
 *
 * 节拍按 PC 选取：`pc % TICK_DIVISOR === 0` 的指令是节拍点。两次节拍之间累积的时间在
 * 节拍点一次性交给外设，计数值与经过的时间仍然精确，只有「谁先看到变化」的粒度变成
 * 若干条指令。中断请求标志也只在节拍处更新，因此中断响应延迟同样以节拍为界。
 *
 * 取值 4 在 11.0592 MHz 下约 0.4–1 µs，对 115200 baud（8.7 µs/位）的串口采样有 8 个以上
 * 采样点；更大的值会让串口接收的位采样变粗，实测 16 已经无法通过串口用例。
 */
const TICK_DIVISOR = 4;

/**
 * 紧循环的回跳块。
 *
 * 节拍按 PC 选取，回跳距离不足 `TICK_DIVISOR` 字节的循环整圈都不会落在节拍边界上
 * （`SJMP $`、`JNB RI,$` 之类），因此这类转移指令每个回跳都是一个节拍点：串口发送
 * 靠它把位边沿细化到一条指令之内。代价是空转循环里外设推进得比直线代码更频繁。
 */
const RELATIVE_BRANCHES: ReadonlyMap<number, { readonly at: number; readonly base: number }> =
  new Map([
    [0x10, { at: 2, base: 3 }], // JBC bit,rel
    [0x20, { at: 2, base: 3 }], // JB bit,rel
    [0x30, { at: 2, base: 3 }], // JNB bit,rel
    [0x40, { at: 1, base: 2 }], // JC rel
    [0x50, { at: 1, base: 2 }], // JNC rel
    [0x60, { at: 1, base: 2 }], // JZ rel
    [0x70, { at: 1, base: 2 }], // JNZ rel
    [0x80, { at: 1, base: 2 }], // SJMP rel
    [0xb4, { at: 2, base: 3 }], // CJNE A,#data,rel
    [0xb5, { at: 2, base: 3 }], // CJNE A,direct,rel
  ]);

const byteAt = (code: JitTranslateInput['code'], offset: number): number =>
  code[offset & 0xffff] ?? 0;

/** 该 PC 处转移指令的目标；不是转移指令时返回 `undefined`。 */
function branchTarget(code: JitTranslateInput['code'], pc: number): number | undefined {
  const opcode = byteAt(code, pc);
  const encoding = RELATIVE_BRANCHES.get(opcode);
  const relative = (at: number, base: number): number => {
    const offset = byteAt(code, pc + at);

    return (pc + base + (offset < 0x80 ? offset : offset - 0x100)) & 0xffff;
  };

  if (encoding !== undefined) return relative(encoding.at, encoding.base);
  if (opcode >= 0xd8 && opcode <= 0xdf) return relative(1, 2); // DJNZ Rn,rel
  if (opcode === 0xd5) return relative(2, 3); // DJNZ direct,rel
  if (opcode >= 0xb6 && opcode <= 0xbf) return relative(2, 3); // CJNE @Ri/#data,rel
  if (opcode === 0x02) return (byteAt(code, pc + 1) << 8) | byteAt(code, pc + 2); // LJMP addr16

  return undefined;
}

/**
 * 该 PC 的块是否推进外设。
 *
 * 节拍点先按 `pc % TICK_DIVISOR` 选取；回跳一律也算节拍点。只按 PC 取点会漏掉整圈
 * 都没有对齐指令的紧循环（例如 8051 的 16 位比较环：0x16 CLR C、0x17 MOV A,direct、
 * 0x19 SUBB、0x1B MOV A,direct、0x1D XRL、0x1F SUBB、0x21 JC 0x16），这类循环里
 * 节拍点一次都不出现，外设推进与中断响应会完全停摆。
 */
function ticksAt(code: JitTranslateInput['code'], pc: number): boolean {
  if (pc % TICK_DIVISOR === 0) return true;

  const target = branchTarget(code, pc);

  return target !== undefined && target <= pc;
}

/**
 * 翻译结果的跨板缓存。
 *
 * 一个块的内容只由「该 PC 处的指令字节」和「系统时钟」决定：外设与内核在内联推进时
 * 只写资源名与常量，不携带实例身份。因此同一段固件在多块板上重复执行时，第二次创建
 * 板可以直接复用已验证、已编译的 `BlockIR`；运行时的编译缓存与块校验都以对象身份为键，
 * 复用同一个对象等于跳过整条翻译链路。
 *
 * 键里带上指令字节，自修改代码改写该指令后自然失效。服务块与结算块位于代码空间之外，
 * 不读指令字节，按角色取键以避免与固件 PC 冲突；容量上限用于约束长固件的内存。
 */
const blockCache = new Map<string, BlockIR>();
const BLOCK_CACHE_LIMIT = 4096;

function cacheKey(
  code: JitTranslateInput['code'],
  pc: number,
  size: number,
  cyclePs: number,
): string {
  if (pc === SERVICE_PC) return `${cyclePs}:service`;
  if (pc === SETTLE_PC) return `${cyclePs}:settle`;

  let bytes = '';

  for (let offset = 0; offset < size; offset += 1)
    bytes += (code[(pc + offset) & 0xffff] ?? 0).toString(16);

  return `${cyclePs}:${pc}:${bytes}`;
}

const createTranslate =
  (machine: Machine, cyclePs: number): JitTranslate =>
  (input) => {
    const pc = input.pc & 0xffff;
    const instruction = pc === SERVICE_PC || pc === SETTLE_PC ? undefined : decode(input.code, pc);
    const key = cacheKey(input.code, pc, instruction?.size ?? 0, cyclePs);
    const cached = blockCache.get(key);

    if (cached !== undefined) return cached;

    const block =
      pc === SETTLE_PC
        ? activateMachine(machine, () => buildSettle(machine))
        : instruction === undefined
          ? activateMachine(machine, () => buildService(machine))
          : translateInstruction(machine, input.code, pc, instruction, cyclePs);

    if (blockCache.size >= BLOCK_CACHE_LIMIT) blockCache.delete(blockCache.keys().next().value!);
    blockCache.set(key, block);

    return block;
  };

/**
 * 时间相关 SFR 访问的结算分类。
 *
 * - `always`：任意 timed 写/读-改-写，或读 SCON/SBUF 之外的 timed SFR；
 * - `uart1`：只读 SCON/SBUF，由 UART1 边沿空闲谓词决定能否跳过结算；
 * - `none`：没有 timed 访问，保持零开销。
 */
type SettleMode = 'always' | 'uart1' | 'none';

function settleMode(
  machine: Machine,
  access: { reads: ReadonlySet<number>; writes: ReadonlySet<number> },
): SettleMode {
  for (const address of access.writes) if (machine.timedWrites.has(address)) return 'always';

  let timedRead = false;
  let uart1Only = true;

  for (const address of access.reads) {
    if (!machine.timedReads.has(address)) continue;

    timedRead = true;
    if (address !== SFR_SCON && address !== SFR_SBUF) uart1Only = false;
  }

  if (!timedRead) return 'none';

  return uart1Only ? 'uart1' : 'always';
}

function translateInstruction(
  machine: Machine,
  code: JitTranslateInput['code'],
  pc: number,
  instruction: ReturnType<typeof decode>,
  cyclePs: number,
): BlockIR {
  const tick = ticksAt(code, pc);

  return activateMachine(machine, () => {
    const build = (settle: SettleMode): BlockIR => {
      const builder = createJitBlockBuilder();

      builder.instruction({ pc, nextPc: (pc + instruction.size) & 0xffff }, (body) => {
        // 读-改-写必须先结算，再读旧字节。待推进时间交给共享结算块处理，指令块本身
        // 不再内联推进；只读 SCON/SBUF 时由 UART1 空闲谓词决定是否省掉这次跳转。
        if (settle === 'always') settleBeforeInstruction(machine, body, pc);
        else if (settle === 'uart1') settleBeforeInstruction(machine, body, pc, canSkipUart1Sync);
        machine.sfr.muted(() => instruction.emit(body));
        body.elapse(instruction.cycles * cyclePs);
        if (tick) tickTail(machine, body, instruction.cycles * cyclePs);
        else accumulate(machine, body, instruction.cycles * cyclePs);
      });

      return builder.finish();
    };

    // 先用真实指令体生成一次，并记录实际访问的 SFR；按分类只重建需要结算的块。
    // 端口写/纯算术等绝大多数块因此只翻译一次。
    machine.beginAccessProbe();

    let draft: BlockIR;
    let access: ReturnType<Machine['endAccessProbe']>;

    try {
      draft = build('none');
    } finally {
      access = machine.endAccessProbe();
    }

    const settle = settleMode(machine, access);

    return settle === 'none' ? draft : build(settle);
  });
}

const create: Factory = (context) => {
  const frequency = clockFrequency(context.props.clockFrequency);
  const cyclePs = Math.max(1, Math.round(PICOSECONDS_PER_SECOND / frequency));
  const clock: Clock = { frequency, cyclePs };
  const machine = createMachine(clock);

  context.attachJit({
    entry: 'cpu',
    code: CODE,
    pc: 'pc',
    translate: createTranslate(machine, cyclePs),
  });

  const firmware = context.props.firmware;

  if (firmware !== undefined && firmware.length > 0) context.loadBytes(CODE, firmware.slice());

  return {
    sync(batch) {
      for (const name of ['uart1Tx', 'uart1Rx'] as const)
        for (const message of batch.outputs[name])
          context.topics.publish(name, message.value.slice());
    },
    dispose() {},
  };
};

export default create;
