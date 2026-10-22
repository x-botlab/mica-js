import { describe, expect, it, vi } from 'vitest';
import { CORE_INSTRUCTION_NAMES } from './builder';
import {
  createIRInterpreter,
  createIRModule,
  IRConstructionError,
  IRExecutionError,
  validateIR,
  type IRBuilderExtension,
  type IRInstructionExecutor,
  type IRModule,
  type IRValidationOptions,
  type Value,
} from './index';

const context = { instanceId: 'domains', virtualTime: 0 };

function domainPolicy(module: IRModule, ...ops: readonly string[]): IRValidationOptions {
  const names = [...CORE_INSTRUCTION_NAMES, ...ops];
  return {
    supportedInstructions: names,
    authorizedInstructions: names,
    resources: [
      ...module.memories.map(({ ref }) => ({ ref, access: 'read-write' as const })),
      ...module.domainDeclarations.map(({ ref }) => ({ ref, access: 'read-write' as const })),
    ],
    validators: ops.map((op) => ({ op, validate: () => [] })),
  };
}

function executionFailure(action: () => unknown, code = 'evaluation-failed'): IRExecutionError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(IRExecutionError);
    expect((error as IRExecutionError).code).toBe(code);
    return error as IRExecutionError;
  }
  throw new Error('Expected IRExecutionError');
}

interface PinNamespace {
  sample(): Value<'u32'>;
  probe(): Value<'u32'>;
}

function namespace(builder: unknown): PinNamespace {
  return (builder as { readonly pin: PinNamespace }).pin;
}

describe('IR builder extensions', () => {
  it('adds the namespace to ordinary and nested block builders', () => {
    let created = 0;
    const extension: IRBuilderExtension = {
      namespace: 'pin',
      create(builder) {
        created += 1;
        return { probe: () => builder.const('u32', 7) };
      },
    };
    const module = createIRModule({ builderExtensions: [extension] });
    module.entry('run', []).body((b) => {
      const first = namespace(b).probe();
      expect(first.type).toBe('u32');
      const nested = b.block([]);
      b.jump(nested, []);
      b.at(nested, (inner) => {
        const second = namespace(inner).probe();
        expect(second.type).toBe('u32');
        inner.return([]);
      });
      return undefined;
    });
    expect(created).toBe(2);
  });

  it('lets an extension declare its instructions lazily when a builder is created', () => {
    const moduleRef: { current?: IRModule } = {};
    const extension: IRBuilderExtension = {
      namespace: 'pin',
      create(builder) {
        const declaration = moduleRef.current!.domainDeclaration('pin', 'P');
        const sample = moduleRef.current!.domainInstruction('pin.sample', {
          operands: [{ kind: 'static', category: 'pin' }],
          results: ['u32'],
        });
        return { sample: () => builder.invoke(sample, [declaration])[0] };
      },
    };
    const created = createIRModule({ builderExtensions: [extension] });
    moduleRef.current = created;
    const fn = created.func('run', { params: [], results: ['u32'] });
    fn.body((b) => b.return([namespace(b).sample()]));
    const validation = validateIR(created, domainPolicy(created, 'pin.sample'));
    expect(validation.diagnostics).toEqual([]);
  });

  it.each([
    ['a reserved namespace', { namespace: 'state', create: () => ({}) }],
    ['an empty namespace', { namespace: '', create: () => ({}) }],
    ['a duplicate namespace', { namespace: 'pin', create: () => ({}) }],
  ])('rejects %s', (label, first) => {
    const extensions =
      label === 'a duplicate namespace'
        ? [first, { namespace: 'pin', create: () => ({}) }]
        : [first];
    expect(() =>
      createIRModule({
        builderExtensions: extensions as unknown as readonly IRBuilderExtension[],
      }),
    ).toThrow(IRConstructionError);
  });

  it('rejects invalid extension member results', () => {
    const module = createIRModule({
      builderExtensions: [{ namespace: 'pin', create: () => ({ write: 1 }) }],
    });
    expect(() => module.entry('run', []).body((b) => b.return([]))).toThrow(IRConstructionError);
  });
});

function executorFixture(): {
  readonly module: IRModule;
  readonly executor: IRInstructionExecutor;
  readonly spy: ReturnType<typeof vi.fn>;
} {
  const module = createIRModule();
  const led = module.domainDeclaration('led', 'status');
  const set = module.domainInstruction('led.set', {
    operands: [
      { kind: 'static', category: 'led' },
      { kind: 'value', type: 'bool' },
    ],
    results: [],
  });
  const read = module.domainInstruction('led.read', {
    operands: [{ kind: 'static', category: 'led' }],
    results: ['u32'],
  });
  module.func('run', { params: ['bool'], results: ['u32'] }).body((b, [on]) => {
    b.invoke(set, [led, on]);
    return b.return([b.invoke(read, [led])[0]!]);
  });
  const execute = vi.fn((execution: Parameters<IRInstructionExecutor['execute']>[0]) =>
    execution.instruction.op === 'led.read' ? [41] : [],
  );
  return { module, executor: { op: 'led.set', execute }, spy: execute };
}

describe('IR instruction executors', () => {
  it('executes declared domain instructions with a trusted synchronous executor', () => {
    const { module, executor, spy } = executorFixture();
    const read = vi.fn((context: Parameters<IRInstructionExecutor['execute']>[0]) => {
      void context;
      return [42];
    });
    const runtime = createIRInterpreter(module, {
      validation: domainPolicy(module, 'led.set', 'led.read'),
      instructionExecutors: [executor, { op: 'led.read', execute: read }],
    });
    const result = runtime.execute(module.functions[0]!.ref, [true], context);
    expect(result.values).toEqual([42]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    const call = read.mock.calls[0]![0] as Parameters<IRInstructionExecutor['execute']>[0];
    expect(call.fn.name).toBe('run');
    expect(call.instruction.op).toBe('led.read');
    expect(call.location).toMatchObject({ functionName: 'run', instructionIndex: 1 });
    expect(call.execution).toEqual(context);
    expect(call.operands).toEqual([]);
    expect(call.module.instructions.map((item) => item.name)).toEqual(['led.set', 'led.read']);
  });

  it('passes captured SSA operands by value', () => {
    const { module, executor, spy } = executorFixture();
    const runtime = createIRInterpreter(module, {
      validation: domainPolicy(module, 'led.set', 'led.read'),
      instructionExecutors: [executor, { op: 'led.read', execute: () => [0] }],
    });
    runtime.execute(module.functions[0]!.ref, [true], context);
    const call = spy.mock.calls[0]![0] as Parameters<IRInstructionExecutor['execute']>[0];
    expect(call.operands).toEqual([true]);
  });

  it('rejects missing, duplicate, core, reserved, undeclared, and async executors', () => {
    const { module, executor } = executorFixture();
    const validation = domainPolicy(module, 'led.set', 'led.read');
    expect(() => createIRInterpreter(module, { validation })).toThrow(IRExecutionError);
    expect(() =>
      createIRInterpreter(module, {
        validation,
        instructionExecutors: [executor, executor],
      }),
    ).toThrow(IRExecutionError);
    expect(() =>
      createIRInterpreter(module, {
        validation,
        instructionExecutors: [{ op: 'int.add', execute: () => [] }],
      }),
    ).toThrow(IRExecutionError);
    expect(() =>
      createIRInterpreter(module, {
        validation,
        instructionExecutors: [{ op: 'dispatch.run', execute: () => [] }],
      }),
    ).toThrow(IRExecutionError);
    expect(() =>
      createIRInterpreter(module, {
        validation,
        instructionExecutors: [{ op: 'led.missing', execute: () => [] }],
      }),
    ).toThrow(IRExecutionError);
    expect(() =>
      createIRInterpreter(module, {
        validation,
        instructionExecutors: [
          {
            op: 'led.set',
            execute: (async () => []) as unknown as IRInstructionExecutor['execute'],
          },
        ],
      }),
    ).toThrow(IRExecutionError);
  });

  it('reserves the event namespace for core event instructions', () => {
    const module = createIRModule();
    expect(() => module.domainInstruction('event.foo', { operands: [], results: [] })).toThrow(
      IRConstructionError,
    );
    expect(() => module.domainInstruction('event', { operands: [], results: [] })).toThrow(
      IRConstructionError,
    );
    expect(() => module.domainInstruction('event.now', { operands: [], results: [] })).toThrow(
      IRConstructionError,
    );
  });

  it('rejects event namespace executors even for a hand-built module', () => {
    const module = createIRModule();
    module.entry('run', []).body((b) => b.return([]));
    const fake = {
      memories: module.memories,
      functions: module.functions,
      domainDeclarations: module.domainDeclarations,
      instructions: [{ name: 'event.foo', operands: [], results: [] }],
    } as unknown as IRModule;
    const names = [...CORE_INSTRUCTION_NAMES, 'event.foo'];
    const error = executionFailure(
      () =>
        createIRInterpreter(fake, {
          validation: {
            supportedInstructions: names,
            authorizedInstructions: names,
            resources: [],
            validators: [{ op: 'event.foo', validate: () => [] }],
          },
          instructionExecutors: [{ op: 'event.foo', execute: () => [] }],
          eventHost: { now: () => 0, at: () => 1, cancel: () => undefined },
        }),
      'invalid-options',
    );
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it('rejects result layout mismatches and faults after an executor error', () => {
    const { module, executor } = executorFixture();
    const validation = domainPolicy(module, 'led.set', 'led.read');
    const wrongCount = createIRInterpreter(module, {
      validation,
      instructionExecutors: [
        { op: 'led.set', execute: () => [1] },
        { op: 'led.read', execute: () => [42] },
      ],
    });
    const countError = executionFailure(() =>
      wrongCount.execute(module.functions[0]!.ref, [true], context),
    );
    expect(countError.message).toContain('expected 0');

    const wrongType = createIRInterpreter(module, {
      validation,
      instructionExecutors: [
        executor,
        {
          op: 'led.read',
          execute: (() => ['nope']) as unknown as IRInstructionExecutor['execute'],
        },
      ],
    });
    executionFailure(() => wrongType.execute(module.functions[0]!.ref, [true], context));

    const thrown = new Error('domain failed');
    const faulty = createIRInterpreter(module, {
      validation,
      instructionExecutors: [
        executor,
        {
          op: 'led.read',
          execute: () => {
            throw thrown;
          },
        },
      ],
    });
    const error = executionFailure(() => faulty.execute(module.functions[0]!.ref, [true], context));
    expect(error.cause).toBe(thrown);
    executionFailure(
      () => faulty.execute(module.functions[0]!.ref, [true], context),
      'instance-faulted',
    );
  });
});
