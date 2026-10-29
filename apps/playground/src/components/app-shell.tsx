import { CircuitBoard, Home, Moon, PanelsTopLeft, Sun } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  CANVAS_EXAMPLES,
  SCHEMATIC_EXAMPLES,
  canvasRoute,
  schematicRoute,
  type CanvasExampleId,
  type SchematicExampleId,
} from '@/examples/registry';
import { cn } from '@/lib/utils';

export type PageId = 'home' | 'schematic' | 'canvas';

interface NavigationEntryBase {
  /** Hash route of the entry, e.g. `schematic/button-relay`. */
  readonly id: string;
  /** Visible label: the example title, never a position. */
  readonly title: string;
}

/** One example, opened by its own route under a page group. */
export type NavigationEntry =
  | (NavigationEntryBase & { readonly page: 'schematic'; readonly exampleId: SchematicExampleId })
  | (NavigationEntryBase & { readonly page: 'canvas'; readonly exampleId: CanvasExampleId });

export interface PageGroup {
  readonly id: PageId;
  readonly title: string;
  readonly icon: ComponentType<{ className?: string }>;
  /** Examples listed as submenu entries; a page without examples is a single link. */
  readonly entries: readonly NavigationEntry[];
}

export const PAGE_GROUPS: readonly PageGroup[] = Object.freeze([
  Object.freeze({
    id: 'home',
    title: '概览',
    icon: Home as PageGroup['icon'],
    entries: Object.freeze([]),
  }),
  Object.freeze({
    id: 'schematic',
    title: '原理图',
    icon: CircuitBoard as PageGroup['icon'],
    entries: Object.freeze(
      SCHEMATIC_EXAMPLES.map((example): NavigationEntry =>
        Object.freeze({
          id: schematicRoute(example.id),
          page: 'schematic',
          exampleId: example.id,
          title: example.title,
        }),
      ),
    ),
  }),
  Object.freeze({
    id: 'canvas',
    title: '画布',
    icon: PanelsTopLeft as PageGroup['icon'],
    entries: Object.freeze(
      CANVAS_EXAMPLES.map((example): NavigationEntry =>
        Object.freeze({
          id: canvasRoute(example.id),
          page: 'canvas',
          exampleId: example.id,
          title: example.title,
        }),
      ),
    ),
  }),
]);

export interface NavigationTarget {
  readonly group: PageGroup;
  /** Example entry of `#/schematic/<id>` / `#/canvas/<id>`; absent on the overview. */
  readonly entry: NavigationEntry | undefined;
}

/**
 * Resolves one hash path to a page group and, when the path names an example, its entry.
 *
 * `schematic` / `canvas` without an example open the first entry, so group links keep working;
 * unknown paths fall back to the overview.
 */
export function resolveNavigation(path: string): NavigationTarget {
  for (const group of PAGE_GROUPS) {
    if (group.id === path) {
      return { group, entry: group.entries[0] };
    }
    const entry = group.entries.find((candidate) => candidate.id === path);
    if (entry !== undefined) {
      return { group, entry };
    }
  }
  const home = PAGE_GROUPS[0]!;
  return { group: home, entry: undefined };
}

export interface AppShellProps {
  readonly page: PageGroup;
  readonly entry: NavigationEntry | undefined;
  readonly dark: boolean;
  readonly onNavigate: (id: string) => void;
  readonly onToggleTheme: () => void;
  readonly children: ReactNode;
}

export function AppShell({
  page,
  entry,
  dark,
  onNavigate,
  onToggleTheme,
  children,
}: AppShellProps) {
  return (
    <div className="flex h-full min-h-0">
      <aside className="bg-card/40 flex w-52 shrink-0 flex-col border-r">
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <span className="bg-primary text-primary-foreground grid size-6 place-items-center rounded-md text-[11px] font-semibold">
            M
          </span>
          <span className="text-xs font-semibold">Mica</span>
        </div>
        <nav className="flex flex-col gap-1 overflow-y-auto p-2">
          {PAGE_GROUPS.map(({ id, title, icon: Icon, entries }) => (
            <div key={id} className="flex flex-col gap-0.5">
              <button
                type="button"
                onClick={() => onNavigate(entries[0]?.id ?? id)}
                aria-current={page.id === id && entry === undefined ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                  'hover:bg-accent hover:text-accent-foreground',
                  page.id === id && 'text-foreground font-medium',
                  page.id === id && entry === undefined && 'bg-accent text-accent-foreground',
                )}
              >
                <Icon className="size-3.5" />
                {title}
              </button>
              {entries.length === 0 ? null : (
                <div
                  role="group"
                  aria-label={title}
                  className="ml-3.5 flex flex-col gap-0.5 border-l pl-2"
                >
                  {entries.map((candidate) => (
                    <button
                      key={candidate.id}
                      type="button"
                      onClick={() => onNavigate(candidate.id)}
                      aria-current={entry?.id === candidate.id ? 'page' : undefined}
                      className={cn(
                        'rounded-md px-2 py-1 text-left text-[11px] transition-colors',
                        'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                        entry?.id === candidate.id &&
                          'bg-accent text-accent-foreground font-medium',
                      )}
                    >
                      {candidate.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
          <h1 className="truncate text-sm font-semibold">{entry?.title ?? page.title}</h1>
          <Button
            size="icon"
            variant="ghost"
            className="ml-auto"
            onClick={onToggleTheme}
            aria-label={dark ? '切换到浅色' : '切换到深色'}
          >
            {dark ? <Sun /> : <Moon />}
          </Button>
        </header>
        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
      </div>
    </div>
  );
}
