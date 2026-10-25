import { describe, expect, it, vi } from 'vitest';
import type { Value } from '@mica-js/ir';
import type { TopicPayloadType } from '@mica-js/device';
import { topicPayloadParams } from '../compiler';
import type { DeviceConfig, DeviceDescription } from '../compiler';
import { Circuit } from './circuit';
import { CircuitError } from './types';
import { fromIRArgs, isTopicPayload, toIRArgs } from './topic-payload';

/** A device that publishes its incrementing counter on `out` every tick. */
function sourceDevice(id = 'src1'): DeviceConfig {
  return {
    id,
    type: 'topic-source',
    description: {
      pins: {},
      ports: { out: { direction: 'output', type: 'number' } },
      states: { next: { type: 'f64', initial: 0 } },
      behaviors: {
        tick: (api) => {
          const next = api.state<'f64'>('next');
          const value = api.builder.float.add(next.load(), api.builder.const('f64', 1));
          next.store(value);
          api.topics.publish('out', [value]);
        },
      },
    },
  };
}

/** A device that stores whatever arrives on its input port. */
function sinkDevice(id = 'sink1', port = 'value', type: TopicPayloadType = 'number'): DeviceConfig {
  const description: DeviceDescription = {
    pins: {},
    ports: { [port]: { direction: 'input', type } },
    // f64 states surface as exact `FloatBits` through the generic accessor, so
    // the fixture stores the integer projection and keeps assertions readable.
    states: { received: { type: 'u32', initial: 0 } },
    behaviors: {
      initialize: (api) => {
        api.topics.subscribe(port, (entry) => {
          const value = entry.builder.convert.floatToInt('u32', entry.args[0] as Value<'f64'>);
          entry.state<'u32'>('received').store(value);
        });
      },
    },
  };
  return { id, type: 'topic-sink', description };
}

describe('topic payload encoding', () => {
  it('declares one scalar tuple per payload type', () => {
    expect(topicPayloadParams('boolean')).toEqual(['bool']);
    expect(topicPayloadParams('number')).toEqual(['f64']);
    expect(topicPayloadParams('vec2d')).toEqual(['f64', 'f64']);
    expect(topicPayloadParams('vec3d')).toEqual(['f64', 'f64', 'f64']);
    for (const type of ['string', 'bytes', 'bytes<rgb565>', 'bytes<segments>'] as const) {
      const params = topicPayloadParams(type);
      expect(params[0]).toBe('u32');
      expect(params.length).toBeGreaterThan(1);
      expect(new Set(params)).toEqual(new Set(['u32']));
    }
  });

  it('round-trips every boolean and number payload', () => {
    for (const payload of [true, false] as const) {
      expect(fromIRArgs(toIRArgs(payload, 'boolean'), 'boolean')).toBe(payload);
    }
    for (const payload of [0, -1, 42, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect(fromIRArgs(toIRArgs(payload, 'number'), 'number')).toBe(payload);
    }
  });

  it('round-trips both vector payloads', () => {
    const vec2d = { x: 1.25, y: -3 };
    expect(fromIRArgs(toIRArgs(vec2d, 'vec2d'), 'vec2d')).toEqual(vec2d);
    const vec3d = { x: 1, y: 2, z: 3.5 };
    expect(fromIRArgs(toIRArgs(vec3d, 'vec3d'), 'vec3d')).toEqual(vec3d);
  });

  it('round-trips strings through the UTF-8 byte words', () => {
    for (const payload of ['', 'pressed', 'led 1', '原理图']) {
      expect(fromIRArgs(toIRArgs(payload, 'string'), 'string')).toBe(payload);
    }
  });

  it('round-trips byte payloads of every byte type', () => {
    const payload = Uint8Array.from([0, 1, 127, 128, 255, 42]);
    for (const type of ['bytes', 'bytes<rgb565>', 'bytes<segments>'] as const) {
      const decoded = fromIRArgs(toIRArgs(payload, type), type);
      expect(decoded).toBeInstanceOf(Uint8Array);
      expect([...(decoded as Uint8Array)]).toEqual([...payload]);
    }
  });

  it('rejects payloads that do not match their port type', () => {
    expect(() => toIRArgs('true', 'boolean')).toThrow(CircuitError);
    expect(() => toIRArgs(1, 'string')).toThrow(CircuitError);
    expect(() => toIRArgs({ x: 1 }, 'vec2d')).toThrow(CircuitError);
    expect(() => toIRArgs('abc', 'bytes')).toThrow(CircuitError);
    expect(isTopicPayload(true, 'boolean')).toBe(true);
    expect(isTopicPayload('nope', 'boolean')).toBe(false);
  });

  it('rejects payloads larger than the transport capacity', () => {
    expect(() => toIRArgs('x'.repeat(64), 'string')).toThrow(/transport limit/);
    expect(() => toIRArgs(new Uint8Array(64), 'bytes')).toThrow(/transport limit/);
  });
});

describe('device topics', () => {
  it('delivers a host payload into a device input port', async () => {
    const circuit = await Circuit.create({
      devices: [sinkDevice()],
      connections: [],
    });

    const sink = circuit.devices.sink1;
    expect(sink?.getState('received')).toBe(0);
    circuit.deliverTopic('sink1', 'value', 7);
    expect(sink?.getState('received')).toBe(7);
    circuit.deliverTopic('sink1', 'value', 42);
    expect(sink?.getState('received')).toBe(42);
  });

  it('publishes a device output to host listeners', async () => {
    const circuit = await Circuit.create({ devices: [sourceDevice()], connections: [] });
    const listener = vi.fn();
    circuit.onPublish(listener);

    circuit.runBatch(3);

    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      target: { symbol: 'src1', port: 'out' },
      payload: 1,
    });
    expect(listener.mock.calls[2]?.[0]).toMatchObject({ payload: 3 });
  });

  it('forwards a publish to every subscriber and honours unsubscribe', async () => {
    const circuit = await Circuit.create({ devices: [sourceDevice()], connections: [] });
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = circuit.onPublish(first);
    circuit.onPublish(second);

    circuit.step();
    unsubscribeFirst();
    circuit.step();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('reports the compiled endpoints of both directions', async () => {
    const circuit = await Circuit.create({
      devices: [sourceDevice(), sinkDevice()],
      connections: [],
    });

    expect(circuit.topics).toEqual([
      { deviceId: 'src1', port: 'out', direction: 'output', type: 'number' },
      { deviceId: 'sink1', port: 'value', direction: 'input', type: 'number' },
    ]);
  });

  it('rejects an unknown or output port', async () => {
    const circuit = await Circuit.create({ devices: [sourceDevice()], connections: [] });

    expect(() => circuit.deliverTopic('src1', 'out', 1)).toThrow(/output topic port, not an input/);
    expect(() => circuit.deliverTopic('src1', 'missing', 1)).toThrow(CircuitError);
  });

  it('rejects a payload of the wrong type', async () => {
    const circuit = await Circuit.create({ devices: [sinkDevice()], connections: [] });

    expect(() => circuit.deliverTopic('sink1', 'value', 'nope')).toThrow(/expects a number/);
  });

  it('compiles a device with an input port nobody subscribes to', async () => {
    const circuit = await Circuit.create({
      devices: [
        {
          id: 'open1',
          type: 'topic-open',
          description: { pins: {}, ports: { set: { direction: 'input', type: 'boolean' } } },
        },
      ],
      connections: [],
    });

    expect(() => circuit.deliverTopic('open1', 'set', true)).not.toThrow();
  });

  it('rejects several subscribers on one port', async () => {
    await expect(
      Circuit.create({
        devices: [
          {
            id: 'twice1',
            type: 'topic-twice',
            description: {
              pins: {},
              ports: { set: { direction: 'input', type: 'boolean' } },
              behaviors: {
                initialize: (api) => {
                  api.topics.subscribe('set', () => {});
                  api.topics.subscribe('set', () => {});
                },
              },
            },
          },
        ],
        connections: [],
      }),
    ).rejects.toThrow(/already has a subscriber/);
  });

  it('rejects a publish argument count that does not match the port', async () => {
    await expect(
      Circuit.create({
        devices: [
          {
            id: 'bad1',
            type: 'topic-bad',
            description: {
              pins: {},
              ports: { out: { direction: 'output', type: 'boolean' } },
              behaviors: {
                tick: (api) => {
                  api.topics.publish('out', []);
                },
              },
            },
          },
        ],
        connections: [],
      }),
    ).rejects.toThrow(/expects 1 scalar argument/);
  });

  it('rejects an undeclared port', async () => {
    await expect(
      Circuit.create({
        devices: [
          {
            id: 'bad2',
            type: 'topic-bad',
            description: {
              pins: {},
              behaviors: {
                tick: (api) => {
                  api.topics.publish('out', [api.builder.const('bool', true)]);
                },
              },
            },
          },
        ],
        connections: [],
      }),
    ).rejects.toThrow(/no output topic port/);
  });
});
