export type DiagnosticSeverity = 'error' | 'warning';

export type DiagnosticCode =
  | 'json/invalid'
  | 'json/not-object'
  | 'schema/unsupported-version'
  | 'schema/missing-field'
  | 'schema/invalid-type'
  | 'schema/invalid-value'
  | 'schema/unknown-field'
  | 'id/duplicate'
  | 'device/invalid-reference'
  | 'device/unresolved'
  | 'device/invalid-package'
  | 'device/duplicate-package'
  | 'device/reserved-namespace'
  | 'device/duplicate-device'
  | 'device/invalid-description'
  | 'device/unknown-pin'
  | 'device/no-symbol'
  | 'wire/invalid-points'
  | 'wire/not-orthogonal'
  | 'junction/unknown-wire'
  | 'junction/duplicate-wire'
  | 'junction/off-wire'
  | 'symbol/missing-net'
  | 'symbol/unsupported-field'
  | 'symbol/designator-duplicate'
  | 'net/naming-conflict'
  | 'canvas/unknown-symbol'
  | 'edit/unknown-entity'
  | 'edit/invalid-command';

export interface DiagnosticEntity {
  readonly kind: 'symbol' | 'wire' | 'junction';
  readonly id: string;
}

export interface DiagnosticRelated {
  readonly pointer?: string;
}

export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  readonly code: DiagnosticCode;
  /** Human readable English message; the `code` is the stable contract. */
  readonly message: string;
  /** JSON Pointer to the offending member, e.g. `/sheet/symbols/0/id`. */
  readonly pointer?: string;
  readonly entity?: DiagnosticEntity;
  readonly related?: readonly DiagnosticRelated[];
}
