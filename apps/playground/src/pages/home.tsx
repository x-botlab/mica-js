import { ArrowRight, CircuitBoard, PanelsTopLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  CANVAS_EXAMPLES,
  SCHEMATIC_EXAMPLES,
  canvasRoute,
  schematicRoute,
} from '@/examples/registry';
import { navigate } from '@/lib/router';

const GROUPS = [
  {
    id: schematicRoute(SCHEMATIC_EXAMPLES[0]!.id),
    icon: CircuitBoard,
    title: '原理图',
  },
  {
    id: canvasRoute(CANVAS_EXAMPLES[0]!.id),
    icon: PanelsTopLeft,
    title: '画布',
  },
] as const;

export function HomePage() {
  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto grid max-w-2xl gap-3 sm:grid-cols-2">
        {GROUPS.map((group) => (
          <Card key={group.id} className="gap-2 py-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <group.icon className="size-4" />
                {group.title}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Button size="xs" variant="secondary" onClick={() => navigate(group.id)}>
                打开
                <ArrowRight />
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
