import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchematicEditor, type ISchematicEditor } from './schematic-editor';
import { createContainer, documentOf, installDomGlobals } from './schematic/editor/test-helpers';
import type { IDeviceDescription } from './providers';

let restore: () => void;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
  restore = installDomGlobals();
});
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  restore();
});

const description: IDeviceDescription = {
  definition: {
    kind: 'device',
    id: 'resistor',
    version: '1.0.0',
    displayName: 'Resistor',
    pins: { A: {}, B: {} },
    symbol: {
      bounds: { x: -12, y: -12, width: 24, height: 24 },
      graphics: [],
      pins: {
        A: { position: [-30, 0], direction: 'left' },
        B: { position: [30, 0], direction: 'right' },
      },
    },
    properties: {
      resistance: {
        type: 'number',
        required: false,
        default: 1000,
        title: 'Resistance',
        editor: { kind: 'number', min: 0 },
        unit: 'Ohm',
      },
      caption: { type: 'string', required: false, default: 'R', nullable: true },
    },
    designatorPrefix: 'R',
  },
  code: 'throw new Error("do not execute"); export default function() {}',
};
const uri = 'memory:///example.sch';
const bytes = () => new TextEncoder().encode(JSON.stringify(documentOf({})));

describe('schematic factory', () => {
  it('serializes edits and history while resolving devices and recovers after failure', async () => {
    let finish!: (value: IDeviceDescription) => void;
    const pending = new Promise<IDeviceDescription>((resolve) => {
      finish = resolve;
    });
    const editor = await createSchematicEditor({
      container: createContainer().container,
      uri,
      fileSystem: { read: async () => bytes() },
      deviceLibrary: {
        resolve: (id) => (id === 'demo:missing' ? Promise.resolve(undefined) : pending),
      },
    });
    cleanup.push(() => editor.dispose());
    const content = vi.fn();
    editor.onDidChangeContent(content);
    await expect(
      editor.executeCommand('schematic.addDevice', {
        deviceId: 'demo:missing',
        x: 0,
        y: 0,
      }),
    ).rejects.toThrow();
    expect(content).not.toHaveBeenCalled();
    const edit = editor.executeCommand('schematic.addDevice', {
      deviceId: 'demo:resistor',
      x: 0,
      y: 0,
    });
    const undo = editor.executeCommand('schematic.undo');
    finish(description);
    await Promise.all([edit, undo]);
    expect(content.mock.calls.map(([document]) => document.sheet.symbols.length)).toEqual([1, 0]);
  });

  it('loads a URI, mounts a view, emits edits and history, and owns only internal resources', async () => {
    const container = createContainer();
    const read = vi.fn(async () => bytes());
    const providerDispose = vi.fn();
    const resolve = vi.fn(async () => description);
    const files = { read, dispose: providerDispose };
    const library = { resolve, dispose: providerDispose };
    const editor = await createSchematicEditor({
      container: container.container,
      uri,
      fileSystem: files,
      deviceLibrary: library,
    });
    cleanup.push(() => editor.dispose());
    expect(read).toHaveBeenCalledExactlyOnceWith(uri);
    expect(editor.uri).toBe(uri);
    expect(editor.state).toBe('ready');
    expect(container.container.children).toHaveLength(1);
    const content = vi.fn();
    const subscription = editor.onDidChangeContent(content);
    await editor.executeCommand('schematic.addDevice', {
      deviceId: 'demo:resistor',
      x: 0,
      y: 0,
    });
    expect(resolve).toHaveBeenCalledExactlyOnceWith('demo:resistor');
    expect(content).toHaveBeenCalledTimes(1);
    expect(content.mock.calls[0]?.[0].sheet.symbols).toHaveLength(1);
    await editor.executeCommand('schematic.undo');
    expect(content.mock.calls[1]?.[0].sheet.symbols).toHaveLength(0);
    await editor.executeCommand('schematic.redo');
    expect(content.mock.calls[2]?.[0].sheet.symbols).toHaveLength(1);
    subscription.dispose();
    const disposal = editor.dispose();
    expect(editor.dispose()).toBe(disposal);
    await disposal;
    expect(editor.state).toBe('disposed');
    expect(container.container.children).toHaveLength(0);
    expect(providerDispose).not.toHaveBeenCalled();
    await expect(editor.executeCommand('schematic.undo')).rejects.toThrow('disposed');
  });

  it('loads only IDs referenced by a document and does not execute device code', async () => {
    const document = documentOf({
      symbols: [
        {
          id: '00000003-41e6-4a4c-869a-82a4cd304787',
          device: 'demo:resistor',
          x: 0,
          y: 0,
          rotation: 0,
          properties: {},
        },
      ],
    });
    const resolve = vi.fn(async () => description);
    const container = createContainer();
    const editor = await createSchematicEditor({
      container: container.container,
      uri,
      fileSystem: { read: async () => new TextEncoder().encode(JSON.stringify(document)) },
      deviceLibrary: { resolve },
    });
    cleanup.push(() => editor.dispose());
    expect(resolve).toHaveBeenCalledExactlyOnceWith('demo:resistor');
    expect(container.container.children).toHaveLength(1);
  });

  it('leaves the container untouched on read, parse or missing-device failure', async () => {
    for (const read of [
      async () => {
        throw new Error('offline');
      },
      async () => new TextEncoder().encode('invalid JSON'),
      async () =>
        new TextEncoder().encode(
          JSON.stringify(
            documentOf({
              symbols: [
                {
                  id: '00000003-41e6-4a4c-869a-82a4cd304787',
                  device: 'demo:missing',
                  x: 0,
                  y: 0,
                  rotation: 0,
                  properties: {},
                },
              ],
            }),
          ),
        ),
    ]) {
      const container = createContainer();
      await expect(
        createSchematicEditor({
          container: container.container,
          uri,
          fileSystem: { read },
          deviceLibrary: { resolve: async () => undefined },
        }),
      ).rejects.toThrow();
      expect(container.container.children).toHaveLength(0);
    }
  });

  it('rejects invalid URIs before reading and blocks edits in read-only mode', async () => {
    const read = vi.fn(async () => bytes());
    const options = {
      container: createContainer().container,
      uri: 'relative.sch',
      fileSystem: { read },
      deviceLibrary: { resolve: async () => description },
    };
    await expect(createSchematicEditor(options)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    const editor = await createSchematicEditor({ ...options, uri, readOnly: true });
    cleanup.push(() => editor.dispose());
    await expect(
      editor.executeCommand('schematic.addDevice', {
        deviceId: 'demo:resistor',
        x: 0,
        y: 0,
      }),
    ).rejects.toThrow('read-only');
    await expect(editor.executeCommand('schematic.undo')).rejects.toThrow('read-only');
    // @ts-expect-error Unknown command names are rejected by the public map.
    await expect(editor.executeCommand('save')).rejects.toThrow('Unknown command');
    expect('save' in editor).toBe(false);
    expect('isDirty' in editor).toBe(false);
  });

  it('does not commit an edit whose device is still resolving when closed', async () => {
    let finish!: (value: IDeviceDescription) => void;
    const library = new Promise<IDeviceDescription>((resolve) => {
      finish = resolve;
    });
    const editor = await createSchematicEditor({
      container: createContainer().container,
      uri,
      fileSystem: { read: async () => bytes() },
      deviceLibrary: { resolve: () => library },
    });
    const content = vi.fn();
    editor.onDidChangeContent(content);
    const edit = editor.executeCommand('schematic.addDevice', {
      deviceId: 'demo:resistor',
      x: 0,
      y: 0,
    });
    await Promise.resolve();
    await Promise.resolve();
    const rejected = expect(edit).rejects.toThrow('disposed');
    await editor.dispose();
    finish(description);
    await rejected;
    expect(content).not.toHaveBeenCalled();
  });

  it('exposes detached initial content, properties and integration state; batches one undo step', async () => {
    const editor = await createSchematicEditor({
      container: createContainer().container,
      uri,
      fileSystem: { read: async () => bytes() },
      deviceLibrary: { resolve: async () => description },
    });
    cleanup.push(() => editor.dispose());
    expect(editor.getDocument()).toEqual(documentOf({}));
    expect(Object.isFrozen(editor.getDocument().sheet.symbols)).toBe(true);
    expect(editor.getState()).toEqual({
      readOnly: false,
      mode: 'edit',
      canUndo: false,
      canRedo: false,
      tool: 'select',
    });
    const states = vi.fn();
    editor.onDidChangeState(states);
    const symbolId = await editor.executeCommand('schematic.addDevice', {
      deviceId: 'demo:resistor',
      x: 0,
      y: 0,
    });
    expect(editor.getProperties(symbolId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'resistance',
          label: 'Resistance',
          value: 1000,
          defaultValue: 1000,
          overrideValue: undefined,
          overridden: false,
          readOnly: false,
          min: 0,
          unit: 'Ohm',
        }),
      ]),
    );
    expect(editor.getProperties('missing')).toEqual([]);
    const changed = vi.fn();
    editor.onDidChangeContent(changed);
    await editor.executeCommand('schematic.setProperties', {
      symbolId,
      values: { resistance: 2200, caption: null },
    });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(changed.mock.calls[0]?.[0].sheet.symbols[0].properties)).toBe(true);
    expect(editor.getProperties(symbolId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'caption',
          value: null,
          overrideValue: null,
          overridden: true,
        }),
      ]),
    );
    await editor.executeCommand('schematic.undo');
    expect(editor.getProperties(symbolId).every((field) => !field.overridden)).toBe(true);
    await editor.executeCommand('schematic.redo');
    await editor.executeCommand('schematic.setProperties', {
      symbolId,
      values: {},
      remove: ['resistance'],
    });
    expect(
      editor.getProperties(symbolId).find((field) => field.key === 'resistance')?.overridden,
    ).toBe(false);
    const before = editor.getDocument();
    changed.mockClear();
    const errors = vi.fn();
    editor.onDidError(errors);
    await expect(
      editor.executeCommand('schematic.setProperties', {
        symbolId,
        values: { resistance: 3300, caption: 42 },
      }),
    ).rejects.toThrow();
    expect(editor.getDocument()).toEqual(before);
    expect(changed).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: 'command' }));
    await editor.executeCommand('schematic.setProperty', {
      symbolId,
      key: 'resistance',
      value: 4700,
    });
    expect(editor.getProperties(symbolId).find((field) => field.key === 'resistance')?.value).toBe(
      4700,
    );
    expect(states).toHaveBeenCalledWith(expect.objectContaining({ canUndo: true }));
    expect(Object.isFrozen(editor.getProperties(symbolId)[0])).toBe(true);
  });

  it('prunes selection on deletion and history and detaches selection input/output', async () => {
    const editor = await createSchematicEditor({
      container: createContainer().container,
      uri,
      fileSystem: { read: async () => bytes() },
      deviceLibrary: { resolve: async () => description },
    });
    cleanup.push(() => editor.dispose());
    const symbolId = await editor.executeCommand('schematic.addDevice', {
      deviceId: 'demo:resistor',
      x: 0,
      y: 0,
    });
    const selected = [{ kind: 'symbol' as const, id: symbolId }];
    const change = vi.fn();
    editor.onDidChangeSelection(change);
    editor.setSelection(selected);
    selected[0]!.id = 'host-mutated';
    expect(editor.getSelection()).toEqual([{ kind: 'symbol', id: symbolId }]);
    expect(Object.isFrozen(editor.getSelection()[0])).toBe(true);
    editor.setSelection([{ kind: 'symbol', id: symbolId }]);
    expect(change).toHaveBeenCalledTimes(1);
    await editor.executeCommand('schematic.deleteSelection');
    expect(editor.getSelection()).toEqual([]);
    await editor.executeCommand('schematic.undo');
    editor.setSelection([{ kind: 'symbol', id: symbolId }]);
    await editor.executeCommand('schematic.undo');
    expect(editor.getSelection()).toEqual([]);
    expect(change.mock.calls.map(([value]) => value.length)).toEqual([1, 0, 1, 0]);
    expect(Object.isFrozen(change.mock.calls[0]?.[0])).toBe(true);
  });

  it('reports ordered click, repeated click, double click and context events, but not drags or pan', async () => {
    const container = createContainer();
    const editor = await createSchematicEditor({
      container: container.container,
      uri,
      fileSystem: { read: async () => bytes() },
      deviceLibrary: { resolve: async () => description },
    });
    cleanup.push(() => editor.dispose());
    const symbolId = await editor.executeCommand('schematic.addDevice', {
      deviceId: 'demo:resistor',
      x: 0,
      y: 0,
    });
    await editor.executeCommand('schematic.resetView');
    const canvas = container.document.find('canvas')!;
    const order: string[] = [];
    editor.onDidChangeSelection(() => order.push('selection'));
    const clicks = vi.fn(() => order.push('click'));
    const doubles = vi.fn();
    const contexts = vi.fn();
    const changed = vi.fn();
    editor.onDidClick(clicks);
    editor.onDidDoubleClick(doubles);
    editor.onDidContextMenu(contexts);
    editor.onDidChangeContent(changed);
    const pointer = (x: number, y: number, button = 0) => ({
      clientX: x,
      clientY: y,
      button,
      pointerId: 1,
      shiftKey: false,
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      preventDefault: vi.fn(),
    });
    const tap = (x: number, y: number) => {
      canvas.emit('pointerdown', pointer(x, y));
      canvas.emit('pointerup', pointer(x, y));
    };
    tap(0, 0);
    tap(0, 0);
    expect(order).toEqual(['selection', 'click', 'click']);
    expect(clicks).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: 'symbol', id: symbolId },
        position: { x: 0, y: 0 },
        clientPosition: { x: 0, y: 0 },
        mode: 'edit',
        altKey: true,
        button: 0,
      }),
    );
    canvas.emit('dblclick', pointer(0, 0));
    expect(doubles).toHaveBeenCalledOnce();
    const menu = pointer(0, 0, 2);
    canvas.emit('contextmenu', menu);
    expect(contexts).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: 'symbol', id: symbolId }, button: 2 }),
    );
    expect(menu.preventDefault).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();
    canvas.emit('pointerdown', pointer(0, 0));
    canvas.emit('pointermove', pointer(20, 10));
    canvas.emit('pointerup', pointer(20, 10));
    expect(clicks).toHaveBeenCalledTimes(2);
    canvas.emit('pointerdown', pointer(100, 100, 1));
    canvas.emit('pointermove', pointer(150, 140, 1));
    canvas.emit('pointerup', pointer(150, 140, 1));
    expect(clicks).toHaveBeenCalledTimes(2);
    tap(700, 500);
    expect(clicks).toHaveBeenLastCalledWith(expect.objectContaining({ target: null }));
    expect(Object.isFrozen(contexts.mock.calls[0]?.[0].position)).toBe(true);
    const count = clicks.mock.calls.length;
    await editor.dispose();
    tap(0, 0);
    expect(clicks).toHaveBeenCalledTimes(count);
    expect(() => editor.setSelection([])).toThrow('disposed');
  });

  it('maps semantic device, wire, selection, property, tool and viewport commands', async () => {
    const editor = await createSchematicEditor({
      container: createContainer().container,
      uri,
      fileSystem: { read: async () => bytes() },
      deviceLibrary: { resolve: async () => description },
    });
    cleanup.push(() => editor.dispose());
    const symbolId = await editor.executeCommand('schematic.addDevice', {
      deviceId: 'demo:resistor',
      x: 0,
      y: 0,
    });
    await editor.executeCommand('schematic.updateDevice', {
      symbolId,
      x: 10,
      y: 20,
      designator: 'R2',
    });
    editor.setSelection([{ kind: 'symbol', id: symbolId }]);
    await editor.executeCommand('schematic.moveSelection', { dx: 5, dy: 10 });
    await editor.executeCommand('schematic.rotateSelection', { degrees: 90 });
    expect(editor.getDocument().sheet.symbols[0]).toMatchObject({
      id: symbolId,
      x: 15,
      y: 30,
      rotation: 90,
      designator: 'R2',
    });
    await editor.executeCommand('schematic.setProperty', { symbolId, key: 'resistance', value: 2 });
    await editor.executeCommand('schematic.removeProperty', { symbolId, key: 'resistance' });
    expect(editor.getProperties(symbolId).find((field) => field.key === 'resistance')?.value).toBe(
      1000,
    );
    const wireId = await editor.executeCommand('schematic.addWire', {
      points: [
        { x: 100, y: 100 },
        { x: 200, y: 100 },
      ],
    });
    await editor.executeCommand('schematic.setWirePoints', {
      wireId,
      points: [
        { x: 100, y: 100 },
        { x: 300, y: 100 },
      ],
    });
    expect(editor.getDocument().sheet.wires[0]).toMatchObject({
      id: wireId,
      points: [
        { x: 100, y: 100 },
        { x: 300, y: 100 },
      ],
    });
    await editor.executeCommand('schematic.removeWire', { wireId });
    expect(editor.getDocument().sheet.wires).toEqual([]);
    await editor.executeCommand('schematic.removeDevice', { symbolId });
    expect(editor.getSelection()).toEqual([]);
    await editor.executeCommand('schematic.placeDevice', { deviceId: 'demo:resistor' });
    await editor.executeCommand('schematic.setTool', { tool: 'wire' });
    expect(editor.getState().tool).toBe('wire');
    await editor.executeCommand('schematic.zoom', { scale: 2 });
    await editor.executeCommand('schematic.fit');
    await editor.executeCommand('schematic.resetView');
  });

  it('cleans up listeners when mounting fails after view initialization', async () => {
    const container = createContainer();
    container.container.append = () => {
      throw new Error('mount failed');
    };
    await expect(
      createSchematicEditor({
        container: container.container,
        uri,
        fileSystem: { read: async () => bytes() },
        deviceLibrary: { resolve: async () => description },
      }),
    ).rejects.toThrow('mount failed');
    const preventDefault = vi.fn();
    container.document
      .find('canvas')!
      .emit('contextmenu', { clientX: 0, clientY: 0, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(container.container.children).toHaveLength(0);
  });

  it('bridges internal gesture rejections as detached runtime errors', async () => {
    const container = createContainer();
    const editor = await createSchematicEditor({
      container: container.container,
      uri,
      fileSystem: { read: async () => bytes() },
      deviceLibrary: { resolve: async () => description },
    });
    cleanup.push(() => editor.dispose());
    await editor.executeCommand('schematic.addDevice', { deviceId: 'demo:resistor', x: 0, y: 0 });
    await editor.executeCommand('schematic.resetView');
    const errors = vi.fn();
    editor.onDidError(errors);
    const before = editor.getDocument();
    const canvas = container.document.find('canvas')!;
    const event = { clientX: 0, clientY: 0, button: 0, pointerId: 1, preventDefault: vi.fn() };
    canvas.emit('pointerdown', event);
    canvas.emit('pointermove', { ...event, clientX: Number.NaN });
    canvas.emit('pointerup', { ...event, clientX: Number.NaN });
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ source: 'runtime' }));
    expect(Object.isFrozen(errors.mock.calls[0]?.[0])).toBe(true);
    expect(editor.getDocument()).toEqual(before);
    await editor.executeCommand('schematic.undo');
    expect(editor.getDocument().sheet.symbols).toEqual([]);
  });

  it('identifies pin targets and separates CSS client coordinates from document units', async () => {
    const container = createContainer();
    const editor = await createSchematicEditor({
      container: container.container,
      uri,
      fileSystem: { read: async () => bytes() },
      deviceLibrary: { resolve: async () => description },
    });
    cleanup.push(() => editor.dispose());
    const symbolId = await editor.executeCommand('schematic.addDevice', {
      deviceId: 'demo:resistor',
      x: 100,
      y: 100,
    });
    await editor.executeCommand('schematic.resetView');
    const events = vi.fn();
    editor.onDidContextMenu(events);
    const canvas = container.document.find('canvas')!;
    canvas.getBoundingClientRect = () => ({ left: 20, top: 30, width: 800, height: 600 });
    canvas.emit('contextmenu', {
      clientX: 90,
      clientY: 130,
      button: 2,
      ctrlKey: true,
      preventDefault: vi.fn(),
    });
    expect(events).toHaveBeenLastCalledWith(
      expect.objectContaining({
        target: { kind: 'pin', symbolId, pinId: 'A' },
        position: { x: 70, y: 100 },
        clientPosition: { x: 90, y: 130 },
        ctrlKey: true,
      }),
    );
    editor.setSelection([{ kind: 'pin', symbolId, pinId: 'missing' }]);
    expect(editor.getSelection()).toEqual([]);
    editor.setSelection([{ kind: 'pin', symbolId, pinId: 'A' }]);
    expect(editor.getSelection()).toEqual([{ kind: 'pin', symbolId, pinId: 'A' }]);
    await editor.executeCommand('schematic.zoom', { scale: 2 });
    canvas.emit('contextmenu', { clientX: 90, clientY: 130, button: 2, preventDefault: vi.fn() });
    expect(events).toHaveBeenLastCalledWith(
      expect.objectContaining({ position: { x: 235, y: 200 }, clientPosition: { x: 90, y: 130 } }),
    );
    await editor.executeCommand('schematic.removeDevice', { symbolId });
    expect(editor.getSelection()).toEqual([]);
  });

  it('does not report canceled gestures or even small committed drags as clicks', async () => {
    const container = createContainer();
    const editor = await createSchematicEditor({
      container: container.container,
      uri,
      fileSystem: { read: async () => bytes() },
      deviceLibrary: { resolve: async () => description },
    });
    cleanup.push(() => editor.dispose());
    await editor.executeCommand('schematic.addDevice', { deviceId: 'demo:resistor', x: 0, y: 0 });
    await editor.executeCommand('schematic.resetView');
    const canvas = container.document.find('canvas')!;
    const clicks = vi.fn();
    editor.onDidClick(clicks);
    const event = { clientX: 0, clientY: 0, button: 0, pointerId: 1, preventDefault: vi.fn() };
    canvas.emit('pointerdown', event);
    canvas.emit('pointercancel', event);
    canvas.emit('pointerup', event);
    expect(clicks).not.toHaveBeenCalled();
    // The designator can be dragged without grid snapping, even by one CSS pixel.
    const reference = editor.getDocument().sheet.symbols[0]!;
    await editor.executeCommand('schematic.updateDevice', {
      symbolId: reference.id,
      reference: { x: 0, y: 50 },
    });
    const down = { ...event, clientX: 0, clientY: 50 };
    const up = { ...down, clientX: 1 };
    canvas.emit('pointerdown', down);
    canvas.emit('pointermove', up);
    canvas.emit('pointerup', up);
    expect(clicks).not.toHaveBeenCalled();
  });

  it('allows readonly selection and pointer queries while rejecting every content command', async () => {
    const symbolId = '00000003-41e6-4a4c-869a-82a4cd304787';
    const value = documentOf({
      symbols: [{ id: symbolId, device: 'demo:resistor', x: 0, y: 0, rotation: 0 }],
    });
    const container = createContainer();
    const editor = await createSchematicEditor({
      container: container.container,
      uri,
      readOnly: true,
      fileSystem: { read: async () => new TextEncoder().encode(JSON.stringify(value)) },
      deviceLibrary: { resolve: async () => description },
    });
    cleanup.push(() => editor.dispose());
    const clicks = vi.fn();
    editor.onDidClick(clicks);
    const selections = vi.fn();
    editor.onDidChangeSelection(selections);
    editor.setSelection([{ kind: 'symbol', id: symbolId }]);
    await editor.executeCommand('schematic.resetView');
    const event = {
      clientX: 0,
      clientY: 0,
      button: 0,
      pointerId: 1,
      shiftKey: false,
      preventDefault: vi.fn(),
    };
    container.document.find('canvas')!.emit('pointerdown', event);
    container.document.find('canvas')!.emit('pointerup', event);
    expect(clicks).toHaveBeenCalledOnce();
    expect(selections).toHaveBeenCalledOnce();
    expect(editor.getProperties(symbolId).every((field) => field.readOnly)).toBe(true);
    for (const id of ['schematic.deleteSelection', 'schematic.undo', 'schematic.redo'] as const)
      await expect(editor.executeCommand(id)).rejects.toThrow('read-only');
    await expect(
      editor.executeCommand('schematic.setProperty', { symbolId, key: 'resistance', value: 5 }),
    ).rejects.toThrow('read-only');
    expect(editor.getDocument()).toEqual(value);
  });
});

function commandTypeAssertions(editor: ISchematicEditor): void {
  // @ts-expect-error Document algorithm commands are not public.
  void editor.executeCommand('schematic.apply', { type: 'remove-symbol', id: 'id' });
  // @ts-expect-error Device placement uses an object parameter.
  void editor.executeCommand('schematic.placeDevice', 'demo:resistor');
  // @ts-expect-error Batch updates require values, not the former properties parameter.
  void editor.executeCommand('schematic.setProperties', { symbolId: 'id', properties: {} });
  // @ts-expect-error Wrong coordinate type.
  void editor.executeCommand('schematic.moveSelection', { dx: '1', dy: 2 });
  // @ts-expect-error Parameterless commands do not accept an argument.
  void editor.executeCommand('schematic.undo', {});
  const result: Promise<string> = editor.executeCommand('schematic.addWire', {
    points: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ],
  });
  void result;
}
void commandTypeAssertions;
