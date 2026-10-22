import { describe, expect, it } from 'vitest';
import { parseDeviceDescription } from '../description';
import { DeviceError, type DeviceErrorCode } from '../errors';

const METADATA = { name: 'acme:switch' } as const;

function parse(raw: Record<string, unknown>) {
  return parseDeviceDescription(raw, METADATA);
}

function expectCode(raw: Record<string, unknown>, code: DeviceErrorCode, pointer?: string): void {
  let caught: unknown;
  try {
    parse(raw);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DeviceError);
  const error = caught as DeviceError;
  expect(error.code).toBe(code);
  if (pointer !== undefined) {
    expect(error.pointer).toBe(pointer);
  }
}

describe('device connection declarations', () => {
  it('parses pins, initial states and the default open state', () => {
    const description = parse({
      pins: { A: { kind: 'signal' }, B: { kind: 'signal' }, C: { kind: 'signal' } },
      connections: {
        contact: { pins: ['A', 'B'] },
        'normally-closed': { pins: ['B', 'C'], initial: 'closed' },
      },
    });

    expect([...description.connections.keys()]).toEqual(['contact', 'normally-closed']);
    expect(description.connections.get('contact')).toEqual({
      key: 'contact',
      pins: ['A', 'B'],
      initial: 'open',
    });
    expect(description.connections.get('normally-closed')?.initial).toBe('closed');
  });

  it('treats an omitted connections object as empty', () => {
    expect(parse({}).connections.size).toBe(0);
    expect(parse({ pins: { A: { kind: 'signal' } } }).connections.size).toBe(0);
  });

  it('rejects malformed containers and entries', () => {
    expectCode({ connections: [] }, 'schema/invalid-type', '/connections');
    expectCode({ connections: { contact: [] } }, 'schema/invalid-type', '/connections/contact');
    expectCode(
      { connections: { '': { pins: ['A', 'B'] } } },
      'schema/invalid-value',
      '/connections',
    );
    expectCode(
      {
        pins: { A: { kind: 'signal' }, B: { kind: 'signal' } },
        connections: { contact: { pins: ['A', 'B'], extra: true } },
      },
      'schema/unknown-field',
      '/connections/contact/extra',
    );
  });

  it('rejects illegal pin pairs before they reach the topology', () => {
    const pins = { A: { kind: 'signal' }, B: { kind: 'signal' } };
    expectCode(
      { pins, connections: { contact: { pins: 'A,B' } } },
      'schema/invalid-type',
      '/connections/contact/pins',
    );
    expectCode(
      { pins, connections: { contact: { pins: ['A'] } } },
      'schema/invalid-value',
      '/connections/contact/pins',
    );
    expectCode(
      { pins, connections: { contact: { pins: ['A', 'A'] } } },
      'schema/invalid-value',
      '/connections/contact/pins',
    );
    expectCode(
      { pins, connections: { contact: { pins: ['A', 'C'] } } },
      'schema/invalid-value',
      '/connections/contact/pins/1',
    );
    expectCode(
      { pins, connections: { contact: { pins: ['A', ''] } } },
      'schema/invalid-type',
      '/connections/contact/pins/1',
    );
    expectCode(
      { pins, connections: { contact: { pins: ['A', 1] } } },
      'schema/invalid-type',
      '/connections/contact/pins/1',
    );
  });

  it('rejects an unknown initial state', () => {
    expectCode(
      {
        pins: { A: { kind: 'signal' }, B: { kind: 'signal' } },
        connections: { contact: { pins: ['A', 'B'], initial: 'half' } },
      },
      'schema/invalid-value',
      '/connections/contact/initial',
    );
  });

  it('rejects connection pins when the description declares no pins', () => {
    expectCode(
      { connections: { contact: { pins: ['A', 'B'] } } },
      'schema/invalid-value',
      '/connections/contact/pins/0',
    );
  });
});
