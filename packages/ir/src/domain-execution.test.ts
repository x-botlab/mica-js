import { describe, expect, it } from 'vitest';
import {
  createIRModule,
  IRConstructionError,
  validateIR,
  type IRInstructionValidator,
  type IRModule,
  type IRValidationOptions,
  type Value,
} from './index';
import { ENGINES } from './testing/engines';

describe.each(ENGINES)('$name engine', ({ create }) => {
  const LED_SET = {
    operands: [
      { kind: 'static-list', category: 'led', minLength: 1 },
      { kind: 'value-list', type: 'bool', minLength: 1 },
    ],
    results: [],
  } as const;

  function grant(module: IRModule): IRValidationOptions {
    const resources = module.domainDeclarations.map((declaration) => ({
      ref: declaration.ref,
      access: 'write' as const,
    }));
    const validator: IRInstructionValidator = {
      op: 'led.set',
      validate: () => [],
    };
    return {
      supportedInstructions: ['led.set', 'return', 'bool.not'],
      authorizedInstructions: ['led.set', 'return', 'bool.not'],
      resources,
      validators: [validator],
    };
  }

  function builder() {
    const module = createIRModule();
    const first = module.domainDeclaration('led', 'first');
    const second = module.domainDeclaration('led', 'second');
    const apply = module.domainInstruction('led.set', LED_SET);
    return { module, first, second, apply };
  }

  function expectConstructionError(run: () => unknown, pattern: RegExp): void {
    let caught: unknown;
    try {
      run();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IRConstructionError);
    expect(String(caught)).toMatch(pattern);
  }

  describe('domain instruction list operands', () => {
    it('builds one instruction with grouped static and value lists', () => {
      const { module, first, second, apply } = builder();
      const run = module.entry('run', ['bool']);
      run.body((b, [flag]) => {
        b.invoke(apply, [
          [first, second],
          [flag, b.bool.not(flag)],
        ]);
        b.return([]);
      });

      const node = module.functions[0]!.body!.entry.instructions.find(
        (instruction) => instruction.op === 'led.set',
      )!;
      expect(node.op).toBe('led.set');
      expect(node.operands[0]).toEqual({ kind: 'static-list', refs: [first, second] });
      expect(node.operands[1]!.kind).toBe('ssa-list');
      expect(validateIR(module, grant(module)).ok).toBe(true);
    });

    it('executes through a trusted executor with flattened bool operands', () => {
      const { module, first, second, apply } = builder();
      const run = module.entry('run', ['bool']);
      run.body((b, [flag]) => {
        b.invoke(apply, [
          [first, second],
          [flag, b.bool.not(flag)],
        ]);
        b.return([]);
      });
      const calls: { operands: readonly unknown[]; refs: readonly unknown[] }[] = [];
      const interpreter = create(module, {
        validation: grant(module),
        executors: [
          {
            op: 'led.set',
            execute(request) {
              const refs = request.instruction.operands[0];
              calls.push({
                operands: request.operands,
                refs: refs?.kind === 'static-list' ? refs.refs : [],
              });
              return [];
            },
          },
        ],
      });

      interpreter.execute(run, [true], { instanceId: 'device', virtualTime: 0 });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.operands).toEqual([true, false]);
      expect(calls[0]!.refs).toEqual([first, second]);
    });

    it('captures executor results using the declared result types', () => {
      const module = createIRModule();
      const instruction = module.domainInstruction('led.read', {
        operands: [{ kind: 'value-list', type: 'bool', minLength: 1 }],
        results: ['u32'],
      });
      const run = module.func('run', { params: ['bool'], results: ['u32'] });
      run.body((b, [flag]) => {
        const result = b.invoke(instruction, [[flag]]);
        b.return([result[0]!]);
      });
      const validation: IRValidationOptions = {
        supportedInstructions: ['led.read', 'return'],
        authorizedInstructions: ['led.read', 'return'],
        resources: [],
        validators: [{ op: 'led.read', validate: () => [] }],
      };
      const interpreter = create(module, {
        validation,
        executors: [{ op: 'led.read', execute: () => [42] }],
      });

      expect(
        interpreter.execute(run, [true], { instanceId: 'device', virtualTime: 0 }).values,
      ).toEqual([42]);
    });

    it('rejects an instruction without an executor at link time', () => {
      const { module, first, apply } = builder();
      const run = module.entry('run', ['bool']);
      run.body((b, [flag]) => {
        b.invoke(apply, [[first], [flag]]);
        b.return([]);
      });

      expect(() => create(module, { validation: grant(module) })).toThrowError(
        expect.objectContaining({ code: 'unsupported-instruction' }),
      );
    });

    it('rejects duplicate, core-colliding, and asynchronously shaped executors', () => {
      const { module, first, apply } = builder();
      const run = module.entry('run', ['bool']);
      run.body((b, [flag]) => {
        b.invoke(apply, [[first], [flag]]);
        b.return([]);
      });
      const execute = () => [];
      expect(() =>
        create(module, {
          validation: grant(module),
          executors: [
            { op: 'led.set', execute },
            { op: 'led.set', execute },
          ],
        }),
      ).toThrowError(expect.objectContaining({ code: 'invalid-options' }));
      expect(() =>
        create(module, {
          validation: grant(module),
          executors: [{ op: 'const', execute }],
        }),
      ).toThrowError(expect.objectContaining({ code: 'invalid-options' }));
      expect(() =>
        create(module, {
          validation: grant(module),
          executors: [
            {
              op: 'led.set',
              execute: (async () => []) as unknown as () => readonly [],
            },
          ],
        }),
      ).toThrowError(expect.objectContaining({ code: 'invalid-options' }));
    });

    it('faults when an executor returns the wrong result shape', () => {
      const module = createIRModule();
      const instruction = module.domainInstruction('led.read', {
        operands: [],
        results: ['u32'],
      });
      const run = module.entry('run', []);
      run.body((b) => {
        b.invoke(instruction, []);
        b.return([]);
      });
      const validation: IRValidationOptions = {
        supportedInstructions: ['led.read', 'return'],
        authorizedInstructions: ['led.read', 'return'],
        resources: [],
        validators: [{ op: 'led.read', validate: () => [] }],
      };
      const interpreter = create(module, {
        validation,
        executors: [{ op: 'led.read', execute: () => [] }],
      });

      expect(() =>
        interpreter.execute(run, [], { instanceId: 'device', virtualTime: 0 }),
      ).toThrowError(expect.objectContaining({ code: 'evaluation-failed' }));
    });

    it('rejects empty lists, wrong element types, and foreign module handles while building', () => {
      const { module, first, apply } = builder();
      const other = createIRModule();
      const foreign = other.domainDeclaration('led', 'foreign');
      const run = module.entry('run', ['bool']);
      run.body((b, [flag]) => {
        expectConstructionError(() => b.invoke(apply, [[], []]), /requires at least 1 item/);
        expectConstructionError(
          () => b.invoke(apply, [[first], [b.const('u32', 1) as unknown as Value<'bool'>]]),
          /must have type bool/,
        );
        expectConstructionError(
          () => b.invoke(apply, [[foreign], [flag]]),
          /belongs to another module/,
        );
        b.return([]);
      });
    });

    it('validates list element scalar types and static categories in supplied IR', () => {
      const { module, first, second, apply } = builder();
      const state = module.state('flag', 'bool', false);
      const run = module.entry('run', ['bool']);
      run.body((b, [flag]) => {
        b.invoke(apply, [
          [first, second],
          [flag, flag],
        ]);
        b.return([]);
      });
      const model = module as unknown as {
        functions: {
          body: { blocks: { instructions: { operands: unknown[] }[] }[] };
        }[];
      };
      const instruction = model.functions[0]!.body.blocks[0]!.instructions[0]!;
      const operands = instruction.operands as {
        kind: string;
        values?: { type: string }[];
        refs?: unknown[];
      }[];
      operands[1]!.values![0] = { type: 'u32' };
      let validation = validateIR(module, grant(module));
      expect(validation.ok).toBe(false);
      expect(validation.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        'signature-mismatch',
      );

      operands[1]!.values![0] = { type: 'bool' };
      operands[0]!.refs![0] = state;
      validation = validateIR(module, grant(module));
      expect(validation.ok).toBe(false);
      expect(validation.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        'signature-mismatch',
      );
    });

    it('validates list element kinds and minimum lengths in supplied IR', () => {
      const { module, first, second, apply } = builder();
      let flag: unknown;
      const run = module.entry('run', ['bool']);
      run.body((b, [value]) => {
        flag = value;
        b.invoke(apply, [
          [first, second],
          [value, value],
        ]);
        b.return([]);
      });
      const model = module as unknown as {
        functions: {
          body: { blocks: { instructions: { operands: unknown[] }[] }[] };
        }[];
      };
      model.functions[0]!.body.blocks[0]!.instructions[0]!.operands[1] = {
        kind: 'ssa',
        value: flag,
      };
      const validation = validateIR(module, grant(module));
      expect(validation.ok).toBe(false);
      expect(validation.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        'signature-mismatch',
      );
    });
  });
});
