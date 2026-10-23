/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createIRModule,
  createIRStorage,
  IRStorageError,
  type FloatBits,
  type IRModule,
  type IRStorage,
  type IRStorageErrorCode,
  type RuntimeScalar,
  type ScalarType,
} from './index';
import {
  advanceScalar,
  providerReadArray,
  providerReadState,
  resumeStorageWrites,
  setLittleEndianHostProbe,
  storageInternals,
  suspendStorageWrites,
  type IRProviderTrackedReads,
  type StorageInternals,
} from './storage';
import { byteReadonly, refKind } from './types';

const RAM = new Uint8Array([
  0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00,
]);

function expectStorageError(run: () => unknown, code: IRStorageErrorCode): IRStorageError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(IRStorageError);
  const error = caught as IRStorageError;
  expect(error.code).toBe(code);
  expect(error.name).toBe('IRStorageError');
  return error;
}

function createFixture() {
  const module = createIRModule();
  const flag = module.state('flag', 'bool', false);
  const byte = module.state('byte', 'u8', 0);
  const word = module.state('word', 'u16', 0x1234);
  const dword = module.state('dword', 'u32', 0x89abcdef);
  const sbyte = module.state('sbyte', 'i8', -1);
  const sword = module.state('sword', 'i16', -2);
  const sdword = module.state('sdword', 'i32', -3);
  const single = module.state('single', 'f32', 1.5);
  const double = module.state('double', 'f64', 0.1);
  const words = module.array('words', 'u16', [0x1122, 0x3344]);
  const emptyArray = module.array('emptyArray', 'u8', []);
  const ram = module.bytes('ram', RAM, { readonly: false });
  const rom = module.bytes(
    'rom',
    new Uint8Array([0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7]),
    { readonly: true, unitBytes: 2 },
  );
  const inbox = module.inbox('input', 4);
  const empty = module.bytes('empty', new Uint8Array(0), { readonly: false });
  return {
    module,
    storage: createIRStorage(module),
    ram,
    rom,
    inbox,
    empty,
    emptyArray,
    words,
    flag,
    byte,
    word,
    dword,
    sbyte,
    sword,
    sdword,
    single,
    double,
  };
}

describe('@mica-js/ir storage', () => {
  it('copies declared initial values for every supported layout', () => {
    const module = createIRModule();
    const flag = module.state('flag', 'bool', true);
    const byte = module.state('byte', 'u8', 0xff);
    const word = module.state('word', 'u16', 0x1234);
    const dword = module.state('dword', 'u32', 0xffffffff);
    const sbyte = module.state('sbyte', 'i8', -0x80);
    const sword = module.state('sword', 'i16', -0x8000);
    const sdword = module.state('sdword', 'i32', -0x80000000);
    const single = module.state('single', 'f32', 1.5);
    const nan = module.state('nan', 'f32', Number.NaN);
    const negativeZero = module.state('negativeZero', 'f32', -0);
    const wide = module.state('wide', 'f64', 0.1);
    const wideNaN = module.state('wideNaN', 'f64', Number.NaN);
    const wideNegativeZero = module.state('wideNegativeZero', 'f64', -0);
    const array = module.array('array', 'u8', [3, 5]);
    const emptyArray = module.array('emptyArray', 'u8', []);
    const ram = module.bytes('ram', new Uint8Array([1, 2, 3]), { readonly: false });
    const rom = module.bytes('rom', new Uint8Array([4, 5]), { readonly: true });
    const inbox = module.inbox('inbox', 3);
    const empty = module.bytes('empty', new Uint8Array(0), { readonly: false });
    const storage = createIRStorage(module);

    expect(storage.loadState(flag)).toBe(true);
    expect(storage.loadState(byte)).toBe(0xff);
    expect(storage.loadState(word)).toBe(0x1234);
    expect(storage.loadState(dword)).toBe(0xffffffff);
    expect(storage.loadState(sbyte)).toBe(-0x80);
    expect(storage.loadState(sword)).toBe(-0x8000);
    expect(storage.loadState(sdword)).toBe(-0x80000000);
    expect(storage.loadState(single)).toEqual({ type: 'f32', bits: '0x3fc00000' });
    expect(storage.loadState(nan)).toEqual({ type: 'f32', bits: '0x7fc00000' });
    expect(storage.loadState(negativeZero)).toEqual({ type: 'f32', bits: '0x80000000' });
    expect(storage.loadState(wide)).toEqual({ type: 'f64', bits: '0x3fb999999999999a' });
    expect(storage.loadState(wideNaN)).toEqual({ type: 'f64', bits: '0x7ff8000000000000' });
    expect(storage.loadState(wideNegativeZero)).toEqual({
      type: 'f64',
      bits: '0x8000000000000000',
    });
    expect(storage.loadArray(array, 0)).toBe(3);
    expect(storage.loadArray(array, 1)).toBe(5);
    expectStorageError(() => storage.loadArray(emptyArray, 0), 'out-of-bounds');
    expect(storage.loadBytes('u8', 'little', ram, 0)).toBe(1);
    expect(storage.loadBytes('u8', 'big', ram, 2)).toBe(3);
    expect(storage.loadBytes('u8', 'little', rom, 1)).toBe(5);
    expect(storage.loadBytes('u8', 'little', inbox, 0)).toBe(0);
    expect(storage.loadBytes('u8', 'little', inbox, 2)).toBe(0);
    expectStorageError(() => storage.loadBytes('u8', 'little', empty, 0), 'out-of-bounds');
  });

  it('stores and loads every scalar state type without crossing categories', () => {
    const fixture = createFixture();
    const { storage } = fixture;

    storage.storeState(fixture.flag, true);
    storage.storeState(fixture.byte, 0xff);
    storage.storeState(fixture.word, 0xffff);
    storage.storeState(fixture.dword, 0xffffffff);
    storage.storeState(fixture.sbyte, -0x80);
    storage.storeState(fixture.sword, -0x8000);
    storage.storeState(fixture.sdword, -0x80000000);
    storage.storeState(fixture.single, 1.1);
    storage.storeState(fixture.double, 0.1);

    expect(storage.loadState(fixture.flag)).toBe(true);
    expect(storage.loadState(fixture.byte)).toBe(0xff);
    expect(storage.loadState(fixture.word)).toBe(0xffff);
    expect(storage.loadState(fixture.dword)).toBe(0xffffffff);
    expect(storage.loadState(fixture.sbyte)).toBe(-0x80);
    expect(storage.loadState(fixture.sword)).toBe(-0x8000);
    expect(storage.loadState(fixture.sdword)).toBe(-0x80000000);
    expect(storage.loadState(fixture.single)).toEqual({ type: 'f32', bits: '0x3f8ccccd' });
    expect(storage.loadState(fixture.double)).toEqual({ type: 'f64', bits: '0x3fb999999999999a' });

    expectStorageError(() => storage.loadState(fixture.words as never), 'invalid-resource');
    expectStorageError(() => storage.loadArray(fixture.flag as never, 0), 'invalid-resource');
    expectStorageError(() => storage.storeState(fixture.words as never, 1), 'invalid-resource');
    expectStorageError(() => storage.storeState(fixture.byte, 256), 'invalid-value');
    expectStorageError(() => storage.storeState(fixture.byte, -1), 'invalid-value');
    expectStorageError(() => storage.storeState(fixture.byte, 1.5), 'invalid-value');
    expectStorageError(() => storage.storeState(fixture.flag, 0), 'invalid-value');
    expectStorageError(() => storage.storeState(fixture.single, true), 'invalid-value');
    expect(storage.loadState(fixture.byte)).toBe(0xff);
  });

  it('stores arrays, checks u32 indexes, and rejects category errors', () => {
    const fixture = createFixture();
    const { storage } = fixture;

    storage.storeArray(fixture.words, 0, 0xffff);
    storage.storeArray(fixture.words, 1, 0);
    expect(storage.loadArray(fixture.words, 0)).toBe(0xffff);
    expect(storage.loadArray(fixture.words, 1)).toBe(0);

    expectStorageError(() => storage.loadArray(fixture.words, 2), 'out-of-bounds');
    expectStorageError(() => storage.storeArray(fixture.words, 2, 1), 'out-of-bounds');
    expect(storage.loadArray(fixture.words, 1)).toBe(0);
    expectStorageError(() => storage.loadArray(fixture.words, -1), 'invalid-argument');
    expectStorageError(() => storage.loadArray(fixture.words, 1.5), 'invalid-argument');
    expectStorageError(() => storage.loadArray(fixture.words, 0x1_0000_0000), 'invalid-argument');
    expectStorageError(() => storage.storeArray(fixture.words, 0, 0x1_0000), 'invalid-value');
    expect(storage.loadArray(fixture.words, 0)).toBe(0xffff);
    expectStorageError(() => storage.loadArray(fixture.emptyArray, 0), 'out-of-bounds');
    expectStorageError(() => storage.storeArray(fixture.emptyArray, 0, 1), 'out-of-bounds');
  });

  it('reads and writes byte loads with both endians, including unaligned access', () => {
    const fixture = createFixture();
    const { storage } = fixture;

    expect(storage.loadBytes('u8', 'little', fixture.ram, 0)).toBe(0x11);
    expect(storage.loadBytes('u8', 'big', fixture.ram, 15)).toBe(0x00);
    expect(storage.loadBytes('i8', 'little', fixture.ram, 0)).toBe(0x11);
    expect(storage.loadBytes('u16', 'little', fixture.ram, 0)).toBe(0x2211);
    expect(storage.loadBytes('u16', 'big', fixture.ram, 0)).toBe(0x1122);
    expect(storage.loadBytes('u16', 'little', fixture.ram, 1)).toBe(0x3322);
    expect(storage.loadBytes('u16', 'big', fixture.ram, 1)).toBe(0x2233);
    expect(storage.loadBytes('u32', 'little', fixture.ram, 0)).toBe(0x44332211);
    expect(storage.loadBytes('u32', 'big', fixture.ram, 0)).toBe(0x11223344);
    expect(storage.loadBytes('i16', 'big', fixture.ram, 14)).toBe(-0x100);

    storage.storeBytes('u16', 'little', fixture.ram, 1, 4660);
    expect(storage.loadBytes('u16', 'little', fixture.ram, 1)).toBe(4660);
    expect(storage.loadBytes('u16', 'big', fixture.ram, 1)).toBe(13330);

    storage.storeBytes('f32', 'little', fixture.ram, 1, {
      type: 'f32',
      bits: '0x7fc01234',
    });
    expect(storage.loadBytes('f32', 'little', fixture.ram, 1)).toEqual({
      type: 'f32',
      bits: '0x7fc01234',
    });
    expect(storage.loadBytes('f32', 'big', fixture.ram, 1)).toEqual({
      type: 'f32',
      bits: '0x3412c07f',
    });

    storage.storeBytes('f64', 'little', fixture.ram, 0, {
      type: 'f64',
      bits: '0x7ff8000000001234',
    });
    expect(storage.loadBytes('f64', 'little', fixture.ram, 0)).toEqual({
      type: 'f64',
      bits: '0x7ff8000000001234',
    });

    storage.storeBytes('i32', 'little', fixture.ram, 4, -0x11223344);
    expect(storage.loadBytes('i32', 'little', fixture.ram, 4)).toBe(-0x11223344);
    storage.storeBytes('u32', 'big', fixture.ram, 8, 0x89abcdef);
    expect(storage.loadBytes('u32', 'big', fixture.ram, 8)).toBe(0x89abcdef);
    storage.storeBytes('i8', 'little', fixture.ram, 0, -1);
    expect(storage.loadBytes('i8', 'little', fixture.ram, 0)).toBe(-1);
  });

  it('validates complete byte ranges before writing or copying', () => {
    const fixture = createFixture();
    const { storage } = fixture;
    const before = Array.from({ length: 16 }, (_, index) =>
      storage.loadBytes('u8', 'little', fixture.ram, index),
    );

    expectStorageError(() => storage.loadBytes('u32', 'little', fixture.ram, 13), 'out-of-bounds');
    expectStorageError(() => storage.loadBytes('u32', 'little', fixture.ram, 16), 'out-of-bounds');
    expectStorageError(
      () => storage.storeBytes('u32', 'little', fixture.ram, 13, 1),
      'out-of-bounds',
    );
    expectStorageError(
      () => storage.loadBytes('u8', 'little', fixture.ram, 0xffffffff),
      'out-of-bounds',
    );
    expectStorageError(
      () => storage.loadBytes('u8', 'little', fixture.ram, 0x1_0000_0000),
      'invalid-argument',
    );
    expectStorageError(
      () => storage.loadBytes('u8', 'little', fixture.ram, -1),
      'invalid-argument',
    );
    expectStorageError(
      () => storage.loadBytes('bool' as never, 'little', fixture.ram, 0),
      'invalid-argument',
    );
    expectStorageError(
      () => storage.loadBytes('u8', 'middle' as never, fixture.ram, 0),
      'invalid-argument',
    );
    expectStorageError(
      () => storage.storeBytes('u8', 'little', fixture.ram, 0, 256),
      'invalid-value',
    );
    expectStorageError(
      () =>
        storage.storeBytes('f32', 'little', fixture.ram, 0, {
          type: 'f64',
          bits: '0x7ff8000000001234',
        }),
      'invalid-value',
    );
    for (let index = 0; index < 16; index += 1) {
      expect(storage.loadBytes('u8', 'little', fixture.ram, index)).toBe(before[index]);
    }
  });

  it('copies with a source snapshot, allowing overlap and zero length', () => {
    const fixture = createFixture();
    const { storage } = fixture;

    storage.copy(fixture.ram, 1, fixture.ram, 0, 4);
    expect(
      Array.from({ length: 8 }, (_, index) =>
        storage.loadBytes('u8', 'little', fixture.ram, index),
      ),
    ).toEqual([0x11, 0x11, 0x22, 0x33, 0x44, 0x66, 0x77, 0x88]);

    const backwards = createFixture();
    backwards.storage.copy(backwards.ram, 0, backwards.ram, 1, 4);
    expect(
      Array.from({ length: 8 }, (_, index) =>
        backwards.storage.loadBytes('u8', 'little', backwards.ram, index),
      ),
    ).toEqual([0x22, 0x33, 0x44, 0x55, 0x55, 0x66, 0x77, 0x88]);

    storage.copy(fixture.ram, 8, fixture.inbox, 0, 4);
    expect(
      Array.from({ length: 4 }, (_, index) =>
        storage.loadBytes('u8', 'little', fixture.ram, 8 + index),
      ),
    ).toEqual([0, 0, 0, 0]);
  });

  it('copies between byte resources, including readonly sources', () => {
    const module = createIRModule();
    const source = module.bytes('source', new Uint8Array([1, 2, 3, 4]), { readonly: true });
    const target = module.bytes('target', new Uint8Array(4), { readonly: false });
    const storage = createIRStorage(module);

    storage.copy(target, 1, source, 0, 3);
    expect(
      Array.from({ length: 4 }, (_, index) => storage.loadBytes('u8', 'little', target, index)),
    ).toEqual([0, 1, 2, 3]);
    storage.copy(target, 0, source, 3, 0);
    expect(storage.loadBytes('u8', 'little', target, 0)).toBe(0);
  });

  it('rejects readonly and inbox writes without partial changes', () => {
    const fixture = createFixture();
    const { storage } = fixture;
    const ramBefore = Array.from({ length: 4 }, (_, index) =>
      storage.loadBytes('u8', 'little', fixture.ram, index),
    );

    expectStorageError(
      () => storage.storeBytes('u8', 'little', fixture.rom as never, 0, 1),
      'readonly-resource',
    );
    expectStorageError(
      () => storage.storeBytes('u8', 'little', fixture.inbox as never, 0, 1),
      'readonly-resource',
    );
    expectStorageError(
      () => storage.copy(fixture.rom as never, 0, fixture.ram, 0, 1),
      'readonly-resource',
    );
    expectStorageError(
      () => storage.copy(fixture.inbox as never, 0, fixture.ram, 0, 1),
      'readonly-resource',
    );
    expect(
      Array.from({ length: 4 }, (_, index) =>
        storage.loadBytes('u8', 'little', fixture.ram, index),
      ),
    ).toEqual(ramBefore);
    expect(storage.loadBytes('u8', 'little', fixture.rom, 0)).toBe(0xa0);
    expect(storage.loadBytes('u8', 'little', fixture.inbox, 0)).toBe(0);

    expectStorageError(() => storage.copy(fixture.ram, 0, fixture.rom, 16, 1), 'out-of-bounds');
    expect(
      Array.from({ length: 4 }, (_, index) =>
        storage.loadBytes('u8', 'little', fixture.ram, index),
      ),
    ).toEqual(ramBefore);
  });

  it('enforces zero length and u32 arguments', () => {
    const fixture = createFixture();
    const { storage } = fixture;

    storage.copy(fixture.ram, 16, fixture.inbox, 4, 0);
    storage.copy(fixture.ram, 16, fixture.ram, 16, 0);
    storage.copy(fixture.empty, 0, fixture.inbox, 4, 0);
    expectStorageError(() => storage.copy(fixture.ram, 17, fixture.inbox, 0, 0), 'out-of-bounds');
    expectStorageError(() => storage.copy(fixture.ram, 0, fixture.inbox, 4, 1), 'out-of-bounds');
    expectStorageError(
      () => storage.copy(fixture.ram, 0, fixture.inbox, 0xffffffff, 1),
      'out-of-bounds',
    );
    expectStorageError(
      () => storage.copy(fixture.ram, 0, fixture.inbox, 0, 0x1_0000_0000),
      'invalid-argument',
    );
    expectStorageError(
      () => storage.copy(fixture.ram, 0, fixture.inbox, 0, -1),
      'invalid-argument',
    );
    expectStorageError(
      () => storage.copy(fixture.ram, 0, fixture.inbox, 1.5, 1),
      'invalid-argument',
    );
    expectStorageError(
      () => storage.copy(fixture.ram, 0, fixture.ram, 0, 0xffffffff),
      'out-of-bounds',
    );
    expectStorageError(() => storage.copy(fixture.empty, 1, fixture.inbox, 4, 0), 'out-of-bounds');
    expectStorageError(() => storage.loadBytes('u8', 'little', fixture.empty, 0), 'out-of-bounds');
  });

  it('rejects references from another module and malformed declarations', () => {
    const first = createFixture();
    const second = createFixture();

    expectStorageError(() => first.storage.loadState(second.flag), 'invalid-resource');
    expectStorageError(
      () => first.storage.loadBytes('u8', 'little', second.ram, 0),
      'invalid-resource',
    );
    expectStorageError(() => first.storage.loadState({} as never), 'invalid-resource');
    expectStorageError(
      () => first.storage.loadBytes('u8', 'little', first.byte as never, 0),
      'invalid-resource',
    );
    expectStorageError(
      () => first.storage.copy(first.ram, 0, first.words as never, 0, 1),
      'invalid-resource',
    );

    const malformedRef = { [refKind]: 'bytes', [byteReadonly]: false };
    const malformed = {
      memories: [
        {
          name: 'bad',
          kind: 'bytes',
          layout: { kind: 'bytes', length: 1, unitBytes: 0 },
          writable: true,
          initial: [0],
          ref: malformedRef,
        },
      ],
    } as unknown as IRModule;
    expectStorageError(() => createIRStorage(malformed), 'invalid-resource');
  });

  it('isolates instances and declaration input buffers', () => {
    const source = new Uint8Array([1, 2, 3]);
    const arrayInitial = [7, 8];
    const module = createIRModule();
    const ram = module.bytes('ram', source, { readonly: false });
    const duplicate = module.bytes('duplicate', source, { readonly: false });
    const state = module.state('state', 'u8', 5);
    const array = module.array('array', 'u8', arrayInitial);
    const first = createIRStorage(module);
    const second = createIRStorage(module);

    source[0] = 0xaa;
    arrayInitial[0] = 99;
    expect(first.loadBytes('u8', 'little', ram, 0)).toBe(1);
    expect(second.loadBytes('u8', 'little', ram, 0)).toBe(1);
    expect(first.loadBytes('u8', 'little', duplicate, 0)).toBe(1);
    first.storeBytes('u8', 'little', ram, 0, 9);
    first.storeState(state, 6);
    first.storeArray(array, 0, 10);
    expect(first.loadBytes('u8', 'little', ram, 0)).toBe(9);
    expect(second.loadBytes('u8', 'little', ram, 0)).toBe(1);
    expect(first.loadBytes('u8', 'little', duplicate, 0)).toBe(1);
    expect(first.loadState(state)).toBe(6);
    expect(second.loadState(state)).toBe(5);
    expect(first.loadArray(array, 0)).toBe(10);
    expect(second.loadArray(array, 0)).toBe(7);
  });

  it('preserves raw float bits for movement and returns immutable FloatBits', () => {
    const fixture = createFixture();
    const { storage } = fixture;

    storage.storeState(fixture.single, { type: 'f32', bits: '0x7fc01234' });
    const single = storage.loadState(fixture.single);
    expect(single).toEqual({ type: 'f32', bits: '0x7fc01234' });
    expect(Object.isFrozen(single)).toBe(true);
    expect(() => {
      (single as unknown as { bits: string }).bits = '0x0';
    }).toThrow();

    storage.storeState(fixture.double, { type: 'f64', bits: '0x7ff8000000001234' });
    expect(storage.loadState(fixture.double)).toEqual({
      type: 'f64',
      bits: '0x7ff8000000001234',
    });

    storage.storeState(fixture.single, -0);
    expect(storage.loadState(fixture.single)).toEqual({ type: 'f32', bits: '0x80000000' });
    storage.storeState(fixture.single, Number.NaN);
    expect(storage.loadState(fixture.single)).toEqual({ type: 'f32', bits: '0x7fc00000' });
    storage.storeState(fixture.double, Number.NaN);
    expect(storage.loadState(fixture.double)).toEqual({
      type: 'f64',
      bits: '0x7ff8000000000000',
    });

    storage.storeBytes('f32', 'little', fixture.ram, 1, {
      type: 'f32',
      bits: '0x7fc01234',
    });
    storage.copy(fixture.ram, 5, fixture.ram, 1, 4);
    expect(storage.loadBytes('f32', 'little', fixture.ram, 5)).toEqual({
      type: 'f32',
      bits: '0x7fc01234',
    });

    expectStorageError(
      () => storage.storeState(fixture.single, { type: 'f64', bits: '0x7ff8000000001234' }),
      'invalid-value',
    );
    expectStorageError(
      () => storage.storeState(fixture.double, { type: 'f32', bits: '0x7fc01234' }),
      'invalid-value',
    );
    expectStorageError(
      () => storage.storeState(fixture.single, { type: 'f32', bits: '0x7fc0123' }),
      'invalid-value',
    );
    expectStorageError(
      () =>
        storage.storeState(fixture.single, { type: 'f32', bits: 'nope' } as unknown as FloatBits),
      'invalid-value',
    );
  });

  it('does not expose a writable buffer or version state', () => {
    const fixture = createFixture();
    const storage = fixture.storage as unknown as Record<string, unknown>;
    expect(Object.keys(storage)).toEqual([]);
    expect('buffer' in storage).toBe(false);
    expect('version' in storage).toBe(false);
    expect('versions' in storage).toBe(false);
  });
});

function storageInternalsOf(storage: IRStorage): StorageInternals {
  return (storage as unknown as { readonly [storageInternals]: StorageInternals })[
    storageInternals
  ];
}

describe('storage internals fast path', () => {
  it('bumps the epoch exactly when a unit map is reassigned', () => {
    const fixture = createFixture();
    const storage = createIRStorage(fixture.module, { updateResources: [fixture.ram] });
    const fast = storageInternalsOf(storage);
    const tracked = storage as unknown as IRProviderTrackedReads;
    expect(fast.control).toEqual({ epoch: 0, suspended: 0 });

    // Public reads and stores with no tracked unit leave every unit map untouched.
    expect(storage.loadState(fixture.word)).toBe(0x1234);
    expect(storage.loadArray(fixture.words, 1)).toBe(0x3344);
    expect(storage.loadBytes('u8', 'little', fixture.ram, 0)).toBe(0x11);
    storage.storeBytes('u8', 'little', fixture.ram, 0, 0x11);
    storage.copy(fixture.ram, 1, fixture.ram, 0, 1);
    storage.storeState(fixture.word, 0x1234);
    expect(fast.control.epoch).toBe(0);

    // Lazy unit creation counts as a rewrite.
    tracked[providerReadState](fixture.word);
    expect(fast.control.epoch).toBe(1);
    // A tracked store advances the whole-resource unit even for an identical value.
    storage.storeState(fixture.word, 0x1234);
    expect(fast.control.epoch).toBe(2);
    tracked[providerReadArray](fixture.words, 0);
    expect(fast.control.epoch).toBe(3);
    storage.storeArray(fixture.words, 0, 0x1122);
    expect(fast.control.epoch).toBe(4);
    // Untracked resources are unaffected.
    storage.storeState(fixture.dword, 1);
    expect(fast.control.epoch).toBe(4);

    // Versioned byte reads lazily mint units.
    const firstRead = storage.readVersionedBytes(fixture.ram, 0, 2);
    expect(fast.control.epoch).toBe(5);
    const secondRead = storage.readVersionedBytes(fixture.ram, 0, 2);
    expect(fast.control.epoch).toBe(6);
    // I3: the epoch moved even though the tokens are unchanged and still valid.
    expect(secondRead.dependencies).toEqual(firstRead.dependencies);
    expect(storage.validateDependencies(firstRead.dependencies)).toBe(true);

    const beforeWrites = fast.control.epoch;
    storage.storeBytes('u8', 'little', fixture.ram, 0, 0x99);
    storage.updateBytes(fixture.ram, 0, fixture.ram, 0, 1);
    storage.fillBytes(fixture.ram, 0, 1, 0);
    storage.updateBytesFromBytes(fixture.ram, 0, new Uint8Array([1]));
    storage.writeInbox(fixture.inbox, 0, new Uint8Array([1]));
    storage.writeInbox(fixture.inbox, 0, new Uint8Array(0));
    expect(fast.control.epoch).toBe(beforeWrites + 4);
  });

  it('keeps dependency tokens valid while the epoch is unchanged (I1)', () => {
    const fixture = createFixture();
    const storage = createIRStorage(fixture.module, { updateResources: [fixture.ram] });
    const fast = storageInternalsOf(storage);
    const read = storage.readVersionedBytes(fixture.ram, 0, 2);
    const epoch = fast.control.epoch;
    expect(storage.validateDependencies(read.dependencies)).toBe(true);

    storage.loadBytes('u8', 'little', fixture.ram, 0);
    storage.storeBytes('u8', 'little', fixture.ram, 0, 1);
    storage.copy(fixture.ram, 1, fixture.ram, 0, 1);
    expect(fast.control.epoch).toBe(epoch);
    expect(storage.validateDependencies(read.dependencies)).toBe(true);

    storage.updateBytesFromBytes(fixture.ram, 0, new Uint8Array([2]));
    expect(fast.control.epoch).toBeGreaterThan(epoch);
    expect(storage.validateDependencies(read.dependencies)).toBe(false);
  });

  it('mirrors the suspension depth on the control block', () => {
    const fixture = createFixture();
    const fast = storageInternalsOf(fixture.storage);
    expect(fast.control.suspended).toBe(0);

    suspendStorageWrites(fixture.storage);
    suspendStorageWrites(fixture.storage);
    expect(fast.control.suspended).toBe(2);
    resumeStorageWrites(fixture.storage);
    expect(fast.control.suspended).toBe(1);
    const error = expectStorageError(
      () => fixture.storage.storeState(fixture.word, 1),
      'unauthorized-resource',
    );
    expect(error.message).toBe('Storage writes are suspended during provider generation');

    resumeStorageWrites(fixture.storage);
    expect(fast.control.suspended).toBe(0);
    fixture.storage.storeState(fixture.word, 1);
    expect(fixture.storage.loadState(fixture.word)).toBe(1);
  });

  it('exposes record internals without widening the public contract', () => {
    const fixture = createFixture();
    const fast = storageInternalsOf(fixture.storage);
    expect(fast.littleEndianHost).toBe(true);

    const state = fast.scalar(fixture.word, 'state', 'test state');
    expect(state.kind).toBe('state');
    expect(state.scalarType).toBe('u16');
    expect(state.length).toBe(1);
    expect(state.width).toBe(2);
    expect(state.view).toBeInstanceOf(Uint16Array);
    expect(state.raw).toBeUndefined();
    expect(state.tracked()).toBe(false);
    expect(state.bytes.byteOffset).toBe(0);
    expect(state.view!.buffer).toBe(state.bytes.buffer);

    const record = fast.bytes(fixture.ram, true, 'test bytes');
    expect(record.kind).toBe('bytes');
    expect(record.writable).toBe(true);
    expect(record.length).toBe(RAM.length);
    expect(record.unitBytes).toBe(RAM.length);
    expect(record.data).toBeInstanceOf(DataView);
    expect(record.data.byteLength).toBe(RAM.length);
    expect(record.data.getUint8(0)).toBe(0x11);

    const wideModule = createIRModule();
    const wideArray = wideModule.array('wide', 'f64', [1, 2]);
    const singleModule = createIRModule();
    const singleArray = singleModule.array('single', 'f32', [1, 2]);
    const wideRecord = storageInternalsOf(createIRStorage(wideModule)).scalar(
      wideArray,
      'array',
      'wide',
    );
    const singleRecord = storageInternalsOf(createIRStorage(singleModule)).scalar(
      singleArray,
      'array',
      'single',
    );
    expect(wideRecord.view).toBeInstanceOf(Float64Array);
    expect(wideRecord.raw).toHaveLength(4);
    expect(singleRecord.view).toBeInstanceOf(Float32Array);
    expect(singleRecord.raw).toHaveLength(2);

    expectStorageError(() => fast.bytes(fixture.rom, true, 'test bytes'), 'readonly-resource');
    expectStorageError(() => fast.scalar(fixture.ram, 'state', 'test state'), 'invalid-resource');
  });

  it('advances a tracked scalar after a direct typed-view write', () => {
    const fixture = createFixture();
    const fast = storageInternalsOf(fixture.storage);
    const reads = fixture.storage as unknown as IRProviderTrackedReads;
    const token = reads[providerReadState](fixture.word).dependencies;
    const record = fast.scalar(fixture.word, 'state', 'test state', true);
    expect(record.tracked()).toBe(true);

    (record.view as unknown as { [index: number]: number })[0] = 0xabcd;
    expect(fixture.storage.loadState(fixture.word)).toBe(0xabcd);
    advanceScalar(record);
    expect(fixture.storage.validateDependencies(token)).toBe(false);

    const next = reads[providerReadState](fixture.word);
    expect(next.value).toBe(0xabcd);
    expect(fixture.storage.validateDependencies(next.dependencies)).toBe(true);

    // Untracked records ignore advanceScalar entirely.
    const fresh = createIRStorage(fixture.module);
    const freshFast = storageInternalsOf(fresh);
    const untracked = freshFast.scalar(fixture.word, 'state', 'test state', true);
    const before = freshFast.control.epoch;
    advanceScalar(untracked);
    expect(freshFast.control.epoch).toBe(before);
  });

  it('writes every scalar type through the typed views like the public path', () => {
    const cases: readonly { type: ScalarType; value: RuntimeScalar }[] = [
      { type: 'bool', value: true },
      { type: 'u8', value: 0xa5 },
      { type: 'u16', value: 0xbeef },
      { type: 'u32', value: 0xdeadbeef },
      { type: 'i8', value: -0x71 },
      { type: 'i16', value: -0x1234 },
      { type: 'i32', value: -0x1234567 },
      { type: 'f32', value: 1.5 },
      { type: 'f64', value: 0.1 },
      { type: 'f32', value: Number.NaN },
      { type: 'f32', value: -0 },
      { type: 'f32', value: 2 ** -149 },
      { type: 'f64', value: Number.NaN },
      { type: 'f64', value: -0 },
      { type: 'f64', value: 5e-324 },
    ];
    for (const { type, value } of cases) {
      const module = createIRModule();
      const initial = type === 'bool' ? false : 0;
      const slot = module.array('slot', type, [initial, initial]);
      const storage = createIRStorage(module);
      const record = storageInternalsOf(storage).scalar(slot, 'array', 'slot', true);
      const index = 1;

      // Reference bytes and value come from the checked public path.
      storage.storeArray(slot, index, value);
      const expectedBytes = Uint8Array.from(record.bytes);
      const expected = storage.loadArray(slot, index);

      // Clear, then write the same value through the JIT fast path.
      record.bytes.fill(0);
      if ((type === 'f32' || type === 'f64') && typeof value === 'number' && Number.isNaN(value)) {
        if (type === 'f32') {
          record.raw![index] = 0x7fc00000;
        } else {
          record.raw![index * 2] = 0;
          record.raw![index * 2 + 1] = 0x7ff80000;
        }
      } else {
        (record.view as unknown as { [index: number]: number })[index] =
          typeof value === 'boolean' ? (value ? 1 : 0) : (value as number);
      }
      expect(Uint8Array.from(record.bytes)).toEqual(expectedBytes);
      expect(storage.loadArray(slot, index)).toEqual(expected);
    }
  });

  it('omits typed views on big-endian hosts', () => {
    const fixture = createFixture();
    try {
      setLittleEndianHostProbe(() => false);
      const storage = createIRStorage(fixture.module);
      const fast = storageInternalsOf(storage);
      expect(fast.littleEndianHost).toBe(false);

      const scalar = fast.scalar(fixture.word, 'state', 'test state');
      expect(scalar.view).toBeUndefined();
      expect(scalar.raw).toBeUndefined();
      expect(storage.loadState(fixture.word)).toBe(0x1234);
      storage.storeState(fixture.word, 0xabcd);
      expect(storage.loadState(fixture.word)).toBe(0xabcd);

      const record = fast.bytes(fixture.ram, true, 'test bytes');
      expect(record.data.getUint8(0)).toBe(0x11);
      storage.storeBytes('u16', 'little', fixture.ram, 0, 0x0102);
      expect(storage.loadBytes('u16', 'little', fixture.ram, 0)).toBe(0x0102);
    } finally {
      setLittleEndianHostProbe();
    }
  });

  it('keeps #setUnits as the only unit-map assignment', () => {
    const source = readFileSync(new URL('./storage.ts', import.meta.url), 'utf8');
    expect(source.match(/\.units\s*=/g) ?? []).toHaveLength(1);
    expect(source).toMatch(/#setUnits\([^)]*\)[^{]*\{\s*record\.units = units;/);
  });

  describe('dump', () => {
    it('snapshots every scalar, array, and byte resource by name', () => {
      const fixture = createFixture();
      fixture.storage.storeState(fixture.dword, 0x01020304);
      fixture.storage.storeArray(fixture.words, 1, 0xbeef);
      fixture.storage.storeBytes('u16', 'big', fixture.ram, 0, 0xcafe);
      fixture.storage.writeInbox(fixture.inbox, 0, new Uint8Array([7, 8]));

      const snapshot = fixture.storage.dump();

      expect([...snapshot.scalars.keys()]).toEqual([
        'flag',
        'byte',
        'word',
        'dword',
        'sbyte',
        'sword',
        'sdword',
        'single',
        'double',
      ]);
      expect(snapshot.scalars.get('flag')).toBe(false);
      expect(snapshot.scalars.get('byte')).toBe(0);
      expect(snapshot.scalars.get('word')).toBe(0x1234);
      expect(snapshot.scalars.get('dword')).toBe(0x01020304);
      expect(snapshot.scalars.get('sbyte')).toBe(-1);
      expect(snapshot.scalars.get('single')).toEqual<FloatBits>({
        type: 'f32',
        bits: '0x3fc00000',
      });
      expect(snapshot.scalars.get('double')).toEqual<FloatBits>({
        type: 'f64',
        bits: '0x3fb999999999999a',
      });

      expect([...snapshot.arrays.keys()]).toEqual(['words', 'emptyArray']);
      expect(snapshot.arrays.get('words')).toEqual([0x1122, 0xbeef]);
      expect(snapshot.arrays.get('emptyArray')).toEqual([]);

      expect([...snapshot.bytes.keys()]).toEqual(['ram', 'rom', 'input', 'empty']);
      const ram = snapshot.bytes.get('ram')!;
      expect(Array.from(ram.subarray(0, 4))).toEqual([0xca, 0xfe, 0x33, 0x44]);
      expect(Array.from(snapshot.bytes.get('rom')!)).toEqual([
        0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
      ]);
      expect(Array.from(snapshot.bytes.get('input')!)).toEqual([7, 8, 0, 0]);
      expect(snapshot.bytes.get('empty')!.length).toBe(0);
    });

    it('returns deep copies that never share storage buffers', () => {
      const fixture = createFixture();
      const snapshot = fixture.storage.dump();
      snapshot.bytes.get('ram')![0] = 0xff;
      fixture.storage.storeBytes('u8', 'little', fixture.ram, 1, 0xee);

      expect(fixture.storage.loadBytes('u8', 'little', fixture.ram, 0)).toBe(0x11);
      expect(snapshot.bytes.get('ram')![1]).toBe(0x22);
      expect(snapshot.scalars.get('single')).not.toBe(fixture.storage.loadState(fixture.single));
      expect(snapshot.arrays.get('words')).not.toBe(fixture.storage.dump().arrays.get('words'));
    });

    it('does not mint version units or observe writes as reads', () => {
      const fixture = createFixture();
      const control = storageInternalsOf(fixture.storage).control;
      const before = control.epoch;
      const first = fixture.storage.dump();
      const second = fixture.storage.dump();
      expect(control.epoch).toBe(before);
      expect([...first.scalars]).toEqual([...second.scalars]);
      expect(second.scalars.get('flag')).toBe(fixture.storage.loadState(fixture.flag));
    });

    it('keeps NaN payload bits exactly as stored', () => {
      const fixture = createFixture();
      fixture.storage.storeState(fixture.single, { type: 'f32', bits: '0x7fa00001' });
      expect(fixture.storage.dump().scalars.get('single')).toEqual<FloatBits>({
        type: 'f32',
        bits: '0x7fa00001',
      });
    });
  });
});
