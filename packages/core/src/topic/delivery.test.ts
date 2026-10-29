import { describe, expect, it } from 'vitest';
import { timePs, type TimePs } from '../scheduler/time';
import {
  DEFAULT_TOPIC_CAPACITY,
  DELIVERY_KINDS,
  TopicInbox,
  defaultDelivery,
  parseDeliveryKind,
  resolveDelivery,
} from './delivery';
import type { DeliveryKind, TopicDeliveryDiagnostic, TopicEnvelope } from './delivery';
import { PAYLOAD_TYPES } from '../format/type-name';

function envelope<T>(payload: T, simTime: number): TopicEnvelope<T> {
  return { payload, simTime: timePs(simTime) as TimePs };
}

function recordingInbox(delivery: DeliveryKind, capacity?: number) {
  const diagnostics: TopicDeliveryDiagnostic[] = [];
  const inbox = new TopicInbox<number>({
    delivery,
    port: 'value',
    ...(capacity === undefined ? {} : { capacity }),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  return { inbox, diagnostics };
}

describe('delivery declaration', () => {
  it('defaults scalars to level and text/bytes to message', () => {
    const defaults = Object.fromEntries(PAYLOAD_TYPES.map((type) => [type, defaultDelivery(type)]));

    expect(defaults).toEqual({
      boolean: 'level',
      number: 'level',
      vec2d: 'level',
      vec3d: 'level',
      string: 'message',
      bytes: 'message',
      'bytes<rgb565>': 'message',
      'bytes<segments>': 'message',
    });
  });

  it('accepts exactly the two kinds', () => {
    expect(DELIVERY_KINDS).toEqual(['level', 'message']);
    expect(parseDeliveryKind('level')).toBe('level');
    expect(parseDeliveryKind('message')).toBe('message');
    for (const value of ['Level', 'latest', '', undefined, null, 1]) {
      expect(parseDeliveryKind(value)).toBeUndefined();
    }
  });

  it('lets the declared kind override the payload type default', () => {
    expect(resolveDelivery('message', 'boolean')).toBe('message');
    expect(resolveDelivery('level', 'bytes<rgb565>')).toBe('level');
    expect(resolveDelivery(undefined, 'number')).toBe('level');
    expect(resolveDelivery(undefined, 'string')).toBe('message');
    // An unparsable declaration falls back to the default; the loader reports it instead.
    expect(resolveDelivery('latest', 'string')).toBe('message');
  });
});

describe('TopicInbox level', () => {
  it('keeps only the last record posted in one step', () => {
    const { inbox, diagnostics } = recordingInbox('level');

    expect(inbox.post(envelope(1, 10))).toBe(true);
    expect(inbox.post(envelope(2, 11))).toBe(true);

    expect(inbox.pending).toBe(1);
    expect(inbox.takeInput()).toBe(2);
    expect(diagnostics).toEqual([]);
  });

  it('treats falsy payloads as real deliveries', () => {
    for (const payload of [0, false, '', new Uint8Array(0)]) {
      const inbox = new TopicInbox<unknown>({ delivery: 'level', port: 'value' });
      expect(inbox.post(envelope(payload, 0))).toBe(true);
      expect(inbox.takeInput()).toBe(payload);
      expect(inbox.current).toBe(payload);
    }
  });

  it('reports no input on a silent step but keeps the effective value', () => {
    const { inbox } = recordingInbox('level');
    inbox.post(envelope(7, 100));
    expect(inbox.takeInput()).toBe(7);

    inbox.endStep();

    expect(inbox.takeInput()).toBeUndefined();
    expect(inbox.current).toBe(7);
  });

  it('replaces the effective value instead of queueing it', () => {
    const { inbox } = recordingInbox('level');
    inbox.post(envelope(1, 0));
    inbox.endStep();
    inbox.post(envelope(2, 1));

    expect(inbox.current).toBe(2);
    expect(inbox.takeInputs().map((record) => record.payload)).toEqual([2]);
  });
});

describe('TopicInbox message', () => {
  it('delivers every record in publish order with its own timestamp', () => {
    const { inbox } = recordingInbox('message');
    inbox.post(envelope(1, 5));
    inbox.post(envelope(2, 6));

    expect(inbox.takeInputs()).toEqual([envelope(1, 5), envelope(2, 6)]);
    expect(inbox.takeInput()).toBe(2);
  });

  it('drops records at the end of the step', () => {
    const { inbox } = recordingInbox('message');
    inbox.post(envelope(1, 0));
    inbox.post(envelope(2, 0));
    inbox.endStep();

    expect(inbox.pending).toBe(0);
    expect(inbox.takeInputs()).toEqual([]);
    expect(inbox.current).toBeUndefined();
  });

  it('rejects a record at capacity and keeps the accepted ones', () => {
    const { inbox, diagnostics } = recordingInbox('message', 2);

    expect(inbox.post(envelope(1, 0))).toBe(true);
    expect(inbox.post(envelope(2, 0))).toBe(true);
    expect(inbox.post(envelope(3, 0))).toBe(false);

    expect(diagnostics).toEqual([
      {
        code: 'topic/backpressure',
        message: expect.stringContaining('2-record capacity'),
        port: 'value',
      },
    ]);
    expect(inbox.takeInputs().map((record) => record.payload)).toEqual([1, 2]);
  });

  it('defaults the capacity to the shared limit', () => {
    const { inbox } = recordingInbox('message');
    expect(inbox.capacity).toBe(DEFAULT_TOPIC_CAPACITY);
    expect(inbox.delivery).toBe('message');
  });
});

describe('TopicInbox diagnostics', () => {
  it('reports a port that mixes takeInput and takeInputs once', () => {
    const { inbox, diagnostics } = recordingInbox('message');
    inbox.post(envelope(1, 0));

    inbox.takeInput();
    inbox.takeInputs();
    inbox.takeInput();

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['topic/mixed-read']);
  });

  it('does not report a port that reads one way per step', () => {
    const { inbox, diagnostics } = recordingInbox('message');
    inbox.post(envelope(1, 0));
    inbox.takeInputs();
    inbox.endStep();
    inbox.post(envelope(2, 0));
    inbox.takeInput();

    expect(diagnostics).toEqual([]);
  });

  it('survives a throwing diagnostic sink', () => {
    const inbox = new TopicInbox<number>({
      delivery: 'message',
      capacity: 1,
      port: 'value',
      onDiagnostic: () => {
        throw new Error('sink boom');
      },
    });
    inbox.post(envelope(1, 0));

    expect(inbox.post(envelope(2, 0))).toBe(false);
    expect(inbox.takeInputs()).toHaveLength(1);
  });
});
