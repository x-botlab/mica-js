import { describe, expect, it } from 'vitest';
import { CORE_INSTRUCTION_NAMES } from './builder';
import { prepareEngine, type EngineSetup } from './engine-setup';
import { makeLocation, prepareExecution, wrapExecutionError } from './engine-host';
import { IRProviderError } from './errors';
import { IRExecutionError, createIRModule, IRStorageError } from './index';
import type { IRExecutionContext, IRDiagnostic } from './index';

const context: IRExecutionContext = { instanceId: 'engine-host', virtualTime: 1234 };

function fixture() {
  const module = createIRModule();
  const identity = module.func('identity', { params: ['u32'], results: ['u32'] });
  identity.body((b, [value]) => b.return([value]));
  const setup: EngineSetup = prepareEngine(module, {
    validation: {
      supportedInstructions: CORE_INSTRUCTION_NAMES,
      authorizedInstructions: CORE_INSTRUCTION_NAMES,
      resources: [],
    },
  });
  return { module, identity, setup };
}

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (cause) {
    return cause;
  }
  throw new Error('Expected the call to throw');
}

describe('prepareExecution', () => {
  it('returns the frozen context and captured arguments', () => {
    const { identity, setup } = fixture();
    const prepared = prepareExecution(setup, identity, [7], context);
    expect(prepared.fn).toBe(setup.functions.get(identity));
    expect(prepared.context).toEqual({ instanceId: 'engine-host', virtualTime: 1234 });
    expect(Object.isFrozen(prepared.context)).toBe(true);
    expect(prepared.inputs).toEqual([7]);
    expect(context).toEqual({ instanceId: 'engine-host', virtualTime: 1234 });
  });

  it('rejects a target that does not belong to the engine', () => {
    const { setup } = fixture();
    const other = createIRModule();
    const stranger = other.func('stranger', { params: [], results: [] });
    stranger.body((b) => b.return([]));
    const cause = caught(() => prepareExecution(setup, stranger, [], context));
    expect(cause).toBeInstanceOf(IRExecutionError);
    expect((cause as IRExecutionError).code).toBe('invalid-target');
    expect((cause as IRExecutionError).message).toBe('Target does not belong to this interpreter');
  });

  it.each([
    ['empty instance id', { instanceId: '', virtualTime: 0 }],
    ['negative time', { instanceId: 'engine-host', virtualTime: -1 }],
    ['fractional time', { instanceId: 'engine-host', virtualTime: 1.5 }],
  ])('rejects an invalid context (%s)', (_label, invalid) => {
    const { identity, setup } = fixture();
    const cause = caught(() => prepareExecution(setup, identity, [7], invalid as never));
    expect(cause).toBeInstanceOf(IRExecutionError);
    expect((cause as IRExecutionError).code).toBe('invalid-argument');
    expect((cause as IRExecutionError).message).toBe(
      'Expected instanceId and non-negative safe integer virtualTime',
    );
  });

  it.each([
    ['wrong arity', []],
    ['invalid scalar', ['seven']],
  ])('rejects invalid arguments (%s)', (_label, args) => {
    const { identity, setup } = fixture();
    const cause = caught(() => prepareExecution(setup, identity, args as never, context));
    expect(cause).toBeInstanceOf(IRExecutionError);
    const failure = cause as IRExecutionError;
    expect(failure.code).toBe('invalid-argument');
    expect(failure.message).toBe('Invalid execution arguments');
    expect(failure.context).toEqual({ instanceId: 'engine-host', virtualTime: 1234 });
    expect(failure.cause).toBeDefined();
  });
});

describe('wrapExecutionError', () => {
  it.each([
    ['interpreter codes', new IRExecutionError('trap', 'boom'), 'trap'],
    ['provider failures', new IRProviderError('generation-failed', 'boom'), 'provider-failed'],
    ['storage failures', new IRStorageError('out-of-bounds', 'boom'), 'storage-failed'],
    ['everything else', new Error('boom'), 'evaluation-failed'],
  ])('maps %s', (_label, cause, code) => {
    const wrapped = wrapExecutionError(cause, context, [], 7);
    expect(wrapped).toBeInstanceOf(IRExecutionError);
    expect(wrapped.code).toBe(code);
    expect(wrapped.message).toBe('boom');
    expect(wrapped.context).toBe(context);
    expect(wrapped.steps).toBe(7);
    expect(wrapped.cause).toBe(cause);
  });

  it('falls back to a generic message for non-Error causes', () => {
    const wrapped = wrapExecutionError('not an error', context, [], 0);
    expect(wrapped.code).toBe('evaluation-failed');
    expect(wrapped.message).toBe('IR execution failed');
    expect(wrapped.cause).toBe('not an error');
  });

  it('omits location when the call stack is empty', () => {
    const wrapped = wrapExecutionError(new Error('boom'), context, [], 3);
    expect(wrapped.location).toBeUndefined();
    expect(wrapped.callStack).toEqual([]);
    expect(wrapped.steps).toBe(3);
  });

  it('uses the innermost frozen location as the reported location', () => {
    const { module, identity } = fixture();
    const fn = module.functions[0]!;
    const block = fn.body!.entry;
    const outer = makeLocation(0, fn, 0, block, 0);
    const inner = makeLocation(1, fn, 1, block, undefined);
    const callStack = Object.freeze([outer, inner]);
    const wrapped = wrapExecutionError(new Error('boom'), context, callStack, 9);
    expect(wrapped.location).toBe(inner);
    expect(wrapped.callStack).toBe(callStack);
    void identity;
  });

  it('carries provider diagnostics only when they are present', () => {
    const diagnostic: IRDiagnostic = {
      code: 'malformed-input',
      message: 'bad artifact',
      location: { path: '$' },
    };
    const empty = wrapExecutionError(
      new IRProviderError('invalid-artifact', 'boom'),
      context,
      [],
      0,
    );
    expect(empty.diagnostics).toEqual([]);
    const detailed = wrapExecutionError(
      new IRProviderError('invalid-artifact', 'boom', { diagnostics: [diagnostic] }),
      context,
      [],
      0,
    );
    expect(detailed.diagnostics).toEqual([diagnostic]);
  });
});

describe('makeLocation', () => {
  it('freezes an instruction location with stable key order', () => {
    const { module } = fixture();
    const fn = module.functions[0]!;
    const block = fn.body!.entry;
    const location = makeLocation(3, fn, 2, block, 5);
    expect(Object.isFrozen(location)).toBe(true);
    expect(Object.keys(location)).toEqual([
      'functionIndex',
      'functionName',
      'blockIndex',
      'blockId',
      'instructionIndex',
    ]);
    expect(location).toEqual({
      functionIndex: 3,
      functionName: 'identity',
      blockIndex: 2,
      blockId: block.id,
      instructionIndex: 5,
    });
  });

  it('replaces instructionIndex with a frozen terminator marker', () => {
    const { module } = fixture();
    const fn = module.functions[0]!;
    const block = fn.body!.entry;
    const location = makeLocation(0, fn, 0, block, undefined);
    expect(Object.isFrozen(location)).toBe(true);
    expect(Object.keys(location)).toEqual([
      'functionIndex',
      'functionName',
      'blockIndex',
      'blockId',
      'terminator',
    ]);
    expect(location.terminator).toBe(true);
    expect('instructionIndex' in location).toBe(false);
  });
});
