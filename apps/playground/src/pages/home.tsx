import { ArrowRight, CircuitBoard, PanelsTopLeft, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { navigate } from '@/lib/router';

const PAGES = [
  {
    id: 'canvas',
    icon: PanelsTopLeft,
    title: '画布',
    summary: 'CanvasScene 串起 .cnv、WidgetHost 与编辑器：拖动实例、切换运行模式、看发布日志。',
    tags: ['@mica-js/canvas-editor', '@mica-js/widget'],
  },
  {
    id: 'schematic',
    icon: CircuitBoard,
    title: '原理图编辑器',
    summary: '挂载 Canvas 编辑器：器件库、放置、连线、属性面板与宿主回调。',
    tags: ['@mica-js/schematic-editor', '@mica-js/core/schematic'],
  },
  {
    id: 'sandbox',
    icon: ShieldCheck,
    title: '沙箱',
    summary: 'iframe + Worker 里跑不可信代码：调用 guest 方法、看日志与错误。',
    tags: ['@mica-js/sandbox'],
  },
] as const;

export function HomePage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">Mica Playground</h2>
          <p className="text-muted-foreground text-xs">
            各个包的可交互示例：每个页面都只调用公开 API，页面本身就是用法文档。
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {PAGES.map((page) => (
            <Card key={page.id} className="gap-2 py-4">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <page.icon className="size-4" />
                  {page.title}
                </CardTitle>
                <CardDescription>{page.summary}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <div className="flex flex-wrap gap-1">
                  {page.tags.map((tag) => (
                    <Badge key={tag} variant="outline" className="font-mono text-[10px]">
                      {tag}
                    </Badge>
                  ))}
                </div>
                <Button size="xs" variant="secondary" onClick={() => navigate(page.id)}>
                  打开
                  <ArrowRight />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card className="gap-2 py-4">
          <CardHeader>
            <CardTitle>工作区</CardTitle>
            <CardDescription>pnpm workspace，页面直接引用包源码，改完刷新即可</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto font-mono text-[11px] leading-[1.7]">{`pnpm --filter @mica-js/playground dev   # 本页
pnpm -r test                          # 所有包测试
pnpm -r typecheck                     # 所有包类型检查
pnpm run build                        # 所有包构建`}</pre>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
