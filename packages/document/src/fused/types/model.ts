/**
 * Public model interface declared by a unified device manifest (RFC 0021).
 *
 * The value domain is the MessagePack subset of RFC 0021: `null`, boolean, finite binary64
 * numbers, strings, bytes, arrays and plain string-keyed objects without cycles.
 */

/** A value exchanged with a device model (RFC 0021). */
export type Value =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | readonly Value[]
  | { readonly [key: string]: Value };

/** Payload type of a model parameter, result or event (RFC 0021). */
export type ValueType =
  | { readonly type: 'null' | 'boolean' | 'number' | 'string' | 'binary' }
  | { readonly type: 'array'; readonly items: ValueType }
  | {
      readonly type: 'object';
      readonly properties: Readonly<Record<string, ValueType>>;
      readonly optional?: readonly string[];
      readonly additionalProperties?: ValueType;
    }
  | { readonly ref: string };

/** One declared model method (RFC 0021). */
export interface MethodDefinition {
  readonly params: ValueType;
  readonly returns: ValueType;
}

/**
 * The `model` object of a unified device manifest (RFC 0020 / RFC 0021).
 *
 * `types` declares the public payload type names that `ref` addresses, `methods` and `events`
 * declare the instance interface the model entry must implement.
 */
export interface ModelDefinition {
  /** Package-root relative `.js` path of the model entry. */
  readonly entry: string;
  readonly types?: Readonly<Record<string, ValueType>>;
  readonly methods?: Readonly<Record<string, MethodDefinition>>;
  readonly events?: Readonly<Record<string, ValueType>>;
}
