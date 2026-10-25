import { DAC_VOLTMETER_EXAMPLE } from './capability/dac-voltmeter';
import { BASIC_WIDGETS_EXAMPLE } from './editor/basic-widgets';
import { LED_BLINK_EXAMPLE } from './editor/led-blink';
import { SIMPLE_CANVAS_EXAMPLE } from './editor/simple-canvas';
import type { ExampleCategory, ExampleDefinition } from './types';

export type {
  CanvasExampleDefinition,
  ExampleCategory,
  ExampleDefinition,
  SchematicExampleDefinition,
} from './types';

/** Sidebar order; categories with no examples stay hidden. */
export const EXAMPLE_CATEGORIES: readonly ExampleCategory[] = Object.freeze([
  'capability',
  'editor',
]);

/** Every page the playground can mount, in sidebar order. */
export const EXAMPLES: readonly ExampleDefinition[] = Object.freeze([
  DAC_VOLTMETER_EXAMPLE,
  LED_BLINK_EXAMPLE,
  BASIC_WIDGETS_EXAMPLE,
  SIMPLE_CANVAS_EXAMPLE,
]);

export const DEFAULT_EXAMPLE_ID = 'led-blink';

/** Route of one example; the only dynamic path the router needs. */
export function examplePath(id: string): string {
  return `/examples/${id}`;
}

export function exampleById(id: string): ExampleDefinition | undefined {
  return EXAMPLES.find((example) => example.id === id);
}

export function examplesOf(category: ExampleCategory): readonly ExampleDefinition[] {
  return EXAMPLES.filter((example) => example.category === category);
}
