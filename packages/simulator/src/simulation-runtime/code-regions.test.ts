import { createDeviceBuilder, types, type JitBlockBuilder } from '@mica-js/device-model';
import { describe, expect, it } from 'vitest';
import { createBoard, createDeviceLibrary } from '../runtime';
import type { Instance } from '../runtime/instance';
import { directJitStats } from '../runtime/jit';
import type { Jit } from '../runtime/state';
import type { BorrowedBytes, JitCodeRegion, JitTranslate, JitTranslateInput } from '../types';

const FLASH_ALIAS = 0x08000000;
const SRAM_BASE = 0x20000000;

function instanceOf(board: ReturnType<typeof createBoard>): Instance {
  return (board as unknown as { instances: readonly Instance[] }).instances[0]!;
}

function jitOf(board: ReturnType<typeof createBoard>): Jit {
  return instanceOf(board).jits[0]!;
}

function regionProbeModel() {
  const builder = createDeviceBuilder({ name: 'RegionProbe' });
  builder.property({ name: 'startPc', type: types.number, default: 0 });
  builder.memory({ name: 'code', length: 8 });
  builder.memory({ name: 'sram', length: 8 });
  builder.memory({ name: 'other', length: 8 });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  builder.channel({ name: 'out', direction: 'output', type: types.number, capacity: 8 });
  builder.start((body) => {
    body.writeState('pc', body.readProperty('startPc', types.number));
  });
  return builder.finish();
}

interface ProbeResult {
  readonly translations: readonly {
    readonly pc: number;
    readonly base: number;
    readonly version: number;
    readonly byte: number;
    readonly length: number;
  }[];
  readonly borrowed: BorrowedBytes;
  readonly borrowedLength: number;
  readonly output: number[];
  readonly denied: boolean;
}

function runRegionProbe(
  startPc: number,
  load: (context: { loadBytes(memory: string, bytes: Uint8Array, offset?: number): void }) => void,
  codeRegions: readonly JitCodeRegion[],
): ProbeResult {
  const translations: {
    readonly pc: number;
    readonly base: number;
    readonly version: number;
    readonly byte: number;
    readonly length: number;
  }[] = [];
  let borrowed!: BorrowedBytes;
  let borrowedLength = 0;
  let denied = false;
  const output: number[] = [];
  const library = createDeviceLibrary([
    {
      id: 'probe',
      model: regionProbeModel(),
      create: (context) => {
        const registration = context.attachJit({
          entry: 'cpu',
          code: 'code',
          codeRegions,
          pc: 'pc',
          translate(input: JitTranslateInput, builder: JitBlockBuilder) {
            borrowed = input.code;
            borrowedLength = input.code.length;
            translations.push({
              pc: input.pc,
              base: input.codeBase,
              version: input.codeVersion,
              byte: input.code[input.pc - input.codeBase] ?? 0,
              length: input.code.length,
            });
            builder.instruction({ pc: input.pc, nextPc: input.pc }, (body) => {
              body.send(
                'out',
                body.constant(types.number, input.code[input.pc - input.codeBase] ?? 0),
              );
              body.stop();
            });
            return builder.finish();
          },
        });
        try {
          load(context);
          try {
            context.loadBytes('other', new Uint8Array([9]));
          } catch {
            denied = true;
          }
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
    instances: [{ id: 'probe', type: 'probe', props: { startPc } }],
    nets: [],
  });
  try {
    board.runUntil(1);
    return { translations, borrowed, borrowedLength, output, denied };
  } finally {
    board.dispose();
  }
}

describe('code regions', () => {
  it('keeps logical PCs for the Flash alias and selects the SRAM view', () => {
    const flashZero = runRegionProbe(
      0,
      (context) => context.loadBytes('code', new Uint8Array([0x2a])),
      [{ memory: 'code', base: FLASH_ALIAS, size: 8 }],
    );
    const flashAlias = runRegionProbe(
      FLASH_ALIAS,
      (context) => context.loadBytes('code', new Uint8Array([0x2a])),
      [{ memory: 'code', base: FLASH_ALIAS, size: 8 }],
    );
    const sram = runRegionProbe(
      SRAM_BASE,
      (context) => context.loadBytes('sram', new Uint8Array([0x33])),
      [{ memory: 'sram', base: SRAM_BASE, size: 8 }],
    );
    const sramWindow = runRegionProbe(
      SRAM_BASE,
      (context) => context.loadBytes('sram', new Uint8Array([0x33])),
      [{ memory: 'sram', base: SRAM_BASE, size: 4 }],
    );

    expect(flashZero.translations[0]).toMatchObject({
      pc: 0,
      base: 0,
      byte: 0x2a,
      length: 8,
    });
    expect(flashAlias.translations[0]).toMatchObject({
      pc: FLASH_ALIAS,
      base: FLASH_ALIAS,
      byte: 0x2a,
      length: 8,
    });
    expect(sram.translations[0]).toMatchObject({
      pc: SRAM_BASE,
      base: SRAM_BASE,
      byte: 0x33,
      length: 8,
    });
    expect(sramWindow.translations[0]).toMatchObject({
      pc: SRAM_BASE,
      base: SRAM_BASE,
      byte: 0x33,
      length: 4,
    });
    expect(flashZero.output).toEqual([0x2a]);
    expect(flashAlias.output).toEqual([0x2a]);
    expect(sram.output).toEqual([0x33]);
    expect(flashZero.denied).toBe(true);
    expect(flashAlias.denied).toBe(true);
    expect(sram.denied).toBe(true);
    expect(flashZero.borrowedLength).toBe(8);
    expect(() => flashZero.borrowed[0]).toThrow(/Translation view expired/);
  });

  it('bumps the per-memory version on a same-byte rewrite inside one runUntil', () => {
    const builder = createDeviceBuilder({ name: 'VersionProbe' });
    builder.memory({ name: 'code', length: 8 });
    builder.memory({ name: 'sram', length: 8 });
    builder.state({ name: 'pc', type: types.number, initial: SRAM_BASE });
    builder.channel({ name: 'out', direction: 'output', type: types.number, capacity: 64 });
    builder.start((body) => {
      body.wait(body.constant(types.number, 1));
      body.store8('sram', body.constant(types.number, 0), body.constant(types.number, 9));
      body.writeState('pc', body.constant(types.number, SRAM_BASE));
    });
    const translations: { pc: number; version: number; byte: number }[] = [];
    const output: number[] = [];
    const library = createDeviceLibrary([
      {
        id: 'probe',
        model: builder.finish(),
        create: (context) => {
          const registration = context.attachJit({
            entry: 'cpu',
            code: 'code',
            codeRegions: [{ memory: 'sram', base: SRAM_BASE, size: 8 }],
            pc: 'pc',
            translate(input: JitTranslateInput, block: JitBlockBuilder) {
              const byte = input.code[input.pc - input.codeBase] ?? 0;
              translations.push({ pc: input.pc, version: input.codeVersion, byte });
              block.instruction({ pc: input.pc, nextPc: input.pc }, (body) => {
                body.send('out', body.constant(types.number, byte));
                body.elapse(1);
              });
              return block.finish();
            },
          });
          try {
            context.loadBytes('sram', new Uint8Array([9]));
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
      board.runUntil(3);
    } finally {
      board.dispose();
    }
    expect(output.slice(0, 2)).toEqual([9, 9]);
    expect(translations.filter((item) => item.pc === SRAM_BASE).length).toBeGreaterThan(1);
    expect(new Set(translations.map((item) => item.version)).size).toBeGreaterThan(1);
  });

  it('does not clear Flash cache or direct when a RAM stack write follows an executed code block', () => {
    const builder = createDeviceBuilder({ name: 'StackProbe' });
    builder.memory({ name: 'code', length: 4 });
    builder.memory({ name: 'sram', length: 4 });
    builder.state({ name: 'pc', type: types.number, initial: 0 });
    builder.state({ name: 'tick', type: types.number, initial: 0 });
    const translations: number[] = [];
    const translate: JitTranslate = ({ pc }, block) => {
      translations.push(pc);
      block.instruction({ pc, nextPc: 0 }, (body) => {
        body.store8('sram', body.constant(types.number, 0), body.constant(types.number, 1));
        body.writeState(
          'tick',
          body.add(body.readState('tick', types.number), body.constant(types.number, 1)),
        );
        body.elapse(1);
      });
      return block.finish();
    };
    const library = createDeviceLibrary([
      {
        id: 'probe',
        model: builder.finish(),
        create: (context) => {
          const registration = context.attachJit({
            entry: 'cpu',
            code: 'code',
            codeRegions: [{ memory: 'sram', base: SRAM_BASE, size: 4 }],
            pc: 'pc',
            translate,
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
    const board = createBoard(library, { instances: [{ id: 'probe', type: 'probe' }], nets: [] });
    try {
      board.runUntil(20);
      const jit = jitOf(board);
      const stats = directJitStats(jit);
      expect(stats).toBeDefined();
      expect(jit.direct).toBeDefined();
      expect(jit.cacheMemories.has('sram')).toBe(false);
      const compiles = stats!.directCompiles;
      const calls = stats!.directCalls;
      const cache = jit.cache.size;
      const translated = translations.length;
      const codeVersion = instanceOf(board).codeVersion('code');
      const sramVersion = instanceOf(board).codeVersion('sram');
      board.runUntil(200);
      expect(translations.length).toBe(translated);
      expect(jit.cache.size).toBe(cache);
      expect(stats!.directCompiles).toBe(compiles);
      expect(stats!.directCalls).toBeGreaterThan(calls);
      expect(instanceOf(board).codeVersion('code')).toBe(codeVersion);
      expect(instanceOf(board).codeVersion('sram')).toBeGreaterThan(sramVersion);
      expect(jit.direct).toBeDefined();
    } finally {
      board.dispose();
    }
  });

  it('captures and freezes regions so later host mutation cannot change routing', () => {
    const regions = [{ memory: 'code', base: FLASH_ALIAS, size: 8 }];
    let baseSeen = -1;
    const library = createDeviceLibrary([
      {
        id: 'probe',
        model: regionProbeModel(),
        create: (context) => {
          const registration = context.attachJit({
            entry: 'cpu',
            code: 'code',
            codeRegions: regions,
            pc: 'pc',
            translate(input: JitTranslateInput, block: JitBlockBuilder) {
              baseSeen = input.codeBase;
              block.instruction({ pc: input.pc, nextPc: input.pc }, (body) => body.stop());
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
    const board = createBoard(library, {
      instances: [{ id: 'probe', type: 'probe', props: { startPc: FLASH_ALIAS } }],
      nets: [],
    });
    try {
      regions[0]!.base = 0x09000000;
      regions.push({ memory: 'code', base: 0x0a000000, size: 8 });
      board.runUntil(1);
      expect(baseSeen).toBe(FLASH_ALIAS);
    } finally {
      board.dispose();
    }
  });

  it('maps every instruction of a multi-PC block to its own region and drops SRAM entries', () => {
    const edge = 4;
    const builder = createDeviceBuilder({ name: 'CrossRegionBlock' });
    builder.memory({ name: 'code', length: 4 });
    builder.memory({ name: 'sram', length: 4 });
    builder.state({ name: 'pc', type: types.number, initial: 0 });
    builder.channel({ name: 'out', direction: 'output', type: types.number, capacity: 8 });
    builder.start((body) => {
      body.wait(body.constant(types.number, 1));
      body.store8('sram', 0, 2);
      body.writeState('pc', body.constant(types.number, edge));
    });
    const translations: { pc: number; version: number; byte: number }[] = [];
    const output: number[] = [];
    const library = createDeviceLibrary([
      {
        id: 'probe',
        model: builder.finish(),
        create: (context) => {
          const registration = context.attachJit({
            entry: 'cpu',
            code: 'code',
            codeRegions: [{ memory: 'sram', base: 4, size: 4 }],
            pc: 'pc',
            translate(input: JitTranslateInput, block: JitBlockBuilder) {
              const byte = input.code[input.pc - input.codeBase] ?? 0;
              translations.push({ pc: input.pc, version: input.codeVersion, byte });
              if (input.pc === 0) {
                block.instruction({ pc: 0, nextPc: edge }, (body) => body.elapse(1));
                // This second entry belongs to SRAM even though the block was translated from
                // the Flash PC. It must not be attributed to Flash or admitted to direct.
                block.instruction({ pc: edge, nextPc: edge }, (body) =>
                  body.send('out', body.constant(types.number, 1)),
                );
              } else {
                block.instruction({ pc: input.pc, nextPc: input.pc }, (body) => {
                  body.send('out', body.constant(types.number, byte));
                  body.stop();
                });
              }
              return block.finish();
            },
          });
          try {
            context.loadBytes('code', new Uint8Array([1]));
            context.loadBytes('sram', new Uint8Array([1]));
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
      board.runUntil(2);
      const jit = jitOf(board);
      expect(output).toEqual([2]);
      expect(translations.map((item) => item.pc)).toEqual([0, edge]);
      expect(translations[1]!.byte).toBe(2);
      expect(translations[1]!.version).toBeGreaterThan(translations[0]!.version);
      expect(jit.cache.has(edge)).toBe(true);
      expect(jit.cache.get(edge)?.codeRegion?.memory).toBe('sram');
      expect(jit.direct?.pcs.has(edge) ?? false).toBe(false);
    } finally {
      board.dispose();
    }
  });

  it('maps two aliases in one memory by each logical PC', () => {
    const alias = 8;
    const builder = createDeviceBuilder({ name: 'AliasBlock' });
    builder.memory({ name: 'code', length: 8 });
    builder.state({ name: 'pc', type: types.number, initial: 0 });
    const library = createDeviceLibrary([
      {
        id: 'probe',
        model: builder.finish(),
        create: (context) => {
          const registration = context.attachJit({
            entry: 'cpu',
            code: 'code',
            codeRegions: [{ memory: 'code', base: alias, size: 8 }],
            pc: 'pc',
            translate(_input: JitTranslateInput, block: JitBlockBuilder) {
              block.instruction({ pc: 0, nextPc: alias }, (body) => body.stop());
              block.instruction({ pc: alias, nextPc: alias }, (body) => body.stop());
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
      board.runUntil(1);
      const jit = jitOf(board);
      expect(jit.cache.get(0)?.codeRegion?.base).toBe(0);
      expect(jit.cache.get(alias)?.codeRegion?.base).toBe(alias);
      expect([...jit.cacheMemories]).toEqual(['code']);
      instanceOf(board).memoryChanged('code', 0, 1);
      expect(jit.cache.size).toBe(0);
      expect(jit.cacheMemories.size).toBe(0);
    } finally {
      board.dispose();
    }
  });

  it('keeps service-PC fallback entries in the primary cache without region attribution', () => {
    const servicePc = 4;
    const builder = createDeviceBuilder({ name: 'ServiceFallbackBlock' });
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
            pc: 'pc',
            translate(_input: JitTranslateInput, block: JitBlockBuilder) {
              block.instruction({ pc: 0, nextPc: servicePc }, (body) => body.stop());
              block.instruction({ pc: servicePc, nextPc: servicePc }, (body) => body.stop());
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
      board.runUntil(1);
      const jit = jitOf(board);
      expect(jit.cache.get(servicePc)?.codeRegion).toBeUndefined();
      expect([...jit.cacheMemories]).toEqual(['code']);
      instanceOf(board).memoryChanged('code', 0, 1);
      expect(jit.cache.size).toBe(0);
      expect(jit.cacheMemories.size).toBe(0);
    } finally {
      board.dispose();
    }
  });

  it('rejects overlapping, out-of-memory, unknown and non-integer regions', () => {
    const cases: readonly JitCodeRegion[][] = [
      [{ memory: 'code', base: 0, size: 4 }],
      [{ memory: 'code', base: 4, size: 1 }],
      [{ memory: 'code', base: 0x100, size: 9 }],
      [{ memory: 'missing', base: 0x100, size: 1 }],
      [{ memory: 'code', base: 0.5, size: 1 }],
    ];
    for (const codeRegions of cases) {
      const library = createDeviceLibrary([
        {
          id: 'probe',
          model: regionProbeModel(),
          create: (context) => {
            context.attachJit({
              entry: 'cpu',
              code: 'code',
              codeRegions,
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
    }
  });
});
