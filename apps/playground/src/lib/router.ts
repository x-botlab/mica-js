import { useEffect, useState } from 'react';

export interface Route<TId extends string> {
  readonly id: TId;
  readonly path: string;
}

/** Hash as `#/path?query` → `path` plus the decoded query, so pages can read demo flags. */
function readHash(): { readonly path: string; readonly params: URLSearchParams } {
  const hash = globalThis.location.hash.replace(/^#\/?/, '');
  const index = hash.indexOf('?');
  if (index === -1) {
    return { path: hash, params: new URLSearchParams() };
  }
  return { path: hash.slice(0, index), params: new URLSearchParams(hash.slice(index + 1)) };
}

/** Query flags of the current hash, e.g. `#/schematic?readonly`. */
export function readHashParams(): URLSearchParams {
  return readHash().params;
}

function readRoute<TId extends string>(routes: readonly Route<TId>[], fallback: TId): TId {
  const { path } = readHash();
  return routes.find((route) => route.id === path)?.id ?? fallback;
}

/** Minimal hash router: `#/schematic` → `schematic`; unknown paths fall back to `fallback`. */
export function useHashRoute<TId extends string>(
  routes: readonly Route<TId>[],
  fallback: TId,
): TId {
  const [route, setRoute] = useState<TId>(() => readRoute(routes, fallback));

  useEffect(() => {
    const onHashChange = (): void => setRoute(readRoute(routes, fallback));
    globalThis.addEventListener('hashchange', onHashChange);
    return () => globalThis.removeEventListener('hashchange', onHashChange);
  }, [routes, fallback]);

  return route;
}

export function navigate(id: string): void {
  globalThis.location.hash = `#/${id}`;
}
