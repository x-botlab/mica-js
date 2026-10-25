import { ChevronRight, Moon, Sun } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import { activeNav, navGroupOf, NAV_ENTRIES, type NavGroup, type NavItem } from '@/lib/navigation';
import { cn } from '@/lib/utils';

export interface AppShellProps {
  readonly dark: boolean;
  readonly onToggleTheme: () => void;
  readonly children: ReactNode;
}

function isGroup(entry: (typeof NAV_ENTRIES)[number]): entry is NavGroup {
  return entry.kind === 'group';
}

function initialExpanded(): ReadonlySet<string> {
  return new Set(NAV_ENTRIES.filter(isGroup).map((group) => group.id));
}

export function AppShell({ dark, onToggleTheme, children }: AppShellProps) {
  const [location, navigate] = useLocation();
  const active = activeNav(location);
  const activeGroup = navGroupOf(location);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(initialExpanded);

  // Navigating into a category always opens it, even after the user collapsed it.
  useEffect(() => {
    if (activeGroup === undefined) {
      return;
    }
    setExpanded((current) =>
      current.has(activeGroup.id) ? current : new Set(current).add(activeGroup.id),
    );
  }, [activeGroup]);

  const toggleGroup = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="flex h-full min-h-0">
      <aside className="bg-card/40 flex w-56 shrink-0 flex-col border-r">
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <span className="bg-primary text-primary-foreground grid size-6 place-items-center rounded-md text-[11px] font-semibold">
            M
          </span>
          <div className="flex flex-col leading-tight">
            <span className="text-xs font-semibold">Mica</span>
            <span className="text-muted-foreground text-[10px]">playground</span>
          </div>
        </div>

        <nav className="flex flex-col gap-0.5 p-2">
          {NAV_ENTRIES.map((entry) => {
            if (entry.kind === 'item') {
              const { path, title, icon: Icon } = entry as NavItem;
              return (
                <button
                  key={path}
                  type="button"
                  onClick={() => navigate(path)}
                  aria-current={location === path ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                    'hover:bg-accent hover:text-accent-foreground',
                    location === path && 'bg-accent text-accent-foreground font-medium',
                  )}
                >
                  <Icon className="size-3.5" />
                  {title}
                </button>
              );
            }

            const open = expanded.has(entry.id);
            const containsActive = activeGroup?.id === entry.id;
            return (
              <div key={entry.id} className="flex flex-col gap-0.5">
                <button
                  type="button"
                  onClick={() => toggleGroup(entry.id)}
                  aria-expanded={open}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                    'hover:bg-accent hover:text-accent-foreground',
                    containsActive && 'text-foreground font-medium',
                  )}
                >
                  <entry.icon className="size-3.5" />
                  <span className="truncate">{entry.title}</span>
                  <ChevronRight
                    className={cn(
                      'text-muted-foreground ml-auto size-3.5 transition-transform',
                      open && 'rotate-90',
                    )}
                  />
                </button>
                {open ? (
                  <div className="ml-[13px] flex flex-col gap-0.5 border-l pl-2">
                    {entry.children.map((child) => (
                      <button
                        key={child.path}
                        type="button"
                        onClick={() => navigate(child.path)}
                        aria-current={location === child.path ? 'page' : undefined}
                        title={child.subtitle}
                        className={cn(
                          'rounded-md px-2 py-1 text-left text-[11px] transition-colors',
                          'hover:bg-accent hover:text-accent-foreground',
                          location === child.path && 'bg-accent text-accent-foreground font-medium',
                        )}
                      >
                        {child.title}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
          <div className="flex min-w-0 flex-col leading-tight">
            <h1 className="truncate text-sm font-semibold">{active.title}</h1>
            <p className="text-muted-foreground truncate text-[11px]">{active.subtitle}</p>
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="ml-auto"
            onClick={onToggleTheme}
            title={dark ? '切换到浅色' : '切换到深色'}
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
