import type { FusedDocument } from '@mica-js/document/fused';
import { SerialQueue } from './serial-queue';

/** Minimal session surface the host state machine needs; `IWorkbench` satisfies it. */
export interface HostSession {
  getDocument(): FusedDocument;
  save(): Promise<void>;
  dispose(): Promise<void>;
}

export interface HostSessionOptions<S extends HostSession> {
  /** Creates a session; it must not be reused after the returned promise settles. */
  create(
    document: FusedDocument,
    saveDocument: (snapshot: FusedDocument) => Promise<void>,
  ): Promise<S>;
  /** Persists a snapshot of the current session; the controller owns the stale checks. */
  saveDocument(snapshot: FusedDocument): void;
  /** Label used after a successful host save. */
  savedLabel?: string;
  onDidOpen?(session: S, label: string): void;
  onDidSave?(session: S, label: string): void;
  /** Called before a previous session is disposed, so subscriptions go first. */
  onWillClose?(): void;
}

/** Host lifecycle error with a stable code, visible through the same error banner. */
export class HostSessionError extends Error {
  readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'HostSessionError';
    this.code = code;
  }
}

/**
 * Serialized open/save/reopen and suspend/resume state machine of the workbench host.
 *
 * The controller is deliberately independent of the DOM so its session behavior can be tested
 * with a fake `create` function. Two counters keep the invariants separate:
 * - `request` is advanced when the user asks for another document, so queued work can be skipped;
 * - `token` is advanced only when a replacement document is actually applied. A failed reopen
 *   therefore leaves the old session, and its save callback, valid.
 */
export class HostSessionController<S extends HostSession> {
  readonly #queue = new SerialQueue();
  readonly #create: HostSessionOptions<S>['create'];
  readonly #saveDocument: HostSessionOptions<S>['saveDocument'];
  readonly #savedLabel: string;
  readonly #onDidOpen: HostSessionOptions<S>['onDidOpen'];
  readonly #onDidSave: HostSessionOptions<S>['onDidSave'];
  readonly #onWillClose: HostSessionOptions<S>['onWillClose'];
  #current: S | undefined;
  #label = '演示';
  #request = 0;
  #token = 0;
  #closing = false;
  #cleanupFailure: string | undefined;
  #suspended: { readonly document: FusedDocument; readonly label: string } | undefined;
  #pending: { readonly document: FusedDocument; readonly label: string } | undefined;

  constructor(options: HostSessionOptions<S>) {
    this.#create = options.create;
    this.#saveDocument = options.saveDocument;
    this.#savedLabel = options.savedLabel ?? 'saved';
    this.#onDidOpen = options.onDidOpen;
    this.#onDidSave = options.onDidSave;
    this.#onWillClose = options.onWillClose;
  }

  get current(): S | undefined {
    return this.#current;
  }

  get label(): string {
    return this.#label;
  }

  get isSuspended(): boolean {
    return this.#suspended !== undefined;
  }

  /** Opens a document; the latest call wins and older queued opens are skipped. */
  open(document: FusedDocument, label: string): Promise<void> {
    const request = ++this.#request;
    this.#pending = { document, label };
    return this.#run(async () => {
      if (request !== this.#request || this.#closing) return;
      if (this.#cleanupFailure !== undefined) {
        throw new HostSessionError('host/dispose-failed', this.#cleanupFailure);
      }
      const token = ++this.#token;
      await this.#replace(document, label, token, request);
    });
  }

  /**
   * Reopens a saved document.
   *
   * `load` runs before the request counter and session token advance, so a missing or corrupt
   * draft rejects without invalidating the live session or its save callback.
   */
  reopen(load: () => FusedDocument | undefined): Promise<void> {
    const request = ++this.#request;
    return this.#run(async () => {
      if (request !== this.#request || this.#closing) return;
      if (this.#cleanupFailure !== undefined) {
        throw new HostSessionError('host/dispose-failed', this.#cleanupFailure);
      }
      const document = load();
      if (document === undefined) {
        throw new HostSessionError('host/no-draft', '没有已保存的文档；请先保存当前文档。');
      }
      const token = ++this.#token;
      await this.#replace(document, '本地保存', token, request);
    });
  }

  /** Saves the current session after every previously requested replacement has settled. */
  save(): Promise<void> {
    return this.#run(async () => {
      if (this.#closing) throw new HostSessionError('host/closing', '页面正在关闭，已拒绝保存。');
      if (this.#cleanupFailure !== undefined) {
        throw new HostSessionError('host/dispose-failed', this.#cleanupFailure);
      }
      const current = this.#current;
      if (current === undefined) throw new HostSessionError('host/no-session', '尚未装载文档');
      await current.save();
      this.#label = this.#savedLabel;
      this.#onDidSave?.(current, this.#label);
    });
  }

  /**
   * Releases the live session for `pagehide` and remembers its document for a bfcache return.
   * A failed release latches the controller; no new session is created on top of it.
   */
  suspend(): Promise<void> {
    const current = this.#current;
    const document = current?.getDocument() ?? this.#pending?.document;
    const label = current === undefined ? this.#pending?.label : this.#label;
    if (document !== undefined) {
      this.#suspended = { document, label: label ?? '演示' };
    }
    this.#closing = true;
    this.#request += 1;
    this.#token += 1;
    return this.#run(async () => {
      if (this.#cleanupFailure !== undefined) return;
      await this.#disposeCurrent();
    });
  }

  /** Restores the document captured by `suspend` when the page returns from the bfcache. */
  resume(): Promise<void> {
    const suspended = this.#suspended;
    if (!this.#closing) return Promise.resolve();
    this.#closing = false;
    if (this.#cleanupFailure !== undefined) {
      const failure = this.#cleanupFailure;
      return Promise.reject(new HostSessionError('host/dispose-failed', failure));
    }
    if (suspended === undefined) return Promise.resolve();
    this.#suspended = undefined;
    const request = ++this.#request;
    return this.#run(async () => {
      if (request !== this.#request || this.#closing) return;
      const token = ++this.#token;
      await this.#replace(suspended.document, suspended.label, token, request);
    });
  }

  #run(task: () => Promise<void>): Promise<void> {
    return this.#queue.run(task);
  }

  async #replace(
    document: FusedDocument,
    label: string,
    token: number,
    request: number,
  ): Promise<void> {
    if (request !== this.#request || this.#closing) return;
    this.#pending = { document, label };
    await this.#disposeCurrent();
    if (request !== this.#request || this.#closing) return;
    const created = await this.#create(document, async (snapshot) => {
      if (this.#closing || token !== this.#token) {
        throw new HostSessionError(
          'host/stale-session',
          '文档正在被替换或页面正在关闭，已拒绝保存旧会话。',
        );
      }
      this.#saveDocument(snapshot);
    });
    if (request !== this.#request || this.#closing) {
      try {
        await created.dispose();
      } catch (cause) {
        const failure = `取消装载时释放失败；请重新加载页面：${messageOf(cause)}`;
        this.#cleanupFailure = failure;
        throw new HostSessionError('host/dispose-failed', failure, cause);
      }
      return;
    }
    this.#current = created;
    this.#label = label;
    this.#pending = undefined;
    this.#onDidOpen?.(created, label);
  }

  async #disposeCurrent(): Promise<void> {
    const previous = this.#current;
    this.#current = undefined;
    if (previous === undefined) return;
    this.#onWillClose?.();
    try {
      await previous.dispose();
    } catch (cause) {
      const failure = `旧工作台释放失败，已停止装载新会话；请重新加载页面：${messageOf(cause)}`;
      this.#cleanupFailure = failure;
      throw new HostSessionError('host/dispose-failed', failure, cause);
    }
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
