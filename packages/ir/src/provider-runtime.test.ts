import { describe, expect, it } from 'vitest';
import { CORE_INSTRUCTION_NAMES } from './builder';
import {
  createIRInterpreter,
  createIRModule,
  IRExecutionError,
  IRProviderError,
  validateIR,
  type EntryRef,
  type FloatBits,
  type HexBits,
  type IRModule,
  type IRResourcePermission,
  type IRValidationOptions,
  type Value,
} from './index';

const context = { instanceId: 'mcu-60', virtualTime: 0 };
const firmwareLength = 12;

function policy(module: IRModule, extra: IRResourcePermission[] = []): IRValidationOptions {
  return Object.freeze({
    supportedInstructions: CORE_INSTRUCTION_NAMES,
    authorizedInstructions: CORE_INSTRUCTION_NAMES,
    resources: Object.freeze([
      ...module.memories.map((memory) => ({
        ref: memory.ref,
        access: memory.writable ? ('read-write' as const) : ('read' as const),
      })),
      ...extra,
    ]),
  });
}

function f32(bits: string): FloatBits {
  return { type: 'f32', bits: bits as HexBits };
}

function f64(bits: string): FloatBits {
  return { type: 'f64', bits: bits as HexBits };
}

function failure(run: () => unknown): IRExecutionError {
  let caught: unknown;
  try {
    run();
  } catch (cause) {
    caught = cause;
  }
  expect(caught).toBeInstanceOf(IRExecutionError);
  return caught as IRExecutionError;
}

interface ToyInstruction {
  readonly opcode: number;
  readonly operand: number;
  readonly cursor: number;
}

/** #26 §16.4 toy MCU: 0x10 ADD, 0x20 JMP, 0x30 JNZ, 0x00 HALT; 2 B per instruction. */
function toyModule() {
  const calls = { count: 0 };
  const module = createIRModule();
  const firmware = module.bytes(
    'firmware',
    new Uint8Array([0x10, 1, 0x10, 2, 0x30, 8, 0x00, 0x00, 0x10, 4, 0x20, 0]),
    { readonly: true, unitBytes: 8 },
  );
  const pc = module.state('pc', 'u32', 0);
  const r0 = module.state('r0', 'u32', 0);
  const stopped = module.state('stopped', 'bool', false);
  const guestFault = module.state('guestFault', 'bool', false);
  const step = module.entry('step', []);
  const code = module.provider(
    'code',
    {
      keyTypes: ['u32'],
      params: [],
      results: [],
      reads: [firmware],
      imports: [pc, r0, stopped, guestFault],
    },
    (gen, [address]) => {
      calls.count += 1;
      const instructions: ToyInstruction[] = [];
      let cursor = address;
      for (;;) {
        if (cursor + 2 > firmwareLength || cursor % 2 !== 0) {
          instructions.push({ opcode: 0xff, operand: 0, cursor });
          break;
        }
        const bytes = gen.readBytes(firmware, cursor, 2);
        const opcode = bytes[0]!;
        const operand = bytes[1]!;
        instructions.push({ opcode, operand, cursor });
        if (opcode !== 0x10) break;
        cursor += 2;
      }
      return gen.function((b) => {
        let value = b.state.load(r0);
        for (const instruction of instructions) {
          if (instruction.opcode === 0x10) {
            value = b.int.add(value, b.const('u32', instruction.operand));
            continue;
          }
          b.state.store(r0, value);
          if (instruction.opcode === 0x30) {
            const nonzero = b.int.cmp('ne', value, b.const('u32', 0));
            const next = b.select(
              nonzero,
              b.const('u32', instruction.operand),
              b.const('u32', instruction.cursor + 2),
            );
            b.state.store(pc, next);
            b.return([]);
            return;
          }
          if (instruction.opcode === 0x20) {
            b.state.store(pc, b.const('u32', instruction.operand));
            b.return([]);
            return;
          }
          b.state.store(stopped, b.const('bool', true));
          b.state.store(guestFault, b.const('bool', instruction.opcode !== 0x00));
          b.return([]);
          return;
        }
        b.state.store(stopped, b.const('bool', true));
        b.state.store(guestFault, b.const('bool', true));
        b.return([]);
      });
    },
  );
  step.body((b) => b.dispatch(code, [b.state.load(pc)], []));
  return { module, firmware, pc, r0, stopped, guestFault, step, calls };
}

function runStep(
  runtime: ReturnType<typeof createIRInterpreter>,
  step: EntryRef,
  time: number,
): void {
  runtime.execute(step, [], { instanceId: 'mcu-60', virtualTime: time });
}

describe('provider generation against the reference interpreter', () => {
  it('generates one basic block per key, reuses it, and regenerates only invalidated units', () => {
    const fixture = toyModule();
    const validation = policy(fixture.module, [{ ref: fixture.firmware, access: 'update' }]);
    expect(validateIR(fixture.module, validation)).toEqual({ ok: true, diagnostics: [] });
    const runtime = createIRInterpreter(fixture.module, { validation });

    runStep(runtime, fixture.step, 0);
    expect(runtime.storage.loadState(fixture.r0)).toBe(3);
    expect(runtime.storage.loadState(fixture.pc)).toBe(8);
    expect(fixture.calls.count).toBe(1);

    runStep(runtime, fixture.step, 1);
    expect(runtime.storage.loadState(fixture.r0)).toBe(7);
    expect(runtime.storage.loadState(fixture.pc)).toBe(0);
    expect(fixture.calls.count).toBe(2);

    runStep(runtime, fixture.step, 2);
    expect(runtime.storage.loadState(fixture.r0)).toBe(10);
    expect(runtime.storage.loadState(fixture.pc)).toBe(8);
    // Cache hit: the block is not regenerated.
    expect(fixture.calls.count).toBe(2);

    // Unit 0 covers bytes 0..7, so the key-8 block is unaffected and key 0 is stale.
    runtime.storage.updateBytesFromBytes(fixture.firmware, 3, new Uint8Array([5]));
    runStep(runtime, fixture.step, 3);
    expect(runtime.storage.loadState(fixture.r0)).toBe(14);
    expect(runtime.storage.loadState(fixture.pc)).toBe(0);
    // Unit 1 (bytes 8..11) never changed, so B8 is still the original artifact.
    expect(fixture.calls.count).toBe(2);

    runStep(runtime, fixture.step, 4);
    expect(runtime.storage.loadState(fixture.r0)).toBe(20);
    expect(runtime.storage.loadState(fixture.pc)).toBe(8);
    expect(fixture.calls.count).toBe(3);

    runStep(runtime, fixture.step, 5);
    expect(runtime.storage.loadState(fixture.r0)).toBe(24);
    expect(runtime.storage.loadState(fixture.pc)).toBe(0);
    expect(fixture.calls.count).toBe(3);
  });

  it('tracks only the units a block actually read, including HALT in a shared unit', () => {
    const fixture = toyModule();
    const validation = policy(fixture.module, [{ ref: fixture.firmware, access: 'update' }]);
    const runtime = createIRInterpreter(fixture.module, { validation });
    runtime.storage.storeState(fixture.pc, 6);
    runStep(runtime, fixture.step, 0);
    expect(runtime.storage.loadState(fixture.stopped)).toBe(true);
    expect(fixture.calls.count).toBe(1);
    // HALT lives at bytes 6..7, unit 0. Updating unit 1 leaves it valid.
    runtime.storage.updateBytesFromBytes(fixture.firmware, 8, new Uint8Array([0x10]));
    runStep(runtime, fixture.step, 1);
    expect(fixture.calls.count).toBe(1);
    // Updating unit 0 invalidates B6 conservatively.
    runtime.storage.updateBytesFromBytes(fixture.firmware, 6, new Uint8Array([0x00]));
    runStep(runtime, fixture.step, 2);
    expect(fixture.calls.count).toBe(2);
  });

  it('uses the same artifact for a key while runtime args still vary', () => {
    const calls = { count: 0 };
    const module = createIRModule();
    const store = module.state('store', 'u32', 0);
    const run = module.entry('run', ['u32', 'u32']);
    const code = module.provider(
      'code',
      { keyTypes: ['u32'], params: ['u32'], results: [], reads: [], imports: [store] },
      (gen, [key]) => {
        calls.count += 1;
        return gen.function((b, [arg]) => {
          b.state.store(store, b.int.add(arg, b.const('u32', key)));
          b.return([]);
        });
      },
    );
    run.body((b, [key, arg]) => b.dispatch(code, [key], [arg]));
    const runtime = createIRInterpreter(module, { validation: policy(module) });
    runtime.execute(run, [7, 10], context);
    expect(runtime.storage.loadState(store)).toBe(17);
    runtime.execute(run, [7, 20], context);
    expect(runtime.storage.loadState(store)).toBe(27);
    expect(calls.count).toBe(1);
  });

  it('returns generated results to the caller of a dispatching function', () => {
    const module = createIRModule();
    const store = module.state('store', 'u32', 0);
    const translate = module.func('translate', { params: ['u32'], results: ['u32'] });
    const run = module.entry('run', ['u32']);
    const code = module.provider(
      'code',
      { keyTypes: ['u32'], params: ['u32'], results: ['u32'], reads: [], imports: [] },
      (gen, [key]) =>
        gen.function((b, [value]) => {
          b.return([b.int.add(value, b.const('u32', key))]);
        }),
    );
    translate.body((b, [value]) => b.dispatch(code, [b.const('u32', 5)], [value]));
    run.body((b, [value]) => {
      const [result] = b.call(translate, [value]);
      b.state.store(store, result);
      b.return([]);
    });
    const runtime = createIRInterpreter(module, { validation: policy(module) });
    runtime.execute(run, [10], context);
    expect(runtime.storage.loadState(store)).toBe(15);
  });

  it('supports nested dispatch to another imported provider', () => {
    const module = createIRModule();
    const store = module.state('store', 'u32', 0);
    const doubler = module.provider(
      'double',
      { keyTypes: ['u32'], params: [], results: ['u32'], reads: [], imports: [] },
      (gen, [key]) => gen.function((b) => b.return([b.const('u32', key * 2)])),
    );
    const outer = module.provider(
      'outer',
      { keyTypes: [], params: [], results: ['u32'], reads: [], imports: [doubler] },
      (gen) => gen.function((b) => b.dispatch(doubler, [b.const('u32', 21)], [])),
    );
    const translate = module.func('translate', { params: [], results: ['u32'] });
    translate.body((b) => b.dispatch(outer, [], []));
    const run = module.entry('run', []);
    run.body((b) => {
      const [result] = b.call(translate, []);
      b.state.store(store, result);
      b.return([]);
    });
    const runtime = createIRInterpreter(module, { validation: policy(module) });
    runtime.execute(run, [], context);
    expect(runtime.storage.loadState(store)).toBe(42);
  });

  it('charges the generated artifact against the same entry step budget', () => {
    const fixture = toyModule();
    const runtime = createIRInterpreter(fixture.module, {
      validation: policy(fixture.module),
      maxSteps: 3,
    });
    expect(failure(() => runtime.execute(fixture.step, [], context)).code).toBe('budget-exhausted');
  });

  it('keeps instance caches and storage independent', () => {
    const fixture = toyModule();
    const first = createIRInterpreter(fixture.module, { validation: policy(fixture.module) });
    const second = createIRInterpreter(fixture.module, { validation: policy(fixture.module) });
    first.execute(fixture.step, [], context);
    expect(fixture.calls.count).toBe(1);
    first.execute(fixture.step, [], context);
    expect(fixture.calls.count).toBe(2);
    second.execute(fixture.step, [], context);
    expect(fixture.calls.count).toBe(3);
    expect(first.storage.loadState(fixture.r0)).toBe(7);
    expect(second.storage.loadState(fixture.r0)).toBe(3);
  });

  it('does not replay committed effects on a cache hit', () => {
    const calls = { count: 0 };
    const module = createIRModule();
    const source = module.state('source', 'u32', 7);
    const counter = module.state('counter', 'u32', 0);
    const run = module.entry('run', []);
    const code = module.provider(
      'code',
      { keyTypes: [], params: [], results: [], reads: [source], imports: [counter] },
      (gen) => {
        calls.count += 1;
        const value = gen.readState(source);
        return gen.function((b) => {
          const next = b.int.add(b.state.load(counter), b.const('u32', value));
          b.state.store(counter, next);
          b.return([]);
        });
      },
    );
    run.body((b) => b.dispatch(code, [], []));
    const runtime = createIRInterpreter(module, { validation: policy(module) });
    runtime.execute(run, [], context);
    runtime.execute(run, [], context);
    expect(calls.count).toBe(1);
    // Generation has no object-side effect; each execution commits exactly one increment.
    expect(runtime.storage.loadState(counter)).toBe(14);
  });

  it('invalidates on an equal-value scalar store and regenerates with new contents', () => {
    const calls = { count: 0 };
    const module = createIRModule();
    const source = module.state('source', 'u32', 7);
    const counter = module.state('counter', 'u32', 0);
    const run = module.entry('run', []);
    const code = module.provider(
      'code',
      { keyTypes: [], params: [], results: [], reads: [source], imports: [counter] },
      (gen) => {
        calls.count += 1;
        const value = gen.readState(source);
        return gen.function((b) => {
          b.state.store(counter, b.int.add(b.state.load(counter), b.const('u32', value)));
          b.return([]);
        });
      },
    );
    run.body((b) => b.dispatch(code, [], []));
    const runtime = createIRInterpreter(module, { validation: policy(module) });
    runtime.execute(run, [], context);
    expect(calls.count).toBe(1);
    runtime.storage.storeState(source, 7);
    runtime.execute(run, [], context);
    expect(calls.count).toBe(2);
    runtime.storage.storeState(source, 8);
    runtime.execute(run, [], context);
    expect(calls.count).toBe(3);
    expect(runtime.storage.loadState(counter)).toBe(22);
  });

  it('tracks arrays as one whole-resource unit', () => {
    const calls = { count: 0 };
    const module = createIRModule();
    const words = module.array('words', 'u32', [1, 2, 3, 4]);
    const out = module.state('out', 'u32', 0);
    const run = module.entry('run', []);
    const code = module.provider(
      'code',
      { keyTypes: [], params: [], results: [], reads: [words], imports: [out] },
      (gen) => {
        calls.count += 1;
        const value = gen.readArray(words, 0);
        return gen.function((b) => {
          b.state.store(out, b.const('u32', value));
          b.return([]);
        });
      },
    );
    run.body((b) => b.dispatch(code, [], []));
    const runtime = createIRInterpreter(module, { validation: policy(module) });
    runtime.execute(run, [], context);
    expect(runtime.storage.loadState(out)).toBe(1);
    runtime.storage.storeArray(words, 3, 9);
    runtime.execute(run, [], context);
    expect(calls.count).toBe(2);
  });

  it('tracks host inbox admission', () => {
    const calls = { count: 0 };
    const module = createIRModule();
    const inbox = module.inbox('input', 4);
    const out = module.state('out', 'u32', 0);
    const run = module.entry('run', []);
    const code = module.provider(
      'code',
      { keyTypes: [], params: [], results: [], reads: [inbox], imports: [out] },
      (gen) => {
        calls.count += 1;
        const bytes = gen.readBytes(inbox, 0, 1);
        return gen.function((b) => {
          b.state.store(out, b.const('u32', bytes[0]!));
          b.return([]);
        });
      },
    );
    run.body((b) => b.dispatch(code, [], []));
    const runtime = createIRInterpreter(module, { validation: policy(module) });
    runtime.execute(run, [], context);
    expect(runtime.storage.loadState(out)).toBe(0);
    runtime.storage.writeInbox(inbox, 0, new Uint8Array([9]));
    runtime.execute(run, [], context);
    expect(calls.count).toBe(2);
    expect(runtime.storage.loadState(out)).toBe(9);
  });

  it('normalizes float keys by canonical bits', () => {
    const calls = { count: 0 };
    const module = createIRModule();
    const run = module.entry('run', ['f32']);
    const keyed = module.provider(
      'keyed',
      { keyTypes: ['f32'], params: [], results: [], reads: [], imports: [] },
      (gen) => {
        calls.count += 1;
        return gen.function((b) => b.return([]));
      },
    );
    run.body((b, [key]) => b.dispatch(keyed, [key], []));
    const runtime = createIRInterpreter(module, { validation: policy(module) });
    runtime.execute(run, [f32('0x00000000')], context);
    expect(calls.count).toBe(1);
    runtime.execute(run, [f32('0x00000000')], context);
    expect(calls.count).toBe(1);
    // -0 is a distinct key from +0.
    runtime.execute(run, [f32('0x80000000')], context);
    expect(calls.count).toBe(2);
    // Every f32 NaN canonicalizes to one identity.
    runtime.execute(run, [f32('0x7fc00001')], context);
    runtime.execute(run, [f32('0xffc00000')], context);
    expect(calls.count).toBe(3);
  });

  it('normalizes f64 non-finite keys and separates integer and bool key components', () => {
    const calls = { count: 0 };
    const module = createIRModule();
    const run = module.entry('run', ['f64', 'u32', 'bool']);
    const keyed = module.provider(
      'keyed',
      { keyTypes: ['f64', 'u32', 'bool'], params: [], results: [], reads: [], imports: [] },
      (gen) => {
        calls.count += 1;
        return gen.function((b) => b.return([]));
      },
    );
    run.body((b, [number, index, flag]) => b.dispatch(keyed, [number, index, flag], []));
    const runtime = createIRInterpreter(module, { validation: policy(module) });
    runtime.execute(run, [f64('0x7ff0000000000000'), 1, true], context);
    expect(calls.count).toBe(1);
    runtime.execute(run, [f64('0x7ff0000000000000'), 1, true], context);
    expect(calls.count).toBe(1);
    runtime.execute(run, [f64('0xfff0000000000000'), 1, true], context);
    expect(calls.count).toBe(2);
    runtime.execute(run, [f64('0x7ff8000000000001'), 1, true], context);
    runtime.execute(run, [f64('0x7ff8000000000002'), 1, true], context);
    expect(calls.count).toBe(3);
    runtime.execute(run, [f64('0x7ff8000000000001'), 2, true], context);
    expect(calls.count).toBe(4);
    runtime.execute(run, [f64('0x7ff8000000000001'), 2, false], context);
    expect(calls.count).toBe(5);
  });

  it('rejects a generation-time declaration without touching the module', () => {
    const module = createIRModule();
    const run = module.entry('run', []);
    const code = module.provider(
      'code',
      { keyTypes: [], params: [], results: [], reads: [], imports: [] },
      (gen) => {
        module.state('dynamic', 'u32', 0);
        return gen.function((b) => b.return([]));
      },
    );
    run.body((b) => b.dispatch(code, [], []));
    const runtime = createIRInterpreter(module, { validation: policy(module) });
    const error = failure(() => runtime.execute(run, [], context));
    expect(error.code).toBe('provider-failed');
    const cause = error.cause as IRProviderError;
    expect(cause).toBeInstanceOf(IRProviderError);
    expect(cause.code).toBe('illegal-operation');
    expect(module.memories.map((memory) => memory.name)).toEqual([]);
  });

  it('rejects storage writes during generation and stays faulted', () => {
    const module = createIRModule();
    const state = module.state('state', 'u32', 1);
    const run = module.entry('run', []);
    const code = module.provider(
      'code',
      { keyTypes: [], params: [], results: [], reads: [state], imports: [] },
      (gen) => {
        gen.readState(state);
        runtime.storage.storeState(state, 5);
        return gen.function((b) => b.return([]));
      },
    );
    run.body((b) => b.dispatch(code, [], []));
    const runtime = createIRInterpreter(module, { validation: policy(module) });
    const error = failure(() => runtime.execute(run, [], context));
    expect(error.code).toBe('provider-failed');
    expect((error.cause as IRProviderError).code).toBe('illegal-operation');
    expect(runtime.storage.loadState(state)).toBe(1);
    expect(failure(() => runtime.execute(run, [], context)).code).toBe('instance-faulted');
  });

  it('rejects a second artifact and a missing artifact', () => {
    const module = createIRModule();
    const run = module.entry('run', []);
    const twice = module.provider(
      'twice',
      { keyTypes: [], params: [], results: [], reads: [], imports: [] },
      (gen) => {
        const handle = gen.function((b) => b.return([]));
        gen.function((b) => b.return([]));
        return handle;
      },
    );
    run.body((b) => b.dispatch(twice, [], []));
    const twiceRuntime = createIRInterpreter(module, { validation: policy(module) });
    const twiceError = failure(() => twiceRuntime.execute(run, [], context));
    expect((twiceError.cause as IRProviderError).code).toBe('illegal-operation');

    const missingModule = createIRModule();
    const missingRun = missingModule.entry('run', []);
    const missing = missingModule.provider(
      'missing',
      { keyTypes: [], params: [], results: [], reads: [], imports: [] },
      () => undefined as never,
    );
    missingRun.body((b) => b.dispatch(missing, [], []));
    const missingRuntime = createIRInterpreter(missingModule, {
      validation: policy(missingModule),
    });
    const missingError = failure(() => missingRuntime.execute(missingRun, [], context));
    expect((missingError.cause as IRProviderError).code).toBe('generation-failed');
  });

  it('reports an invalid artifact with the existing validator', () => {
    const calls = { count: 0 };
    const module = createIRModule();
    const helper = module.func('helper', { params: [], results: [] });
    helper.body((b) => b.return([]));
    const run = module.entry('run', []);
    const code = module.provider(
      'code',
      { keyTypes: [], params: [], results: [], reads: [], imports: [] },
      (gen) => {
        calls.count += 1;
        return gen.function((b) => {
          b.call(helper, []);
          b.return([]);
        });
      },
    );
    run.body((b) => b.dispatch(code, [], []));
    const runtime = createIRInterpreter(module, { validation: policy(module) });
    const error = failure(() => runtime.execute(run, [], context));
    expect(error.code).toBe('provider-failed');
    const cause = error.cause as IRProviderError;
    expect(cause.code).toBe('import-violation');
    expect(cause.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'provider-import-violation' }),
    );
    expect(error.diagnostics).toBe(cause.diagnostics);
    expect(calls.count).toBe(1);
  });

  it('rejects artifacts that write a generated-read resource directly or through a call', () => {
    const direct = createIRModule();
    const state = direct.state('state', 'u32', 0);
    const directRun = direct.entry('run', []);
    const directProvider = direct.provider(
      'direct',
      { keyTypes: [], params: [], results: [], reads: [state], imports: [state] },
      (gen) => {
        gen.readState(state);
        return gen.function((b) => {
          b.state.store(state, b.const('u32', 1));
          b.return([]);
        });
      },
    );
    directRun.body((b) => b.dispatch(directProvider, [], []));
    const directRuntime = createIRInterpreter(direct, { validation: policy(direct) });
    const directError = failure(() => directRuntime.execute(directRun, [], context));
    expect((directError.cause as IRProviderError).code).toBe('invalid-artifact');
    expect((directError.cause as IRProviderError).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unsupported-provider' }),
    );

    const indirect = createIRModule();
    const tracked = indirect.state('tracked', 'u32', 0);
    const writer = indirect.func('writer', { params: [], results: [] });
    writer.body((b) => {
      b.state.store(tracked, b.const('u32', 2));
      b.return([]);
    });
    const indirectRun = indirect.entry('run', []);
    const indirectProvider = indirect.provider(
      'indirect',
      { keyTypes: [], params: [], results: [], reads: [tracked], imports: [tracked, writer] },
      (gen) => {
        gen.readState(tracked);
        return gen.function((b) => {
          b.call(writer, []);
          b.return([]);
        });
      },
    );
    indirectRun.body((b) => b.dispatch(indirectProvider, [], []));
    const indirectRuntime = createIRInterpreter(indirect, { validation: policy(indirect) });
    const indirectError = failure(() => indirectRuntime.execute(indirectRun, [], context));
    expect((indirectError.cause as IRProviderError).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unsupported-provider' }),
    );
  });

  it('rejects generated bridge instructions when the host hook is missing', () => {
    const module = createIRModule();
    const output = module.output('out', { params: [], capacity: 1 });
    const run = module.entry('run', []);
    const code = module.provider(
      'code',
      { keyTypes: [], params: [], results: [], reads: [], imports: [output] },
      (gen) =>
        gen.function((b) => {
          b.output(output, []);
          b.return([]);
        }),
    );
    run.body((b) => b.dispatch(code, [], []));
    const runtime = createIRInterpreter(module, { validation: policy(module) });
    const error = failure(() => runtime.execute(run, [], context));
    expect((error.cause as IRProviderError).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unsupported-instruction' }),
    );
  });

  it('does not cache an artifact after a failed generation', () => {
    const calls = { count: 0 };
    const module = createIRModule();
    const run = module.entry('run', []);
    const code = module.provider(
      'code',
      { keyTypes: [], params: [], results: [], reads: [], imports: [] },
      (gen) => {
        calls.count += 1;
        if (calls.count === 1) throw new Error('boom');
        return gen.function((b) => b.return([]));
      },
    );
    run.body((b) => b.dispatch(code, [], []));
    const runtime = createIRInterpreter(module, { validation: policy(module) });
    const error = failure(() => runtime.execute(run, [], context));
    expect((error.cause as IRProviderError).code).toBe('generation-failed');
    // The interpreter faults, so a fresh instance retries generation instead of reusing a result.
    const retry = createIRInterpreter(module, { validation: policy(module) });
    retry.execute(run, [], context);
    expect(calls.count).toBe(2);
  });
});

describe('provider key and read contract at runtime', () => {
  it('rejects unauthorized and out-of-range tracked reads', () => {
    const module = createIRModule();
    const firmware = module.bytes('firmware', new Uint8Array([1, 2]), {
      readonly: true,
      unitBytes: 1,
    });
    const other = module.state('other', 'u32', 0);
    const run = module.entry('run', ['u32']);
    const bad = module.provider(
      'bad',
      { keyTypes: ['u32'], params: [], results: [], reads: [firmware], imports: [] },
      (gen, [mode]) => {
        if (mode === 0) gen.readBytes(firmware, 0, 4);
        if (mode === 1) gen.readState(other);
        if (mode === 2) gen.readBytes(firmware, 0.5, 1);
        if (mode === 3) gen.readArray(other as never, 0);
        return gen.function((b) => b.return([]));
      },
    );
    run.body((b, [mode]) => b.dispatch(bad, [mode], []));
    const codes: string[] = [];
    for (const mode of [0, 1, 2, 3]) {
      const runtime = createIRInterpreter(module, { validation: policy(module) });
      const error = failure(() => runtime.execute(run, [mode], context));
      codes.push((error.cause as IRProviderError).code);
    }
    expect(codes).toEqual([
      'invalid-read',
      'unauthorized-read',
      'invalid-read',
      'unauthorized-read',
    ]);
  });

  it('returns an independent copy from readBytes', () => {
    const module = createIRModule();
    const firmware = module.bytes('firmware', new Uint8Array([7, 8]), {
      readonly: true,
      unitBytes: 1,
    });
    const out = module.state('out', 'u32', 0);
    const run = module.entry('run', []);
    const code = module.provider(
      'code',
      { keyTypes: [], params: [], results: [], reads: [firmware], imports: [out] },
      (gen) => {
        const bytes = gen.readBytes(firmware, 0, 2);
        bytes[0] = 99;
        return gen.function((b) => {
          b.state.store(out, b.const('u32', bytes[0]!));
          b.return([]);
        });
      },
    );
    run.body((b) => b.dispatch(code, [], []));
    const runtime = createIRInterpreter(module, { validation: policy(module) });
    runtime.execute(run, [], context);
    expect(runtime.storage.loadState(out)).toBe(99);
    expect(runtime.storage.loadBytes('u8', 'little', firmware, 0)).toBe(7);
  });

  it('normalizes f32 readState values to JS numbers', () => {
    const module = createIRModule();
    const value = module.state('value', 'f32', 1.5);
    const run = module.entry('run', []);
    let seen: unknown;
    const code = module.provider(
      'code',
      { keyTypes: [], params: [], results: [], reads: [value], imports: [] },
      (gen) => {
        seen = gen.readState(value);
        return gen.function((b) => b.return([]));
      },
    );
    run.body((b) => b.dispatch(code, [], []));
    const runtime = createIRInterpreter(module, { validation: policy(module) });
    runtime.execute(run, [], context);
    expect(seen).toBe(1.5);
    expect(typeof seen).toBe('number');
  });

  it('rejects a mismatched dispatch key at build time', () => {
    const module = createIRModule();
    const run = module.entry('run', []);
    const keyed = module.provider(
      'keyed',
      { keyTypes: ['u32'], params: [], results: [], reads: [], imports: [] },
      (gen) => gen.function((b) => b.return([])),
    );
    expect(() => {
      run.body((b) => {
        const key = b.const('bool', true) as unknown as Value<'u32'>;
        b.dispatch(keyed, [key], []);
      });
    }).toThrow(/dispatch key/);
  });
});
