import type { Diagnostic } from '../../format/diagnostics';
import { throwIfErrors } from '../../format/errors';
import { report } from '../../format/validate';
import type { CanvasBindingTarget, CanvasDocument, CanvasWidgetInstance } from '../format/types';
import type { CanvasBindingCatalog, CanvasPortDescriptor } from './catalog';

export interface ValidateCanvasBindingsOptions {
  readonly catalog?: CanvasBindingCatalog;
  /** Skip widget/property/port checks; useful for partial validation. Default `false`. */
  readonly skipWidgets?: boolean;
}

type WidgetDefinition = NonNullable<ReturnType<CanvasBindingCatalog['widgetDefinition']>>;

interface InstanceContext {
  readonly catalog: CanvasBindingCatalog;
  readonly checkWidgets: boolean;
  readonly checkSymbols: boolean;
}

/**
 * Collects binding diagnostics; never throws.
 *
 * Without a `catalog` the checks that need the widget registry and the schematic are skipped, so a
 * host that has not loaded them can call this safely. `schematic` is optional on the document: when
 * absent, only widget-side facts are checked.
 */
export function validateCanvasBindings(
  document: CanvasDocument,
  options: ValidateCanvasBindingsOptions = {},
): readonly Diagnostic[] {
  const { catalog } = options;
  if (catalog === undefined) {
    return [];
  }
  const diagnostics: Diagnostic[] = [];
  const schematic = document.schematic;
  // An unloaded schematic makes every symbol unknown, so reporting the path once keeps the output
  // free of cascading `canvas/unknown-symbol` errors.
  const schematicLoaded = schematic !== undefined && catalog.hasSchematic(schematic);
  if (schematic !== undefined && !schematicLoaded) {
    report(diagnostics, 'canvas/unknown-schematic', `Schematic "${schematic}" is not loaded.`, [
      'schematic',
    ]);
  }
  const context: InstanceContext = {
    catalog,
    checkWidgets: options.skipWidgets !== true,
    checkSymbols: schematicLoaded,
  };
  document.widgets.forEach((widget, index) => {
    validateInstance(widget, index, context, diagnostics);
  });
  return diagnostics;
}

/** @throws {SchematicError} when any diagnostic is an error. */
export function assertCanvasBindings(
  document: CanvasDocument,
  options: ValidateCanvasBindingsOptions = {},
): void {
  throwIfErrors(validateCanvasBindings(document, options));
}

function validateInstance(
  widget: CanvasWidgetInstance,
  index: number,
  context: InstanceContext,
  diagnostics: Diagnostic[],
): void {
  const path = ['widgets', String(index)];
  const definition = context.checkWidgets
    ? context.catalog.widgetDefinition(widget.widget)
    : undefined;
  if (context.checkWidgets && definition === undefined) {
    report(diagnostics, 'canvas/unknown-widget', `Unknown widget "${widget.widget}".`, [
      ...path,
      'widget',
    ]);
  }
  if (definition !== undefined) {
    validateProperties(widget, path, definition.propertyKeys, diagnostics);
  }
  for (const [port, target] of Object.entries(widget.bindings ?? {})) {
    validateBinding(
      widget,
      port,
      target,
      definition,
      context,
      [...path, 'bindings', port],
      diagnostics,
    );
  }
}

function validateProperties(
  widget: CanvasWidgetInstance,
  path: readonly string[],
  propertyKeys: readonly string[],
  diagnostics: Diagnostic[],
): void {
  for (const key of Object.keys(widget.properties ?? {})) {
    if (!propertyKeys.includes(key)) {
      report(
        diagnostics,
        'canvas/unknown-property',
        `Widget "${widget.widget}" has no property "${key}".`,
        [...path, 'properties', key],
      );
    }
  }
}

function validateBinding(
  widget: CanvasWidgetInstance,
  port: string,
  target: CanvasBindingTarget,
  definition: WidgetDefinition | undefined,
  context: InstanceContext,
  path: readonly string[],
  diagnostics: Diagnostic[],
): void {
  const widgetPort = definition?.ports[port];
  if (definition !== undefined && widgetPort === undefined) {
    report(
      diagnostics,
      'canvas/unknown-port',
      `Widget "${widget.widget}" has no port "${port}".`,
      path,
    );
  }
  if (!context.checkSymbols) {
    return;
  }
  if (!context.catalog.hasSymbol(target.symbol)) {
    report(diagnostics, 'canvas/unknown-symbol', `Unknown symbol "${target.symbol}".`, [
      ...path,
      'symbol',
    ]);
    return;
  }
  const devicePort = context.catalog.symbolPort(target.symbol, target.port);
  if (devicePort === undefined) {
    report(
      diagnostics,
      'canvas/unknown-target-port',
      `Symbol "${target.symbol}" has no port "${target.port}".`,
      [...path, 'port'],
    );
    return;
  }
  if (widgetPort === undefined) {
    return;
  }
  validatePortPair(port, widgetPort, target.port, devicePort, path, diagnostics);
}

/**
 * A widget input receives what a device output sends and a widget output feeds a device input, so
 * the directions must be complementary and the payload types identical.
 */
function validatePortPair(
  widgetPortName: string,
  widgetPort: CanvasPortDescriptor,
  devicePortName: string,
  devicePort: CanvasPortDescriptor,
  path: readonly string[],
  diagnostics: Diagnostic[],
): void {
  const sides =
    `Widget port "${widgetPortName}" (${widgetPort.direction}, ${widgetPort.type}) cannot bind ` +
    `to device port "${devicePortName}" (${devicePort.direction}, ${devicePort.type})`;
  if (widgetPort.direction === devicePort.direction) {
    report(diagnostics, 'topic/type-mismatch', `${sides}: directions must be complementary.`, path);
  }
  if (widgetPort.type !== devicePort.type) {
    report(diagnostics, 'topic/type-mismatch', `${sides}: payload types must match.`, path);
  }
}
