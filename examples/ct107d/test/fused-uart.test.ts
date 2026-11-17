import { describe, expect, it } from 'vitest';
import { assemble } from './fixtures/8051/assemble.ts';
import { createFusedCt107dBoard } from '../bench/fused.ts';

/**
 * Fused CT107D UART 端到端：probe 数字行为与 MCU 共用同一份融合模型。
 *
 * 这些用例依赖统一构建窗口生成的 device/dist，不在 source-only 阶段运行。
 * probe 的波特率由 fused `uartBaud` 属性配置，不再常量折叠成 9600。
 */

const CLOCK = 12_000_000;
const CYCLES = { 1200: 10_000, 4800: 2_500, 9600: 1_252 } as const;
type Baud = keyof typeof CYCLES;
const bitPs = (baud: Baud): number => CYCLES[baud] * Math.round(1e12 / CLOCK);

function setup(baud: Baud, receive: boolean): string {
  const value = 0x1_0000 - CYCLES[baud] / 4;

  return `
    MOV SCON,#${receive ? '50H' : '40H'}
    MOV TMOD,#00H
    MOV AUXR,#40H
    MOV TH1,#${(value >> 8).toString(16).toUpperCase()}H
    MOV TL1,#${(value & 0xff).toString(16).toUpperCase()}H
    SETB TR1
  `;
}

function transmit(baud: Baud, values: readonly number[], irq = false): Uint8Array {
  const body = values
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
    ${irq ? 'ORG 0x0023\nCLR TI\nRETI' : ''}
    ORG 0x0100
  main:
${setup(baud, false)}
    ${irq ? 'SETB ES\nSETB EA' : ''}
${body}
  done:
    SJMP done
  `);
}

function receive(baud: Baud): Uint8Array {
  return assemble(`
    ORG 0x0000
    LJMP main
    ORG 0x0100
  main:
${setup(baud, true)}
  loop:
    JNB RI,loop
    MOV A,SBUF
    MOV P2,A
    CLR RI
    SJMP loop
  `);
}

async function boot(baud: Baud, firmware: Uint8Array) {
  const fused = await createFusedCt107dBoard({
    firmware,
    props: { clockFrequency: CLOCK, uartBaud: baud },
  });
  const uartTx: number[] = [];
  const uartRx: number[] = [];
  const probeTx: number[] = [];
  const probeRx: number[] = [];
  const subscription = fused.board.topics.onDidReceive((message) => {
    if (message.topic === 'uart1.tx')
      uartTx.push(...(message.payload as { data: Uint8Array }).data);
    else if (message.topic === 'uart1.rx')
      uartRx.push(...(message.payload as { data: Uint8Array }).data);
    else if (message.topic === 'bytes') {
      const value = message.payload as { designator: string; port: string; data: Uint8Array };

      if (value.designator === 'UART_PROBE' && value.port === 'tx') probeTx.push(...value.data);
      if (value.designator === 'UART_PROBE' && value.port === 'rx') probeRx.push(...value.data);
    }
  });

  return {
    fused,
    uartTx,
    uartRx,
    probeTx,
    probeRx,
    run(ms: number) {
      fused.board.runUntil(fused.board.time + Math.round(ms * 1_000_000_000));
    },
    dispose() {
      subscription.dispose();
      fused.dispose();
    },
  };
}

describe('fused CT107D UART 1200/4800/9600', () => {
  it.each([1200, 4800, 9600] as const)(
    '%d baud：MCU 发送帧由同源 probe 复原，uart1Tx 与 probeTx 一致',
    async (baud) => {
      const payload = [0x00, 0xff, 0x55, 0xaa];
      const runtime = await boot(baud, transmit(baud, payload));

      try {
        runtime.run((payload.length * 10 * bitPs(baud)) / 1_000_000_000 + 5);
        expect(runtime.fused.faults).toEqual([]);
        expect(runtime.uartTx).toEqual(payload);
        expect(runtime.probeTx).toEqual(payload);
      } finally {
        runtime.dispose();
      }
    },
  );

  it('1200 完整 49 字节报告流与 9600 100 字节背靠背在单次 coarse runUntil 下无损', async () => {
    for (const [baud, length] of [
      [1200, 49],
      [9600, 100],
    ] as const) {
      const payload = Array.from({ length }, (_, index) => (index * 41 + 5) & 0xff);
      const runtime = await boot(baud, transmit(baud, payload));

      try {
        runtime.run((payload.length * 10 * bitPs(baud)) / 1_000_000_000 + 20);
        expect(runtime.fused.faults, `${baud} faults`).toEqual([]);
        expect(runtime.uartTx, `${baud} uart1Tx`).toEqual(payload);
        expect(runtime.probeTx, `${baud} probeTx`).toEqual(payload);
      } finally {
        runtime.dispose();
      }
    }
  });

  it('SERVICE 内接受 UART IRQ 时，probe 仍复原完整帧（nested redirect commit）', async () => {
    const runtime = await boot(9600, transmit(9600, [0x5a], true));

    try {
      runtime.run(10);
      expect(runtime.fused.faults).toEqual([]);
      expect(runtime.uartTx).toEqual([0x5a]);
      expect(runtime.probeTx).toEqual([0x5a]);
    } finally {
      runtime.dispose();
    }
  });

  it.each([1200, 4800, 9600] as const)(
    '%d baud：sendUart 注入经 fused probe 进入 MCU RXD，uart1Rx/probeRx 一致',
    async (baud) => {
      const payload = new Uint8Array([0x00, 0xff, 0x5a]);
      const runtime = await boot(baud, receive(baud));

      try {
        runtime.run(1);
        runtime.fused.methods.sendUart!({ data: payload });
        runtime.run((payload.length * 10 * bitPs(baud)) / 1_000_000_000 + 5);
        expect(runtime.fused.faults).toEqual([]);
        expect(runtime.uartRx).toEqual([...payload]);
        expect(runtime.probeRx).toEqual([...payload]);
      } finally {
        runtime.dispose();
      }
    },
  );
});
