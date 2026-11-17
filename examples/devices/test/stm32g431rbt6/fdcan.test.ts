import { describe, expect, it } from 'vitest';
import { RCC_RCC_STATE } from '@mica-js/stm32g431rbt6-core/layout';
import { RCC_APB1ENR1 } from '@mica-js/stm32g431rbt6-core/clock-tree';
import { types } from '@mica-js/sdk/model';
import { num, readWordAt, writeWordAt } from '@mica-js/stm32g431rbt6-core/ir';
import type { Body } from '@mica-js/stm32g431rbt6-core/ir';
import type { Value } from '@mica-js/sdk/model';
import {
  FDCAN1_BASE,
  FDCAN1_RAM_BASE,
  FDCAN_CCCR,
  FDCAN_CCCR_CCE,
  FDCAN_CCCR_INIT,
  FDCAN_CCCR_MON,
  FDCAN_CCCR_TEST,
  FDCAN_IE,
  FDCAN_ILE,
  FDCAN_ILS,
  FDCAN_IR,
  FDCAN_IR_RF0N,
  FDCAN_IR_TC,
  FDCAN_NBTP,
  FDCAN_RX0_START,
  FDCAN_RXGFC,
  FDCAN_RXF0S,
  FDCAN_RXF0S_F0FL,
  FDCAN_TEST,
  FDCAN_TEST_LBCK,
  FDCAN_TXBAR,
  FDCAN_TXBTO,
  FDCAN_TX_BUFFER_START,
  advanceFdcan,
  fdcanPending,
  readFdcanAt,
  writeFdcanAt,
} from '@mica-js/stm32g431rbt6-core/fdcan';
import { runFdcanRig } from './fdcan-rig';

const OUT_IR = 0x00;
const OUT_RXF0S = 0x04;
const OUT_TXBTO = 0x08;
const OUT_R0 = 0x0c;
const OUT_R1 = 0x10;
const OUT_T2 = 0x14;
const OUT_T3 = 0x18;
const OUT_ACTIVE = 0x1c;

const write = (b: Body, address: number, value: number): void => {
  writeFdcanAt(b, address, 4, num(b, value));
};
const read = (b: Body, address: number): ReturnType<typeof readFdcanAt> =>
  readFdcanAt(b, address, 4);
const put = (b: Body, offset: number, value: ReturnType<typeof num>): void => {
  writeWordAt(b, 'out', offset, value);
};

const enableFdcanClock = (b: Body): void => {
  writeWordAt(b, 'periph', RCC_RCC_STATE + RCC_APB1ENR1, num(b, 1 << 25));
};

const configureLoopback = (b: Body, filterWord: number): void => {
  enableFdcanClock(b);
  write(b, FDCAN1_BASE + FDCAN_CCCR, FDCAN_CCCR_INIT | FDCAN_CCCR_CCE);
  write(b, FDCAN1_BASE + FDCAN_NBTP, 0x00000b02);
  write(b, FDCAN1_BASE + FDCAN_TEST, FDCAN_TEST_LBCK);
  write(
    b,
    FDCAN1_BASE + FDCAN_CCCR,
    FDCAN_CCCR_INIT | FDCAN_CCCR_CCE | FDCAN_CCCR_TEST | FDCAN_CCCR_MON,
  );
  write(b, FDCAN1_RAM_BASE, filterWord);
  write(b, FDCAN1_BASE + FDCAN_RXGFC, 1 << 16);
  write(b, FDCAN1_BASE + FDCAN_CCCR, FDCAN_CCCR_TEST | FDCAN_CCCR_MON);
  write(b, FDCAN1_BASE + FDCAN_IE, FDCAN_IR_RF0N | FDCAN_IR_TC);
  write(b, FDCAN1_BASE + FDCAN_ILE, 1);
};

const sendStandardFrame = (b: Body): void => {
  const tx = FDCAN1_RAM_BASE + FDCAN_TX_BUFFER_START;

  write(b, tx + 0, 0x123 << 18);
  write(b, tx + 4, 8 << 16);
  write(b, tx + 8, 0x44332211);
  write(b, tx + 12, 0x88776655);
  write(b, FDCAN1_BASE + FDCAN_TXBAR, 1);
  advanceFdcan(b, num(b, 1));
  advanceFdcan(b, num(b, 1_000_000_000));
};

const putFlag = (b: Body, offset: number, value: Value<boolean>): void => {
  put(
    b,
    offset,
    b.select(
      types.number,
      value,
      (inner) => inner.constant(types.number, 1),
      (inner) => inner.constant(types.number, 0),
    ),
  );
};

describe('FDCAN1 内部 loopback（IR rig）', () => {
  it('Tx buffer0 经 11 位标准 filter 进入 Rx FIFO0，并置 TC/RF0N', () => {
    const rig = runFdcanRig({
      build: (b) => {
        writeWordAt(b, 'periph', RCC_RCC_STATE + RCC_APB1ENR1, num(b, 1 << 25));

        // INIT+CCE 下配置，随后进入 TEST+MON 内部 loopback。
        write(b, FDCAN1_BASE + FDCAN_CCCR, FDCAN_CCCR_INIT | FDCAN_CCCR_CCE);
        write(b, FDCAN1_BASE + FDCAN_NBTP, 0x00000b02);
        write(b, FDCAN1_BASE + FDCAN_TEST, FDCAN_TEST_LBCK);
        write(
          b,
          FDCAN1_BASE + FDCAN_CCCR,
          FDCAN_CCCR_INIT | FDCAN_CCCR_CCE | FDCAN_CCCR_TEST | FDCAN_CCCR_MON,
        );

        // 标准 filter #0：classic mask，ID=0x123/mask=0x7ff → FIFO0。
        write(b, FDCAN1_RAM_BASE + 0, (2 << 30) | (1 << 27) | (0x123 << 16) | 0x7ff);
        write(b, FDCAN1_BASE + FDCAN_RXGFC, 1 << 16);
        write(b, FDCAN1_BASE + FDCAN_CCCR, FDCAN_CCCR_TEST | FDCAN_CCCR_MON);
        write(b, FDCAN1_BASE + FDCAN_IE, FDCAN_IR_RF0N | FDCAN_IR_TC);
        write(b, FDCAN1_BASE + FDCAN_ILE, 1);

        const tx = FDCAN1_RAM_BASE + FDCAN_TX_BUFFER_START;

        write(b, tx + 0, 0x123 << 18);
        write(b, tx + 4, 8 << 16);
        write(b, tx + 8, 0x44332211);
        write(b, tx + 12, 0x88776655);
        write(b, FDCAN1_BASE + FDCAN_TXBAR, 1);
        advanceFdcan(b, num(b, 1));
        put(b, OUT_ACTIVE, readWordAt(b, 'can', 0x184));

        advanceFdcan(b, num(b, 1_000_000_000));
        put(b, OUT_IR, read(b, FDCAN1_BASE + FDCAN_IR));
        put(b, OUT_RXF0S, read(b, FDCAN1_BASE + FDCAN_RXF0S));
        put(b, OUT_TXBTO, read(b, FDCAN1_BASE + FDCAN_TXBTO));
        put(b, OUT_R0, read(b, FDCAN1_RAM_BASE + FDCAN_RX0_START));
        put(b, OUT_R1, read(b, FDCAN1_RAM_BASE + FDCAN_RX0_START + 4));
        put(b, OUT_T2, read(b, FDCAN1_RAM_BASE + FDCAN_RX0_START + 8));
        put(b, OUT_T3, read(b, FDCAN1_RAM_BASE + FDCAN_RX0_START + 12));
      },
    });

    try {
      const out = new DataView(rig.memory('out').buffer);

      expect(out.getUint32(OUT_ACTIVE, true)).toBe(1);
      expect(out.getUint32(OUT_IR, true) & FDCAN_IR_TC).toBe(FDCAN_IR_TC);
      expect(out.getUint32(OUT_IR, true) & FDCAN_IR_RF0N).toBe(FDCAN_IR_RF0N);
      expect(out.getUint32(OUT_RXF0S, true) & FDCAN_RXF0S_F0FL).toBe(1);
      expect(out.getUint32(OUT_TXBTO, true) & 1).toBe(1);
      expect(out.getUint32(OUT_R0, true) >>> 18).toBe(0x123);
      expect((out.getUint32(OUT_R1, true) >>> 16) & 0xf).toBe(8);
      expect(out.getUint32(OUT_T2, true)).toBe(0x44332211);
      expect(out.getUint32(OUT_T3, true)).toBe(0x88776655);
    } finally {
      rig.dispose();
    }
  });
  it('IR 按字节 W1C，IE 支持 byte/halfword 部分访问', () => {
    const rig = runFdcanRig({
      build: (b) => {
        configureLoopback(b, (2 << 30) | (1 << 27) | (0x123 << 16) | 0x7ff);
        sendStandardFrame(b);
        put(b, 0x00, read(b, FDCAN1_BASE + FDCAN_IR));
        writeFdcanAt(b, FDCAN1_BASE + FDCAN_IR, 1, num(b, 0x01));
        put(b, 0x04, read(b, FDCAN1_BASE + FDCAN_IR));
        writeFdcanAt(b, FDCAN1_BASE + FDCAN_IE, 1, num(b, 0x81));
        put(b, 0x08, read(b, FDCAN1_BASE + FDCAN_IE));
        writeFdcanAt(b, FDCAN1_BASE + FDCAN_IE, 2, num(b, 0x0281));
        put(b, 0x0c, read(b, FDCAN1_BASE + FDCAN_IE));
      },
    });

    try {
      const out = new DataView(rig.memory('out').buffer);
      const before = out.getUint32(0x00, true);
      const after = out.getUint32(0x04, true);

      expect(before & FDCAN_IR_RF0N).toBe(FDCAN_IR_RF0N);
      expect(after & FDCAN_IR_RF0N).toBe(0);
      expect(after & FDCAN_IR_TC).toBe(FDCAN_IR_TC);
      expect(out.getUint32(0x08, true)).toBe(0x81);
      expect(out.getUint32(0x0c, true)).toBe(0x281);
    } finally {
      rig.dispose();
    }
  });

  it('标准 filter reject 不写 Rx FIFO，ILS/ILE 把 TC 路由到 IT1', () => {
    const rig = runFdcanRig({
      build: (b) => {
        configureLoopback(b, (2 << 30) | (3 << 27) | (0x123 << 16) | 0x7ff);
        sendStandardFrame(b);
        put(b, 0x00, read(b, FDCAN1_BASE + FDCAN_IR));
        put(b, 0x04, read(b, FDCAN1_BASE + FDCAN_RXF0S));
        putFlag(b, 0x08, fdcanPending(b, 0));
        putFlag(b, 0x0c, fdcanPending(b, 1));
        write(b, FDCAN1_BASE + FDCAN_ILS, 0x7f);
        write(b, FDCAN1_BASE + FDCAN_ILE, 2);
        putFlag(b, 0x10, fdcanPending(b, 0));
        putFlag(b, 0x14, fdcanPending(b, 1));
      },
    });

    try {
      const out = new DataView(rig.memory('out').buffer);

      expect(out.getUint32(0x00, true) & FDCAN_IR_TC).toBe(FDCAN_IR_TC);
      expect(out.getUint32(0x00, true) & FDCAN_IR_RF0N).toBe(0);
      expect(out.getUint32(0x04, true) & FDCAN_RXF0S_F0FL).toBe(0);
      expect(out.getUint32(0x08, true)).toBe(1);
      expect(out.getUint32(0x0c, true)).toBe(0);
      expect(out.getUint32(0x10, true)).toBe(0);
      expect(out.getUint32(0x14, true)).toBe(1);
    } finally {
      rig.dispose();
    }
  });
});
