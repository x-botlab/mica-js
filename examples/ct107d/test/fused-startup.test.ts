import { describe, expect, it } from 'vitest';
import { createFusedCt107dBoard } from '../bench/fused';
import { PREVIEW_CLOCK_FREQUENCY, previewFirmware } from '../bench/preview';

const LED = /^D[1-8]$/;

interface LedEvent {
  readonly designator: string;
  readonly port: string;
  readonly value: number;
}

function captureFused(fused: Awaited<ReturnType<typeof createFusedCt107dBoard>>): {
  events: LedEvent[];
  final: Map<string, number>;
  dispose(): void;
} {
  const events: LedEvent[] = [];
  const final = new Map<string, number>();
  const subscription = fused.board.topics.onDidReceive((message) => {
    if (message.topic !== 'signal') return;
    const value = message.payload as LedEvent;
    if (!LED.test(value.designator)) return;
    events.push({ ...value });
    final.set(`${value.designator}/${value.port}`, value.value);
  });
  return { events, final, dispose: () => subscription.dispose() };
}

describe('fused startup observables', () => {
  it('does not publish a fabricated LED off frame before the first real on state', async () => {
    const firmware = previewFirmware();
    const fused = await createFusedCt107dBoard({
      firmware,
      props: { clockFrequency: PREVIEW_CLOCK_FREQUENCY },
    });
    const actual = captureFused(fused);
    try {
      fused.board.runUntil(0);

      expect(actual.events.length).toBeGreaterThan(0);
      expect(actual.events.some((event) => event.value === 0)).toBe(false);
      expect(actual.final.size).toBeGreaterThan(0);

      const snapshot = fused.methods.getSnapshot!(null) as {
        readonly ledStates: readonly {
          readonly brightness: number;
          readonly current: number;
          readonly voltage: number;
        }[];
      };
      expect(snapshot.ledStates).toHaveLength(8);
      for (let index = 0; index < snapshot.ledStates.length; index += 1) {
        const state = snapshot.ledStates[index]!;
        expect(state.brightness).toBe(actual.final.get(`D${index + 1}/brightness`));
        expect(state.current).toBe(actual.final.get(`D${index + 1}/current`));
        expect(state.voltage).toBe(actual.final.get(`D${index + 1}/voltage`));
      }
      expect(fused.board.status).toBe('ready');
      expect(fused.faults).toEqual([]);
    } finally {
      actual.dispose();
      fused.dispose();
    }
  }, 300_000);
});
