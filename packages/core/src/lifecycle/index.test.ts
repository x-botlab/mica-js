import { describe, expect, it } from 'vitest';
import { DisposableStore, Emitter, toDisposable, type IDisposable } from './index';

describe('Emitter', () => {
  it('delivers to every listener until the subscription is disposed', () => {
    const emitter = new Emitter<number>();
    const seen: number[] = [];
    const subscription = emitter.event((value) => seen.push(value));

    emitter.fire(1);
    expect(emitter.hasListeners).toBe(true);
    subscription.dispose();
    subscription.dispose();
    emitter.fire(2);

    expect(seen).toEqual([1]);
    expect(emitter.hasListeners).toBe(false);
  });

  it('binds thisArgs and collects subscriptions in disposables', () => {
    const emitter = new Emitter<string>();
    const disposables: IDisposable[] = [];
    const receiver = { prefix: 'net:', seen: [] as string[] };

    emitter.event(
      function (this: typeof receiver, value: string) {
        this.seen.push(`${this.prefix}${value}`);
      },
      receiver,
      disposables,
    );
    emitter.fire('VCC');

    expect(receiver.seen).toEqual(['net:VCC']);
    expect(disposables).toHaveLength(1);
    for (const disposable of disposables) {
      disposable.dispose();
    }
    emitter.fire('GND');
    expect(receiver.seen).toEqual(['net:VCC']);
  });

  it('runs a listener added while firing on the next fire only', () => {
    const emitter = new Emitter<number>();
    const seen: string[] = [];
    emitter.event(() => {
      seen.push('first');
      emitter.event(() => seen.push('late'));
    });

    emitter.fire(1);
    expect(seen).toEqual(['first']);
    emitter.fire(2);
    expect(seen).toEqual(['first', 'first', 'late']);
  });

  it('stops delivering once disposed', () => {
    const emitter = new Emitter<number>();
    const seen: number[] = [];
    emitter.event((value) => seen.push(value));
    emitter.dispose();

    emitter.fire(1);
    emitter.event((value) => seen.push(value));
    emitter.fire(2);

    expect(seen).toEqual([]);
    expect(emitter.hasListeners).toBe(false);
  });
});

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
