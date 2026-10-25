import { SIMPLE_CANVAS_EXAMPLE } from '@/canvas/examples';
import { CanvasExampleView } from '@/components/canvas-example-view';

export interface CanvasExamplePageProps {
  readonly dark: boolean;
}

/** 自由拖拽、缩放与面板添加实例。 */
export function SimpleCanvasPage({ dark }: CanvasExamplePageProps) {
  return <CanvasExampleView dark={dark} example={SIMPLE_CANVAS_EXAMPLE} />;
}
