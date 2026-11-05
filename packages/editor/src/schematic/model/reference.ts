import {
  referenceAnchor,
  pinsBounds,
  symbolPinPosition,
  type DeviceSymbolDefinition,
  type Point,
  type SchematicSymbol,
} from '@mica-js/document/schematic';

export function deviceReferenceAnchor(
  definition: DeviceSymbolDefinition | undefined,
  override: Point | undefined,
): Point {
  const declared = definition?.annotations?.designator?.position;
  return referenceAnchor(
    definition?.bounds ?? (definition === undefined ? undefined : pinsBounds(definition.pins)),
    override ?? (declared === undefined ? undefined : { x: declared[0], y: declared[1] }),
  );
}

export function deviceReferencePosition(
  symbol: Pick<SchematicSymbol, 'x' | 'y' | 'rotation' | 'reference'>,
  definition: DeviceSymbolDefinition | undefined,
): Point {
  return symbolPinPosition(symbol, deviceReferenceAnchor(definition, symbol.reference));
}
