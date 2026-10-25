import { CircuitBoard, Home, ShieldCheck, Zap, type LucideIcon } from 'lucide-react';
import { EXAMPLE_CATEGORIES, examplePath, examplesOf, type ExampleCategory } from '@/examples';

/** One clickable page in the sidebar. */
export interface NavLeaf {
  readonly path: string;
  readonly title: string;
  readonly subtitle: string;
}

/** A collapsible category; every child is a leaf page. */
export interface NavGroup {
  readonly kind: 'group';
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly icon: LucideIcon;
  readonly children: readonly NavLeaf[];
}

/** A top-level page without children. */
export interface NavItem {
  readonly kind: 'item';
  readonly path: string;
  readonly title: string;
  readonly subtitle: string;
  readonly icon: LucideIcon;
}

export type NavEntry = NavItem | NavGroup;

interface CategoryMeta {
  readonly title: string;
  readonly subtitle: string;
  readonly icon: LucideIcon;
}

/** Presentation of each example category; the order comes from `EXAMPLE_CATEGORIES`. */
export const CATEGORY_META: Readonly<Record<ExampleCategory, CategoryMeta>> = Object.freeze({
  capability: { title: '能力测试', subtitle: '逐个能力自检', icon: Zap },
  editor: { title: '编辑器示例', subtitle: '原理图与画布', icon: CircuitBoard },
});

const HOME: NavItem = {
  kind: 'item',
  path: '/',
  title: '首页',
  subtitle: '示例入口',
  icon: Home,
};

const SANDBOX: NavItem = {
  kind: 'item',
  path: '/sandbox',
  title: '沙箱',
  subtitle: 'iframe + Worker 隔离',
  icon: ShieldCheck,
};

/** One group per non-empty category, so a new example appears without touching nav. */
function exampleGroups(): readonly NavGroup[] {
  return EXAMPLE_CATEGORIES.map((category) => {
    const meta = CATEGORY_META[category];
    return {
      kind: 'group' as const,
      id: category,
      title: meta.title,
      subtitle: meta.subtitle,
      icon: meta.icon,
      children: examplesOf(category).map((example) => ({
        path: examplePath(example.id),
        title: example.title,
        subtitle: example.capability,
      })),
    };
  }).filter((group) => group.children.length > 0);
}

export const NAV_ENTRIES: readonly NavEntry[] = Object.freeze([HOME, ...exampleGroups(), SANDBOX]);

/** The category containing `path`, so the sidebar can auto-expand it. */
export function navGroupOf(path: string): NavGroup | undefined {
  return NAV_ENTRIES.find(
    (entry): entry is NavGroup =>
      entry.kind === 'group' && entry.children.some((child) => child.path === path),
  );
}

/** Header text for the current location; unknown paths fall back to the home entry. */
export function activeNav(path: string): NavLeaf {
  for (const entry of NAV_ENTRIES) {
    if (entry.kind === 'item' && entry.path === path) {
      return entry;
    }
    if (entry.kind === 'group') {
      const child = entry.children.find((candidate) => candidate.path === path);
      if (child !== undefined) {
        return child;
      }
    }
  }
  return HOME;
}
