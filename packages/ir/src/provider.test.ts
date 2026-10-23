import { describe, expect, it } from 'vitest';
import { CORE_INSTRUCTION_NAMES } from './builder';
import {
  createIRModule,
  validateIR,
  type FunctionDefinition,
  type IRModule,
  type IRValidationOptions,
  type ProviderDefinition,
  type Value,
} from './index';

function options(
  module: IRModule,
  changes: Partial<IRValidationOptions> = {},
): IRValidationOptions {
  return {
    supportedInstructions: CORE_INSTRUCTION_NAMES,
    authorizedInstructions: CORE_INSTRUCTION_NAMES,
    resources: module.memories.map((memory) => ({
      ref: memory.ref,
      access: memory.writable ? 'read-write' : 'read',
    })),
    ...changes,
  };
}

type Mutable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;

interface ProviderModel {
  memories: readonly import('./index').MemoryDefinition[];
  functions: readonly FunctionDefinition[];
  providers: readonly ProviderDefinition[];
  domainDeclarations: readonly import('./index').DomainDeclaration[];
  instructions: readonly import('./index').DeclaredInstruction[];
  outputs: readonly import('./index').OutputDefinition[];
}

function model(module: IRModule): Mutable<ProviderModel> {
  return {
    memories: [...module.memories],
    functions: [...module.functions] as Mutable<FunctionDefinition[]>,
    providers: module.providers.map((provider) => ({ ...provider })) as Mutable<
      ProviderDefinition[]
    >,
    domainDeclarations: [...module.domainDeclarations],
    instructions: [...module.instructions],
    outputs: [...module.outputs],
  } as Mutable<ProviderModel>;
}

function basicModule() {
  const module = createIRModule();
  const firmware = module.bytes('firmware', new Uint8Array([1, 2, 3, 4]), {
    readonly: true,
    unitBytes: 2,
  });
  const pc = module.state('pc', 'u32', 0);
  const helper = module.func('helper', { params: [], results: [] });
  helper.body((b) => b.return([]));
  const step = module.entry('step', []);
  const code = module.provider(
    'code',
    {
      keyTypes: ['u32'],
      params: [],
      results: [],
      reads: [firmware],
      imports: [pc, helper, step],
    },
    (gen) => {
      gen.readBytes(firmware, 0, 2);
      return gen.function((b) => b.return([]));
    },
  );
  step.body((b) => b.dispatch(code, [b.state.load(pc)], []));
  return { module, firmware, pc, helper, step, code };
}

describe('provider declarations', () => {
  it('exposes the confirmed provider surface on the module', () => {
    const { module, firmware, pc, helper, step, code } = basicModule();
    expect(module.providers).toHaveLength(1);
    const [definition] = module.providers;
    expect(definition).toEqual({
      name: 'code',
      ref: code,
      keyTypes: ['u32'],
      params: [],
      results: [],
      reads: [firmware],
      imports: [pc, helper, step],
    });
    expect(validateIR(module, options(module))).toEqual({ ok: true, diagnostics: [] });
  });

  it('rejects duplicate declaration names and malformed descriptors', () => {
    const module = createIRModule();
    expect(() =>
      module.provider(
        'same',
        { keyTypes: [], params: [], results: [], reads: [], imports: [] },
        (gen) => gen.function((b) => b.return([])),
      ),
    ).not.toThrow();
    expect(() => module.state('same', 'u32', 0)).toThrow(/already declared/);
    expect(() =>
      module.provider(
        'bad',
        { keyTypes: ['wat'], params: [], results: [], reads: [], imports: [] } as never,
        (gen) => gen.function((b) => b.return([])),
      ),
    ).toThrow(/scalar type/);
    expect(() =>
      module.provider(
        'bad2',
        { keyTypes: [], params: [], results: [], reads: [], imports: [] },
        (async () => Promise.resolve()) as never,
      ),
    ).toThrow(/synchronous/);
  });

  it('rejects writable byte resources in reads', () => {
    const module = createIRModule();
    const ram = module.bytes('ram', new Uint8Array(2), { readonly: false });
    expect(() =>
      module.provider(
        'code',
        { keyTypes: [], params: [], results: [], reads: [ram], imports: [] },
        (gen) => gen.function((b) => b.return([])),
      ),
    ).toThrow(/writable bytes/);
  });

  it('rejects duplicate and foreign read/import references', () => {
    const module = createIRModule();
    const other = createIRModule();
    const foreign = other.state('foreign', 'u32', 0);
    const state = module.state('state', 'u32', 0);
    const domain = module.domainDeclaration('pin', 'p1');
    expect(() =>
      module.provider(
        'dup',
        { keyTypes: [], params: [], results: [], reads: [state, state], imports: [] },
        (gen) => gen.function((b) => b.return([])),
      ),
    ).toThrow(/more than once/);
    expect(() =>
      module.provider(
        'foreign',
        { keyTypes: [], params: [], results: [], reads: [foreign], imports: [] },
        (gen) => gen.function((b) => b.return([])),
      ),
    ).toThrow(/another module/);
    expect(() =>
      module.provider(
        'domain',
        { keyTypes: [], params: [], results: [], reads: [], imports: [domain as never] },
        (gen) => gen.function((b) => b.return([])),
      ),
    ).toThrow(/reference/);
  });

  it('rejects dispatch signature mismatches and foreign providers at build time', () => {
    const module = createIRModule();
    const other = createIRModule();
    const code = module.provider(
      'code',
      { keyTypes: ['u32'], params: ['u32'], results: ['u32'], reads: [], imports: [] },
      (gen) => gen.function((b, [value]) => b.return([value])),
    );
    const foreign = other.provider(
      'foreign',
      { keyTypes: [], params: [], results: [], reads: [], imports: [] },
      (gen) => gen.function((b) => b.return([])),
    );
    const noResults = module.entry('noResults', []);
    expect(() =>
      noResults.body((b) =>
        b.dispatch(
          code as unknown as import('./index').ProviderRef<
            readonly ['u32'],
            readonly ['u32'],
            readonly []
          >,
          [b.const('u32', 1)],
          [b.const('u32', 2)],
        ),
      ),
    ).toThrow(/returns/);
    const wrongArgs = module.func('wrongArgs', { params: [], results: ['u32'] });
    expect(() =>
      wrongArgs.body((b) =>
        b.dispatch(code, [b.const('u32', 1)], [] as unknown as readonly [Value<'u32'>]),
      ),
    ).toThrow(/dispatch arguments/);
    const foreignUse = module.entry('foreignUse', []);
    expect(() => foreignUse.body((b) => b.dispatch(foreign, [], []))).toThrow(
      /another module|declared by this module/,
    );
  });
});

describe('provider validation', () => {
  it('rejects a tampered provider signature', () => {
    const { module } = basicModule();
    const input = model(module);
    input.providers[0]!.params = ['u32'] as never;
    const result = validateIR(input, options(module));
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'signature-mismatch' }),
    );
  });

  it('rejects duplicate provider declarations', () => {
    const { module } = basicModule();
    const input = model(module);
    input.providers.push({ ...input.providers[0]! });
    const result = validateIR(input, options(module));
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'duplicate-definition' }),
    );
  });

  it('rejects a dispatch target that is not a declared provider', () => {
    const { module, pc } = basicModule();
    const input = model(module);
    const term = input.functions[1]!.body!.entry.terminator!;
    Object.assign(term, { provider: pc });
    const result = validateIR(input, options(module));
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'invalid-static-reference' }),
    );
  });

  it('rejects a dispatch key that differs from the declared layout', () => {
    const { module } = basicModule();
    const input = model(module);
    const term = input.functions[1]!.body!.entry.terminator!;
    if (term.kind !== 'dispatch') throw new Error('expected dispatch');
    const bool = { type: 'bool' } as Value<'bool'>;
    Object.assign(term.key[0]!, { type: 'bool' });
    void bool;
    const result = validateIR(input, options(module));
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'provider-key-mismatch' }),
    );
  });

  it('rejects dispatch results that differ from the function signature', () => {
    const { module } = basicModule();
    const input = model(module);
    input.providers[0]!.results = ['u32'] as never;
    const result = validateIR(input, options(module));
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'signature-mismatch' }),
    );
  });

  it('rejects writable bytes in reads and unknown imports on re-validation', () => {
    const { module, firmware } = basicModule();
    const input = model(module);
    input.providers[0]!.reads = [firmware] as never;
    input.memories.find((memory) => memory.ref === firmware)!.writable = true;
    const result = validateIR(input, options(module));
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'invalid-provider' }),
    );

    const unknown = model(module);
    unknown.providers[0]!.imports = [{} as never];
    const unknownResult = validateIR(unknown, options(module));
    expect(unknownResult.ok).toBe(false);
  });

  it('requires an explicit dispatch capability grant', () => {
    const { module } = basicModule();
    const unsupported = validateIR(
      module,
      options(module, {
        supportedInstructions: CORE_INSTRUCTION_NAMES.filter((op) => op !== 'dispatch'),
      }),
    );
    expect(unsupported.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unsupported-instruction' }),
    );
    const unauthorized = validateIR(
      module,
      options(module, {
        authorizedInstructions: CORE_INSTRUCTION_NAMES.filter((op) => op !== 'dispatch'),
      }),
    );
    expect(unauthorized.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unauthorized-instruction' }),
    );
  });

  it('rejects a provider reference category mismatch', () => {
    const { module } = basicModule();
    const input = model(module);
    Object.assign(input.providers[0]!, { ref: input.memories[0]!.ref });
    const result = validateIR(input, options(module));
    expect(result.ok).toBe(false);
  });
});

describe('provider construction failures', () => {
  it('rejects a dispatch from another module provider', () => {
    const first = createIRModule();
    const second = createIRModule();
    const provider = first.provider(
      'code',
      { keyTypes: [], params: [], results: [], reads: [], imports: [] },
      (gen) => gen.function((b) => b.return([])),
    );
    const entry = second.entry('run', []);
    expect(() => entry.body((b) => b.dispatch(provider, [], []))).toThrow(
      /declared by this module|another module/,
    );
  });

  it('rejects a missing descriptor', () => {
    const module = createIRModule();
    expect(() =>
      module.provider('code', null as never, (gen) => gen.function((b) => b.return([]))),
    ).toThrow(/requires a descriptor/);
  });
});
