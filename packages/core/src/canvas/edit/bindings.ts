import type { Diagnostic } from '../../format/diagnostics';
import { report } from '../../format/validate';
import { readBindingTarget } from '../format/parse';
import type { CanvasBindingTarget, CanvasDocument } from '../format/types';
import { findInstanceIndex, replaceInstance } from './instances';

/**
 * Binds, rebinds or unbinds one widget port. Only the binding shape is checked here; whether the
 * target symbol and port exist, and whether they match in direction and payload, belongs to the
 * binding loader.
 */
export function setBinding(
  document: CanvasDocument,
  instanceId: string,
  port: string,
  target: CanvasBindingTarget | null,
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
  const path = ['widgets', String(index), 'bindings'];
  if (port.length === 0) {
    report(diagnostics, 'schema/invalid-value', 'Binding port keys must not be empty.', path);
    return document;
  }
  const bindings = { ...current.bindings };
  if (target === null) {
    delete bindings[port];
  } else {
    const parsed = readBindingTarget(target, [...path, port], diagnostics);
    if (parsed === undefined) {
      return document;
    }
    bindings[port] = { symbol: parsed.symbol, port: parsed.port };
  }
  return replaceInstance(document, index, { ...current, bindings });
}

/** Sets the bound `.sch` path, or drops the field entirely when `schematic` is `null`. */
export function setSchematic(
  document: CanvasDocument,
  schematic: string | null,
  diagnostics: Diagnostic[],
): CanvasDocument {
  if (schematic === null) {
    return { version: document.version, widgets: document.widgets };
  }
  if (schematic.length === 0) {
    report(diagnostics, 'schema/invalid-value', 'Field "schematic" must not be empty.', [
      'schematic',
    ]);
    return document;
  }
  return { ...document, schematic };
}
