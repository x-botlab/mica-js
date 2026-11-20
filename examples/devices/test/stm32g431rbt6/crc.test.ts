import { describe, expect, it } from 'vitest';
import { num } from '@mica-js/stm32g431rbt6-core/ir';
import type { Body } from '@mica-js/stm32g431rbt6-core/ir';
import { CRC } from '@mica-js/stm32g431rbt6-core/layout';
import { readCrc, writeCrc } from '@mica-js/stm32g431rbt6-core/crc';
import { runRig } from './peripheral-rig';

const CAPTURES = [
  'dr',
  'vector16',
  'vector8',
  'vector7',
  'revOut',
  'revIn',
  'initValue',
  'idr',
].map((name) => ({ name, type: 'number' as const, initial: 0 }));

const DR = 0x00;
const IDR = 0x04;
const CR = 0x08;
const INIT = 0x10;
const POL = 0x14;

const byte = (b: Body, value: number) => {
  writeCrc(b, num(b, DR), 1, num(b, value));
};

const text = (b: Body, value: string) => {
  for (let index = 0; index < value.length; index += 1) byte(b, value.charCodeAt(index));
};

function reverseBits(value: number, width: number): number {
  let result = 0;

  for (let bit = 0; bit < width; bit += 1) result = (result << 1) | ((value >>> bit) & 1);

  return result >>> 0;
}

describe('STM32G431 CRC', () => {
  it('computes the CRC-32/MPEG-2 reference vector and supports INIT/POL/RESET', () => {
    const rig = runRig({
      states: CAPTURES,
      build: (b) => {
        text(b, '123456789');
        b.writeState('dr', readCrc(b, num(b, DR), 4));

        b.writeState('initValue', readCrc(b, num(b, INIT), 4));

        writeCrc(b, num(b, CR), 4, num(b, 0x08)); // POLYSIZE=16
        writeCrc(b, num(b, INIT), 4, num(b, 0xffff));
        writeCrc(b, num(b, POL), 4, num(b, 0x1021));
        writeCrc(b, num(b, CR), 4, num(b, 0x08 | 0x01)); // RESET
        text(b, '123456789');
        b.writeState('vector16', readCrc(b, num(b, DR), 4));

        writeCrc(b, num(b, CR), 4, num(b, 0x10 | 0x01)); // POLYSIZE=8
        writeCrc(b, num(b, INIT), 4, num(b, 0));
        writeCrc(b, num(b, POL), 4, num(b, 0x07));
        text(b, '123456789');
        b.writeState('vector8', readCrc(b, num(b, DR), 4));

        writeCrc(b, num(b, CR), 4, num(b, 0x18 | 0x01)); // POLYSIZE=7
        writeCrc(b, num(b, INIT), 4, num(b, 0));
        writeCrc(b, num(b, POL), 4, num(b, 0x09));
        text(b, '123456789');
        b.writeState('vector7', readCrc(b, num(b, DR), 4));
      },
    });

    try {
      expect(rig.state('dr')).toBe(0x0376e6e7);
      expect(rig.state('initValue')).toBe(0xffffffff);
      expect(rig.state('vector16')).toBe(0x29b1);
      expect(rig.state('vector8')).toBe(0xf4);
      expect(rig.state('vector7')).toBe(0x75);
    } finally {
      rig.dispose();
    }
  });

  it('applies REV_IN and REV_OUT without changing the underlying sequence', () => {
    const rig = runRig({
      states: CAPTURES,
      build: (b) => {
        text(b, '123456789');
        const plain = readCrc(b, num(b, DR), 4);

        writeCrc(b, num(b, CR), 4, num(b, 0x80)); // REV_OUT
        b.writeState('revOut', readCrc(b, num(b, DR), 4));

        writeCrc(b, num(b, CR), 4, num(b, 0x20 | 0x01)); // REV_IN byte + RESET
        for (const value of '123456789') byte(b, reverseBits(value.charCodeAt(0), 8));
        b.writeState('revIn', readCrc(b, num(b, DR), 4));

        writeCrc(b, num(b, CR), 4, num(b, 0x01));
        writeCrc(b, num(b, IDR), 4, num(b, 0x11223344));
        b.writeState('idr', readCrc(b, num(b, IDR), 4));
        b.writeState('dr', plain);
      },
    });

    try {
      expect(rig.state('revIn')).toBe(0x0376e6e7);
      expect(rig.state('revOut')).toBe(reverseBits(0x0376e6e7, 32));
      expect(rig.state('idr')).toBe(0x11223344);
      expect(rig.state('dr')).toBe(0x0376e6e7);
      expect(rig.memory(CRC)[0x0c]).toBe(0);
    } finally {
      rig.dispose();
    }
  });
});
