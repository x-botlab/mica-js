import { Activity, CircuitBoard, Home, Moon, PanelsTopLeft, ShieldCheck, Sun } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type PageId = 'home' | 'canvas' | 'schematic' | 'sandbox' | 'simulator';

export interface PageDefinition {
  readonly id: PageId;
  readonly title: string;
  readonly subtitle: string;
  readonly icon: ComponentType<{ className?: string }>;
}

export const PAGES: readonly PageDefinition[] = [
  { id: 'home', title: '概览', subtitle: '包的示例与入口', icon: Home },
  {
    id: 'canvas',
    title: '画布',
    subtitle: 'CanvasScene：.cnv 文档 + widget 运行时',
    icon: PanelsTopLeft,
  },
  {
    id: 'schematic',
    title: '原理图编辑器',
    subtitle: '宿主驱动的 Canvas 编辑器',
    icon: CircuitBoard,
  },
  { id: 'sandbox', title: '沙箱', subtitle: 'iframe + Worker 隔离执行', icon: ShieldCheck },
  {
    id: 'simulator',
    title: '仿真',
    subtitle: 'DeviceSimExecutor：单虚拟时钟、事件轨迹与诊断',
    icon: Activity,
  },
];

export interface AppShellProps {
  readonly page: PageDefinition;
  readonly dark: boolean;
  readonly onNavigate: (id: PageId) => void;
  readonly onToggleTheme: () => void;
  readonly children: ReactNode;
}

export function AppShell({ page, dark, onNavigate, onToggleTheme, children }: AppShellProps) {
  return (
    <div className="flex h-full min-h-0">
      <aside className="bg-card/40 flex w-52 shrink-0 flex-col border-r">
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <span className="bg-primary text-primary-foreground grid size-6 place-items-center rounded-md text-[11px] font-semibold">
            M
          </span>
          <div className="flex flex-col leading-tight">
            <span className="text-xs font-semibold">Mica</span>
            <span className="text-muted-foreground text-[10px]">playground</span>
          </div>
        </div>
        <nav className="flex flex-col gap-1 p-2">
          {PAGES.map(({ id, title, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => onNavigate(id)}
              aria-current={page.id === id ? 'page' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                'hover:bg-accent hover:text-accent-foreground',
                page.id === id && 'bg-accent text-accent-foreground font-medium',
              )}
            >
              <Icon className="size-3.5" />
              {title}
            </button>
          ))}
        </nav>
        <div className="text-muted-foreground mt-auto flex flex-col gap-1 border-t p-3 text-[10px]">
          <span className="font-mono">#/{page.id}</span>
          <span>哈希路由 · 单入口</span>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
          <div className="flex min-w-0 flex-col leading-tight">
            <h1 className="truncate text-sm font-semibold">{page.title}</h1>
            <p className="text-muted-foreground truncate text-[11px]">{page.subtitle}</p>
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
