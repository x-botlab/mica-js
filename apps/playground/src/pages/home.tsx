import { ArrowRight, CircuitBoard, PanelsTopLeft, ShieldCheck } from 'lucide-react';
import { navigate } from 'wouter/use-hash-location';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface ExampleCard {
  readonly path: string;
  readonly title: string;
  readonly summary: string;
  readonly tags: readonly string[];
}

const SCHEMATIC_EXAMPLES: readonly ExampleCard[] = [
  {
    path: '/schematic-examples/led-blink',
    title: 'LED 闪烁',
    summary: 'teaching-mcu 的 GPIO 驱动 LED。',
    tags: ['teaching-mcu', 'board:led'],
  },
  {
    path: '/schematic-examples/segment-display',
    title: '数码管显示',
    summary: '7 段数码管的段选与共地接线。',
    tags: ['7 段数码管'],
  },
  {
    path: '/schematic-examples/basic-io',
    title: '基础 I/O',
    summary: '按钮输入 + LED 输出。',
    tags: ['ideal-button', 'LED'],
  },
];

const CANVAS_EXAMPLES: readonly ExampleCard[] = [
  {
    path: '/canvas-examples/basic-widgets',
    title: '基础 Widget',
    summary: '按钮、开关与 LED 通过布尔端口互通。',
    tags: ['demo:button', 'lab:led'],
  },
  {
    path: '/canvas-examples/simple-canvas',
    title: '简单画布',
    summary: '拖动、缩放、从组件面板添加实例。',
    tags: ['lab:animation'],
  },
];

function ExampleGrid({ entries }: { readonly entries: readonly ExampleCard[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {entries.map((entry) => (
        <Card key={entry.path} className="gap-2 py-4">
          <CardHeader>
            <CardTitle>{entry.title}</CardTitle>
            <CardDescription>{entry.summary}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-1">
              {entry.tags.map((tag) => (
                <Badge key={tag} variant="outline" className="font-mono text-[10px]">
                  {tag}
                </Badge>
              ))}
            </div>
            <Button size="xs" variant="secondary" onClick={() => navigate(entry.path)}>
              打开
              <ArrowRight />
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function SectionHeader({
  icon: Icon,
  title,
}: {
  readonly icon: typeof CircuitBoard;
  readonly title: string;
}) {
  return (
    <h3 className="flex items-center gap-2 text-xs font-semibold">
      <Icon className="size-3.5" />
      {title}
    </h3>
  );
}

export function HomePage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-5 p-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">Mica Playground</h2>
          <p className="text-muted-foreground text-xs">每个示例只使用包的公开 API。</p>
        </div>

        <section className="flex flex-col gap-2">
          <SectionHeader icon={CircuitBoard} title="原理图示例" />
          <ExampleGrid entries={SCHEMATIC_EXAMPLES} />
        </section>

        <section className="flex flex-col gap-2">
          <SectionHeader icon={PanelsTopLeft} title="画布示例" />
          <ExampleGrid entries={CANVAS_EXAMPLES} />
        </section>

        <section className="flex flex-col gap-2">
          <SectionHeader icon={ShieldCheck} title="沙箱" />
          <Card className="gap-2 py-4">
            <CardHeader>
              <CardTitle>不可信代码</CardTitle>
              <CardDescription>iframe + Worker 里自动启动，无 DOM、存储与网络。</CardDescription>
            </CardHeader>
            <CardContent>
              <Button size="xs" variant="secondary" onClick={() => navigate('/sandbox')}>
                打开
                <ArrowRight />
              </Button>
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
}
