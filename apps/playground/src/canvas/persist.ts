import { serializeCanvas, type CanvasDocument } from '@mica-js/core/canvas';

/** Where the playground keeps its unsaved draft; the sample `.cnv` stays the fallback. */
export const DRAFT_STORAGE_KEY = 'mica-playground:canvas-draft';

export type SaveState = 'clean' | 'dirty' | 'failed';

/** The slice of `Storage` this module needs, so tests can pass a Map-backed fake. */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface CanvasDraftStore {
  read(): string | null;
  /** Throws when the browser refuses the write (quota, private mode); the caller reports it. */
  write(text: string): void;
  clear(): void;
}

export function createDraftStore(
  storage: DraftStorage,
  key: string = DRAFT_STORAGE_KEY,
): CanvasDraftStore {
  return {
    read() {
      try {
        return storage.getItem(key);
      } catch {
        // A storage that throws on read is the same as an empty one for the caller.
        return null;
      }
    },
    write(text) {
      storage.setItem(key, text);
    },
    clear() {
      try {
        storage.removeItem(key);
      } catch {
        // Nothing to do: the caller is about to reload the sample anyway.
      }
    },
  };
}

/** In-memory fallback for browsers that refuse `localStorage` (private mode, blocked cookies). */
export function createMemoryStorage(): DraftStorage {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
  };
}

export interface CanvasDraftOptions {
  readonly store: CanvasDraftStore;
  /** Coalesces a burst of commits; defaults to 300 ms. */
  readonly delayMs?: number;
  readonly onStateChange?: (state: SaveState) => void;
  readonly onError?: (error: unknown) => void;
}

export interface CanvasDraft {
  readonly state: SaveState;
  /** Text of the last successful write; `null` until something is saved. */
  readonly saved: string | null;
  /** Adopts a snapshot as the saved baseline without writing it. */
  seed(document: CanvasDocument): void;
  /** Records a committed document; the write is debounced. */
  record(document: CanvasDocument): void;
  /** Writes the recorded document now, skipping the delay. */
  flush(): void;
  /** Forgets the draft, so the next load falls back to the sample. */
  reset(): void;
  destroy(): void;
}

const DEFAULT_DELAY_MS = 300;

/**
 * Debounced, deduplicated draft saving for the canvas page.
 *
 * The document is the whole persistent state, so every commit serializes it again; the baseline is
 * the serialized text rather than a revision counter, because two different command sequences can
 * land on the same document (drag right then left) and that is not a change worth rewriting.
 */
export function createCanvasDraft(options: CanvasDraftOptions): CanvasDraft {
  const { store, delayMs = DEFAULT_DELAY_MS, onStateChange, onError } = options;
  let state: SaveState = 'clean';
  let saved: string | null = null;
  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function setState(next: SaveState): void {
    if (state === next) {
      return;
    }
    state = next;
    try {
      onStateChange?.(next);
    } catch {
      // A throwing listener must not break saving.
    }
  }

  function cancelTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function write(): void {
    cancelTimer();
    if (pending === null || pending === saved) {
      pending = null;
      setState('clean');
      return;
    }
    const text = pending;
    pending = null;
    try {
      store.write(text);
      saved = text;
      setState('clean');
    } catch (error) {
      // Keep `pending` so the next commit or an explicit flush retries the same content.
      pending = text;
      setState('failed');
      try {
        onError?.(error);
      } catch {
        // Ditto: reporting must not escape into the scene's onChange.
      }
    }
  }

  return {
    get state() {
      return state;
    },
    get saved() {
      return saved;
    },
    seed(document) {
      cancelTimer();
      pending = null;
      saved = serializeCanvas(document);
      setState('clean');
    },
    record(document) {
      const text = serializeCanvas(document);
      if (text === saved) {
        cancelTimer();
        pending = null;
        setState('clean');
        return;
      }
      pending = text;
      setState('dirty');
      cancelTimer();
      timer = setTimeout(write, delayMs);
    },
    flush: write,
    reset() {
      cancelTimer();
      pending = null;
      saved = null;
      store.clear();
      setState('clean');
    },
    destroy: cancelTimer,
  };
}
