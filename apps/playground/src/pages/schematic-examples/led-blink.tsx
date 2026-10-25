import { SchematicExampleView } from '@/components/schematic-example-view';
import { LED_BLINK_EXAMPLE } from '@/schematic/examples';

export interface ExamplePageProps {
  readonly dark: boolean;
}

/** GPIO 翻转 LED 的最小原理图。 */
export function LedBlinkPage({ dark }: ExamplePageProps) {
  return <SchematicExampleView dark={dark} example={LED_BLINK_EXAMPLE} />;
}
