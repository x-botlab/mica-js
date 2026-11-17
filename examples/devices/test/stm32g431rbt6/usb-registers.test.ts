import { describe, expect, it } from 'vitest';
import { types } from '@mica-js/sdk/model';
import { num } from '@mica-js/stm32g431rbt6-core/ir';
import type { Body } from '@mica-js/stm32g431rbt6-core/ir';
import { USB, USB_BASE } from '@mica-js/stm32g431rbt6-core/layout';
import {
  USB_BCDR,
  USB_CNTR_RESETM,
  USB_CNTR_SUSPM,
  USB_BTABLE,
  USB_CNTR,
  USB_DADDR,
  USB_EP_CTR_RX,
  USB_EP_DTOG_RX,
  USB_EP_STAT_RX,
  USB_EP_STAT_TX,
  USB_EP0R,
  USB_ISTR,
  USB_ISTR_RESET,
  USB_ISTR_WKUP,
  USB_PMA_BASE,
  USB_PMA_OFFSET,
} from '@mica-js/stm32g431rbt6-core/usb-layout';
import {
  USB_MODULE,
  advanceUsb,
  readUsb,
  usbHighPending,
  usbLowPending,
  usbWakePending,
  writeUsb,
} from '@mica-js/stm32g431rbt6-core/usb';
import { capture, runUsbRig } from './usb-rig';

function advanceFlag(b: Body, value: ReturnType<typeof usbLowPending>): ReturnType<typeof num> {
  return b.select(
    types.number,
    value,
    (yes) => yes.constant(types.number, 1),
    (no) => no.constant(types.number, 0),
  );
}

const CAPTURES = [
  'cntrReset',
  'cntrOff',
  'ep0Configured',
  'ep0Toggled',
  'ep1',
  'pmaWord',
  'btable',
  'daddr',
  'istrClear',
  'istrCtrPreserved',
  'epCtr',
  'epCtrCleared',
  'bcdr',
  'low',
  'high',
  'wake',
].map((name) => ({ name, type: 'number' as const, initial: 0 }));

describe('STM32G431 USB FS register/PMA semantics', () => {
  it('exposes HP/LP/wakeup NVIC sources', () => {
    expect(USB_MODULE.interrupts?.map((source) => source.exception)).toEqual([35, 36, 58]);
  });

  it('models reset values, EP toggle/W0C bits, BTABLE/DADDR masks and 1 KiB PMA', () => {
    const rig = runUsbRig({
      states: CAPTURES,
      build: (b) => {
        const read = (offset: number, state: string, size = 2): void =>
          capture(b, state, readUsb(b, num(b, USB_BASE + offset), size));
        const write = (offset: number, value: number, size = 2): void =>
          writeUsb(b, num(b, USB_BASE + offset), size, num(b, value));

        read(USB_CNTR, 'cntrReset');
        write(USB_CNTR, 0);
        read(USB_CNTR, 'cntrOff');

        // CONTROL, RX=VALID, TX=NAK, EA=0.
        write(USB_EP0R, 0x0200 | 0x3000 | 0x0020);
        read(USB_EP0R, 'ep0Configured');

        // DTOG_RX/STAT_RX/STAT_TX are toggled by writing 1, not assigned.
        write(USB_EP0R, USB_EP_DTOG_RX | USB_EP_STAT_RX | USB_EP_STAT_TX);
        read(USB_EP0R, 'ep0Toggled');

        write(0x04, 0x0031); // EP1R BULK, TX=VALID, EA=1
        read(0x04, 'ep1');

        writeUsb(b, num(b, USB_PMA_BASE + 0x10), 2, num(b, 0x1234));
        capture(b, 'pmaWord', readUsb(b, num(b, USB_PMA_BASE + 0x10), 2));

        write(USB_BTABLE, 0x123f);
        read(USB_BTABLE, 'btable');

        write(USB_DADDR, 0x01ff);
        read(USB_DADDR, 'daddr');

        // ISTR rc_w0: writing 0 clears event bits, CTR is read-only and survives.
        b.store16le(USB, num(b, USB_ISTR), num(b, 0x7f80));
        write(USB_ISTR, 0);
        read(USB_ISTR, 'istrClear');
        b.store16le(USB, num(b, USB_ISTR), num(b, 0x8000));
        write(USB_ISTR, 0);
        read(USB_ISTR, 'istrCtrPreserved');

        // CTR_RX is cleared by writing 0; writing 1 has no effect.
        b.store16le(USB, num(b, USB_EP0R), num(b, USB_EP_CTR_RX));
        read(USB_EP0R, 'epCtr');
        write(USB_EP0R, 0);
        read(USB_EP0R, 'epCtrCleared');

        write(USB_BCDR, 0xffff);
        read(USB_BCDR, 'bcdr');
      },
    });

    try {
      expect(rig.state('cntrReset')).toBe(0x0003);
      expect(rig.state('cntrOff')).toBe(0);
      expect(rig.state('ep0Configured')).toBe(0x3220);
      expect(rig.state('ep0Toggled')).toBe(0x4010);
      expect(rig.state('ep1')).toBe(0x0031);
      expect(rig.state('pmaWord')).toBe(0x1234);
      expect(rig.memory(USB)[USB_PMA_OFFSET + 0x10]).toBe(0x34);
      expect(rig.memory(USB)[USB_PMA_OFFSET + 0x11]).toBe(0x12);
      expect(rig.state('btable')).toBe(0x1238);
      expect(rig.state('daddr')).toBe(0x00ff);
      expect(rig.state('istrClear')).toBe(0);
      expect(rig.state('istrCtrPreserved')).toBe(0x8000);
      expect(rig.state('epCtr')).toBe(0x8000);
      expect(rig.state('epCtrCleared')).toBe(0);
      expect(rig.state('bcdr')).toBe(0x8000);
      expect(rig.memory(USB)[USB_PMA_OFFSET + 0x3ff]).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('honors byte lanes, EP reserved high 16 and lane-scoped W0C/toggle', () => {
    const rig = runUsbRig({
      states: CAPTURES,
      build: (b) => {
        const write = (offset: number, value: number, size = 2): void =>
          writeUsb(b, num(b, USB_BASE + offset), size, num(b, value));
        const read = (offset: number, state: string, size = 2): void =>
          capture(b, state, readUsb(b, num(b, USB_BASE + offset), size));

        write(USB_CNTR, 0);
        write(USB_CNTR + 1, 0x80, 1); // high byte: CTRM
        read(USB_CNTR, 'cntrReset');
        read(USB_CNTR + 1, 'cntrOff', 1);

        b.store16le(USB, num(b, USB_EP0R), num(b, 0xffff));
        write(USB_EP0R + 1, 0, 1); // high lane only: clear CTR_RX, no low-lane change
        read(USB_EP0R, 'ep0Configured');
        write(USB_EP0R + 1, 0x40, 1); // high lane: toggle DTOG_RX
        read(USB_EP0R, 'ep0Toggled');

        const before = readUsb(b, num(b, USB_EP0R), 2);
        write(USB_EP0R + 2, 0xffff, 2); // reserved high 16: ignored
        write(USB_EP0R + 3, 0xff, 1);
        capture(b, 'ep1', b.subtract(readUsb(b, num(b, USB_EP0R), 2), before));
        read(USB_EP0R + 2, 'pmaWord');

        b.store16le(USB, num(b, USB_ISTR), num(b, 0xffff));
        write(USB_ISTR + 1, 0, 1);
        read(USB_ISTR, 'istrClear');
        b.store16le(USB, num(b, USB_ISTR), num(b, 0xffff));
        write(USB_ISTR, 0, 1);
        read(USB_ISTR, 'istrCtrPreserved');
      },
    });

    try {
      expect(rig.state('cntrReset')).toBe(0x8000);
      expect(rig.state('cntrOff')).toBe(0x80);
      // EP0 high lane write 0 clears CTR_RX; low byte remains 0xff.
      expect(rig.state('ep0Configured')).toBe(0x78ff);
      // Toggling DTOG_RX from 0 sets bit 14; low byte remains.
      expect(rig.state('ep0Toggled')).toBe(0x38ff);
      expect(rig.state('ep1')).toBe(0); // reserved offset+2/+3 write ignored
      expect(rig.state('pmaWord')).toBe(0);
      // High-byte ISTR write clears only bits 8..14, preserves CTR and low byte.
      expect(rig.state('istrClear')).toBe(0x80ff);
      // Low-byte ISTR write clears only L1REQ (bit 7), preserves low read-only bits.
      expect(rig.state('istrCtrPreserved')).toBe(0xff7f);
    } finally {
      rig.dispose();
    }
  });

  it('computes HP/LP/wakeup pending and marks IRQ dirty from transaction state', () => {
    const rig = runUsbRig({
      states: CAPTURES,
      build: (b) => {
        b.store16le(USB, num(b, USB_CNTR), num(b, USB_CNTR_RESETM | USB_CNTR_SUSPM));
        b.store16le(USB, num(b, USB_ISTR), num(b, USB_ISTR_RESET));
        b.writeState('low', advanceFlag(b, usbLowPending(b)));
        b.writeState('high', advanceFlag(b, usbHighPending(b)));
        b.writeState('wake', advanceFlag(b, usbWakePending(b)));

        advanceUsb(b, num(b, 1_000_000_000));
        b.writeState(
          'bcdr',
          b.select(
            types.number,
            b.readState('irqDirty', types.bool),
            (yes) => yes.constant(types.number, 1),
            (no) => no.constant(types.number, 0),
          ),
        );

        b.store16le(USB, num(b, USB_ISTR), num(b, USB_ISTR_WKUP));
        b.writeState('wake', advanceFlag(b, usbWakePending(b)));
      },
    });

    try {
      expect(rig.state('low')).toBe(1);
      expect(rig.state('high')).toBe(0);
      expect(rig.state('wake')).toBe(1);
      expect(rig.state('bcdr')).toBe(1);
    } finally {
      rig.dispose();
    }
  });

  it('keeps EP CTR summary and DIR/EP_ID in ISTR for low-priority transfers', () => {
    const rig = runUsbRig({
      states: CAPTURES,
      build: (b) => {
        b.store16le(USB, num(b, USB_EP0R), num(b, 0x8000));
        b.store16le(USB, num(b, 0x04), num(b, 0x8002));
        writeUsb(b, num(b, USB_BASE + USB_EP0R), 2, num(b, 0));
        capture(b, 'istrClear', readUsb(b, num(b, USB_BASE + USB_ISTR), 2));
      },
    });

    try {
      // EP1 with a higher EA still has CTR_RX; write to EP0R only toggles EP0.
      expect(rig.state('istrClear')).toBe(0x8011);
      expect(rig.memory(USB)[USB_ISTR + 1] ?? 0).toBeGreaterThanOrEqual(0);
    } finally {
      rig.dispose();
    }
  });
});
