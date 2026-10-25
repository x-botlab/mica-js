import { BASIC_WIDGETS_EXAMPLE } from '@/canvas/examples';
import { CanvasExampleView } from '@/components/canvas-example-view';

export interface CanvasExamplePageProps {
  readonly dark: boolean;
}

/** 按钮 / 开关 / LED 通过布尔指示器互通。 */
export function BasicWidgetsPage({ dark }: CanvasExamplePageProps) {
  return <CanvasExampleView dark={dark} example={BASIC_WIDGETS_EXAMPLE} />;
}
