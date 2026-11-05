import {
  CANVAS_VERSION,
  SchematicError,
  type CanvasCommand,
  type CanvasDocument,
  type CanvasWidgetInstance,
} from '@mica-js/document/canvas';
import { describe, expect, it, vi } from 'vitest';
import { CanvasModel } from './model';

const ID_A = '3f6c1e28-9b47-4d05-8a71-2c5e0f9b6d13';
const ID_B = 'a17d5b90-4e2c-4f86-b3d9-7e1c8a2f5046';

function instance(id: string, overrides: Partial<CanvasWidgetInstance> = {}): CanvasWidgetInstance {
  return {
    id,
    widget: 'builtin:test',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    rotation: 0,
    ...overrides,
  };
}

function documentWith(...widgets: readonly CanvasWidgetInstance[]): CanvasDocument {
  return { version: CANVAS_VERSION, widgets };
}

function setPlacement(instanceId: string, x: number): CanvasCommand {
  return {
    type: 'set-placement',
    instanceId,
    placement: { x, y: 0, width: 100, height: 50, rotation: 0 },
  };
}

interface IDeferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): IDeferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('CanvasModel', () => {
  it('parses a private copy of the initial document', () => {
    const widget = instance(ID_A, { properties: { label: 'first' } });
    const input = documentWith(widget);
    const model = new CanvasModel(input);

    expect(model.document).toEqual(input);
    expect(model.document).not.toBe(input);

    (input.widgets as CanvasWidgetInstance[]).push(instance(ID_B));
    (widget as { x: number }).x = 500;
    (widget.properties as Record<string, unknown>)['label'] = 'changed';

    expect(model.document.widgets).toHaveLength(1);
    expect(model.document.widgets[0]?.x).toBe(0);
    expect(model.document.widgets[0]?.properties).toEqual({ label: 'first' });
    model.dispose();
  });

  it('rejects an invalid initial document', () => {
    expect(
      () =>
        new CanvasModel({
          version: CANVAS_VERSION,
          widgets: [{ ...instance(ID_A), width: 0 }],
        } as unknown as CanvasDocument),
    ).toThrow(SchematicError);
    expect(() => new CanvasModel({ version: 2, widgets: [] } as unknown as CanvasDocument)).toThrow(
      SchematicError,
    );
  });

  it('commits a new immutable snapshot and notifies once', async () => {
    const model = new CanvasModel(documentWith(instance(ID_A)));
    const first = model.document;
    const changes: CanvasDocument[] = [];
    const subscription = model.onDidChangeContent((next) => changes.push(next));

    expect(model.canUndo).toBe(false);
    expect(model.canRedo).toBe(false);

    await model.apply(setPlacement(ID_A, 10));

    expect(changes).toHaveLength(1);
    expect(changes[0]).toBe(model.document);
    expect(model.document).not.toBe(first);
    expect(first.widgets[0]?.x).toBe(0);
    expect(model.document.widgets[0]?.x).toBe(10);
    expect(model.canUndo).toBe(true);
    expect(model.canRedo).toBe(false);

    subscription.dispose();
    model.dispose();
  });

  it('undoes and redoes committed snapshots', async () => {
    const model = new CanvasModel(documentWith(instance(ID_A)));
    const first = model.document;
    const changes: CanvasDocument[] = [];
    model.onDidChangeContent((next) => changes.push(next));

    await model.apply(setPlacement(ID_A, 10));
    const second = model.document;

    await model.undo();
    expect(model.document).toBe(first);
    expect(model.canUndo).toBe(false);
    expect(model.canRedo).toBe(true);

    await model.undo();
    expect(model.document).toBe(first);

    await model.redo();
    expect(model.document).toBe(second);
    expect(model.canUndo).toBe(true);
    expect(model.canRedo).toBe(false);
    expect(changes).toEqual([second, first, second]);

    model.dispose();
  });

  it('waits for prepare before committing', async () => {
    const gate = deferred<void>();
    const seen: CanvasDocument[] = [];
    const prepare = vi.fn(async (next: CanvasDocument) => {
      seen.push(next);
      await gate.promise;
    });
    const model = new CanvasModel(documentWith(instance(ID_A)), prepare);
    const changes: CanvasDocument[] = [];
    model.onDidChangeContent((next) => changes.push(next));

    const pending = model.apply(setPlacement(ID_A, 10));
    await tick();

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(seen[0]?.widgets[0]?.x).toBe(10);
    expect(model.document.widgets[0]?.x).toBe(0);
    expect(model.canUndo).toBe(false);
    expect(changes).toHaveLength(0);

    gate.resolve();
    await pending;

    expect(model.document.widgets[0]?.x).toBe(10);
    expect(model.document).toBe(seen[0]);
    expect(changes).toHaveLength(1);
    model.dispose();
  });

  it('keeps the content when prepare rejects and accepts the next edit', async () => {
    let failures = 1;
    const prepare = async (): Promise<void> => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('binding failed');
      }
    };
    const model = new CanvasModel(documentWith(instance(ID_A)), prepare);
    const changes: CanvasDocument[] = [];
    model.onDidChangeContent((next) => changes.push(next));

    await expect(model.apply(setPlacement(ID_A, 10))).rejects.toThrow('binding failed');
    expect(model.document.widgets[0]?.x).toBe(0);
    expect(model.canUndo).toBe(false);
    expect(changes).toHaveLength(0);

    await expect(model.apply({ type: 'remove-instance', instanceId: ID_B })).rejects.toThrow(
      SchematicError,
    );
    expect(model.document.widgets).toHaveLength(1);

    await model.apply(setPlacement(ID_A, 10));
    expect(model.document.widgets[0]?.x).toBe(10);
    expect(model.canUndo).toBe(true);
    model.dispose();
  });

  it('serializes concurrent edits and prepares the second against the first commit', async () => {
    const gates: IDeferred<void>[] = [];
    const seen: CanvasDocument[] = [];
    const prepare = async (next: CanvasDocument): Promise<void> => {
      seen.push(next);
      const gate = deferred<void>();
      gates.push(gate);
      await gate.promise;
    };
    const model = new CanvasModel(documentWith(instance(ID_A)), prepare);

    const first = model.apply(setPlacement(ID_A, 10));
    const second = model.apply({ type: 'add-instance', instance: instance(ID_B), z: 1 });
    await tick();

    expect(gates).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.widgets[0]?.x).toBe(10);

    const firstGate = gates[0];
    expect(firstGate).toBeDefined();
    firstGate?.resolve();
    await first;
    await tick();

    expect(seen).toHaveLength(2);
    expect(seen[1]?.widgets.map((widget) => widget.id)).toEqual([ID_A, ID_B]);
    expect(seen[1]?.widgets[0]?.x).toBe(10);

    const secondGate = gates[1];
    expect(secondGate).toBeDefined();
    secondGate?.resolve();
    await second;

    expect(model.document.widgets.map((widget) => widget.id)).toEqual([ID_A, ID_B]);
    expect(model.document.widgets[0]?.x).toBe(10);
    expect(model.canUndo).toBe(true);
    model.dispose();
  });

  it('drops a pending commit after dispose', async () => {
    const gate = deferred<void>();
    const model = new CanvasModel(documentWith(instance(ID_A)), async () => gate.promise);
    const changes: CanvasDocument[] = [];
    model.onDidChangeContent((next) => changes.push(next));

    const pending = model.apply(setPlacement(ID_A, 10));
    await tick();
    model.dispose();
    gate.resolve();
    await pending;

    expect(model.document.widgets[0]?.x).toBe(0);
    expect(changes).toHaveLength(0);
    expect(model.canUndo).toBe(false);
    expect(model.canRedo).toBe(false);

    await expect(model.apply(setPlacement(ID_A, 20))).rejects.toThrow('disposed');
    await expect(model.undo()).rejects.toThrow('disposed');
    await expect(model.redo()).rejects.toThrow('disposed');
  });

  it('prepares undone and redone snapshots', async () => {
    const seen: CanvasDocument[] = [];
    const model = new CanvasModel(documentWith(instance(ID_A)), async (next) => {
      seen.push(next);
    });
    const initial = model.document;

    await model.apply(setPlacement(ID_A, 10));
    const committed = model.document;

    seen.length = 0;
    await model.undo();
    expect(seen).toEqual([initial]);

    seen.length = 0;
    await model.redo();
    expect(seen).toEqual([committed]);
    model.dispose();
  });

  it('keeps the history when preparing an undo rejects', async () => {
    let blocked = false;
    const model = new CanvasModel(documentWith(instance(ID_A)), async () => {
      if (blocked) throw new Error('blocked');
    });

    await model.apply(setPlacement(ID_A, 10));
    blocked = true;

    await expect(model.undo()).rejects.toThrow('blocked');
    expect(model.document.widgets[0]?.x).toBe(10);
    expect(model.canUndo).toBe(true);
    expect(model.canRedo).toBe(false);

    blocked = false;
    await model.undo();
    expect(model.document.widgets[0]?.x).toBe(0);
    model.dispose();
  });

  it('keeps the newest 200 undo steps', async () => {
    const model = new CanvasModel(documentWith(instance(ID_A)));

    for (let x = 1; x <= 201; x += 1) {
      await model.apply(setPlacement(ID_A, x));
    }

    let undos = 0;
    while (model.canUndo) {
      await model.undo();
      undos += 1;
    }

    expect(undos).toBe(200);
    expect(model.document.widgets[0]?.x).toBe(1);
    expect(model.canRedo).toBe(true);
    model.dispose();
  });
});
