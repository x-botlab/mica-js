import { createDeviceBuilder, types } from '@mica-js/sdk/model';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { JitTranslate } from '@mica-js/sdk/device';
import { describe, expect, it } from 'vitest';

const WAIT_PS = 10;

function pollingModel() {
  const builder = createDeviceBuilder({ name: 'PollingWait' });

  builder.memory({ name: 'code', length: 16 });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  builder.state({ name: 'runs', type: types.number, initial: 0 });
  builder.state({ name: 'elapsed', type: types.number, initial: 0 });
  builder.state({ name: 'wake', type: types.number, initial: 0 });
  builder.state({ name: 'consumed', type: types.number, initial: 0 });
  builder.pureFn({ name: 'poll', params: [], returns: types.bool }, (body) =>
    body.returnValue(
      body.notEqual(
        types.number,
        body.readState('wake', types.number),
        body.constant(types.number, 0),
      ),
    ),
  );
  builder.pureFn({ name: 'waitPs', params: [], returns: types.number }, (body) =>
    body.returnValue(body.constant(types.number, WAIT_PS)),
  );
  builder.fn(
    { name: 'advance', params: [{ name: 'duration', type: types.number }] },
    (body, args) => {
      body.writeState('elapsed', body.add(body.readState('elapsed', types.number), args.duration));
      body.writeState('wake', body.constant(types.number, 1));
    },
  );
  builder.fn({ name: 'consume', params: [] }, (body) => {
    body.writeState('consumed', body.constant(types.number, 1));
  });

  return builder.finish();
}

const translate: JitTranslate = ({ pc }, block) => {
  block.instruction({ pc, nextPc: pc }, (body) => {
    body.writeState(
      'runs',
      body.add(body.readState('runs', types.number), body.constant(types.number, 1)),
    );
    body.stop();
  });
  return block.finish();
};

interface InstanceView {
  readonly states: ReadonlyMap<string, unknown>;
}

const instanceOf = (runtime: ReturnType<typeof createBoard>): InstanceView =>
  (runtime as unknown as { instances: readonly InstanceView[] }).instances[0]!;

function board(execution: 'throughput' | 'precise') {
  const library = createDeviceLibrary([
    {
      id: 'poll',
      model: pollingModel(),
      create: (context) => {
        const registration = context.attachJit({
          entry: 'poll',
          code: 'code',
          pc: 'pc',
          translate,
          polling: [
            {
              pc: 0,
              predicate: 'poll',
              consume: 'consume',
              wait: { delay: 'waitPs', advance: 'advance' },
            },
          ],
        });
        context.loadBytes('code', new Uint8Array(16));
        return { sync() {}, dispose: () => registration.dispose() };
      },
    },
  ]);

  return createBoard(
    library,
    { instances: [{ id: 'poll', type: 'poll' }], nets: [] },
    { execution },
  );
}

describe('polling time events', () => {
  it('throughput parks until the device event and then advances the model exactly once', () => {
    const runtime = board('throughput');

    try {
      runtime.runUntil(5);
      const instance = instanceOf(runtime);
      expect(instance.states.get('runs')).toBe(0);
      expect(runtime.time).toBe(5);

      runtime.runUntil(20);
      expect(runtime.time).toBe(20);
      expect(instance.states.get('runs')).toBe(1);
      expect(instance.states.get('elapsed')).toBe(WAIT_PS);
      expect(instance.states.get('consumed')).toBe(1);
    } finally {
      runtime.dispose();
    }
  });

  it('precise ignores polling and executes the instruction immediately', () => {
    const runtime = board('precise');

    try {
      runtime.runUntil(5);
      const instance = instanceOf(runtime);
      expect(instance.states.get('runs')).toBe(1);
      expect(instance.states.get('elapsed')).toBe(0);
      expect(runtime.time).toBe(5);
    } finally {
      runtime.dispose();
    }
  });
});
