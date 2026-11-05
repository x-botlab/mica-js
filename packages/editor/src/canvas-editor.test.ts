import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from '@mica-js/core/lifecycle';
import { timePs } from '@mica-js/core';
import type { CanvasDocument } from '@mica-js/document/canvas';
import { createCanvasEditor, type ICanvasEditor } from './canvas-editor';

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
    getSelection: vi.fn(() => []),
    setSelection: vi.fn(),
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
  it('constrains command names, object parameters and results at compile time', () => {
    const check = (editor: ICanvasEditor) => {
      const result: Promise<void> = editor.executeCommand('canvas.setProperty', {
        instanceId: id,
        key: 'x',
        value: 1,
      });
      // @ts-expect-error Arbitrary string commands are not public API.
      void editor.executeCommand('canvas.apply', { type: 'remove-instance', instanceId: id });
      // @ts-expect-error Mode commands require named object parameters.
      void editor.executeCommand('canvas.setMode', 'edit');
      // @ts-expect-error Property writes require a value.
      void editor.executeCommand('canvas.setProperty', { instanceId: id, key: 'x' });
      // @ts-expect-error Void commands do not accept arguments.
      void editor.executeCommand('canvas.undo', {});
      return result;
    };
    expect(check).toBeTypeOf('function');
  });
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
    await editor.executeCommand('canvas.removeWidget', { instanceId: id });
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
    await editor.executeCommand('canvas.setMode', { mode: 'simulation' });
    await expect(editor.executeCommand('canvas.undo')).rejects.toThrow('edit mode');
    expect(editor.getState()).toMatchObject({
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
    await editor.executeCommand('canvas.setMode', { mode: 'simulation' });
    const view = createView.mock.results[0]!.value;
    for (const action of ['zoomIn', 'zoomOut', 'resetView', 'fitView'] as const) {
      await editor.executeCommand(`canvas.${action}`);
      expect(view[action]).toHaveBeenCalledOnce();
    }
    expect(changed).not.toHaveBeenCalled();
    expect(createRuntime).toHaveBeenCalledTimes(2);
    await editor.dispose();
  });

  it('exposes detached snapshots and batches properties into one undo step', async () => {
    const opts = {
      ...options(),
      widgetLibrary: {
        resolve: vi.fn(async () => ({
          code: '',
          definition: {
            properties: {
              count: { type: 'number', default: 3, label: 'Count', min: 0 },
              title: { type: 'string', default: 'hello' },
            },
            ports: {},
          },
        })),
      },
    };
    const editor = await createCanvasEditor(opts);
    const changed = vi.fn();
    editor.onDidChangeContent(changed);
    await editor.executeCommand('canvas.setProperties', { instanceId: id, values: {} });
    expect(editor.getState().canUndo).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    expect(editor.getProperties(id)).toEqual([
      expect.objectContaining({
        key: 'count',
        value: 3,
        defaultValue: 3,
        overridden: false,
        min: 0,
      }),
      expect.objectContaining({ key: 'title', value: 'hello' }),
    ]);
    await editor.executeCommand('canvas.setProperties', {
      instanceId: id,
      values: { count: 9, title: 'new' },
    });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(editor.getProperties(id)[0]).toMatchObject({
      value: 9,
      overrideValue: 9,
      overridden: true,
    });
    const snapshot = editor.getDocument();
    expect(snapshot).not.toBe(editor.getDocument());
    expect(Object.isFrozen(snapshot.widgets[0])).toBe(true);
    expect(Object.isFrozen(changed.mock.calls[0]![0].widgets[0])).toBe(true);
    await editor.executeCommand('canvas.undo');
    expect(editor.getDocument()).toEqual(source);
    expect(editor.getState()).toMatchObject({ canUndo: false, canRedo: true });
    await editor.executeCommand('canvas.redo');
    await editor.executeCommand('canvas.setProperties', {
      instanceId: id,
      values: { count: 5 },
      remove: ['title'],
    });
    expect(editor.getDocument().widgets[0]!.properties).toEqual({ count: 5 });
    const beforeFailure = editor.getDocument();
    await expect(
      editor.executeCommand('canvas.setProperties', {
        instanceId: id,
        values: { count: 7, unknown: 1 },
      }),
    ).rejects.toThrow();
    expect(editor.getDocument()).toEqual(beforeFailure);
    expect(opts.widgetLibrary.resolve).toHaveBeenCalledTimes(1);
    await editor.dispose();
  });

  it('queries binding compatibility without executing device code and rolls back association changes', async () => {
    const original = {
      ...source,
      schematic: 'main.sch',
      widgets: [{ ...source.widgets[0]!, bindings: { value: { symbol: id, port: 'out' } } }],
    };
    const schematic = {
      version: 1,
      sheet: {
        symbols: [{ id, device: 'demo:device', designator: 'K1', x: 0, y: 0, rotation: 0 }],
        wires: [],
        junctions: [],
      },
    };
    const files = {
      read: vi.fn(async (uri: string) => {
        if (uri.endsWith('missing.sch')) throw new Error('missing schematic');
        return new TextEncoder().encode(
          JSON.stringify(uri.endsWith('.cnv') ? original : schematic),
        );
      }),
    };
    const editor = await createCanvasEditor({
      ...options(),
      uri: 'https://test/project/nested/main.cnv',
      projectRoot: 'https://test/project/',
      fileSystem: files,
      widgetLibrary: {
        resolve: async () => ({
          code: '',
          definition: { properties: {}, ports: { value: { direction: 'input', type: 'number' } } },
        }),
      },
      deviceLibrary: {
        resolve: async () => ({
          code: 'throw new Error("must not execute for metadata")',
          definition: {
            kind: 'device',
            id: 'device',
            version: '1',
            displayName: 'Device',
            ports: {
              out: { direction: 'output', type: 'number' },
              input: { direction: 'input', type: 'number' },
              text: { direction: 'output', type: 'string' },
              message: { direction: 'output', type: 'number', delivery: 'message' },
            },
          },
        }),
      },
    });
    const runtime = await createRuntime.mock.results[0]!.value;
    const queries = editor.getBindings(id);
    expect(queries[0]).toMatchObject({
      port: 'value',
      direction: 'input',
      type: 'number',
      target: { symbol: id, port: 'out' },
    });
    expect(queries[0]!.candidates[0]!.label).toBe('K1 / Device / out');
    expect(queries[0]!.candidates.map((candidate) => candidate.compatible)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(queries[0]!.candidates.slice(1).every((candidate) => !!candidate.reason)).toBe(true);
    expect(Object.isFrozen(queries[0]!.candidates)).toBe(true);
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(files.read).toHaveBeenCalledWith('https://test/project/main.sch');
    const changed = vi.fn();
    editor.onDidChangeContent(changed);
    await expect(
      editor.executeCommand('canvas.setSchematic', { path: 'missing.sch' }),
    ).rejects.toThrow('missing schematic');
    expect(editor.getDocument()).toEqual(original);
    expect(runtime.dispose).not.toHaveBeenCalled();
    expect(editor.getState().canUndo).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    await editor.executeCommand('canvas.setSchematic', { path: null });
    expect(editor.getDocument().schematic).toBeUndefined();
    expect(editor.getDocument().widgets[0]!.bindings).toBeUndefined();
    await editor.executeCommand('canvas.undo');
    expect(editor.getDocument()).toEqual(original);
    expect(editor.getState().canUndo).toBe(false);
    await editor.executeCommand('canvas.setSchematic', { path: 'other.sch', bindings: 'clear' });
    expect(editor.getDocument().widgets[0]!.bindings).toBeUndefined();
    await editor.executeCommand('canvas.undo');
    expect(editor.getDocument()).toEqual(original);
    await expect(
      editor.executeCommand('canvas.setBinding', {
        instanceId: id,
        port: 'value',
        target: { symbol: id, port: 'message' },
      }),
    ).rejects.toThrow('delivery');
    await editor.dispose();
  });

  it('keeps model history and active runtime intact when a candidate fails to mount', async () => {
    const editor = await createCanvasEditor(options());
    const initial = await createRuntime.mock.results[0]!.value;
    const candidate = {
      ...initial,
      widgets: {
        ...initial.widgets,
        mount: vi.fn(async () => {
          throw new Error('candidate failed');
        }),
      },
      dispose: vi.fn(async () => {}),
    };
    createRuntime.mockResolvedValueOnce(candidate);
    await expect(
      editor.executeCommand('canvas.setPlacement', {
        instanceId: id,
        placement: { x: 10, y: 10, width: 90, height: 40, rotation: 0 },
      }),
    ).rejects.toThrow('candidate failed');
    expect(initial.dispose).not.toHaveBeenCalled();
    expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(editor.getDocument()).toEqual(source);
    expect(editor.getState().canUndo).toBe(false);
    await editor.executeCommand('canvas.removeWidget', { instanceId: id });
    await editor.executeCommand('canvas.undo');
    expect(editor.getDocument()).toEqual(source);
    await editor.dispose();
  });

  it('emits deduplicated integration state and shared command errors', async () => {
    const editor = await createCanvasEditor(options());
    const states = vi.fn();
    const errors = vi.fn();
    editor.onDidChangeState(states);
    editor.onDidError(errors);
    await editor.executeCommand('canvas.setMode', { mode: 'simulation' });
    await editor.executeCommand('canvas.run');
    await editor.executeCommand('canvas.run');
    await editor.executeCommand('canvas.pause');
    await editor.executeCommand('canvas.pause');
    expect(states.mock.calls.map(([state]) => [state.mode, state.running])).toEqual([
      ['simulation', false],
      ['simulation', true],
      ['simulation', false],
    ]);
    await expect(editor.executeCommand('canvas.removeWidget', { instanceId: id })).rejects.toThrow(
      'edit mode',
    );
    expect(errors).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: 'command' }));
    await editor.dispose();
  });

  it('rejects relative URIs before providers are called', async () => {
    const opts = options();
    await expect(createCanvasEditor({ ...opts, uri: 'main.cnv' })).rejects.toThrow();
    expect(opts.fileSystem.read).not.toHaveBeenCalled();
  });
});
