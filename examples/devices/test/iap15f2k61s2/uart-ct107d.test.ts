import { describe, expect, it } from 'vitest';
import { assemble } from '../../../ct107d/test/fixtures/8051/assemble.ts';
import { createSourceHarness } from './source-harness.ts';
import type { SourceHarness } from './source-harness.ts';

/**
 * CT107D 课程波特率下的 UART1 产品回归。
 *
 * 12 MHz 时钟、T1 1T 16 位模式，重装值直接取自课程源码：
 * - 9600：TH1/TL1 = FE/C7，位时间 1252 个系统时钟；
 * - 4800：FD/8F，2500 个系统时钟；
 * - 1200：F6/3C，10000 个系统时钟。
 *
 * 发送侧独立按位中点采样 P3.1 并对照公开 `uart1Tx` 事件；接收侧用独立 bit driver
 * 驱动 P3.0，对照公开 `uart1Rx` 事件。两种方向都不经过 uart-probe 的采样器。
 */

const CYCLES_PER_BIT = { 1200: 10_000, 4800: 2_500, 9600: 1_252 } as const;
type Baud = keyof typeof CYCLES_PER_BIT;
const BAUDS: readonly Baud[] = [1200, 4800, 9600];

const CLOCK = 12_000_000;
const CYCLE_PS = Math.round(1e12 / CLOCK);
const bitPs = (baud: Baud): number => CYCLES_PER_BIT[baud] * CYCLE_PS;
const reload = (baud: Baud): { readonly hi: number; readonly lo: number } => {
  const divisor = CYCLES_PER_BIT[baud] / 4;
  const value = 0x1_0000 - divisor;

  return { hi: value >> 8, lo: value & 0xff };
};

interface Capture {
  readonly rx: number[][];
  readonly tx: Array<{ readonly at: number; readonly value: number }>;
  readonly harness: SourceHarness;
  dispose(): void;
}

async function boot(
  firmware: Uint8Array,
  execution: 'throughput' | 'precise' = 'throughput',
  drive = false,
): Promise<Capture> {
  const harness = await createSourceHarness({
    firmware,
    clockFrequency: CLOCK,
    observe: ['P3_1'],
    drive: drive ? ['P3_0'] : [],
    samplePeriodPs: 1_000_000,
    execution,
  });
  const rx: number[][] = [];
  const tx: Array<{ at: number; value: number }> = [];
  const subscription = harness.board.topics.onDidReceive(({ topic, payload }) => {
    if (topic === 'uart1Tx')
      tx.push({ at: harness.board.time, value: [...(payload as Uint8Array)][0]! });
    else if (topic === 'uart1Rx') rx.push([...(payload as Uint8Array)]);
  });

  return {
    rx,
    tx,
    harness,
    dispose() {
      subscription.dispose();
      harness.dispose();
    },
  };
}

function uartSetup(baud: Baud, receive: boolean): string {
  const value = reload(baud);

  return `
    MOV SCON,#${receive ? '50H' : '40H'}
    MOV TMOD,#00H
    MOV AUXR,#40H
    MOV TH1,#${value.hi.toString(16).toUpperCase()}H
    MOV TL1,#${value.lo.toString(16).toUpperCase()}H
    SETB TR1
  `;
}

function transmitFirmware(baud: Baud, values: readonly number[]): Uint8Array {
  let body = '';

  values.forEach((value, index) => {
    body += `
      MOV SBUF,#${value.toString(16).toUpperCase()}H
    wait${index}:
      JNB TI,wait${index}
      CLR TI
    `;
  });

  return assemble(`
    ORG 0x0000
    LJMP main
    ORG 0x0100
  main:
${uartSetup(baud, false)}
${body}
  done:
    SJMP done
  `);
}

function receiveFirmware(baud: Baud): Uint8Array {
  return assemble(`
    ORG 0x0000
    LJMP main
    ORG 0x0100
  main:
${uartSetup(baud, true)}
  loop:
    JNB RI,loop
    MOV A,SBUF
    MOV P2,A
    CLR RI
    SJMP loop
  `).slice();
}

function frameLevels(value: number): readonly (0 | 1)[] {
  const levels: (0 | 1)[] = [0];

  for (let bit = 0; bit < 8; bit += 1) levels.push(((value >> bit) & 1) as 0 | 1);
  levels.push(1);

  return levels;
}

function findStart(capture: Capture, from: number, limit: number, step: number): number {
  for (let at = from; at <= limit; at += step) {
    capture.harness.board.runUntil(at);
    if (capture.harness.level('P3_1') === 0) return at;
  }

  return -1;
}

function sampleTransmit(
  capture: Capture,
  values: readonly number[],
  baud: Baud,
): { readonly levels: number[][]; readonly start: number } {
  const bit = bitPs(baud);
  const step = Math.max(1_000_000, Math.floor(bit / 16));
  const start = findStart(capture, capture.harness.board.time, 20 * bit, step);

  if (start < 0) throw new Error(`no UART start edge at ${baud}`);

  const levels: number[][] = [];
  let cursor = start;

  for (let sent = 0; sent < values.length; sent += 1) {
    const frame: number[] = [];

    for (let index = 0; index < 10; index += 1) {
      const at = Math.round(cursor + (index + 0.5) * bit);
      capture.harness.board.runUntil(at);
      frame.push(capture.harness.level('P3_1'));
    }

    levels.push(frame);
    cursor += 10 * bit;
  }

  return { levels, start };
}

function driveFrame(capture: Capture, value: number, start: number, baud: Baud): number {
  const bit = bitPs(baud);

  frameLevels(value).forEach((level, index) => {
    capture.harness.drive('P3_0', level);
    capture.harness.board.runUntil(Math.round(start + (index + 1) * bit));
  });

  return start + 10 * bit;
}

describe('CT107D UART1 1200/4800/9600 产品时序', () => {
  it('三种课程波特率发送连续字节，独立 bit driver 与 uart1Tx 事件一致', async () => {
    const payload = [0x00, 0xff, 0x55, 0xaa];

    for (const baud of BAUDS) {
      const capture = await boot(transmitFirmware(baud, payload));
      try {
        const { levels, start } = sampleTransmit(capture, payload, baud);
        const bit = bitPs(baud);

        for (let index = 0; index < payload.length; index += 1) {
          expect(levels[index], `${baud} baud frame ${index}`).toEqual(
            frameLevels(payload[index]!),
          );
        }

        // 最后一个停止位结束后才发布最后一条事件。
        capture.harness.board.runUntil(Math.round(start + (payload.length * 10 + 2) * bit));
        expect(capture.tx.map((entry) => entry.value)).toEqual(payload);
        // 每个事件在完整停止位结束后发布；首帧事件应落在起始沿后约 10 个位时间。
        expect(capture.tx[0]!.at - start).toBeGreaterThanOrEqual(10 * bit - 2 * bit);
        expect(capture.tx[0]!.at - start).toBeLessThanOrEqual(10 * bit + 2 * bit);
        expect(capture.harness.faults).toEqual([]);
      } finally {
        capture.dispose();
      }
    }
  });

  it('接收方向：1200/4800/9600 都复原 0x00、0xFF 与背靠背帧', async () => {
    const payload = [0x00, 0xff, 0x55, 0xaa];

    for (const baud of BAUDS) {
      const capture = await boot(receiveFirmware(baud), 'throughput', true);
      try {
        const bit = bitPs(baud);
        capture.harness.drive('P3_0', 1);
        capture.harness.board.runUntil(20 * bit);

        let cursor = Math.round(20 * bit);
        for (const value of payload) cursor = driveFrame(capture, value, cursor, baud);
        capture.harness.board.runUntil(cursor + 2 * bit);

        expect(capture.rx, `${baud} baud RX`).toEqual(payload.map((value) => [value]));
        expect(capture.harness.faults).toEqual([]);
      } finally {
        capture.dispose();
      }
    }
  });

  it('throughput 小步与 precise 大步推进得到相同 UART1 发送事件', async () => {
    const firmware = transmitFirmware(9600, [0x5a]);
    const throughput = await boot(firmware, 'throughput');
    const precise = await boot(firmware, 'precise');

    try {
      const end = 2_000_000_000;
      while (throughput.harness.board.time < end) {
        const next = Math.min(end, throughput.harness.board.time + 100_000_000);
        throughput.harness.board.runUntil(next);
      }
      precise.harness.board.runUntil(end);

      expect(throughput.tx.map((entry) => entry.value)).toEqual([0x5a]);
      expect(precise.tx.map((entry) => entry.value)).toEqual([0x5a]);
      expect(throughput.harness.faults).toEqual([]);
      expect(precise.harness.faults).toEqual([]);
    } finally {
      throughput.dispose();
      precise.dispose();
    }
  });
});
