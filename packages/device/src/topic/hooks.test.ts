import { createScheduler } from '@mica-js/core';
import { describe, expect, it } from 'vitest';
import { createForTest, expectDeviceError, testDescription } from '../lifecycle/test-helpers';
import type {
  DeviceBindings,
  DeviceDiagnostic,
  DeviceFactory,
  DeviceInputIO,
  DeviceOutputIO,
  DeviceTopicMessage,
} from '../types';

function stepDescription() {
  return testDescription({
    ports: {
      levelIn: { direction: 'input', type: 'number' },
      msgIn: { direction: 'input', type: 'string' },
      levelOut: { direction: 'output', type: 'number' },
      bytesOut: { direction: 'output', type: 'bytes' },
    },
  });
}

function collectDiagnostics(): DeviceDiagnostic[] {
  return [];
}

describe('device step hooks', () => {
  it('accepts applyInputs and flushOutputs as factory bindings', () => {
    let calls = 0;
    const bindings: DeviceBindings = {
      applyInputs: () => {
        calls += 1;
      },
      flushOutputs: () => {
        calls += 1;
      },
    };
    const { instance } = createForTest(() => bindings, {}, createScheduler(), stepDescription());

    instance.applyInputs();
    instance.flushOutputs();

    expect(calls).toBe(2);
  });

  it('rejects an async step hook', () => {
    expectDeviceError(
      () =>
        createForTest(
          () => ({
            applyInputs: (async () => undefined) as unknown as (io: DeviceInputIO) => void,
          }),
          {},
          createScheduler(),
          stepDescription(),
        ),
      'device/lifecycle-binding',
    );
  });

  it('reads the last payload of a level port and every record of a message port', () => {
    const seen: unknown[] = [];
    const { instance } = createForTest(
      () => ({
        applyInputs(io) {
          seen.push(io.takeInput('levelIn'));
          seen.push([...io.takeInputs('msgIn')]);
        },
      }),
      {},
      createScheduler(),
      stepDescription(),
    );

    instance.deliver('levelIn', 1, { simTime: 0 });
    instance.deliver('levelIn', 2, { simTime: 0 });
    instance.deliver('msgIn', 'a', { simTime: 0 });
    instance.deliver('msgIn', 'b', { simTime: 0 });
    instance.applyInputs();

    expect(seen).toEqual([2, ['a', 'b']]);

    // A silent step reports no delivery, even for a level port (RFC 0017 io table).
    instance.applyInputs();
    expect(seen).toEqual([2, ['a', 'b'], undefined, []]);
  });

  it('reports backpressure instead of throwing when a message port is full', () => {
    const diagnostics = collectDiagnostics();
    const { instance } = createForTest(
      () => ({
        applyInputs(io) {
          io.takeInputs('msgIn');
        },
      }),
      {
        messaging: { deliveryCapacity: 1 },
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      },
      createScheduler(),
      stepDescription(),
    );

    instance.deliver('msgIn', 'kept', { simTime: 0 });
    expect(() => instance.deliver('msgIn', 'dropped', { simTime: 0 })).not.toThrow();

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['topic/backpressure']);
    expect(diagnostics[0]?.port).toBe('msgIn');
  });

  it('reports a port that mixes takeInput and takeInputs', () => {
    const diagnostics = collectDiagnostics();
    const { instance } = createForTest(
      (api) => {
        api.ir.state('unused', 'u32', 0);
        return {
          applyInputs(io) {
            io.takeInput('levelIn');
            io.takeInputs('levelIn');
          },
        };
      },
      { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
      createScheduler(),
      stepDescription(),
    );

    instance.deliver('levelIn', 1, { simTime: 0 });
    instance.applyInputs();

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('topic/mixed-read');
  });

  it('round-trips state and byte memory through the io views', () => {
    const read: unknown[] = [];
    const { instance } = createForTest(
      (api) => {
        api.ir.state('count', 'u32', 0);
        api.ir.state('ratio', 'f32', 0);
        api.ir.state('flag', 'bool', false);
        api.ir.bytes('frame', 4);
        return {
          applyInputs(io) {
            io.writeState('count', 7);
            io.writeState('ratio', 1.5);
            io.writeState('flag', true);
          },
          flushOutputs(io) {
            read.push(io.readState('count'), io.readState('ratio'), io.readState('flag'));
            read.push([...io.readBytes('frame')]);
          },
        };
      },
      {},
      createScheduler(),
      stepDescription(),
    );

    instance.applyInputs();
    instance.flushOutputs();

    expect(read).toEqual([7, 1.5, true, [0, 0, 0, 0]]);
  });

  it('reports a value that does not match the declared state type', () => {
    const diagnostics = collectDiagnostics();
    const { instance } = createForTest(
      (api) => {
        api.ir.state('flag', 'bool', false);
        return {
          applyInputs(io) {
            io.writeState('flag', 1);
          },
        };
      },
      { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
      createScheduler(),
      stepDescription(),
    );

    instance.applyInputs();

    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'device/memory-type', memory: 'flag' }),
    ]);
  });

  it('reports unknown and mistyped memory references', () => {
    const diagnostics = collectDiagnostics();
    const { instance } = createForTest(
      (api) => {
        api.ir.bytes('frame', 2);
        return {
          applyInputs(io) {
            io.writeState('ghost', 1);
            io.writeState('frame', 1);
          },
          flushOutputs(io) {
            io.readFifo('frame');
            io.readBytes('ghost');
          },
        };
      },
      { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
      createScheduler(),
      stepDescription(),
    );

    instance.applyInputs();
    instance.flushOutputs();

    expect(
      diagnostics
        .filter((diagnostic) => diagnostic.code.startsWith('device/memory'))
        .map((diagnostic) => diagnostic.code),
    ).toEqual([
      'device/memory-unknown',
      'device/memory-kind',
      'device/memory-kind',
      'device/memory-unknown',
    ]);
  });

  it('queues fifo records in order and reports overflow by returning false', () => {
    const read: number[][][] = [];
    const overflow: boolean[] = [];
    const { instance } = createForTest(
      (api) => {
        api.ir.fifo('rx', { maxRecord: 4, length: 2 });
        return {
          applyInputs(io) {
            overflow.push(io.writeFifo('rx', new Uint8Array([1])));
            overflow.push(io.writeFifo('rx', new Uint8Array([2, 3])));
            overflow.push(io.writeFifo('rx', new Uint8Array([4])));
            // A record larger than maxRecord is rejected as a diagnostic, not a backpressure.
            overflow.push(io.writeFifo('rx', new Uint8Array([1, 2, 3, 4, 5])));
          },
          flushOutputs(io) {
            read.push(io.readFifo('rx').map((record) => [...record]));
          },
        };
      },
      {},
      createScheduler(),
      stepDescription(),
    );

    instance.applyInputs();
    instance.flushOutputs();
    instance.flushOutputs();

    expect(overflow).toEqual([true, true, false, false]);
    expect(read).toEqual([[[1], [2, 3]], []]);
  });

  it('publishes through the output view and reports rejected ports', () => {
    const published: DeviceTopicMessage[] = [];
    const diagnostics = collectDiagnostics();
    const { instance } = createForTest(
      () => ({
        flushOutputs(io) {
          io.publish('levelOut', 42);
          io.publishBytes('bytesOut', new Uint8Array([9]));
          io.publish('msgIn', 1);
          io.publish('ghost', 1);
        },
      }),
      {
        onTopic: (message) => {
          published.push(message);
        },
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      },
      createScheduler(),
      stepDescription(),
    );

    instance.flushOutputs();

    expect(published).toEqual([
      { port: 'levelOut', payload: 42 },
      { port: 'bytesOut', payload: new Uint8Array([9]) },
    ]);
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'device/topic-direction',
      'device/topic-unknown',
    ]);
  });

  it('reports a declared hook port that the hooks never used', () => {
    const diagnostics = collectDiagnostics();
    const { instance } = createForTest(
      () => ({
        applyInputs(io) {
          io.takeInput('levelIn');
          io.takeInputs('msgIn');
        },
        flushOutputs(io) {
          io.publish('levelOut', 1);
        },
      }),
      { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
      createScheduler(),
      stepDescription(),
    );

    instance.applyInputs();
    instance.flushOutputs();
    instance.applyInputs();
    instance.flushOutputs();

    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'device/port-unused', port: 'bytesOut' }),
    ]);
  });

  it('lets a hook exception reach the host unchanged', () => {
    const { instance } = createForTest(
      () => ({
        applyInputs() {
          throw new Error('hook boom');
        },
      }),
      {},
      createScheduler(),
      stepDescription(),
    );

    expect(() => instance.applyInputs()).toThrow('hook boom');
    // The step still ends, so the next one starts from an empty record set.
    expect(instance.state).toBe('ready');
  });

  it('drops staged deliveries when the instance resets', () => {
    const seen: unknown[] = [];
    const { instance } = createForTest(
      (api) => {
        const reset = api.ir.lifecycle('reset', []);
        reset.body((b) => b.return([]));
        return {
          reset,
          applyInputs(io) {
            seen.push(io.takeInput('levelIn'));
          },
        };
      },
      {},
      createScheduler(),
      stepDescription(),
    );

    instance.deliver('levelIn', 5, { simTime: 0 });
    instance.reset();
    instance.applyInputs();

    expect(seen).toEqual([undefined]);
  });

  it('is a no-op for a device without step hooks', () => {
    const factory: DeviceFactory = () => ({});
    const { instance } = createForTest(factory, {}, createScheduler(), stepDescription());

    instance.deliver('levelIn', 1, { simTime: 0 });
    expect(() => instance.applyInputs()).not.toThrow();
    expect(() => instance.flushOutputs()).not.toThrow();
  });

  it('exposes frozen io views with exactly the documented methods', () => {
    let input: DeviceInputIO | undefined;
    let output: DeviceOutputIO | undefined;
    const { instance } = createForTest(
      () => ({
        applyInputs(io) {
          input = io;
        },
        flushOutputs(io) {
          output = io;
        },
      }),
      {},
      createScheduler(),
      stepDescription(),
    );

    instance.applyInputs();
    instance.flushOutputs();

    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.keys(input ?? {}).sort()).toEqual([
      'report',
      'takeInput',
      'takeInputs',
      'writeFifo',
      'writeState',
    ]);
    expect(Object.keys(output ?? {}).sort()).toEqual([
      'publish',
      'publishBytes',
      'readBytes',
      'readFifo',
      'readState',
    ]);
  });
});
