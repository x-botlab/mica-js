import { CircuitBoard, Home, PanelsTopLeft, ShieldCheck, type LucideIcon } from 'lucide-react';

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

export const NAV_ENTRIES: readonly NavEntry[] = Object.freeze([
  {
    kind: 'item',
    path: '/',
    title: '首页',
    subtitle: '示例入口',
    icon: Home,
  },
  {
    kind: 'group',
    id: 'schematic-examples',
    title: '原理图示例',
    subtitle: '选择一个原理图示例',
    icon: CircuitBoard,
    children: [
      {
        path: '/schematic-examples/led-blink',
        title: 'LED 闪烁',
        subtitle: 'teaching-mcu + LED',
      },
      {
        path: '/schematic-examples/segment-display',
        title: '数码管显示',
        subtitle: 'teaching-mcu + 7 段数码管',
      },
      {
        path: '/schematic-examples/basic-io',
        title: '基础 I/O',
        subtitle: '按钮输入 + LED 输出',
      },
    ],
  },
  {
    kind: 'group',
    id: 'canvas-examples',
    title: '画布示例',
    subtitle: '选择一个画布示例',
    icon: PanelsTopLeft,
    children: [
      {
        path: '/canvas-examples/basic-widgets',
        title: '基础 Widget',
        subtitle: '按钮、开关与 LED',
      },
      {
        path: '/canvas-examples/simple-canvas',
        title: '简单画布',
        subtitle: '拖动、缩放与面板添加',
      },
    ],
  },
  {
    kind: 'item',
    path: '/sandbox',
    title: '沙箱',
    subtitle: 'iframe + Worker 隔离',
    icon: ShieldCheck,
  },
]);

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
  return NAV_ENTRIES[0] as NavItem;
}
