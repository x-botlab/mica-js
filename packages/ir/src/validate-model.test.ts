import { describe, expect, it } from 'vitest';
import { createIRModule, validateIR, type IRValidationOptions } from './index';

const options: IRValidationOptions = {
  supportedInstructions: ['call', 'return'],
  authorizedInstructions: ['call', 'return'],
  resources: [],
};

function callLocation(functionIndex: number, functionName: string) {
  return {
    path: `functions[${functionIndex}].body.blocks[0].instructions[0]`,
    functionIndex,
    functionName,
    blockIndex: 0,
    blockId: 0,
    instructionIndex: 0,
  };
}

describe('validateIR module registry snapshots', () => {
  it('accepts ordinary calls on an actual builder module with fresh declaration getters', () => {
    const module = createIRModule();
    const helper = module.func('helper', { params: ['u32'], results: ['u32'] });
    helper.body((b, [parameter]) => b.return([parameter]));
    module.entry('main', ['u32']).body((b, [parameter]) => {
      b.call(helper, [parameter]);
      b.return([]);
    });

    expect(module.functions[0]).not.toBe(module.functions[0]);
    expect(validateIR(module, options)).toEqual({ ok: true, diagnostics: [] });
  });

  it('reports the precise call sites of a recursive actual builder module', () => {
    const module = createIRModule();
    const left = module.func('left', { params: [], results: [] });
    const right = module.func('right', { params: [], results: [] });
    left.body((b) => {
      b.call(right, []);
      b.return([]);
    });
    right.body((b) => {
      b.call(left, []);
      b.return([]);
    });

    const result = validateIR(module, options);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      { code: 'recursive-call', message: expect.any(String), location: callLocation(0, 'left') },
      { code: 'recursive-call', message: expect.any(String), location: callLocation(1, 'right') },
    ]);
  });

  it('reads each registry once and still observes a new model on the next validation', () => {
    const module = createIRModule();
    const helper = module.func('helper', { params: [], results: [] });
    helper.body((b) => b.return([]));
    const reads = { memories: 0, functions: 0, domainDeclarations: 0, instructions: 0 };
    const input = {
      get memories() {
        reads.memories += 1;
        return module.memories;
      },
      get functions() {
        reads.functions += 1;
        return module.functions;
      },
      get domainDeclarations() {
        reads.domainDeclarations += 1;
        return module.domainDeclarations;
      },
      get instructions() {
        reads.instructions += 1;
        return module.instructions;
      },
    };
    expect(validateIR(input, options)).toEqual({ ok: true, diagnostics: [] });
    expect(reads).toEqual({ memories: 1, functions: 1, domainDeclarations: 1, instructions: 1 });

    module.func('missing', { params: [], results: [] });
    const result = validateIR(input, options);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      {
        code: 'invalid-block',
        message: expect.any(String),
        location: { path: 'functions[1]', functionIndex: 1, functionName: 'missing' },
      },
    ]);
    expect(reads).toEqual({ memories: 2, functions: 2, domainDeclarations: 2, instructions: 2 });
  });
});
