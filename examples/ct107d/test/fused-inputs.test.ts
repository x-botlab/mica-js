import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFusedCt107dBoard } from '../bench/fused';
import { assemble } from './fixtures/8051/assemble';

const IDLE = Uint8Array.from([0x80, 0xfe]); // SJMP $

interface Snapshot {
  readonly latches: Record<'U6' | 'U7' | 'U8' | 'U9', number>;
  readonly displays: Record<'DS1' | 'DS2', number[]>;
  readonly leds: number[];
  readonly ledStates: {
    readonly brightness: number;
    readonly current: number;
    readonly voltage: number;
  }[];
  readonly temperature: { readonly converted: boolean; readonly value: number };
  readonly lm386: { readonly active: boolean };
  readonly relay: boolean;
  readonly buzzer: boolean;
  readonly hall: boolean;
  readonly amplifier: {
    readonly position: number;
    readonly gain: number;
    readonly outputVoltage: number;
  };
  readonly switches: Record<string, boolean>;
  readonly jumpers: Record<string, boolean>;
  readonly infrared: Record<'LD1' | 'U11' | 'U20', boolean>;
  readonly ne555: { readonly frequency: number; readonly dutyCycle: number };
  readonly uln2003: { readonly mask: number; readonly channels: string };
  readonly decoder: { readonly select: number; readonly enabled: boolean; readonly code: string };
  readonly pcf8591: {
    readonly channel: number;
    readonly output: number;
    readonly analog: number[];
  };
}

const snapshot = (fused: Awaited<ReturnType<typeof createFusedCt107dBoard>>): Snapshot =>
  fused.methods.getSnapshot!(null) as Snapshot;

describe('fused board input methods', () => {
  it('routes switches, jumpers, hall, independent IR sources and the folded LM324 front-end', async () => {
    const fused = await createFusedCt107dBoard({ firmware: IDLE });
    const signals = new Map<string, number>();
    const amplifierEvents: { position: number; gain: number; outputVoltage: number }[] = [];
    const subscription = fused.board.topics.onDidReceive((message) => {
      if (message.topic === 'signal') {
        const value = message.payload as { designator: string; port: string; value: number };
        signals.set(`${value.designator}/${value.port}`, value.value);
      } else if (message.topic === 'amplifier.event') {
        amplifierEvents.push(
          message.payload as { position: number; gain: number; outputVoltage: number },
        );
      }
    });
    try {
      fused.board.runUntil(0);
      const initial = snapshot(fused);
      expect(initial.switches.S9).toBe(false);
      expect(initial.jumpers).toEqual({ J13: true, J3: true, J2: true });
      expect(initial.infrared).toEqual({ LD1: false, U11: false, U20: false });
      expect(initial.ne555.frequency).toBeGreaterThan(0);
      expect(initial.ne555.dutyCycle).toBeGreaterThan(0);
      expect(initial.uln2003).toEqual({ mask: 0, channels: '0000000' });
      expect(initial.decoder).toMatchObject({ select: 0, enabled: true });
      expect(initial.decoder.code).toHaveLength(2);
      expect(initial.pcf8591).toEqual({ channel: 0, output: 0, analog: [0, 0, 0, 0] });
      expect(initial.amplifier.gain).toBeCloseTo(21, 6);
      expect(initial.temperature).toEqual({ converted: false, value: 0 });
      expect(initial.lm386).toEqual({ active: false });
      expect(initial.ledStates).toHaveLength(8);
      expect(initial.ledStates.every((state) => state.brightness > 0)).toBe(true);
      for (const state of initial.ledStates) {
        expect(state.current).toBeGreaterThan(0);
        expect(state.voltage).toBeGreaterThan(0);
      }

      fused.methods.setSwitch!({ designator: 'S9', pressed: true });
      fused.methods.setJumper!({ designator: 'J13', closed: false });
      fused.methods.setJumper!({ designator: 'J2', closed: true });
      fused.methods.setHallField!({ value: 20 });
      fused.methods.setIrCarrier!({ designator: 'LD1', value: true });
      fused.methods.setIrCarrier!({ designator: 'U11', value: true });
      fused.methods.setAmplifierInputs!({ plus: 1, minus: 0.9 });
      fused.methods.setWiper!({ value: 0 });
      fused.methods.setAnalogInput!({ channel: 2, value: 0.5 });
      fused.board.runUntil(10_000_000_000);

      expect(signals.get('S9/pressed')).toBe(1);
      expect(signals.get('J13/closedState')).toBe(0);
      expect(signals.get('U21/active')).toBe(1);
      expect(signals.get('LD1/carrier')).toBe(1);
      expect(signals.get('U11/receiving')).toBe(1);
      const routed = snapshot(fused);
      expect(routed.switches.S9).toBe(true);
      expect(routed.jumpers).toEqual({ J13: false, J3: true, J2: true });
      expect(routed.infrared).toEqual({ LD1: true, U11: true, U20: false });
      expect(routed.pcf8591.analog).toEqual([0, 0, 0.5, 0]);
      expect(routed.hall).toBe(true);
      expect(routed.amplifier.position).toBe(0);
      expect(routed.amplifier.gain).toBeCloseTo(21, 6);
      expect(routed.amplifier.outputVoltage).toBeCloseTo(2.1, 6);
      const amplifier = fused.methods.getAmplifier!(null) as {
        readonly gain: number;
        readonly outputVoltage: number;
      };
      expect(amplifier.gain).toBeCloseTo(21, 6);
      expect(amplifier.outputVoltage).toBeCloseTo(2.1, 6);
      expect(amplifierEvents.at(-1)).toMatchObject({ position: 0, gain: 21 });
      expect(amplifierEvents.at(-1)?.outputVoltage).toBeCloseTo(2.1, 6);

      // Independent IR sources: only the selected receiver retriggers; J2 exposes the
      // schematic VS1838 choice without coupling it to the other receiver.
      fused.methods.setIrCarrier!({ designator: 'LD1', value: false });
      fused.methods.setIrCarrier!({ designator: 'U11', value: false });
      fused.methods.setIrCarrier!({ designator: 'U20', value: true });
      fused.methods.setSwitch!({ designator: 'S9', pressed: false });
      fused.methods.setHallField!({ value: 0 });
      fused.methods.setWiper!({ value: 1 });
      fused.board.runUntil(20_000_000_000);

      expect(signals.get('S9/pressed')).toBe(0);
      expect(signals.get('U21/active')).toBe(0);
      expect(signals.get('LD1/carrier')).toBe(0);
      expect(signals.get('U11/receiving')).toBe(0);
      expect(signals.get('U20/receiving')).toBe(1);
      const final = snapshot(fused);
      expect(final.infrared).toEqual({ LD1: false, U11: false, U20: true });
      expect(final.amplifier.gain).toBeCloseTo(2001, 6);
      expect(final.amplifier.outputVoltage).toBeGreaterThan(4.5);
    } finally {
      subscription.dispose();
      fused.dispose();
    }
  }, 120_000);

  it('publishes LM324 gain-only changes at zero output and clamps analog inputs', async () => {
    const fused = await createFusedCt107dBoard({ firmware: IDLE });
    const events: { position: number; gain: number; outputVoltage: number }[] = [];
    const subscription = fused.board.topics.onDidReceive((message) => {
      if (message.topic === 'amplifier.event')
        events.push(message.payload as { position: number; gain: number; outputVoltage: number });
    });
    try {
      // Factory initial query matches the DDL's initial wiper (gain 21, not a stale 1).
      expect(snapshot(fused).amplifier.gain).toBeCloseTo(21, 6);
      fused.board.runUntil(0);
      expect(events.at(-1)).toMatchObject({ position: 0, gain: 21, outputVoltage: 0 });

      fused.methods.setAmplifierInputs!({ plus: 0, minus: 0 });
      fused.methods.setWiper!({ value: 1 });
      fused.board.runUntil(1_000_000_000);
      expect(events.at(-1)).toMatchObject({ position: 1, gain: 2001, outputVoltage: 0 });
      const high = snapshot(fused).amplifier;
      expect(high.position).toBe(1);
      expect(high.gain).toBeCloseTo(2001, 6);
      expect(high.outputVoltage).toBe(0);

      fused.methods.setWiper!({ value: 0 });
      fused.board.runUntil(2_000_000_000);
      expect(events.at(-1)).toMatchObject({ position: 0, gain: 21, outputVoltage: 0 });

      fused.methods.setAnalogInput!({ channel: 0, value: -1 });
      fused.methods.setAnalogInput!({ channel: 1, value: 2 });
      fused.board.runUntil(3_000_000_000);
      expect(snapshot(fused).pcf8591.analog).toEqual([0, 1, 0, 0]);
    } finally {
      subscription.dispose();
      fused.dispose();
    }
  }, 60_000);

  it('rejects prototype keys instead of treating them as designators', async () => {
    const fused = await createFusedCt107dBoard({ firmware: IDLE });
    try {
      fused.board.runUntil(0);
      for (const designator of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
        expect(() => fused.methods.setSwitch!({ designator, pressed: true })).toThrow(
          /Unknown switch designator/,
        );
        expect(() => fused.methods.setJumper!({ designator, closed: true })).toThrow(
          /Unknown jumper designator/,
        );
        expect(() => fused.methods.setIrCarrier!({ designator, value: true })).toThrow(
          /Unknown infrared source/,
        );
      }
      expect(snapshot(fused).switches.S4).toBe(false);
      expect(snapshot(fused).jumpers.J13).toBe(true);
    } finally {
      fused.dispose();
    }
  }, 60_000);

  it('queries are coherent inside events, late subscribers do not miss state, and results are copies', async () => {
    const firmware = assemble(
      readFileSync(join(import.meta.dirname, 'fixtures', '8051', 'latch.asm'), 'utf8'),
    );
    const fused = await createFusedCt107dBoard({ firmware });
    let reentrant: Snapshot | undefined;
    let eepromPayload: Uint8Array | undefined;
    const subscription = fused.board.topics.onDidReceive((message) => {
      if (message.topic === 'signal') {
        const value = message.payload as { designator: string; port: string; value: number };
        if (
          value.designator === 'U6' &&
          value.port === 'latch' &&
          value.value === 0xa5 &&
          reentrant === undefined
        ) {
          const inside = snapshot(fused);
          expect(inside.latches.U6).toBe(0xa5);
          reentrant = inside;
        }
      } else if (message.topic === 'bytes') {
        const value = message.payload as { designator: string; port: string; data: Uint8Array };
        if (value.designator === 'U4' && value.port === 'dump' && eepromPayload === undefined) {
          eepromPayload = value.data;
          value.data[0] = 0xaa;
        }
      }
    });
    try {
      fused.board.runUntil(0);
      fused.board.runUntil(1_000_000);
      expect(reentrant).toBeDefined();
      expect(eepromPayload).toBeDefined();

      // The event owns a copy and the query cache owns another copy.
      expect(fused.methods.getEeprom!(null)).toEqual(new Uint8Array(256));
      const borrowed = fused.methods.getEeprom!(null) as Uint8Array;
      borrowed[0] = 0x55;
      expect((fused.methods.getEeprom!(null) as Uint8Array)[0]).toBe(0);

      // Mutating a snapshot must not affect later queries.
      const beforeMutation = snapshot(fused);
      const mutable = snapshot(fused) as unknown as {
        latches: { U6: number };
        leds: number[];
        switches: Record<string, boolean>;
        pcf8591: { analog: number[] };
        ledStates: { current: number }[];
      };
      mutable.latches.U6 = 999;
      mutable.leds[0] = beforeMutation.leds[0]! + 999;
      mutable.switches.S9 = true;
      mutable.pcf8591.analog[0] = 9;
      mutable.ledStates[0]!.current = 9;
      const fresh = snapshot(fused);
      expect(fresh.latches.U6).toBe(0xa5);
      expect(fresh.leds[0]).toBe(beforeMutation.leds[0]);
      expect(fresh.switches.S9).toBe(false);
      expect(fresh.pcf8591.analog[0]).toBe(0);
      expect(fresh.ledStates[0]!.current).toBe(beforeMutation.ledStates[0]!.current);
      expect(fresh.ledStates[1]!.brightness).toBeGreaterThan(0);
      expect(fresh.ledStates[1]!.voltage).toBeGreaterThan(0);

      // Late subscriber: listen first, query the current state, then mutate.
      const observed: number[] = [];
      const late = fused.board.topics.onDidReceive((message) => {
        if (message.topic !== 'signal') return;
        const value = message.payload as { designator: string; port: string; value: number };
        if (value.designator === 'S9' && value.port === 'pressed') observed.push(value.value);
      });
      try {
        expect(snapshot(fused).switches.S9).toBe(false);
        fused.methods.setSwitch!({ designator: 'S9', pressed: true });
        fused.board.runUntil(1_000_000);
        expect(observed).toEqual([1]);
        expect(snapshot(fused).switches.S9).toBe(true);
      } finally {
        late.dispose();
      }
    } finally {
      subscription.dispose();
      fused.dispose();
    }
  }, 60_000);
});
