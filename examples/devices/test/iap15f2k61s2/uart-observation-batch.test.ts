import { describe, expect, it } from 'vitest';
import { assemble } from '../../../ct107d/test/fixtures/8051/assemble.ts';
import { createSourceHarness } from './source-harness.ts';
import type { SourceHarness } from './source-harness.ts';

/**
 * Coarse `runUntil` lossless observation regression.
 *
 * Before the capacity fix the UART output channels held 16 messages, so one coarse
 * run could retain only the tail of a 49/100-byte stream. The channel now matches the
 * SerialLog window; these cases assert the public event stream and readSerial cursor
 * agree after a single large batch, and that chunked runs produce the same stream.
 */

const CLOCK = 12_000_000;
const CYCLE_PS = Math.round(1e12 / CLOCK);
const BIT_PS = { 1200: 10_000 * CYCLE_PS, 9600: 1_252 * CYCLE_PS } as const;
type Baud = keyof typeof BIT_PS;

interface SerialMethods {
  readSerial(params: { readonly channel: string; readonly cursor: number }): {
    readonly start: number;
    readonly end: number;
    readonly dropped: number;
    readonly data: Uint8Array;
  };
  getSerialStatus(params: { readonly channel: string }): {
    readonly capacity: number;
    readonly oldest: number;
    readonly next: number;
    readonly droppedTotal: number;
  };
}

function firmware(values: readonly number[], baud: Baud): Uint8Array {
  const divisor = BIT_PS[baud] / (4 * CYCLE_PS);
  const reload = 0x1_0000 - divisor;
  const sends = values
    .map(
      (value, index) => `
      MOV SBUF,#${value.toString(16).toUpperCase()}H
    wait${index}:
      JNB TI,wait${index}
      CLR TI
    `,
    )
    .join('');

  return assemble(`
    ORG 0x0000
    LJMP main
    ORG 0x0100
  main:
    MOV SCON,#40H
    MOV TMOD,#00H
    MOV AUXR,#40H
    MOV TH1,#${(reload >> 8).toString(16).toUpperCase()}H
    MOV TL1,#${(reload & 0xff).toString(16).toUpperCase()}H
    SETB TR1
${sends}
  done:
    SJMP done
  `);
}

interface Capture {
  readonly events: number[];
  readonly status: ReturnType<SerialMethods['getSerialStatus']>;
  readonly chunk: ReturnType<SerialMethods['readSerial']>;
  readonly harness: SourceHarness;
  dispose(): void;
}

async function capture(
  values: readonly number[],
  baud: Baud,
  targetPs: number,
  chunkPs?: number,
): Promise<Capture> {
  const harness = await createSourceHarness({
    firmware: firmware(values, baud),
    clockFrequency: CLOCK,
    samplePeriodPs: 1_000_000,
  });
  const events: number[] = [];
  const subscription = harness.board.topics.onDidReceive(({ topic, payload }) => {
    if (topic === 'uart1Tx') events.push(...(payload as Uint8Array));
  });

  try {
    if (chunkPs === undefined) harness.board.runUntil(targetPs);
    else {
      while (harness.board.time < targetPs) {
        harness.board.runUntil(Math.min(targetPs, harness.board.time + chunkPs));
      }
    }

    const instance = (
      harness.board as unknown as {
        readonly instances: readonly {
          readonly adapter?: { readonly methods?: SerialMethods };
        }[];
      }
    ).instances[0];
    const methods = instance?.adapter?.methods;

    if (methods === undefined) throw new Error('missing SerialLog methods');

    return {
      events,
      status: methods.getSerialStatus({ channel: 'uart1Tx' }),
      chunk: methods.readSerial({ channel: 'uart1Tx', cursor: 0 }),
      harness,
      dispose() {
        subscription.dispose();
        harness.dispose();
      },
    };
  } catch (cause) {
    subscription.dispose();
    harness.dispose();
    throw cause;
  }
}

function assertLossless(capture: Capture, values: readonly number[], label: string): void {
  expect(capture.events, label).toEqual(values);
  expect(capture.status, label).toMatchObject({
    capacity: 4096,
    oldest: 0,
    next: values.length,
    droppedTotal: 0,
  });
  expect(capture.chunk, label).toMatchObject({
    start: 0,
    end: values.length,
    dropped: 0,
  });
  expect([...capture.chunk.data], label).toEqual(values);
  expect(capture.harness.faults).toEqual([]);
}

const HIGH_RATE_FIRMWARE = assemble(`
  ORG 0x0000
  LJMP main
  ORG 0x0100
main:
  MOV SCON,#40H
  MOV AUXR,#05H
  MOV 0D7H,#0FFH
  MOV 0D6H,#0FFH
  MOV R6,#16
outer:
  MOV R7,#0
inner:
  MOV SBUF,#55H
wait:
  JNB TI,wait
  CLR TI
  DJNZ R7,inner
  DJNZ R6,outer
  MOV SBUF,#55H
waitLast:
  JNB TI,waitLast
  CLR TI
done:
  SJMP done
`);

async function highRateHarness(): Promise<SourceHarness> {
  return createSourceHarness({
    firmware: HIGH_RATE_FIRMWARE,
    clockFrequency: 1_000_000,
    samplePeriodPs: 200_000,
  });
}

describe('UART coarse-batch observation', () => {
  it('9600 单次 runUntil 保留 100 字节，chunked 结果一致', async () => {
    const values = Array.from({ length: 100 }, (_, index) => (index * 37 + 11) & 0xff);
    const duration = Math.round((values.length * 10 + 2) * BIT_PS[9600]);
    const single = await capture(values, 9600, duration);
    const chunked = await capture(values, 9600, duration, 10_000_000_000);

    try {
      assertLossless(single, values, 'single batch');
      assertLossless(chunked, values, 'chunked batch');
      expect(chunked.events).toEqual(single.events);
      expect([...chunked.chunk.data]).toEqual([...single.chunk.data]);
      expect(chunked.status).toEqual(single.status);
    } finally {
      single.dispose();
      chunked.dispose();
    }
  });

  it('1200 单次 runUntil 保留完整 49 字节报告流', async () => {
    const values = Array.from({ length: 49 }, (_, index) => (index * 53 + 7) & 0xff);
    const duration = Math.round((values.length * 10 + 2) * BIT_PS[1200]);
    const run = await capture(values, 1200, duration);

    try {
      assertLossless(run, values, '1200 report');
    } finally {
      run.dispose();
    }
  });
  it('跨多个 batch 的 4097 字节流保留最后 4096 并准确报告 dropped', async () => {
    const harness = await highRateHarness();
    const events: number[] = [];
    const subscription = harness.board.topics.onDidReceive(({ topic, payload }) => {
      if (topic === 'uart1Tx') events.push(...(payload as Uint8Array));
    });

    try {
      while (harness.board.time < 400_000_000_000) {
        harness.board.runUntil(Math.min(400_000_000_000, harness.board.time + 50_000_000_000));
      }
      const instance = (
        harness.board as unknown as {
          readonly instances: readonly {
            readonly adapter?: { readonly methods?: SerialMethods };
          }[];
        }
      ).instances[0];
      const methods = instance?.adapter?.methods;

      if (methods === undefined) throw new Error('missing SerialLog methods');

      const chunk = methods.readSerial({ channel: 'uart1Tx', cursor: 0 });
      const status = methods.getSerialStatus({ channel: 'uart1Tx' });

      expect(harness.faults).toEqual([]);
      expect(events).toHaveLength(4097);
      expect(status).toEqual({ capacity: 4096, oldest: 1, next: 4097, droppedTotal: 1 });
      expect(chunk).toMatchObject({ start: 1, end: 4097, dropped: 1 });
      expect([...chunk.data]).toEqual(events.slice(1));
    } finally {
      subscription.dispose();
      harness.dispose();
    }
  });

  it('单次 batch 4097 字节超过观察窗口时精确触发 CHANNEL_OVERFLOW', async () => {
    const harness = await highRateHarness();
    const diagnostics: Array<{ readonly code: string; readonly message: string }> = [];
    const subscription = harness.board.onDidError((diagnostic) => {
      diagnostics.push({ code: diagnostic.code, message: diagnostic.message });
    });
    let failure: unknown;

    try {
      harness.board.runUntil(400_000_000_000);
    } catch (cause) {
      failure = cause;
    } finally {
      subscription.dispose();
    }

    try {
      // 不能只匹配 /overflow/：意外抛出的其它 SimulationError 也必须让本用例失败。
      expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('CHANNEL_OVERFLOW');

      if (failure !== undefined) {
        expect(failure).toMatchObject({
          code: 'CHANNEL_OVERFLOW',
          message: expect.stringContaining('overflow'),
        });
      }

      const overflow = diagnostics.find((diagnostic) => diagnostic.code === 'CHANNEL_OVERFLOW');
      expect(overflow?.message).toContain('overflow');
    } finally {
      harness.dispose();
    }
  });
});
