import { describe, expect, it } from 'vitest';
import { iapDeviceWithFirmware } from '../iap15f2k61s2/firmware-device.ts';
import { createBoardWith, US } from './harness.ts';

async function probePort1Bit0(loadResistance?: number) {
  const device = await iapDeviceWithFirmware(
    Uint8Array.from([
      0x75,
      0x90,
      0xff, // MOV P1,#0FFH: quasi-bidirectional latch high
      0x80,
      0xfe, // SJMP $
    ]),
  );
  const board = await createBoardWith(
    [
      {
        id: 'dut',
        type: 'iap15f2k61s2',
        device,
        props: {
          clockFrequency: 1_000_000,
        },
      },
    ],
    {
      probes: ['probe'],
      ...(loadResistance === undefined
        ? {}
        : { resistors: [{ id: 'load', resistance: loadResistance }] }),
      nets: [
        {
          id: 'vcc',
          pins: [{ instance: 'dut', pin: 'VCC' }],
          voltage: 5,
        },
        {
          id: 'gnd',
          pins: [
            { instance: 'dut', pin: 'GND' },
            ...(loadResistance === undefined ? [] : [{ instance: 'load', pin: 'b' }]),
          ],
          voltage: 0,
        },
        {
          id: 'signal',
          pins: [
            { instance: 'dut', pin: 'P1_0' },
            { instance: 'probe', pin: 'y' },
            ...(loadResistance === undefined ? [] : [{ instance: 'load', pin: 'a' }]),
          ],
        },
      ],
    },
  );

  try {
    board.run(100 * US);
    return board.probe('probe');
  } finally {
    board.dispose();
  }
}

describe('IAP15F2K61S2 准双向端口', () => {
  it('uses a weak pull-up when the latch is high', async () => {
    await expect(probePort1Bit0()).resolves.toBe(1);
  });

  it('models the pull-up as weak enough for a 1 kΩ pull-down to dominate', async () => {
    await expect(probePort1Bit0(1_000)).resolves.toBe(0);
  });
});
