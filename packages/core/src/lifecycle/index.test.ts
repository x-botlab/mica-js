import { describe, expect, it } from 'vitest';
import { DisposableStore, toDisposable } from './index';

describe('DisposableStore', () => {
  it('clears resources and remains reusable', () => {
    const store = new DisposableStore();
    const calls: number[] = [];
    const first = toDisposable(() => {
      calls.push(1);
    });
    expect(store.add(first)).toBe(first);
    store.add(first);
    store.clear();
    store.add(
      toDisposable(() => {
        calls.push(2);
      }),
    );
    store.clear();
    expect(calls).toEqual([1, 2]);
  });

  it('disposes once and immediately releases subsequent additions', () => {
    const store = new DisposableStore();
    let calls = 0;
    store.add(
      toDisposable(() => {
        calls++;
      }),
    );
    store.dispose();
    store.dispose();
    store.add(
      toDisposable(() => {
        calls++;
      }),
    );
    expect(calls).toBe(2);
    expect(() => store.add(store)).toThrow(TypeError);
  });

  it('continues after failures and aggregates errors', () => {
    const store = new DisposableStore();
    const first = new Error('first');
    const second = new Error('second');
    let released = false;
    store.add(
      toDisposable(() => {
        throw first;
      }),
    );
    store.add(
      toDisposable(() => {
        released = true;
      }),
    );
    store.add(
      toDisposable(() => {
        throw second;
      }),
    );
    try {
      store.dispose();
      expect.fail('Expected disposal failure');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([first, second]);
    }
    expect(released).toBe(true);
    expect(() => store.dispose()).not.toThrow();
  });

  it('handles reentrant clearing and idempotent cleanup functions', () => {
    const store = new DisposableStore();
    let calls = 0;
    const disposable = toDisposable(() => {
      calls++;
      store.clear();
    });
    store.add(disposable);
    store.clear();
    disposable.dispose();
    expect(calls).toBe(1);
  });
});
