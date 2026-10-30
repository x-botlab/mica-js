import { propertyValueProblem, readPropertyDescriptors } from '@mica-js/core/schematic';
import type { PropertyValue } from '@mica-js/core/schematic';

export interface ElectricalReference {
  readonly source: string;
}

export interface PinElectricalDescription {
  readonly drive?: {
    readonly reference: ElectricalReference;
    readonly highResistance: number;
    readonly lowResistance: number;
    readonly analogResistance?: number;
    readonly maxAbsCurrent?: number;
  };
  readonly bias?: {
    readonly reference: ElectricalReference;
    readonly upResistance: number;
    readonly downResistance: number;
  };
  readonly input?: {
    readonly reference: ElectricalReference;
    readonly low: number;
    readonly high: number;
  };
}

export interface ResistorInitialState {
  readonly resistance: number;
  readonly enabled: boolean;
  readonly maxAbsCurrent?: number;
}

export interface ResistorDeclaration {
  readonly pins: readonly [string, string];
}

export interface ContactDeclaration extends ResistorDeclaration {
  readonly initial: 'open' | 'closed';
}

interface InitializedResistor extends ResistorDeclaration, ResistorInitialState {}

export interface DeviceElectricalInitialization {
  initializeResistor(id: string, initial: ResistorInitialState): void;
  initializePin(id: string, initial: PinElectricalDescription): void;
}

export interface ElectricalFactoryContext {
  readonly properties: Readonly<Record<string, PropertyValue>>;
  readonly electrical: DeviceElectricalInitialization;
}

export interface ElectricalPinDeclaration {
  readonly kind: 'signal' | 'power' | 'gnd';
  readonly side?: 'left' | 'right' | 'top' | 'bottom';
}

export interface PreparedElectricalDevice<T> {
  readonly pinDeclarations: Readonly<Record<string, ElectricalPinDeclaration>>;
  readonly properties: Readonly<Record<string, PropertyValue>>;
  readonly pins: Readonly<Record<string, PinElectricalDescription>>;
  readonly resistors: Readonly<Record<string, InitializedResistor>>;
  readonly connections: Readonly<Record<string, ContactDeclaration>>;
  readonly implementation: T;
}

export type ElectricalDefinitionErrorCode =
  | 'electrical/invalid-definition'
  | 'electrical/invalid-parameter'
  | 'electrical/unknown-resource'
  | 'electrical/duplicate-initialization'
  | 'electrical/missing-initialization'
  | 'electrical/factory-closed';

export class ElectricalDefinitionError extends Error {
  override readonly name = 'ElectricalDefinitionError';
  constructor(
    readonly code: ElectricalDefinitionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Resolves a JSON declaration and calls its paired synchronous factory exactly once. */
export function prepareElectricalDevice<T>(
  definition: unknown,
  values: Readonly<Record<string, PropertyValue>>,
  factory: (context: ElectricalFactoryContext) => T,
): PreparedElectricalDevice<T> {
  const raw = record(definition, 'device');
  const declarations = record(raw['pins'], 'pins');
  const pinDeclarations: [string, ElectricalPinDeclaration][] = [];
  for (const [id, value] of Object.entries(declarations)) {
    resourceId(id);
    const pin = record(value, `pins.${id}`);
    rejectFields(pin, ['direction', 'role', 'electrical'], `pins.${id}`);
    if (!['signal', 'power', 'gnd'].includes(String(pin['kind']))) {
      fail('electrical/invalid-definition', `pins.${id}.kind must be signal, power or gnd`);
    }
    if (
      pin['side'] !== undefined &&
      !['left', 'right', 'top', 'bottom'].includes(String(pin['side']))
    ) {
      fail('electrical/invalid-definition', `pins.${id}.side is invalid`);
    }
    pinDeclarations.push([
      id,
      Object.freeze({
        kind: pin['kind'] as ElectricalPinDeclaration['kind'],
        ...(pin['side'] === undefined
          ? {}
          : { side: pin['side'] as NonNullable<ElectricalPinDeclaration['side']> }),
      }),
    ]);
  }
  const resistors = parseBranches(raw['resistors'], declarations, false);
  const connections = parseBranches(raw['connections'], declarations, true);
  const descriptors = readPropertyDescriptors(raw['properties']);
  const resolved: [string, PropertyValue][] = [];
  for (const [key, descriptor] of descriptors) {
    const value = Object.hasOwn(values, key) ? values[key] : descriptor.default;
    if (value === undefined) continue;
    const problem = propertyValueProblem(descriptor, value);
    if (problem !== undefined) fail('electrical/invalid-parameter', problem.message);
    resolved.push([key, freezeCopy(value)]);
  }
  const properties = Object.freeze(Object.fromEntries(resolved));
  const initializedPins = new Map<string, PinElectricalDescription>();
  const initializedResistors = new Map<string, InitializedResistor>();
  let open = true;
  const assertOpen = (): void => {
    if (!open) fail('electrical/factory-closed', 'Electrical declarations are closed');
  };
  const electrical: DeviceElectricalInitialization = Object.freeze({
    initializeResistor(id: string, initial: ResistorInitialState): void {
      assertOpen();
      const branch = resistors.get(id);
      if (branch === undefined) fail('electrical/unknown-resource', `Unknown resistor "${id}"`);
      if (initializedResistors.has(id)) {
        fail('electrical/duplicate-initialization', `Resistor "${id}" is already initialized`);
      }
      const state = record(initial, `resistor ${id}`);
      positive(state['resistance'], `resistor ${id}.resistance`);
      if (typeof state['enabled'] !== 'boolean') {
        fail('electrical/invalid-parameter', `resistor ${id}.enabled must be boolean`);
      }
      optionalCurrent(state, `resistor ${id}`);
      initializedResistors.set(
        id,
        freezeCopy({
          pins: branch.pins,
          resistance: initial.resistance,
          enabled: initial.enabled,
          ...(initial.maxAbsCurrent === undefined ? {} : { maxAbsCurrent: initial.maxAbsCurrent }),
        }),
      );
    },
    initializePin(id: string, initial: PinElectricalDescription): void {
      assertOpen();
      if (!Object.hasOwn(declarations, id)) {
        fail('electrical/unknown-resource', `Unknown pin "${id}"`);
      }
      if (initializedPins.has(id)) {
        fail('electrical/duplicate-initialization', `Pin "${id}" is already initialized`);
      }
      validatePin(initial, id);
      initializedPins.set(id, freezeCopy(initial));
    },
  });
  let implementation: T;
  try {
    implementation = factory(Object.freeze({ properties, electrical }));
    if (
      implementation !== null &&
      (typeof implementation === 'object' || typeof implementation === 'function') &&
      'then' in implementation
    ) {
      fail('electrical/invalid-definition', 'The paired device factory must be synchronous');
    }
  } finally {
    open = false;
  }
  for (const id of resistors.keys()) {
    if (!initializedResistors.has(id)) {
      fail('electrical/missing-initialization', `Resistor "${id}" has no initial state`);
    }
  }
  return Object.freeze({
    pinDeclarations: Object.freeze(Object.fromEntries(pinDeclarations)),
    properties,
    pins: Object.freeze(Object.fromEntries(initializedPins)),
    resistors: Object.freeze(Object.fromEntries(initializedResistors)),
    connections: Object.freeze(Object.fromEntries(connections)) as Readonly<
      Record<string, ContactDeclaration>
    >,
    implementation,
  });
}

function parseBranches(
  value: unknown,
  pins: Record<string, unknown>,
  contact: boolean,
): Map<string, ResistorDeclaration | ContactDeclaration> {
  const result = new Map<string, ResistorDeclaration | ContactDeclaration>();
  if (value === undefined) return result;
  for (const [id, item] of Object.entries(record(value, contact ? 'connections' : 'resistors'))) {
    resourceId(id);
    const branch = record(item, id);
    rejectFields(branch, ['resistance', 'adjustable', 'initialEnabled'], id);
    const endpoints = branch['pins'];
    if (
      !Array.isArray(endpoints) ||
      endpoints.length !== 2 ||
      endpoints[0] === endpoints[1] ||
      endpoints.some((pin) => typeof pin !== 'string' || !Object.hasOwn(pins, pin))
    ) {
      fail('electrical/invalid-definition', `${id}.pins must name two distinct declared pins`);
    }
    const pair: readonly [string, string] = [endpoints[0] as string, endpoints[1] as string];
    if (contact) {
      const initial = branch['initial'] ?? 'open';
      if (initial !== 'open' && initial !== 'closed') {
        fail('electrical/invalid-definition', `${id}.initial must be open or closed`);
      }
      result.set(id, freezeCopy({ pins: pair, initial }));
    } else {
      result.set(id, freezeCopy({ pins: pair }));
    }
  }
  return result;
}

function validatePin(value: PinElectricalDescription, id: string): void {
  const pin = record(value, `pin ${id}`);
  rejectFields(pin, ['direction', 'role', 'interpretation'], id);
  if (!['drive', 'bias', 'input'].some((key) => pin[key] !== undefined)) {
    fail('electrical/invalid-parameter', `pin ${id} needs drive, bias or input parameters`);
  }
  for (const category of ['drive', 'bias', 'input'] as const) {
    if (pin[category] === undefined) continue;
    const part = record(pin[category], `${id}.${category}`);
    const reference = record(part['reference'], `${id}.${category}.reference`);
    if (typeof reference['source'] !== 'string' || reference['source'].length === 0) {
      fail('electrical/invalid-parameter', `${id}.${category} needs an explicit source reference`);
    }
    if (category === 'drive') {
      positive(part['highResistance'], `${id}.highResistance`);
      positive(part['lowResistance'], `${id}.lowResistance`);
      if (part['analogResistance'] !== undefined)
        positive(part['analogResistance'], `${id}.analogResistance`);
      optionalCurrent(part, id);
    } else if (category === 'bias') {
      positive(part['upResistance'], `${id}.upResistance`);
      positive(part['downResistance'], `${id}.downResistance`);
    } else {
      rejectFields(part, ['interpretation'], `${id}.input`);
      const low = part['low'];
      const high = part['high'];
      if (
        typeof low !== 'number' ||
        typeof high !== 'number' ||
        !Number.isFinite(low) ||
        !Number.isFinite(high) ||
        low < 0 ||
        low >= high ||
        high > 1
      ) {
        fail('electrical/invalid-parameter', `${id} thresholds must satisfy 0 <= low < high <= 1`);
      }
    }
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('electrical/invalid-definition', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function resourceId(id: string): void {
  if (id.length === 0) fail('electrical/invalid-definition', 'Resource IDs must not be empty');
}

function positive(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail('electrical/invalid-parameter', `${label} must be finite and greater than zero`);
  }
}

function optionalCurrent(value: Record<string, unknown>, label: string): void {
  if (value['maxAbsCurrent'] !== undefined)
    positive(value['maxAbsCurrent'], `${label}.maxAbsCurrent`);
}

function rejectFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  for (const field of fields) {
    if (Object.hasOwn(value, field)) {
      fail(
        'electrical/invalid-definition',
        `${label}.${field} is not part of the electrical declaration`,
      );
    }
  }
}

function freezeCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== 'object') return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(copy);
  return copy;
}

function fail(code: ElectricalDefinitionErrorCode, message: string): never {
  throw new ElectricalDefinitionError(code, message);
}
