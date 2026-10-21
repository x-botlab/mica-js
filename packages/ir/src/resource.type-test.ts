// Compile-only checks for the approved #47 public contract.
import { createIRStorage } from './index';
import type {
  BytesRef,
  FunctionBuilder,
  GeneratedFunctionBuilder,
  InboxRef,
  IRModule,
  IRResourceDependency,
  IRResourceIdentity,
  IRResourcePermission,
  IRResourceVersion,
  IRStorage,
  IRStorageOptions,
  IRVersionedBytes,
  IRVersionUnitIdentity,
  ResourceOperations,
  StateRef,
  Value,
} from './index';

function expectType<T>(value: T): void {
  void value;
}

declare const module: IRModule;
declare const b: FunctionBuilder;
declare const generated: GeneratedFunctionBuilder;
declare const storage: IRStorage;
declare const rom: BytesRef<true>;
declare const ram: BytesRef<false>;
declare const inbox: InboxRef;
declare const state: StateRef<'u32'>;
declare const offset: Value<'u32'>;
declare const byte: Value<'u8'>;

expectType<ResourceOperations>(b.resource);
expectType<undefined>(b.resource.updateBytes(rom, offset, inbox, offset, offset));
expectType<undefined>(b.resource.updateBytes(ram, offset, rom, offset, offset));
expectType<undefined>(b.resource.fillBytes(rom, offset, offset, byte));
generated.at(generated.block([]), (nested) => {
  nested.resource.updateBytes(rom, offset, inbox, offset, offset);
  nested.resource.fillBytes(ram, offset, offset, byte);
  return nested.return([]);
});
const options: IRStorageOptions = { updateResources: [rom, ram] };
const permission: IRResourcePermission = { ref: rom, access: 'update' };
expectType<IRStorage>(createIRStorage(module));
expectType<IRStorage>(createIRStorage(module, options));
expectType<IRResourcePermission>(permission);
expectType<void>(storage.updateBytes(rom, 0, inbox, 0, 0));
expectType<void>(storage.fillBytes(rom, 0, 0, 255));
const result = storage.readVersionedBytes(inbox, 0, 0);
expectType<IRVersionedBytes>(result);
expectType<Uint8Array>(result.bytes);
expectType<readonly IRResourceDependency[]>(result.dependencies);
expectType<boolean>(storage.validateDependencies(result.dependencies));
const dependency = result.dependencies[0]!;
expectType<IRResourceIdentity>(dependency.resource);
expectType<IRVersionUnitIdentity>(dependency.unit);
expectType<IRResourceVersion>(dependency.version);

// @ts-expect-error inbox cannot receive versioned updates
b.resource.updateBytes(inbox, offset, rom, offset, offset);
// @ts-expect-error state is not a byte source
b.resource.updateBytes(rom, offset, state, offset, offset);
// @ts-expect-error offsets must be u32
b.resource.updateBytes(rom, byte, ram, offset, offset);
// @ts-expect-error lengths must be u32
b.resource.fillBytes(rom, offset, byte, byte);
// @ts-expect-error fill value must be u8
b.resource.fillBytes(rom, offset, offset, offset);
// @ts-expect-error inbox cannot be authorized as an update target
createIRStorage(module, { updateResources: [inbox] });
// @ts-expect-error inbox cannot be updated through storage
storage.fillBytes(inbox, 0, 0, 0);
// @ts-expect-error state is not a byte destination
storage.updateBytes(state, 0, ram, 0, 0);
// @ts-expect-error dependencies are immutable
result.dependencies.push(dependency);
// @ts-expect-error dependency fields are immutable
dependency.version = result.dependencies[1]!.version;
// @ts-expect-error identities cannot be constructed by consumers
const fakeIdentity: IRResourceIdentity = {};
// @ts-expect-error unit identity is not resource identity
const swappedIdentity: IRResourceIdentity = dependency.unit;
// @ts-expect-error version identity is not unit identity
const swappedVersion: IRVersionUnitIdentity = dependency.version;
void [fakeIdentity, swappedIdentity, swappedVersion];
