import {
  createDeviceBuilder,
  types,
  type DeviceIR,
  type JitBlockBuilder,
} from '@mica-js/device-model';
import { describe, expect, it } from 'vitest';
import { createBoard, createDeviceLibrary } from '../runtime';
import type { Instance } from '../runtime/instance';
import type { Process } from '../runtime/state';
import type { BoardOptions, JitTranslateInput, ProcessBatchRegistration } from '../types';

const STEP = 10;
const LENGTH = 256;

type Effect = 'advance' | 'fill' | 'copy';

interface Collected {
  readonly name: string;
  readonly time: number;
  readonly value: unknown;
}

interface HarnessOptions {
  readonly effect?: Effect;
  readonly batch?: boolean;
  readonly execution?: BoardOptions['execution'];
  readonly limit?: number;
  readonly memoryLength?: number;
  readonly stopBefore?: string;
  readonly stopAt?: number;
  readonly register?: boolean;
  readonly externalAt?: number;
  readonly externalEvery?: number;
  readonly observer?: boolean;
  readonly derivedCursor?: boolean;
  readonly receiveFirst?: boolean;
  readonly reaction?: boolean;
  readonly cpuQuantum?: number;
}

interface Harness {
  readonly board: ReturnType<typeof createBoard>;
  readonly instance: Instance;
  readonly outputs: Collected[];
  readonly dispose: () => void;
}

let serial = 0;

function model(limit: number, options: HarnessOptions): DeviceIR {
  const builder = createDeviceBuilder({ name: `ProcessBatch${serial++}` });
  builder.property({ name: 'batched', type: types.bool, default: true });
  builder.memory({ name: 'src', length: options.memoryLength ?? LENGTH });
  builder.memory({ name: 'dst', length: options.memoryLength ?? LENGTH });
  builder.state({ name: 'cursor', type: types.number, initial: 0 });
  builder.state({ name: 'stopAt', type: types.number, initial: 0 });
  builder.state({ name: 'flag', type: types.bool, initial: false });
  if (options.reaction) {
    builder.state({ name: 'trigger', type: types.number, initial: 0 });
    builder.state({ name: 'fires', type: types.number, initial: 0 });
  }
  builder.channel({ name: 'done', direction: 'output', type: types.number, capacity: 4 });
  if (options.receiveFirst)
    builder.channel({ name: 'control', direction: 'input', type: types.number, capacity: 1 });
  if (options.observer)
    builder.channel({ name: 'seen', direction: 'output', type: types.number, capacity: 1024 });
  if (options.derivedCursor)
    builder.derived({ name: 'doubleCursor', type: types.number }, (body) =>
      body.returnValue(
        body.add(body.readState('cursor', types.number), body.readState('cursor', types.number)),
      ),
    );
  if (options.reaction)
    builder.reaction(
      {
        name: 'watchTrigger',
        sourcePath: ['trigger'],
        sourceType: types.number,
        previous: 'previousTrigger',
        current: 'currentTrigger',
        captures: [],
      },
      {},
      (body) => {
        body.writeState(
          'fires',
          body.add(body.readState('fires', types.number), body.constant(types.number, 1)),
        );
      },
    );

  const effect = options.effect ?? 'fill';
  builder.start((body) => {
    if (options.receiveFirst) body.writeState('cursor', body.receive('control', types.number));
    body.while(
      (test) =>
        test.lessThan(test.readState('cursor', types.number), test.constant(types.number, limit)),
      (step) => {
        const cursor = step.readState('cursor', types.number);
        if (effect === 'fill') step.store8('dst', cursor, step.constant(types.number, 42));
        else if (effect === 'copy') step.store8('dst', cursor, step.load8('src', cursor));
        step.writeState('cursor', step.add(cursor, step.constant(types.number, 1)));
        step.wait(step.constant(types.number, STEP));
      },
    );
    body.send('done', body.readState('cursor', types.number));
  });
  if (options.observer)
    builder.on({ name: 'watchCursor', sourcePath: ['cursor'] }, (body) => {
      body.send('seen', body.readState('cursor', types.number));
    });
  return builder.finish();
}

function createHarness(options: HarnessOptions = {}): Harness {
  const id = `ProcessBatch${serial++}`;
  const outputs: Collected[] = [];
  const registration: ProcessBatchRegistration = {
    process: { kind: 'start', index: 0 },
    loop: 0,
    ...(options.stopBefore === undefined ? {} : { stopBefore: options.stopBefore }),
  };
  const library = createDeviceLibrary([
    {
      id,
      model: model(options.limit ?? LENGTH, options),
      create: (context) => {
        if (options.register !== false && context.props.batched === true)
          context.registerProcessBatch(registration);
        return {
          sync(batch) {
            for (const [name, messages] of Object.entries(batch.outputs))
              for (const entry of messages as readonly { time: number; value: unknown }[])
                outputs.push({ name, time: entry.time, value: entry.value });
          },
          dispose() {},
        };
      },
    },
  ]);
  const board = createBoard(
    library,
    { instances: [{ id: 'dev', type: id }], nets: [] },
    {
      ...(options.batch === true ? { batchExecution: true } : {}),
      ...(options.execution === undefined ? {} : { execution: options.execution }),
      ...(options.cpuQuantum === undefined ? {} : { cpuQuantum: options.cpuQuantum }),
    },
  );
  const instance = (board as unknown as { instances: readonly Instance[] }).instances[0]!;
  return {
    board,
    instance,
    outputs,
    dispose: () => board.dispose(),
  };
}

interface Counters {
  pushes: number;
  pops: number;
}

function countEvents(board: ReturnType<typeof createBoard>): () => Counters {
  const queue = (
    board as unknown as {
      events: {
        push(time: number, value: () => void): void;
        pop(): () => void;
      };
    }
  ).events;
  const counters: Counters = { pushes: 0, pops: 0 };
  const push = queue.push.bind(queue);
  const pop = queue.pop.bind(queue);
  queue.push = (time, value) => {
    counters.pushes++;
    push(time, value);
  };
  queue.pop = () => {
    counters.pops++;
    return pop();
  };
  return () => ({ ...counters });
}

function processBatches(instance: Instance): readonly Process[] {
  return instance.processes.filter(
    (process) => (process as Process & { readonly batch?: unknown }).batch !== undefined,
  );
}

function sourceBytes(length = LENGTH): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) bytes[index] = (index * 17 + 3) & 0xff;
  return bytes;
}

function exercise(
  options: HarnessOptions,
  slices?: readonly number[],
  target = LENGTH * STEP,
): {
  harness: Harness;
  counters: Counters;
  outputs: readonly Collected[];
  external: readonly string[];
} {
  const harness = createHarness(options);
  if ((options.effect ?? 'fill') === 'copy')
    harness.instance.memories.get('src')!.set(sourceBytes());
  if (options.stopBefore !== undefined && options.stopAt !== undefined)
    harness.instance.host.write(options.stopBefore, options.stopAt);
  const external: string[] = [];
  if (options.externalAt !== undefined) {
    const queue = (
      harness.board as unknown as {
        events: { push(time: number, value: () => void): void };
      }
    ).events;
    queue.push(options.externalAt, () => external.push('first'));
    queue.push(options.externalAt, () => external.push('second'));
  }
  if (options.externalEvery !== undefined) {
    const queue = (
      harness.board as unknown as {
        events: { push(time: number, value: () => void): void };
      }
    ).events;
    for (let time = options.externalEvery; time <= target; time += options.externalEvery)
      queue.push(time, () => external.push(`t${time}`));
  }
  const read = countEvents(harness.board);
  if (slices === undefined) harness.board.runUntil(target);
  else {
    let previous = 0;
    for (const slice of slices) {
      previous = Math.min(target, previous + slice);
      harness.board.runUntil(previous);
      if (previous === target) break;
    }
    if (previous < target) harness.board.runUntil(target);
  }
  return { harness, counters: read(), outputs: harness.outputs, external };
}

describe('process batch execution', () => {
  it('folds fill rounds while preserving the done message and wake reduction', () => {
    const off = exercise({ effect: 'fill', batch: false });
    const on = exercise({ effect: 'fill', batch: true });
    for (const run of [off, on]) {
      expect(run.harness.board.time).toBe(LENGTH * STEP);
      expect(run.outputs).toEqual([{ name: 'done', time: LENGTH * STEP, value: LENGTH }]);
      expect(run.harness.instance.states.get('cursor')).toBe(LENGTH);
      expect(run.harness.instance.memories.get('dst')).toEqual(new Uint8Array(LENGTH).fill(42));
    }
    expect(on.outputs).toEqual(off.outputs);
    // The batch board must really skip timed wakes, not merely produce the same state.
    expect(on.counters.pushes).toBeLessThan(off.counters.pushes / 4);
    expect(on.counters.pops).toBeLessThan(off.counters.pops / 4);
    expect(processBatches(on.harness.instance)).toHaveLength(1);
    off.harness.dispose();
    on.harness.dispose();
  });

  it('folds copy and advance rounds with exact bytes and counters', () => {
    for (const effect of ['copy', 'advance'] as const) {
      const off = exercise({ effect, batch: false });
      const on = exercise({ effect, batch: true });
      expect(on.outputs).toEqual(off.outputs);
      expect(on.harness.instance.states.get('cursor')).toBe(
        off.harness.instance.states.get('cursor'),
      );
      expect(on.harness.instance.memories.get('dst')).toEqual(
        off.harness.instance.memories.get('dst'),
      );
      if (effect === 'copy') expect(on.harness.instance.memories.get('dst')).toEqual(sourceBytes());
      else expect(on.harness.instance.memories.get('dst')).toEqual(new Uint8Array(LENGTH));
      expect(on.counters.pushes).toBeLessThan(off.counters.pushes / 4);
      off.harness.dispose();
      on.harness.dispose();
    }
  });

  it('matches fixed and seeded random runUntil slices at logical times', () => {
    const off = exercise({ effect: 'fill', batch: false });
    const fixed = exercise({ effect: 'fill', batch: true }, new Array(64).fill(7));
    let seed = 0x12345678;
    const random: number[] = [];
    for (let index = 0; index < 200; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      random.push(1 + (seed % 29));
    }
    const sliced = exercise({ effect: 'fill', batch: true }, random);
    for (const run of [fixed, sliced]) {
      expect(run.outputs).toEqual(off.outputs);
      expect(run.harness.board.time).toBe(LENGTH * STEP);
      expect(run.harness.instance.states.get('cursor')).toBe(LENGTH);
      expect(run.harness.instance.memories.get('dst')).toEqual(new Uint8Array(LENGTH).fill(42));
    }
    off.harness.dispose();
    fixed.harness.dispose();
    sliced.harness.dispose();
  });

  it('limits the folded window at other same-board work', () => {
    const off = exercise({ effect: 'fill', batch: false, externalAt: 35 });
    const on = exercise({ effect: 'fill', batch: true, externalAt: 35 });
    expect(on.outputs).toEqual(off.outputs);
    expect(on.external).toEqual(['first', 'second']);
    expect(off.external).toEqual(['first', 'second']);
    expect(on.harness.instance.states.get('cursor')).toBe(LENGTH);
    expect(on.counters.pushes).toBeLessThan(off.counters.pushes / 2);
    off.harness.dispose();
    on.harness.dispose();
  });

  it('falls back while a state observer is subscribed and matches the ordinary trace', () => {
    const off = exercise(
      { effect: 'fill', batch: false, observer: true, limit: 32 },
      undefined,
      320,
    );
    const on = exercise({ effect: 'fill', batch: true, observer: true, limit: 32 }, undefined, 320);
    expect(on.outputs).toEqual(off.outputs);
    expect(on.harness.instance.states.get('cursor')).toBe(32);
    // The binding exists, but the live subscriber check declines every attempt.
    expect(on.counters).toEqual(off.counters);
    off.harness.dispose();
    on.harness.dispose();
  });

  it('honours stopBefore around the boundary without changing the ordinary deadline', () => {
    for (const stopAt of [39, 40, 41]) {
      const options = {
        effect: 'advance' as const,
        stopBefore: 'stopAt',
        stopAt,
        limit: 64,
      };
      const off = exercise({ ...options, batch: false }, undefined, 640);
      const on = exercise({ ...options, batch: true }, undefined, 640);
      expect(on.outputs).toEqual(off.outputs);
      expect(on.harness.board.time).toBe(640);
      expect(on.harness.instance.states.get('cursor')).toBe(64);
      off.harness.dispose();
      on.harness.dispose();
    }
  });

  it('keeps precise execution on the ordinary path even when batch is requested', () => {
    const off = exercise({ effect: 'fill', batch: false, execution: 'precise' });
    const on = exercise({ effect: 'fill', batch: true, execution: 'precise' });
    expect((on.harness.board as unknown as { batchExecution: boolean }).batchExecution).toBe(false);
    expect(processBatches(on.harness.instance)).toHaveLength(0);
    expect(on.outputs).toEqual(off.outputs);
    expect(on.counters).toEqual(off.counters);
    off.harness.dispose();
    on.harness.dispose();
  });

  it('rejects an illegal stopBefore value at runtime without mutating the attempt', () => {
    const off = exercise({ effect: 'fill', batch: false, stopBefore: 'stopAt' });
    const onHarness = createHarness({ effect: 'fill', batch: true, stopBefore: 'stopAt' });
    onHarness.instance.host.write('stopAt', -1);
    const read = countEvents(onHarness.board);
    onHarness.board.runUntil(LENGTH * STEP);
    const counters = read();
    expect(onHarness.outputs).toEqual(off.outputs);
    expect(onHarness.instance.states.get('cursor')).toBe(LENGTH);
    expect(counters).toEqual(off.counters);
    off.harness.dispose();
    onHarness.dispose();
  });

  it('invalidates a stale derived cache across a folded batch', () => {
    const harness = createHarness({
      effect: 'advance',
      batch: true,
      limit: 16,
      derivedCursor: true,
    });
    try {
      expect(harness.instance.read('derived', 'doubleCursor')).toBe(0);
      harness.board.runUntil(160);
      expect(harness.instance.read('derived', 'doubleCursor')).toBe(32);
      expect(harness.instance.states.get('cursor')).toBe(16);
    } finally {
      harness.dispose();
    }
  });

  it('does not fold a receive resume and batches the following ticks window', () => {
    function receiving(batch: boolean): {
      outputs: readonly Collected[];
      cursor: unknown;
      pushes: number;
    } {
      const harness = createHarness({
        effect: 'advance',
        batch,
        limit: 16,
        receiveFirst: true,
      });
      harness.board.runUntil(0);
      const inputs = harness.instance.inputs() as {
        control: { send(value: unknown): void };
      };
      inputs.control.send(10);
      const read = countEvents(harness.board);
      harness.board.runUntil(200);
      const result = {
        outputs: harness.outputs,
        cursor: harness.instance.states.get('cursor'),
        pushes: read().pushes,
      };
      harness.dispose();
      return result;
    }
    const off = receiving(false);
    const on = receiving(true);
    expect(on.outputs).toEqual(off.outputs);
    expect(on.outputs).toEqual([{ name: 'done', time: 60, value: 16 }]);
    expect(on.cursor).toBe(16);
    expect(on.pushes).toBeLessThan(off.pushes);
  });

  it('resumes folding after an unrelated reaction settles', () => {
    function reacted(batch: boolean): {
      outputs: readonly Collected[];
      cursor: unknown;
      fires: unknown;
      pushes: number;
      pops: number;
    } {
      const harness = createHarness({
        effect: 'advance',
        batch,
        limit: 32,
        reaction: true,
      });
      harness.board.runUntil(50);
      harness.instance.host.write('trigger', 1);
      const read = countEvents(harness.board);
      harness.board.runUntil(320);
      const counters = read();
      const result = {
        outputs: harness.outputs,
        cursor: harness.instance.states.get('cursor'),
        fires: harness.instance.states.get('fires'),
        pushes: counters.pushes,
        pops: counters.pops,
      };
      harness.dispose();
      return result;
    }
    const off = reacted(false);
    const on = reacted(true);
    expect(on.outputs).toEqual(off.outputs);
    expect(on.outputs).toEqual([{ name: 'done', time: 320, value: 32 }]);
    expect(on.cursor).toBe(32);
    expect(on.fires).toBe(1);
    expect(off.fires).toBe(1);
    // A stale settled scratch entry must not disable the quiet window after time 60.
    expect(on.pushes).toBeLessThan(off.pushes / 2);
    expect(on.pops).toBeLessThan(off.pops / 2);
  });

  it('rechecks dynamic code ownership after registration', () => {
    function codeOwned(batch: boolean): {
      outputs: readonly Collected[];
      bytes: Uint8Array | undefined;
      pushes: number;
      pops: number;
    } {
      const id = `ProcessBatchCode${serial++}`;
      const builder = createDeviceBuilder({ name: id });
      const outputs: Collected[] = [];
      builder.memory({ name: 'dst', length: 16 });
      builder.state({ name: 'cursor', type: types.number, initial: 0 });
      builder.state({ name: 'pc', type: types.number, initial: 0 });
      builder.channel({ name: 'done', direction: 'output', type: types.number, capacity: 4 });
      builder.start((body) => {
        body.while(
          (test) =>
            test.lessThan(test.readState('cursor', types.number), test.constant(types.number, 4)),
          (step) => {
            const cursor = step.readState('cursor', types.number);
            step.store8('dst', cursor, step.constant(types.number, 42));
            step.writeState('cursor', step.add(cursor, step.constant(types.number, 1)));
            step.wait(step.constant(types.number, STEP));
          },
        );
        body.send('done', body.readState('cursor', types.number));
      });
      const library = createDeviceLibrary([
        {
          id,
          model: builder.finish(),
          create: (context) => {
            // Register first, then make the destination a code memory in the same factory.
            context.registerProcessBatch({ process: { kind: 'start', index: 0 }, loop: 0 });
            const jit = context.attachJit({
              entry: 'cpu',
              code: 'dst',
              pc: 'pc',
              translate: (input: JitTranslateInput, block: JitBlockBuilder) => {
                block.instruction({ pc: input.pc, nextPc: input.pc }, (body) => body.stop());
                return block.finish();
              },
            });
            return {
              sync(value) {
                for (const [name, messages] of Object.entries(value.outputs))
                  for (const entry of messages as readonly { time: number; value: unknown }[])
                    outputs.push({ name, time: entry.time, value: entry.value });
              },
              dispose: () => jit.dispose(),
            };
          },
        },
      ]);
      const board = createBoard(
        library,
        { instances: [{ id: 'dev', type: id }], nets: [] },
        batch ? { batchExecution: true } : {},
      );
      const instance = (board as unknown as { instances: readonly Instance[] }).instances[0]!;
      const read = countEvents(board);
      board.runUntil(100);
      const counters = read();
      const result = {
        outputs,
        bytes: instance.memories.get('dst'),
        pushes: counters.pushes,
        pops: counters.pops,
      };
      board.dispose();
      return result;
    }
    const off = codeOwned(false);
    const on = codeOwned(true);
    expect(on.outputs).toEqual(off.outputs);
    expect(on.outputs).toEqual([{ name: 'done', time: 40, value: 4 }]);
    expect(on.bytes).toEqual(off.bytes);
    expect(on.bytes!.slice(0, 4)).toEqual(new Uint8Array([42, 42, 42, 42]));
    // The destination became code after registration, so every admission must decline.
    expect(on.pushes).toBe(off.pushes);
    expect(on.pops).toBe(off.pops);
  });

  it('keeps the committed prefix and fault time when a later round fails', () => {
    function failing(batch: boolean): {
      error: { code?: string; diagnostic?: { time?: number } };
      cursor: unknown;
      bytes: Uint8Array | undefined;
      pushes: number;
      pops: number;
    } {
      const harness = createHarness({
        effect: 'fill',
        batch,
        limit: 400,
        memoryLength: 300,
      });
      const queue = (
        harness.board as unknown as {
          events: { push(time: number, value: () => void): void };
        }
      ).events;
      for (let time = 100; time <= 4000; time += 100) queue.push(time, () => {});
      const read = countEvents(harness.board);
      let error: { code?: string; diagnostic?: { time?: number } } = {};
      try {
        harness.board.runUntil(4000);
      } catch (cause) {
        error = cause as typeof error;
      }
      const counters = read();
      const result = {
        error,
        cursor: harness.instance.states.get('cursor'),
        bytes: harness.instance.memories.get('dst'),
        pushes: counters.pushes,
        pops: counters.pops,
      };
      harness.dispose();
      return result;
    }
    const off = failing(false);
    const on = failing(true);
    expect(on.error.code).toBe(off.error.code);
    expect(on.error.diagnostic?.time).toBe(off.error.diagnostic?.time);
    expect(on.cursor).toBe(off.cursor);
    expect(on.cursor).toBe(300);
    expect(on.bytes).toEqual(off.bytes);
    expect(on.bytes).toEqual(new Uint8Array(300).fill(42));
    // The valid prefix was folded before the ordinary failing round.
    expect(on.pushes).toBeLessThan(off.pushes / 2);
    expect(on.pops).toBeLessThan(off.pops / 2);
  });
});

describe('process batch registration', () => {
  function registrationFailure(
    registration: unknown,
    options: { readonly batch?: boolean; readonly duplicate?: boolean } = {},
  ): unknown {
    const id = `ProcessBatchRegistration${serial++}`;
    let failure: unknown;
    const library = createDeviceLibrary([
      {
        id,
        model: model(4, {}),
        create: (context) => {
          try {
            context.registerProcessBatch(registration as ProcessBatchRegistration);
            if (options.duplicate === true)
              context.registerProcessBatch(registration as ProcessBatchRegistration);
          } catch (cause) {
            failure = cause;
          }
          return { sync() {}, dispose() {} };
        },
      },
    ]);
    const board = createBoard(
      library,
      { instances: [{ id: 'dev', type: id }], nets: [] },
      options.batch === true ? { batchExecution: true } : {},
    );
    const instance = (board as unknown as { instances: readonly Instance[] }).instances[0]!;
    try {
      expect(failure).toBeDefined();
      // A rejected registration never leaves a partial binding behind.
      expect(processBatches(instance)).toHaveLength(options.duplicate === true ? 1 : 0);
    } finally {
      board.dispose();
    }
    return failure;
  }

  function hasDiagnostic(value: unknown, code: string): boolean {
    let error = value as { code?: string; diagnostic?: { cause?: unknown } } | undefined;
    while (error !== undefined) {
      if (error.code === code) return true;
      const cause = error.diagnostic?.cause;
      error = cause as typeof error;
    }
    return false;
  }

  it.each([
    [{ process: { kind: 'start', index: 0 }, loop: 0, extra: 1 }, 'unknown field'],
    [{ process: { kind: 'start', index: 0 }, loop: 0, stopBefore: undefined }, 'undefined'],
    [{ process: { kind: 'start', index: 9 }, loop: 0 }, 'start index'],
    [{ process: { kind: 'on', name: 'missing' }, loop: 0 }, 'unknown on'],
    [{ process: { kind: 'on', name: '' }, loop: 0 }, 'empty name'],
    [{ process: { kind: 'start', index: 0 }, loop: 1 }, 'loop ordinal'],
    [{ process: { kind: 'start', index: 0 }, loop: -1 }, 'negative loop'],
    [{ process: { kind: 'start', index: 0 }, loop: 0, stopBefore: 'missing' }, 'unknown state'],
    [{ process: { kind: 'start', index: 0 }, loop: 0, stopBefore: 'flag' }, 'non-number state'],
    [{ process: { kind: 'start', index: 0 }, loop: 0, stopBefore: '' }, 'empty stop'],
    [{ process: { kind: 'start' }, loop: 0 }, 'missing index'],
    [{ process: { kind: 'start', index: 0, name: 'x' }, loop: 0 }, 'foreign field'],
    [{ process: undefined, loop: 0 }, 'undefined process'],
  ])('rejects %o (%s) with INVALID_BINDING', (registration, _label) => {
    const failure = registrationFailure(registration);
    expect(hasDiagnostic(failure, 'INVALID_BINDING')).toBe(true);
  });

  it('validates the same shape on a disabled board', () => {
    const failure = registrationFailure({
      process: { kind: 'start', index: 0 },
      loop: 5,
    });
    expect(hasDiagnostic(failure, 'INVALID_BINDING')).toBe(true);
  });

  it('rejects a duplicate active process/loop pair', () => {
    const failure = registrationFailure(
      { process: { kind: 'start', index: 0 }, loop: 0 },
      { batch: true, duplicate: true },
    );
    expect(hasDiagnostic(failure, 'INVALID_BINDING')).toBe(true);
  });

  it('frees a disposed registration and is idempotent', () => {
    const id = `ProcessBatchLifecycle${serial++}`;
    let first: { dispose(): void } | undefined;
    let second: { dispose(): void } | undefined;
    let failure: unknown;
    const library = createDeviceLibrary([
      {
        id,
        model: model(4, {}),
        create: (context) => {
          first = context.registerProcessBatch({ process: { kind: 'start', index: 0 }, loop: 0 });
          first!.dispose();
          first!.dispose();
          try {
            second = context.registerProcessBatch({
              process: { kind: 'start', index: 0 },
              loop: 0,
            });
          } catch (cause) {
            failure = cause;
          }
          return { sync() {}, dispose() {} };
        },
      },
    ]);
    const board = createBoard(
      library,
      { instances: [{ id: 'dev', type: id }], nets: [] },
      { batchExecution: true },
    );
    const instance = (board as unknown as { instances: readonly Instance[] }).instances[0]!;
    try {
      expect(failure).toBeUndefined();
      expect(processBatches(instance)).toHaveLength(1);
      second!.dispose();
      second!.dispose();
      expect(processBatches(instance)).toHaveLength(0);
    } finally {
      board.dispose();
    }
  });

  it('snapshots registration per instance', () => {
    const id = `ProcessBatchInstances${serial++}`;
    const library = createDeviceLibrary([
      {
        id,
        model: model(4, {}),
        create: (context) => {
          if (context.props.batched === true)
            context.registerProcessBatch({ process: { kind: 'start', index: 0 }, loop: 0 });
          return { sync() {}, dispose() {} };
        },
      },
    ]);
    const board = createBoard(
      library,
      {
        instances: [
          { id: 'on', type: id, props: { batched: true } },
          { id: 'off', type: id, props: { batched: false } },
        ],
        nets: [],
      },
      { batchExecution: true },
    );
    const instances = (board as unknown as { instances: readonly Instance[] }).instances;
    try {
      expect(processBatches(instances[0]!)).toHaveLength(1);
      expect(processBatches(instances[1]!)).toHaveLength(0);
    } finally {
      board.dispose();
    }
  });
});
