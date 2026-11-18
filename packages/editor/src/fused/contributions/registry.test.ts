import { describe, expect, it } from 'vitest';
import { createContextKeyService } from '../context';
import type { IWorkbenchContributions, IWorkbenchToolbarItem } from '../types';
import { ContributionRegistry } from './registry';

const builtin: IWorkbenchContributions = {
  containers: [{ id: 'mica.properties', title: 'Properties', icon: 'settings-gear' }],
};
describe('workbench contributions', () => {
  it('evaluates inherited workbench keys and host enablement independently', () => {
    const root = createContextKeyService({ owner: 'workbench' });
    const mode = root.createKey('workbench.mode', 'edit');
    const host = root.createScope();
    const allowed = host.createKey('host.allowed', false);
    const item: IWorkbenchToolbarItem = {
      id: 'host.add',
      title: 'Add',
      when: "workbench.mode == 'edit'",
      enablement: 'host.allowed',
      execute() {},
    };
    const registry = new ContributionRegistry(host, builtin, { toolbar: [item] });
    expect(registry.visible(item)).toBe(true);
    expect(registry.enabled(item)).toBe(false);
    allowed.set(true);
    expect(registry.enabled(item)).toBe(true);
    mode.set('run');
    expect(registry.visible(item)).toBe(false);
    expect(registry.affected(new Set(['host.allowed']))).toBe(true);
    expect(registry.affected(new Set(['host.unrelated']))).toBe(false);
    root.dispose();
  });
  it.each([
    { containers: [{ id: 'mica.override', title: 'Override', icon: 'add' }] },
    {
      containers: [
        { id: 'host.duplicate', title: 'One', icon: 'add' },
        { id: 'host.duplicate', title: 'Two', icon: 'add' },
      ],
    },
    {
      views: [
        {
          id: 'host.view',
          title: 'Missing container',
          containerId: 'host.missing',
          mount: () => ({ dispose() {} }),
        },
      ],
    },
    {
      toolbar: [
        { id: 'host.command', title: 'Invalid condition', when: 'host.check()', execute() {} },
      ],
    },
  ] satisfies IWorkbenchContributions[])(
    'rejects invalid registration before mounting a view',
    (contributions) => {
      const context = createContextKeyService();
      expect(() => new ContributionRegistry(context, builtin, contributions)).toThrow();
      context.dispose();
    },
  );
});
