import { createDeviceBuilder, types, type JitBlockBuilder } from '@mica-js/device-model';
import { describe, expect, it } from 'vitest';
import { createBoard, createDeviceLibrary } from '../runtime';
import type { Instance } from '../runtime/instance';
import type {
  JitCodeMetadata,
  JitCodeMetadataInput,
  JitTranslate,
  JitTranslateInput,
} from '../types';

function wfiModel(nextByte: number) {
  const builder = createDeviceBuilder({ name: `MetadataWfi${nextByte}` });
  builder.memory({ name: 'code', length: 4 });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  builder.state({ name: 'awake', type: types.bool, initial: false });
  builder.state({ name: 'wakeCount', type: types.number, initial: 0 });
  builder.channel({ name: 'out', direction: 'output', type: types.number, capacity: 8 });
  builder.pureFn({ name: 'awakeNow', params: [], returns: types.bool }, (body) => {
    body.returnValue(body.readState('awake', types.bool));
  });
  builder.pureFn({ name: 'waitPs', params: [], returns: types.number }, (body) => {
    body.returnValue(body.constant(types.number, 3));
  });
  builder.fn({ name: 'advance', params: [{ name: 'elapsed', type: types.number }] }, (body) => {
    body.writeState('awake', body.constant(types.bool, true));
    body.writeState('wakeCount', body.add(body.readState('wakeCount', types.number), 1));
  });
  builder.start((body) => {
    body.wait(body.constant(types.number, 1));
    body.store8('code', 0, nextByte);
  });
  return builder.finish();
}

function runWfi(nextByte: number) {
  const calls: { memory: string; base: number; changes: number }[] = [];
  const translations: number[] = [];
  const output: number[] = [];
  const outputTimes: number[] = [];
  const provider = (input: JitCodeMetadataInput): JitCodeMetadata => {
    calls.push({
      memory: input.region.memory,
      base: input.region.base,
      changes: input.changes.length,
    });
    const polling =
      input.region.memory === 'code' && input.region.code[0] === 1
        ? [
            {
              pc: 0,
              predicate: 'awakeNow',
              wait: { delay: 'waitPs', advance: 'advance' },
            },
          ]
        : [];
    return { polling, delays: new Map() };
  };
  const translate: JitTranslate = (input, block) => {
    const byte = input.code[0] ?? 0;
    translations.push(byte);
    block.instruction({ pc: 0, nextPc: 1 }, (body) => {
      body.send('out', body.constant(types.number, byte));
      body.stop();
    });
    return block.finish();
  };
  const library = createDeviceLibrary([
    {
      id: 'probe',
      model: wfiModel(nextByte),
      create: (context) => {
        const registration = context.attachJit({
          entry: 'cpu',
          code: 'code',
          codeMetadata: provider,
          pc: 'pc',
          translate,
        });
        try {
          context.loadBytes('code', new Uint8Array([1, 1, 1, 1]));
        } catch (cause) {
          registration.dispose();
          throw cause;
        }
        return {
          sync(batch) {
            for (const message of batch.outputs.out ?? []) {
              output.push(message.value as number);
              outputTimes.push(message.time);
            }
          },
          dispose: () => registration.dispose(),
        };
      },
    },
  ]);
  const board = createBoard(library, { instances: [{ id: 'probe', type: 'probe' }], nets: [] });
  try {
    board.runUntil(10);
  } finally {
    board.dispose();
  }
  return { calls, translations, output, outputTimes };
}

describe('code metadata provider', () => {
  it('rechecks a same-byte WFI rewrite and advances to wake it', () => {
    const result = runWfi(1);
    expect(result.output).toEqual([1]);
    expect(result.outputTimes[0]).toBeGreaterThanOrEqual(4);
    expect(result.translations).toEqual([1]);
    expect(result.calls.length).toBeGreaterThan(1);
    expect(result.calls[0]!.changes).toBe(1);
  });

  it('removes old parking when WFI is replaced by a normal opcode', () => {
    const result = runWfi(2);
    expect(result.output).toEqual([2]);
    expect(result.outputTimes).toEqual([1]);
    expect(result.translations).toEqual([2]);
    expect(result.calls.length).toBeGreaterThan(1);
  });
});

function sramWfiModel() {
  const builder = createDeviceBuilder({ name: 'MetadataSramWfi' });
  builder.memory({ name: 'code', length: 4 });
  builder.memory({ name: 'sram', length: 4 });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  builder.state({ name: 'awake', type: types.bool, initial: false });
  builder.channel({ name: 'out', direction: 'output', type: types.number, capacity: 8 });
  builder.pureFn({ name: 'awakeNow', params: [], returns: types.bool }, (body) => {
    body.returnValue(body.readState('awake', types.bool));
  });
  builder.pureFn({ name: 'waitPs', params: [], returns: types.number }, (body) => {
    body.returnValue(body.constant(types.number, 3));
  });
  builder.fn({ name: 'advance', params: [{ name: 'elapsed', type: types.number }] }, (body) =>
    body.writeState('awake', body.constant(types.bool, true)),
  );
  builder.start((body) => {
    body.wait(body.constant(types.number, 1));
    body.store8('sram', 0, 1);
    body.writeState('pc', body.constant(types.number, 0x20000000));
  });
  return builder.finish();
}

it('discovers a new WFI in SRAM when execution actually enters that region', () => {
  const calls: { memory: string; base: number }[] = [];
  const output: number[] = [];
  const provider = (input: JitCodeMetadataInput): JitCodeMetadata => {
    calls.push({ memory: input.region.memory, base: input.region.base });
    return {
      polling:
        input.region.memory === 'sram' && input.region.code[0] === 1
          ? [
              {
                pc: 0x20000000,
                predicate: 'awakeNow',
                wait: { delay: 'waitPs', advance: 'advance' },
              },
            ]
          : [],
      delays: new Map(),
    };
  };
  const library = createDeviceLibrary([
    {
      id: 'probe',
      model: sramWfiModel(),
      create: (context) => {
        const registration = context.attachJit({
          entry: 'cpu',
          code: 'code',
          codeRegions: [{ memory: 'sram', base: 0x20000000, size: 4 }],
          codeMetadata: provider,
          pc: 'pc',
          translate(input: JitTranslateInput, block: JitBlockBuilder) {
            if (input.pc === 0) {
              block.instruction({ pc: 0, nextPc: 0 }, (body) => body.elapse(1));
            } else {
              block.instruction({ pc: input.pc, nextPc: input.pc }, (body) => {
                body.send('out', body.constant(types.number, 1));
                body.stop();
              });
            }
            return block.finish();
          },
        });
        try {
          context.loadBytes('code', new Uint8Array([2]));
          context.loadBytes('sram', new Uint8Array([0]));
        } catch (cause) {
          registration.dispose();
          throw cause;
        }
        return {
          sync(batch) {
            for (const message of batch.outputs.out ?? []) output.push(message.value as number);
          },
          dispose: () => registration.dispose(),
        };
      },
    },
  ]);
  const board = createBoard(library, { instances: [{ id: 'probe', type: 'probe' }], nets: [] });
  try {
    board.runUntil(10);
  } finally {
    board.dispose();
  }
  expect(output).toEqual([1]);
  expect(calls.some((call) => call.memory === 'sram' && call.base === 0x20000000)).toBe(true);
});

it('refreshes metadata for the final region after a beforeInstruction redirect', () => {
  const alias = 0x20000000;
  const builder = createDeviceBuilder({ name: 'MetadataHookRedirect' });
  builder.memory({ name: 'code', length: 4 });
  builder.memory({ name: 'sram', length: 4 });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  builder.state({ name: 'gate', type: types.bool, initial: true });
  builder.state({ name: 'hooked', type: types.bool, initial: false });
  builder.channel({ name: 'out', direction: 'output', type: types.number, capacity: 8 });
  builder.fn({ name: 'redirectFromHook', params: [] }, (body) => {
    body.writeState('hooked', body.constant(types.bool, true));
    body.writeState('pc', body.constant(types.number, alias));
  });
  const calls: { memory: string; base: number; version: number; hooked: unknown }[] = [];
  const translations: { pc: number; base: number; version: number; byte: number }[] = [];
  const output: number[] = [];
  let hooked: (() => unknown) | undefined;
  const provider = (input: JitCodeMetadataInput): JitCodeMetadata => {
    calls.push({
      memory: input.region.memory,
      base: input.region.base,
      version: input.region.codeVersion,
      hooked: input.region.memory === 'sram' ? hooked?.() : undefined,
    });
    return { polling: [], delays: new Map() };
  };
  const translate: JitTranslate = (input: JitTranslateInput, block: JitBlockBuilder) => {
    const byte = input.code[input.pc - input.codeBase] ?? 0;
    translations.push({
      pc: input.pc,
      base: input.codeBase,
      version: input.codeVersion,
      byte,
    });
    block.instruction({ pc: input.pc, nextPc: input.pc }, (body) => {
      body.send('out', body.constant(types.number, byte));
      body.stop();
    });
    return block.finish();
  };
  const library = createDeviceLibrary([
    {
      id: 'metadata-hook-redirect',
      model: builder.finish(),
      create: (context) => {
        const registration = context.attachJit({
          entry: 'cpu',
          code: 'code',
          codeRegions: [{ memory: 'sram', base: alias, size: 4 }],
          codeMetadata: provider,
          pc: 'pc',
          beforeInstruction: { when: 'gate', call: 'redirectFromHook' },
          translate,
        });
        try {
          context.loadBytes('code', new Uint8Array([9]));
          context.loadBytes('sram', new Uint8Array([2]));
        } catch (cause) {
          registration.dispose();
          throw cause;
        }
        return {
          sync(batch) {
            for (const message of batch.outputs.out ?? []) output.push(message.value as number);
          },
          dispose: () => registration.dispose(),
        };
      },
    },
  ]);
  const board = createBoard(library, {
    instances: [{ id: 'metadata-hook-redirect', type: 'metadata-hook-redirect' }],
    nets: [],
  });
  try {
    const instance = (board as unknown as { instances: Instance[] }).instances[0]!;
    hooked = () => instance.states.get('hooked');
    board.runUntil(1);
  } finally {
    board.dispose();
  }
  // The hook redirects before translation, so only the alias PC is translated and its
  // metadata refresh must observe the hook already having run.
  expect(translations.map((entry) => entry.pc)).toEqual([alias]);
  expect(output).toEqual([2]);
  const sram = calls.find((call) => call.memory === 'sram');
  expect(sram).toBeDefined();
  expect(sram!.base).toBe(alias);
  expect(sram!.hooked).toBe(true);
  expect(translations[0]!.base).toBe(alias);
  expect(translations[0]!.version).toBe(sram!.version);
});

it('does not refresh SRAM metadata on a Flash stack write', () => {
  const builder = createDeviceBuilder({ name: 'MetadataStack' });
  builder.memory({ name: 'code', length: 4 });
  builder.memory({ name: 'sram', length: 4 });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  const calls: string[] = [];
  const library = createDeviceLibrary([
    {
      id: 'probe',
      model: builder.finish(),
      create: (context) => {
        const registration = context.attachJit({
          entry: 'cpu',
          code: 'code',
          codeRegions: [{ memory: 'sram', base: 0x20000000, size: 4 }],
          codeMetadata: (input: JitCodeMetadataInput) => {
            calls.push(input.region.memory);
            return { polling: [], delays: new Map() };
          },
          pc: 'pc',
          translate(input: JitTranslateInput, block: JitBlockBuilder) {
            block.instruction({ pc: 0, nextPc: 0 }, (body) => {
              body.store8('sram', 0, 1);
              body.elapse(1);
            });
            return block.finish();
          },
        });
        try {
          context.loadBytes('code', new Uint8Array([1]));
          context.loadBytes('sram', new Uint8Array([0]));
        } catch (cause) {
          registration.dispose();
          throw cause;
        }
        return { sync() {}, dispose: () => registration.dispose() };
      },
    },
  ]);
  const board = createBoard(library, { instances: [{ id: 'probe', type: 'probe' }], nets: [] });
  try {
    board.runUntil(100);
  } finally {
    board.dispose();
  }
  expect(calls).toEqual(['code']);
});

it('refreshes both primary aliases before direct after a primary write', () => {
  const builder = createDeviceBuilder({ name: 'MetadataAlias' });
  builder.memory({ name: 'code', length: 8 });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  builder.start((body) => {
    body.wait(body.constant(types.number, 1));
    body.store8('code', 0, 1);
  });
  const calls: number[] = [];
  const library = createDeviceLibrary([
    {
      id: 'probe',
      model: builder.finish(),
      create: (context) => {
        const registration = context.attachJit({
          entry: 'cpu',
          code: 'code',
          codeRegions: [{ memory: 'code', base: 8, size: 8 }],
          codeMetadata: (input: JitCodeMetadataInput) => {
            calls.push(input.region.base);
            return { polling: [], delays: new Map() };
          },
          pc: 'pc',
          translate(input: JitTranslateInput, block: JitBlockBuilder) {
            block.instruction({ pc: 0, nextPc: 0 }, (body) => body.elapse(1));
            return block.finish();
          },
        });
        try {
          context.loadBytes('code', new Uint8Array([1]));
        } catch (cause) {
          registration.dispose();
          throw cause;
        }
        return { sync() {}, dispose: () => registration.dispose() };
      },
    },
  ]);
  const board = createBoard(library, { instances: [{ id: 'probe', type: 'probe' }], nets: [] });
  try {
    board.runUntil(2);
  } finally {
    board.dispose();
  }
  expect(calls.filter((base) => base === 0).length).toBeGreaterThan(1);
  expect(calls.filter((base) => base === 8).length).toBeGreaterThan(1);
});

it('faults atomically for throw, promise, invalid metadata and an expired view', () => {
  function attempt(provider: unknown, inspect?: (view: unknown) => void, shouldThrow = true) {
    const builder = createDeviceBuilder({ name: 'MetadataFault' });
    builder.memory({ name: 'code', length: 4 });
    builder.state({ name: 'pc', type: types.number, initial: 0 });
    const library = createDeviceLibrary([
      {
        id: 'probe',
        model: builder.finish(),
        create: (context) => {
          const registration = context.attachJit({
            entry: 'cpu',
            code: 'code',
            codeMetadata: ((input: JitCodeMetadataInput) => {
              inspect?.(input.region.code);
              return (provider as (input: JitCodeMetadataInput) => JitCodeMetadata)(input);
            }) as never,
            pc: 'pc',
            translate(input: JitTranslateInput, block: JitBlockBuilder) {
              block.instruction({ pc: 0, nextPc: 1 }, (body) => body.stop());
              return block.finish();
            },
          });
          try {
            context.loadBytes('code', new Uint8Array([1]));
          } catch (cause) {
            registration.dispose();
            throw cause;
          }
          return { sync() {}, dispose: () => registration.dispose() };
        },
      },
    ]);
    const board = createBoard(library, { instances: [{ id: 'probe', type: 'probe' }], nets: [] });
    try {
      if (shouldThrow) {
        expect(() => board.runUntil(1)).toThrow();
        expect(board.status).toBe('faulted');
      } else {
        board.runUntil(1);
        expect(board.status).toBe('ready');
      }
    } finally {
      board.dispose();
    }
  }

  attempt(() => {
    throw new Error('provider failed');
  });
  attempt(() => Promise.resolve({ polling: [], delays: new Map() }));
  attempt(() => ({ polling: [], delays: {} }));
  attempt(() => ({
    polling: [],
    delays: new Map([[0, { counter: 'counter', cycles: 0 }]]),
  }));
  let expired!: { readonly [index: number]: number | undefined };
  attempt(
    () => ({ polling: [], delays: new Map() }),
    (view) => {
      expired = view as { readonly [index: number]: number | undefined };
    },
    false,
  );
  expect(() => expired[0]).toThrow(/Metadata view expired/);
});

it('validates provider regions/timings and leaves no partial metadata on failure', () => {
  const create = (provider: unknown, regions = false) => {
    const library = createDeviceLibrary([
      {
        id: 'probe',
        model: wfiModel(1),
        create: (context) => {
          const registration = context.attachJit({
            entry: 'cpu',
            code: 'code',
            ...(regions ? { codeRegions: [{ memory: 'code', base: 8, size: 4 }] } : {}),
            codeMetadata: provider as never,
            pc: 'pc',
            translate(input: JitTranslateInput, block: JitBlockBuilder) {
              block.instruction({ pc: input.pc, nextPc: input.pc + 1 }, (body) => body.stop());
              return block.finish();
            },
          });
          try {
            context.loadBytes('code', new Uint8Array([1, 1, 1, 1]));
          } catch (cause) {
            registration.dispose();
            throw cause;
          }
          return { sync() {}, dispose: () => registration.dispose() };
        },
      },
    ]);
    return createBoard(library, { instances: [{ id: 'probe', type: 'probe' }], nets: [] });
  };

  for (const provider of [
    () => ({
      polling: [
        { pc: 0, predicate: 'awakeNow' },
        { pc: 0, predicate: 'awakeNow' },
      ],
      delays: new Map(),
    }),
    () => ({ polling: [{ pc: 99, predicate: 'awakeNow' }], delays: new Map() }),
    () => ({ polling: [], delays: new Map([[99, { counter: 'counter', cycles: 1 }]]) }),
  ]) {
    const board = create(provider);
    try {
      expect(() => board.runUntil(1)).toThrow();
      expect(board.status).toBe('faulted');
    } finally {
      board.dispose();
    }
  }

  let primaryCalls = 0;
  const board = create((input: JitCodeMetadataInput): JitCodeMetadata => {
    if (input.region.base === 0) {
      primaryCalls++;
      return { polling: [{ pc: 0, predicate: 'awakeNow' }], delays: new Map() };
    }
    throw new Error('alias metadata failed');
  }, true);
  try {
    expect(() => board.runUntil(1)).toThrow();
    expect(board.status).toBe('faulted');
    const instance = (
      board as unknown as {
        instances: readonly { jits: readonly { metadata?: { polling: Map<number, unknown> } }[] }[];
      }
    ).instances[0]!;
    expect(primaryCalls).toBe(1);
    expect(instance.jits[0]!.metadata!.polling.size).toBe(0);
  } finally {
    board.dispose();
  }
});

it('rejects static polling/delays when codeMetadata is present', () => {
  const builder = createDeviceBuilder({ name: 'MetadataExclusive' });
  builder.memory({ name: 'code', length: 4 });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  const library = createDeviceLibrary([
    {
      id: 'probe',
      model: builder.finish(),
      create: (context) => {
        context.attachJit({
          entry: 'cpu',
          code: 'code',
          codeMetadata: () => ({ polling: [], delays: new Map() }),
          polling: [],
          pc: 'pc',
          translate: () => {
            throw new Error('unreachable');
          },
        });
        return { sync() {}, dispose() {} };
      },
    },
  ]);
  expect(() =>
    createBoard(library, { instances: [{ id: 'probe', type: 'probe' }], nets: [] }),
  ).toThrow();
});
