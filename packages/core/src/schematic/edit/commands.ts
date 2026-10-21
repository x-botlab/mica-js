import { isAssetReference } from '../format/asset';
import type { Diagnostic } from '../format/diagnostics';
import { throwIfErrors } from '../format/errors';
import { parseSchematic } from '../format/parse-schematic';
import type {
  Point,
  PropertyValue,
  SchematicDocument,
  SchematicJunction,
  SchematicSymbol,
  SchematicWire,
} from '../format/types';
import { toPointer } from '../format/validate';
import {
  normalizePropertyValue,
  propertyValueProblem,
  type PropertyDescriptor,
} from '../device/properties';
import { parseDeviceReference } from '../device/reference';
import { defaultNetName, hasDesignator, namesNet, symbolRole } from '../device/reference';
import type { SymbolRole } from '../device/reference';
import type { TopologyOptions } from '../topology/derive';
import { DEFAULT_TOLERANCE, pointOnPolyline } from '../geometry/point';
import { defaultElementIdFactory, type ElementIdFactory } from './ids';

export type SchematicCommand =
  | {
      readonly type: 'add-symbol';
      readonly id?: string;
      readonly device: string;
      readonly x: number;
      readonly y: number;
      readonly rotation?: number;
      readonly properties?: Readonly<Record<string, PropertyValue>>;
      /** Component reference designator; defaults to the new symbol's id. */
      readonly designator?: string;
      /** Net name for labels / power / ground; power and ground fall back to VCC / GND. */
      readonly net?: string;
      /** Reference designator anchor in symbol-local coordinates; `null` clears it. */
      readonly reference?: Point | null;
    }
  | {
      readonly type: 'update-symbol';
      readonly id: string;
      readonly device?: string;
      readonly x?: number;
      readonly y?: number;
      readonly rotation?: number;
      /** Replaces the whole property map when provided. */
      readonly properties?: Readonly<Record<string, PropertyValue>>;
      /** Reference designator; `null` clears the override, `undefined` keeps it. */
      readonly designator?: string | null;
      /** Net name; `null` clears it, `undefined` keeps it. */
      readonly net?: string | null;
      /** Reference designator anchor; `null` clears it, `undefined` keeps it. */
      readonly reference?: Point | null;
    }
  | { readonly type: 'remove-symbol'; readonly id: string }
  | {
      readonly type: 'set-symbol-property';
      readonly id: string;
      readonly key: string;
      readonly value: PropertyValue;
    }
  | { readonly type: 'remove-symbol-property'; readonly id: string; readonly key: string }
  | { readonly type: 'add-wire'; readonly id?: string; readonly points: readonly Point[] }
  | { readonly type: 'set-wire-points'; readonly id: string; readonly points: readonly Point[] }
  | { readonly type: 'remove-wire'; readonly id: string }
  | {
      readonly type: 'add-junction';
      readonly id?: string;
      readonly x: number;
      readonly y: number;
      readonly wires: readonly string[];
    }
  | {
      readonly type: 'update-junction';
      readonly id: string;
      readonly x?: number;
      readonly y?: number;
      readonly wires?: readonly string[];
    }
  | { readonly type: 'remove-junction'; readonly id: string };

export interface EditEffect {
  readonly kind: 'junction-removed';
  readonly id: string;
  readonly reason: 'wire-removed' | 'junction-detached';
}

export interface SchematicEditOptions extends TopologyOptions {
  readonly createId?: ElementIdFactory;
  /** How to handle junctions that stop lying on a wire after its geometry changes. */
  readonly onJunctionConflict?: 'reject' | 'remove';
  /** Receives cascaded removals such as junctions dropped with their wire. */
  readonly onEffect?: (effect: EditEffect) => void;
}

/**
 * Applies an edit command to a copy of `document`.
 *
 * @throws {SchematicError} when the command is invalid; the input document is never mutated.
 */
export function applySchematicCommand(
  document: SchematicDocument,
  command: SchematicCommand,
  options: SchematicEditOptions = {},
): SchematicDocument {
  const symbols = [...document.sheet.symbols];
  const wires = [...document.sheet.wires];
  const junctions = [...document.sheet.junctions];
  const diagnostics: Diagnostic[] = [];
  const effects: EditEffect[] = [];
  const createId = options.createId ?? defaultElementIdFactory;
  const draft = (): SchematicDocument => ({ ...document, sheet: { symbols, wires, junctions } });

  switch (command.type) {
    case 'add-symbol': {
      const device = requireDevice(command.device, diagnostics);
      const id = command.id ?? createId('symbol', draft());
      const properties = normalizeProperties(
        command.properties,
        deviceDescriptors(device, options),
        diagnostics,
      );
      const reference = resolveReference(
        command.reference,
        undefined,
        ['sheet', 'symbols'],
        diagnostics,
      );
      if (device !== undefined) {
        const role = symbolRole(device);
        const designator = resolveDesignator(command.designator, role, id, diagnostics);
        const net = resolveNet(command.net, role, diagnostics);
        symbols.push(
          withProperties(
            {
              id,
              device,
              x: command.x,
              y: command.y,
              rotation: command.rotation ?? 0,
              ...(designator === undefined ? {} : { designator }),
              ...(net === undefined ? {} : { net }),
              ...(hasDesignator(role) && reference !== undefined ? { reference } : {}),
            },
            properties,
          ),
        );
      }
      break;
    }
    case 'update-symbol': {
      const index = findIndex(symbols, command.id, 'symbol', diagnostics);
      const current = index === -1 ? undefined : symbols[index];
      if (current !== undefined) {
        const device =
          command.device === undefined
            ? current.device
            : requireDevice(command.device, diagnostics);
        const properties =
          command.properties === undefined
            ? current.properties
            : normalizeProperties(
                command.properties,
                deviceDescriptors(device, options),
                diagnostics,
              );
        const reference = resolveReference(
          command.reference,
          current.reference,
          ['sheet', 'symbols', String(index)],
          diagnostics,
        );
        if (device !== undefined) {
          const role = symbolRole(device);
          const designator = resolveOptionalText(
            command.designator,
            current.designator,
            hasDesignator(role),
            'designator',
            diagnostics,
          );
          const net = resolveOptionalText(
            command.net,
            current.net,
            namesNet(role),
            'net',
            diagnostics,
          );
          symbols[index] = withProperties(
            {
              id: current.id,
              device,
              x: command.x ?? current.x,
              y: command.y ?? current.y,
              rotation: command.rotation ?? current.rotation,
              ...(designator === undefined ? {} : { designator }),
              ...(net === undefined ? {} : { net }),
              ...(hasDesignator(role) && reference !== undefined ? { reference } : {}),
            },
            properties,
          );
        }
      }
      break;
    }
    case 'remove-symbol': {
      const index = findIndex(symbols, command.id, 'symbol', diagnostics);
      if (index !== -1) {
        symbols.splice(index, 1);
      }
      break;
    }
    case 'set-symbol-property': {
      const index = findIndex(symbols, command.id, 'symbol', diagnostics);
      const current = index === -1 ? undefined : symbols[index];
      if (current !== undefined) {
        const value = checkPropertyValue(
          command.key,
          command.value,
          deviceDescriptors(current.device, options)?.get(command.key),
          diagnostics,
        );
        if (value !== undefined) {
          symbols[index] = withProperties(baseOf(current), {
            ...(current.properties ?? {}),
            [command.key]: value,
          });
        }
      }
      break;
    }
    case 'remove-symbol-property': {
      const index = findIndex(symbols, command.id, 'symbol', diagnostics);
      const current = index === -1 ? undefined : symbols[index];
      if (current !== undefined) {
        const properties = { ...(current.properties ?? {}) };
        if (!Object.prototype.hasOwnProperty.call(properties, command.key)) {
          diagnostics.push({
            severity: 'error',
            code: 'edit/unknown-entity',
            message: `Symbol "${current.id}" has no property ${JSON.stringify(command.key)}.`,
            entity: { kind: 'symbol', id: current.id },
          });
        } else {
          delete properties[command.key];
          symbols[index] = withProperties(baseOf(current), properties);
        }
      }
      break;
    }
    case 'add-wire': {
      const id = command.id ?? createId('wire', draft());
      const wire = makeWire(id, command.points, diagnostics);
      if (wire !== undefined) {
        wires.push(wire);
      }
      break;
    }
    case 'set-wire-points': {
      const index = findIndex(wires, command.id, 'wire', diagnostics);
      if (index !== -1) {
        const wire = makeWire(command.id, command.points, diagnostics);
        if (wire !== undefined) {
          wires[index] = wire;
        }
      }
      break;
    }
    case 'remove-wire': {
      const index = findIndex(wires, command.id, 'wire', diagnostics);
      if (index !== -1) {
        wires.splice(index, 1);
        for (let junctionIndex = junctions.length - 1; junctionIndex >= 0; junctionIndex -= 1) {
          const junction = junctions[junctionIndex];
          if (junction === undefined || !junction.wires.includes(command.id)) {
            continue;
          }
          effects.push({ kind: 'junction-removed', id: junction.id, reason: 'wire-removed' });
          junctions.splice(junctionIndex, 1);
        }
      }
      break;
    }
    case 'add-junction': {
      const id = command.id ?? createId('junction', draft());
      const junction = makeJunction(id, command.x, command.y, command.wires, diagnostics);
      if (junction !== undefined) {
        junctions.push(junction);
      }
      break;
    }
    case 'update-junction': {
      const index = findIndex(junctions, command.id, 'junction', diagnostics);
      const current = index === -1 ? undefined : junctions[index];
      if (current !== undefined) {
        const junction = makeJunction(
          current.id,
          command.x ?? current.x,
          command.y ?? current.y,
          command.wires ?? current.wires,
          diagnostics,
        );
        if (junction !== undefined) {
          junctions[index] = junction;
        }
      }
      break;
    }
    case 'remove-junction': {
      const index = findIndex(junctions, command.id, 'junction', diagnostics);
      if (index !== -1) {
        junctions.splice(index, 1);
      }
      break;
    }
    default: {
      diagnostics.push({
        severity: 'error',
        code: 'edit/invalid-command',
        message: `Unsupported command ${JSON.stringify((command as { type?: unknown }).type)}.`,
      });
    }
  }

  throwIfErrors(diagnostics);

  const result = validateSheet(draft(), options, diagnostics, effects);
  throwIfErrors(diagnostics);

  for (const effect of effects) {
    options.onEffect?.(effect);
  }
  return result;
}

function validateSheet(
  candidate: SchematicDocument,
  options: SchematicEditOptions,
  diagnostics: Diagnostic[],
  effects: EditEffect[],
): SchematicDocument {
  // Structural re-validation: ids, required fields, wire point counts, junction references.
  const parsed = parseSchematic(candidate);
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const wireById = new Map(parsed.sheet.wires.map((wire) => [wire.id, wire]));
  const survivingJunctions: SchematicJunction[] = [];
  let cascaded = false;

  for (const junction of parsed.sheet.junctions) {
    const detached = junction.wires.some((wireId) => {
      const wire = wireById.get(wireId);
      return (
        wire === undefined ||
        !pointOnPolyline(wire.points, { x: junction.x, y: junction.y }, tolerance)
      );
    });
    if (!detached) {
      survivingJunctions.push(junction);
      continue;
    }
    if (options.onJunctionConflict === 'remove') {
      cascaded = true;
      effects.push({ kind: 'junction-removed', id: junction.id, reason: 'junction-detached' });
      continue;
    }
    diagnostics.push({
      severity: 'error',
      code: 'junction/off-wire',
      message: `Junction "${junction.id}" no longer lies on every referenced wire.`,
      pointer: toPointer(['sheet', 'junctions']),
      entity: { kind: 'junction', id: junction.id },
    });
  }

  if (!cascaded) {
    return parsed;
  }
  return { ...parsed, sheet: { ...parsed.sheet, junctions: survivingJunctions } };
}

function makeWire(
  id: string,
  points: readonly Point[],
  diagnostics: Diagnostic[],
): SchematicWire | undefined {
  if (points.length < 2) {
    diagnostics.push({
      severity: 'error',
      code: 'wire/invalid-points',
      message: `Wire "${id}" must contain at least two points.`,
      entity: { kind: 'wire', id },
    });
    return undefined;
  }
  return { id, points: points.map((point) => ({ x: point.x, y: point.y })) };
}

function makeJunction(
  id: string,
  x: number,
  y: number,
  wires: readonly string[],
  diagnostics: Diagnostic[],
): SchematicJunction | undefined {
  if (wires.length < 2) {
    diagnostics.push({
      severity: 'error',
      code: 'schema/invalid-value',
      message: `Junction "${id}" must reference at least two wires.`,
      entity: { kind: 'junction', id },
    });
    return undefined;
  }
  return { id, x, y, wires: [...wires] };
}

function requireDevice(device: string, diagnostics: Diagnostic[]): string | undefined {
  if (parseDeviceReference(device) === undefined) {
    diagnostics.push({
      severity: 'error',
      code: 'device/invalid-reference',
      message: `Invalid device reference ${JSON.stringify(device)}.`,
    });
    return undefined;
  }
  return device;
}

function baseOf(symbol: SchematicSymbol): Omit<SchematicSymbol, 'properties' | 'reference'> {
  return {
    id: symbol.id,
    device: symbol.device,
    x: symbol.x,
    y: symbol.y,
    rotation: symbol.rotation,
    ...(symbol.designator === undefined ? {} : { designator: symbol.designator }),
    ...(symbol.net === undefined ? {} : { net: symbol.net }),
  };
}

/**
 * Reference designator for a new symbol: components keep `undefined` (the id doubles as the
 * default designator), everything else must not have one.
 */
function resolveDesignator(
  value: string | undefined,
  role: SymbolRole,
  id: string,
  diagnostics: Diagnostic[],
): string | undefined {
  if (!hasDesignator(role)) {
    if (value !== undefined) {
      diagnostics.push({
        severity: 'error',
        code: 'symbol/unsupported-field',
        message: `Symbols of role "${role}" carry no reference designator.`,
      });
    }
    return undefined;
  }
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 || trimmed === id ? undefined : trimmed;
}

/** Net name for a new symbol; labels need one, power and ground fall back to their default. */
function resolveNet(
  value: string | undefined,
  role: SymbolRole,
  diagnostics: Diagnostic[],
): string | undefined {
  if (!namesNet(role)) {
    if (value !== undefined) {
      diagnostics.push({
        severity: 'error',
        code: 'symbol/unsupported-field',
        message: `Symbols of role "${role}" name no net.`,
      });
    }
    return undefined;
  }
  const trimmed = value?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    return trimmed;
  }
  const fallback = defaultNetName(role);
  if (fallback === undefined) {
    diagnostics.push({
      severity: 'error',
      code: 'symbol/missing-net',
      message: `Symbols of role "${role}" must name the net they attach to.`,
    });
  }
  return fallback;
}

/** `null` clears the field, `undefined` keeps it, and unsupported roles cannot set it. */
function resolveOptionalText(
  value: string | null | undefined,
  current: string | undefined,
  supported: boolean,
  field: 'designator' | 'net',
  diagnostics: Diagnostic[],
): string | undefined {
  if (value === undefined) {
    return current;
  }
  if (!supported) {
    diagnostics.push({
      severity: 'error',
      code: 'symbol/unsupported-field',
      message: `This symbol must not declare "${field}".`,
    });
    return undefined;
  }
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    diagnostics.push({
      severity: 'error',
      code: 'schema/invalid-value',
      message: `${field === 'net' ? 'Net name' : 'Reference designator'} must not be empty.`,
    });
    return undefined;
  }
  return trimmed;
}

function withProperties(
  symbol: Omit<SchematicSymbol, 'properties'>,
  properties: Readonly<Record<string, PropertyValue>> | undefined,
): SchematicSymbol {
  if (properties === undefined || Object.keys(properties).length === 0) {
    return symbol;
  }
  return { ...symbol, properties };
}

/** `reference: null` clears the override and falls back to the default anchor. */
function resolveReference(
  value: Point | null | undefined,
  current: Point | undefined,
  path: readonly string[],
  diagnostics: Diagnostic[],
): Point | undefined {
  if (value === undefined) {
    return current;
  }
  if (value === null) {
    return undefined;
  }
  if (typeof value !== 'object' || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    diagnostics.push({
      severity: 'error',
      code: 'schema/invalid-value',
      message: 'Symbol reference must contain finite x and y numbers.',
      pointer: toPointer([...path, 'reference']),
    });
    return undefined;
  }
  return { x: value.x, y: value.y };
}

/** Property descriptors of `device`, when the caller supplied a device registry (#7). */
function deviceDescriptors(
  device: string | undefined,
  options: SchematicEditOptions,
): ReadonlyMap<string, PropertyDescriptor> | undefined {
  const reference = device === undefined ? undefined : parseDeviceReference(device);
  return reference === undefined
    ? undefined
    : options.devices?.getDevicePropertyDescriptors?.(reference);
}

function normalizeProperties(
  properties: Readonly<Record<string, PropertyValue>> | undefined,
  descriptors: ReadonlyMap<string, PropertyDescriptor> | undefined,
  diagnostics: Diagnostic[],
): Readonly<Record<string, PropertyValue>> | undefined {
  if (properties === undefined) {
    return undefined;
  }
  const normalized: Record<string, PropertyValue> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (key.length === 0) {
      diagnostics.push({
        severity: 'error',
        code: 'schema/invalid-value',
        message: 'Property keys must not be empty.',
      });
      continue;
    }
    const checked = checkPropertyValue(key, value, descriptors?.get(key), diagnostics);
    if (checked !== undefined) {
      normalized[key] = checked;
    }
  }
  return normalized;
}

function checkPropertyValue(
  key: string,
  value: PropertyValue,
  descriptor: PropertyDescriptor | undefined,
  diagnostics: Diagnostic[],
): PropertyValue | undefined {
  if (key.length === 0) {
    diagnostics.push({
      severity: 'error',
      code: 'schema/invalid-value',
      message: 'Property keys must not be empty.',
    });
    return undefined;
  }
  if (descriptor !== undefined) {
    const problem = propertyValueProblem(descriptor, value);
    if (problem !== undefined) {
      diagnostics.push({ severity: 'error', code: problem.code, message: problem.message });
      return undefined;
    }
    return normalizePropertyValue(descriptor, value);
  }
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      diagnostics.push({
        severity: 'error',
        code: 'schema/invalid-value',
        message: `Property "${key}" must be a finite number.`,
      });
      return undefined;
    }
    return value;
  }
  if (isAssetReference(value)) {
    return value;
  }
  diagnostics.push({
    severity: 'error',
    code: 'schema/invalid-value',
    message: `Property "${key}" must be a string, finite number, boolean, resource reference or null.`,
  });
  return undefined;
}

function findIndex<T extends { readonly id: string }>(
  items: readonly T[],
  id: string,
  kind: 'symbol' | 'wire' | 'junction',
  diagnostics: Diagnostic[],
): number {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) {
    diagnostics.push({
      severity: 'error',
      code: 'edit/unknown-entity',
      message: `Unknown ${kind} "${id}".`,
      entity: { kind, id },
    });
  }
  return index;
}
