import { WidgetLoadError } from '../errors';
import { loadWidgetPackage, type PackageFiles } from '../load-package';
import type { WidgetModule, WidgetProvider } from '../types';

export interface PackageWidgetProviderOptions {
  readonly files: PackageFiles | readonly PackageFiles[];
}

/**
 * Loads every package up front and indexes its widgets under `<packageId>:<widgetId>`.
 * Resolution never touches the file system again, and unknown references return `undefined`.
 *
 * @throws {WidgetLoadError}
 */
export async function createPackageWidgetProvider(
  options: PackageWidgetProviderOptions,
): Promise<WidgetProvider> {
  const filesList: readonly PackageFiles[] = Array.isArray(options.files)
    ? options.files
    : [options.files as PackageFiles];

  const index = new Map<string, WidgetModule>();
  const packageIds = new Set<string>();

  for (const files of filesList) {
    const widgetPackage = await loadWidgetPackage(withPathCache(files));
    if (packageIds.has(widgetPackage.id)) {
      throw new WidgetLoadError(
        'widget/invalid-manifest',
        `Package id ${JSON.stringify(widgetPackage.id)} is provided more than once.`,
        { packageId: widgetPackage.id, path: 'package.json' },
      );
    }
    packageIds.add(widgetPackage.id);
    for (const [widgetId, module] of Object.entries(widgetPackage.modules)) {
      index.set(`${widgetPackage.id}:${widgetId}`, module);
    }
  }

  return {
    resolve(ref) {
      return Promise.resolve(index.get(ref));
    },
  };
}

/** Reads each path at most once for the lifetime of the provider. */
function withPathCache(files: PackageFiles): PackageFiles {
  const cache = new Map<string, Promise<Uint8Array>>();
  return {
    label: files.label,
    read(path) {
      const cached = cache.get(path);
      if (cached !== undefined) {
        return cached;
      }
      const pending = files.read(path);
      cache.set(path, pending);
      return pending;
    },
  };
}
