import { SchematicExampleView } from '@/components/schematic-example-view';
import { BASIC_IO_EXAMPLE } from '@/schematic/examples';

export interface ExamplePageProps {
  readonly dark: boolean;
}

/** 按钮输入、LED 输出的最小 I/O 回路。 */
export function BasicIoPage({ dark }: ExamplePageProps) {
  return <SchematicExampleView dark={dark} example={BASIC_IO_EXAMPLE} />;
}
