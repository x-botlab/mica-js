import { describe, expect, it } from 'vitest';
import { CORE_INSTRUCTION_NAMES } from './builder';
import {
  createIRInterpreter,
  createIRModule,
  IRConstructionError,
  IRExecutionError,
  IRStorageError,
  validateIR,
  type BytesRef,
  type FunctionBuilder,
  type IRModule,
  type IRResourcePermission,
  type IRValidationOptions,
  type Value,
} from './index';

const context = { instanceId: 'device-47', virtualTime: 1234 };

function policy(module: IRModule, updates: readonly BytesRef[] = []): IRValidationOptions {
  return {
    supportedInstructions: CORE_INSTRUCTION_NAMES,
    authorizedInstructions: CORE_INSTRUCTION_NAMES,
    resources: [
      ...module.memories.map((memory): IRResourcePermission => ({
        ref: memory.ref,
        access: memory.writable ? 'read-write' : 'read',
      })),
      ...updates.map((ref): IRResourcePermission => ({ ref, access: 'update' })),
    ],
  };
}

function fixture(readonly: boolean = true) {
  const module = createIRModule();
  const destination = module.bytes('destination', new Uint8Array(9).fill(255), {
    readonly,
    unitBytes: 4,
  });
  const source = module.bytes('source', new Uint8Array([11, 22, 33, 44, 55, 66, 77, 88, 99]), {
    readonly: true,
    unitBytes: 3,
  });
  const update = module.func('update', { params: ['u32', 'u32', 'u32'], results: [] });
  update.body((b, [dstOffset, srcOffset, length]) => {
    b.resource.updateBytes(destination, dstOffset, source, srcOffset, length);
    b.return([]);
  });
  const fill = module.func('fill', { params: ['u32', 'u32', 'u8'], results: [] });
  fill.body((b, [offset, length, value]) => {
    b.resource.fillBytes(destination, offset, length, value);
    b.return([]);
  });
  const validation = policy(module, [destination]);
  const runtime = () => {
    expect(validateIR(module, validation)).toEqual({ ok: true, diagnostics: [] });
    return createIRInterpreter(module, { validation });
  };
  return { module, destination, source, update, fill, validation, runtime };
}

function instruction(module: IRModule, op: string) {
  return module.functions
    .flatMap((fn) => fn.body!.blocks.flatMap((block) => block.instructions))
    .find((node) => node.op === op)!;
}

function failure(run: () => unknown): IRExecutionError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(IRExecutionError);
  return caught as IRExecutionError;
}

describe('versioned resource builder and validation', () => {
  it.each([true, false])(
    'executes independently authorized readonly=%s byte updates and fills',
    (readonly) => {
      const f = fixture(readonly);
      const runtime = f.runtime();
      const before = runtime.storage.readVersionedBytes(f.destination, 0, 9);
      const sourceBefore = runtime.storage.readVersionedBytes(f.source, 0, 9);
      expect(runtime.execute(f.update, [2, 0, 4], context)).toEqual({ values: [], steps: 2 });
      const copied = runtime.storage.readVersionedBytes(f.destination, 0, 9);
      expect([...copied.bytes]).toEqual([255, 255, 11, 22, 33, 44, 255, 255, 255]);
      expect(copied.dependencies).toHaveLength(3);
      expect(copied.dependencies[0]!.version).not.toBe(before.dependencies[0]!.version);
      expect(copied.dependencies[1]!.version).not.toBe(before.dependencies[1]!.version);
      expect(copied.dependencies[2]).toBe(before.dependencies[2]);
      expect(runtime.storage.validateDependencies(before.dependencies)).toBe(false);
      expect(runtime.storage.validateDependencies(sourceBefore.dependencies)).toBe(true);
      expect(runtime.execute(f.fill, [4, 4, 255], context)).toEqual({ values: [], steps: 2 });
      const filled = runtime.storage.readVersionedBytes(f.destination, 0, 9);
      expect([...filled.bytes]).toEqual([255, 255, 11, 22, 255, 255, 255, 255, 255]);
      expect(filled.dependencies[0]).toBe(copied.dependencies[0]);
      expect(filled.dependencies[1]!.version).not.toBe(copied.dependencies[1]!.version);
      expect(filled.dependencies[2]).toBe(copied.dependencies[2]);
      expect(context.virtualTime).toBe(1234);
      expect(f.module.instructions).toEqual([]);
    },
  );

  it.each([true, false])('does not grant updates from ordinary access, readonly=%s', (readonly) => {
    const f = fixture(readonly);
    const validation = policy(f.module);
    expect(
      validateIR(f.module, validation).diagnostics.filter(
        (d) => d.code === 'unauthorized-resource',
      ),
    ).toHaveLength(2);
    expect(failure(() => createIRInterpreter(f.module, { validation })).code).toBe(
      'validation-failed',
    );
  });

  it('requires readable source authorization separately from destination update', () => {
    const f = fixture();
    const validation = {
      ...f.validation,
      resources: [{ ref: f.destination, access: 'update' as const }],
    };
    const result = validateIR(f.module, validation);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'unauthorized-resource',
        message: expect.stringContaining('read access'),
      }),
    );
  });

  it('does not grant normal reading or writing from update authorization', () => {
    const module = createIRModule();
    const ram = module.bytes('ram', new Uint8Array(4), { readonly: false });
    module.func('run', { params: [], results: [] }).body((b) => {
      const offset = b.const('u32', 0);
      b.bytes.store('u8', 'little', ram, offset, b.const('u8', 1));
      b.bytes.load('u8', 'little', ram, offset);
      b.return([]);
    });
    const result = validateIR(module, {
      ...policy(module),
      resources: [{ ref: ram, access: 'update' }],
    });
    expect(result.diagnostics.filter((d) => d.code === 'unauthorized-resource')).toHaveLength(2);
  });

  it.each(['supportedInstructions', 'authorizedInstructions'] as const)(
    'enforces operation policy %s',
    (field) => {
      const f = fixture();
      const validation = {
        ...f.validation,
        [field]: CORE_INSTRUCTION_NAMES.filter((op) => op !== 'resource.fill_bytes'),
      };
      expect(validateIR(f.module, validation).diagnostics).toContainEqual(
        expect.objectContaining({
          code:
            field === 'supportedInstructions'
              ? 'unsupported-instruction'
              : 'unauthorized-instruction',
        }),
      );
    },
  );

  it.each(['resource.update_bytes', 'resource.fill_bytes'])(
    'reserves the implemented core name %s against domain replacement',
    (op) => {
      const f = fixture();
      expect(() => f.module.domainInstruction(op, { operands: [], results: [] })).toThrow(
        IRConstructionError,
      );
      expect(
        validateIR(f.module, { ...f.validation, validators: [{ op, validate: () => [] }] })
          .diagnostics,
      ).toContainEqual(expect.objectContaining({ code: 'unsupported-instruction' }));
    },
  );

  it('accepts inbox only as a readable source and preserves its version', () => {
    const module = createIRModule();
    const inbox = module.inbox('inbox', 4);
    const rom = module.bytes('rom', new Uint8Array([1, 2, 3, 4]), { readonly: true, unitBytes: 2 });
    const run = module.func('run', { params: [], results: [] });
    run.body((b) => {
      b.resource.updateBytes(rom, b.const('u32', 0), inbox, b.const('u32', 0), b.const('u32', 4));
      b.return([]);
    });
    const validation = policy(module, [rom]);
    expect(validateIR(module, validation).ok).toBe(true);
    const runtime = createIRInterpreter(module, { validation });
    const before = runtime.storage.readVersionedBytes(inbox, 0, 4);
    runtime.execute(run, [], context);
    expect([...runtime.storage.readVersionedBytes(rom, 0, 4).bytes]).toEqual([0, 0, 0, 0]);
    expect(runtime.storage.validateDependencies(before.dependencies)).toBe(true);
    Object.assign(instruction(module, 'resource.update_bytes').operands[0]!, { ref: inbox });
    expect(validateIR(module, validation).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'invalid-static-reference' }),
    );
    expect(
      validateIR(module, { ...validation, resources: [{ ref: inbox, access: 'update' }] })
        .diagnostics,
    ).toContainEqual(expect.objectContaining({ code: 'invalid-resource' }));
  });

  it.each(['destination', 'source'] as const)(
    'rejects a scalar in the %s slot even in forged IR',
    (slot) => {
      const f = fixture();
      const state = f.module.state('state', 'u32', 0);
      Object.assign(
        instruction(f.module, 'resource.update_bytes').operands[slot === 'destination' ? 0 : 2]!,
        { ref: state },
      );
      expect(validateIR(f.module, f.validation).diagnostics).toContainEqual(
        expect.objectContaining({ code: 'invalid-static-reference' }),
      );
    },
  );

  it.each([
    ['resource.update_bytes', 1],
    ['resource.update_bytes', 3],
    ['resource.update_bytes', 4],
    ['resource.fill_bytes', 1],
    ['resource.fill_bytes', 2],
    ['resource.fill_bytes', 3],
  ] as const)('checks scalar type of %s operand %i in forged IR', (op, index) => {
    const f = fixture();
    const node = instruction(f.module, op);
    Object.assign(node, {
      operands: node.operands.map((operand, i) =>
        i === index && operand.kind === 'ssa'
          ? { kind: 'ssa', value: { ...operand.value, type: 'bool' } }
          : operand,
      ),
    });
    expect(validateIR(f.module, f.validation).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'type-mismatch' }),
    );
  });

  it.each(['resource.update_bytes', 'resource.fill_bytes'])(
    'requires exact layout and empty results for %s',
    (op) => {
      const f = fixture();
      const node = instruction(f.module, op);
      const original = node.operands;
      Object.assign(node, { operands: original.slice(1) });
      expect(validateIR(f.module, f.validation).diagnostics).toContainEqual(
        expect.objectContaining({ code: 'signature-mismatch' }),
      );
      Object.assign(node, { operands: original, results: [{ id: 100, type: 'u32' }] });
      expect(validateIR(f.module, f.validation).diagnostics).toContainEqual(
        expect.objectContaining({ code: 'signature-mismatch' }),
      );
    },
  );

  it('checks builder reference categories, nominal module ownership and value types', () => {
    const module = createIRModule();
    const bytes = module.bytes('bytes', new Uint8Array(4), { readonly: true });
    const inbox = module.inbox('inbox', 4);
    const scalar = module.state('scalar', 'u8', 0);
    const foreign = createIRModule().bytes('foreign', new Uint8Array(4), { readonly: false });
    const attempts: ((b: FunctionBuilder, zero: Value<'u32'>) => unknown)[] = [
      (b, z) => b.resource.fillBytes(inbox as unknown as BytesRef, z, z, b.const('u8', 0)),
      (b, z) => b.resource.updateBytes(bytes, z, scalar as unknown as BytesRef, z, z),
      (b, z) => b.resource.fillBytes(foreign, z, z, b.const('u8', 0)),
      (b, z) => b.resource.fillBytes(bytes, z, z, b.const('u32', 0) as unknown as Value<'u8'>),
      (b, z) =>
        b.resource.updateBytes(bytes, b.const('u8', 0) as unknown as Value<'u32'>, bytes, z, z),
    ];
    attempts.forEach((attempt, i) => {
      const fn = module.func(`invalid${i}`, { params: [], results: [] });
      expect(() =>
        fn.body((b) => {
          attempt(b, b.const('u32', 0));
          b.return([]);
        }),
      ).toThrow(IRConstructionError);
    });
  });
});

describe('versioned resource interpreter integration', () => {
  it.each([
    [9, 9],
    [0, 9],
    [9, 0],
  ])('checks zero-length endpoints %s/%s without changing versions', (dst, src) => {
    const f = fixture();
    const runtime = f.runtime();
    const before = runtime.storage.readVersionedBytes(f.destination, 0, 9);
    runtime.execute(f.update, [dst, src, 0], context);
    runtime.execute(f.fill, [9, 0, 255], context);
    expect(runtime.storage.readVersionedBytes(f.destination, 0, 9)).toEqual(before);
    expect(runtime.storage.validateDependencies(before.dependencies)).toBe(true);
  });

  it.each([
    [10, 0, 0],
    [0, 10, 0],
    [8, 0, 2],
    [0, 8, 2],
    [1, 1, 0xffffffff],
  ])('does not partially commit failed update %s/%s/%s', (dst, src, length) => {
    const f = fixture();
    const runtime = f.runtime();
    const before = runtime.storage.readVersionedBytes(f.destination, 0, 9);
    const error = failure(() => runtime.execute(f.update, [dst, src, length], context));
    expect(error).toMatchObject({
      code: 'storage-failed',
      steps: 1,
      location: { functionName: 'update', instructionIndex: 0 },
      context,
    });
    expect(error.cause).toBeInstanceOf(IRStorageError);
    expect(error.cause).toMatchObject({ code: 'out-of-bounds' });
    expect(runtime.storage.readVersionedBytes(f.destination, 0, 9)).toEqual(before);
    expect(runtime.storage.validateDependencies(before.dependencies)).toBe(true);
    expect(failure(() => runtime.execute(f.update, [0, 0, 1], context)).code).toBe(
      'instance-faulted',
    );
  });

  it('preserves earlier scalar and resource commits across nested-call storage failure', () => {
    const f = fixture();
    const state = f.module.state('counter', 'u32', 0);
    const run = f.module.entry('run', []);
    run.body((b) => {
      b.state.store(state, b.const('u32', 17));
      b.call(f.fill, [b.const('u32', 0), b.const('u32', 2), b.const('u8', 7)]);
      b.call(f.update, [b.const('u32', 8), b.const('u32', 0), b.const('u32', 2)]);
      b.return([]);
    });
    const runtime = createIRInterpreter(f.module, {
      validation: policy(f.module, [f.destination]),
    });
    const before = runtime.storage.readVersionedBytes(f.destination, 0, 9);
    const error = failure(() => runtime.execute(run, [], context));
    expect(error.code).toBe('storage-failed');
    expect(error.callStack.map((frame) => frame.functionName)).toEqual(['run', 'update']);
    expect(runtime.storage.loadState(state)).toBe(17);
    const after = runtime.storage.readVersionedBytes(f.destination, 0, 9);
    expect([...after.bytes]).toEqual([7, 7, 255, 255, 255, 255, 255, 255, 255]);
    expect(runtime.storage.validateDependencies([before.dependencies[0]!])).toBe(false);
    expect(runtime.storage.validateDependencies(before.dependencies.slice(1))).toBe(true);
  });

  it.each([
    [0, 1, [2, 3, 4, 5, 5]],
    [1, 0, [1, 1, 2, 3, 4]],
  ] as const)('uses overlap snapshot %s <- %s', (dst, src, expected) => {
    const module = createIRModule();
    const bytes = module.bytes('bytes', new Uint8Array([1, 2, 3, 4, 5]), {
      readonly: true,
      unitBytes: 2,
    });
    const run = module.func('run', { params: [], results: [] });
    run.body((b) => {
      b.resource.updateBytes(
        bytes,
        b.const('u32', dst),
        bytes,
        b.const('u32', src),
        b.const('u32', 4),
      );
      b.return([]);
    });
    const validation = policy(module, [bytes]);
    expect(validateIR(module, validation).ok).toBe(true);
    const runtime = createIRInterpreter(module, { validation });
    runtime.execute(run, [], context);
    expect([...runtime.storage.readVersionedBytes(bytes, 0, 5).bytes]).toEqual(expected);
  });

  it('isolates resource versions by interpreter storage, not context display id', () => {
    const f = fixture();
    const first = f.runtime();
    const second = f.runtime();
    const a = first.storage.readVersionedBytes(f.destination, 0, 9);
    const b = second.storage.readVersionedBytes(f.destination, 0, 9);
    expect(a.dependencies[0]!.resource).not.toBe(b.dependencies[0]!.resource);
    expect(first.storage.validateDependencies(b.dependencies)).toBe(false);
    first.execute(f.fill, [0, 9, 42], context);
    expect(second.storage.readVersionedBytes(f.destination, 0, 9)).toEqual(b);
    expect(second.storage.validateDependencies(b.dependencies)).toBe(true);
  });

  it('captures policy and graph against later external mutation', () => {
    const f = fixture();
    const resources = [...f.validation.resources];
    const runtime = createIRInterpreter(f.module, { validation: { ...f.validation, resources } });
    resources.splice(0);
    Object.assign(instruction(f.module, 'resource.fill_bytes'), { op: 'resource.invalid' });
    expect(runtime.execute(f.fill, [0, 1, 3], context)).toEqual({ values: [], steps: 2 });
    expect(runtime.storage.loadBytes('u8', 'little', f.destination, 0)).toBe(3);
  });

  it.each([true, false])(
    'captures update grants before trusted validation callbacks (granted=%s)',
    (granted) => {
      const module = createIRModule();
      const bytes = module.bytes('bytes', new Uint8Array(2), { readonly: true });
      const extension = module.domainInstruction('test.validate', { operands: [], results: [] });
      module.func('run', { params: [], results: [] }).body((b) => {
        b.invoke(extension, []);
        b.return([]);
      });
      const resources: IRResourcePermission[] = granted ? [{ ref: bytes, access: 'update' }] : [];
      const receivers: unknown[] = [];
      let observed: readonly IRResourcePermission[] = [];
      const validator = {
        op: 'test.validate',
        validate(context: { readonly resources: readonly IRResourcePermission[] }) {
          receivers.push(this);
          observed = context.resources;
          resources.splice(
            0,
            resources.length,
            ...(granted ? [] : [{ ref: bytes, access: 'update' as const }]),
          );
          return [];
        },
      };
      // An extension is statically valid but deliberately not executable; capture
      // policy through a temporary unused module instruction is still checked.
      const validation = {
        ...policy(module),
        resources,
        supportedInstructions: [...CORE_INSTRUCTION_NAMES, 'test.validate'],
        authorizedInstructions: [...CORE_INSTRUCTION_NAMES, 'test.validate'],
        validators: [validator],
      };
      expect(failure(() => createIRInterpreter(module, { validation })).code).toBe(
        'unsupported-instruction',
      );
      expect(receivers).toEqual([validator]);
      expect(observed.some((permission) => permission.access === 'update')).toBe(granted);
      expect(Object.isFrozen(observed)).toBe(true);
    },
  );

  it('charges exactly one budget step per update and preserves previous effects on exhaustion', () => {
    const module = createIRModule();
    const bytes = module.bytes('bytes', new Uint8Array(2), { readonly: true, unitBytes: 1 });
    const run = module.func('run', { params: ['u32', 'u32', 'u8'], results: [] });
    run.body((b, [offset, length, value]) => {
      b.resource.fillBytes(bytes, offset, length, value);
      b.return([]);
    });
    const validation = policy(module, [bytes]);
    const runtime = createIRInterpreter(module, { validation, maxSteps: 1 });
    const before = runtime.storage.readVersionedBytes(bytes, 0, 2);
    expect(failure(() => runtime.execute(run, [0, 1, 8], context))).toMatchObject({
      code: 'budget-exhausted',
      steps: 1,
      location: { terminator: true },
    });
    const after = runtime.storage.readVersionedBytes(bytes, 0, 2);
    expect([...after.bytes]).toEqual([8, 0]);
    expect(after.dependencies[0]!.version).not.toBe(before.dependencies[0]!.version);
    expect(after.dependencies[1]).toBe(before.dependencies[1]);
  });
});
