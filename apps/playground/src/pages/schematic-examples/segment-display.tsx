import { SchematicExampleView } from '@/components/schematic-example-view';
import { SEGMENT_DISPLAY_EXAMPLE } from '@/schematic/examples';

export interface ExamplePageProps {
  readonly dark: boolean;
}

/** teaching-mcu 驱动 7 段数码管。 */
export function SegmentDisplayPage({ dark }: ExamplePageProps) {
  return <SchematicExampleView dark={dark} example={SEGMENT_DISPLAY_EXAMPLE} />;
}
