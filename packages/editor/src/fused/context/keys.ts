import type { IDisposable } from '@mica-js/core/lifecycle';

/** Scalar value a context key carries; a key that nobody registered reads as `undefined`. */
export type ContextValue = string | number | boolean;

/**
 * Who owns a key. `workbench` is the editor itself and is the only owner allowed to claim the
 * namespaces in {@link BUILT_IN_CONTEXT_PREFIXES}; `host` covers every contributed view,
 * container and device package.
 */
export type ContextKeyOwner = 'workbench' | 'host';

/**
 * Namespaces reserved for editor-owned state. A host-owned scope can never register these names,
 * so a contributed view cannot shadow workbench state such as the active selection or the editor
 * mode; the editor registers them from a workbench-owned scope.
 */
export const BUILT_IN_CONTEXT_PREFIXES: readonly string[] = ['workbench.', 'editor.'];

/** Why a context key or scope operation was rejected. */
export type ContextRegistrationErrorReason =
  | 'duplicate-key'
  | 'invalid-key'
  | 'reserved-prefix'
  | 'owner-escalation'
  | 'type-mismatch'
  | 'disposed';

/** Raised when a key, a value or a scope operation violates the context registry contract. */
export class ContextRegistrationError extends Error {
  constructor(
    message: string,
    readonly reason: ContextRegistrationErrorReason,
    readonly keyName: string | undefined,
  ) {
    super(message);
    this.name = 'ContextRegistrationError';
  }
}

/**
 * Widens a literal default to its primitive, so `createKey('workbench.mode', 'edit')` yields
 * `IContextKey<string>` and `set('simulate')` type-checks.
 */
export type ContextValueType<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : ContextValue;

/** Extra ownership metadata for one key; the default is the owning scope's owner. */
export interface IContextKeyOptions {
  /**
   * Declares who owns the key. A reserved prefix still requires the creating scope to be
   * workbench-owned, so this option never unlocks built-in names from a host scope.
   */
  readonly owner?: ContextKeyOwner;
}

/**
 * A typed key created inside a scope. `set` stores a local value, `reset` drops it so the key
 * falls back to its parent and then to {@link IContextKey.defaultValue}, and `dispose` removes
 * the key from its scope for good.
 */
export interface IContextKey<T extends ContextValue = ContextValue> extends IDisposable {
  /** Dotted name expressions reference, for example `workbench.selection.kind`. */
  readonly name: string;
  readonly defaultValue: T;
  readonly owner: ContextKeyOwner;
  /** Value stored in the owning scope; `undefined` while the key falls back to its parent. */
  readonly value: T | undefined;
  readonly disposed: boolean;
  set(value: T): void;
  reset(): void;
}
