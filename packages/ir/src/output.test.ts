import { describe, expect, it } from 'vitest';
import { CORE_INSTRUCTION_NAMES } from './builder';
import {
  createIRInterpreter,
  createIRModule,
  IRConstructionError,
  IRExecutionError,
  validateIR,
  type IRBridgeHost,
  type IRModule,
  type IRValidationOptions,
} from './index';

const context = { instanceId: 'device-54', virtualTime: 1234 };

function policy(module: IRModule): IRValidationOptions {
  return {
    supportedInstructions: CORE_INSTRUCTION_NAMES,
    authorizedInstructions: CORE_INSTRUCTION_NAMES,
    resources: module.memories.map((memory) => ({
      ref: memory.ref,
      access: memory.writable ? 'read-write' : 'read',
    })),
  };
}

function expectConstructionError(run: () => unknown): IRConstructionError {
  let caught: unknown;
  try {
    run();
  } catch (cause) {
    caught = cause;
  }
  expect(caught).toBeInstanceOf(IRConstructionError);
  return caught as IRConstructionError;
}

function expectExecutionError(run: () => unknown, code: string): IRExecutionError {
  let caught: unknown;
  try {
    run();
  } catch (cause) {
    caught = cause;
  }
  expect(caught).toBeInstanceOf(IRExecutionError);
  const error = caught as IRExecutionError;
  expect(error.code).toBe(code);
  return error;
}

interface Call {
  readonly kind: 'scalar' | 'bytes';
  readonly output: unknown;
  readonly payload: readonly (boolean | number)[] | Uint8Array;
  readonly timePs: number;
}

function fixture(maxBytes: number = 4, capacity: number = 2) {
  const module = createIRModule();
  const region = module.bytes('region', new Uint8Array([1, 2, 3, 4]), { readonly: true });
  const inbox = module.inbox('inbox', 4);
  const scalarResult = module.state('scalarResult', 'bool', false);
  const bytesResult = module.state('bytesResult', 'bool', false);
  const scalar = module.output('scalar', { params: ['u32', 'f32'], capacity });
  const bytes = module.outputBytes('bytes', { maxBytes, capacity });
  const emit = module.entry('emit', ['u32']);
  emit.body((b, [value]) => {
    const ok = b.output(scalar, [value, b.const('f32', 1.5)]);
    b.state.store(scalarResult, ok);
    const bytesOk = b.outputBytes(bytes, region, b.const('u32', 1), b.const('u32', 2));
    b.state.store(bytesResult, bytesOk);
    b.return([]);
  });
  return { module, region, inbox, scalar, bytes, scalarResult, bytesResult, emit };
}

function host(calls: Call[], results: boolean[] = []): IRBridgeHost {
  return {
    send(output, payload, timePs) {
      calls.push({ kind: 'scalar', output, payload, timePs });
      return results.shift() ?? true;
    },
    sendBytes(output, bytes, timePs) {
      calls.push({ kind: 'bytes', output, payload: bytes, timePs });
      return results.shift() ?? true;
    },
  };
}

/** A host that returns exactly the given values, including non-boolean ones. */
function returning(calls: Call[], results: unknown[]): IRBridgeHost {
  return {
    send(output, payload, timePs) {
      calls.push({ kind: 'scalar', output, payload, timePs });
      return results.shift() as boolean;
    },
    sendBytes(output, bytes, timePs) {
      calls.push({ kind: 'bytes', output, payload: bytes, timePs });
      return results.shift() as boolean;
    },
  };
}

describe('IR scalar and byte output bridge', () => {
  it('declares outputs and lowers b.output / b.outputBytes to bridge instructions', () => {
    const { module, scalar, bytes, emit } = fixture();
    expect(module.outputs).toHaveLength(2);
    expect(module.outputs[0]).toMatchObject({
      kind: 'scalar-output',
      name: 'scalar',
      params: ['u32', 'f32'],
      capacity: 2,
    });
    expect(module.outputs[1]).toMatchObject({
      kind: 'bytes-output',
      name: 'bytes',
      capacity: 2,
      maxBytes: 4,
    });
    expect(emit).toBeDefined();
    const nodes = module.functions[0]!.body!.entry.instructions;
    expect(nodes.map((node) => node.op)).toEqual([
      'const',
      'bridge.send',
      'state.store',
      'const',
      'const',
      'bridge.send_bytes',
      'state.store',
    ]);
    expect(nodes[1]!.operands[0]).toMatchObject({ kind: 'static', ref: scalar });
    expect(nodes[5]!.operands[0]).toMatchObject({ kind: 'static', ref: bytes });
    expect(validateIR(module, policy(module))).toEqual({ ok: true, diagnostics: [] });
  });

  it('captures scalar payload and virtual time at the bridge instruction', () => {
    const { module, scalarResult, bytesResult, emit } = fixture();
    const calls: Call[] = [];
    const validation = policy(module);
    const interpreter = createIRInterpreter(module, { validation, bridge: host(calls) });
    const result = interpreter.execute(emit, [7], context);
    expect(result.values).toEqual([]);
    expect(calls).toEqual([
      {
        kind: 'scalar',
        output: expect.anything(),
        payload: [7, 1.5],
        timePs: 1234,
      },
      {
        kind: 'bytes',
        output: expect.anything(),
        payload: new Uint8Array([2, 3]),
        timePs: 1234,
      },
    ]);
    expect(interpreter.storage.loadState(scalarResult)).toBe(true);
    expect(interpreter.storage.loadState(bytesResult)).toBe(true);
  });

  it('reports host queue rejection through the bool result without dropping captures', () => {
    const { module, scalarResult, bytesResult, emit } = fixture();
    const calls: Call[] = [];
    const interpreter = createIRInterpreter(module, {
      validation: policy(module),
      bridge: host(calls, [false, false]),
    });
    interpreter.execute(emit, [7], context);
    expect(calls).toHaveLength(2);
    expect(interpreter.storage.loadState(scalarResult)).toBe(false);
    expect(interpreter.storage.loadState(bytesResult)).toBe(false);
  });

  it('supports zero-length byte outputs and reads inbox regions', () => {
    const module = createIRModule();
    const inbox = module.inbox('inbox', 4);
    const output = module.outputBytes('bytes', { maxBytes: 4, capacity: 1 });
    const entry = module.entry('emit', ['u32', 'u32']);
    entry.body((b, [offset, length]) => {
      b.outputBytes(output, inbox, offset, length);
      b.return([]);
    });
    const calls: Call[] = [];
    const interpreter = createIRInterpreter(module, {
      validation: policy(module),
      bridge: host(calls),
    });
    interpreter.execute(entry, [0, 0], context);
    expect(calls[0]!.payload).toEqual(new Uint8Array(0));

    calls.length = 0;
    interpreter.execute(entry, [1, 2], context);
    expect(calls[0]!.payload).toEqual(new Uint8Array([0, 0]));
  });

  it('rejects an out-of-range byte read before touching the host', () => {
    const module = createIRModule();
    const region = module.bytes('region', new Uint8Array([1, 2]), { readonly: true });
    const output = module.outputBytes('bytes', { maxBytes: 4, capacity: 1 });
    const entry = module.entry('emit', ['u32', 'u32']);
    entry.body((b, [offset, length]) => {
      b.outputBytes(output, region, offset, length);
      b.return([]);
    });
    const calls: Call[] = [];
    const interpreter = createIRInterpreter(module, {
      validation: policy(module),
      bridge: host(calls),
    });
    expectExecutionError(() => interpreter.execute(entry, [1, 2], context), 'storage-failed');
    expect(calls).toHaveLength(0);
  });

  it('rejects maxBytes violations as model errors instead of returning false', () => {
    const module = createIRModule();
    const region = module.bytes('region', new Uint8Array([1, 2, 3]), { readonly: true });
    const output = module.outputBytes('bytes', { maxBytes: 2, capacity: 1 });
    const entry = module.entry('emit', []);
    entry.body((b) => {
      b.outputBytes(output, region, b.const('u32', 0), b.const('u32', 3));
      b.return([]);
    });
    const calls: Call[] = [];
    const interpreter = createIRInterpreter(module, {
      validation: policy(module),
      bridge: host(calls),
    });
    expectExecutionError(() => interpreter.execute(entry, [], context), 'evaluation-failed');
    expect(calls).toHaveLength(0);
  });

  it('requires a bridge host to execute bridge instructions', () => {
    const { module, emit } = fixture();
    expectExecutionError(
      () => createIRInterpreter(module, { validation: policy(module) }),
      'unsupported-instruction',
    );
    void emit;
  });

  it('rejects malformed declarations and output operands at build time', () => {
    const module = createIRModule();
    module.output('scalar', { params: ['u32'], capacity: 1 });
    expectConstructionError(() => module.output('scalar', { params: ['u32'], capacity: 1 }));
    expectConstructionError(() => module.output('empty', { params: [], capacity: 0 }));
    expectConstructionError(() => module.outputBytes('bytes', { maxBytes: -1, capacity: 1 }));

    const other = createIRModule();
    const foreign = other.output('foreign', { params: ['u32'], capacity: 1 });
    const ordinary = module.entry('emit', []);
    expectConstructionError(() =>
      ordinary.body((b) => {
        b.output(foreign, [b.const('u32', 1)]);
        b.return([]);
      }),
    );

    const wrongType = module.entry('wrongType', []);
    expectConstructionError(() =>
      wrongType.body((b) => {
        b.output(module.output('typed', { params: ['u32'], capacity: 1 }), [
          b.const('u8', 1) as never,
        ]);
        b.return([]);
      }),
    );

    const bytesOutput = module.outputBytes('typedBytes', { maxBytes: 2, capacity: 1 });
    const region = module.bytes('region', new Uint8Array([1]), { readonly: true });
    const wrongRegion = module.entry('wrongRegion', []);
    expectConstructionError(() =>
      wrongRegion.body((b) => {
        b.outputBytes(
          bytesOutput,
          module.state('state', 'u32', 0) as never,
          b.const('u32', 0),
          b.const('u32', 1),
        );
        b.return([]);
      }),
    );
    expect(region).toBeDefined();
  });

  it.each([1, undefined, 'true'])(
    'captures a non-boolean bridge.send result (%s) as evaluation-failed',
    (returned) => {
      const { module, emit } = fixture();
      const calls: Call[] = [];
      const interpreter = createIRInterpreter(module, {
        validation: policy(module),
        bridge: returning(calls, [returned]),
      });
      const failure = expectExecutionError(
        () => interpreter.execute(emit, [7], context),
        'evaluation-failed',
      );
      expect(failure.steps).toBe(2);
      expect(failure.location).toMatchObject({
        functionIndex: 0,
        functionName: 'emit',
        blockIndex: 0,
        blockId: module.functions[0]!.body!.entry.id,
        instructionIndex: 1,
      });
      expectExecutionError(() => interpreter.execute(emit, [7], context), 'instance-faulted');
    },
  );

  it.each([1, undefined, 'true'])(
    'captures a non-boolean bridge.send_bytes result (%s) as evaluation-failed',
    (returned) => {
      const { module, emit } = fixture();
      const calls: Call[] = [];
      const interpreter = createIRInterpreter(module, {
        validation: policy(module),
        bridge: returning(calls, [true, returned]),
      });
      const failure = expectExecutionError(
        () => interpreter.execute(emit, [7], context),
        'evaluation-failed',
      );
      expect(failure.steps).toBe(6);
      expect(failure.location).toMatchObject({
        functionIndex: 0,
        functionName: 'emit',
        blockIndex: 0,
        blockId: module.functions[0]!.body!.entry.id,
        instructionIndex: 5,
      });
    },
  );
});
