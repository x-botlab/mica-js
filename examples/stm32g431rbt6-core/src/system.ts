import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import {
  APSR_T,
  IRQ_DIRTY,
  SERVICE_IRQ,
  SYS,
} from './layout';
import {
  asBody,
  markService,
  num,
  readApsr,
  readReg,
  readWordAt,
  syncIrqService,
  writeReg,
  writeWordAt,
} from './ir';
import type { Body } from './ir';
import { CPU_HIDDEN_EVENT } from './exclusive';
import {
  readBasepri,
  readControl,
  readFaultmask,
  readMsp,
  readPrimask,
  readPsp,
  readScb,
  registerExceptionEntryHook,
  writeBasepri,
  writeControl,
  writeFaultmask,
  writeMsp,
  writePrimask,
  writePsp,
} from './nvic';
import { beginWait, clearWait } from './wait';

/**
 * 系统指令：屏障、低功耗与特殊寄存器。
 *
 * 单核、无弱内存重排的 IR 下，DMB/DSB/ISB 是真实的 no-op：所有访存按发射顺序执行，宿主
 * 也没有可观察的乱序。WFI/WFE 本身只表达阻塞语义：有 pending 请求/event 时落到下一条，
 * 否则 PC 停在当前指令；真正的低功耗与时间推进由中央注册的 JitPolling（见 `wait.ts` 与
 * `/tmp/opencode/g431-cpu-wait-contract.md`）复用现有 SERVICE_TICK 完成，CPU 内不自旋、
 * 也不伪造 `elapse`。WFE 的 event 存在 `sys` 隐藏区：SEV 置位，WFE 执行时消费。
 *
 * MSP/PSP/CONTROL/BASEPRI/FAULTMASK 的存储与切换规则由 nvic 的隐藏状态维护；本模块只
 * 负责 MRS/MSR 的字段掩码，不复制第二份栈规则。
 */

const APSR_READ_MASK = 0xf80f0000;
const APSR_NZCVQ = 0xf8000000;
const APSR_GE = 0x000f0000;

/**
 * 任何异常入口都清 WFI/WFE 等待标记。异常栈里的返回地址已由中央在
 * `dispatchExceptions` 前用 `waitExceptionReturnPc` 选为等待指令的 nextPC。
 */
registerExceptionEntryHook(clearWait);

/** 特殊寄存器号（MRS/MSR 的 sysm）。 */
const SYSM_APSR = 0;
const SYSM_IPSR = 5;
const SYSM_MSP = 8;
const SYSM_PSP = 9;
const SYSM_PRIMASK = 16;
const SYSM_BASEPRI = 17;
const SYSM_FAULTMASK = 19;
const SYSM_CONTROL = 20;

export function isSystemRegisterSupported(sysm: number): boolean {
  return (
    sysm === SYSM_APSR ||
    sysm === SYSM_IPSR ||
    sysm === SYSM_MSP ||
    sysm === SYSM_PSP ||
    sysm === SYSM_PRIMASK ||
    sysm === SYSM_BASEPRI ||
    sysm === SYSM_FAULTMASK ||
    sysm === SYSM_CONTROL
  );
}

/** MRS：返回 false 表示 sysm 无法实现（调用方报告 fault）。 */
export function emitMrs(b: Body, h2: number): boolean {
  const rd = (h2 >> 8) & 0xf;
  const sysm = h2 & 0xff;

  if (sysm === SYSM_APSR) {
    writeReg(b, rd, b.bitAnd(readApsr(b), num(b, APSR_READ_MASK)));

    return true;
  }

  if (sysm === SYSM_IPSR) {
    // IPSR = ICSR.VECTACTIVE；读 SCB 的 ICSR 与 NVIC 的 active 栈保持同一份事实。
    writeReg(b, rd, b.bitAnd(readScb(b, num(b, 0x04), 4), num(b, 0x1ff)));

    return true;
  }

  if (sysm === SYSM_MSP) {
    writeReg(b, rd, readMsp(b));

    return true;
  }

  if (sysm === SYSM_PSP) {
    writeReg(b, rd, readPsp(b));

    return true;
  }

  if (sysm === SYSM_PRIMASK) {
    writeReg(b, rd, b.bitAnd(readPrimask(b), num(b, 1)));

    return true;
  }

  if (sysm === SYSM_BASEPRI) {
    writeReg(b, rd, readBasepri(b));

    return true;
  }

  if (sysm === SYSM_FAULTMASK) {
    writeReg(b, rd, b.bitAnd(readFaultmask(b), num(b, 1)));

    return true;
  }

  if (sysm === SYSM_CONTROL) {
    writeReg(b, rd, readControl(b));

    return true;
  }

  return false;
}

/** MSR：APSR_nzcvq/_g、IPSR 只读、MSP/PSP/PRIMASK/BASEPRI/FAULTMASK/CONTROL。 */
export function emitMsr(b: Body, h1: number, h2: number): boolean {
  const rn = h1 & 0xf;
  const sysm = h2 & 0xff;
  const mask = (h2 >> 10) & 3;
  const value = readReg(b, rn);

  if (sysm === SYSM_APSR) {
    if (mask === 0) return false;

    const apsr = readApsr(b);
    const withNzcvq =
      mask & 2
        ? b.bitOr(b.bitAnd(apsr, num(b, ~APSR_NZCVQ)), b.bitAnd(value, num(b, APSR_NZCVQ)))
        : apsr;
    const withGe =
      mask & 1
        ? b.bitOr(b.bitAnd(withNzcvq, num(b, ~APSR_GE)), b.bitAnd(value, num(b, APSR_GE)))
        : withNzcvq;

    b.writeState('apsr', b.bitOr(withGe, num(b, APSR_T)));

    return true;
  }

  if (sysm === SYSM_MSP) {
    writeMsp(b, value);

    return true;
  }

  if (sysm === SYSM_PSP) {
    writePsp(b, value);

    return true;
  }

  if (sysm === SYSM_PRIMASK) {
    writePrimask(b, value);
    syncIrqService(b);

    return true;
  }

  if (sysm === SYSM_BASEPRI) {
    writeBasepri(b, value);

    return true;
  }

  if (sysm === SYSM_FAULTMASK) {
    writeFaultmask(b, value);

    return true;
  }

  if (sysm === SYSM_CONTROL) {
    writeControl(b, value);

    return true;
  }

  // IPSR 只读；其余 sysm 不可写。
  return false;
}

const EVENT = CPU_HIDDEN_EVENT;

const loadEvent = (b: Body) => readWordAt(b, SYS, EVENT);
const storeEvent = (b: Body, value: number): void => {
  writeWordAt(b, SYS, EVENT, num(b, value));
};

/**
 * WFI/WFE 的等待入口。
 *
 * `irqDirty` 只表示“需要扫描异常”，不表示已有真实 IRQ：这里先写等待标记并停在当前
 * PC，让现有的 SERVICE_TICK/DISPATCH 去判定；只有 `dispatchExceptions` 真正取走异常
 * 时才通过异常栈返回 nextPC。没有真实 IRQ 时服务尾回到等待 PC，不会伪唤醒。
 */
function emitWait(b: Body, pc: number, nextPc: number, event: Value<boolean> | undefined): void {
  const irq = b.readState(IRQ_DIRTY, types.bool);

  const enter = (body: Body): void => {
    beginWait(body, pc, nextPc);
    body.writeState('pc', num(body, pc));
    // dirty 只是扫描触发；没有真实 IRQ 时 DISPATCH 会回到 pc。
    body.if(irq, (scan) => markService(asBody(scan), SERVICE_IRQ));
  };

  if (event === undefined) {
    enter(b);
    return;
  }

  b.if(event, (hit) => {
    const body = asBody(hit);

    // WFE event 在 WFE 执行时消费；这是立即唤醒，不进入等待。
    storeEvent(body, 0);
    clearWait(body);
    body.writeState('pc', num(body, nextPc));
    // 若同时有 dirty/真实 IRQ，仍让批次尾扫描一次；无 IRQ 时服务尾回 nextPc。
    body.if(irq, (scan) => markService(asBody(scan), SERVICE_IRQ));
  }, (wait) => enter(asBody(wait)));
}

/** WFI：有真实 pending 中断时由 DISPATCH 唤醒；否则停在当前 PC。 */
export function emitWaitForInterrupt(b: Body, pc: number, nextPc: number): void {
  emitWait(b, pc, nextPc, undefined);
}

/** WFE：event 置位时消费并继续；否则等待真实中断/event。 */
export function emitWaitForEvent(b: Body, pc: number, nextPc: number): void {
  emitWait(b, pc, nextPc, b.notEqual(types.number, loadEvent(b), num(b, 0)));
}

/** SEV：单核也维护 event 寄存器；WFE 消费它。 */
export function emitSendEvent(b: Body): void {
  storeEvent(b, 1);
}

/** YIELD 是调度提示；单核模拟没有同级线程，语义上是 no-op。 */
export const emitYield = (_b: Body): void => {
  void _b;
};

/** DMB/DSB/ISB/NOP.W/CLREX 等屏障在顺序 IR 下没有可观察效果。 */
export const emitBarrier = (_b: Body): void => {
  void _b;
};
