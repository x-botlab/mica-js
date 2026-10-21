import { describe, expect, it } from 'vitest';
import {
  createIRModule,
  IRConstructionError,
  type BlockDefinition,
  type BlockRef,
  type FunctionDefinition,
  type FunctionRef,
  type InstructionNode,
  type Value,
} from './index';

function functionByName(
  module: ReturnType<typeof createIRModule>,
  name: string,
): FunctionDefinition {
  const definition = module.functions.find((entry) => entry.name === name);
  if (definition === undefined) throw new Error(`Missing function ${name}`);
  return definition;
}

function entryInstructions(definition: FunctionDefinition): readonly InstructionNode[] {
  if (definition.body === undefined) throw new Error(`Missing body for ${definition.name}`);
  return definition.body.entry.instructions;
}

function blockOperations(block: BlockDefinition | undefined): string[] {
  if (block === undefined) return [];
  return [
    ...block.instructions.map((node) => node.op),
    ...(block.terminator === undefined ? [] : [block.terminator.kind]),
  ];
}

function expectConstructionError(run: () => unknown, pattern: RegExp): void {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(IRConstructionError);
  expect(String(error)).toMatch(pattern);
}

interface UnhandledRejectionHost {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
}

const runtime = globalThis as unknown as {
  process?: UnhandledRejectionHost;
  setTimeout: (callback: () => void, delay?: number) => unknown;
};

async function flushRejectionEvents(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    runtime.setTimeout(resolve, 0);
  });
  await Promise.resolve();
}

async function expectConstructionErrorWithoutUnhandledRejection(
  run: () => unknown,
  pattern: RegExp,
): Promise<void> {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown): void => {
    unhandled.push(reason);
  };
  runtime.process?.on('unhandledRejection', listener);
  try {
    expectConstructionError(run, pattern);
    await flushRejectionEvents();
  } finally {
    runtime.process?.off('unhandledRejection', listener);
  }
  expect(unhandled).toEqual([]);
}

describe('@mica-js/ir model and builder', () => {
  it('builds constants, state, calls, and multiple results', () => {
    const module = createIRModule();
    const count = module.state('count', 'u32', 0);
    const split = module.func('split', { params: ['u32'], results: ['u32', 'u32'] });
    split.body((b, [value]) => {
      b.return([value, b.const('u32', 2)]);
    });

    const run = module.entry('run', ['u32']);
    run.body((b, [value]) => {
      const [left, right] = b.call(split, [value]);
      const sum = b.int.add(left, right);
      b.state.store(count, sum);
      b.return([]);
    });

    const splitDefinition = functionByName(module, 'split');
    expect(splitDefinition.category).toBe('function');
    expect(splitDefinition.params).toEqual(['u32']);
    expect(splitDefinition.results).toEqual(['u32', 'u32']);
    expect(blockOperations(splitDefinition.body?.entry)).toEqual(['const', 'return']);

    const runDefinition = functionByName(module, 'run');
    expect(blockOperations(runDefinition.body?.entry)).toEqual([
      'call',
      'int.add',
      'state.store',
      'return',
    ]);
    const call = entryInstructions(runDefinition)[0];
    expect(call?.results).toHaveLength(2);
    expect(call?.results.map((result: Value) => result.type)).toEqual(['u32', 'u32']);

    expect(module.memories).toHaveLength(1);
    expect(module.memories[0]).toMatchObject({
      name: 'count',
      writable: true,
      initial: [0],
      layout: { kind: 'scalar', scalarType: 'u32', length: 1 },
    });

    const initialize = module.lifecycle('initialize', []);
    initialize.body((b) => b.return([]));
    expect(functionByName(module, 'initialize').category).toBe('lifecycle');
  });

  it('keeps block creation out of the insertion position and builds branches and loops', () => {
    const module = createIRModule();
    const insert = module.func('insert', { params: [], results: ['u32'] });
    insert.body((b) => {
      const target = b.block(['u32']);
      b.const('u32', 1);
      b.at(target, (inner, [value]) => inner.return([value]));
      const after = b.const('u32', 2);
      b.return([after]);
    });

    const insertDefinition = functionByName(module, 'insert');
    expect(blockOperations(insertDefinition.body?.entry)).toEqual(['const', 'const', 'return']);
    const targetBlock = insertDefinition.body?.blocks[1];
    expect(blockOperations(targetBlock)).toEqual(['return']);
    expect(targetBlock?.params).toHaveLength(1);

    const choose = module.func('choose', { params: ['bool'], results: ['u32'] });
    choose.body((b, [condition]) => {
      const yes = b.block([]);
      const no = b.block([]);
      const join = b.block(['u32']);
      b.branch(condition, { target: yes, args: [] }, { target: no, args: [] });
      b.at(yes, (inner) => inner.jump(join, [inner.const('u32', 1)]));
      b.at(no, (inner) => inner.jump(join, [inner.const('u32', 2)]));
      b.at(join, (inner, [result]) => inner.return([result]));
    });

    const chooseDefinition = functionByName(module, 'choose');
    const entry = chooseDefinition.body?.entry;
    expect(entry?.terminator?.kind).toBe('branch');
    expect(entry?.terminator).toMatchObject({
      yes: { target: { id: 1 } },
      no: { target: { id: 2 } },
    });
    expect(chooseDefinition.body?.blocks.map((block) => blockOperations(block))).toEqual([
      ['branch'],
      ['const', 'jump'],
      ['const', 'jump'],
      ['return'],
    ]);

    const loop = module.func('loop', { params: ['u32'], results: ['u32'] });
    loop.body((b, [count]) => {
      const repeat = b.block(['u32']);
      const step = b.block(['u32']);
      const done = b.block(['u32']);
      b.jump(repeat, [count]);
      b.at(repeat, (inner, [remaining]) => {
        const zero = inner.int.cmp('eq', remaining, inner.const('u32', 0));
        inner.branch(
          zero,
          { target: done, args: [remaining] },
          { target: step, args: [remaining] },
        );
      });
      b.at(step, (inner, [remaining]) => {
        inner.jump(repeat, [inner.int.sub(remaining, inner.const('u32', 1))]);
      });
      b.at(done, (inner, [result]) => inner.return([result]));
    });

    const loopDefinition = functionByName(module, 'loop');
    expect(loopDefinition.body?.blocks[1]?.params.map((param) => param.type)).toEqual(['u32']);
    expect(loopDefinition.body?.blocks[2]?.terminator?.kind).toBe('jump');
  });

  it('represents state, array, bytes, and inbox with one memory model', () => {
    const module = createIRModule();
    const words = [1, 2, 3];
    const bytes = new Uint8Array([9, 8, 7]);
    module.state('flag', 'bool', false);
    module.array('words', 'u16', words);
    module.bytes('ram', bytes, { readonly: false });
    module.bytes('rom', new Uint8Array(4), { readonly: true, unitBytes: 2 });
    module.inbox('input', 8);

    words[0] = 99;
    bytes[0] = 0xaa;

    expect(module.memories.map((memory) => memory.name)).toEqual([
      'flag',
      'words',
      'ram',
      'rom',
      'input',
    ]);
    expect(module.memories.map((memory) => memory.kind)).toEqual([
      'state',
      'array',
      'bytes',
      'bytes',
      'inbox',
    ]);
    expect(module.memories[1]?.initial).toEqual([1, 2, 3]);
    expect(module.memories[2]?.initial).toEqual([9, 8, 7]);
    expect(module.memories[2]?.writable).toBe(true);
    expect(module.memories[3]).toMatchObject({
      writable: false,
      layout: { kind: 'bytes', length: 4, unitBytes: 2 },
    });
    expect(module.memories[4]).toMatchObject({
      writable: false,
      layout: { kind: 'bytes', length: 8, unitBytes: 8 },
    });
  });

  it('rejects invalid references, layouts, and construction order', () => {
    const module = createIRModule();
    const count = module.state('count', 'u32', 0);
    const words = module.array('words', 'u16', [0]);
    const ram = module.bytes('ram', new Uint8Array(4), { readonly: false });
    const rom = module.bytes('rom', new Uint8Array(4), { readonly: true });
    const inbox = module.inbox('input', 4);
    const helper = module.func('helper', { params: [], results: ['u32'] });
    const entry = module.entry('run', []);

    helper.body((b) => b.return([b.const('u32', 1)]));
    expectConstructionError(
      () => helper.body((b) => b.return([b.const('u32', 2)])),
      /already has a body/,
    );

    const other = createIRModule();
    const otherCount = other.state('count', 'u32', 0);
    const cross = createIRModule();
    const probe = cross.entry('probe', []);
    expectConstructionError(
      () =>
        probe.body((b) => {
          b.state.load(otherCount);
          b.return([]);
        }),
      /another module/,
    );

    expectConstructionError(
      () =>
        entry.body((b) => {
          b.state.store(count, b.const('bool', true) as never);
          b.return([]);
        }),
      /must have type u32/,
    );

    expectConstructionError(
      () =>
        entry.body((b) => {
          b.state.load(words as never);
          b.return([]);
        }),
      /must be a state reference/,
    );

    expectConstructionError(
      () =>
        entry.body((b) => {
          b.bytes.store('u8', 'little', rom as never, b.const('u32', 0), b.const('u8', 1));
          b.return([]);
        }),
      /must be writable/,
    );

    expectConstructionError(
      () =>
        entry.body((b) => {
          b.bytes.copy(
            inbox as never,
            b.const('u32', 0),
            ram,
            b.const('u32', 0),
            b.const('u32', 1),
          );
          b.return([]);
        }),
      /destination/,
    );

    expectConstructionError(
      () =>
        entry.body((b) => {
          b.call(entry as unknown as FunctionRef, []);
          b.return([]);
        }),
      /ordinary function/,
    );

    expectConstructionError(
      () =>
        entry.body((b) => {
          b.return([]);
          b.const('u32', 1);
        }),
      /after a terminator/,
    );

    expectConstructionError(
      () =>
        entry.body((b) => {
          b.const('u32', 1);
        }),
      /must end with a terminator/,
    );

    expectConstructionError(
      () =>
        entry.body((b) => {
          const target = b.block([]);
          b.jump(target, []);
        }),
      /never defined/,
    );

    expectConstructionError(
      () =>
        entry.body((b) => {
          const target = b.block([]);
          b.at(target, (inner) => inner.return([]));
          b.at(target, (inner) => inner.return([]));
          b.return([]);
        }),
      /already defined/,
    );

    expectConstructionError(
      () =>
        entry.body((b) => {
          const target = b.block(['u32']);
          b.at(target, (inner) => {
            inner.const('u32', 1);
          });
          b.return([]);
        }),
      /must end with a terminator/,
    );

    expectConstructionError(
      () =>
        entry.body((b) => {
          const target = b.block(['u32']);
          b.jump(target, [b.const('bool', true) as never]);
          b.at(target, (inner) => inner.return([]));
          b.return([]);
        }),
      /must have type u32/,
    );

    expectConstructionError(
      () =>
        entry.body((b) => {
          const yes = b.block([]);
          const no = b.block([]);
          b.branch(b.const('bool', true), { target: yes, args: [] }, {
            target: no,
            args: [b.const('u32', 1)],
          } as never);
          b.at(yes, (inner) => inner.return([]));
          b.at(no, (inner) => inner.return([]));
          b.return([]);
        }),
      /must contain 0 value/,
    );

    expectConstructionError(() => entry.body((async () => undefined) as never), /synchronous/);

    expectConstructionError(
      () =>
        entry.body((b) => {
          const target = b.block([]);
          b.at(target, (async () => undefined) as never);
          b.return([]);
        }),
      /synchronous/,
    );

    expectConstructionError(
      () =>
        entry.body(function* () {
          yield undefined;
          return undefined;
        } as never),
      /synchronous/,
    );

    const first = module.func('first', { params: [], results: [] });
    let leakedBlock: BlockRef | undefined;
    first.body((b) => {
      const target = b.block([]);
      leakedBlock = target;
      b.at(target, (inner) => inner.return([]));
      b.return([]);
    });
    expect(leakedBlock).toBeDefined();
    const second = module.func('second', { params: [], results: [] });
    expectConstructionError(
      () =>
        second.body((b) => {
          b.jump(leakedBlock as BlockRef, []);
          b.return([]);
        }),
      /another function/,
    );
  });

  it('rejects async and Promise-returning callbacks without leaking rejections', async () => {
    const module = createIRModule();
    const entry = module.entry('run', []);

    let asyncBodyRan = false;
    const asyncBody = async (): Promise<void> => {
      asyncBodyRan = true;
      throw new Error('boom');
    };
    await expectConstructionErrorWithoutUnhandledRejection(
      () => entry.body(asyncBody as never),
      /synchronous/,
    );
    expect(asyncBodyRan).toBe(false);

    await expectConstructionErrorWithoutUnhandledRejection(
      () => entry.body((() => Promise.resolve()) as never),
      /synchronous/,
    );
    await expectConstructionErrorWithoutUnhandledRejection(
      () => entry.body((() => Promise.reject(new Error('boom'))) as never),
      /synchronous/,
    );
    await expectConstructionErrorWithoutUnhandledRejection(
      () =>
        entry.body(
          (() =>
            new Promise<void>((_resolve, reject) => {
              runtime.setTimeout(() => reject(new Error('later')), 0);
            })) as never,
        ),
      /synchronous/,
    );

    let asyncBlockRan = false;
    const asyncBlock = async (): Promise<void> => {
      asyncBlockRan = true;
      throw new Error('boom');
    };
    await expectConstructionErrorWithoutUnhandledRejection(
      () =>
        entry.body((b) => {
          const target = b.block([]);
          b.at(target, asyncBlock as never);
        }),
      /synchronous/,
    );
    expect(asyncBlockRan).toBe(false);

    await expectConstructionErrorWithoutUnhandledRejection(
      () =>
        entry.body((b) => {
          const target = b.block([]);
          b.at(target, (() => Promise.resolve()) as never);
        }),
      /synchronous/,
    );
    await expectConstructionErrorWithoutUnhandledRejection(
      () =>
        entry.body((b) => {
          const target = b.block([]);
          b.at(target, (() => Promise.reject(new Error('boom'))) as never);
        }),
      /synchronous/,
    );

    expect(functionByName(module, 'run').body).toBeUndefined();
  });

  it('invalidates a function build when a block callback fails', () => {
    const module = createIRModule();
    const retry = module.func('retry', { params: [], results: ['u32'] });
    let leakedBlock: BlockRef | undefined;

    expectConstructionError(
      () =>
        retry.body((b) => {
          const target = b.block(['u32']);
          leakedBlock = target;
          b.jump(target, [b.const('u32', 1)]);
          try {
            b.at(target, (inner, [value]) => {
              inner.int.add(value, value);
            });
          } catch {
            // A failed block definition must not leave a retryable partial block.
          }
          b.at(target, (inner, [value]) => inner.return([value]));
        }),
      /cannot continue after a failed block definition/,
    );
    expect(functionByName(module, 'retry').body).toBeUndefined();
    expect(leakedBlock).toBeDefined();

    const second = module.func('second', { params: [], results: [] });
    expectConstructionError(
      () =>
        second.body((b) => {
          b.jump(leakedBlock as BlockRef, []);
          b.return([]);
        }),
      /another function/,
    );

    retry.body((b) => {
      const target = b.block(['u32']);
      b.jump(target, [b.const('u32', 1)]);
      b.at(target, (inner, [value]) => inner.return([value]));
    });
    expect(blockOperations(functionByName(module, 'retry').body?.blocks[1])).toEqual(['return']);

    const thrown = module.func('thrown', { params: [], results: [] });
    expectConstructionError(
      () =>
        thrown.body((b) => {
          const target = b.block([]);
          try {
            b.at(target, (inner) => {
              inner.const('u32', 1);
              throw new Error('boom');
            });
          } catch {
            // The thrown callback is also a failed block definition.
          }
          b.return([]);
        }),
      /cannot continue after a failed block definition/,
    );
    expect(functionByName(module, 'thrown').body).toBeUndefined();

    const nested = module.func('nested', { params: [], results: [] });
    expectConstructionError(
      () =>
        nested.body((b) => {
          const outer = b.block([]);
          const inner = b.block([]);
          b.jump(outer, []);
          try {
            b.at(outer, (outerBuilder) => {
              outerBuilder.at(inner, () => {
                throw new Error('boom');
              });
            });
          } catch {
            // A nested failure invalidates the whole function build.
          }
          b.return([]);
        }),
      /cannot continue after a failed block definition/,
    );
    expect(functionByName(module, 'nested').body).toBeUndefined();
  });

  it('keeps constants within declared scalar types and rounds f32 at the boundary', () => {
    const module = createIRModule();
    const values = module.func('values', { params: [], results: ['f32', 'f64'] });
    values.body((b) => {
      const rounded = b.const('f32', 0.1);
      const payload = b.bits('f64', '0x7FF8000000001234');
      b.return([rounded, payload]);
    });

    const instructions = entryInstructions(functionByName(module, 'values'));
    expect(instructions[0]?.operands[0]).toEqual({ kind: 'literal', value: Math.fround(0.1) });
    expect(instructions[1]?.operands[0]).toEqual({
      kind: 'literal',
      value: '0x7FF8000000001234',
    });

    expectConstructionError(() => {
      const bad = module.func('bad', { params: [], results: ['u8'] });
      bad.body((b) => b.return([b.const('u8', 300)]));
    }, /outside/);
    expectConstructionError(() => {
      const bad = module.func('badBits', { params: [], results: ['f32'] });
      bad.body((b) => b.return([b.bits('f32', '0x1')]));
    }, /hexadecimal/);
  });

  it('supports explicit domain declarations and instructions without host callbacks', () => {
    const module = createIRModule();
    const led = module.domainDeclaration('led', 'status');
    const setLed = module.domainInstruction('led.set', {
      operands: [
        { kind: 'static', category: 'led' },
        { kind: 'value', type: 'bool' },
      ],
      results: [],
    });
    const setMode = module.domainInstruction('led.mode', {
      operands: [{ kind: 'static', category: 'led' }, { kind: 'literal' }],
      results: [],
    });
    const run = module.entry('run', ['bool']);
    run.body((b, [enabled]) => {
      b.invoke(setLed, [led, enabled]);
      b.return([]);
    });
    const mode = module.entry('mode', []);
    mode.body((b) => {
      b.invoke(setMode, [led, 'fast']);
      b.return([]);
    });

    expect(module.domainDeclarations).toEqual([{ kind: 'led', name: 'status', ref: led }]);
    expect(module.instructions).toEqual([
      {
        name: 'led.set',
        operands: [
          { kind: 'static', category: 'led' },
          { kind: 'value', type: 'bool' },
        ],
        results: [],
      },
      {
        name: 'led.mode',
        operands: [{ kind: 'static', category: 'led' }, { kind: 'literal' }],
        results: [],
      },
    ]);
    expect(entryInstructions(functionByName(module, 'run'))[0]).toMatchObject({
      op: 'led.set',
      operands: [{ kind: 'static' }, { kind: 'ssa' }],
    });
    expect(entryInstructions(functionByName(module, 'mode'))[0]).toMatchObject({
      op: 'led.mode',
      operands: [{ kind: 'static' }, { kind: 'literal', value: 'fast' }],
    });

    expectConstructionError(
      () => module.domainInstruction('call', { operands: [], results: [] }),
      /reserved/,
    );
    module.domainInstruction('led.other', { operands: [], results: [] });
    expectConstructionError(
      () => module.domainInstruction('led.other', { operands: [], results: [] }),
      /already declared or reserved/,
    );
    const invalid = module.entry('invalid', []);
    expectConstructionError(
      () =>
        invalid.body((b) => {
          b.invoke(setLed, [led, b.const('u32', 1)] as never);
          b.return([]);
        }),
      /must have type bool/,
    );

    const other = createIRModule();
    const otherLed = other.domainDeclaration('led', 'status');
    const crossInvalid = module.entry('crossInvalid', ['bool']);
    expectConstructionError(
      () =>
        crossInvalid.body((b, [enabled]) => {
          b.invoke(setLed, [otherLed, enabled]);
          b.return([]);
        }),
      /another module/,
    );
    expectConstructionError(() => module.domainDeclaration('led', 'status'), /already declared/);
  });

  it('rejects duplicate declarations and invalid memory declarations', () => {
    const module = createIRModule();
    module.state('value', 'u32', 0);
    expectConstructionError(() => module.state('value', 'u32', 1), /already declared/);
    expectConstructionError(() => module.state('bad', 'u64' as never, 0 as never), /scalar type/);
    expectConstructionError(() => module.array('badArray', 'u8', [256]), /outside/);
    expectConstructionError(
      () => module.bytes('badUnit', new Uint8Array(2), { readonly: false, unitBytes: 0 }),
      /positive/,
    );
    expectConstructionError(
      () => module.bytes('badInitial', [] as never, { readonly: false }),
      /Uint8Array/,
    );
    expectConstructionError(() => module.inbox('badInbox', -1), /non-negative/);
  });
});
