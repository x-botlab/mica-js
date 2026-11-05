/** Detaches public data and freezes JSON objects; binary views remain writable private copies. */
export function editorSnapshot<T>(value: T): T {
  const copy = structuredClone(value);
  const seen = new WeakSet<object>();
  const freeze = (entry: unknown): void => {
    if (entry === null || typeof entry !== 'object' || seen.has(entry)) return;
    seen.add(entry);
    if (ArrayBuffer.isView(entry)) return;
    for (const child of Object.values(entry)) freeze(child);
    Object.freeze(entry);
  };
  freeze(copy);
  return copy;
}
