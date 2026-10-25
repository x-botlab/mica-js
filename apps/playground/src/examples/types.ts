import type { CanvasDocument } from '@mica-js/core/canvas';
import type { SchematicDocument } from '@mica-js/core/schematic';

/**
 * Sidebar grouping. A category with no examples is not rendered, so the
 * capability set can grow one page at a time.
 */
export type ExampleCategory = 'capability' | 'editor';

/** Fields every example carries, regardless of the document format it mounts. */
interface ExampleMeta {
  /** Route id and folder name: `/examples/<id>`. */
  readonly id: string;
  /** Sidebar and card title. */
  readonly title: string;
  /** One line naming what the page measures, used as the header subtitle. */
  readonly capability: string;
  /** Longer description for the home card. */
  readonly summary: string;
  readonly category: ExampleCategory;
  /** Device ids the page mounts, shown as card tags. */
  readonly devices: readonly string[];
}

/** A `.sch` page: the schematic editor mounts `document`. */
export interface SchematicExampleDefinition extends ExampleMeta {
  readonly kind: 'schematic';
  readonly document: SchematicDocument;
}

/** A `.cnv` page: the widget host mounts `document` over `schematic`. */
export interface CanvasExampleDefinition extends ExampleMeta {
  readonly kind: 'canvas';
  readonly document: CanvasDocument;
  /** Endpoints the widget bindings target; loaded into the simulator before mounting. */
  readonly schematic?: SchematicDocument;
  readonly showPalette?: boolean;
}

export type ExampleDefinition = SchematicExampleDefinition | CanvasExampleDefinition;
