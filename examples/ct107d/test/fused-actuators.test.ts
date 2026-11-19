// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../device/.mica/device.d.ts" />
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../device/src/mcu-package.d.ts" />
// This example does not declare @mica-js/core directly; tests reuse its lifecycle
// source rather than duplicating an event sink.
import { DisposableStore, Emitter } from '../../../packages/core/src/lifecycle/index.ts';
import { describe, expect, it } from 'vitest';
import { createFusedCt107dBoard } from '../bench/fused';
import { create as createAdapter } from '../device/src/index';
import { assemble } from './fixtures/8051/assemble';

const MS = 1_000_000_000;
const SECOND = 1_000 * MS;

interface SignalValue {
  readonly designator: string;
  readonly port: string;
  readonly value: number;
}
interface ActuatorMessage {
  readonly target: number;
  readonly active: boolean;
  readonly value: number;
}
interface ActuatorStateMessage {
  readonly relay: boolean;
  readonly buzzer: boolean;
}
interface Snapshot {
  readonly relay: boolean;
  readonly buzzer: boolean;
}
type Adapter = ReturnType<typeof createAdapter>;
type Batch = Parameters<Adapter['sync']>[0];
type Message = { readonly value: unknown };

function makeAdapter() {
  const resources = new DisposableStore();
  try {
    const signal = resources.add(new Emitter<SignalValue>());
    const unused = resources.add(new Emitter<never>());
    const adapter = createAdapter({
      props: {
        clockFrequency: 11_059_200,
        ultrasonicDistanceCm: 100,
        uartBaud: 9600,
        firmware: null,
      },
      inputs: {},
      events: {
        onDidSignal: signal,
        onDidBytes: unused,
        onDidUart1Tx: unused,
        onDidUart1Rx: unused,
        onDidAmplifier: unused,
      },
      attachJit: () => ({ dispose() {} }),
      loadBytes() {},
      reportError() {},
    } as never);
    resources.add({ dispose: () => adapter.dispose() });

    const notifications: { value: SignalValue; snapshot: Snapshot }[] = [];
    resources.add(
      signal.event((value) => {
        notifications.push({
          value,
          snapshot: adapter.methods.getSnapshot!(null) as Snapshot,
        });
      }),
    );

    const sync = (outputs: Readonly<Record<string, readonly Message[]>>): void => {
      adapter.sync({ outputs: { uart1Tx: [], uart1Rx: [], ...outputs } } as unknown as Batch);
    };
    const snapshot = (): Snapshot => adapter.methods.getSnapshot!(null) as Snapshot;

    return {
      sync,
      snapshot,
      notifications,
      dispose: () => resources.dispose(),
    };
  } catch (error) {
    resources.dispose();
    throw error;
  }
}

const actuator = (target: number, active: boolean): Message => ({
  value: { target, active, value: 0 } satisfies ActuatorMessage,
});
const state = (relay: boolean, buzzer: boolean): Message => ({
  value: { relay, buzzer } satisfies ActuatorStateMessage,
});
const targetSignals = (
  notifications: readonly { value: SignalValue }[],
  designator: string,
  port: string,
): number[] =>
  notifications
    .filter((entry) => entry.value.designator === designator && entry.value.port === port)
    .map((entry) => entry.value.value);

function withAdapter(run: (session: ReturnType<typeof makeAdapter>) => void): void {
  const session = makeAdapter();
  try {
    run(session);
  } finally {
    session.dispose();
  }
}

describe('actuator adapter snapshots and history', () => {
  it('keeps relay state when buzzer history overflows and converges the last edge', () => {
    withAdapter(({ sync, snapshot, notifications }) => {
      sync({
        actuator: [actuator(0, false), actuator(1, false)],
        actuatorState: [state(false, false)],
      });
      notifications.length = 0;

      // Forty buzzer transitions evict the relay=true history edge in the real model.
      const history: Message[] = [];
      for (let index = 0; index < 40; index += 1) history.push(actuator(1, index % 2 === 0));
      sync({ actuator: history, actuatorState: [state(true, true)] });

      expect(snapshot()).toMatchObject({ relay: true, buzzer: true });
      expect(targetSignals(notifications, 'K1', 'energized').at(-1)).toBe(1);
      expect(targetSignals(notifications, 'SP1', 'active').at(-1)).toBe(1);
      expect(targetSignals(notifications, 'SP1', 'active').slice(0, 40)).toEqual(
        history.map((message) => ((message.value as ActuatorMessage).active ? 1 : 0)),
      );
      // Every notification of the batch observes the final whole-batch snapshot.
      expect(notifications.every((entry) => entry.snapshot.relay && entry.snapshot.buzzer)).toBe(
        true,
      );
    });
  });

  it('keeps buzzer state when relay history overflows (symmetric)', () => {
    withAdapter(({ sync, snapshot, notifications }) => {
      sync({
        actuator: [actuator(0, false), actuator(1, false)],
        actuatorState: [state(false, false)],
      });
      notifications.length = 0;

      const history: Message[] = [];
      for (let index = 0; index < 40; index += 1) history.push(actuator(0, index % 2 === 0));
      history.push(actuator(0, false));
      sync({ actuator: history, actuatorState: [state(false, true)] });

      expect(snapshot()).toMatchObject({ relay: false, buzzer: true });
      expect(targetSignals(notifications, 'K1', 'energized').at(-1)).toBe(0);
      expect(targetSignals(notifications, 'SP1', 'active').at(-1)).toBe(1);
      expect(notifications.every((entry) => !entry.snapshot.relay && entry.snapshot.buzzer)).toBe(
        true,
      );

      // A no-change batch must not repeat the convergence notification.
      const count = notifications.length;
      sync({ actuatorState: [state(false, true)] });
      expect(notifications).toHaveLength(count);
    });
  });

  it('converges a true to false final state and publishes initial state only once', () => {
    withAdapter(({ sync, snapshot, notifications }) => {
      sync({ uart1Tx: [], uart1Rx: [] });
      expect(snapshot()).toMatchObject({ relay: false, buzzer: false });
      expect(targetSignals(notifications, 'K1', 'energized')).toEqual([0]);
      expect(targetSignals(notifications, 'SP1', 'active')).toEqual([0]);

      sync({ uart1Tx: [], uart1Rx: [] });
      expect(notifications).toHaveLength(2);

      sync({ actuatorState: [state(true, true)] });
      expect(snapshot()).toMatchObject({ relay: true, buzzer: true });
      expect(targetSignals(notifications, 'K1', 'energized')).toEqual([0, 1]);
      expect(targetSignals(notifications, 'SP1', 'active')).toEqual([0, 1]);

      const count = notifications.length;
      sync({ actuatorState: [state(true, true)] });
      expect(notifications).toHaveLength(count);

      // Historical true edges are published, then the authoritative final false state
      // is restored once; the stale history never overwrites the snapshot.
      const history = [actuator(0, true), actuator(1, true)];
      sync({ actuator: history, actuatorState: [state(false, false)] });
      expect(snapshot()).toMatchObject({ relay: false, buzzer: false });
      expect(targetSignals(notifications, 'K1', 'energized')).toEqual([0, 1, 1, 0]);
      expect(targetSignals(notifications, 'SP1', 'active')).toEqual([0, 1, 1, 0]);
      expect(
        notifications.slice(4).every((entry) => !entry.snapshot.relay && !entry.snapshot.buzzer),
      ).toBe(true);
    });
  });

  it('produces the same snapshot and final notifications for coarse and fine batches', () => {
    withAdapter((coarse) => {
      withAdapter((fine) => {
        coarse.sync({
          actuator: [actuator(0, false), actuator(1, false)],
          actuatorState: [state(false, false)],
        });
        coarse.sync({
          actuator: [actuator(1, true), actuator(1, false), actuator(1, true)],
          actuatorState: [state(true, true)],
        });

        fine.sync({
          actuator: [actuator(0, false), actuator(1, false)],
          actuatorState: [state(false, false)],
        });
        fine.sync({ actuator: [actuator(1, true)], actuatorState: [state(false, true)] });
        fine.sync({ actuator: [actuator(0, true)], actuatorState: [state(true, true)] });
        fine.sync({ actuator: [actuator(1, false)], actuatorState: [state(true, false)] });
        fine.sync({ actuator: [actuator(1, true)], actuatorState: [state(true, true)] });

        expect(coarse.snapshot()).toEqual(fine.snapshot());
        expect(targetSignals(coarse.notifications, 'K1', 'energized').at(-1)).toBe(
          targetSignals(fine.notifications, 'K1', 'energized').at(-1),
        );
        expect(targetSignals(coarse.notifications, 'SP1', 'active').at(-1)).toBe(
          targetSignals(fine.notifications, 'SP1', 'active').at(-1),
        );
      });
    });
  });
});

const firmware = (body: string): Uint8Array =>
  assemble(`        ORG 0\n${body}\nEND:\n        SJMP END\n`);

// Both actuators start on, then 40 buzzer-only transitions fill the history channel.
const relaySurvivesBuzzerChurn = firmware(`
        MOV P0,#0xD0
        MOV P2,#0xA0
        MOV P2,#0x00
        MOV R5,#40
A_LOOP:
        MOV P0,#0x90
        MOV P2,#0xA0
        MOV P2,#0x00
        MOV R6,#100
A_D1:
        MOV R7,#250
A_D2:
        DJNZ R7,A_D2
        DJNZ R6,A_D1
        MOV P0,#0xD0
        MOV P2,#0xA0
        MOV P2,#0x00
        MOV R6,#100
A_D3:
        MOV R7,#250
A_D4:
        DJNZ R7,A_D4
        DJNZ R6,A_D3
        DJNZ R5,A_LOOP
        MOV P0,#0x90
        MOV P2,#0xA0
        MOV P2,#0x00
`);

// Buzzer stays on while 40 relay transitions fill the history channel.
const buzzerSurvivesRelayChurn = firmware(`
        MOV P0,#0xD0
        MOV P2,#0xA0
        MOV P2,#0x00
        MOV R5,#40
B_LOOP:
        MOV P0,#0x40
        MOV P2,#0xA0
        MOV P2,#0x00
        MOV R6,#100
B_D1:
        MOV R7,#250
B_D2:
        DJNZ R7,B_D2
        DJNZ R6,B_D1
        MOV P0,#0xD0
        MOV P2,#0xA0
        MOV P2,#0x00
        MOV R6,#100
B_D3:
        MOV R7,#250
B_D4:
        DJNZ R7,B_D4
        DJNZ R6,B_D3
        DJNZ R5,B_LOOP
        MOV P0,#0x40
        MOV P2,#0xA0
        MOV P2,#0x00
`);

// Both actuators stay on past 100 ms, then relay turns off and buzzer churns to off.
const bothThenClose = firmware(`
        MOV P0,#0xD0
        MOV P2,#0xA0
        MOV P2,#0x00
        MOV R5,#30
C_D1:
        MOV R6,#100
C_D2:
        MOV R7,#250
C_D3:
        DJNZ R7,C_D3
        DJNZ R6,C_D2
        DJNZ R5,C_D1
        MOV P0,#0x40
        MOV P2,#0xA0
        MOV P2,#0x00
        MOV R5,#40
C_LOOP:
        MOV P0,#0x00
        MOV P2,#0xA0
        MOV P2,#0x00
        MOV R6,#100
C_D4:
        MOV R7,#250
C_D5:
        DJNZ R7,C_D5
        DJNZ R6,C_D4
        MOV P0,#0x40
        MOV P2,#0xA0
        MOV P2,#0x00
        MOV R6,#100
C_D6:
        MOV R7,#250
C_D7:
        DJNZ R7,C_D7
        DJNZ R6,C_D6
        DJNZ R5,C_LOOP
        MOV P0,#0x00
        MOV P2,#0xA0
        MOV P2,#0x00
`);

type Fused = Awaited<ReturnType<typeof createFusedCt107dBoard>>;
interface Captured {
  signals: SignalValue[];
  snapshot(): Snapshot;
  runUntil(target: number): void;
  dispose(): void;
}

function capture(fused: Fused): Captured {
  const signals: SignalValue[] = [];
  const subscription = fused.board.topics.onDidReceive((message) => {
    if (message.topic === 'signal') signals.push(message.payload as SignalValue);
  });
  return {
    signals,
    snapshot: () => fused.methods.getSnapshot!(null) as Snapshot,
    runUntil: (target) => fused.board.runUntil(target),
    dispose() {
      subscription.dispose();
      fused.dispose();
    },
  };
}

async function createCaptured(firmwareImage: Uint8Array): Promise<Captured> {
  const fused = await createFusedCt107dBoard({ firmware: firmwareImage });
  try {
    return capture(fused);
  } catch (error) {
    fused.dispose();
    throw error;
  }
}

async function runInSteps(firmwareImage: Uint8Array, steps: readonly number[]): Promise<Captured> {
  const captured = await createCaptured(firmwareImage);
  try {
    captured.runUntil(0);
    let time = 0;
    for (const step of steps) {
      time += step;
      captured.runUntil(time);
    }
    return captured;
  } catch (error) {
    captured.dispose();
    throw error;
  }
}

const signalValues = (captured: Captured, designator: string, port: string): number[] =>
  captured.signals
    .filter((value) => value.designator === designator && value.port === port)
    .map((value) => value.value);
const last = (captured: Captured, designator: string, port: string): number | undefined =>
  signalValues(captured, designator, port).at(-1);

describe('fused actuator batch regressions', () => {
  it('keeps relay=true and the last K1 notification after a coarse buzzer burst', async () => {
    const boards: Captured[] = [];
    try {
      const coarse = await runInSteps(relaySurvivesBuzzerChurn, [SECOND]);
      boards.push(coarse);
      const step100 = await runInSteps(
        relaySurvivesBuzzerChurn,
        Array.from({ length: 10 }, () => 100 * MS),
      );
      boards.push(step100);
      const step10 = await runInSteps(
        relaySurvivesBuzzerChurn,
        Array.from({ length: 100 }, () => 10 * MS),
      );
      boards.push(step10);

      for (const captured of boards)
        expect(captured.snapshot()).toMatchObject({ relay: true, buzzer: false });
      expect(last(coarse, 'K1', 'energized')).toBe(1);
      expect(last(coarse, 'SP1', 'active')).toBe(0);
      expect(last(step100, 'K1', 'energized')).toBe(1);
      expect(last(step10, 'K1', 'energized')).toBe(1);

      // runInSteps first drains startup at t=0, then advances once to 1 s. The second
      // batch therefore queues 82 buzzer transitions, and the bounded history keeps
      // only the newest 32 (plus the startup notification) before the adapter sync.
      expect(signalValues(coarse, 'SP1', 'active')).toHaveLength(33);
      expect(signalValues(coarse, 'K1', 'energized')).toEqual([0, 1]);
      // The relay=true history edge was evicted; the only K1=true notification is the
      // end-of-batch convergence emitted after every retained SP1 history edge.
      expect(coarse.signals.findLastIndex((value) => value.designator === 'K1')).toBeGreaterThan(
        coarse.signals.findLastIndex((value) => value.designator === 'SP1'),
      );
    } finally {
      for (const captured of boards) captured.dispose();
    }
  }, 120_000);

  it('keeps buzzer=true and the last SP1 notification after a coarse relay burst', async () => {
    const boards: Captured[] = [];
    try {
      const coarse = await runInSteps(buzzerSurvivesRelayChurn, [SECOND]);
      boards.push(coarse);
      const fine = await runInSteps(
        buzzerSurvivesRelayChurn,
        Array.from({ length: 100 }, () => 10 * MS),
      );
      boards.push(fine);

      for (const captured of boards)
        expect(captured.snapshot()).toMatchObject({ relay: false, buzzer: true });
      expect(last(coarse, 'K1', 'energized')).toBe(0);
      expect(last(coarse, 'SP1', 'active')).toBe(1);
      expect(last(fine, 'SP1', 'active')).toBe(1);

      // The coarse batch keeps the newest 32 relay transitions; the startup SP1=true
      // edge is evicted, so SP1 is reported once at startup and once by convergence.
      expect(signalValues(coarse, 'K1', 'energized')).toHaveLength(33);
      expect(signalValues(coarse, 'SP1', 'active')).toEqual([0, 1]);
      // The only SP1=true notification follows the retained relay history, proving the
      // historical SP1 edge was not merely replayed from the queue.
      expect(coarse.signals.findLastIndex((value) => value.designator === 'SP1')).toBeGreaterThan(
        coarse.signals.findLastIndex((value) => value.designator === 'K1'),
      );
    } finally {
      for (const captured of boards) captured.dispose();
    }
  }, 120_000);

  it('closes both outputs after a prior energized snapshot and a long batch', async () => {
    const boards: Captured[] = [];
    try {
      const coarse = await createCaptured(bothThenClose);
      boards.push(coarse);
      const fine = await createCaptured(bothThenClose);
      boards.push(fine);

      coarse.runUntil(0);
      coarse.runUntil(100 * MS);
      expect(coarse.snapshot()).toMatchObject({ relay: true, buzzer: true });
      coarse.runUntil(2 * SECOND);
      expect(coarse.snapshot()).toMatchObject({ relay: false, buzzer: false });
      expect(last(coarse, 'K1', 'energized')).toBe(0);
      expect(last(coarse, 'SP1', 'active')).toBe(0);

      fine.runUntil(0);
      fine.runUntil(100 * MS);
      for (let step = 110; step <= 2000; step += 10) fine.runUntil(step * MS);
      expect(fine.snapshot()).toEqual(coarse.snapshot());
      expect(last(fine, 'K1', 'energized')).toBe(0);
      expect(last(fine, 'SP1', 'active')).toBe(0);
    } finally {
      for (const captured of boards) captured.dispose();
    }
  }, 120_000);
});
