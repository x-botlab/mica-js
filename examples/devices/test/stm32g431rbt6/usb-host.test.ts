import { describe, expect, it } from 'vitest';
import {
  USB_CNTR,
  USB_DADDR,
  USB_EP_CTR_RX,
  USB_EP_CTR_TX,
  USB_EP_SETUP,
  USB_EP_STAT_RX,
  USB_EP_STAT_TX,
  USB_EP_KIND,
  USB_EP_TYPE_BULK,
  USB_EP_TYPE_CONTROL,
  USB_EP_TYPE_ISO,
  USB_ISTR,
  USB_ISTR_CTR,
  USB_ISTR_RESET,
  USB_ISTR_SOF,
  USB_ISTR_SUSP,
  USB_ISTR_WKUP,
  USB_BCDR,
  USB_BCDR_DPPU,
  USB_BTABLE,
  USB_FNR,
  USB_STAT_NAK,
  USB_STAT_STALL,
  USB_STAT_VALID,
} from '@mica-js/stm32g431rbt6-core/usb-layout';
import {
  initUsbMemory,
  usbHostIn,
  usbHostOut,
  usbHostReset,
  usbHostResume,
  usbHostSetup,
  usbHostSof,
  usbApplyPatch,
  usbHostSuspend,
  usbPatchBytes,
} from '@mica-js/stm32g431rbt6-core/usb';

const u16 = (usb: Uint8Array, offset: number): number => usb[offset]! | (usb[offset + 1]! << 8);

const put16 = (usb: Uint8Array, offset: number, value: number): void => {
  usb[offset] = value & 0xff;
  usb[offset + 1] = (value >>> 8) & 0xff;
};

const ep = (usb: Uint8Array, index: number): number => u16(usb, index * 4);
const setEp = (usb: Uint8Array, index: number, value: number): void => put16(usb, index * 4, value);

const pmaWrite = (usb: Uint8Array, offset: number, data: readonly number[]): void => {
  const start = 0x100 + offset;

  for (let index = 0; index < data.length; index += 1) usb[start + index] = data[index]!;
};

const pmaRead = (usb: Uint8Array, offset: number, length: number): number[] => [
  ...usb.subarray(0x100 + offset, 0x100 + offset + length),
];

function makeUsb(): Uint8Array {
  const usb = new Uint8Array(0x500);

  initUsbMemory(usb);
  put16(usb, USB_CNTR, 0);
  put16(usb, USB_BCDR, USB_BCDR_DPPU);
  put16(usb, USB_DADDR, 0x80);
  put16(usb, USB_BTABLE, 0);

  // BTABLE is in PMA: entry 0 TX 0x40/COUNT 0, RX 0x80/64 bytes.
  const table = 0x100;
  put16(usb, table + 0x00, 0x40);
  put16(usb, table + 0x02, 0);
  put16(usb, table + 0x04, 0x80);
  put16(usb, table + 0x06, 0x8800);

  // Entry 1: TX 0x100; entry 2: RX 0x140/64 bytes.
  put16(usb, table + 0x08, 0x100);
  put16(usb, table + 0x0a, 0);
  put16(usb, table + 0x0c, 0);
  put16(usb, table + 0x0e, 0);
  put16(usb, table + 0x10, 0);
  put16(usb, table + 0x12, 0);
  put16(usb, table + 0x14, 0x140);
  put16(usb, table + 0x16, 0x8800);

  setEp(usb, 0, (USB_EP_TYPE_CONTROL << 9) | (USB_STAT_VALID << 12) | (USB_STAT_NAK << 4));
  setEp(usb, 1, (USB_EP_TYPE_BULK << 9) | (USB_STAT_NAK << 4) | 1);
  setEp(usb, 2, (USB_EP_TYPE_BULK << 9) | (USB_STAT_VALID << 12) | 2);

  return usb;
}

const setupGetDescriptor = Uint8Array.of(0x80, 0x06, 0x00, 0x01, 0x00, 0x00, 0x12, 0x00);

describe('STM32G431 USB FS transaction-level host', () => {
  it('resets address/endpoints, preserves CNTR and raises RESET', () => {
    const usb = makeUsb();

    put16(usb, USB_DADDR, 0x85);
    setEp(usb, 0, 0xffff);
    put16(usb, USB_CNTR, 0x8000);

    usbHostReset(usb);

    expect(u16(usb, USB_DADDR)).toBe(0);
    expect(ep(usb, 0)).toBe(0x8080);
    expect(u16(usb, USB_CNTR)).toBe(0x8000);
    expect(u16(usb, USB_ISTR) & USB_ISTR_RESET).toBe(USB_ISTR_RESET);
    expect(u16(usb, USB_ISTR) & USB_ISTR_CTR).toBe(USB_ISTR_CTR);
  });

  it('completes an EP0 SETUP/DATA IN/status OUT sequence using firmware-provided PMA data', () => {
    const usb = makeUsb();
    const result = usbHostSetup(usb, 0, 0, setupGetDescriptor);

    expect(result).toEqual({ handshake: 'ACK' });
    expect(pmaRead(usb, 0x80, 8)).toEqual([...setupGetDescriptor]);
    expect(u16(usb, 0x106) & 0x3ff).toBe(8);
    expect(ep(usb, 0) & USB_EP_SETUP).toBe(USB_EP_SETUP);
    expect(ep(usb, 0) & USB_EP_CTR_RX).toBe(USB_EP_CTR_RX);
    expect((ep(usb, 0) >> 12) & 3).toBe(USB_STAT_NAK);
    expect(u16(usb, USB_ISTR) & USB_ISTR_CTR).toBe(USB_ISTR_CTR);
    expect(u16(usb, USB_ISTR) & 0x10).toBe(0x10);

    // Firmware takes the SETUP, writes a descriptor and enables DATA IN.
    const descriptor = Array.from({ length: 18 }, (_, index) => index + 1);
    pmaWrite(usb, 0x40, descriptor);
    put16(usb, 0x102, descriptor.length);
    setEp(usb, 0, (ep(usb, 0) & ~USB_EP_CTR_RX) | (USB_STAT_VALID << 4));

    const data = usbHostIn(usb, 0, 0);
    expect(data.handshake).toBe('DATA1');
    expect([...(data.data ?? [])]).toEqual(descriptor);
    expect(ep(usb, 0) & USB_EP_CTR_TX).toBe(USB_EP_CTR_TX);
    expect((ep(usb, 0) >> 4) & 3).toBe(USB_STAT_NAK);

    // Firmware re-arms RX VALID and clears CTR_TX for the OUT status stage.
    setEp(usb, 0, (ep(usb, 0) & ~USB_EP_CTR_TX & ~USB_EP_STAT_RX) | (USB_STAT_VALID << 12));

    const status = usbHostOut(usb, 0, 0, new Uint8Array(0), 1);
    expect(status).toEqual({ handshake: 'ACK' });
    expect(ep(usb, 0) & USB_EP_SETUP).toBe(0);
    expect(u16(usb, 0x106) & 0x3ff).toBe(0);
  });

  it('returns NAK/STALL from real endpoint state and keeps SETUP acceptable', () => {
    const usb = makeUsb();

    expect(usbHostIn(usb, 0, 0)).toEqual({ handshake: 'NAK' });

    setEp(usb, 0, (ep(usb, 0) & ~USB_EP_STAT_TX) | (USB_STAT_STALL << 4));
    expect(usbHostIn(usb, 0, 0)).toEqual({ handshake: 'STALL' });

    // CONTROL SETUP is accepted even when RX is STALL/NAK, per RM0440 §45.5.2.
    setEp(usb, 0, (ep(usb, 0) & ~USB_EP_STAT_RX) | (USB_STAT_STALL << 12));
    expect(usbHostSetup(usb, 0, 0, setupGetDescriptor)).toEqual({ handshake: 'ACK' });
  });

  it('filters device address and validates setup size', () => {
    const usb = makeUsb();

    put16(usb, USB_DADDR, 0x85);
    expect(usbHostSetup(usb, 4, 0, setupGetDescriptor)).toEqual({ handshake: 'TIMEOUT' });
    expect(usbHostSetup(usb, 5, 0, setupGetDescriptor)).toEqual({ handshake: 'ACK' });
    expect(() => usbHostSetup(usb, 5, 0, Uint8Array.of(0))).toThrow(RangeError);
  });

  it('implements bulk OUT toggle/ACK-discard and bulk IN DATA0/NAK re-arm', () => {
    const usb = makeUsb();

    // EP2 OUT: DATA0 accepted.
    expect(usbHostOut(usb, 0, 2, Uint8Array.of(1, 2, 3), 0)).toEqual({ handshake: 'ACK' });
    expect(pmaRead(usb, 0x140, 3)).toEqual([1, 2, 3]);
    expect((ep(usb, 2) >> 14) & 1).toBe(1);
    expect(ep(usb, 2) & USB_EP_CTR_RX).toBe(USB_EP_CTR_RX);

    // Firmware clears CTR_RX and re-arms RX VALID by toggling NAK->VALID.
    setEp(
      usb,
      2,
      (ep(usb, 2) & ~USB_EP_CTR_RX) | (((ep(usb, 2) >> 12) & 3) === USB_STAT_NAK ? 0 : 0x1000),
    );
    // The previous line is deliberately simple: directly set VALID for the test.
    setEp(usb, 2, (ep(usb, 2) & ~USB_EP_STAT_RX) | (USB_STAT_VALID << 12));

    // Wrong toggle is ACKed and discarded without CTR.
    expect(usbHostOut(usb, 0, 2, Uint8Array.of(9), 0)).toEqual({ handshake: 'ACK' });
    expect(ep(usb, 2) & USB_EP_CTR_RX).toBe(0);
    expect(pmaRead(usb, 0x140, 3)).toEqual([1, 2, 3]);

    // EP1 IN: firmware loads 3 bytes and enables TX; first packet is DATA0.
    pmaWrite(usb, 0x100, [7, 8, 9]);
    put16(usb, 0x10a, 3);
    setEp(usb, 1, (ep(usb, 1) & ~USB_EP_STAT_TX) | (USB_STAT_VALID << 4));

    const packet = usbHostIn(usb, 0, 1);
    expect(packet.handshake).toBe('DATA0');
    expect([...(packet.data ?? [])]).toEqual([7, 8, 9]);
    expect(ep(usb, 1) & USB_EP_CTR_TX).toBe(USB_EP_CTR_TX);
    expect(usbHostIn(usb, 0, 1)).toEqual({ handshake: 'NAK' });
  });

  it('applies a narrow transaction patch without overwriting unrelated guest bytes', () => {
    const usb = makeUsb();
    const before = usb.slice();
    const after = before.slice();

    usb[0x1f0] = 0xaa; // guest-owned unrelated byte
    usb[0x1f1] = 0xbb;
    expect(usbHostSetup(after, 0, 0, setupGetDescriptor)).toEqual({ handshake: 'ACK' });

    const patch = usbPatchBytes(before, after);
    expect(patch.length).toBeLessThan(0x100);
    expect(usbApplyPatch(usb, patch)).toBe(true);
    expect(usb[0x1f0]).toBe(0xaa);
    expect(usb[0x1f1]).toBe(0xbb);
    expect([...usb.subarray(0x180, 0x188)]).toEqual([...setupGetDescriptor]);
    expect(u16(usb, 0x106) & 0x3ff).toBe(8);
  });

  it('rejects unsupported isochronous and double-buffer endpoints explicitly', () => {
    const usb = makeUsb();

    setEp(usb, 1, (ep(usb, 1) & ~0x0600) | (USB_EP_TYPE_ISO << 9));
    expect(usbHostIn(usb, 0, 1)).toEqual({ handshake: 'ERROR' });

    setEp(usb, 2, (ep(usb, 2) & ~0x0600) | (USB_EP_TYPE_BULK << 9) | USB_EP_KIND);
    expect(usbHostOut(usb, 0, 2, Uint8Array.of(1), 0)).toEqual({ handshake: 'ERROR' });
  });

  it('raises suspend/resume/wakeup and SOF state', () => {
    const usb = makeUsb();

    usbHostSuspend(usb);
    expect(u16(usb, USB_ISTR) & USB_ISTR_SUSP).toBe(USB_ISTR_SUSP);
    usbHostResume(usb);
    expect(u16(usb, USB_ISTR) & USB_ISTR_SUSP).toBe(0);
    expect(u16(usb, USB_ISTR) & USB_ISTR_WKUP).toBe(USB_ISTR_WKUP);

    usbHostSof(usb, 0x123);
    expect(u16(usb, USB_FNR) & 0x7ff).toBe(0x123);
    expect(u16(usb, USB_ISTR) & USB_ISTR_SOF).toBe(USB_ISTR_SOF);
  });
});
