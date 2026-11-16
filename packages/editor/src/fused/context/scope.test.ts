import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_CONTEXT_PREFIXES,
  ContextRegistrationError,
  createContextKeyService,
  parseCondition,
  type IContextChangeEvent,
  type IContextKeyService,
} from './index';

function captureEvents(scope: IContextKeyService): IContextChangeEvent[] {
  const events: IContextChangeEvent[] = [];
  scope.onDidChange((event) => {
    events.push(event);
  });
  return events;
}

describe('context key service', () => {
  it('creates typed keys with defaults and local values', () => {
    const context = createContextKeyService({ owner: 'workbench' });
    const kind = context.createKey('workbench.selection.kind', 'none', { owner: 'workbench' });

    expect(kind.name).toBe('workbench.selection.kind');
    expect(kind.owner).toBe('workbench');
    expect(kind.value).toBeUndefined();
    expect(context.getValue('workbench.selection.kind')).toBe('none');
    expect(context.getValue('workbench.unknown')).toBeUndefined();

    kind.set('symbol');
    expect(kind.value).toBe('symbol');
    expect(context.getValue('workbench.selection.kind')).toBe('symbol');

    kind.reset();
    expect(kind.value).toBeUndefined();
    expect(context.getValue('workbench.selection.kind')).toBe('none');
  });

  it('rejects duplicate names, wrong value types and disposed keys', () => {
    const context = createContextKeyService({ owner: 'workbench' });
    const count = context.createKey('workbench.count', 0, { owner: 'workbench' });

    const duplicate = (() => {
      try {
        context.createKey('workbench.count', 1, { owner: 'workbench' });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(duplicate).toBeInstanceOf(ContextRegistrationError);
    expect((duplicate as ContextRegistrationError).reason).toBe('duplicate-key');

    expect(() => count.set('one' as unknown as number)).toThrow(/expects a number/);
    expect(() => context.createKey('not a name', true)).toThrow(/Invalid context key name/);
    expect(() => context.createKey('workbench.value', undefined as unknown as string)).toThrow(
      /needs a string, number or boolean default/,
    );

    count.dispose();
    expect(count.disposed).toBe(true);
    expect(() => count.set(1)).toThrow(/disposed/);
    expect(() => count.reset()).toThrow(/disposed/);
    count.dispose();

    expect(context.getValue('workbench.count')).toBeUndefined();
    expect(context.createKey('workbench.count', 0, { owner: 'workbench' }).name).toBe(
      'workbench.count',
    );
  });

  it('falls back from a view scope to the workbench value', () => {
    const workbench = createContextKeyService({ owner: 'workbench' });
    const view = workbench.createScope();
    const workbenchKey = workbench.createKey('device.running', false);
    const viewKey = view.createKey('device.running', false);
    const events = captureEvents(view);

    expect(view.depth).toBe(1);
    expect(view.parent).toBe(workbench);

    workbenchKey.set(true);
    expect(view.getValue('device.running')).toBe(true);
    expect(viewKey.value).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0]!.names).toEqual(['device.running']);
    expect(events[0]!.changes).toEqual([{ name: 'device.running', previous: false, value: true }]);
  });

  it('keeps a local value over parent changes', () => {
    const workbench = createContextKeyService({ owner: 'workbench' });
    const view = workbench.createScope();
    const workbenchKey = workbench.createKey('device.mode', 'idle');
    const viewKey = view.createKey('device.mode', 'idle');
    viewKey.set('local');
    const events = captureEvents(view);

    workbenchKey.set('run');
    expect(view.getValue('device.mode')).toBe('local');
    expect(events).toHaveLength(0);

    viewKey.reset();
    expect(view.getValue('device.mode')).toBe('run');
    expect(events).toHaveLength(1);
    expect(events[0]!.changes).toEqual([{ name: 'device.mode', previous: 'local', value: 'run' }]);
  });

  it('reports the fallback when a parent key is disposed', () => {
    const workbench = createContextKeyService({ owner: 'workbench' });
    const view = workbench.createScope();
    const workbenchKey = workbench.createKey('device.level', 0);
    workbenchKey.set(5);
    const events = captureEvents(view);

    workbenchKey.dispose();
    expect(events).toHaveLength(1);
    expect(events[0]!.changes).toEqual([{ name: 'device.level', previous: 5, value: undefined }]);
    expect(view.getValue('device.level')).toBeUndefined();
  });

  it('batches notifications into one event per scope', () => {
    const context = createContextKeyService({ owner: 'workbench' });
    const first = context.createKey('workbench.first', false, { owner: 'workbench' });
    const second = context.createKey('workbench.second', 0, { owner: 'workbench' });
    const events = captureEvents(context);

    context.batch(() => {
      first.set(true);
      second.set(1);
      first.set(false);
      first.set(true);
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.names).toEqual(['workbench.first', 'workbench.second']);
    expect(events[0]!.changes).toEqual([
      { name: 'workbench.first', previous: false, value: true },
      { name: 'workbench.second', previous: 0, value: 1 },
    ]);
  });

  it('merges parent and local changes into one child event per key', () => {
    const workbench = createContextKeyService({ owner: 'workbench' });
    const view = workbench.createScope();
    const workbenchKey = workbench.createKey('device.mode', 'idle');
    const viewKey = view.createKey('device.mode', 'idle');
    viewKey.set('local');
    const events = captureEvents(view);

    view.batch(() => {
      workbenchKey.set('run');
      viewKey.reset();
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.changes).toEqual([{ name: 'device.mode', previous: 'local', value: 'run' }]);
  });

  it('skips values that end where they started inside a batch', () => {
    const context = createContextKeyService({ owner: 'workbench' });
    const key = context.createKey('workbench.toggle', false, { owner: 'workbench' });
    const events = captureEvents(context);

    context.batch(() => {
      key.set(true);
      key.set(false);
    });

    expect(events).toHaveLength(0);
  });

  it('evaluates conditions while unknown keys stay false', () => {
    const context = createContextKeyService({ owner: 'workbench' });
    const condition = context.compile('workbench.selection.kind == "symbol" || device.late');

    expect(condition.keys).toEqual(['workbench.selection.kind', 'device.late']);
    expect(context.evaluate(condition)).toBe(false);
    expect(context.evaluate('device.late')).toBe(false);
    expect(context.getValue('workbench.selection.kind')).toBeUndefined();

    const kind = context.createKey('workbench.selection.kind', 'none', { owner: 'workbench' });
    kind.set('symbol');
    expect(context.evaluate(condition)).toBe(true);
    expect(context.evaluate(parseCondition('workbench.selection.kind != "none"'))).toBe(true);
  });

  it('filters change names with condition dependency keys', () => {
    const context = createContextKeyService({ owner: 'workbench' });
    const condition = context.compile('workbench.a == true && workbench.b == true');
    const first = context.createKey('workbench.a', false, { owner: 'workbench' });
    const second = context.createKey('workbench.b', false, { owner: 'workbench' });
    const unrelated = context.createKey('workbench.c', false, { owner: 'workbench' });
    const matched: string[][] = [];
    context.onDidChange((event) => {
      const names = event.names.filter((name) => condition.keys.includes(name));
      if (names.length > 0) matched.push(names);
      expect(context.evaluate(condition)).toBe(
        context.getValue('workbench.a') === true && context.getValue('workbench.b') === true,
      );
    });

    first.set(true);
    unrelated.set(true);
    second.set(true);

    expect(matched).toEqual([['workbench.a'], ['workbench.b']]);
  });

  it('reserves built-in prefixes for workbench-owned scopes', () => {
    const workbench = createContextKeyService();
    expect(workbench.owner).toBe('workbench');
    const mode = workbench.createKey('workbench.mode', 'edit', { owner: 'workbench' });
    expect(mode.owner).toBe('workbench');

    const host = workbench.createScope();
    expect(host.owner).toBe('host');
    expect(() => host.createKey('workbench.mode', 'edit')).toThrow(/reserved prefix/);
    expect(() => host.createKey('editor.mode', 'edit', { owner: 'workbench' })).toThrow(
      /reserved prefix/,
    );
    expect(() => host.createScope({ owner: 'workbench' })).toThrow(/workbench-owned scope/);
    expect(BUILT_IN_CONTEXT_PREFIXES).toContain('workbench.');
  });

  it('falls children back to the next ancestor when a scope is disposed', () => {
    const workbench = createContextKeyService({ owner: 'workbench' });
    const container = workbench.createScope();
    const view = container.createScope();
    workbench.createKey('device.running', false).set(true);
    const containerKey = container.createKey('device.running', false);
    containerKey.set(false);
    const events = captureEvents(view);

    expect(view.depth).toBe(2);
    container.dispose();

    expect(events).toHaveLength(1);
    expect(events[0]!.changes).toEqual([{ name: 'device.running', previous: false, value: true }]);
    expect(view.getValue('device.running')).toBe(true);
    expect(() => container.createKey('device.other', false)).toThrow(/disposed/);
    expect(() => containerKey.set(true)).toThrow(/disposed/);
  });

  it('delivers disposal fallbacks that happen inside a batch', () => {
    const workbench = createContextKeyService({ owner: 'workbench' });
    const container = workbench.createScope();
    const view = container.createScope();
    workbench.createKey('device.running', false).set(true);
    container.createKey('device.running', false).set(false);
    const events = captureEvents(view);

    workbench.batch(() => {
      container.dispose();
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.changes).toEqual([{ name: 'device.running', previous: false, value: true }]);
  });

  it('disposes the root service and every key it created', () => {
    const workbench = createContextKeyService({ owner: 'workbench' });
    const view = workbench.createScope();
    const key = workbench.createKey('device.running', false);
    key.set(true);

    workbench.dispose();

    expect(workbench.disposed).toBe(true);
    expect(key.disposed).toBe(true);
    expect(view.getValue('device.running')).toBeUndefined();
    expect(() => workbench.createKey('device.other', false)).toThrow(/disposed/);
    expect(() => workbench.batch(() => undefined)).toThrow(/disposed/);
  });
});
