import type { FusedDocument } from '@mica-js/document/fused';
import { describe, expect, it, vi } from 'vitest';
import {
  HostSessionController,
  HostSessionError,
  type HostSession,
} from '../workbench/src/session-controller';

function document(): FusedDocument {
  return {
    version: 2,
    dependencies: {},
    instances: [],
    nodes: [],
    wires: [],
    labels: [],
    references: [],
    display: { body: true, designators: false },
  };
}

interface SessionCallback {
  (snapshot: FusedDocument): Promise<void>;
}

class FakeSession implements HostSession {
  readonly save = vi.fn(async () => {
    await this.saveDocument(this.documentValue);
  });
  readonly dispose = vi.fn(async () => {});
  readonly saveDocument: SessionCallback;

  constructor(
    readonly documentValue: FusedDocument,
    saveDocument: SessionCallback,
  ) {
    this.saveDocument = saveDocument;
  }

  getDocument(): FusedDocument {
    return this.documentValue;
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}

function harness() {
  const sessions: FakeSession[] = [];
  const saved: FusedDocument[] = [];
  const opened: string[] = [];
  const closed: string[] = [];
  let hook:
    | ((document: FusedDocument, saveDocument: SessionCallback) => Promise<FakeSession>)
    | undefined;

  const create = (documentValue: FusedDocument, saveDocument: SessionCallback): FakeSession => {
    const session = new FakeSession(documentValue, saveDocument);
    sessions.push(session);
    return session;
  };
  const controller = new HostSessionController<FakeSession>({
    create: (documentValue, saveDocument) =>
      hook === undefined
        ? Promise.resolve(create(documentValue, saveDocument))
        : hook(documentValue, saveDocument),
    saveDocument: (snapshot) => saved.push(snapshot),
    savedLabel: '本地保存',
    onDidOpen: (_session, label) => opened.push(label),
    onWillClose: () => closed.push('closed'),
  });
  return {
    controller,
    sessions,
    saved,
    opened,
    closed,
    setHook(next: typeof hook) {
      hook = next;
    },
    create,
  };
}

describe('host session controller', () => {
  it('keeps the live session savable when reopen has no draft or a corrupt draft', async () => {
    const test = harness();
    await test.controller.open(document(), '演示');
    const first = test.sessions[0]!;

    await expect(
      test.controller.reopen(() => {
        throw new Error('corrupt draft');
      }),
    ).rejects.toThrow('corrupt draft');
    expect(test.controller.current).toBe(first);
    await test.controller.save();
    expect(first.save).toHaveBeenCalledTimes(1);
    expect(test.saved).toHaveLength(1);
    expect(test.controller.label).toBe('本地保存');

    await expect(test.controller.reopen(() => undefined)).rejects.toMatchObject({
      code: 'host/no-draft',
    });
    expect(test.controller.current).toBe(first);
    await test.controller.save();
    expect(first.save).toHaveBeenCalledTimes(2);
  });

  it('does not cancel an in-flight initial open when reopen finds no draft', async () => {
    const test = harness();
    const source = document();
    const gate = deferred<FakeSession>();
    const started = deferred<void>();
    let saveDocument: SessionCallback | undefined;
    test.setHook((value, callback) => {
      expect(value).toBe(source);
      saveDocument = callback;
      started.resolve(undefined);
      return gate.promise;
    });
    const opening = test.controller.open(source, '演示');
    await started.promise;
    const reopening = test.controller.reopen(() => undefined);
    const saving = test.controller.save();
    const session = test.create(source, saveDocument!);
    gate.resolve(session);
    await opening;
    await expect(reopening).rejects.toMatchObject({ code: 'host/no-draft' });
    await saving;
    expect(test.controller.current).toBe(session);
    expect(session.dispose).not.toHaveBeenCalled();
    expect(session.save).toHaveBeenCalledTimes(1);
  });

  it('does not cancel an in-flight initial open when the draft is corrupt', async () => {
    const test = harness();
    const source = document();
    const gate = deferred<FakeSession>();
    const started = deferred<void>();
    let saveDocument: SessionCallback | undefined;
    test.setHook((value, callback) => {
      expect(value).toBe(source);
      saveDocument = callback;
      started.resolve(undefined);
      return gate.promise;
    });
    const opening = test.controller.open(source, '演示');
    await started.promise;
    const reopening = test.controller.reopen(() => {
      throw new Error('corrupt draft');
    });
    const saving = test.controller.save();
    const session = test.create(source, saveDocument!);
    gate.resolve(session);
    await opening;
    await expect(reopening).rejects.toThrow('corrupt draft');
    await saving;
    expect(test.controller.current).toBe(session);
    expect(session.dispose).not.toHaveBeenCalled();
  });

  it('lets a later open win over a queued successful reopen', async () => {
    const test = harness();
    const a = document();
    const b = document();
    const c = document();
    const gate = deferred<FakeSession>();
    const started = deferred<void>();
    let saveDocument: SessionCallback | undefined;
    test.setHook((value, callback) => {
      if (value !== a) return Promise.resolve(test.create(value, callback));
      saveDocument = callback;
      started.resolve(undefined);
      return gate.promise;
    });
    const openingA = test.controller.open(a, 'A');
    await started.promise;
    const reopeningB = test.controller.reopen(() => b);
    const openingC = test.controller.open(c, 'C');
    const sessionA = test.create(a, saveDocument!);
    gate.resolve(sessionA);
    await openingA;
    await reopeningB;
    await openingC;
    expect(sessionA.dispose).toHaveBeenCalledTimes(1);
    expect(test.controller.current?.documentValue).toBe(c);
    expect(test.sessions.some((session) => session.documentValue === b)).toBe(false);
  });

  it('rejects saving through a replaced session and saves the new one', async () => {
    const test = harness();
    await test.controller.open(document(), '演示');
    const first = test.sessions[0]!;
    const secondDocument = document();
    await test.controller.open(secondDocument, '演示');
    const second = test.sessions[1]!;
    await expect(first.saveDocument(document())).rejects.toMatchObject({
      code: 'host/stale-session',
    });
    await test.controller.save();
    expect(first.save).not.toHaveBeenCalled();
    expect(second.save).toHaveBeenCalledTimes(1);
    expect(test.controller.current).toBe(second);
  });

  it('skips a queued open whose create resolves after a newer open was requested', async () => {
    const test = harness();
    await test.controller.open(document(), '演示');
    const b = document();
    const c = document();
    const gate = deferred<FakeSession>();
    const started = deferred<void>();
    test.setHook((value, saveDocument) => {
      if (value !== b) return Promise.resolve(test.create(value, saveDocument));
      started.resolve(undefined);
      return gate.promise;
    });
    const openB = test.controller.open(b, 'B');
    await started.promise;
    const openC = test.controller.open(c, 'C');
    const sessionB = test.create(b, async () => {});
    gate.resolve(sessionB);
    await openB;
    await openC;
    expect(test.controller.current?.documentValue).toBe(c);
    expect(test.sessions[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(sessionB.dispose).toHaveBeenCalledTimes(1);
    expect(test.controller.current).toBe(test.sessions[2]);
  });

  it('queues save behind an in-flight replacement so it cannot persist the old model', async () => {
    const test = harness();
    await test.controller.open(document(), '演示');
    const first = test.sessions[0]!;
    const nextDocument = document();
    const gate = deferred<FakeSession>();
    const started = deferred<void>();
    test.setHook((value, saveDocument) => {
      started.resolve(undefined);
      return gate.promise.then((session) => {
        expect(value).toBe(nextDocument);
        expect(saveDocument).toBeTypeOf('function');
        return session;
      });
    });
    const openNext = test.controller.open(nextDocument, '演示');
    await started.promise;
    const saveNext = test.controller.save();
    const next = test.create(nextDocument, async () => {});
    gate.resolve(next);
    await openNext;
    await saveNext;
    expect(first.save).not.toHaveBeenCalled();
    expect(next.save).toHaveBeenCalledTimes(1);
    expect(test.controller.current).toBe(next);
  });

  it('suspends and restores the same document on a bfcache return', async () => {
    const test = harness();
    const source = document();
    await test.controller.open(source, '演示');
    const first = test.sessions[0]!;
    await test.controller.suspend();
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(test.controller.current).toBeUndefined();
    expect(test.controller.isSuspended).toBe(true);
    await test.controller.resume();
    expect(test.controller.isSuspended).toBe(false);
    expect(test.controller.current).toBe(test.sessions[1]);
    expect(test.controller.current?.documentValue).toBe(source);
    await test.controller.save();
    expect(test.sessions[1]!.save).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-flight create on suspend and restores it after pageshow', async () => {
    const test = harness();
    const source = document();
    const gate = deferred<FakeSession>();
    const started = deferred<void>();
    test.setHook((value, saveDocument) => {
      started.resolve(undefined);
      return gate.promise.then((session) => {
        expect(value).toBe(source);
        expect(saveDocument).toBeTypeOf('function');
        return session;
      });
    });
    const opening = test.controller.open(source, '演示');
    await started.promise;
    const suspending = test.controller.suspend();
    const session = test.create(source, async () => {});
    gate.resolve(session);
    await opening;
    await suspending;
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(test.controller.current).toBeUndefined();
    expect(test.controller.isSuspended).toBe(true);
    await test.controller.resume();
    expect(test.controller.current?.documentValue).toBe(source);
  });

  it('latches after a failed release and refuses to create a new session on top of it', async () => {
    const test = harness();
    await test.controller.open(document(), '演示');
    const first = test.sessions[0]!;
    first.dispose.mockRejectedValue(new Error('worker stuck'));
    await expect(test.controller.suspend()).rejects.toMatchObject({
      code: 'host/dispose-failed',
    });
    expect(test.controller.current).toBeUndefined();
    await expect(test.controller.resume()).rejects.toBeInstanceOf(HostSessionError);
    await expect(test.controller.open(document(), '演示')).rejects.toMatchObject({
      code: 'host/dispose-failed',
    });
    await expect(test.controller.save()).rejects.toMatchObject({
      code: 'host/dispose-failed',
    });
    expect(test.sessions).toHaveLength(1);
  });

  it('notifies close before disposal and open after the new session is current', async () => {
    const test = harness();
    const events: string[] = [];
    await test.controller.open(document(), '演示');
    expect(test.opened).toEqual(['演示']);
    const first = test.sessions[0]!;
    first.dispose.mockImplementation(async () => {
      events.push('dispose');
    });
    await test.controller.open(document(), '演示');
    expect(events).toEqual(['dispose']);
    expect(test.closed).toEqual(['closed']);
    expect(test.opened).toEqual(['演示', '演示']);
  });
});
