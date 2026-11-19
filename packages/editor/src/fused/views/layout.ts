import type { InstanceViewLayout, UnifiedDeviceManifest } from '@mica-js/document/fused';

export function resolveViewLayout(
  saved: InstanceViewLayout | undefined,
  manifest: UnifiedDeviceManifest,
  availableHeight: number,
): InstanceViewLayout {
  const declared = Object.entries(manifest.view ?? {});
  const height = Math.max(120, Math.floor((availableHeight - 240) / Math.max(1, declared.length)));
  const views = declared.map(
    ([viewId, view]) =>
      saved?.views.find((entry) => entry.viewId === viewId) ?? {
        viewId,
        location: view.defaultLocation ?? 'sidebar',
        height,
        collapsed: false,
      },
  );
  if (saved !== undefined)
    views.sort((a, b) => {
      const index = (id: string) => {
        const found = saved.views.findIndex((entry) => entry.viewId === id);
        return found < 0 ? saved.views.length + declared.findIndex(([name]) => name === id) : found;
      };
      return index(a.viewId) - index(b.viewId);
    });
  return { properties: saved?.properties ?? { height: 200, collapsed: false }, views };
}
