import { describe, expect, it, vi } from 'vitest';
import {
  createIRModule,
  createIRStorage,
  IRStorageError,
  type BytesRef,
  type IRResourceDependency,
  type IRStorageErrorCode,
} from './index';

function expectStorageError(run: () => unknown, code: IRStorageErrorCode): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(IRStorageError);
  expect((caught as IRStorageError).code).toBe(code);
}

function fixture() {
  const module = createIRModule();
  const ram = module.bytes('ram', new Uint8Array([1, 2, 3, 4, 5, 6, 7]), {
    readonly: false,
    unitBytes: 2,
  });
  const rom = module.bytes('rom', new Uint8Array([8, 9, 10, 11, 12, 13, 14]), {
    readonly: true,
    unitBytes: 2,
  });
  const inbox = module.inbox('inbox', 3);
  const empty = module.bytes('empty', new Uint8Array(), { readonly: false });
  const state = module.state('state', 'u8', 0);
  const array = module.array('array', 'u8', [0]);
  const storage = createIRStorage(module, { updateResources: [ram, rom, empty] });
  return { module, storage, ram, rom, inbox, empty, state, array };
}

function expectStableIdentities(
  before: readonly IRResourceDependency[],
  after: readonly IRResourceDependency[],
  changed: readonly number[],
): void {
  expect(after).toHaveLength(before.length);
  for (let index = 0; index < before.length; index += 1) {
    expect(after[index]!.resource).toBe(before[index]!.resource);
    expect(after[index]!.unit).toBe(before[index]!.unit);
    if (changed.includes(index)) {
      expect(after[index]!.version).not.toBe(before[index]!.version);
    } else {
      expect(after[index]!.version).toBe(before[index]!.version);
    }
  }
}

describe('@mica/ir standalone resource storage', () => {
  it('requires explicit update authorization independently of ordinary writability', () => {
    const { module, ram, rom, inbox } = fixture();
    for (const storage of [createIRStorage(module), createIRStorage(module, {})]) {
      storage.storeBytes('u8', 'little', ram, 0, 42);
      expectStorageError(() => storage.fillBytes(ram, 0, 1, 42), 'unauthorized-resource');
      expectStorageError(() => storage.updateBytes(ram, 0, rom, 0, 1), 'unauthorized-resource');
      expectStorageError(() => storage.fillBytes(rom, 0, 0, 0), 'unauthorized-resource');
      expectStorageError(() => storage.updateBytes(rom, 7, inbox, 3, 0), 'unauthorized-resource');
      expect(storage.loadBytes('u8', 'little', ram, 0)).toBe(42);
    }
  });

  it('updates readonly bytes without enabling ordinary writes, and reads inbox sources', () => {
    const { storage, rom, ram, inbox } = fixture();
    const before = storage.readVersionedBytes(rom, 0, 7);
    storage.fillBytes(rom, 1, 3, 0xff);
    storage.updateBytes(rom, 4, inbox, 0, 3);
    expect(storage.readVersionedBytes(rom, 0, 7).bytes).toEqual(
      new Uint8Array([8, 255, 255, 255, 0, 0, 0]),
    );
    expect(storage.validateDependencies(before.dependencies)).toBe(false);
    expectStorageError(
      () => storage.storeBytes('u8', 'little', rom as never, 0, 1),
      'readonly-resource',
    );
    expectStorageError(() => storage.copy(rom as never, 0, ram, 0, 1), 'readonly-resource');
    expectStorageError(() => storage.fillBytes(inbox as never, 0, 0, 0), 'invalid-resource');
    expectStorageError(() => storage.updateBytes(inbox as never, 0, ram, 0, 0), 'invalid-resource');
    const input = storage.readVersionedBytes(inbox, 0, 3);
    expect(input.bytes).toEqual(new Uint8Array(3));
    expect(input.dependencies).toHaveLength(1);
    expect(storage.validateDependencies(input.dependencies)).toBe(true);
  });

  it.each([null, false, 1, 'options', []])('rejects invalid options %j', (options) => {
    const { module } = fixture();
    expectStorageError(() => createIRStorage(module, options as never), 'invalid-argument');
  });

  it.each([null, false, 1, 'resources', {}, new Set(), new Uint8Array()])(
    'rejects a non-array authorization list %j',
    (updateResources) => {
      const { module } = fixture();
      expectStorageError(
        () => createIRStorage(module, { updateResources: updateResources as never }),
        'invalid-argument',
      );
    },
  );

  it('rejects scalar, array, inbox, forged, foreign, missing and primitive authorization refs', () => {
    const { module, state, array, inbox, ram } = fixture();
    const foreign = fixture().ram;
    for (const ref of [state, array, inbox, { ...ram }, foreign, null, undefined, 1]) {
      expectStorageError(
        () => createIRStorage(module, { updateResources: [ref as never] }),
        'invalid-resource',
      );
    }
    expectStorageError(
      () => createIRStorage(module, { updateResources: new Array<BytesRef>(1) }),
      'invalid-resource',
    );
  });

  it('captures the authorization list instead of retaining caller mutations', () => {
    const { module, ram, rom } = fixture();
    const updateResources: BytesRef[] = [ram, ram];
    const options = { updateResources };
    const storage = createIRStorage(module, options);
    updateResources.splice(0, 2, rom);
    options.updateResources = [rom];
    storage.fillBytes(ram, 0, 1, 99);
    expect(storage.loadBytes('u8', 'little', ram, 0)).toBe(99);
    expectStorageError(() => storage.fillBytes(rom, 0, 1, 99), 'unauthorized-resource');
  });

  it('returns detached mutable bytes with frozen dependencies and opaque frozen identities', () => {
    const { storage, ram } = fixture();
    const first = storage.readVersionedBytes(ram, 1, 5);
    const second = storage.readVersionedBytes(ram, 1, 5);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.dependencies)).toBe(true);
    expect(first.bytes).toEqual(new Uint8Array([2, 3, 4, 5, 6]));
    expect(first.bytes).not.toBe(second.bytes);
    expect(first.bytes.buffer).not.toBe(second.bytes.buffer);
    expect(first.dependencies).toHaveLength(3);
    expectStableIdentities(first.dependencies, second.dependencies, []);
    for (const dependency of first.dependencies) {
      expect(Object.isFrozen(dependency)).toBe(true);
      for (const identity of [dependency.resource, dependency.unit, dependency.version]) {
        expect(typeof identity).toBe('object');
        expect(identity).not.toBeNull();
        expect(Object.isFrozen(identity)).toBe(true);
        expect(Reflect.ownKeys(identity)).toEqual([]);
      }
      expect(dependency.resource).toBe(first.dependencies[0]!.resource);
    }
    expect(new Set(first.dependencies.map((dependency) => dependency.unit)).size).toBe(3);
    expect(new Set(first.dependencies.map((dependency) => dependency.version)).size).toBe(3);
    first.bytes.fill(255);
    expect(second.bytes).toEqual(new Uint8Array([2, 3, 4, 5, 6]));
    expect(storage.readVersionedBytes(ram, 1, 5).bytes).toEqual(second.bytes);
    expect(storage.validateDependencies(first.dependencies)).toBe(true);
    storage.fillBytes(ram, 1, 1, 10);
    expect(second.bytes).toEqual(new Uint8Array([2, 3, 4, 5, 6]));
    expect(storage.validateDependencies(first.dependencies)).toBe(false);
  });

  it.each(['fill', 'copy'] as const)(
    '%s invalidates every unaligned covered unit, but no other unit or resource',
    (operation) => {
      const { storage, ram, rom } = fixture();
      const before = storage.readVersionedBytes(ram, 0, 7);
      const source = storage.readVersionedBytes(rom, 0, 7);
      if (operation === 'fill') storage.fillBytes(ram, 1, 4, 0);
      else storage.updateBytes(ram, 1, rom, 2, 4);
      const after = storage.readVersionedBytes(ram, 0, 7);
      expect(after.bytes).toEqual(
        new Uint8Array(operation === 'fill' ? [1, 0, 0, 0, 0, 6, 7] : [1, 10, 11, 12, 13, 6, 7]),
      );
      expectStableIdentities(before.dependencies, after.dependencies, [0, 1, 2]);
      for (let index = 0; index < before.dependencies.length; index += 1) {
        expect(storage.validateDependencies([before.dependencies[index]!])).toBe(index === 3);
      }
      expect(storage.validateDependencies(source.dependencies)).toBe(true);
      expect(storage.validateDependencies(after.dependencies)).toBe(true);
      expect(after.dependencies[0]!.resource).not.toBe(source.dependencies[0]!.resource);
      expect(after.dependencies[0]!.unit).not.toBe(source.dependencies[0]!.unit);
    },
  );

  it('does not invalidate the next unit when a range ends exactly at its boundary', () => {
    const { storage, ram } = fixture();
    const before = storage.readVersionedBytes(ram, 0, 7);
    storage.fillBytes(ram, 1, 1, 255);
    expectStableIdentities(
      before.dependencies,
      storage.readVersionedBytes(ram, 0, 7).dependencies,
      [0],
    );
  });

  it('keeps fixed units for partial tails and units larger than the resource', () => {
    const module = createIRModule();
    const partial = module.bytes('partial', new Uint8Array(7), { readonly: true, unitBytes: 3 });
    const large = module.bytes('large', new Uint8Array(2), { readonly: true, unitBytes: 100 });
    const storage = createIRStorage(module, { updateResources: [partial, large] });
    const before = storage.readVersionedBytes(partial, 0, 7);
    expect(before.dependencies).toHaveLength(3);
    const tail = storage.readVersionedBytes(partial, 6, 1);
    expect(tail.dependencies[0]!.unit).toBe(before.dependencies[2]!.unit);
    storage.fillBytes(partial, 6, 1, 255);
    expectStableIdentities(
      before.dependencies,
      storage.readVersionedBytes(partial, 0, 7).dependencies,
      [2],
    );
    const wide = storage.readVersionedBytes(large, 0, 1);
    const otherByte = storage.readVersionedBytes(large, 1, 1);
    expect(wide.dependencies).toHaveLength(1);
    expect(wide.dependencies[0]!.unit).toBe(otherByte.dependencies[0]!.unit);
    storage.fillBytes(large, 1, 1, 255);
    expect(storage.validateDependencies(wide.dependencies)).toBe(false);
    expectStableIdentities(
      wide.dependencies,
      storage.readVersionedBytes(large, 0, 1).dependencies,
      [0],
    );
  });

  it('keeps zero-capacity resources unitless and checks zero-length endpoints', () => {
    const { storage, ram, rom, empty, inbox } = fixture();
    const before = storage.readVersionedBytes(ram, 0, 7);
    storage.fillBytes(empty, 0, 0, 255);
    storage.updateBytes(empty, 0, inbox, 3, 0);
    storage.updateBytes(ram, 7, empty, 0, 0);
    storage.updateBytes(ram, 7, rom, 7, 0);
    storage.fillBytes(ram, 7, 0, 0);
    for (const [ref, offset] of [
      [empty, 0],
      [ram, 7],
      [inbox, 3],
    ] as const) {
      const read = storage.readVersionedBytes(ref, offset, 0);
      expect(read.bytes).toEqual(new Uint8Array());
      expect(read.dependencies).toEqual([]);
      expect(Object.isFrozen(read.dependencies)).toBe(true);
    }
    expectStableIdentities(
      before.dependencies,
      storage.readVersionedBytes(ram, 0, 7).dependencies,
      [],
    );
    for (const run of [
      () => storage.fillBytes(empty, 1, 0, 0),
      () => storage.fillBytes(empty, 0, 1, 0),
      () => storage.updateBytes(ram, 8, rom, 0, 0),
      () => storage.updateBytes(ram, 0, rom, 8, 0),
      () => storage.readVersionedBytes(empty, 1, 0),
      () => storage.readVersionedBytes(empty, 0, 1),
      () => storage.readVersionedBytes(ram, 8, 0),
    ])
      expectStorageError(run, 'out-of-bounds');
  });

  it.each([
    [1, 0, [1, 1, 2, 3, 4, 5, 7], [0, 1, 2]],
    [0, 1, [2, 3, 4, 5, 6, 6, 7], [0, 1, 2]],
  ] as const)(
    'snapshots overlapping updates from %i to %i',
    (destination, source, expected, changed) => {
      const { storage, ram } = fixture();
      const before = storage.readVersionedBytes(ram, 0, 7);
      storage.updateBytes(ram, destination, ram, source, 5);
      expect(storage.readVersionedBytes(ram, 0, 7).bytes).toEqual(new Uint8Array(expected));
      expectStableIdentities(
        before.dependencies,
        storage.readVersionedBytes(ram, 0, 7).dependencies,
        changed,
      );
    },
  );

  it('never reuses versions for same-value updates or an ABA byte sequence', () => {
    const { storage, ram } = fixture();
    const original = storage.readVersionedBytes(ram, 0, 2);
    storage.fillBytes(ram, 0, 1, 1);
    const sameFill = storage.readVersionedBytes(ram, 0, 2);
    storage.updateBytes(ram, 0, ram, 0, 1);
    const sameCopy = storage.readVersionedBytes(ram, 0, 2);
    storage.fillBytes(ram, 0, 1, 99);
    const intermediate = storage.readVersionedBytes(ram, 0, 2);
    storage.fillBytes(ram, 0, 1, 1);
    const restored = storage.readVersionedBytes(ram, 0, 2);
    expect(restored.bytes).toEqual(original.bytes);
    const snapshots = [original, sameFill, sameCopy, intermediate, restored];
    expect(new Set(snapshots.map((read) => read.dependencies[0]!.version)).size).toBe(5);
    for (const read of snapshots.slice(0, -1)) {
      expect(storage.validateDependencies(read.dependencies)).toBe(false);
      expect(read.dependencies[0]!.unit).toBe(restored.dependencies[0]!.unit);
    }
    expect(storage.validateDependencies(restored.dependencies)).toBe(true);
  });

  it('does not change versions for ordinary stores or copies and preserves raw float bits', () => {
    const module = createIRModule();
    const ram = module.bytes('ram', new Uint8Array(24), { readonly: false, unitBytes: 4 });
    const storage = createIRStorage(module, { updateResources: [ram] });
    const before = storage.readVersionedBytes(ram, 0, 24);
    storage.storeBytes('f32', 'little', ram, 0, { type: 'f32', bits: '0x7fc01234' });
    storage.storeBytes('f64', 'big', ram, 4, { type: 'f64', bits: '0x8000000000000000' });
    storage.copy(ram, 12, ram, 0, 12);
    expect(storage.loadBytes('f32', 'little', ram, 12)).toEqual({
      type: 'f32',
      bits: '0x7fc01234',
    });
    expect(storage.loadBytes('f64', 'big', ram, 16)).toEqual({
      type: 'f64',
      bits: '0x8000000000000000',
    });
    expect(storage.validateDependencies(before.dependencies)).toBe(true);
    expectStableIdentities(
      before.dependencies,
      storage.readVersionedBytes(ram, 0, 24).dependencies,
      [],
    );
    storage.updateBytes(ram, 0, ram, 12, 12);
    expect(storage.loadBytes('f32', 'little', ram, 0)).toEqual({ type: 'f32', bits: '0x7fc01234' });
    expect(storage.loadBytes('f64', 'big', ram, 4)).toEqual({
      type: 'f64',
      bits: '0x8000000000000000',
    });
    expectStableIdentities(
      before.dependencies,
      storage.readVersionedBytes(ram, 0, 24).dependencies,
      [0, 1, 2],
    );
    expect(before.bytes).toEqual(new Uint8Array(24));
  });

  it('validates retained and combined dependencies but rejects stale, forged and foreign identities', () => {
    const { module, storage, ram, rom } = fixture();
    const first = storage.readVersionedBytes(ram, 0, 7);
    const otherResource = storage.readVersionedBytes(rom, 0, 1);
    const otherStorage = createIRStorage(module, { updateResources: [ram] });
    const other = otherStorage.readVersionedBytes(ram, 0, 7);
    const dependency = first.dependencies[0]!;
    expect(storage.validateDependencies([])).toBe(true);
    expect(
      storage.validateDependencies([...first.dependencies, ...otherResource.dependencies]),
    ).toBe(true);
    expect(storage.validateDependencies([dependency, dependency])).toBe(true);
    expect(storage.validateDependencies(other.dependencies)).toBe(false);
    expect(otherStorage.validateDependencies(first.dependencies)).toBe(false);
    expect(other.dependencies[0]!.resource).not.toBe(dependency.resource);
    expect(other.dependencies[0]!.unit).not.toBe(dependency.unit);
    expect(other.dependencies[0]!.version).not.toBe(dependency.version);
    for (const forged of [
      { ...dependency },
      Object.freeze({ ...dependency }),
      { ...dependency, resource: otherResource.dependencies[0]!.resource },
      { ...dependency, unit: first.dependencies[1]!.unit },
      { ...dependency, version: other.dependencies[0]!.version },
      Object.create(dependency),
    ])
      expect(storage.validateDependencies([forged])).toBe(false);
    storage.fillBytes(ram, 0, 1, 0);
    expect(storage.validateDependencies(first.dependencies)).toBe(false);
    expect(storage.validateDependencies(first.dependencies.slice(1))).toBe(true);
    expect(otherStorage.validateDependencies(other.dependencies)).toBe(true);
    const current = storage.readVersionedBytes(ram, 0, 7);
    expect(storage.validateDependencies([...current.dependencies, dependency])).toBe(false);
  });

  it.each([
    null,
    undefined,
    false,
    1,
    'deps',
    {},
    new Set(),
    [null],
    [undefined],
    [1],
    [{}],
    new Array(1),
  ])('returns false for malformed dependencies %j', (dependencies) => {
    expect(fixture().storage.validateDependencies(dependencies as never)).toBe(false);
  });

  it('rejects wrong, foreign and forged refs even for zero-length operations', () => {
    const { storage, ram, state, array } = fixture();
    for (const ref of [state, array, fixture().ram, { ...ram }, null, undefined, 1, {}]) {
      expectStorageError(() => storage.readVersionedBytes(ref as never, 0, 0), 'invalid-resource');
      expectStorageError(() => storage.fillBytes(ref as never, 0, 0, 0), 'invalid-resource');
      expectStorageError(() => storage.updateBytes(ref as never, 0, ram, 0, 0), 'invalid-resource');
      expectStorageError(() => storage.updateBytes(ram, 0, ref as never, 0, 0), 'invalid-resource');
    }
  });

  it.each([-1, 0.5, 0x1_0000_0000, NaN, Infinity, -Infinity, '0', null, undefined, true, 0n])(
    'strictly checks all u32 arguments for %s without effects',
    (value) => {
      const { storage, ram, rom } = fixture();
      const before = storage.readVersionedBytes(ram, 0, 7);
      const invalid = value as number;
      for (const run of [
        () => storage.updateBytes(ram, invalid, rom, 0, 0),
        () => storage.updateBytes(ram, 0, rom, invalid, 0),
        () => storage.updateBytes(ram, 0, rom, 0, invalid),
        () => storage.fillBytes(ram, invalid, 0, 0),
        () => storage.fillBytes(ram, 0, invalid, 0),
        () => storage.readVersionedBytes(ram, invalid, 0),
        () => storage.readVersionedBytes(ram, 0, invalid),
      ])
        expectStorageError(run, 'invalid-argument');
      expect(storage.readVersionedBytes(ram, 0, 7).bytes).toEqual(before.bytes);
      expect(storage.validateDependencies(before.dependencies)).toBe(true);
    },
  );

  it.each([-1, 256, 0.5, NaN, Infinity, '0', null, undefined, false, 0n])(
    'strictly checks u8 fill value %s even for zero-length fills',
    (value) => {
      const { storage, ram, empty } = fixture();
      const before = storage.readVersionedBytes(ram, 0, 7);
      for (const length of [0, 1]) {
        expectStorageError(
          () => storage.fillBytes(ram, 0, length, value as number),
          'invalid-value',
        );
      }
      expectStorageError(() => storage.fillBytes(empty, 0, 0, value as number), 'invalid-value');
      expect(storage.readVersionedBytes(ram, 0, 7).bytes).toEqual(before.bytes);
      expect(storage.validateDependencies(before.dependencies)).toBe(true);
    },
  );

  it('validates full ranges without partial effects or undoing previous successful effects', () => {
    const { storage, ram, rom } = fixture();
    storage.fillBytes(ram, 0, 1, 255);
    const before = storage.readVersionedBytes(ram, 0, 7);
    const source = storage.readVersionedBytes(rom, 0, 7);
    for (const run of [
      () => storage.updateBytes(ram, 5, rom, 0, 3),
      () => storage.updateBytes(ram, 0, rom, 5, 3),
      () => storage.updateBytes(ram, 0xffffffff, rom, 0, 2),
      () => storage.updateBytes(ram, 0, rom, 0xffffffff, 2),
      () => storage.updateBytes(ram, 0, rom, 0, 0xffffffff),
      () => storage.fillBytes(ram, 6, 2, 0),
      () => storage.fillBytes(ram, 0xffffffff, 2, 0),
      () => storage.fillBytes(ram, 0, 0xffffffff, 0),
      () => storage.readVersionedBytes(ram, 6, 2),
      () => storage.readVersionedBytes(ram, 0xffffffff, 2),
      () => storage.readVersionedBytes(ram, 0, 0xffffffff),
    ]) {
      expectStorageError(run, 'out-of-bounds');
      expect(storage.readVersionedBytes(ram, 0, 7).bytes).toEqual(before.bytes);
      expect(storage.validateDependencies(before.dependencies)).toBe(true);
      expect(storage.validateDependencies(source.dependencies)).toBe(true);
    }
  });

  it('leaves bytes and versions unchanged when source snapshot allocation fails', () => {
    const { storage, ram, rom } = fixture();
    storage.fillBytes(ram, 0, 1, 255);
    const before = storage.readVersionedBytes(ram, 0, 7);
    const source = storage.readVersionedBytes(rom, 0, 7);
    let caught: unknown;
    const spy = vi.spyOn(Uint8Array.prototype, 'slice').mockImplementation(() => {
      throw new RangeError('Simulated snapshot allocation failure');
    });
    try {
      storage.updateBytes(ram, 1, rom, 0, 6);
    } catch (error) {
      caught = error;
    } finally {
      spy.mockRestore();
    }
    expectStorageError(() => {
      throw caught;
    }, 'allocation-failure');
    expect(storage.readVersionedBytes(ram, 0, 7).bytes).toEqual(before.bytes);
    expect(storage.readVersionedBytes(rom, 0, 7).bytes).toEqual(source.bytes);
    expect(storage.validateDependencies(before.dependencies)).toBe(true);
    expect(storage.validateDependencies(source.dependencies)).toBe(true);
    storage.updateBytes(ram, 1, rom, 0, 6);
    expect(storage.validateDependencies(before.dependencies)).toBe(false);
  });

  it.each(['fill', 'copy'] as const)(
    'prepares all %s version allocations before committing any byte or version',
    (operation) => {
      const { storage, ram, rom } = fixture();
      storage.fillBytes(ram, 0, 1, 255);
      const before = storage.readVersionedBytes(ram, 0, 7);
      const source = storage.readVersionedBytes(rom, 0, 7);
      const freeze = Object.freeze;
      let calls = 0;
      let caught: unknown;
      // Fail after at least one covered unit has been prepared.
      const spy = vi.spyOn(Object, 'freeze').mockImplementation((value) => {
        calls += 1;
        if (calls === 4) throw new RangeError('Simulated version allocation failure');
        return freeze(value);
      });
      try {
        if (operation === 'fill') storage.fillBytes(ram, 1, 6, 0);
        else storage.updateBytes(ram, 1, rom, 0, 6);
      } catch (error) {
        caught = error;
      } finally {
        spy.mockRestore();
      }
      expect(calls).toBe(4);
      expectStorageError(() => {
        throw caught;
      }, 'allocation-failure');
      expect(storage.readVersionedBytes(ram, 0, 7).bytes).toEqual(before.bytes);
      expect(storage.readVersionedBytes(rom, 0, 7).bytes).toEqual(source.bytes);
      expect(storage.validateDependencies(before.dependencies)).toBe(true);
      expect(storage.validateDependencies(source.dependencies)).toBe(true);
    },
  );
});
