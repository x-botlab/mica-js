import type { Clock, Peripheral } from './types';
import { ports } from './ports';
import { createTimer } from './timer';
import { createUart } from './uart';
import { createAdc } from './adc';
import { createPca } from './pca';
import { createSpi } from './spi';
import { createIap } from './iap';
import { createWatchdog } from './watchdog';
import { createExtint } from './extint';
import { createClockControl } from './clock';

/**
 * 外设装配。
 *
 * 数组顺序同时决定同一 SFR 写入后各钩子的执行顺序：时钟与端口在前，定时器/串口等
 * 依赖它们状态的外设随后。此文件由协调者维护，外设模块不要覆盖。
 */
export function createPeripherals(clock: Clock): readonly Peripheral[] {
  return [
    createClockControl(),
    ports,
    createTimer(clock),
    createUart(),
    createExtint(),
    createAdc(clock),
    createPca(),
    createSpi(clock),
    createIap(clock),
    createWatchdog(),
  ];
}

/**
 * 读之前必须先把累积时间推进给外设的 SFR。
 *
 * 固件只能通过 SFR 与引脚看到外设的随时间变化；引脚是即时采样的，所以这里列出的
 * 是「外设在时间上产生」的那部分：计数器、请求标志、移位缓冲、捕获值。读别的 SFR
 * （ACC/PSW/IE 之类）不触发推进，否则每条算术指令都会带上整段推进代码。
 */
export const SYNC_ON_READ: ReadonlySet<number> = new Set([
  0x87, // PCON（LVDF）
  0x88, // TCON（TF0/TF1/IE0/IE1）
  0x8a, // TL0
  0x8b, // TL1
  0x8c, // TH0
  0x8d, // TH1
  0x98, // SCON（RI/TI）
  0x99, // SBUF
  0x9a, // S2CON
  0x9b, // S2BUF
  0xbc, // ADC_CONTR（ADC_FLAG）
  0xc1, // WDT_CONTR（WDT_FLAG）
  0xcd, // SPSTAT
  0xcf, // SPDAT
  0xd6, // T2H
  0xd7, // T2L
  0xd8, // CCON（CF）
  0xe9, // CL
  0xea, // CCAP0L
  0xeb, // CCAP1L
  0xec, // CCAP2L
  0xf9, // CH
  0xfa, // CCAP0H
  0xfb, // CCAP1H
  0xfc, // CCAP2H
]);
