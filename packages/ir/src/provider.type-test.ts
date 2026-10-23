// Compile-only public provider contract checks; run by the package typecheck.
import type {
  EntryRef,
  GeneratedFunction,
  GeneratedFunctionBuilder,
  GenerationContext,
  ImportRef,
  IRDeclarations,
  IRModule,
  OutputRef,
  ProviderDefinition,
  ProviderRef,
  StateRef,
  Value,
} from './index';

function expectType<T>(value: T): void {
  void value;
}

declare const api: IRDeclarations;
declare const module: IRModule;
declare const state: StateRef<'u32'>;
declare const flag: StateRef<'bool'>;
declare const rom: import('./index').BytesRef<true>;
declare const inbox: import('./index').InboxRef;
declare const entry: EntryRef<readonly []>;
declare const output: OutputRef<readonly ['u32']>;
declare const u32: Value<'u32'>;
declare const bool: Value<'bool'>;
declare const generatedBuilder: GeneratedFunctionBuilder<readonly ['u32']>;

const code: ProviderRef<readonly ['u32'], readonly ['u32'], readonly ['u32']> = api.provider(
  'code',
  {
    keyTypes: ['u32'],
    params: ['u32'],
    results: ['u32'],
    reads: [rom],
    imports: [state, entry, output],
  },
  (gen, [key]) => {
    expectType<number>(key);
    expectType<Uint8Array>(gen.readBytes(rom, 0, 2));
    expectType<number>(gen.readState(state));
    expectType<boolean>(gen.readState(flag));
    return gen.function((b, [value]) => {
      expectType<GeneratedFunctionBuilder<readonly ['u32']>>(b);
      expectType<Value<'u32'>>(value);
      return b.return([b.int.add(value, b.const('u32', key))]);
    });
  },
);
expectType<ProviderRef<readonly ['u32'], readonly ['u32'], readonly ['u32']>>(code);

declare const GenerationInstance: GenerationContext<readonly ['u32'], readonly ['u32']>;
expectType<GeneratedFunction<readonly ['u32'], readonly ['u32']>>(
  GenerationInstance.function((b, [value]) => b.return([value])),
);

declare const providerDefinitions: readonly ProviderDefinition[];
expectType<readonly ProviderDefinition[]>(module.providers);
void providerDefinitions;

const dispatchable = module.func('dispatchable', { params: ['u32'], results: ['u32'] });
dispatchable.body((b, [value]) => b.dispatch(code, [u32], [value]));
generatedBuilder.dispatch(code, [u32], [u32]);
generatedBuilder.at(generatedBuilder.block([]), (nested) => {
  expectType<GeneratedFunctionBuilder<readonly ['u32']>>(nested);
  return nested.return([u32]);
});
// Generated artifacts cannot return different results than the dispatch context.
const mismatched = module.func('mismatched', { params: [], results: ['bool'] });
// @ts-expect-error Provider results are part of the dispatch tail signature.
mismatched.body((b) => b.dispatch(code, [u32], [u32]));
// @ts-expect-error Key layout is fixed by the provider descriptor.
dispatchable.body((b) => b.dispatch(code, [bool], [u32]));
// @ts-expect-error Runtime arguments have their own fixed layout.
dispatchable.body((b) => b.dispatch(code, [u32], [bool]));
api.provider(
  'bad',
  // @ts-expect-error Provider key types are fixed at declaration.
  { keyTypes: ['wat'], params: [], results: [], reads: [], imports: [] },
  () => code,
);
const imports: readonly ImportRef[] = [state, flag, rom, inbox, entry, code];
void imports;
declare const generated: GeneratedFunction;
// @ts-expect-error Generated handles are not importable static references.
const rejectedImport: ImportRef = generated;
void rejectedImport;
// @ts-expect-error Generated handles are not scalar values.
const rejectedScalar: Value<'u32'> = generated;
void rejectedScalar;
