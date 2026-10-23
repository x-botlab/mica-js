import { applyCanvasCommand, type CanvasCommand, type CanvasDocument } from '@mica-js/core/canvas';
import type { WidgetLayers, WidgetPublish } from '@mica-js/widget';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasEditor, MountCanvasEditorOptions } from './editor/mount';
import { mountCanvasEditor } from './editor/mount';
import {
  createCanvasScene,
  type CanvasScene,
  type CanvasSceneDiagnostic,
  type CanvasSceneHost,
  type CreateCanvasSceneOptions,
} from './scene';
import { canvasDocument, widget } from './test-helpers';
import type { CanvasMode } from './types';

vi.mock('./editor/mount', () => ({ mountCanvasEditor: vi.fn() }));

const mount = vi.mocked(mountCanvasEditor);

/** The editor is a DOM component, so the scene tests drive a fake one through the mount mock. */
interface FakeEditor extends CanvasEditor {
  readonly calls: string[];
}

function createFakeEditor(): FakeEditor {
  const calls: string[] = [];
  return {
    calls,
    setDocument: vi.fn(),
    setMode: vi.fn((mode: CanvasMode) => {
      calls.push(`setMode:${mode}`);
    }),
    setSelection: vi.fn(),
    cancelInteraction: vi.fn(() => {
      calls.push('cancelInteraction');
    }),
    state: { mode: 'edit', selection: [], viewport: { x: 0, y: 0, scale: 1 } },
    focus: vi.fn(),
    destroy: vi.fn(() => {
      calls.push('destroy');
    }),
  };
}

interface Delivered {
  readonly instanceId: string;
  readonly port: string;
  readonly payload: unknown;
  readonly simTime: number;
}

interface FakeHost extends CanvasSceneHost {
  readonly delivered: readonly Delivered[];
  emitDocumentChange(document: CanvasDocument): void;
  emitPublish(publish: WidgetPublish): void;
  publishListenerCount(): number;
  /** Holds the next `reset()` open; the returned function releases it. */
  holdReset(): () => void;
  failNextReset(error: Error): void;
}

const layers: WidgetLayers = {
  list: () => [],
  get: () => undefined,
  subscribe: () => () => {},
};

function createFakeHost(initial: CanvasDocument = canvasDocument()): FakeHost {
  let current = initial;
  const delivered: Delivered[] = [];
  const documentListeners = new Set<(document: CanvasDocument) => void>();
  const publishListeners = new Set<(publish: WidgetPublish) => void>();
  let resetGate: Promise<void> | undefined;
  let resetFailure: Error | undefined;

  return {
    delivered,
    get document() {
      return current;
    },
    loadDocument: vi.fn(async (source: string | CanvasDocument) => {
      if (typeof source === 'string') {
        throw new Error('this fake host only accepts parsed documents');
      }
      current = source;
    }),
    applyCommand: vi.fn((command: CanvasCommand) => {
      current = applyCanvasCommand(current, command);
      for (const listener of [...documentListeners]) listener(current);
    }),
    onDocumentChange: vi.fn((listener: (document: CanvasDocument) => void) => {
      documentListeners.add(listener);
      return () => {
        documentListeners.delete(listener);
      };
    }),
    reset: vi.fn(async () => {
      const gate = resetGate;
      resetGate = undefined;
      if (gate !== undefined) {
        await gate;
      }
      const failure = resetFailure;
      resetFailure = undefined;
      if (failure !== undefined) {
        throw failure;
      }
    }),
    deliver: vi.fn((instanceId: string, port: string, payload: unknown, simTime: number) => {
      delivered.push({ instanceId, port, payload, simTime });
    }),
    dispatch: vi.fn(),
    layers,
    resize: vi.fn(),
    dispose: vi.fn(async () => {}),
    onPublish: vi.fn((listener: (publish: WidgetPublish) => void) => {
      publishListeners.add(listener);
      return () => {
        publishListeners.delete(listener);
      };
    }),
    emitDocumentChange(next: CanvasDocument): void {
      current = next;
      for (const listener of [...documentListeners]) listener(next);
    },
    emitPublish(publish: WidgetPublish): void {
      for (const listener of [...publishListeners]) listener(publish);
    },
    publishListenerCount: () => publishListeners.size,
    holdReset(): () => void {
      let release: () => void = () => {};
      resetGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    failNextReset(error: Error): void {
      resetFailure = error;
    },
  };
}

const container = {} as HTMLElement;

/** `applyCanvasCommand` validates ids, so the command tests need UUID v4 values. */
const ID_A = '2b6f0d1e-6f0a-4a7a-9a39-0d3c5a1f7c11';

function mountedOptions(): MountCanvasEditorOptions {
  const call = mount.mock.calls.at(-1);
  if (call === undefined) {
    throw new Error('mountCanvasEditor was not called');
  }
  return call[0];
}

async function mountScene(
  host: FakeHost,
  options: Omit<Partial<CreateCanvasSceneOptions>, 'container' | 'host' | 'document'> = {},
): Promise<CanvasScene> {
  return createCanvasScene({ container, document: host.document, host, ...options });
}

let editor: FakeEditor;

beforeEach(() => {
  editor = createFakeEditor();
  mount.mockReset();
  mount.mockImplementation(() => editor);
});

describe('createCanvasScene', () => {
  it('loads the document through the host before mounting the editor', async () => {
    const host = createFakeHost();
    const document = canvasDocument(widget('a'));

    const scene = await createCanvasScene({ container, document, host });

    expect(host.loadDocument).toHaveBeenCalledWith(document);
    const options = mountedOptions();
    expect(options.document).toBe(host.document);
    expect(options.layers).toBe(host.layers);
    expect(options.mode).toBe('edit');
    expect(scene.document).toBe(host.document);
    expect(scene.mode).toBe('edit');
  });

  it('forwards a command to the host and reports the committed snapshot once', async () => {
    const host = createFakeHost();
    const onChange = vi.fn();
    await mountScene(host, { onChange });

    mountedOptions().onCommand?.({ type: 'add-instance', instance: widget(ID_A), z: 0 });

    expect(host.applyCommand).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(host.document);
    // The host already notified `onDocumentChange`; the command handler must not feed twice.
    expect(editor.setDocument).toHaveBeenCalledTimes(1);
    expect(editor.setDocument).toHaveBeenCalledWith(host.document);
  });

  it('reports a rejected command and keeps the editor on the old snapshot', async () => {
    const host = createFakeHost(canvasDocument(widget(ID_A)));
    host.applyCommand = vi.fn(() => {
      throw new Error('placement out of bounds');
    });
    const onChange = vi.fn();
    const diagnostics: CanvasSceneDiagnostic[] = [];
    const scene = await mountScene(host, {
      onChange,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    mountedOptions().onCommand?.({ type: 'remove-instance', instanceId: ID_A });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ code: 'canvas-scene/command-failed' });
    expect(diagnostics[0]?.message).toContain('placement out of bounds');
    expect(onChange).not.toHaveBeenCalled();
    expect(editor.setDocument).not.toHaveBeenCalled();
    expect(scene.document).toBe(host.document);
  });

  it('adopts a snapshot the host committed on its own without looping', async () => {
    const host = createFakeHost();
    const onChange = vi.fn();
    await mountScene(host, { onChange });

    host.applyCommand({ type: 'add-instance', instance: widget(ID_A), z: 0 });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(host.document);

    // The same snapshot again is not a change.
    host.emitDocumentChange(host.document);
    expect(onChange).toHaveBeenCalledTimes(1);

    const placement = { x: 12, y: 24, width: 100, height: 50, rotation: 0 };
    host.applyCommand({ type: 'set-placement', instanceId: ID_A, placement });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(host.document);
    expect(editor.setDocument).toHaveBeenCalledTimes(2);
  });

  it('delivers to every instance bound to the target endpoint', async () => {
    const target = { symbol: 'mcu', port: 'value' };
    const host = createFakeHost(
      canvasDocument(
        widget('a', { bindings: { display: target } }),
        widget('b', { bindings: { mirror: target } }),
        widget('c', { bindings: { other: { symbol: 'mcu', port: 'other' } } }),
      ),
    );
    const scene = await mountScene(host);

    scene.deliver(target, '12.34', 5);

    expect(host.delivered).toEqual([
      { instanceId: 'a', port: 'display', payload: '12.34', simTime: 5 },
      { instanceId: 'b', port: 'mirror', payload: '12.34', simTime: 5 },
    ]);
  });

  it('drops a delivery no binding matches', async () => {
    const host = createFakeHost(
      canvasDocument(widget('a', { bindings: { display: { symbol: 'mcu', port: 'value' } } })),
    );
    const scene = await mountScene(host);

    scene.deliver({ symbol: 'mcu', port: 'missing' }, 1, 0);

    expect(host.deliver).not.toHaveBeenCalled();
  });

  it('resolves a publish back to its binding target', async () => {
    const target = { symbol: 'mcu', port: 'press' };
    const host = createFakeHost(canvasDocument(widget('a', { bindings: { press: target } })));
    const scene = await mountScene(host);
    const listener = vi.fn();
    scene.onPublish(listener);

    host.emitPublish({ instanceId: 'a', port: 'press', payload: true, simTime: 3 });

    expect(listener).toHaveBeenCalledWith(target, true, 3);
  });

  it('reports a publish without a binding', async () => {
    const host = createFakeHost(canvasDocument(widget('a')));
    const diagnostics: CanvasSceneDiagnostic[] = [];
    const scene = await mountScene(host, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const listener = vi.fn();
    scene.onPublish(listener);

    host.emitPublish({ instanceId: 'a', port: 'unknown', payload: true, simTime: 0 });

    expect(listener).not.toHaveBeenCalled();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: 'canvas-scene/unbound-publish',
      instanceId: 'a',
    });
  });

  it('feeds every publish listener until it unsubscribes', async () => {
    const target = { symbol: 'mcu', port: 'press' };
    const host = createFakeHost(canvasDocument(widget('a', { bindings: { press: target } })));
    const scene = await mountScene(host);
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = scene.onPublish(first);
    scene.onPublish(second);

    host.emitPublish({ instanceId: 'a', port: 'press', payload: false, simTime: 7 });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    unsubscribe();
    host.emitPublish({ instanceId: 'a', port: 'press', payload: true, simTime: 8 });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('delivers publishes handed to receivePublish by the host owner', async () => {
    const target = { symbol: 'mcu', port: 'press' };
    const host = createFakeHost(canvasDocument(widget('a', { bindings: { press: target } })));
    const scene = await mountScene(host);
    const listener = vi.fn();
    scene.onPublish(listener);

    scene.receivePublish({ instanceId: 'a', port: 'press', payload: true, simTime: 2 });

    expect(listener).toHaveBeenCalledWith(target, true, 2);
  });

  it('cancels the interaction in flight before entering run mode', async () => {
    const host = createFakeHost();
    const scene = await mountScene(host);

    await scene.setMode('run');

    expect(editor.calls).toEqual(['cancelInteraction', 'setMode:run']);
    expect(scene.mode).toBe('run');

    await scene.setMode('edit');
    expect(editor.calls.at(-2)).toBe('cancelInteraction');
    expect(editor.calls.at(-1)).toBe('setMode:edit');
    expect(scene.mode).toBe('edit');
  });

  it('resets the widgets on every mode change', async () => {
    const host = createFakeHost();
    const scene = await mountScene(host);

    await scene.setMode('run');
    expect(host.reset).toHaveBeenCalledTimes(1);

    await scene.setMode('edit');
    expect(host.reset).toHaveBeenCalledTimes(2);
  });

  it('does not reset when the mode is already in effect', async () => {
    const host = createFakeHost();
    const scene = await mountScene(host, { mode: 'run' });
    expect(scene.mode).toBe('run');

    await scene.setMode('run');

    expect(host.reset).not.toHaveBeenCalled();
    expect(editor.calls).toEqual([]);
  });

  it('applies the new mode before the reset and resolves after it', async () => {
    const host = createFakeHost();
    const scene = await mountScene(host);
    const release = host.holdReset();

    let settled = false;
    const switching = scene.setMode('run').then(() => {
      settled = true;
    });

    // Routing follows the new mode immediately, while the widgets are still being rebuilt.
    expect(scene.mode).toBe('run');
    expect(editor.calls).toEqual(['cancelInteraction', 'setMode:run']);
    expect(host.reset).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await switching;
    expect(settled).toBe(true);
  });

  it('keeps the previous mode when the host rejects the reset', async () => {
    const host = createFakeHost();
    const scene = await mountScene(host);
    host.failNextReset(new Error('reset exploded'));

    await expect(scene.setMode('run')).rejects.toThrow('reset exploded');

    expect(scene.mode).toBe('edit');
    expect(editor.calls).toEqual(['cancelInteraction', 'setMode:run', 'setMode:edit']);
  });

  it('ignores a mode change after destroy', async () => {
    const host = createFakeHost();
    const scene = await mountScene(host);
    scene.destroy();

    await scene.setMode('run');

    expect(host.reset).not.toHaveBeenCalled();
    expect(scene.mode).toBe('edit');
  });

  it('forwards a host-side selection but drops ids the document does not contain', async () => {
    const host = createFakeHost(canvasDocument(widget('a'), widget('b')));
    const scene = await mountScene(host);

    scene.setSelection(['b', 'ghost']);

    expect(editor.setSelection).toHaveBeenCalledWith(['b']);
  });

  it('ignores a selection change after destroy', async () => {
    const host = createFakeHost(canvasDocument(widget('a')));
    const scene = await mountScene(host);
    scene.destroy();
    vi.mocked(editor.setSelection).mockClear();

    scene.setSelection(['a']);

    expect(editor.setSelection).not.toHaveBeenCalled();
  });

  it('destroys the editor and the subscriptions but never the host', async () => {
    const host = createFakeHost();
    const scene = await mountScene(host);
    const listener = vi.fn();
    scene.onPublish(listener);

    expect(host.publishListenerCount()).toBe(1);
    scene.destroy();

    expect(editor.destroy).toHaveBeenCalledTimes(1);
    expect(host.dispose).not.toHaveBeenCalled();
    expect(host.publishListenerCount()).toBe(0);

    // A destroyed scene is inert.
    host.emitPublish({ instanceId: 'a', port: 'press', payload: true, simTime: 0 });
    scene.deliver({ symbol: 'mcu', port: 'press' }, true, 0);
    expect(listener).not.toHaveBeenCalled();
    expect(host.deliver).not.toHaveBeenCalled();

    scene.destroy();
    expect(editor.destroy).toHaveBeenCalledTimes(1);
  });
});
