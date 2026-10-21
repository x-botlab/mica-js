import { useEffect, useState } from 'react';

export interface Route<TId extends string> {
  readonly id: TId;
  readonly path: string;
}

function readRoute<TId extends string>(routes: readonly Route<TId>[], fallback: TId): TId {
  const hash = globalThis.location.hash.replace(/^#\/?/, '');
  return routes.find((route) => route.id === hash)?.id ?? fallback;
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
