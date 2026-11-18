import { describe, expect, it } from 'vitest';
import { createFusedCt107dBoard } from '../bench/fused';
import { PREVIEW_CLOCK_FREQUENCY, previewFirmware } from '../bench/preview';

const DISPLAYS = ['DS1', 'DS2'] as const;
const DIGITS = ['digit1', 'digit2', 'digit3', 'digit4'] as const;
const LATCHES = ['U6', 'U7', 'U8', 'U9'] as const;

interface SignalEvent {
  readonly timePs: number;
  readonly designator: string;
  readonly port: string;
  readonly value: number;
}

interface Capture {
  readonly latest: Map<string, number>;
  readonly events: SignalEvent[];
  readonly status: () => string;
  readonly faults: () => readonly string[];
  readonly snapshot: () => {
    readonly latches: Readonly<Record<'U6' | 'U7' | 'U8' | 'U9', number>>;
  };
  runUntil(targetPs: number): void;
  dispose(): void;
}

function captureFused(fused: Awaited<ReturnType<typeof createFusedCt107dBoard>>): Capture {
  const latest = new Map<string, number>();
  const events: SignalEvent[] = [];
  const subscription = fused.board.topics.onDidReceive((message) => {
    if (message.topic !== 'signal') return;
    const value = message.payload as { designator: string; port: string; value: number };
    latest.set(`${value.designator}/${value.port}`, value.value);
    events.push({ timePs: fused.board.time, ...value });
  });
  return {
    latest,
    events,
    status: () => fused.board.status,
    faults: () => fused.faults,
    snapshot: () => {
      const method = fused.methods.getSnapshot;
      if (method === undefined) throw new Error('the fused board has no getSnapshot');
      return method(null) as {
        readonly latches: Readonly<Record<'U6' | 'U7' | 'U8' | 'U9', number>>;
      };
    },
    runUntil: (target) => fused.board.runUntil(target),
    dispose() {
      subscription.dispose();
      fused.dispose();
    },
  };
}

function maskAt(capture: Capture, designator: string, digit: string): number {
  const value = capture.latest.get(`${designator}/${digit}`);
  if (value === undefined) throw new Error(`missing ${designator}/${digit}`);
  return value;
}

function displayAt(capture: Capture, designator: string): number[] {
  return DIGITS.map((digit) => maskAt(capture, designator, digit));
}

function latchAt(capture: Capture, designator: string): number {
  const value = capture.latest.get(`${designator}/latch`);
  if (value === undefined) throw new Error(`missing ${designator}/latch`);
  return value;
}

function text(masks: readonly number[]): string {
  const glyphs: Record<number, string> = {
    0x3f: '0',
    0x06: '1',
    0x5b: '2',
    0x4f: '3',
    0x66: '4',
    0x6d: '5',
    0x7d: '6',
    0x07: '7',
    0x7f: '8',
    0x6f: '9',
    0x40: '-',
    0x00: ' ',
  };
  return masks.map((mask) => glyphs[mask & 0x7f] ?? '?').join('');
}

function expectedDs2(ms: number): string {
  if (ms < 1152) return '--02';
  if (ms < 2304) return '--03';
  if (ms < 3392) return '--04';
  return '--05';
}

describe('fused board preview trajectory', () => {
  it('64 ms 检查点 0→4096 ms：完整 8 位段码与 U6–U9 锁存轨迹', async () => {
    const firmware = previewFirmware();
    const fused = captureFused(
      await createFusedCt107dBoard({
        firmware,
        props: { clockFrequency: PREVIEW_CLOCK_FREQUENCY },
      }),
    );
    try {
      fused.runUntil(0);
      for (let ms = 64; ms <= 4096; ms += 64) {
        fused.runUntil(ms * 1_000_000_000);

        for (const designator of DISPLAYS) {
          const actual = displayAt(fused, designator);

          expect(text(actual), `${designator} text @${ms}`).not.toContain('?');
        }
        expect(text(displayAt(fused, 'DS1')), `DS1 @${ms}`).toBe('2018');
        expect(text(displayAt(fused, 'DS2')), `DS2 @${ms}`).toBe(expectedDs2(ms));
        for (const designator of LATCHES) {
          const latch = latchAt(fused, designator);

          expect(Number.isInteger(latch), `${designator}/latch @${ms}`).toBe(true);
          expect(latch, `${designator}/latch @${ms}`).toBeGreaterThanOrEqual(0);
          expect(latch, `${designator}/latch @${ms}`).toBeLessThanOrEqual(0xff);
        }
        expect(fused.status()).toBe('ready');
      }
      const snapshot = fused.snapshot();
      for (const designator of LATCHES)
        expect(snapshot.latches[designator], `${designator} snapshot`).toBe(
          latchAt(fused, designator),
        );
      expect(fused.events.length).toBeGreaterThan(0);
      expect(fused.faults()).toEqual([]);
    } finally {
      fused.dispose();
    }
  }, 1_800_000);

  it('1 ms 首帧与 DS2 进位：3/11 ms 首帧、1126/2241/3355 ms 更新', async () => {
    const firmware = previewFirmware();
    const fused = captureFused(
      await createFusedCt107dBoard({
        firmware,
        props: { clockFrequency: PREVIEW_CLOCK_FREQUENCY },
      }),
    );
    try {
      fused.runUntil(0);
      for (let ms = 1; ms <= 4096; ms += 1) fused.runUntil(ms * 1_000_000_000);

      // The startup snapshot at 0 establishes the zero state; the first *scanned*
      // frame is DS1 at 3 ms and DS2 at 11 ms.
      const firstFrame = (capture: Capture, designator: string, digit: string): number => {
        // Match the original 1 ms control: record the last snapshot in the first
        // 64 ms window, not the very first transient during the scan.
        const event = capture.events
          .filter(
            (item) =>
              item.timePs > 0 &&
              item.timePs <= 64_000_000_000 &&
              item.designator === designator &&
              item.port === digit,
          )
          .at(-1);
        return event === undefined ? -1 : event.timePs / 1_000_000_000;
      };
      for (const digit of DIGITS) {
        expect(firstFrame(fused, 'DS1', digit)).toBe(3);
        expect(firstFrame(fused, 'DS2', digit)).toBe(11);
      }

      const ds2Digit4 = fused.events
        .filter(
          (event) => event.timePs > 0 && event.designator === 'DS2' && event.port === 'digit4',
        )
        .map((event) => [event.timePs / 1_000_000_000, event.value] as const);
      expect(ds2Digit4).toEqual([
        [3, 0x00],
        [4, 0x00],
        [5, 0x06],
        [11, 0x5b],
        [1126, 0x4f],
        [2241, 0x66],
        [3355, 0x6d],
      ]);
      expect(text(displayAt(fused, 'DS1'))).toBe('2018');
      expect(text(displayAt(fused, 'DS2'))).toBe('--05');
      const snapshot = fused.snapshot();
      for (const designator of LATCHES)
        expect(snapshot.latches[designator]).toBe(latchAt(fused, designator));
      expect(fused.status()).toBe('ready');
      expect(fused.faults()).toEqual([]);
    } finally {
      fused.dispose();
    }
  }, 1_800_000);
});
