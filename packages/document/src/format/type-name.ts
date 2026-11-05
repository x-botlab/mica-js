/** Payload type names of the Mica value model (see #10). */
export const PAYLOAD_TYPES = [
  'boolean',
  'number',
  'string',
  'vec2d',
  'vec3d',
  'bytes',
  'bytes<rgb565>',
  'bytes<segments>',
] as const;

export type PayloadType = (typeof PAYLOAD_TYPES)[number];

/** Resolves a written payload type name, or `undefined` when it names no known type. */
export function parsePayloadType(value: string): PayloadType | undefined {
  return (PAYLOAD_TYPES as readonly string[]).includes(value) ? (value as PayloadType) : undefined;
}

/** Payload types are nominal for now: only an exact match is assignable. */
export function isAssignable(from: PayloadType, to: PayloadType): boolean {
  return from === to;
}
