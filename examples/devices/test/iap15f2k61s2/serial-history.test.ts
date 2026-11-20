import { describe, expect, it } from 'vitest';
import { SerialLog } from '../../shared/serial.ts';
import { run } from './harness.ts';

/**
 * 串口历史的游标、容量与副本语义。
 *
 * 公开方法由清单生成的 `DeviceMethods` 约束；这里用运行时校验后的结构化视图读取，
 * 覆盖实时输出进入历史后的完整状态，以及调用方修改返回值不影响后续查询。
 */

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

function methodsOf(value: unknown): SerialMethods {
  if (value === null || typeof value !== 'object') throw new Error('Missing model methods');

  const record = value as Record<string, unknown>;

  if (typeof record.readSerial !== 'function' || typeof record.getSerialStatus !== 'function')
    throw new Error('Model methods do not match the manifest');

  return value as SerialMethods;
}

/** 模式 1、T2 作波特率发生器：发送 55H 后等待 TI 并停机。 */
const UART_SEND_55 = Uint8Array.from([
  0x75,
  0x98,
  0x40, // SCON = 40H（模式 1）
  0x75,
  0x8e,
  0x05, // AUXR = 05H（S1ST2、T2x12）
  0x75,
  0xd7,
  0xf6, // T2L = F6H
  0x75,
  0xd6,
  0xff, // T2H = FFH
  0x75,
  0x99,
  0x55, // SBUF = 55H
  0x30,
  0x99,
  0xfd, // JNB TI,$
  0x80,
  0xfe, // SJMP $
]);

describe('SerialLog', () => {
  it('固定容量保留最新字节，并报告请求游标已丢失的数量', () => {
    const log = new SerialLog(8);
    const first = log.append(Uint8Array.from([0, 1, 2, 3, 4]));
    const second = log.append(Uint8Array.from([5, 6, 7, 8, 9]));

    expect(first.cursor).toBe(0);
    expect(second.cursor).toBe(5);
    expect(log.status()).toEqual({ capacity: 8, oldest: 2, next: 10, droppedTotal: 2 });

    const stale = log.read(0);

    expect(stale.start).toBe(2);
    expect(stale.end).toBe(10);
    expect(stale.dropped).toBe(2);
    expect([...stale.data]).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);

    const current = log.read(7);

    expect(current).toMatchObject({ start: 7, end: 10, dropped: 0 });
    expect([...current.data]).toEqual([7, 8, 9]);
  });

  it('一次性追加超过容量时只保留尾部并累计丢弃数', () => {
    const log = new SerialLog(4);

    log.append(Uint8Array.from([1, 2, 3, 4, 5, 6]));

    expect(log.status()).toEqual({ capacity: 4, oldest: 2, next: 6, droppedTotal: 2 });
    expect([...log.read(0).data]).toEqual([3, 4, 5, 6]);
    expect(log.read(0).dropped).toBe(2);
    expect(log.read(6).data).toHaveLength(0);
  });

  it('读取结果是独立副本', () => {
    const log = new SerialLog(4);

    log.append(Uint8Array.from([1, 2, 3]));

    const first = log.read(0);

    first.data[0] = 0xff;

    expect([...log.read(0).data]).toEqual([1, 2, 3]);
  });
});

describe('公开串口查询', () => {
  it('发送字节后可按游标读取历史，状态与容量来自同一实例', async () => {
    const result = await run({ firmware: UART_SEND_55, milliseconds: 2 });
    const methods = methodsOf(result.methods);

    expect(result.faults).toEqual([]);

    const status = methods.getSerialStatus({ channel: 'uart1Tx' });

    expect(status).toEqual({ capacity: 4096, oldest: 0, next: 1, droppedTotal: 0 });

    const chunk = methods.readSerial({ channel: 'uart1Tx', cursor: 0 });

    expect(chunk).toMatchObject({ start: 0, end: 1, dropped: 0 });
    expect([...chunk.data]).toEqual([0x55]);

    chunk.data[0] = 0x00;
    expect([...methods.readSerial({ channel: 'uart1Tx', cursor: 0 }).data]).toEqual([0x55]);

    const empty = methods.readSerial({ channel: 'uart1Tx', cursor: 1 });

    expect(empty.start).toBe(1);
    expect(empty.end).toBe(1);
    expect(empty.dropped).toBe(0);
    expect(empty.data).toHaveLength(0);
  });

  it('未知通道与非法游标返回可恢复的 MethodError', async () => {
    const result = await run({ milliseconds: 0 });
    const methods = methodsOf(result.methods);
    const cases = [
      {
        code: 'serial/unknown-channel',
        call: () => methods.getSerialStatus({ channel: 'uart9Tx' }),
      },
      {
        code: 'serial/unknown-channel',
        call: () => methods.readSerial({ channel: 'uart9Tx', cursor: 0 }),
      },
      {
        code: 'serial/invalid-cursor',
        call: () => methods.readSerial({ channel: 'uart1Tx', cursor: -1 }),
      },
      {
        code: 'serial/invalid-cursor',
        call: () => methods.readSerial({ channel: 'uart1Tx', cursor: 1.5 }),
      },
    ];

    for (const entry of cases) {
      let failure: unknown;

      try {
        entry.call();
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({ name: 'MethodError', code: entry.code });
    }
  });
});
