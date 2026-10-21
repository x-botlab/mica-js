// Compile-only storage contract checks. This file is not executed and is
// excluded from the package build; `pnpm --filter @mica/ir typecheck` runs it.
import type {
  ArrayRef,
  BytesRef,
  FloatBits,
  InboxRef,
  IRStorage,
  StateRef,
  StorageValue,
} from './index';

function expectType<T>(value: T): void {
  void value;
}

declare const storage: IRStorage;
declare const flag: StateRef<'bool'>;
declare const byte: StateRef<'u8'>;
declare const single: StateRef<'f32'>;
declare const wide: StateRef<'f64'>;
declare const ram: BytesRef<false>;
declare const rom: BytesRef<true>;
declare const inbox: InboxRef;
declare const array: ArrayRef<'u32'>;

expectType<boolean>(storage.loadState(flag));
expectType<number>(storage.loadState(byte));
expectType<FloatBits>(storage.loadState(single));
expectType<FloatBits>(storage.loadState(wide));
expectType<number>(storage.loadArray(array, 0));
expectType<number>(storage.loadBytes('u32', 'little', ram, 0));
expectType<number>(storage.loadBytes('u16', 'big', inbox, 0));
expectType<FloatBits>(storage.loadBytes('f32', 'little', rom, 0));
expectType<FloatBits>(storage.loadBytes('f64', 'big', ram, 0));
const boolValue: StorageValue<'bool'> = true;
const integerValue: StorageValue<'i32'> = 1;
const floatValue: StorageValue<'f32'> = { type: 'f32', bits: '0x7fc01234' };
expectType<boolean>(boolValue);
expectType<number>(integerValue);
expectType<FloatBits>(floatValue);

storage.storeState(flag, true);
storage.storeState(byte, 1);
storage.storeState(single, 1.5);
storage.storeState(single, { type: 'f32', bits: '0x7fc01234' });
storage.storeArray(array, 0, 1);
storage.storeBytes('u16', 'little', ram, 0, 1);
storage.storeBytes('f64', 'big', ram, 0, { type: 'f64', bits: '0x7ff8000000001234' });
storage.copy(ram, 0, inbox, 0, 1);
storage.copy(ram, 0, rom, 0, 1);

// @ts-expect-error storage values cannot be strings
storage.storeState(byte, '1');
// @ts-expect-error bytes load types exclude bool
storage.loadBytes('bool', 'little', ram, 0);
// @ts-expect-error bytes store types exclude bool
storage.storeBytes('bool', 'little', ram, 0, 1);
// @ts-expect-error inbox is never a normal write destination
storage.storeBytes('u8', 'little', inbox, 0, 1);
// @ts-expect-error readonly bytes are never a normal write destination
storage.storeBytes('u8', 'little', rom, 0, 1);
// @ts-expect-error inbox is never a copy destination
storage.copy(inbox, 0, ram, 0, 1);
// @ts-expect-error readonly bytes are never a copy destination
storage.copy(rom, 0, ram, 0, 1);
// @ts-expect-error a state reference is not a byte source
storage.copy(ram, 0, byte, 0, 1);
