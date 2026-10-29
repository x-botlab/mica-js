export type WidgetLoadErrorCode =
  | 'widget/package-not-found'
  | 'widget/invalid-manifest'
  | 'widget/invalid-definition'
  | 'widget/no-implementation'
  | 'widget/not-self-contained'
  | 'widget/load-failed'
  /** A descriptor field carries a value outside its closed set (RFC 0017 `delivery`). */
  | 'schema/invalid-value';

export interface WidgetLoadErrorOptions {
  /** Package id, when the package was already identified. */
  readonly packageId?: string;
  /** Package-relative path the failure refers to. */
  readonly path?: string;
  readonly cause?: unknown;
}

/** Thrown when a widget reference resolves to a package that cannot be turned into a module. */
export class WidgetLoadError extends Error {
  readonly code: WidgetLoadErrorCode;
  readonly packageId: string | undefined;
  readonly path: string | undefined;

  constructor(code: WidgetLoadErrorCode, message: string, options: WidgetLoadErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WidgetLoadError';
    this.code = code;
    this.packageId = options.packageId;
    this.path = options.path;
  }
}
