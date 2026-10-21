import {
  DEFAULT_TEXT_CONTENT,
  designatorOf,
  isTextDevice,
  namesNet,
  netNameOf,
  parseDeviceReference,
  propertyValueProblem,
  symbolRole,
  textDeviceContent,
  type DeviceSymbolProvider,
  type PropertyDescriptor,
  type PropertyValue,
  type SchematicDocument,
  type SchematicSymbol,
  type SchematicTopology,
} from '@mica-js/core/schematic';
import type { EditorSelection, Inspector, PropertyField, SymbolInspector } from './types';

export interface InspectorContext {
  readonly devices: DeviceSymbolProvider | undefined;
  readonly topology: () => SchematicTopology;
}

/** Builds the property-panel payload for the current selection. */
export function buildInspector(
  document: SchematicDocument,
  selection: readonly EditorSelection[],
  context: InspectorContext,
): Inspector {
  if (selection.length !== 1) {
    return undefined;
  }
  const [item] = selection;
  if (item === undefined) {
    return undefined;
  }
  if (item.kind === 'wire') {
    const wire = document.sheet.wires.find((candidate) => candidate.id === item.id);
    if (wire === undefined) {
      return undefined;
    }
    const net = context.topology().nets.find((candidate) => candidate.wireIds.includes(wire.id));
    return { kind: 'wire', id: wire.id, netName: net?.name ?? null, points: wire.points };
  }
  if (item.kind !== 'symbol' && item.kind !== 'reference') {
    return undefined;
  }
  const symbolId = item.kind === 'symbol' ? item.id : item.symbolId;
  const symbol = document.sheet.symbols.find((candidate) => candidate.id === symbolId);
  if (symbol === undefined) {
    return undefined;
  }
  return symbolInspector(symbol, context.devices);
}

function symbolInspector(
  symbol: SchematicSymbol,
  devices: DeviceSymbolProvider | undefined,
): SymbolInspector {
  const reference = parseDeviceReference(symbol.device);
  const role = symbolRole(symbol.device);
  const designator = designatorOf(symbol);
  const net = netNameOf(symbol);
  return {
    kind: 'symbol',
    id: symbol.id,
    role,
    device: symbol.device,
    name:
      (reference === undefined ? undefined : devices?.getDeviceName(reference)) ??
      builtinName(symbol),
    builtin: role !== 'component',
    ...(designator === undefined ? {} : { designator }),
    ...(net === undefined ? {} : { net }),
    x: symbol.x,
    y: symbol.y,
    rotation: symbol.rotation,
    properties: propertyFields(symbol, devices),
  };
}

function propertyFields(
  symbol: SchematicSymbol,
  devices: DeviceSymbolProvider | undefined,
): readonly PropertyField[] {
  const overrides = symbol.properties ?? {};

  if (isTextDevice(symbol.device)) {
    const override = overrides['text'];
    return [toField(TEXT_DESCRIPTOR, typeof override === 'string' ? override : undefined)];
  }

  // Net-naming symbols expose their net name as a dedicated inspector row, not as a property.
  if (namesNet(symbolRole(symbol.device))) {
    return [];
  }

  const fields: PropertyField[] = [];
  for (const descriptor of devicePropertyDescriptors(symbol, devices).values()) {
    const override = overrides[descriptor.key];
    const valid =
      override !== undefined && propertyValueProblem(descriptor, override) === undefined;
    fields.push(toField(descriptor, valid ? override : undefined));
  }
  return fields;
}

/** Moves the declared default to `defaultValue` so hosts can tell it apart from the instance value. */
function toField(descriptor: PropertyDescriptor, value: PropertyValue | undefined): PropertyField {
  const { default: defaultValue, ...rest } = descriptor;
  return {
    ...rest,
    ...(defaultValue === undefined ? {} : { defaultValue }),
    ...(value === undefined ? {} : { value }),
  };
}

function devicePropertyDescriptors(
  symbol: SchematicSymbol,
  devices: DeviceSymbolProvider | undefined,
): ReadonlyMap<string, PropertyDescriptor> {
  const reference = parseDeviceReference(symbol.device);
  if (reference === undefined) {
    return new Map();
  }
  return devices?.getDevicePropertyDescriptors?.(reference) ?? new Map();
}

function builtinName(symbol: SchematicSymbol): string | undefined {
  if (isTextDevice(symbol.device)) {
    return textDeviceContent(symbol);
  }
  return netNameOf(symbol);
}

/** `builtin:text` carries its content in one string property, described like any other (#7). */
const TEXT_DESCRIPTOR: PropertyDescriptor = {
  key: 'text',
  type: 'string',
  title: '文本',
  default: DEFAULT_TEXT_CONTENT,
};
