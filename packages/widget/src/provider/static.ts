import type { WidgetModule, WidgetProvider } from '../types';

/** Provider over a fixed module table, used for builtin widgets and tests. */
export function createStaticWidgetProvider(
  modules: Readonly<Record<string, WidgetModule>>,
): WidgetProvider {
  const index = new Map(Object.entries(modules));
  return {
    resolve(ref) {
      return Promise.resolve(index.get(ref));
    },
  };
}
