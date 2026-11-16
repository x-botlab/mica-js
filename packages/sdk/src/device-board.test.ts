import { describe, expect, it } from 'vitest';
import { compileDDL } from '@mica-js/ddl';
import type {
  ChannelMessage,
  DeviceBatch,
  DeviceContext,
  Disposable,
  TopicMessage,
} from '@mica-js/simulator';
import { createBoard, createDeviceLibrary } from './index';
import { adaptModelFactory, firmwareImage, type FirmwareImage, type ModelContext } from './device';

interface ProbeProps {
  readonly gain: number;
  readonly label: string;
  readonly firmware: FirmwareImage | null;
}

type ProbeEvents = {
  readonly onDidLoaded: number;
  readonly onDidLevel: number;
  readonly onDidResistance: number;
};

type ProbeBatch = DeviceBatch<{
  readonly loaded: readonly ChannelMessage<number>[];
  readonly level: readonly ChannelMessage<number>[];
  readonly resistance: readonly ChannelMessage<number>[];
}>;

describe('simulator adapter integration', () => {
  it('runs loadBytes, legacy input mapping, output events and dispose through createBoard', async () => {
    const model = await compileDDL(`
      device AdapterProbe(gain: number default 1) {
        pin a = [resistor(to: b, resistance: 1_000_000_000)];
        pin b;
        memory code[4];
        state pc: number = 0;
        input channel press: bool(capacity: 1);
        output channel loaded: number(capacity: 1);
        output channel level: number(capacity: 1);
        output channel resistance: number(capacity: 1);
        process start {
          loaded.send(load8(code, 0) + gain);
          loop {
            const pressed = await press.receive();
            a.intent <- [resistor(to: b, resistance: pressed ? 100 : 1_000_000_000)];
            level.send(pressed ? 1 : 0);
            resistance.send(pressed ? 100 : 1_000_000_000);
          }
        }
      }
    `);

    const source = Uint8Array.of(7);
    let captured: Readonly<ProbeProps> | undefined;
    let modelDisposals = 0;
    const unified = (
      context: ModelContext<DeviceContext, ProbeProps, ProbeEvents>,
    ): {
      readonly methods: { readonly press: (value: boolean) => null };
      sync(batch: ProbeBatch): void;
      dispose(): void;
    } => {
      captured = context.props;
      const registration = context.attachJit({
        entry: 'probe',
        code: 'code',
        pc: 'pc',
        translate: ({ pc }, block) => {
          block.instruction({ pc, nextPc: pc + 1 }, (body) => {
            body.elapse(1);
          });
          return block.finish();
        },
      });
      const data = context.props.firmware?.segments[0]?.data.slice() ?? new Uint8Array([0]);
      context.loadBytes('code', data);
      registration.dispose();
      return {
        methods: {
          press(value) {
            (
              context.inputs as unknown as Record<string, { send(value: boolean): void }>
            ).press!.send(value);
            return null;
          },
        },
        sync(batch) {
          for (const message of batch.outputs.loaded)
            context.events.onDidLoaded.fire(message.value);
          for (const message of batch.outputs.level) context.events.onDidLevel.fire(message.value);
          for (const message of batch.outputs.resistance)
            context.events.onDidResistance.fire(message.value);
        },
        dispose() {
          modelDisposals += 1;
        },
      };
    };

    const adapted = adaptModelFactory(unified, {
      props: (legacy) => ({
        ...(legacy.props as { readonly gain: number }),
        label: 'board',
        firmware: firmwareImage([{ addressSpace: 'code', address: 0, data: source }]),
      }),
      events: {
        onDidLoaded: 'loaded',
        onDidLevel: 'level',
        onDidResistance: 'resistance',
      },
      inputs: {
        press: 'press',
      },
    });

    let activeInputs = 0;
    const create = (
      context: DeviceContext,
    ): Disposable & {
      readonly methods: { readonly press: (value: boolean) => null };
      sync(batch: ProbeBatch): void;
    } => {
      const topics = context.topics;
      const wrapped = {
        ...context,
        topics: {
          ...topics,
          onDidReceive(
            listener: (message: TopicMessage) => unknown,
            thisArgs?: unknown,
            disposables?: Disposable[],
          ) {
            activeInputs += 1;
            const subscription = topics.onDidReceive(listener, thisArgs, disposables);
            return {
              dispose() {
                activeInputs -= 1;
                subscription.dispose();
              },
            };
          },
        },
      } as DeviceContext;
      return adapted(wrapped) as Disposable & {
        readonly methods: { readonly press: (value: boolean) => null };
        sync(batch: ProbeBatch): void;
      };
    };

    const board = createBoard(
      createDeviceLibrary([{ id: 'probe', model, create: create as never }]),
      {
        instances: [{ id: 'probe', type: 'probe', props: { gain: 2 } }],
        nets: [
          { id: 'a', voltage: 5, pins: [{ instance: 'probe', pin: 'a' }] },
          { id: 'b', voltage: 0, pins: [{ instance: 'probe', pin: 'b' }] },
        ],
      },
    );
    const messages: TopicMessage[] = [];
    const subscription = board.topics.onDidReceive((message) => messages.push(message));
    try {
      expect(board.status).toBe('ready');
      expect(activeInputs).toBe(1);
      expect(captured?.gain).toBe(2);
      expect(Object.isFrozen(captured)).toBe(true);
      expect(Object.isFrozen(captured?.firmware)).toBe(true);

      source[0] = 99;
      expect(captured?.firmware?.segments[0]?.data.slice()).toEqual(new Uint8Array([7]));

      board.runUntil(1);
      expect(messages).toContainEqual(expect.objectContaining({ topic: 'loaded', payload: 9 }));

      board.topics.publish('press', true);
      board.runUntil(2_000_000_000);
      expect(messages).toContainEqual(expect.objectContaining({ topic: 'level', payload: 1 }));
      expect(messages).toContainEqual(
        expect.objectContaining({ topic: 'resistance', payload: 100 }),
      );
    } finally {
      subscription.dispose();
      board.dispose();
    }
    expect(activeInputs).toBe(0);
    expect(modelDisposals).toBe(1);
  });
});
