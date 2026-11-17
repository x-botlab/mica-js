import { Emitter, type Event, type IDisposable } from '@mica-js/core/lifecycle';
import { parseCondition, type ICondition } from './condition';
import {
  BUILT_IN_CONTEXT_PREFIXES,
  ContextRegistrationError,
  type ContextKeyOwner,
  type ContextValue,
  type ContextValueType,
  type IContextKey,
  type IContextKeyOptions,
} from './keys';

/** One effective value transition reported by a scope. */
export interface IContextChange {
  readonly name: string;
  readonly previous: ContextValue | undefined;
  readonly value: ContextValue | undefined;
}

/**
 * Delivered once per scope and flush. `changes` carries previous and new effective values;
 * `names` lists the same keys for callers that only filter or invalidate.
 */
export interface IContextChangeEvent {
  readonly scope: IContextScope;
  readonly changes: readonly IContextChange[];
  readonly names: readonly string[];
}

export interface IContextScopeOptions {
  /** Defaults to `workbench` for the root service and `host` for child scopes. */
  readonly owner?: ContextKeyOwner;
  /** Defaults to {@link BUILT_IN_CONTEXT_PREFIXES}. */
  readonly reservedPrefixes?: readonly string[];
}

/** Constructor shape; `parent` stays internal so callers link scopes through `createScope`. */
interface IContextScopeInit extends IContextScopeOptions {
  readonly parent?: ContextScope;
}

/**
 * Workbench-side entry point: the root scope plus key creation. The editor owns one service and
 * hands {@link IContextKeyService.createScope} children to containers and views; those children
 * are host-owned and cannot claim reserved prefixes.
 */
export interface IContextKeyService extends IDisposable {
  readonly owner: ContextKeyOwner;
  readonly disposed: boolean;
  /** Fires with the effective changes of this scope only. */
  readonly onDidChange: Event<IContextChangeEvent>;
  /**
   * Creates and registers a typed key in this scope.
   *
   * @throws {ContextRegistrationError} for malformed names, invalid defaults, duplicate names in
   * this scope, reserved prefixes outside a workbench scope, or a disposed scope.
   */
  createKey<T extends ContextValue>(
    name: string,
    defaultValue: T,
    options?: IContextKeyOptions,
  ): IContextKey<ContextValueType<T>>;
  /** Effective value: local, then nearest ancestor, then the key default; `undefined` if unknown. */
  getValue(name: string): ContextValue | undefined;
  /**
   * Creates a child scope that falls back to this one.
   *
   * @param options.owner Defaults to `host`; `workbench` requires a workbench-owned parent.
   */
  createScope(options?: IContextScopeOptions): IContextScope;
  /** Defers and merges change notifications of this whole tree; fires once per scope on exit. */
  batch(run: () => void): void;
  /** Parses an expression once; see {@link ICondition.keys} for selective subscriptions. */
  compile(expression: string): ICondition;
  /** Parses `expression` when needed and evaluates it against this scope's effective values. */
  evaluate(expression: ICondition | string): boolean;
}

export interface IContextScope extends IContextKeyService {
  readonly parent: IContextScope | undefined;
  /** Distance from the workbench root; the root is `0`. */
  readonly depth: number;
}

/**
 * Creates the editor-owned root. It defaults to `owner: 'workbench'`, so built-in keys register
 * directly; hand containers and views children from `createScope()`, which default to `host` and
 * reject reserved prefixes.
 */
export function createContextKeyService(options: IContextScopeOptions = {}): IContextKeyService {
  return new ContextScope(options);
}

interface IStoredKey {
  readonly name: string;
  readonly defaultValue: ContextValue;
  readonly owner: ContextKeyOwner;
  readonly value: ContextValue | undefined;
  assign(value: ContextValue | undefined): void;
  markDisposed(): void;
}

interface IPendingChange {
  readonly key: IStoredKey;
  readonly previous: ContextValue | undefined;
}

const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

class ContextKey<T extends ContextValue> implements IContextKey<T>, IStoredKey {
  readonly name: string;
  readonly defaultValue: T;
  readonly owner: ContextKeyOwner;
  readonly #scope: ContextScope;
  #value: T | undefined;
  #disposed = false;

  constructor(name: string, defaultValue: T, owner: ContextKeyOwner, scope: ContextScope) {
    this.name = name;
    this.defaultValue = defaultValue;
    this.owner = owner;
    this.#scope = scope;
  }

  get value(): T | undefined {
    return this.#value;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  set(value: T): void {
    this.#assertAlive();
    if (typeof value !== typeof this.defaultValue) {
      throw new ContextRegistrationError(
        `Context key "${this.name}" expects a ${typeof this.defaultValue} value.`,
        'type-mismatch',
        this.name,
      );
    }
    this.#scope.assignValue(this, value);
  }

  reset(): void {
    this.#assertAlive();
    if (this.#value === undefined) return;
    this.#scope.assignValue(this, undefined);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#scope.removeKey(this);
  }

  assign(value: ContextValue | undefined): void {
    this.#value = value as T | undefined;
  }

  markDisposed(): void {
    this.#disposed = true;
  }

  #assertAlive(): void {
    if (this.#disposed) {
      throw new ContextRegistrationError(
        `Context key "${this.name}" is disposed.`,
        'disposed',
        this.name,
      );
    }
  }
}

class ContextBatch {
  readonly #pending = new Map<ContextScope, Map<string, IPendingChange>>();
  readonly #deferred: (() => void)[] = [];
  #depth = 0;
  #flushing = false;

  enter(): void {
    this.#depth += 1;
  }

  exit(): void {
    this.#depth -= 1;
    this.#flushWhenIdle();
  }

  add(scope: ContextScope, key: IStoredKey, previous: ContextValue | undefined): void {
    let entries = this.#pending.get(scope);
    if (entries === undefined) {
      entries = new Map();
      this.#pending.set(scope, entries);
    }
    if (!entries.has(key.name)) entries.set(key.name, { key, previous });
    this.#flushWhenIdle();
  }

  hasPending(scope: ContextScope, name: string): boolean {
    return this.#pending.get(scope)?.has(name) ?? false;
  }

  /** Runs now when idle, or after the next flush so deferred teardown cannot swallow events. */
  defer(run: () => void): void {
    if (this.#depth === 0 && !this.#flushing) {
      run();
      return;
    }
    this.#deferred.push(run);
  }

  /** Fires merged changes ancestors-first so descendants can skip keys they report themselves. */
  #flushWhenIdle(): void {
    if (this.#depth > 0 || this.#flushing) return;
    this.#flushing = true;
    try {
      while (this.#pending.size > 0) {
        const scopes = [...this.#pending.keys()].sort((left, right) => left.depth - right.depth);
        for (const scope of scopes) {
          const entries = this.#pending.get(scope);
          if (entries === undefined) continue;
          this.#pending.delete(scope);
          const changes: IContextChange[] = [];
          for (const entry of entries.values()) {
            const value = scope.getValue(entry.key.name);
            if (value !== entry.previous) {
              changes.push({ name: entry.key.name, previous: entry.previous, value });
            }
          }
          if (changes.length > 0) scope.notifyChanges(changes);
        }
      }
    } finally {
      this.#flushing = false;
      this.#runDeferred();
    }
  }

  #runDeferred(): void {
    while (this.#deferred.length > 0) {
      this.#deferred.shift()!();
    }
    if (this.#pending.size > 0) this.#flushWhenIdle();
  }
}

class ContextScope implements IContextScope {
  readonly #parent: ContextScope | undefined;
  readonly #owner: ContextKeyOwner;
  readonly #reservedPrefixes: readonly string[];
  readonly #registrations = new Map<string, IStoredKey>();
  readonly #changes = new Emitter<IContextChangeEvent>();
  readonly #batch: ContextBatch;
  readonly #parentSubscription: IDisposable | undefined;
  readonly #depth: number;
  #disposed = false;

  /** Fires with this scope's effective changes only, never with an overridden parent change. */
  readonly onDidChange: Event<IContextChangeEvent> = this.#changes.event;

  constructor(options: IContextScopeInit = {}) {
    const parent = options.parent;
    this.#parent = parent;
    this.#owner = options.owner ?? 'workbench';
    this.#reservedPrefixes = options.reservedPrefixes ?? BUILT_IN_CONTEXT_PREFIXES;
    this.#depth = parent === undefined ? 0 : parent.depth + 1;
    this.#batch = parent === undefined ? new ContextBatch() : parent.#batch;
    this.#parentSubscription = parent?.onDidChange((event) => {
      if (this.#disposed) return;
      const changes = event.changes.filter((change) => this.#tracks(change.name));
      if (changes.length > 0) this.notifyChanges(changes);
    });
  }

  get parent(): IContextScope | undefined {
    return this.#parent;
  }

  get owner(): ContextKeyOwner {
    return this.#owner;
  }

  get depth(): number {
    return this.#depth;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  createKey<T extends ContextValue>(
    name: string,
    defaultValue: T,
    options: IContextKeyOptions = {},
  ): IContextKey<ContextValueType<T>> {
    this.#assertMutable();
    if (!KEY_NAME.test(name)) {
      throw new ContextRegistrationError(
        `Invalid context key name "${name}"; expected dotted segments such as "workbench.selection.kind".`,
        'invalid-key',
        name,
      );
    }
    const kind = typeof defaultValue;
    if (kind !== 'string' && kind !== 'number' && kind !== 'boolean') {
      throw new ContextRegistrationError(
        `Context key "${name}" needs a string, number or boolean default.`,
        'invalid-key',
        name,
      );
    }
    if (this.#registrations.has(name)) {
      throw new ContextRegistrationError(
        `Context key "${name}" is already registered in this scope.`,
        'duplicate-key',
        name,
      );
    }
    const owner = options.owner ?? this.#owner;
    const reserved = this.#reservedPrefixes.some((prefix) => name.startsWith(prefix));
    if (reserved && (this.#owner !== 'workbench' || owner !== 'workbench')) {
      throw new ContextRegistrationError(
        `Context key "${name}" uses a reserved prefix; only a workbench-owned key in a workbench scope may register it.`,
        'reserved-prefix',
        name,
      );
    }
    const key = new ContextKey(name, defaultValue as unknown as ContextValueType<T>, owner, this);
    this.#registrations.set(name, key);
    return key;
  }

  getValue(name: string): ContextValue | undefined {
    return this.#resolve(name);
  }

  createScope(options: IContextScopeOptions = {}): IContextScope {
    this.#assertMutable();
    const owner = options.owner ?? 'host';
    if (owner === 'workbench' && this.#owner !== 'workbench') {
      throw new ContextRegistrationError(
        'Only a workbench-owned scope can create a workbench scope.',
        'owner-escalation',
        undefined,
      );
    }
    return new ContextScope({
      parent: this,
      owner,
      ...(options.reservedPrefixes === undefined
        ? {}
        : { reservedPrefixes: options.reservedPrefixes }),
    });
  }

  batch(run: () => void): void {
    this.#assertMutable();
    this.#batch.enter();
    try {
      run();
    } finally {
      this.#batch.exit();
    }
  }

  compile(expression: string): ICondition {
    return parseCondition(expression);
  }

  evaluate(expression: ICondition | string): boolean {
    const condition = typeof expression === 'string' ? parseCondition(expression) : expression;
    return condition.evaluate((name) => this.#resolve(name));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#batch.enter();
    try {
      for (const key of [...this.#registrations.values()]) {
        const previous = this.effectiveValue(key);
        this.#registrations.delete(key.name);
        key.markDisposed();
        this.#batch.add(this, key, previous);
      }
    } finally {
      this.#batch.exit();
    }
    this.#disposed = true;
    this.#batch.defer(() => {
      this.#parentSubscription?.dispose();
      this.#changes.dispose();
    });
  }

  /** @internal Stored by the batch flush and by key assignment. */
  assignValue(key: IStoredKey, value: ContextValue | undefined): void {
    this.#assertMutable();
    if (this.#registrations.get(key.name) !== key) return;
    const previous = this.effectiveValue(key);
    key.assign(value);
    this.#batch.add(this, key, previous);
  }

  /** @internal Called by `dispose` of a key; the scope reports the fallback value. */
  removeKey(key: IStoredKey): void {
    if (this.#disposed) return;
    if (this.#registrations.get(key.name) !== key) return;
    const previous = this.effectiveValue(key);
    this.#registrations.delete(key.name);
    this.#batch.add(this, key, previous);
  }

  /** @internal Effective value including the key default when no scope registered it. */
  effectiveValue(key: IStoredKey): ContextValue {
    return this.#resolve(key.name) ?? key.defaultValue;
  }

  /** @internal Fires one merged event for this scope; children propagate from it. */
  notifyChanges(changes: readonly IContextChange[]): void {
    this.#changes.fire({
      scope: this,
      changes,
      names: changes.map((change) => change.name),
    });
  }

  /** A child tracks a parent change while it owns no local value and has no pending change. */
  #tracks(name: string): boolean {
    return (
      this.#registrations.get(name)?.value === undefined && !this.#batch.hasPending(this, name)
    );
  }

  /**
   * Nearest local value, else the default of the nearest scope that registered the name, else
   * `undefined` for names no scope knows.
   */
  #resolve(name: string): ContextValue | undefined {
    const value = this.#valueInChain(name);
    if (value !== undefined) return value;
    const key = this.#registrations.get(name);
    if (key !== undefined) return key.defaultValue;
    return this.#parent === undefined ? undefined : this.#parent.#resolve(name);
  }

  #valueInChain(name: string): ContextValue | undefined {
    const value = this.#registrations.get(name)?.value;
    if (value !== undefined) return value;
    return this.#parent === undefined ? undefined : this.#parent.#valueInChain(name);
  }

  #assertMutable(): void {
    if (this.#disposed) throw new Error('Context scope is disposed.');
  }
}
