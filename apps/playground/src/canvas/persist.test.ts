import type { CanvasDocument } from '@mica-js/core/canvas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCanvasDraft,
  createDraftStore,
  DRAFT_STORAGE_KEY,
  type DraftStorage,
  type SaveState,
} from './persist';

function documentWith(x: number): CanvasDocument {
  return {
    version: 1,
    widgets: [
      {
        id: '1c2d3e4f-5a6b-4c7d-9e8f-0a1b2c3d4e50',
        widget: 'demo:button',
        x,
        y: 0,
        width: 10,
        height: 10,
        rotation: 0,
      },
    ],
  };
}

function memoryStorage(): DraftStorage & { readonly entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createDraftStore', () => {
  it('reads and writes the draft under the shared key', () => {
    const storage = memoryStorage();
    const store = createDraftStore(storage);

    store.write('{"version":1}');
    expect(storage.entries.get(DRAFT_STORAGE_KEY)).toBe('{"version":1}');
    expect(store.read()).toBe('{"version":1}');

    store.clear();
    expect(store.read()).toBeNull();
  });

  it('treats a storage that throws on read as empty', () => {
    const store = createDraftStore({
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {},
      removeItem: () => {},
    });

    expect(store.read()).toBeNull();
  });
});

describe('createCanvasDraft', () => {
  it('stays clean when a recorded document matches the baseline', () => {
    const storage = memoryStorage();
    const states: SaveState[] = [];
    const draft = createCanvasDraft({
      store: createDraftStore(storage),
      onStateChange: (state) => states.push(state),
    });

    draft.seed(documentWith(0));
    draft.record(documentWith(0));
    vi.runAllTimers();

    expect(draft.state).toBe('clean');
    expect(states).toEqual([]);
    expect(storage.entries.size).toBe(0);
  });

  it('debounces writes and keeps only the last document', () => {
    const storage = memoryStorage();
    const draft = createCanvasDraft({ store: createDraftStore(storage), delayMs: 100 });
    draft.seed(documentWith(0));

    draft.record(documentWith(10));
    draft.record(documentWith(20));
    expect(draft.state).toBe('dirty');
    expect(storage.entries.size).toBe(0);

    vi.advanceTimersByTime(99);
    expect(storage.entries.size).toBe(0);
    vi.advanceTimersByTime(1);

    expect(draft.state).toBe('clean');
    expect(storage.entries.get(DRAFT_STORAGE_KEY)).toContain('"x": 20');
  });

  it('writes immediately on flush and drops the pending timer', () => {
    const storage = memoryStorage();
    const draft = createCanvasDraft({ store: createDraftStore(storage), delayMs: 100 });
    draft.seed(documentWith(0));
    draft.record(documentWith(5));

    draft.flush();

    expect(storage.entries.get(DRAFT_STORAGE_KEY)).toContain('"x": 5');
    expect(draft.state).toBe('clean');
    // The debounced write must not fire a second time.
    const before = storage.entries.get(DRAFT_STORAGE_KEY);
    vi.runAllTimers();
    expect(storage.entries.get(DRAFT_STORAGE_KEY)).toBe(before);
  });

  it('reports a refused write and retries the same content on the next flush', () => {
    const storage = memoryStorage();
    let refuse = true;
    const store = createDraftStore(storage);
    const failing = {
      read: store.read,
      write: (text: string) => {
        if (refuse) throw new Error('quota exceeded');
        store.write(text);
      },
      clear: store.clear,
    };
    const errors: unknown[] = [];
    const draft = createCanvasDraft({ store: failing, onError: (error) => errors.push(error) });
    draft.seed(documentWith(0));

    draft.record(documentWith(7));
    vi.runAllTimers();

    expect(draft.state).toBe('failed');
    expect(errors).toHaveLength(1);
    expect(storage.entries.size).toBe(0);

    refuse = false;
    draft.flush();

    expect(draft.state).toBe('clean');
    expect(storage.entries.get(DRAFT_STORAGE_KEY)).toContain('"x": 7');
  });

  it('clears the stored draft on reset and forgets the baseline', () => {
    const storage = memoryStorage();
    const draft = createCanvasDraft({ store: createDraftStore(storage) });
    draft.seed(documentWith(0));
    draft.record(documentWith(3));
    draft.flush();

    draft.reset();
    draft.record(documentWith(3));

    expect(storage.entries.size).toBe(0);
    expect(draft.saved).toBeNull();
    expect(draft.state).toBe('dirty');
  });

  it('cancels a pending write on destroy', () => {
    const storage = memoryStorage();
    const draft = createCanvasDraft({ store: createDraftStore(storage), delayMs: 100 });
    draft.seed(documentWith(0));
    draft.record(documentWith(9));

    draft.destroy();
    vi.runAllTimers();

    expect(storage.entries.size).toBe(0);
  });
});
