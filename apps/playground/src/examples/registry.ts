/**
 * One demo sheet per page, referenced from both sides.
 *
 * The canvas documents name a `.sch` asset in `document.schematic`; the schematic page opens the
 * same file. Keeping the paths in one registry is what makes the two pages agree: a canvas example
 * can only be mounted on a sheet that the schematic page really offers.
 *
 * Every example is one sidebar route (`#/schematic/<id>`, `#/canvas/<id>`) and is labelled by
 * capability, never by position.
 */

export type SchematicExampleId = 'board-properties' | 'mcu-leds' | 'button-relay';
export type CanvasExampleId = 'button-lamp' | 'dual-lamp';

/** Symbol source of one schematic sheet. */
export type SchematicExampleLibrary = 'sample' | 'demo';

export interface SchematicExample {
  readonly id: SchematicExampleId;
  /** Visible sidebar label of the example; names the capability, not a position. */
  readonly title: string;
  /** Page-relative path of the `.sch` asset. */
  readonly document: string;
  /**
   * `sample` resolves the hand-written editor devices (STM32 / 8051 / LCD / NE555);
   * `demo` resolves the Playground device contract library that the canvas device host also loads.
   */
  readonly library: SchematicExampleLibrary;
}

export interface CanvasExample {
  readonly id: CanvasExampleId;
  /** Visible sidebar label of the example; names the capability, not a position. */
  readonly title: string;
  /** Page-relative path of the `.cnv` asset. */
  readonly document: string;
  /** Schematic example the document is mounted on; must exist in {@link SCHEMATIC_EXAMPLES}. */
  readonly schematic: SchematicExampleId;
}

export const SCHEMATIC_EXAMPLES: readonly SchematicExample[] = Object.freeze([
  Object.freeze({
    id: 'board-properties',
    title: '板级器件与属性',
    document: 'schematics/board-properties.sch',
    library: 'sample',
  }),
  Object.freeze({
    id: 'mcu-leds',
    title: '教学 MCU 与指示灯',
    document: 'schematics/device-bench.sch',
    library: 'demo',
  }),
  Object.freeze({
    id: 'button-relay',
    title: '按键、继电器与指示灯',
    document: 'schematics/button-relay.sch',
    library: 'demo',
  }),
]);

export const CANVAS_EXAMPLES: readonly CanvasExample[] = Object.freeze([
  Object.freeze({
    id: 'button-lamp',
    title: '按键与指示灯',
    document: 'canvases/button-lamp.cnv',
    schematic: 'button-relay',
  }),
  Object.freeze({
    id: 'dual-lamp',
    title: '双通道指示灯',
    document: 'canvases/dual-lamp.cnv',
    schematic: 'mcu-leds',
  }),
]);

export function schematicExampleById(id: SchematicExampleId): SchematicExample {
  const example = SCHEMATIC_EXAMPLES.find((entry) => entry.id === id);
  if (example === undefined) {
    throw new Error(`Unknown schematic example ${JSON.stringify(id)}`);
  }
  return example;
}

export function canvasExampleById(id: CanvasExampleId): CanvasExample {
  const example = CANVAS_EXAMPLES.find((entry) => entry.id === id);
  if (example === undefined) {
    throw new Error(`Unknown canvas example ${JSON.stringify(id)}`);
  }
  return example;
}

/** Canvas examples mounted on one schematic sheet; the schematic page links to them. */
export function canvasExamplesFor(schematic: SchematicExampleId): readonly CanvasExample[] {
  return CANVAS_EXAMPLES.filter((example) => example.schematic === schematic);
}

/** Hash route that opens one schematic example: `schematic/<id>`. */
export function schematicRoute(id: SchematicExampleId): string {
  return `schematic/${id}`;
}

/** Hash route that opens one canvas example: `canvas/<id>`. */
export function canvasRoute(id: CanvasExampleId): string {
  return `canvas/${id}`;
}
