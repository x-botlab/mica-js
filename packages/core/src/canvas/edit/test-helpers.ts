import { expect } from 'vitest';
import type { Diagnostic } from '../../format/diagnostics';
import { catchError, codesOf } from '../../format/test-helpers';
import { parseCanvas } from '../format/parse';
import { serializeCanvas } from '../format/serialize';
import type { CanvasDocument, CanvasWidgetInstance } from '../format/types';
import { CANVAS_VERSION } from '../format/types';
import type { CanvasCommand } from './commands';
import { applyCanvasCommand } from './commands';

export const ID_A = '3f6c1e28-9b47-4d05-8a71-2c5e0f9b6d13';
export const ID_B = 'a17d5b90-4e2c-4f86-b3d9-7e1c8a2f5046';
export const ID_C = 'c94e07a1-6d38-4b2f-9e50-81a7d3c6b2f4';
export const ID_D = '7b2d94ce-58a1-4f03-b7e6-d9182c5a4f70';
export const SYMBOL_ID = '5b8e2f14-9c03-4d7a-b6e1-2f4c8a9d0e57';

export function makeDocument(): CanvasDocument {
  return {
    version: CANVAS_VERSION,
    schematic: 'boards/board.sch',
    widgets: [
      {
        id: ID_A,
        widget: 'builtin:image',
        x: 0,
        y: 0,
        width: 1024,
        height: 762,
        rotation: 0,
        properties: { image: 'board.webp' },
        bindings: { value: { symbol: SYMBOL_ID, port: 'segments' } },
      },
      {
        id: ID_B,
        widget: 'zerobit:screen',
        x: 10,
        y: 20,
        width: 30,
        height: 40,
        rotation: 90,
      },
      {
        id: ID_C,
        widget: 'builtin:text',
        x: 5,
        y: 5,
        width: 10,
        height: 10,
        rotation: 0,
      },
    ],
  };
}

export function makeInstance(overrides: Partial<CanvasWidgetInstance> = {}): CanvasWidgetInstance {
  return {
    id: ID_D,
    widget: 'builtin:text',
    x: 1,
    y: 2,
    width: 10,
    height: 20,
    rotation: 0,
    ...overrides,
  };
}

export function widgetAt(document: CanvasDocument, index: number): CanvasWidgetInstance {
  const widget = document.widgets[index];
  if (widget === undefined) {
    throw new Error(`Expected a widget at index ${index}.`);
  }
  return widget;
}

/** Applies a command, asserting that the input is untouched and the result parses again. */
export function applyCommand(document: CanvasDocument, command: CanvasCommand): CanvasDocument {
  const snapshot = JSON.stringify(document);
  const result = applyCanvasCommand(document, command);
  expect(JSON.stringify(document)).toBe(snapshot);
  expect(parseCanvas(serializeCanvas(result))).toEqual(result);
  return result;
}

/** Runs a command expected to fail, asserting that the input is untouched. */
export function rejection(document: CanvasDocument, command: CanvasCommand): readonly Diagnostic[] {
  const snapshot = JSON.stringify(document);
  const { diagnostics } = catchError(() => applyCanvasCommand(document, command));
  expect(JSON.stringify(document)).toBe(snapshot);
  return diagnostics;
}

export function rejectionCodes(
  document: CanvasDocument,
  command: CanvasCommand,
): readonly string[] {
  return codesOf(rejection(document, command));
}
