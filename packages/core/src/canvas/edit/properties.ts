import type { Diagnostic } from '../../format/diagnostics';
import { report } from '../../format/validate';
import { clonePropertyValue } from '../format/parse';
import type { CanvasDocument } from '../format/types';
import { findInstanceIndex, replaceInstance } from './instances';

export function setProperty(
  document: CanvasDocument,
  instanceId: string,
  key: string,
  value: unknown,
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
  if (key.length === 0) {
    report(diagnostics, 'schema/invalid-value', 'Property keys must not be empty.', [
      'widgets',
      String(index),
      'properties',
    ]);
    return document;
  }
  // A fresh map keeps the input document and its nested property objects untouched; cloning keeps
  // later mutation of `value` from leaking into the document, matching `parseCanvas`.
  const properties = { ...current.properties, [key]: clonePropertyValue(value) };
  return replaceInstance(document, index, { ...current, properties });
}

export function unsetProperty(
  document: CanvasDocument,
  instanceId: string,
  key: string,
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
  const properties = { ...current.properties };
  if (!Object.prototype.hasOwnProperty.call(properties, key)) {
    report(
      diagnostics,
      'edit/unknown-entity',
      `Widget instance "${current.id}" has no property ${JSON.stringify(key)}.`,
      ['widgets', String(index), 'properties'],
    );
    return document;
  }
  delete properties[key];
  return replaceInstance(document, index, { ...current, properties });
}
