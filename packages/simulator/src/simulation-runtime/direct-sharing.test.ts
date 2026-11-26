import { createDeviceBuilder, types, type JitBlockBuilder } from '@mica-js/device-model';
import { describe, expect, it } from 'vitest';
import { createBoard, createDeviceLibrary } from '../runtime';
import type { Instance } from '../runtime/instance';
import { directJitStats } from '../runtime/jit';
import type { Jit } from '../runtime/state';
import type { JitCodeRegion, JitDelay, JitTranslate, JitTranslateInput } from '../types';

/** The implicit primary window is `[0, WINDOW)`; the alias window reuses the same bytes. */
const WINDOW = 0x1000;
const ALIAS = WINDOW;

interface TranslationRecord {
  readonly pc: number;
  readonly base: number;
  readonly version: number;
  readonly byte: number;
  readonly marked: boolean;
}

interface SharingBoard {
  readonly board: ReturnType<typeof createBoard>;
  readonly instance: Instance;
  readonly jit: Jit;
  readonly dispose: () => void;
}

interface SharingBoardOptions {
  readonly translate: JitTranslate;
  readonly shareDirectBodies?: boolean;
  readonly delays?: ReadonlyMap<number, JitDelay>;
  readonly codeRegions?: readonly JitCodeRegion[];
  readonly configure?: (builder: ReturnType<typeof createDeviceBuilder>) => void;
  readonly load?: Uint8Array;
}

function createSharingBoard(options: SharingBoardOptions): SharingBoard {
  const builder = createDeviceBuilder({ name: 'DirectSharing' });
  builder.memory({ name: 'code', length: WINDOW });
  builder.memory({ name: 'sram', length: 8 });
  for (const name of ['pc', 'hits', 'prefixes', 'suffixes', 'marker', 'counter'])
    builder.state({ name, type: types.number, initial: 0 });
  options.configure?.(builder);
  const library = createDeviceLibrary([
    {
      id: 'sharing',
      model: builder.finish(),
      create: (context) => {
        const registration = context.attachJit({
          entry: 'sharing',
          code: 'code',
          codeRegions: options.codeRegions ?? [{ memory: 'code', base: ALIAS, size: WINDOW }],
          pc: 'pc',
          ...(options.shareDirectBodies === undefined
            ? {}
            : { shareDirectBodies: options.shareDirectBodies }),
          ...(options.delays === undefined ? {} : { delays: options.delays }),
          translate: options.translate,
        });
        try {
          context.loadBytes('code', options.load ?? new Uint8Array([1]));
        } catch (cause) {
          registration.dispose();
          throw cause;
        }
        return { sync() {}, dispose: () => registration.dispose() };
      },
    },
  ]);
  const board = createBoard(
    library,
    { instances: [{ id: 'sharing', type: 'sharing' }], nets: [] },
    { execution: 'throughput' },
  );
  const instance = (board as unknown as { instances: readonly Instance[] }).instances[0]!;
  return {
    board,
    instance,
    jit: instance.jits[0]!,
    dispose: () => board.dispose(),
  };
}

/** Both logical windows fetch the same byte and emit structurally identical IR. */
function alternatingTranslate(log: TranslationRecord[]): JitTranslate {
  return (input: JitTranslateInput, block: JitBlockBuilder) => {
    log.push({
      pc: input.pc,
      base: input.codeBase,
      version: input.codeVersion,
      byte: input.code[input.pc - input.codeBase] ?? 0,
      marked: input.markDirectBodyShareable !== undefined,
    });
    input.markDirectBodyShareable?.(input.pc, 1);
    block.instruction({ pc: input.pc, nextPc: input.pc === 0 ? ALIAS : 0 }, (body) => {
      body.writeState(
        'hits',
        body.add(body.readState('hits', types.number), body.constant(types.number, 1)),
      );
      body.elapse(1);
    });
    return block.finish();
  };
}

function currentPc(instance: Instance): number {
  return instance.states.get('pc') as number;
}

function zeroShareRejected() {
  return {
    missing: 0,
    invalid: 0,
    single: 0,
    ir: 0,
    delay: 0,
    isolated: 0,
    context: 0,
  };
}

function zeroMarkRejected() {
  return {
    unknownPc: 0,
    duplicate: 0,
    invalidPc: 0,
    invalidLength: 0,
    outsideRegion: 0,
    crossView: 0,
    service: 0,
    notAdmitted: 0,
  };
}

describe('direct JIT body sharing', () => {
  it('shares one body across two logical windows and keeps per-route nextPc', () => {
    const log: TranslationRecord[] = [];
    const harness = createSharingBoard({
      translate: alternatingTranslate(log),
      shareDirectBodies: true,
    });
    try {
      // The first route writes ALIAS, the second writes 0; the shared body itself carries
      // neither logical PC nor nextPc.
      harness.board.runUntil(1);
      expect(currentPc(harness.instance)).toBe(ALIAS);
      harness.board.runUntil(2);
      expect(currentPc(harness.instance)).toBe(0);
      harness.board.runUntil(10);
      expect(harness.instance.states.get('hits')).toBe(10);
      expect(currentPc(harness.instance)).toBe(0);

      const stats = directJitStats(harness.jit)!;
      expect(stats.directShareCallbacks).toBe(2);
      expect(stats.directShareCandidates).toBe(2);
      expect(stats.directShareGroups).toBe(1);
      expect(stats.directSharedRoutes).toBe(2);
      expect(stats.directSharedBodies).toBe(1);
      expect(stats.directSharedBytes).toBeGreaterThan(0);
      expect(stats.directShareReusedBodies).toBe(1);
      expect(stats.directShareReusedRoutes).toBeGreaterThanOrEqual(2);
      expect(stats.directShareRejected).toMatchObject({
        missing: 0,
        invalid: 0,
        ir: 0,
        delay: 0,
        isolated: 0,
        context: 0,
      });
      expect(stats.directShareMarkRejected).toEqual(zeroMarkRejected());
      expect(log.map((item) => item.pc).sort((left, right) => left - right)).toEqual([0, ALIAS]);
      expect(log.every((item) => item.marked)).toBe(true);
      const codeVersion = harness.instance.codeVersion('code');
      for (const pc of [0, ALIAS]) {
        const instruction = harness.jit.cache.get(pc)!;
        expect(instruction.codeVersion).toBe(codeVersion);
        expect(instruction.share).toEqual({
          storage: 'code',
          codeVersion,
          offset: 0,
          byteLength: 1,
        });
      }
    } finally {
      harness.dispose();
    }
  });

  it('keeps both windows independent when sharing is disabled', () => {
    const log: TranslationRecord[] = [];
    const harness = createSharingBoard({ translate: alternatingTranslate(log) });
    try {
      harness.board.runUntil(1);
      expect(currentPc(harness.instance)).toBe(ALIAS);
      harness.board.runUntil(2);
      expect(currentPc(harness.instance)).toBe(0);
      harness.board.runUntil(10);
      expect(harness.instance.states.get('hits')).toBe(10);
      expect(currentPc(harness.instance)).toBe(0);

      const stats = directJitStats(harness.jit)!;
      expect(stats.directShareCallbacks).toBe(0);
      expect(stats.directShareCandidates).toBe(0);
      expect(stats.directShareGroups).toBe(0);
      expect(stats.directSharedRoutes).toBe(0);
      expect(stats.directSharedBodies).toBe(0);
      expect(stats.directSharedBytes).toBe(0);
      expect(stats.directShareReusedBodies).toBe(0);
      expect(stats.directShareReusedRoutes).toBe(0);
      expect(stats.directShareRejected).toEqual(zeroShareRejected());
      expect(stats.directShareMarkRejected).toEqual(zeroMarkRejected());
      expect(stats.directBodyBytes + stats.directArtifactInstructionHits).toBeGreaterThan(0);
      expect(log).toHaveLength(2);
      expect(log.every((item) => !item.marked)).toBe(true);
      for (const pc of [0, ALIAS]) expect(harness.jit.cache.get(pc)?.share).toBeUndefined();
    } finally {
      harness.dispose();
    }
  });

  it('rejects invalid marks without failing translation or execution', () => {
    const log: TranslationRecord[] = [];
    const SERVICE = 0x1000;
    const builder = createDeviceBuilder({ name: 'MarkRejection' });
    builder.memory({ name: 'code', length: 8 });
    builder.memory({ name: 'sram', length: 8 });
    builder.state({ name: 'pc', type: types.number, initial: 0 });
    builder.state({ name: 'hits', type: types.number, initial: 0 });
    builder.pureFn({ name: 'ready', params: [], returns: types.bool }, (body) => {
      body.returnValue(body.constant(types.bool, false));
    });
    const translate: JitTranslate = (input, block) => {
      log.push({
        pc: input.pc,
        base: input.codeBase,
        version: input.codeVersion,
        byte: input.code[0] ?? 0,
        marked: input.markDirectBodyShareable !== undefined,
      });
      const mark = input.markDirectBodyShareable!;
      mark(0, 1);
      mark(0, 1);
      mark(999, 1);
      mark(Number.NaN, 1);
      mark(-1, 1);
      mark(1, 0);
      mark(1, -2);
      mark(1, 1.5);
      mark(1, 1000);
      mark(0x100, 1);
      mark(SERVICE, 1);
      mark(3, 1);
      mark(5, 1);
      const entries = [0, 1, 2, 0x100, SERVICE, 3, 5];
      for (let index = 0; index < entries.length; index++) {
        const pc = entries[index]!;
        const nextPc = entries[(index + 1) % entries.length]!;
        block.instruction({ pc, nextPc }, (body) => {
          if (pc !== 0) return;
          body.writeState(
            'hits',
            body.add(body.readState('hits', types.number), body.constant(types.number, 1)),
          );
          body.stop();
        });
      }
      return block.finish();
    };
    const library = createDeviceLibrary([
      {
        id: 'marks',
        model: builder.finish(),
        create: (context) => {
          const registration = context.attachJit({
            entry: 'marks',
            code: 'code',
            codeRegions: [
              { memory: 'code', base: 0x100, size: 8 },
              { memory: 'sram', base: 0x200, size: 8 },
            ],
            pc: 'pc',
            polling: [{ pc: 3, predicate: 'ready' }],
            shareDirectBodies: true,
            translate,
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
    const board = createBoard(library, { instances: [{ id: 'marks', type: 'marks' }], nets: [] });
    try {
      board.runUntil(1);
      expect(board.status).toBe('ready');
      const instance = (board as unknown as { instances: readonly Instance[] }).instances[0]!;
      const jit = instance.jits[0]!;
      expect(instance.states.get('hits')).toBe(1);
      const stats = directJitStats(jit)!;
      expect(stats.directShareCallbacks).toBe(13);
      expect(stats.directShareCandidates).toBe(2);
      expect(stats.directShareMarkRejected).toEqual({
        unknownPc: 1,
        duplicate: 1,
        invalidPc: 2,
        invalidLength: 3,
        outsideRegion: 1,
        crossView: 1,
        service: 1,
        notAdmitted: 1,
      });
      expect(log).toHaveLength(1);
      expect(log[0]!.marked).toBe(true);
    } finally {
      board.dispose();
    }
  });

  it('does not share when same bytes produce different IR or delay', () => {
    const variants: readonly {
      readonly name: string;
      readonly delays?: ReadonlyMap<number, JitDelay>;
      readonly translate: (log: TranslationRecord[]) => JitTranslate;
    }[] = [
      {
        name: 'ir',
        translate: (log) => (input, block) => {
          log.push({
            pc: input.pc,
            base: input.codeBase,
            version: input.codeVersion,
            byte: input.code[0] ?? 0,
            marked: input.markDirectBodyShareable !== undefined,
          });
          input.markDirectBodyShareable?.(input.pc, 1);
          const value = input.pc === 0 ? 1 : 2;
          block.instruction({ pc: input.pc, nextPc: input.pc === 0 ? ALIAS : 0 }, (body) => {
            body.writeState(
              'hits',
              body.add(body.readState('hits', types.number), body.constant(types.number, 1)),
            );
            body.elapse(1);
            body.writeState(
              'marker',
              body.add(body.readState('marker', types.number), body.constant(types.number, value)),
            );
          });
          return block.finish();
        },
      },
      {
        name: 'delay',
        delays: new Map([[0, { counter: 'counter', cycles: 1 }]]),
        translate: alternatingTranslate,
      },
    ];
    for (const variant of variants) {
      const log: TranslationRecord[] = [];
      const harness = createSharingBoard({
        translate: variant.translate(log),
        shareDirectBodies: true,
        ...(variant.delays === undefined ? {} : { delays: variant.delays }),
      });
      try {
        harness.board.runUntil(2);
        const stats = directJitStats(harness.jit)!;
        expect(stats.directShareGroups, variant.name).toBe(0);
        expect(stats.directSharedRoutes, variant.name).toBe(0);
        expect(stats.directSharedBodies, variant.name).toBe(0);
        if (variant.name === 'ir') expect(stats.directShareRejected.ir).toBeGreaterThan(0);
        else expect(stats.directShareRejected.delay).toBeGreaterThan(0);
        expect(harness.instance.states.get('hits'), variant.name).toBe(2);
      } finally {
        harness.dispose();
      }
    }
  });

  it('retranslates both windows from new versions and completes old suffixes once', () => {
    const log: TranslationRecord[] = [];
    const translate: JitTranslate = (input, block) => {
      const byte = input.code[input.pc - input.codeBase] ?? 0;
      log.push({
        pc: input.pc,
        base: input.codeBase,
        version: input.codeVersion,
        byte,
        marked: input.markDirectBodyShareable !== undefined,
      });
      input.markDirectBodyShareable?.(input.pc, 1);
      block.instruction({ pc: input.pc, nextPc: input.pc === 0 ? ALIAS : 0 }, (body) => {
        body.writeState(
          'prefixes',
          body.add(body.readState('prefixes', types.number), body.constant(types.number, 1)),
        );
        body.elapse(10);
        body.writeState(
          'suffixes',
          body.add(body.readState('suffixes', types.number), body.constant(types.number, byte)),
        );
      });
      return block.finish();
    };
    const harness = createSharingBoard({
      translate,
      shareDirectBodies: true,
      load: new Uint8Array([1]),
      configure: (builder) => {
        builder.start((body) => {
          body.wait(5);
          body.store8('code', body.constant(types.number, 0), body.constant(types.number, 2));
          body.wait(55);
          body.store8('code', body.constant(types.number, 0), body.constant(types.number, 0));
        });
      },
    });
    try {
      harness.board.runUntil(110);
      const instance = harness.instance;
      // 11 instructions start at 0,10,...,100. The old suffix contributes once (1), the
      // rewritten generation contributes 2 for five suffixes, the erased generation 0.
      expect(instance.states.get('prefixes')).toBe(11);
      expect(instance.states.get('suffixes')).toBe(11);

      const versions = [...new Set(log.map((item) => item.version))].sort(
        (left, right) => left - right,
      );
      expect(versions).toHaveLength(3);
      const pcsAtVersion = (version: number): number[] =>
        [...new Set(log.filter((item) => item.version === version).map((item) => item.pc))].sort(
          (left, right) => left - right,
        );
      // The first generation only reached the base window before the write; after each
      // write/erase both windows are retranslated from the new code version.
      expect(pcsAtVersion(versions[0]!)).toEqual([0]);
      expect(pcsAtVersion(versions[1]!)).toEqual([0, ALIAS]);
      expect(pcsAtVersion(versions[2]!)).toEqual([0, ALIAS]);
      expect(
        log.filter((item) => item.version === versions[1]!).every((item) => item.byte === 2),
      ).toBe(true);
      expect(
        log.filter((item) => item.version === versions[2]!).every((item) => item.byte === 0),
      ).toBe(true);

      const stats = directJitStats(harness.jit)!;
      expect(stats.directShareGroups).toBe(1);
      expect(stats.directSharedRoutes).toBe(2);
      expect(stats.directSharedBodies).toBe(2);
      expect(stats.directShareCandidates).toBe(5);
      expect(stats.directShareCallbacks).toBe(5);
    } finally {
      harness.dispose();
    }
  });
});
