import { describe, expect, it } from 'vitest';
import { CORE_INSTRUCTION_NAMES } from './builder';
import {
  createIRInterpreter,
  createIRModule,
  IRExecutionError,
  IRProviderError,
  validateIR,
  type EntryRef,
  type IRExecutionContext,
  type IRModule,
  type IRResourcePermission,
  type IRValidationOptions,
  type ProviderRef,
  type RuntimeScalar,
  type Value,
} from './index';

const context = { instanceId: 'mcu-61', virtualTime: 0 };

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

interface RecoveryFixtureOptions {
  readonly updateOffset?: number;
  readonly nested?: boolean;
  readonly hosts?: boolean;
}

function recoveryFixture(options: RecoveryFixtureOptions = {}) {
  const updateOffset = options.updateOffset ?? 0;
  const calls = { generated: 0 };
  const module = createIRModule();
  const firmware = module.bytes('firmware', new Uint8Array([1, 2, 3, 4]), {
    readonly: true,
    unitBytes: 2,
  });
  const patch = module.bytes('patch', new Uint8Array([9]), { readonly: true });
  const pc = module.state('pc', 'u32', 0);
  const result = module.state('result', 'u32', 0);
  const patches = module.state('patches', 'u32', 0);
  const later = module.entry('later', ['u32']);
  later.body((b, [value]) => {
    b.state.store(result, value);
    b.return([]);
  });
  const update = module.func('update', { params: [], results: [] });
  update.body((b) => {
    const offset = b.const('u32', updateOffset);
    const zero = b.const('u32', 0);
    const one = b.const('u32', 1);
    b.resource.updateBytes(firmware, offset, patch, zero, one);
    b.state.store(patches, b.int.add(b.state.load(patches), one));
    b.return([]);
  });
  const out = module.output('out', { params: ['u32'], capacity: 4 });
  const code: ProviderRef<readonly ['u32'], readonly [], readonly []> = module.provider(
    'code',
    {
      keyTypes: ['u32'],
      params: [],
      results: [],
      reads: [firmware],
      imports: [pc, result, patches, update, later, out],
    },
    (gen, [address]) => {
      calls.generated += 1;
      const value = gen.readBytes(firmware, address, 1)[0]!;
      return gen.function((b) => {
        if (address !== 0) {
          b.state.store(result, b.const('u32', 2000 + value));
          b.state.store(pc, b.const('u32', 2));
          b.return([]);
          return;
        }
        // Recovery key/state values are computed before the invalidating call.
        const nextPc = b.const('u32', 2);
        if (options.nested === true) {
          const next = b.block([]);
          b.jump(next, []);
          b.at(next, (inner) => {
            if (options.hosts !== false) {
              inner.output(out, [inner.const('u32', 7)]);
              inner.event.at(later, inner.const('f64', 5), [inner.const('u32', 9)]);
            }
            inner.call(update, []);
            inner.state.store(pc, nextPc);
            inner.checkpoint(code, [nextPc], []);
            inner.state.store(result, inner.const('u32', 1000 + value));
            inner.return([]);
          });
          return;
        }
        if (options.hosts !== false) {
          b.output(out, [b.const('u32', 7)]);
          b.event.at(later, b.const('f64', 5), [b.const('u32', 9)]);
        }
        b.call(update, []);
        b.state.store(pc, nextPc);
        b.checkpoint(code, [nextPc], []);
        b.state.store(result, b.const('u32', 1000 + value));
        b.return([]);
      });
    },
  );
  const run = module.entry('run', []);
  run.body((b) => b.dispatch(code, [b.state.load(pc)], []));
  return {
    module,
    firmware,
    patch,
    pc,
    result,
    patches,
    later,
    out,
    update,
    code,
    run,
    calls,
  };
}

function recordingHosts() {
  const sends: { readonly payload: readonly (boolean | number)[]; readonly timePs: number }[] = [];
  const events: { readonly deadline: number; readonly args: readonly RuntimeScalar[] }[] = [];
  return {
    sends,
    events,
    eventHost: {
      now: () => 5,
      at: (_target: EntryRef, deadline: number, args: readonly RuntimeScalar[]) => {
        events.push({ deadline, args });
        return 1;
      },
      cancel: () => undefined,
    },
    bridge: {
      send: (_output: unknown, payload: readonly (boolean | number)[], timePs: number) => {
        sends.push({ payload, timePs });
        return true;
      },
      sendBytes: () => true,
    },
  };
}

describe('provider checkpoint and runtime invalidation recovery', () => {
  it('recovers through a checkpoint after a helper updates a depended-on unit', () => {
    const fixture = recoveryFixture();
    const validation = policy(fixture.module, [{ ref: fixture.firmware, access: 'update' }]);
    expect(validateIR(fixture.module, validation)).toEqual({ ok: true, diagnostics: [] });
    const hosts = recordingHosts();
    const times: number[] = [];
    const runtime = createIRInterpreter(fixture.module, {
      validation,
      eventHost: hosts.eventHost,
      bridge: hosts.bridge,
      stepObserver: {
        beforeStep: (execution: IRExecutionContext) => {
          times.push(execution.virtualTime);
        },
      },
    });

    runtime.execute(fixture.run, [], context);

    // The helper effect commits once; the old artifact's post-checkpoint step never runs.
    expect(runtime.storage.loadState(fixture.patches)).toBe(1);
    expect(fixture.calls.generated).toBe(2);
    expect(runtime.storage.loadBytes('u8', 'little', fixture.firmware, 0)).toBe(9);
    expect(runtime.storage.loadState(fixture.pc)).toBe(2);
    expect(runtime.storage.loadState(fixture.result)).toBe(2003);
    // Outputs and events before the checkpoint are preserved exactly once.
    expect(hosts.sends).toEqual([{ payload: [7], timePs: 0 }]);
    expect(hosts.events).toEqual([{ deadline: 5, args: [9] }]);
    expect(times.every((time) => time === 0)).toBe(true);

    // Re-entering the regenerated key uses the cache and does not replay the helper.
    runtime.execute(fixture.run, [], context);
    expect(fixture.calls.generated).toBe(2);
    expect(runtime.storage.loadState(fixture.patches)).toBe(1);
    expect(runtime.storage.loadState(fixture.result)).toBe(2003);
  });

  it('continues the old artifact when the update touches an unrelated unit', () => {
    const fixture = recoveryFixture({ updateOffset: 2 });
    const validation = policy(fixture.module, [{ ref: fixture.firmware, access: 'update' }]);
    const hosts = recordingHosts();
    const runtime = createIRInterpreter(fixture.module, {
      validation,
      eventHost: hosts.eventHost,
      bridge: hosts.bridge,
    });

    runtime.execute(fixture.run, [], context);

    expect(runtime.storage.loadState(fixture.patches)).toBe(1);
    expect(fixture.calls.generated).toBe(1);
    expect(runtime.storage.loadBytes('u8', 'little', fixture.firmware, 2)).toBe(9);
    expect(runtime.storage.loadState(fixture.pc)).toBe(2);
    expect(runtime.storage.loadState(fixture.result)).toBe(1001);
    expect(hosts.sends).toHaveLength(1);
    expect(hosts.events).toHaveLength(1);

    runtime.execute(fixture.run, [], context);
    expect(fixture.calls.generated).toBe(2);
    expect(runtime.storage.loadState(fixture.result)).toBe(2009);
  });

  it('supports a checkpoint inside a nested block', () => {
    const fixture = recoveryFixture({ nested: true });
    const validation = policy(fixture.module, [{ ref: fixture.firmware, access: 'update' }]);
    const hosts = recordingHosts();
    const runtime = createIRInterpreter(fixture.module, {
      validation,
      eventHost: hosts.eventHost,
      bridge: hosts.bridge,
    });

    runtime.execute(fixture.run, [], context);

    expect(runtime.storage.loadState(fixture.patches)).toBe(1);
    expect(fixture.calls.generated).toBe(2);
    expect(runtime.storage.loadState(fixture.pc)).toBe(2);
    expect(runtime.storage.loadState(fixture.result)).toBe(2003);
    expect(hosts.sends).toHaveLength(1);
    expect(hosts.events).toHaveLength(1);
  });

  it('recovers with target parameters and returns the result through the caller chain', () => {
    const module = createIRModule();
    const source = module.state('source', 'u32', 0);
    const out = module.state('out', 'u32', 0);
    const update = module.func('update', { params: [], results: [] });
    update.body((b) => {
      b.state.store(source, b.const('u32', 1));
      b.return([]);
    });
    const translate: ProviderRef<readonly ['u32'], readonly ['u32'], readonly ['u32']> =
      module.provider(
        'translate',
        {
          keyTypes: ['u32'],
          params: ['u32'],
          results: ['u32'],
          reads: [source],
          imports: [update],
        },
        (gen, [key]) => {
          const value = gen.readState(source);
          return gen.function((b, [arg]) => {
            if (key === 0) {
              const next = b.const('u32', 1);
              b.call(update, []);
              b.checkpoint(translate, [next], [arg]);
              b.return([b.int.add(arg, b.const('u32', 1000 + value))]);
              return;
            }
            b.return([b.int.add(arg, b.const('u32', 2000 + value))]);
          });
        },
      );
    const wrapper = module.func('wrapper', { params: ['u32'], results: ['u32'] });
    wrapper.body((b, [arg]) => b.dispatch(translate, [b.const('u32', 0)], [arg]));
    const run = module.entry('run', []);
    run.body((b) => {
      const [value] = b.call(wrapper, [b.const('u32', 5)]);
      b.state.store(out, value);
      b.return([]);
    });

    const runtime = createIRInterpreter(module, { validation: policy(module) });
    runtime.execute(run, [], context);

    // The recovered artifact sees the committed source value and the captured argument.
    expect(runtime.storage.loadState(source)).toBe(1);
    expect(runtime.storage.loadState(out)).toBe(2006);
  });

  it('rejects a pure step between an invalidating update and its checkpoint', () => {
    const module = createIRModule();
    const firmware = module.bytes('firmware', new Uint8Array([1, 2]), {
      readonly: true,
      unitBytes: 1,
    });
    const patch = module.bytes('patch', new Uint8Array([9]), { readonly: true });
    const pc = module.state('pc', 'u32', 0);
    const result = module.state('result', 'u32', 0);
    const update = module.func('update', { params: [], results: [] });
    update.body((b) => {
      b.resource.updateBytes(
        firmware,
        b.const('u32', 0),
        patch,
        b.const('u32', 0),
        b.const('u32', 1),
      );
      b.return([]);
    });
    const code: ProviderRef<readonly ['u32'], readonly [], readonly []> = module.provider(
      'code',
      {
        keyTypes: ['u32'],
        params: [],
        results: [],
        reads: [firmware],
        imports: [pc, result, update],
      },
      (gen) => {
        gen.readBytes(firmware, 0, 1);
        return gen.function((b) => {
          const nextPc = b.const('u32', 1);
          const one = b.const('u32', 1);
          const two = b.const('u32', 2);
          b.call(update, []);
          b.state.store(pc, nextPc);
          const pure = b.int.add(one, two);
          b.checkpoint(code, [nextPc], []);
          b.state.store(result, pure);
          b.return([]);
        });
      },
    );
    const run = module.entry('run', []);
    run.body((b) => b.dispatch(code, [b.state.load(pc)], []));
    const validation = policy(module, [{ ref: firmware, access: 'update' }]);
    const runtime = createIRInterpreter(module, { validation });

    const error = failure(() => runtime.execute(run, [], context));
    expect(error.code).toBe('provider-failed');
    const cause = error.cause as IRProviderError;
    expect(cause.code).toBe('invalid-artifact');
    expect(cause.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unsupported-provider' }),
    );
    // Artifact validation happens before execution, so no effect was committed.
    expect(runtime.storage.loadBytes('u8', 'little', firmware, 0)).toBe(1);
    expect(runtime.storage.loadState(result)).toBe(0);
  });

  it('rejects a checkpoint target that is not imported', () => {
    const module = createIRModule();
    const target = module.provider(
      'target',
      { keyTypes: [], params: [], results: [], reads: [], imports: [] },
      (gen) => gen.function((b) => b.return([])),
    );
    const code = module.provider(
      'code',
      { keyTypes: [], params: [], results: [], reads: [], imports: [] },
      (gen) =>
        gen.function((b) => {
          b.checkpoint(target, [], []);
          b.return([]);
        }),
    );
    const run = module.entry('run', []);
    run.body((b) => b.dispatch(code, [], []));
    const runtime = createIRInterpreter(module, { validation: policy(module) });

    const error = failure(() => runtime.execute(run, [], context));
    expect(error.code).toBe('provider-failed');
    const cause = error.cause as IRProviderError;
    expect(cause.code).toBe('import-violation');
    expect(cause.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'provider-import-violation' }),
    );
  });

  it('reports an illegal checkpoint key during generation', () => {
    const module = createIRModule();
    const target = module.provider(
      'target',
      { keyTypes: ['u32'], params: ['u32'], results: [], reads: [], imports: [] },
      (gen) => gen.function((b) => b.return([])),
    );
    const code = module.provider(
      'code',
      { keyTypes: [], params: [], results: [], reads: [], imports: [target] },
      (gen) =>
        gen.function((b) => {
          const wrong = b.const('bool', true) as unknown as Value<'u32'>;
          b.checkpoint(target, [wrong], [b.const('u32', 1)]);
          b.return([]);
        }),
    );
    const run = module.entry('run', []);
    run.body((b) => b.dispatch(code, [], []));
    const runtime = createIRInterpreter(module, { validation: policy(module) });

    const error = failure(() => runtime.execute(run, [], context));
    const cause = error.cause as IRProviderError;
    expect(cause.code).toBe('generation-failed');
    expect(cause.message).toMatch(/checkpoint key/);
  });

  it('rejects a checkpoint operand that does not dominate the checkpoint', () => {
    const module = createIRModule();
    const condition = module.state('condition', 'bool', true);
    const target = module.provider(
      'target',
      { keyTypes: ['u32'], params: [], results: [], reads: [], imports: [] },
      (gen) => gen.function((b) => b.return([])),
    );
    const code = module.provider(
      'code',
      { keyTypes: [], params: [], results: [], reads: [], imports: [condition, target] },
      (gen) =>
        gen.function((b) => {
          let fromYes: Value<'u32'> | undefined;
          const yes = b.block([]);
          const no = b.block([]);
          b.at(yes, (inner) => {
            fromYes = inner.const('u32', 1);
            inner.jump(no, []);
          });
          b.at(no, (inner) => {
            inner.checkpoint(target, [fromYes!], []);
            inner.return([]);
          });
          b.branch(b.state.load(condition), { target: yes, args: [] }, { target: no, args: [] });
        }),
    );
    const run = module.entry('run', []);
    run.body((b) => b.dispatch(code, [], []));
    const runtime = createIRInterpreter(module, { validation: policy(module) });

    const error = failure(() => runtime.execute(run, [], context));
    const cause = error.cause as IRProviderError;
    expect(cause.code).toBe('invalid-artifact');
    expect(cause.diagnostics).toContainEqual(expect.objectContaining({ code: 'ssa-dominance' }));
  });

  it('rejects a checkpoint target declared by another module', () => {
    const first = createIRModule();
    const second = createIRModule();
    const foreign = first.provider(
      'foreign',
      { keyTypes: [], params: [], results: [], reads: [], imports: [] },
      (gen) => gen.function((b) => b.return([])),
    );
    const code = second.provider(
      'code',
      { keyTypes: [], params: [], results: [], reads: [], imports: [] },
      (gen) =>
        gen.function((b) => {
          b.checkpoint(foreign, [], []);
          b.return([]);
        }),
    );
    const run = second.entry('run', []);
    run.body((b) => b.dispatch(code, [], []));
    const runtime = createIRInterpreter(second, { validation: policy(second) });

    const error = failure(() => runtime.execute(run, [], context));
    const cause = error.cause as IRProviderError;
    expect(cause.code).toBe('generation-failed');
    expect(cause.message).toMatch(/another module|declared by this module/);
  });

  it('reports an incompatible checkpoint result layout during generation', () => {
    const module = createIRModule();
    const target = module.provider(
      'target',
      { keyTypes: [], params: [], results: ['u32'], reads: [], imports: [] },
      (gen) => gen.function((b) => b.return([b.const('u32', 1)])),
    );
    const code = module.provider(
      'code',
      { keyTypes: [], params: [], results: [], reads: [], imports: [target] },
      (gen) =>
        gen.function((b) => {
          const compatible = target as unknown as ProviderRef<
            readonly [],
            readonly [],
            readonly []
          >;
          b.checkpoint(compatible, [], []);
          b.return([]);
        }),
    );
    const run = module.entry('run', []);
    run.body((b) => b.dispatch(code, [], []));
    const runtime = createIRInterpreter(module, { validation: policy(module) });

    const error = failure(() => runtime.execute(run, [], context));
    const cause = error.cause as IRProviderError;
    expect(cause.code).toBe('generation-failed');
    expect(cause.message).toMatch(/checkpoint target returns/);
  });

  it('keeps recovery inside the current entry step budget', () => {
    const module = createIRModule();
    const firmware = module.bytes('firmware', new Uint8Array([1, 2]), {
      readonly: true,
      unitBytes: 1,
    });
    const patch = module.bytes('patch', new Uint8Array([9]), { readonly: true });
    const pc = module.state('pc', 'u32', 0);
    const result = module.state('result', 'u32', 0);
    let generated = 0;
    const code: ProviderRef<readonly ['u32'], readonly [], readonly []> = module.provider(
      'code',
      {
        keyTypes: ['u32'],
        params: [],
        results: [],
        reads: [firmware],
        imports: [firmware, pc, result, patch],
      },
      (gen, [address]) => {
        generated += 1;
        const value = gen.readBytes(firmware, address, 1)[0]!;
        return gen.function((b) => {
          if (address !== 0) {
            b.state.store(result, b.const('u32', 2000 + value));
            b.state.store(pc, b.const('u32', 1));
            b.return([]);
            return;
          }
          const zero = b.const('u32', 0);
          const one = b.const('u32', 1);
          const nextPc = b.const('u32', 1);
          b.resource.updateBytes(firmware, zero, patch, zero, one);
          b.state.store(pc, nextPc);
          b.checkpoint(code, [nextPc], []);
          b.state.store(result, b.const('u32', 1000 + value));
          b.return([]);
        });
      },
    );
    const run = module.entry('run', []);
    run.body((b) => b.dispatch(code, [b.state.load(pc)], []));
    const validation = policy(module, [{ ref: firmware, access: 'update' }]);
    const runtime = createIRInterpreter(module, { validation, maxSteps: 8 });

    const error = failure(() => runtime.execute(run, [], context));
    expect(error.code).toBe('budget-exhausted');
    // Key load, dispatch, three recovery constants, the atomic update, the recovery-PC store,
    // and the checkpoint consume the budget; the recovered artifact has not started.
    expect(generated).toBe(2);
    expect(runtime.storage.loadBytes('u8', 'little', firmware, 0)).toBe(9);
    expect(runtime.storage.loadState(pc)).toBe(1);
    expect(runtime.storage.loadState(result)).toBe(0);
  });

  it('keeps caches and storage independent across instances during recovery', () => {
    const fixture = recoveryFixture({ hosts: false });
    const validation = policy(fixture.module, [{ ref: fixture.firmware, access: 'update' }]);
    const first = createIRInterpreter(fixture.module, { validation });
    const second = createIRInterpreter(fixture.module, { validation });

    first.execute(fixture.run, [], context);
    expect(fixture.calls.generated).toBe(2);
    expect(first.storage.loadState(fixture.result)).toBe(2003);

    second.execute(fixture.run, [], context);
    expect(fixture.calls.generated).toBe(4);
    expect(second.storage.loadState(fixture.result)).toBe(2003);

    first.execute(fixture.run, [], context);
    expect(fixture.calls.generated).toBe(4);

    first.storage.updateBytesFromBytes(fixture.firmware, 0, new Uint8Array([5]));
    expect(second.storage.loadBytes('u8', 'little', fixture.firmware, 0)).toBe(9);
  });
});
