import { describe, expect, it } from 'vitest';
import { createIRModule, IRStorageError } from './index';
import {
  createIRStorage,
  providerReadArray,
  providerReadState,
  resumeStorageWrites,
  suspendStorageWrites,
  type IRProviderTrackedReads,
  type IRStorage,
} from './storage';

function tracked(storage: IRStorage): IRProviderTrackedReads {
  return storage as unknown as IRProviderTrackedReads;
}

describe('provider tracked scalar reads', () => {
  it('advances a whole-resource state unit on every ordinary store', () => {
    const module = createIRModule();
    const state = module.state('state', 'u32', 7);
    const other = module.state('other', 'u32', 0);
    const storage = createIRStorage(module);
    const reads = tracked(storage);

    const first = reads[providerReadState](state);
    expect(first.value).toBe(7);
    expect(storage.validateDependencies(first.dependencies)).toBe(true);
    // Re-reading the same unit returns the same version token.
    expect(reads[providerReadState](state).dependencies).toEqual(first.dependencies);

    storage.storeState(other, 1);
    expect(storage.validateDependencies(first.dependencies)).toBe(true);

    storage.storeState(state, 7);
    expect(storage.validateDependencies(first.dependencies)).toBe(false);
    const second = reads[providerReadState](state);
    expect(second.value).toBe(7);
    expect(storage.validateDependencies(second.dependencies)).toBe(true);
    expect(storage.validateDependencies(first.dependencies)).toBe(false);
  });

  it('treats an array as one whole-resource unit', () => {
    const module = createIRModule();
    const words = module.array('words', 'u32', [1, 2, 3]);
    const storage = createIRStorage(module);
    const reads = tracked(storage);
    const first = reads[providerReadArray](words, 0);
    expect(first.value).toBe(1);
    storage.storeArray(words, 0, 1);
    expect(storage.validateDependencies(first.dependencies)).toBe(false);
    const second = reads[providerReadArray](words, 2);
    expect(second.value).toBe(3);
    expect(second.dependencies).toEqual(first.dependencies);
  });

  it('invalidates on host inbox admission but not on a zero-length write', () => {
    const module = createIRModule();
    const inbox = module.inbox('input', 4);
    const storage = createIRStorage(module);
    const read = storage.readVersionedBytes(inbox, 0, 4);
    expect(read.dependencies).toHaveLength(1);
    storage.writeInbox(inbox, 0, new Uint8Array(0));
    expect(storage.validateDependencies(read.dependencies)).toBe(true);
    storage.writeInbox(inbox, 1, new Uint8Array([1]));
    expect(storage.validateDependencies(read.dependencies)).toBe(false);
  });

  it('keeps ordinary bytes stores outside the version mechanism (#47)', () => {
    const module = createIRModule();
    const ram = module.bytes('ram', new Uint8Array(4), { readonly: false, unitBytes: 2 });
    const storage = createIRStorage(module);
    const read = storage.readVersionedBytes(ram, 0, 2);
    storage.storeBytes('u8', 'little', ram, 0, 9);
    expect(storage.validateDependencies(read.dependencies)).toBe(true);
  });

  it('records every unit covered by a non-aligned read', () => {
    const module = createIRModule();
    const firmware = module.bytes('firmware', new Uint8Array(4), {
      readonly: true,
      unitBytes: 2,
    });
    const storage = createIRStorage(module, { updateResources: [firmware] });
    const read = storage.readVersionedBytes(firmware, 1, 3);
    expect(read.dependencies).toHaveLength(2);
    storage.updateBytesFromBytes(firmware, 0, new Uint8Array([1]));
    expect(storage.validateDependencies(read.dependencies)).toBe(false);
  });

  it('suspends every write path during generation while reads keep working', () => {
    const module = createIRModule();
    const state = module.state('state', 'u32', 1);
    const ram = module.bytes('ram', new Uint8Array(2), { readonly: false });
    const inbox = module.inbox('input', 2);
    const storage = createIRStorage(module, { updateResources: [ram] });
    suspendStorageWrites(storage);
    expect(storage.loadState(state)).toBe(1);
    expect(storage.readVersionedBytes(ram, 0, 1).bytes).toEqual(new Uint8Array([0]));
    for (const write of [
      () => storage.storeState(state, 2),
      () => storage.storeBytes('u8', 'little', ram, 0, 1),
      () => storage.copy(ram, 0, ram, 0, 1),
      () => storage.updateBytes(ram, 0, ram, 0, 1),
      () => storage.fillBytes(ram, 0, 1, 2),
      () => storage.writeInbox(inbox, 0, new Uint8Array([1])),
      () => storage.updateBytesFromBytes(ram, 0, new Uint8Array([1])),
    ]) {
      let caught: unknown;
      try {
        write();
      } catch (cause) {
        caught = cause;
      }
      expect(caught).toBeInstanceOf(IRStorageError);
      expect((caught as IRStorageError).code).toBe('unauthorized-resource');
    }
    expect(storage.loadState(state)).toBe(1);
    resumeStorageWrites(storage);
    storage.storeState(state, 2);
    expect(storage.loadState(state)).toBe(2);
  });
});
