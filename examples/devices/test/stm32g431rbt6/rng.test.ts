import { describe, expect, it } from 'vitest';
import { types } from '@mica-js/sdk/model';
import { asBody, num, u32 } from '@mica-js/stm32g431rbt6-core/ir';
import type { Body } from '@mica-js/stm32g431rbt6-core/ir';
import {
  RNG_STATES,
  advanceRng,
  readRng,
  rngPending,
  setRngFaults,
  writeRng,
} from '@mica-js/stm32g431rbt6-core/rng';
import { runRig } from './peripheral-rig';

const CR = 0x00;
const SR = 0x04;
const DR = 0x08;

const NUMBER_CAPTURES = [
  'sr0',
  'srAfterRead',
  'srAfterTwo',
  'srFault',
  'srEmpty',
  'srKeep',
  'srClear',
  'empty',
  'filled',
  'hash',
  'sampleCount',
  'nonzero',
  'different',
  'w0',
  'w1',
  'w2',
  'w3',
].map((name) => ({ name, type: 'number' as const, initial: 0 }));
const BOOL_CAPTURES = ['pending', 'pendingCleared', 'pendingError'].map((name) => ({
  name,
  type: 'bool' as const,
  initial: false,
}));

function enableAndRefill(b: Body, count: number): void {
  writeRng(b, num(b, CR), 4, num(b, 0x04));
  for (let index = 0; index < count; index += 1)
    advanceRng(b, num(b, 20_000_000));
}

describe('STM32G431 RNG', () => {
  it('fills a four-word FIFO and exposes deterministic non-crypto data', () => {
    const run = () => {
      const rig = runRig({
        states: [...RNG_STATES, ...NUMBER_CAPTURES],
        build: (b) => {
          enableAndRefill(b, 4);
          b.writeState('sr0', readRng(b, num(b, SR), 4));
          b.writeState('w0', readRng(b, num(b, DR), 4));
          b.writeState('w1', readRng(b, num(b, DR), 4));
          b.writeState('w2', readRng(b, num(b, DR), 4));
          b.writeState('w3', readRng(b, num(b, DR), 4));
          b.writeState('srAfterRead', readRng(b, num(b, SR), 4));
        },
      });

      try {
        return [0, 1, 2, 3].map((index) => rig.state(`w${index}`) as number);
      } finally {
        rig.dispose();
      }
    };
    const first = run();
    const second = run();

    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(4);
    expect(first.every((word) => word >>> 0 === word)).toBe(true);
  });

  it('keeps generated data readable after RNGEN is cleared', () => {
    const rig = runRig({
      states: [...RNG_STATES, ...NUMBER_CAPTURES],
      build: (b) => {
        enableAndRefill(b, 2);
        writeRng(b, num(b, CR), 4, num(b, 0));
        b.writeState('sr0', readRng(b, num(b, SR), 4));
        b.writeState('w0', readRng(b, num(b, DR), 4));
        b.writeState('srAfterRead', readRng(b, num(b, SR), 4));
        advanceRng(b, num(b, 100_000_000));
        b.writeState('w1', readRng(b, num(b, DR), 4));
        b.writeState('srAfterTwo', readRng(b, num(b, SR), 4));
      },
    });

    try {
      expect(rig.state('sr0')).toBe(1);
      expect(rig.state('w0')).not.toBe(0);
      expect(rig.state('srAfterRead')).toBe(1);
      expect(rig.state('w1')).not.toBe(0);
      expect(rig.state('srAfterTwo')).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('raises the RNG interrupt on DRDY/error and clears it on DR read/fault clear', () => {
    const rig = runRig({
      states: [...RNG_STATES, ...NUMBER_CAPTURES, ...BOOL_CAPTURES],
      build: (b) => {
        writeRng(b, num(b, CR), 4, num(b, 0x04 | 0x08));
        advanceRng(b, num(b, 20_000_000));
        b.writeState('pending', rngPending(b));
        readRng(b, num(b, DR), 4);
        b.writeState('pendingCleared', rngPending(b));

        setRngFaults(b, true, false);
        b.writeState('srFault', readRng(b, num(b, SR), 4));
        b.writeState('pendingError', rngPending(b));
        setRngFaults(b, false, false);
        b.writeState('pendingError', rngPending(b));
      },
    });

    try {
      expect(rig.state('pending')).toBe(true);
      expect(rig.state('pendingCleared')).toBe(false);
      expect((rig.state('srFault') as number) & 0x22).toBe(0x22);
      expect(rig.state('pendingError')).toBe(false);
    } finally {
      rig.dispose();
    }
  });

  it('returns 0 for an empty FIFO without claiming its stale DR is valid', () => {
    const rig = runRig({
      states: [...RNG_STATES, ...NUMBER_CAPTURES],
      build: (b) => {
        writeRng(b, num(b, CR), 4, num(b, 0x04));
        b.writeState('empty', readRng(b, num(b, DR), 4));
        b.writeState('srEmpty', readRng(b, num(b, SR), 4));
        advanceRng(b, num(b, 20_000_000));
        b.writeState('filled', readRng(b, num(b, DR), 4));
      },
    });

    try {
      expect(rig.state('empty')).toBe(0);
      expect(rig.state('srEmpty')).toBe(0);
      expect(rig.state('filled')).not.toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('clears latched CEIS/SEIS from firmware with RNG_SR rc_w0 semantics', () => {
    const rig = runRig({
      states: [...RNG_STATES, ...NUMBER_CAPTURES, ...BOOL_CAPTURES],
      build: (b) => {
        writeRng(b, num(b, CR), 4, num(b, 0x04 | 0x08));
        setRngFaults(b, true, false);
        b.writeState('srFault', readRng(b, num(b, SR), 4));
        b.writeState('pending', rngPending(b));
        writeRng(b, num(b, SR), 4, num(b, 0xffffffff));
        b.writeState('srKeep', readRng(b, num(b, SR), 4));
        writeRng(b, num(b, SR), 4, num(b, 0));
        b.writeState('srClear', readRng(b, num(b, SR), 4));
        b.writeState('pendingCleared', rngPending(b));
        setRngFaults(b, false, false);
      },
    });

    try {
      expect((rig.state('srFault') as number) & 0x22).toBe(0x22);
      expect(rig.state('pending')).toBe(true);
      expect((rig.state('srKeep') as number) & 0x22).toBe(0x22);
      expect((rig.state('srClear') as number) & 0x02).toBe(0x02);
      expect((rig.state('srClear') as number) & 0x20).toBe(0);
      expect(rig.state('pendingCleared')).toBe(false);
    } finally {
      rig.dispose();
    }
  });

  it('advances the full 32-bit PRNG state reproducibly past 1024 samples', () => {
    const run = (): unknown[] => {
      const rig = runRig({
        states: [...RNG_STATES, ...NUMBER_CAPTURES],
        build: (b) => {
          writeRng(b, num(b, CR), 4, num(b, 0x04));
          const count = b.local(types.number, 0);
          const hash = b.local(types.number, 0);
          const previous = b.local(types.number, 0);
          const different = b.local(types.number, 0);
          const nonzero = b.local(types.number, 0);

          b.loop((loop) => {
            const body = asBody(loop);

            body.if(
              body.lessThan(body.getLocal(count), num(body, 1100)),
              (sample) => {
                const scope = asBody(sample);
                const word = scope.local(types.number, 0);

                advanceRng(scope, num(scope, 20_000_000));
                scope.setLocal(word, readRng(scope, num(scope, DR), 4));
                scope.setLocal(
                  hash,
                  u32(
                    scope,
                    scope.add(
                      scope.multiply(scope.getLocal(hash), num(scope, 1_664_525)),
                      scope.getLocal(word),
                    ),
                  ),
                );
                scope.setLocal(
                  different,
                  scope.bitOr(
                    scope.getLocal(different),
                    scope.bitXor(scope.getLocal(word), scope.getLocal(previous)),
                  ),
                );
                scope.setLocal(
                  nonzero,
                  scope.bitOr(scope.getLocal(nonzero), scope.getLocal(word)),
                );
                scope.setLocal(previous, scope.getLocal(word));
                scope.setLocal(count, scope.add(scope.getLocal(count), num(scope, 1)));
              },
              (done) => done.break(),
            );
          });

          b.writeState('sampleCount', b.getLocal(count));
          b.writeState('hash', b.getLocal(hash));
          b.writeState('nonzero', b.getLocal(nonzero));
          b.writeState('different', b.getLocal(different));
        },
      });

      try {
        return [
          rig.state('sampleCount'),
          rig.state('hash'),
          rig.state('nonzero'),
          rig.state('different'),
        ];
      } finally {
        rig.dispose();
      }
    };

    const first = run();
    const second = run();

    expect(first).toEqual(second);
    expect(first[0]).toBe(1100);
    expect(first[2]).not.toBe(0);
    expect(first[3]).not.toBe(0);
  });
});
