import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchematicEditor } from './schematic-editor';
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
      editor.executeCommand('schematic.apply', {
        type: 'add-symbol',
        device: 'demo:missing',
        x: 0,
        y: 0,
      }),
    ).rejects.toThrow();
    expect(content).not.toHaveBeenCalled();
    const edit = editor.executeCommand('schematic.apply', {
      type: 'add-symbol',
      device: 'demo:resistor',
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
    await editor.executeCommand('schematic.apply', {
      type: 'add-symbol',
      device: 'demo:resistor',
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
      editor.executeCommand('schematic.apply', {
        type: 'add-symbol',
        device: 'demo:resistor',
        x: 0,
        y: 0,
      }),
    ).rejects.toThrow('read-only');
    await expect(editor.executeCommand('schematic.undo')).rejects.toThrow('read-only');
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
    const edit = editor.executeCommand('schematic.apply', {
      type: 'add-symbol',
      device: 'demo:resistor',
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
});
