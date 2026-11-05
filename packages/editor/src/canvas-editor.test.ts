import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from '@mica-js/core/lifecycle';
import { timePs } from '@mica-js/core';
import type { CanvasDocument } from '@mica-js/document/canvas';
import { createCanvasEditor } from './canvas-editor';

const { createRuntime, createView } = vi.hoisted(() => ({
  createRuntime: vi.fn(),
  createView: vi.fn(),
}));
vi.mock('./canvas/runtime-factory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./canvas/runtime-factory')>()),
  CanvasRuntimeFactory: class {
    create = createRuntime;
  },
}));
vi.mock('./canvas/view', () => ({ createCanvasView: createView }));

const id = '11111111-1111-4111-8111-111111111111';
const source: CanvasDocument = {
  version: 1,
  widgets: [{ id, widget: 'demo:widget', x: 10, y: 10, width: 80, height: 40, rotation: 0 }],
};
const module = { definition: { properties: {}, ports: {} }, code: '' };
function options() {
  return {
    container: {} as HTMLElement,
    uri: 'https://test/main.cnv',
    fileSystem: { read: vi.fn(async () => new TextEncoder().encode(JSON.stringify(source))) },
    deviceLibrary: { resolve: vi.fn(async () => undefined) },
    widgetLibrary: { resolve: vi.fn(async () => module) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  createView.mockImplementation(() => ({
    render: vi.fn(),
    dispose: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    resetView: vi.fn(),
    fitView: vi.fn(),
  }));
  createRuntime.mockImplementation(async () => ({
    widgets: {
      onDidRender: new Emitter().event,
      mount: vi.fn(async () => {}),
      setBindings: vi.fn(async () => {}),
      step: vi.fn(async () => {}),
      dispatch: vi.fn(async () => {}),
    },
    simulation: {
      load: vi.fn(async () => {}),
      tick: vi.fn(async () => ({ simTime: timePs(1), executed: 1 })),
    },
    dispose: vi.fn(async () => {}),
  }));
});

describe('canvas editor factory', () => {
  it('loads through caller providers and emits only committed edits, undo and redo', async () => {
    const opts = options();
    const editor = await createCanvasEditor(opts);
    expect(editor.uri).toBe(opts.uri);
    expect(editor.state).toBe('ready');
    expect('getSandboxWorker' in editor).toBe(false);
    expect('save' in editor).toBe(false);
    expect('commands' in editor).toBe(false);
    const snapshots: CanvasDocument[] = [];
    const subscription = editor.onDidChangeContent((value) => snapshots.push(value));
    expect(snapshots).toHaveLength(0);
    await editor.executeCommand('canvas.apply', { type: 'remove-instance', instanceId: id });
    await editor.executeCommand('canvas.undo');
    await editor.executeCommand('canvas.redo');
    expect(snapshots.map((value) => value.widgets.length)).toEqual([0, 1, 0]);
    expect(opts.fileSystem.read).toHaveBeenCalledExactlyOnceWith(opts.uri);
    const view = createView.mock.results[0]!.value;
    subscription.dispose();
    const closing = editor.dispose();
    expect(editor.dispose()).toBe(closing);
    await closing;
    expect(view.dispose).toHaveBeenCalledExactlyOnceWith();
    expect(editor.state).toBe('disposed');
    await expect(editor.executeCommand('canvas.undo')).rejects.toThrow('disposed');
  });

  it('rejects content commands in readonly and simulation modes', async () => {
    const readonly = await createCanvasEditor({ ...options(), readOnly: true });
    await expect(readonly.executeCommand('canvas.undo')).rejects.toThrow('read-only');
    await readonly.dispose();
    const editor = await createCanvasEditor(options());
    await editor.executeCommand('canvas.setMode', 'simulation');
    await expect(editor.executeCommand('canvas.undo')).rejects.toThrow('edit mode');
    expect(await editor.executeCommand('canvas.status')).toMatchObject({
      mode: 'simulation',
      running: false,
    });
    await editor.dispose();
  });

  it('fails missing definitions before mounting a view or starting a worker', async () => {
    await expect(
      createCanvasEditor({ ...options(), widgetLibrary: { resolve: async () => undefined } }),
    ).rejects.toThrow('was not found');
    expect(createView).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('keeps viewport commands available in readonly simulation without changing content', async () => {
    const editor = await createCanvasEditor({ ...options(), readOnly: true });
    const changed = vi.fn();
    editor.onDidChangeContent(changed);
    await editor.executeCommand('canvas.setMode', 'simulation');
    const view = createView.mock.results[0]!.value;
    for (const action of ['zoomIn', 'zoomOut', 'resetView', 'fitView']) {
      await editor.executeCommand(`canvas.${action}`);
      expect(view[action]).toHaveBeenCalledOnce();
    }
    expect(changed).not.toHaveBeenCalled();
    expect(createRuntime).toHaveBeenCalledTimes(2);
    await editor.dispose();
  });

  it('rejects relative URIs before providers are called', async () => {
    const opts = options();
    await expect(createCanvasEditor({ ...opts, uri: 'main.cnv' })).rejects.toThrow();
    expect(opts.fileSystem.read).not.toHaveBeenCalled();
  });
});
