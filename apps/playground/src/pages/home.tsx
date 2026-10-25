import { ArrowRight, ShieldCheck } from 'lucide-react';
import { navigate } from 'wouter/use-hash-location';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EXAMPLE_CATEGORIES, examplePath, examplesOf, type ExampleDefinition } from '@/examples';
import { CATEGORY_META } from '@/lib/navigation';

function ExampleCard({ example }: { readonly example: ExampleDefinition }) {
  return (
    <Card className="gap-2 py-4" data-example-card={example.id}>
      <CardHeader>
        <CardTitle>{example.title}</CardTitle>
        <CardDescription>{example.summary}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-1">
          {example.devices.map((device) => (
            <Badge key={device} variant="outline" className="font-mono text-[10px]">
              {device}
            </Badge>
          ))}
        </div>
        <p className="text-muted-foreground text-[11px]">{example.capability}</p>
        <Button size="xs" variant="secondary" onClick={() => navigate(examplePath(example.id))}>
          打开
          <ArrowRight />
        </Button>
      </CardContent>
    </Card>
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

        {EXAMPLE_CATEGORIES.map((category) => {
          const examples = examplesOf(category);
          if (examples.length === 0) {
            return null;
          }
          const meta = CATEGORY_META[category];
          const Icon = meta.icon;
          return (
            <section key={category} className="flex flex-col gap-2">
              <h3 className="flex items-center gap-2 text-xs font-semibold">
                <Icon className="size-3.5" />
                {meta.title}
              </h3>
              <div className="grid gap-3 sm:grid-cols-3">
                {examples.map((example) => (
                  <ExampleCard key={example.id} example={example} />
                ))}
              </div>
            </section>
          );
        })}

        <section className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 text-xs font-semibold">
            <ShieldCheck className="size-3.5" />
            沙箱
          </h3>
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
