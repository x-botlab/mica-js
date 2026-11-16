import { describe, expect, it } from 'vitest';
import { createTestBoard, US } from './harness.ts';

/** 1 MHz 系统时钟、T2 12 分频重载 10：UART 位时间为 40 个系统周期。 */
const BIT_PS = 40 * US;

const UART_BASE = [
  0x75,
  0x8e,
  0x05, // MOV AUXR,#05H：S1ST2=1、T2x12=1
  0x75,
  0xd7,
  0xf6, // MOV T2L,#0F6H
  0x75,
  0xd6,
  0xff, // MOV T2H,#0FFH
];

function bytes(values: readonly unknown[]): number[][] {
  return values.map((value) => Array.from(value as Uint8Array));
}

describe('IAP15F2K61S2 UART1 端口', () => {
  it('发送时每帧只在停止位完成后发布一条单字节消息', async () => {
    const board = await createTestBoard('iap15f2k61s2', {
      props: {
        clockFrequency: 1_000_000,
        firmware: Uint8Array.from([
          0x75,
          0x98,
          0x40, // MOV SCON,#40H：模式 1
          ...UART_BASE,
          0x75,
          0x99,
          0x55, // MOV SBUF,#55H
          0x30,
          0x99,
          0xfd, // JNB TI,$
          0xc2,
          0x99, // CLR TI
          0x75,
          0x99,
          0xaa, // 在停止位尚未结束时写入下一字节
          0x30,
          0x99,
          0xfd, // JNB TI,$
          0x80,
          0xfe, // SJMP $
        ]),
      },
      nets: [
        { id: 'vcc', pins: [{ instance: 'dut', pin: 'VCC' }], voltage: 5 },
        { id: 'gnd', pins: [{ instance: 'dut', pin: 'GND' }], voltage: 0 },
      ],
    });

    try {
      board.run(2_000 * US);

      expect(board.faults).toEqual([]);
      expect(bytes(board.history.uart1Tx ?? [])).toEqual([[0x55], [0xaa]]);
      expect(Array.from(board.topics.uart1Tx as Uint8Array)).toEqual([0xaa]);
      expect(board.history.uart1Rx ?? []).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('接收一帧后把写入接收缓冲的字节发布到 uart1Rx', async () => {
    const board = await createTestBoard('iap15f2k61s2', {
      props: {
        clockFrequency: 1_000_000,
        firmware: Uint8Array.from([
          0x75,
          0x98,
          0x50, // MOV SCON,#50H：模式 1、REN=1
          ...UART_BASE,
          0x30,
          0x98,
          0xfd, // JNB RI,$
          0xe5,
          0x99, // MOV A,SBUF
          0xf5,
          0xa0, // MOV P2,A
          0x80,
          0xfe, // SJMP $
        ]),
      },
      sources: ['src'],
      nets: [
        {
          id: 'vcc',
          pins: [
            { instance: 'dut', pin: 'VCC' },
            { instance: 'src', pin: 'vcc' },
          ],
          voltage: 5,
        },
        {
          id: 'gnd',
          pins: [
            { instance: 'dut', pin: 'GND' },
            { instance: 'src', pin: 'gnd' },
          ],
          voltage: 0,
        },
        {
          id: 'rxd',
          pins: [
            { instance: 'dut', pin: 'P3_0' },
            { instance: 'src', pin: 'y' },
          ],
        },
      ],
    });

    try {
      const value = 0x69;

      board.send('src', 'level', 1); // 空闲高
      board.run(20 * US);

      board.send('src', 'level', 0); // 起始位
      board.run(BIT_PS);

      for (let bit = 0; bit < 8; bit += 1) {
        board.send('src', 'level', (value >> bit) & 1); // LSB first
        board.run(BIT_PS);
      }

      board.send('src', 'level', 1); // 停止位
      board.run(2 * BIT_PS);

      expect(board.faults).toEqual([]);
      expect(bytes(board.history.uart1Rx ?? [])).toEqual([[value]]);
      expect(Array.from(board.topics.uart1Rx as Uint8Array)).toEqual([value]);
      expect(board.history.uart1Tx ?? []).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});
