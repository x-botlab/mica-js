import { describe, expect, it } from 'vitest';
import { Commands, ICommandService } from './commands';
import { EditorLifecycle, type IEditorOptions } from './editor';
import { InstantiationService, ServiceCollection, SyncDescriptor } from './instantiation';

function createLifecycle(options: IEditorOptions = {}) {
  const services = new ServiceCollection();
  services.set(ICommandService, new SyncDescriptor(Commands));
  return new EditorLifecycle(new InstantiationService(services), options);
}

async function createTestEditor(options: IEditorOptions = {}) {
  const lifecycle = createLifecycle(options);
  await lifecycle.start();
  return lifecycle;
}

describe('IEditor', () => {
  it('lets an already executing command settle after shutdown', async () => {
    let finish!: (value: string) => void;
    const result = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const editor = await createTestEditor({
      commands: [{ id: 'pending', execute: () => result }],
    });
    const execution = editor.executeCommand('pending');
    await editor.dispose();
    finish('done');
    await expect(execution).resolves.toBe('done');
    await expect(editor.executeCommand('pending')).rejects.toThrow('not ready');
  });

  it.each([createTestEditor])(
    'creates one editor and releases its services: %s',
    async (createEditor) => {
      const editor = await createEditor({
        commands: [{ id: 'hello', execute: (name) => `Hello ${String(name)}` }],
      });
      expect(editor.state).toBe('ready');
      await expect(editor.executeCommand('hello', 'Mica')).resolves.toBe('Hello Mica');
      expect('listEditors' in editor).toBe(false);
      expect('resolveEditor' in editor).toBe(false);
      const disposal = editor.dispose();
      expect(editor.dispose()).toBe(disposal);
      await disposal;
      expect(editor.state).toBe('disposed');
      await expect(editor.executeCommand('hello')).rejects.toThrow('not ready');
    },
  );

  it('shares startup and rejects operations before ready', async () => {
    const editor = createLifecycle();
    expect(editor.state).toBe('created');
    await expect(editor.executeCommand('missing')).rejects.toThrow('not ready');
    const startup = editor.start();
    expect(editor.start()).toBe(startup);
    expect(editor.state).toBe('starting');
    await startup;
    expect(editor.start()).toBe(startup);
    await editor.dispose();
    await expect(editor.start()).rejects.toThrow('disposed');
  });

  it('cleans up partial startup and keeps failure stable', async () => {
    const editor = createLifecycle({
      commands: [
        { id: 'duplicate', execute: () => 1 },
        { id: 'duplicate', execute: () => 2 },
      ],
    });
    const startup = editor.start();
    await expect(startup).rejects.toThrow('Duplicate');
    expect(editor.state).toBe('failed');
    expect(editor.start()).toBe(startup);
    await expect(editor.executeCommand('duplicate')).rejects.toThrow('not ready');
    await editor.dispose();
    expect(editor.state).toBe('disposed');
  });

  it('cancels startup when disposed during startup or before starting', async () => {
    const editor = createLifecycle();
    const startup = editor.start();
    const disposal = editor.dispose();
    await expect(startup).rejects.toThrow('cancelled');
    await disposal;
    expect(editor.state).toBe('disposed');
    const unopened = createLifecycle();
    await unopened.dispose();
    await expect(unopened.start()).rejects.toThrow('disposed');
  });

  it('isolates editor services and snapshots configuration', async () => {
    const commands = [{ id: 'value', execute: () => 1 }];
    const first = createLifecycle({ commands });
    commands[0]!.execute = () => 2;
    await first.start();
    const second = await createTestEditor();
    await expect(first.executeCommand('value')).resolves.toBe(1);
    await expect(second.executeCommand('value')).rejects.toThrow('Unknown');
    await first.dispose();
    expect(second.state).toBe('ready');
    await second.dispose();
  });
});
