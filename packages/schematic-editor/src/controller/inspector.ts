import {
  DEFAULT_GROUND_LABEL,
  DEFAULT_POWER_LABEL,
  DEFAULT_TEXT_CONTENT,
  builtinSymbolKind,
  isTextDevice,
  parseDeviceReference,
  textDeviceContent,
  type DeviceReference,
  type DeviceSymbolProvider,
  type PropertyValue,
  type SchematicDocument,
  type SchematicSymbol,
  type SchematicTopology,
} from '@mica/core/schematic';
import type { EditorSelection, Inspector, PropertyField, SymbolInspector } from './types';

const PROPERTY_TYPES = ['string', 'number', 'boolean'] as const;

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
  if (item.kind !== 'symbol') {
    return undefined;
  }
  const symbol = document.sheet.symbols.find((candidate) => candidate.id === item.id);
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
  return {
    kind: 'symbol',
    id: symbol.id,
    device: symbol.device,
    name:
      (reference === undefined ? undefined : devices?.getDeviceName(reference)) ??
      builtinName(symbol),
    builtin: builtinSymbolKind(symbol.device) !== undefined || isTextDevice(symbol.device),
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
  const fields: PropertyField[] = [];
  const overrides = symbol.properties ?? {};

  if (isTextDevice(symbol.device)) {
    fields.push({
      key: 'text',
      type: 'string',
      value: typeof overrides['text'] === 'string' ? (overrides['text'] as string) : undefined,
      defaultValue: DEFAULT_TEXT_CONTENT,
    });
    return fields;
  }

  const builtin = builtinSymbolKind(symbol.device);
  if (builtin !== undefined) {
    fields.push({
      key: 'label',
      type: 'string',
      value: typeof overrides['label'] === 'string' ? (overrides['label'] as string) : undefined,
      defaultValue:
        builtin === 'power'
          ? DEFAULT_POWER_LABEL
          : builtin === 'ground'
            ? DEFAULT_GROUND_LABEL
            : symbol.id,
    });
    return fields;
  }

  const declared = deviceProperties(symbol, devices);
  for (const [key, value] of Object.entries(declared)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      continue;
    }
    const type = (value as { type?: unknown }).type;
    if (typeof type !== 'string' || !isPropertyType(type)) {
      continue;
    }
    const fallback = (value as { default?: unknown }).default;
    const override = overrides[key];
    fields.push({
      key,
      type,
      value: isPropertyValue(override, type) ? override : undefined,
      defaultValue: isPropertyValue(fallback, type) ? fallback : undefined,
    });
  }
  return fields;
}

function deviceProperties(
  symbol: SchematicSymbol,
  devices: DeviceSymbolProvider | undefined,
): Readonly<Record<string, unknown>> {
  const reference = parseDeviceReference(symbol.device);
  const raw = reference === undefined ? undefined : deviceRaw(reference, devices);
  const declared = raw?.['properties'];
  return typeof declared === 'object' && declared !== null && !Array.isArray(declared)
    ? (declared as Readonly<Record<string, unknown>>)
    : {};
}

function deviceRaw(
  reference: DeviceReference,
  devices: DeviceSymbolProvider | undefined,
): Readonly<Record<string, unknown>> | undefined {
  const provider = devices as
    { resolve?: (value: DeviceReference) => { raw?: unknown } } | undefined;
  const raw = provider?.resolve?.(reference)?.raw;
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Readonly<Record<string, unknown>>)
    : undefined;
}

function builtinName(symbol: SchematicSymbol): string | undefined {
  if (isTextDevice(symbol.device)) {
    return textDeviceContent(symbol);
  }
  const builtin = builtinSymbolKind(symbol.device);
  if (builtin === undefined) {
    return undefined;
  }
  const label = symbol.properties?.['label'];
  if (typeof label === 'string') {
    return label;
  }
  if (builtin === 'power') {
    return DEFAULT_POWER_LABEL;
  }
  if (builtin === 'ground') {
    return DEFAULT_GROUND_LABEL;
  }
  return symbol.id;
}

function isPropertyType(value: string): value is 'string' | 'number' | 'boolean' {
  return (PROPERTY_TYPES as readonly string[]).includes(value);
}

function isPropertyValue(
  value: unknown,
  type: 'string' | 'number' | 'boolean',
): value is PropertyValue {
  return typeof value === type && (type !== 'number' || Number.isFinite(value));
}
