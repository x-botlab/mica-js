import { useEffect, useState } from 'react';

/** Hash as `#/path?query` → `path` plus the decoded query, so pages can read demo flags. */
function readHash(): { readonly path: string; readonly params: URLSearchParams } {
  const hash = globalThis.location.hash.replace(/^#\/?/, '');
  const index = hash.indexOf('?');
  if (index === -1) {
    return { path: hash, params: new URLSearchParams() };
  }
  return { path: hash.slice(0, index), params: new URLSearchParams(hash.slice(index + 1)) };
}

/** Query flags of the current hash, e.g. `#/schematic/board-properties?readonly`. */
export function readHashParams(): URLSearchParams {
  return readHash().params;
}

/** Current hash path, e.g. `#/schematic/button-relay` → `schematic/button-relay`. */
export function useHashPath(): string {
  const [path, setPath] = useState<string>(() => readHash().path);

  useEffect(() => {
    const onHashChange = (): void => setPath(readHash().path);
    globalThis.addEventListener('hashchange', onHashChange);
    return () => globalThis.removeEventListener('hashchange', onHashChange);
  }, []);

  return path;
}

export function navigate(id: string): void {
  globalThis.location.hash = `#/${id}`;
}
