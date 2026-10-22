const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Strict UUID v4 check: 8-4-4-4-12 hex with the version and variant bits fixed. */
export function isUuidV4(value: string): boolean {
  return UUID_V4.test(value);
}
