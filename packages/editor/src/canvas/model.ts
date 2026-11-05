import { Emitter, type Event } from '@mica-js/core/lifecycle';
import {
  applyCanvasCommand,
  parseCanvas,
  type CanvasCommand,
  type CanvasDocument,
} from '@mica-js/document/canvas';

/** Undo steps kept by {@link CanvasModel}; the schematic document editor uses the same limit. */
const HISTORY_LIMIT = 200;

/**
 * Owns one `.cnv` document and its undo history, independent of any DOM.
 *
 * The model is the single writer for document content. Construction parses a private copy of the
 * argument, every commit replaces the document with a new immutable snapshot, and each change is
 * delivered through {@link CanvasModel.onDidChangeContent}. Edits run one at a time, and a snapshot
 * becomes visible only after `prepare` resolved, so the host can resolve libraries, validate
 * bindings and synchronize the widget runtime before anyone observes the new content.
 */
export class CanvasModel {
  readonly #content = new Emitter<CanvasDocument>();
  #prepare: ((next: CanvasDocument) => Promise<void>) | undefined;
  #document: CanvasDocument;
  #past: CanvasDocument[] = [];
  #future: CanvasDocument[] = [];
  #queue: Promise<void> = Promise.resolve();
  #disposed = false;

  /** Fires after every committed change with the new snapshot; rejected edits do not fire it. */
  readonly onDidChangeContent: Event<CanvasDocument> = this.#content.event;

  /**
   * @param document Initial content; it is parsed into a private copy, so the caller keeps
   * ownership of its own object and later mutations of it never reach the model.
   * @param prepare Preparation of the next snapshot. It must resolve before the snapshot is
   * committed and may reject to reject the edit, leaving document and history untouched.
   * @throws {SchematicError} when `document` is not a valid `.cnv` document.
   */
  constructor(document: CanvasDocument, prepare?: (next: CanvasDocument) => Promise<void>) {
    this.#document = parseCanvas(document);
    this.#prepare = prepare;
  }

  /** Current snapshot; the same reference until the next commit replaces it. */
  get document(): CanvasDocument {
    return this.#document;
  }

  get canUndo(): boolean {
    return this.#past.length > 0;
  }

  get canRedo(): boolean {
    return this.#future.length > 0;
  }

  whenIdle(): Promise<void> {
    return this.#queue;
  }

  /**
   * Applies one command as one undoable edit.
   *
   * Commands are derived from the document as it is when they reach the front of the queue, so
   * concurrent calls never interleave and a later command always sees the earlier commit.
   *
   * @throws {SchematicError} when the command is invalid, or when `prepare` rejects; the content
   * stays untouched in either case.
   */
  async apply(command: CanvasCommand): Promise<void> {
    this.#assertAlive();
    await this.#enqueue(async () => {
      if (this.#disposed) return;
      const next = applyCanvasCommand(this.#document, command);
      if (!(await this.#prepareSnapshot(next))) return;
      this.#commit(next);
    });
  }

  /**
   * Restores the previous snapshot as one change. `prepare` runs for the restored snapshot too,
   * because the widget runtime has to follow the document back to that state.
   */
  async undo(): Promise<void> {
    this.#assertAlive();
    await this.#enqueue(async () => {
      if (this.#disposed) return;
      const previous = this.#past[this.#past.length - 1];
      if (previous === undefined) return;
      if (!(await this.#prepareSnapshot(previous))) return;
      this.#past.pop();
      this.#future.push(this.#document);
      this.#document = previous;
      this.#content.fire(previous);
    });
  }

  /** Reapplies the last undone snapshot, through the same preparation as {@link CanvasModel.undo}. */
  async redo(): Promise<void> {
    this.#assertAlive();
    await this.#enqueue(async () => {
      if (this.#disposed) return;
      const next = this.#future[this.#future.length - 1];
      if (next === undefined) return;
      if (!(await this.#prepareSnapshot(next))) return;
      this.#future.pop();
      this.#past.push(this.#document);
      this.#document = next;
      this.#content.fire(next);
    });
  }

  /**
   * Releases the change event and drops the history. A preparation still in flight resolves into
   * no commit, so a disposed model never changes its document again; calls made afterwards reject.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#prepare = undefined;
    this.#past = [];
    this.#future = [];
    this.#content.dispose();
  }

  #commit(next: CanvasDocument): void {
    this.#past.push(this.#document);
    if (this.#past.length > HISTORY_LIMIT) {
      this.#past.shift();
    }
    this.#future = [];
    this.#document = next;
    this.#content.fire(next);
  }

  /** @returns false when the model was disposed while `prepare` was pending. */
  async #prepareSnapshot(next: CanvasDocument): Promise<boolean> {
    const prepare = this.#prepare;
    if (prepare === undefined) {
      return !this.#disposed;
    }
    try {
      await prepare(next);
    } catch (error) {
      // A rejected preparation of a disposed model is teardown noise, not a caller's error.
      if (this.#disposed) return false;
      throw error;
    }
    return !this.#disposed;
  }

  #enqueue(run: () => Promise<void>): Promise<void> {
    const pending = this.#queue.then(run);
    // A rejected edit must not poison the queue: the next operation starts from a settled chain.
    this.#queue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error('Canvas model is disposed.');
  }
}
