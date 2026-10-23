import { describe, expect, it } from 'vitest';
import { CORE_INSTRUCTION_NAMES } from './builder';
import { createIRModule } from './index';
import type { BlockDefinition, FunctionDefinition, FunctionRef } from './types';
import { refKind, signature } from './types';
import { validateGeneratedFunction } from './validate';

function artifactWith(instruction: unknown): FunctionDefinition {
  const block: BlockDefinition = {
    id: 0,
    params: [],
    instructions: [instruction as never],
    terminator: { kind: 'return', values: [] },
    defined: true,
  };
  return {
    ref: {
      [refKind]: 'function',
      [signature]: { params: [], results: [] },
    } as unknown as FunctionRef,
    name: 'artifact',
    category: 'function',
    params: [],
    results: [],
    body: { entry: block, blocks: [block] },
  };
}

function options() {
  return {
    supportedInstructions: CORE_INSTRUCTION_NAMES,
    authorizedInstructions: CORE_INSTRUCTION_NAMES,
    resources: [],
  };
}

describe('checkpoint artifact shape validation', () => {
  it('rejects a checkpoint with the wrong operand layout', () => {
    const module = createIRModule();
    const diagnostics = validateGeneratedFunction(
      module,
      artifactWith({ op: 'checkpoint', operands: [], results: [] }),
      options(),
      [],
    );
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'invalid-checkpoint' }));
  });

  it('rejects a checkpoint that declares results', () => {
    const module = createIRModule();
    const diagnostics = validateGeneratedFunction(
      module,
      artifactWith({
        op: 'checkpoint',
        operands: [
          { kind: 'static', ref: {} },
          { kind: 'ssa-list', values: [] },
          { kind: 'ssa-list', values: [] },
        ],
        results: [{ type: 'u32' }],
      }),
      options(),
      [],
    );
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'invalid-checkpoint' }));
  });
});
