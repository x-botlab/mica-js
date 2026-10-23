import { describe, expect, it } from 'vitest';
import { CORE_INSTRUCTION_NAMES } from './builder';
import {
  createIRModule,
  IRConstructionError,
  IRExecutionError,
  validateIR,
  type IRBuilderExtension,
  type IRModule,
  type IRValidationOptions,
  type Value,
} from './index';
import { ENGINES } from './testing/engines';

describe.each(ENGINES)('$name engine', ({ create }) => {
  const context = { instanceId: 'extensions', virtualTime: 0 };

  function policy(module: IRModule, ...ops: readonly string[]): IRValidationOptions {
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
      const validation = validateIR(created, policy(created, 'pin.sample'));
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

  describe('domain instructions in the event namespace', () => {
    function eventModule() {
      const module = createIRModule();
      const instruction = module.domainInstruction('event.foo', {
        operands: [],
        results: ['u32'],
      });
      module
        .func('run', { params: [], results: ['u32'] })
        .body((b) => b.return([b.invoke(instruction, [])[0]!]));
      return module;
    }

    it.each([false, true])(
      'executes an event-prefixed domain instruction through its executor (eventHost=%s)',
      (withHost) => {
        const module = eventModule();
        const names = [...CORE_INSTRUCTION_NAMES, 'event.foo'];
        const runtime = create(module, {
          validation: {
            supportedInstructions: names,
            authorizedInstructions: names,
            resources: [],
            validators: [{ op: 'event.foo', validate: () => [] }],
          },
          executors: [{ op: 'event.foo', execute: () => [7] }],
          ...(withHost
            ? { eventHost: { now: () => 0, at: () => 1, cancel: () => undefined } }
            : {}),
        });
        expect(runtime.execute(module.functions[0]!.ref, [], context).values).toEqual([7]);
      },
    );

    it('rejects an event-prefixed declaration without an executor', () => {
      const module = eventModule();
      const names = [...CORE_INSTRUCTION_NAMES, 'event.foo'];
      expect(() =>
        create(module, {
          validation: {
            supportedInstructions: names,
            authorizedInstructions: names,
            resources: [],
            validators: [{ op: 'event.foo', validate: () => [] }],
          },
        }),
      ).toThrow(IRExecutionError);
    });
  });
});
