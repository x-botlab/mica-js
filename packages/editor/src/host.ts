import type { PropertyDescriptor } from '@mica-js/document/schematic';

export interface IEditorPoint {
  readonly x: number;
  readonly y: number;
}

/** Coordinates are CSS pixels for clientPosition and document units for position. */
export interface IEditorPointerEvent<T> {
  readonly target: T | null;
  readonly position: IEditorPoint;
  readonly clientPosition: IEditorPoint;
  readonly button: number;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly mode: 'edit' | 'simulation';
}

export interface IEditorErrorEvent {
  readonly source: 'load' | 'render' | 'runtime' | 'command';
  readonly error: unknown;
}

export interface IEditorIntegrationState {
  readonly readOnly: boolean;
  readonly mode: 'edit' | 'simulation';
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly tool?: string;
  readonly running?: boolean;
}

/**
 * Detached property-panel data; value includes the definition default when inherited.
 *
 * The shared fields describe what every panel needs; the remaining optional metadata is the
 * declaration's original descriptor (`group`, `order`, `editor`, `unit`, `maxLength`, `nullable`,
 * `alpha`, byte/pixel limits, …), which hosts forward untouched to pick the right control.
 */
export interface IEditorProperty extends Omit<
  PropertyDescriptor,
  'key' | 'type' | 'description' | 'default' | 'options' | 'min' | 'max' | 'step'
> {
  readonly key: string;
  readonly label: string;
  readonly type: string;
  readonly description?: string;
  readonly value: unknown;
  readonly defaultValue: unknown;
  readonly overrideValue: unknown;
  readonly overridden: boolean;
  readonly readOnly: boolean;
  readonly options?: readonly { readonly value: unknown; readonly label: string }[];
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

export interface IEditorCommand<P = void, R = void> {
  readonly params: P;
  readonly result: R;
}

export type EditorCommandArgs<C extends { readonly params: unknown }> = [C['params']] extends [void]
  ? []
  : [params: C['params']];
