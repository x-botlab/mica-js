import type { Diagnostic } from '../../format/diagnostics';
import { report } from '../../format/validate';
import { readWidget, readWidgetPlacement } from '../format/parse';
import type { CanvasDocument, CanvasWidgetInstance, WidgetPlacement } from '../format/types';

/** Position of `instanceId` in drawing order, or `-1` when the canvas has no such instance. */
export function findInstanceIndex(document: CanvasDocument, instanceId: string): number {
  return document.widgets.findIndex((widget) => widget.id === instanceId);
}

/** Replaces one instance, keeping the rest of the document and the array order untouched. */
export function replaceInstance(
  document: CanvasDocument,
  index: number,
  instance: CanvasWidgetInstance,
): CanvasDocument {
  const widgets = [...document.widgets];
  widgets[index] = instance;
  return { ...document, widgets };
}

export function addInstance(
  document: CanvasDocument,
  instance: CanvasWidgetInstance,
  z: number,
  diagnostics: Diagnostic[],
): CanvasDocument {
  const index = isIndexWithin(z, document.widgets.length) ? z : undefined;
  if (index === undefined) {
    report(
      diagnostics,
      'edit/invalid-command',
      `Insertion index ${z} is out of range 0..${document.widgets.length}.`,
      ['widgets'],
    );
  }
  // Instance problems are reported even when `z` is out of range, so one call surfaces them all.
  const widgetPath = ['widgets', String(index ?? document.widgets.length)];
  const widget = readWidget(instance, widgetPath, diagnostics);
  if (widget !== undefined && findInstanceIndex(document, widget.id) !== -1) {
    report(diagnostics, 'id/duplicate', `Duplicate widget id "${widget.id}".`, [
      ...widgetPath,
      'id',
    ]);
    return document;
  }
  if (index === undefined || widget === undefined) {
    return document;
  }
  const widgets = [...document.widgets];
  widgets.splice(index, 0, widget);
  return { ...document, widgets };
}

export function removeInstance(
  document: CanvasDocument,
  instanceId: string,
  diagnostics: Diagnostic[],
): CanvasDocument {
  const index = findInstanceIndex(document, instanceId);
  if (index === -1) {
    report(diagnostics, 'edit/unknown-entity', `Unknown widget instance "${instanceId}".`, [
      'widgets',
    ]);
    return document;
  }
  const widgets = [...document.widgets];
  widgets.splice(index, 1);
  return { ...document, widgets };
}

export function setPlacement(
  document: CanvasDocument,
  instanceId: string,
  placement: WidgetPlacement,
  diagnostics: Diagnostic[],
): CanvasDocument {
  const index = findInstanceIndex(document, instanceId);
  const current = index === -1 ? undefined : document.widgets[index];
  if (current === undefined) {
    report(diagnostics, 'edit/unknown-entity', `Unknown widget instance "${instanceId}".`, [
      'widgets',
    ]);
    return document;
  }
  const parsed = readWidgetPlacement(placement, ['widgets', String(index)], diagnostics);
  if (parsed === undefined) {
    return document;
  }
  return replaceInstance(document, index, { ...current, ...parsed });
}

export function setZ(
  document: CanvasDocument,
  instanceId: string,
  z: number,
  diagnostics: Diagnostic[],
): CanvasDocument {
  const index = findInstanceIndex(document, instanceId);
  const current = index === -1 ? undefined : document.widgets[index];
  if (current === undefined) {
    report(diagnostics, 'edit/unknown-entity', `Unknown widget instance "${instanceId}".`, [
      'widgets',
    ]);
    return document;
  }
  const widgets = [...document.widgets];
  widgets.splice(index, 1);
  // The target index addresses the array after the removal, so the top position shrinks by one.
  if (!isIndexWithin(z, widgets.length)) {
    report(
      diagnostics,
      'edit/invalid-command',
      `Index ${z} is out of range 0..${widgets.length}.`,
      ['widgets'],
    );
    return document;
  }
  widgets.splice(z, 0, current);
  return { ...document, widgets };
}

function isIndexWithin(index: number, maximum: number): boolean {
  return Number.isInteger(index) && index >= 0 && index <= maximum;
}
