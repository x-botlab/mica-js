import { Redirect, useParams } from 'wouter';
import { CanvasExampleView } from '@/components/canvas-example-view';
import { SchematicExampleView } from '@/components/schematic-example-view';
import { DEFAULT_EXAMPLE_ID, exampleById, examplePath } from '@/examples';

export interface ExamplePageProps {
  readonly dark: boolean;
}

/**
 * The only example page: the registry carries the document, so adding a page
 * means adding one folder under `src/examples/` and no route.
 */
export function ExamplePage({ dark }: ExamplePageProps) {
  const { id } = useParams<{ id: string }>();
  const example = exampleById(id ?? '');

  if (example === undefined) {
    return <Redirect to={examplePath(DEFAULT_EXAMPLE_ID)} />;
  }

  return example.kind === 'schematic' ? (
    <SchematicExampleView dark={dark} example={example} />
  ) : (
    <CanvasExampleView dark={dark} example={example} />
  );
}
