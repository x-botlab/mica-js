import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import {
  ANALOG,
  ANALOG_SIZE,
  APSR_T,
  CAN,
  CAPTURE,
  CAPTURE_HEAD,
  CAPTURE_OVERFLOW,
  CAPTURE_PENDING,
  CAPTURE_RESUME,
  CAPTURE_SIZE,
  CAPTURE_TAIL,
  CODE,
  CPU_CYCLE_PS,
  CRC,
  CRC_SIZE,
  DMA,
  DMA_SIZE,
  EXTI,
  EXTI_SIZE,
  FLASH_STATE_MEMORY,
  GENERIC,
  GENERIC_SIZE,
  GPIO_PIN_MASK,
  GPIO_POWERED,
  GPIO_SYNC,
  GPIO_WRITE,
  I2C,
  I2C_SIZE,
  IRQ_DIRTY,
  NOW_PS,
  PENDING_PS,
  PERIPH,
  PERIPH_ACTIVE,
  PERIPH_SLOT_COUNT,
  RNG,
  RNG_SIZE,
  SERIAL,
  SERIAL_SIZE,
  SERVICE_MASK,
  SERVICE_RESUME,
  SPI,
  SPI_SIZE,
  SYSCFG,
  SYSCFG_SIZE,
  SYS,
  SYSTICK_COUNT,
  SYSTICK_CTRL,
  SYSTICK_LOAD,
  SYSTICK_ON,
  SYSTICK_PENDING,
  SYSTICK_VAL,
  TIM,
  TIM_SIZE,
  TICK_ACTIVE,
  TICK_PS,
  TX_MASK,
  UCPD,
  USB,
  WATCHDOG,
  WATCHDOG_SIZE,
  gpioAfr0State,
  gpioAfr1State,
  gpioLockState,
  gpioLockStepState,
  gpioModerState,
  gpioOdrState,
  gpioOtyperState,
  gpioPupdrState,
  gpioSimpleOutState,
  periphDeadlineState,
  txState,
} from './layout';
import {
  asBody,
  bool,
  markService,
  num,
  readWordAt,
  writeReg,
  writeSp,
  writeWord,
  writeWordAt,
} from './ir';
import type { Body } from './ir';
import { SERVICE_IRQ } from './layout';
import { FPCCR_RESET, FPU_FPCCR } from './fpu-layout';
import { syncPort } from './gpio';
import { RCC_RESET_FLAGS_CLEARED_STATE, RCC_RESET_FLAGS_STATE, recordRccResetFlags } from './rcc';
import { machine } from './machine';
import {
  RESET_CAUSE,
  RESET_COUNT,
  RESET_HELD,
  RESET_REQUEST,
  SERVICE_RESET_PC,
} from './system-layout';

/**
 * NRST / SYSRESETREQ 共用的复位入口。
 *
 * `applyReset` 清 CPU 寄存器、异常状态、NVIC/SCB、SysTick/USART、GPIO 影子与外设寄存器，
 * 再从 Flash 向量表重新取 SP/PC；**不写 code（Flash 固件保留）**，**不清 SRAM/CCM**
 * （Cortex-M 复位保留 SRAM 内容）。GPIO 复位后重新发布为输入/高阻意图。
 *
 * 中央启动钩子负责把 NRST 电平变化转到 `SERVICE_RESET_PC`，并在该服务块调用
 * `serviceReset(body, resume)`。NRST 保持低电平时本函数只维持停机状态；释放后执行
 * 完整复位，不回到旧 `resume`。CPU 侧的 AIRCR.SYSRESETREQ 通过 `requestReset` 进入
 * 同一 `applyReset`。
 */

/** 复位原因：NRST 引脚、AIRCR.SYSRESETREQ、AIRCR.VECTRESET。 */
export const RESET_CAUSE_PIN = 1;
export const RESET_CAUSE_SYSRESETREQ = 2;
export const RESET_CAUSE_VECTRESET = 3;
export const RESET_CAUSE_OBL_LAUNCH = 4;
export const RESET_CAUSE_IWDG = 5;
export const RESET_CAUSE_WWDG = 6;
/** 兼容旧名：明确等价于 IWDG，不再让 WWDG 复用 5。 */
export const RESET_CAUSE_WATCHDOG = RESET_CAUSE_IWDG;

/** flash.ts 私有标记 `flashState[0xfc]`：控制器复位但保留选项字节。 */
export const FLASH_RESET_MARKER = 0x464c_5352;

/** 模块状态复位钩子；中央可注册 `resetModuleStates`（TIM/DMA 等 STATE_SPECS）。 */
export type ResetHook = (b: Body) => void;

const resetHooks: ResetHook[] = [];

export function registerResetHook(hook: ResetHook): void {
  if (!resetHooks.includes(hook)) resetHooks.push(hook);
}

const WORD = 4;

const readSys = (b: Body, offset: number): Value<number> => readWordAt(b, SYS, offset);
const writeSys = (b: Body, offset: number, value: Value<number>): void => {
  writeWordAt(b, SYS, offset, value);
};

/** 用运行期循环清零一个 memory；服务块冷路径，IR 体积与大小无关。 */
function clearMemory(b: Body, memory: string, bytes: number): void {
  const offset = b.local(types.number, 0);

  b.while(
    (test) => test.lessThan(test.getLocal(offset), test.constant(types.number, bytes)),
    (body) => {
      const scope = asBody(body);

      writeWord(scope, memory, scope.getLocal(offset), num(scope, 0));
      scope.setLocal(offset, scope.add(scope.getLocal(offset), num(scope, WORD)));
    },
  );
}

function clearState(b: Body, name: string, value: number | boolean): void {
  if (typeof value === 'boolean') b.writeState(name, bool(b, value));
  else b.writeState(name, num(b, value));
}

function clearGpio(b: Body): void {
  for (let port = 0; port < 5; port += 1) {
    clearState(b, gpioModerState(port), 0);
    clearState(b, gpioOtyperState(port), 0);
    clearState(b, gpioPupdrState(port), 0);
    clearState(b, gpioAfr0State(port), 0);
    clearState(b, gpioAfr1State(port), 0);
    clearState(b, gpioOdrState(port), 0);
    clearState(b, gpioSimpleOutState(port), 0);
    clearState(b, gpioLockState(port), 0);
    clearState(b, gpioLockStepState(port), 0);
  }

  clearState(b, GPIO_SYNC, 0);
  clearState(b, GPIO_PIN_MASK, 0);
  clearState(b, GPIO_POWERED, false);
  clearState(b, GPIO_WRITE, 0);
}

function clearUsart(b: Body): void {
  for (let index = 1; index <= 3; index += 1) {
    for (const field of ['Active', 'Remaining', 'Queue', 'Count', 'Period'] as const)
      clearState(b, txState(index, field), 0);
    clearState(b, txState(index, 'Publish'), -1);
  }
  clearState(b, TX_MASK, 0);
}

function clearSysTick(b: Body): void {
  clearState(b, SYSTICK_CTRL, 0);
  clearState(b, SYSTICK_LOAD, 0);
  clearState(b, SYSTICK_VAL, 0);
  clearState(b, SYSTICK_COUNT, 0);
  clearState(b, SYSTICK_PENDING, 0);
  clearState(b, SYSTICK_ON, false);
}

function clearScheduling(b: Body): void {
  clearState(b, PENDING_PS, 0);
  if (machine().dynamicClock === true)
    b.writeState(CPU_CYCLE_PS, num(b, machine().cyclePs));
  clearState(b, TICK_PS, 1_000_000_000_000);
  clearState(b, TICK_ACTIVE, false);
  clearState(b, SERVICE_MASK, 0);
  clearState(b, SERVICE_RESUME, 0);
  if (machine().dynamicClock === true) {
    clearState(b, CAPTURE_HEAD, 0);
    clearState(b, CAPTURE_TAIL, 0);
    clearState(b, CAPTURE_PENDING, 0);
    clearState(b, CAPTURE_OVERFLOW, 0);
    clearState(b, CAPTURE_RESUME, 0);
  }
  clearState(b, IRQ_DIRTY, false);
  clearState(b, 'pollContinue', false);
  clearState(b, 'itState', 0);
  clearState(b, 'halted', false);
  clearState(b, 'faultPc', 0);
  clearState(b, PERIPH_ACTIVE, 0);
  for (let slot = 0; slot < PERIPH_SLOT_COUNT; slot += 1)
    clearState(b, periphDeadlineState(slot), 0);
}

/** 完整 MCU 复位。调用方已经决定进入复位（NRST 释放或软件复位）。 */
export function applyReset(b: Body): void {
  const count = readSys(b, RESET_COUNT);
  const cause = readSys(b, RESET_CAUSE);
  // RCC_CSR flags 的持久区在 SYS 0x14/0x18，清 SYS 前保存，写完 cause/count 后
  // 交 rcc.recordRccResetFlags 追加本次 cause；RMVF 清除标记不自动补 POR。
  const rccFlags = readSys(b, RCC_RESET_FLAGS_STATE);
  const rccFlagsCleared = readSys(b, RCC_RESET_FLAGS_CLEARED_STATE);
  // RCC_BDCR 属备份域，NRST/SYSRESETREQ 不应清 LSE/RTC 选择与 RTCEN。
  const backupDomain = readWordAt(b, PERIPH, 0x90);

  // 外设寄存器与模块私有状态。未建模外设的 generic 后备也清掉，避免复位后读到旧值。
  clearMemory(b, PERIPH, 0x1000);
  clearMemory(b, EXTI, EXTI_SIZE);
  clearMemory(b, SYSCFG, SYSCFG_SIZE);
  clearMemory(b, ANALOG, ANALOG_SIZE);
  clearMemory(b, I2C, I2C_SIZE);
  clearMemory(b, SPI, SPI_SIZE);
  clearMemory(b, TIM, TIM_SIZE);
  clearMemory(b, SERIAL, SERIAL_SIZE);
  clearMemory(b, DMA, DMA_SIZE);
  clearMemory(b, CRC, CRC_SIZE);
  clearMemory(b, RNG, RNG_SIZE);
  // RTC 寄存器/日历在备份域，系统复位保留。
  clearMemory(b, WATCHDOG, WATCHDOG_SIZE);
  // Flash 选项字节/写保护跨复位保留；只写“控制器已复位”标记，下一次 Flash 访问
  // 由 flash.ts 的 ensureInitialized 重置 ACR/SR/CR/ECCR，不动 OPTR/WRP/PCROP/SEC1R。
  writeWordAt(b, FLASH_STATE_MEMORY, 0xfc, num(b, FLASH_RESET_MARKER));
  writeWordAt(b, PERIPH, 0x90, backupDomain);
  // FPU 扩展未启用，但 FPCCR 的 ASPEN/LSPEN 复位值必须真实；FPSCR 随 periph 清零。
  writeWordAt(b, PERIPH, FPU_FPCCR, num(b, FPCCR_RESET));
  clearMemory(b, GENERIC, GENERIC_SIZE);
  clearMemory(b, USB, 0x800);
  if (machine().dynamicClock === true) clearMemory(b, CAPTURE, CAPTURE_SIZE);
  clearMemory(b, CAN, 0x800);
  clearMemory(b, UCPD, 0x100);
  // NVIC/SCB 与异常内部状态。
  clearMemory(b, SYS, 0x200);

  // Flash 保留；SRAM/CCM 按 Cortex-M 复位策略保留。

  for (let register = 0; register < 13; register += 1) writeReg(b, register, num(b, 0));
  writeSp(b, readWordAt(b, CODE, 0));
  clearState(b, 'lr', 0xffffffff);
  clearState(b, 'apsr', APSR_T);
  clearState(b, 'primask', 0);
  b.writeState('pc', b.bitAnd(readWordAt(b, CODE, 4), num(b, 0xfffffffe)));

  clearGpio(b);
  clearUsart(b);
  clearSysTick(b);
  clearScheduling(b);

  // 释放所有 GPIO：影子已清零，整端口重发 intent（输入/浮空或下拉）。
  for (let port = 0; port < 5; port += 1) syncPort(b, port, num(b, 0xffff));

  writeSys(b, RESET_REQUEST, num(b, 0));
  writeSys(b, RESET_HELD, num(b, 0));
  writeSys(b, RCC_RESET_FLAGS_STATE, rccFlags);
  writeSys(b, RCC_RESET_FLAGS_CLEARED_STATE, rccFlagsCleared);
  writeSys(b, RESET_CAUSE, cause);
  writeSys(b, RESET_COUNT, b.add(count, num(b, 1)));
  recordRccResetFlags(b);
  for (const hook of resetHooks) hook(b);
}

/** 请求一次软件复位；真正执行在异常派发边界，避免在一条指令中间重写 PC。 */
export function requestReset(b: Body, cause: number): void {
  // 统一 reset sink：标记 request，异常边界执行 applyReset。先停掉时间外设/模块槽，
  // 避免中央调度器把本拍路由到外设推进而饿死异常派发。
  writeSys(b, RESET_REQUEST, num(b, 1));
  writeSys(b, RESET_CAUSE, num(b, cause));
  b.writeState(SYSTICK_ON, bool(b, false));
  b.writeState(TX_MASK, num(b, 0));
  b.writeState(PERIPH_ACTIVE, num(b, 0));
  b.writeState(IRQ_DIRTY, bool(b, true));
  markService(b, SERVICE_IRQ);
}

export function resetPending(b: Body): Value<boolean> {
  return b.notEqual(types.number, readSys(b, RESET_REQUEST), num(b, 0));
}

export function resetHeld(b: Body): Value<boolean> {
  return b.notEqual(types.number, readSys(b, RESET_HELD), num(b, 0));
}

/** NRST 是否被明确拉低；浮空/未知按内部上拉视为未复位。 */
export function nrstLow(b: Body): Value<boolean> {
  return b.equal(
    types.logic,
    b.field(b.readSample('NRST'), 'level'),
    b.constant(types.logic, types.logic.members.low),
  );
}

/**
 * `SERVICE_RESET_PC` 服务块的主体。
 *
 * 返回 true 表示本次服务已经接管 PC（保持低电平或执行了复位），调用方不得再写回
 * 旧 `resume`。低电平保持期间调用方应以 1 ms 左右的步长推进时间，避免仿真空转。
 */
export function serviceReset(b: Body, resume: Value<number>): Value<boolean> {
  const taken = b.local(types.bool, false);

  b.if(nrstLow(b), (low) => {
    const scope = asBody(low);

    writeSys(scope, RESET_HELD, num(scope, 1));
    scope.writeState('halted', bool(scope, true));
    scope.writeState('pc', num(scope, SERVICE_RESET_PC));
    scope.setLocal(taken, bool(scope, true));
  }, (high) => {
    const scope = asBody(high);

    scope.if(resetHeld(scope), (held) => {
      const inner = asBody(held);

      applyReset(inner);
      inner.setLocal(taken, bool(inner, true));
    }, (normal) => {
      const inner = asBody(normal);

      inner.writeState('pc', resume);
    });
  });

  return b.getLocal(taken);
}

/** 软件复位执行点：在异常派发/服务边界调用。 */
export function applyPendingReset(b: Body): void {
  writeSys(b, RESET_REQUEST, num(b, 0));
  applyReset(b);
}

export { SERVICE_RESET_PC };
