import { snapshotElectricalPin } from '../electrical/network';
import {
  checkChoice,
  checkFinite,
  checkIdentity,
  checkInteger,
  checkRecord,
  invalidType,
} from '../electrical/validation';
import type { ElectricalPinInput } from '../electrical/types';
import type { TopologyDefinition, TopologyPinRef } from '../topology/types';
import { captureTopologyDefinition } from '../topology/runtime';
import type {
  PowerDomainObserver,
  PowerFloatingOptions,
  PowerInputMode,
  PowerLevels,
} from './types';

const INPUT_MODES = ['two-state', 'three-state'] as const;
const DOMAIN_FIELDS = ['supply', 'ground', 'voltage', 'dependsOn'] as const;
const VOLTAGE_FIELDS = ['turnOn', 'turnOff'] as const;
const BINDING_FIELDS = ['powerDomain', 'levels'] as const;
const LEVEL_FIELDS = ['low', 'high'] as const;
const DEVICE_FIELDS = ['instanceId', 'powerDomains', 'pins'] as const;
const DEFINITION_FIELDS = ['topology', 'devices'] as const;
const OPTION_FIELDS = [
  'instanceId',
  'topologyInstanceId',
  'pinStates',
  'floating',
  'inputMode',
  'maxPropagationRounds',
  'observer',
] as const;
const FLOATING_FIELDS = ['seed'] as const;

const DEFAULT_MAX_PROPAGATION_ROUNDS = 10_000;

type PinKind = 'signal' | 'power' | 'gnd';

export interface CapturedDomain {
  readonly instanceId: string;
  readonly domainId: string;
  readonly key: string;
  readonly supply: TopologyPinRef;
  readonly ground: TopologyPinRef;
  readonly turnOn: number;
  readonly turnOff: number;
  readonly dependsOn: readonly CapturedDomain[];
  readonly depth: number;
}

export interface CapturedPin {
  readonly ref: TopologyPinRef;
  readonly key: string;
  readonly kind: PinKind;
  readonly domain: CapturedDomain | undefined;
  readonly levels: PowerLevels | undefined;
}

export interface CapturedDevice {
  readonly instanceId: string;
  readonly domains: readonly CapturedDomain[];
  readonly domainsById: ReadonlyMap<string, CapturedDomain>;
}

export interface CapturedPowerDefinition {
  readonly topology: TopologyDefinition;
  readonly devices: readonly CapturedDevice[];
  readonly devicesById: ReadonlyMap<string, CapturedDevice>;
  readonly domainsInOrder: readonly CapturedDomain[];
  readonly domainsByKey: ReadonlyMap<string, CapturedDomain>;
  readonly pins: readonly CapturedPin[];
  readonly pinsByKey: ReadonlyMap<string, CapturedPin>;
  readonly instances: ReadonlySet<string>;
}

export interface CapturedObserver {
  readonly receiver: PowerDomainObserver;
  readonly notify: PowerDomainObserver['onPowerDomainChange'];
}

export interface CapturedPowerOptions {
  readonly instanceId: string;
  readonly topologyInstanceId: string;
  readonly intents: ReadonlyMap<string, ElectricalPinInput>;
  readonly initialStates: readonly ElectricalPinInput[];
  readonly floating: PowerFloatingOptions | undefined;
  readonly inputMode: PowerInputMode;
  readonly maxPropagationRounds: number;
  readonly observer: CapturedObserver | undefined;
}

interface InterimDomain {
  readonly instanceId: string;
  readonly domainId: string;
  readonly supply: TopologyPinRef;
  readonly ground: TopologyPinRef;
  readonly turnOn: number;
  readonly turnOff: number;
  readonly dependsOnIds: readonly string[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRefs(left: TopologyPinRef, right: TopologyPinRef): number {
  return compareText(left.instanceId, right.instanceId) || compareText(left.pinName, right.pinName);
}

export function pinKey(instanceId: string, pinName: string): string {
  return JSON.stringify([instanceId, pinName]);
}

export function domainKey(instanceId: string, domainId: string): string {
  return JSON.stringify([instanceId, domainId]);
}

function captureEntries(value: unknown, path: string): readonly [string, unknown][] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalidType(path, value, 'be an object');
  }
  const entries: [string, unknown][] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      invalidType(`${path}.${String(key)}`, Reflect.get(value, key), 'use a string key');
    }
    if (key.length === 0) {
      throw new RangeError(`${path}: map keys must be nonempty strings`);
    }
    entries.push([key, Reflect.get(value, key)]);
  }
  entries.sort(([left], [right]) => compareText(left, right));
  return Object.freeze(entries);
}

function captureLevels(value: unknown, path: string): PowerLevels {
  checkRecord(value, path, LEVEL_FIELDS);
  const low = value.low;
  const high = value.high;
  checkFinite(low, `${path}.low`);
  checkFinite(high, `${path}.high`);
  if (low < 0 || low > 1) {
    throw new RangeError(`${path}.low: ${low} must be within [0, 1]`);
  }
  if (high < 0 || high > 1) {
    throw new RangeError(`${path}.high: ${high} must be within [0, 1]`);
  }
  if (low >= high) {
    throw new RangeError(`${path}.low: ${low} must be less than high ${high}`);
  }
  return Object.freeze({ low, high });
}

function captureVoltage(value: unknown, path: string): { turnOn: number; turnOff: number } {
  checkRecord(value, path, VOLTAGE_FIELDS);
  const turnOn = value.turnOn;
  const turnOff = value.turnOff;
  checkFinite(turnOn, `${path}.turnOn`);
  checkFinite(turnOff, `${path}.turnOff`);
  if (turnOff < 0) {
    throw new RangeError(`${path}.turnOff: ${turnOff} must be nonnegative`);
  }
  if (turnOn <= turnOff) {
    throw new RangeError(`${path}.turnOn: ${turnOn} must be greater than turnOff ${turnOff}`);
  }
  return Object.freeze({ turnOn, turnOff });
}

function resolveDeclaredPin(
  value: unknown,
  path: string,
  instanceId: string,
  declared: ReadonlyMap<string, { readonly ref: TopologyPinRef; readonly kind: PinKind }>,
  kind: PinKind,
): TopologyPinRef {
  checkIdentity(value, path);
  const key = pinKey(instanceId, value);
  const pin = declared.get(key);
  if (pin === undefined) {
    throw new RangeError(
      `${path}: ${JSON.stringify(value)} must reference a pin declared by instance ${JSON.stringify(instanceId)}`,
    );
  }
  if (pin.kind !== kind) {
    throw new RangeError(
      `${path}: pin ${JSON.stringify(value)} must have kind ${JSON.stringify(kind)}`,
    );
  }
  return pin.ref;
}

function captureDomains(
  deviceValue: Record<string, unknown>,
  path: string,
  instanceId: string,
  declared: ReadonlyMap<string, { readonly ref: TopologyPinRef; readonly kind: PinKind }>,
): readonly CapturedDomain[] {
  const rawDomains = deviceValue.powerDomains;
  const entries = captureEntries(rawDomains, `${path}.powerDomains`);
  const interim = new Map<string, InterimDomain>();
  for (const [domainId, declaration] of entries) {
    const domainPath = `${path}.powerDomains.${domainId}`;
    checkRecord(declaration, domainPath, DOMAIN_FIELDS);
    const supply = resolveDeclaredPin(
      declaration.supply,
      `${domainPath}.supply`,
      instanceId,
      declared,
      'power',
    );
    const ground = resolveDeclaredPin(
      declaration.ground,
      `${domainPath}.ground`,
      instanceId,
      declared,
      'gnd',
    );
    const { turnOn, turnOff } = captureVoltage(declaration.voltage, `${domainPath}.voltage`);
    let dependsOnIds: readonly string[] = Object.freeze([]);
    if ('dependsOn' in declaration) {
      const rawDependsOn = declaration.dependsOn;
      if (!Array.isArray(rawDependsOn)) {
        invalidType(`${domainPath}.dependsOn`, rawDependsOn, 'be an array');
      }
      const seen = new Set<string>();
      for (let index = 0; index < rawDependsOn.length; index += 1) {
        const dependency = rawDependsOn[index];
        checkIdentity(dependency, `${domainPath}.dependsOn[${index}]`);
        if (dependency === domainId) {
          throw new RangeError(`${domainPath}.dependsOn: domain must not depend on itself`);
        }
        if (seen.has(dependency)) {
          invalidType(
            `${domainPath}.dependsOn[${index}]`,
            dependency,
            'be unique within the dependency set',
          );
        }
        seen.add(dependency);
      }
      dependsOnIds = Object.freeze([...seen].sort(compareText));
    }
    interim.set(
      domainId,
      Object.freeze({
        instanceId,
        domainId,
        supply,
        ground,
        turnOn,
        turnOff,
        dependsOnIds,
      }),
    );
  }

  for (const [domainId, domain] of interim) {
    for (const dependency of domain.dependsOnIds) {
      if (!interim.has(dependency)) {
        throw new RangeError(
          `${path}.powerDomains.${domainId}.dependsOn: ${JSON.stringify(dependency)} must reference a domain declared by the same device`,
        );
      }
    }
  }

  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const [domainId, domain] of interim) {
    indegree.set(domainId, domain.dependsOnIds.length);
    for (const dependency of domain.dependsOnIds) {
      const list = dependents.get(dependency);
      if (list === undefined) dependents.set(dependency, [domainId]);
      else list.push(domainId);
    }
  }
  const ready = [...indegree.keys()].filter((domainId) => indegree.get(domainId) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort(compareText);
    const domainId = ready.shift() as string;
    order.push(domainId);
    for (const dependent of dependents.get(domainId) ?? []) {
      const next = (indegree.get(dependent) as number) - 1;
      indegree.set(dependent, next);
      if (next === 0) ready.push(dependent);
    }
  }
  if (order.length !== interim.size) {
    const remaining = [...interim.keys()].filter((domainId) => !order.includes(domainId));
    throw new RangeError(
      `${path}.powerDomains.dependsOn: dependency graph must be acyclic; cycle involves ${remaining
        .sort(compareText)
        .map((domainId) => JSON.stringify(domainId))
        .join(', ')}`,
    );
  }

  const domainsById = new Map<string, CapturedDomain>();
  const domains: CapturedDomain[] = [];
  for (const domainId of order) {
    const domain = interim.get(domainId) as InterimDomain;
    const dependsOn = Object.freeze(
      domain.dependsOnIds.map((dependency) => domainsById.get(dependency) as CapturedDomain),
    );
    let depth = 0;
    for (const dependency of dependsOn) depth = Math.max(depth, dependency.depth + 1);
    const captured = Object.freeze({
      instanceId: domain.instanceId,
      domainId: domain.domainId,
      key: domainKey(domain.instanceId, domain.domainId),
      supply: domain.supply,
      ground: domain.ground,
      turnOn: domain.turnOn,
      turnOff: domain.turnOff,
      dependsOn,
      depth,
    });
    domainsById.set(domainId, captured);
    domains.push(captured);
  }
  return Object.freeze(domains);
}

function capturePinBindings(
  deviceValue: Record<string, unknown>,
  path: string,
  instanceId: string,
  domainsById: ReadonlyMap<string, CapturedDomain>,
  declared: ReadonlyMap<string, { readonly ref: TopologyPinRef; readonly kind: PinKind }>,
): ReadonlyMap<
  string,
  { readonly domain: CapturedDomain; readonly levels: PowerLevels | undefined }
> {
  const result = new Map<
    string,
    { readonly domain: CapturedDomain; readonly levels: PowerLevels | undefined }
  >();
  if (!('pins' in deviceValue)) return result;
  const entries = captureEntries(deviceValue.pins, `${path}.pins`);
  for (const [pinName, binding] of entries) {
    const bindingPath = `${path}.pins.${pinName}`;
    checkRecord(binding, bindingPath, BINDING_FIELDS);
    const key = pinKey(instanceId, pinName);
    const pin = declared.get(key);
    if (pin === undefined) {
      throw new RangeError(
        `${bindingPath}: ${JSON.stringify(pinName)} must reference a pin declared by instance ${JSON.stringify(instanceId)}`,
      );
    }
    if (pin.kind !== 'signal') {
      throw new RangeError(`${bindingPath}: powerDomain is only supported on kind 'signal' pins`);
    }
    let domain: CapturedDomain | undefined;
    if ('powerDomain' in binding) {
      const domainId = binding.powerDomain;
      checkIdentity(domainId, `${bindingPath}.powerDomain`);
      domain = domainsById.get(domainId);
      if (domain === undefined) {
        throw new RangeError(
          `${bindingPath}.powerDomain: ${JSON.stringify(domainId)} must reference a domain declared by the same device`,
        );
      }
    }
    let levels: PowerLevels | undefined;
    if ('levels' in binding) {
      if (domain === undefined) {
        throw new RangeError(`${bindingPath}.levels requires a powerDomain binding`);
      }
      levels = captureLevels(binding.levels, `${bindingPath}.levels`);
    }
    if (domain !== undefined) result.set(key, Object.freeze({ domain, levels }));
  }
  return result;
}

export function capturePowerDefinition(value: unknown): CapturedPowerDefinition {
  checkRecord(value, 'definition', DEFINITION_FIELDS);
  const topology = captureTopologyDefinition(value.topology);
  const declared = new Map<string, { readonly ref: TopologyPinRef; readonly kind: PinKind }>();
  const instances = new Set<string>();
  for (const pin of topology.pins) {
    const ref = Object.freeze({ instanceId: pin.instanceId, pinName: pin.pinName });
    declared.set(pinKey(pin.instanceId, pin.pinName), Object.freeze({ ref, kind: pin.kind }));
    instances.add(pin.instanceId);
  }

  const rawDevices = value.devices;
  if (!Array.isArray(rawDevices)) invalidType('definition.devices', rawDevices, 'be an array');
  const devices: CapturedDevice[] = [];
  const devicesById = new Map<string, CapturedDevice>();
  const bindingsByKey = new Map<
    string,
    { readonly domain: CapturedDomain; readonly levels: PowerLevels | undefined }
  >();
  for (let index = 0; index < rawDevices.length; index += 1) {
    const path = `definition.devices[${index}]`;
    const deviceValue = rawDevices[index];
    checkRecord(deviceValue, path, DEVICE_FIELDS);
    const instanceId = deviceValue.instanceId;
    checkIdentity(instanceId, `${path}.instanceId`);
    if (devicesById.has(instanceId)) {
      invalidType(`${path}.instanceId`, instanceId, 'be unique among power device definitions');
    }
    if (!instances.has(instanceId)) {
      throw new RangeError(
        `${path}.instanceId: ${JSON.stringify(instanceId)} must reference a declared topology instance`,
      );
    }
    const domains = captureDomains(deviceValue, path, instanceId, declared);
    const domainsById = new Map(domains.map((domain) => [domain.domainId, domain] as const));
    const device = Object.freeze({ instanceId, domains, domainsById });
    devices.push(device);
    devicesById.set(instanceId, device);
    const bindings = capturePinBindings(deviceValue, path, instanceId, domainsById, declared);
    for (const [key, binding] of bindings) bindingsByKey.set(key, binding);
  }
  devices.sort((left, right) => compareText(left.instanceId, right.instanceId));

  const domainsInOrder: CapturedDomain[] = [];
  for (const device of devices) domainsInOrder.push(...device.domains);
  const domainsByKey = new Map(domainsInOrder.map((domain) => [domain.key, domain] as const));

  const pins: CapturedPin[] = [];
  for (const [key, pin] of declared) {
    const binding = bindingsByKey.get(key);
    pins.push(
      Object.freeze({
        ref: pin.ref,
        key,
        kind: pin.kind,
        domain: binding?.domain,
        levels: binding?.levels,
      }),
    );
  }
  pins.sort((left, right) => compareRefs(left.ref, right.ref));
  const pinsByKey = new Map(pins.map((pin) => [pin.key, pin] as const));

  return Object.freeze({
    topology,
    devices: Object.freeze(devices),
    devicesById,
    domainsInOrder: Object.freeze(domainsInOrder),
    domainsByKey,
    pins: Object.freeze(pins),
    pinsByKey,
    instances,
  });
}

export function captureObserver(value: unknown, path: string): CapturedObserver {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    invalidType(path, value, 'be an object');
  }
  const notify = Reflect.get(value, 'onPowerDomainChange');
  if (typeof notify !== 'function') {
    invalidType(`${path}.onPowerDomainChange`, notify, 'be a function');
  }
  return Object.freeze({
    receiver: value as PowerDomainObserver,
    notify: notify as PowerDomainObserver['onPowerDomainChange'],
  });
}

function captureLimit(value: unknown, fallback: number, path: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalidType(path, value, 'be a finite number');
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${path}: ${value} must be a non-negative safe integer`);
  }
  return value;
}

export function capturePowerOptions(
  value: unknown,
  definition: CapturedPowerDefinition,
): CapturedPowerOptions {
  checkRecord(value, 'options', OPTION_FIELDS);
  const instanceId = value.instanceId;
  checkIdentity(instanceId, 'options.instanceId');
  let topologyInstanceId = `${instanceId}:topology`;
  if ('topologyInstanceId' in value) {
    const candidate = value.topologyInstanceId;
    checkIdentity(candidate, 'options.topologyInstanceId');
    topologyInstanceId = candidate;
  }
  if (topologyInstanceId === instanceId) {
    throw new RangeError('options.topologyInstanceId must differ from options.instanceId');
  }

  const rawStates = value.pinStates;
  if (!Array.isArray(rawStates)) invalidType('options.pinStates', rawStates, 'be an array');
  const intents = new Map<string, ElectricalPinInput>();
  for (let index = 0; index < rawStates.length; index += 1) {
    const path = `options.pinStates[${index}]`;
    const state = snapshotElectricalPin(rawStates[index], path);
    const key = pinKey(state.instanceId, state.pinName);
    if (!definition.pinsByKey.has(key)) {
      throw new RangeError(
        `${path}: (${JSON.stringify(state.instanceId)}, ${JSON.stringify(state.pinName)}) must reference a declared pin`,
      );
    }
    if (intents.has(key)) {
      invalidType(
        `${path}.pinName`,
        state.pinName,
        `be unique within instance ${JSON.stringify(state.instanceId)}`,
      );
    }
    intents.set(key, state);
  }
  const initialStates: ElectricalPinInput[] = [];
  for (const pin of definition.pins) {
    const intent = intents.get(pin.key);
    if (intent === undefined) {
      throw new RangeError(
        `options.pinStates: missing state for (${JSON.stringify(pin.ref.instanceId)}, ${JSON.stringify(pin.ref.pinName)})`,
      );
    }
    initialStates.push(
      pin.domain === undefined ? intent : Object.freeze({ ...intent, powerReady: false }),
    );
  }

  let floating: PowerFloatingOptions | undefined;
  if ('floating' in value) {
    const rawFloating = value.floating;
    checkRecord(rawFloating, 'options.floating', FLOATING_FIELDS);
    const seed = rawFloating.seed;
    checkInteger(seed, 0, 0xffffffff, 'options.floating.seed');
    floating = Object.freeze({ seed: seed as number });
  }

  let inputMode: PowerInputMode = 'three-state';
  if ('inputMode' in value) {
    inputMode = checkChoice(value.inputMode, INPUT_MODES, 'options.inputMode');
  }
  const maxPropagationRounds = captureLimit(
    value.maxPropagationRounds,
    DEFAULT_MAX_PROPAGATION_ROUNDS,
    'options.maxPropagationRounds',
  );
  let observer: CapturedObserver | undefined;
  if ('observer' in value) {
    observer = captureObserver(value.observer, 'options.observer');
  }

  return Object.freeze({
    instanceId,
    topologyInstanceId,
    intents,
    initialStates: Object.freeze(initialStates),
    floating,
    inputMode,
    maxPropagationRounds,
    observer,
  });
}
