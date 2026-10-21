import type {
  ElectricalNetworkResult,
  ElectricalPinInput,
  FloatingInput,
} from '../electrical/electrical-types';
import { resolveElectricalNetwork, snapshotElectricalPin } from '../electrical/electrical';
import {
  checkBoolean,
  checkChoice,
  checkIdentity,
  checkInteger,
  checkRecord,
  invalidType,
} from '../electrical/electrical-validation';
import { createFloatingInput } from '../electrical/floating-input';
import type { Scheduler, SchedulerInstance, SchedulerTarget } from '../scheduler/scheduler-types';
import type {
  ConnectionState,
  TopologyConnectionPatch,
  TopologyDefinition,
  TopologyNetwork,
  TopologyOptions,
  TopologyPinRef,
  TopologyRuntime,
} from './topology-types';

const PIN_KINDS = ['signal', 'power', 'gnd'] as const;
const CONNECTION_STATES = ['open', 'closed'] as const;

interface CapturedPin {
  readonly instanceId: string;
  readonly pinName: string;
  readonly kind: TopologyPinDeclarationKind;
  readonly key: string;
  readonly ref: TopologyPinRef;
}

type TopologyPinDeclarationKind = (typeof PIN_KINDS)[number];

interface CapturedWire {
  readonly wireId: string;
  readonly pins: readonly CapturedPin[];
  readonly globalGnd: boolean;
}

interface CapturedConnection {
  readonly instanceId: string;
  readonly connectionId: string;
  readonly pinA: CapturedPin;
  readonly pinB: CapturedPin;
  readonly initial: ConnectionState;
  readonly key: string;
}

interface CapturedDefinition {
  readonly pins: readonly CapturedPin[];
  readonly pinsByKey: ReadonlyMap<string, CapturedPin>;
  readonly instances: ReadonlySet<string>;
  readonly wires: readonly CapturedWire[];
  readonly connections: readonly CapturedConnection[];
  readonly connectionsByKey: ReadonlyMap<string, CapturedConnection>;
}

interface CapturedFloating {
  readonly seed: number;
  readonly supplyVoltage: (pin: TopologyPinRef) => number | undefined;
  readonly samplingEnabled: (pin: TopologyPinRef) => boolean;
}

interface CapturedPinState {
  readonly key: string;
  readonly state: ElectricalPinInput;
}

interface CapturedPatch {
  readonly instanceId: string;
  readonly entries: readonly { readonly key: string; readonly state: ConnectionState }[];
}

type Command =
  | { readonly kind: 'patch'; readonly patch: CapturedPatch }
  | { readonly kind: 'pins'; readonly updates: readonly CapturedPinState[] }
  | { readonly kind: 'refresh'; readonly pins: readonly CapturedPin[] | undefined };

interface Component {
  readonly networkId: string;
  readonly pins: readonly CapturedPin[];
  readonly groundReady: boolean;
}

interface FloatingTrack {
  readonly input: FloatingInput;
  physical: 'unknown' | 'driven' | 'floating';
  pendingInitialization: boolean;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePins(left: TopologyPinRef, right: TopologyPinRef): number {
  return compareText(left.instanceId, right.instanceId) || compareText(left.pinName, right.pinName);
}

function pinKey(instanceId: string, pinName: string): string {
  return JSON.stringify([instanceId, pinName]);
}

function connectionKey(instanceId: string, connectionId: string): string {
  return JSON.stringify([instanceId, connectionId]);
}

/**
 * Escapes the two characters that carry structure in a network ID. Unlike
 * `encodeURIComponent`, this accepts every JavaScript string, including lone surrogates.
 */
function escapeNetworkIdentity(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('/', '%2F');
}

function capturePinReference(
  value: unknown,
  path: string,
  pinsByKey: ReadonlyMap<string, CapturedPin>,
): CapturedPin {
  checkRecord(value, path, ['instanceId', 'pinName']);
  const instanceId = value.instanceId;
  const pinName = value.pinName;
  checkIdentity(instanceId, `${path}.instanceId`);
  checkIdentity(pinName, `${path}.pinName`);
  const declared = pinsByKey.get(pinKey(instanceId, pinName));
  if (declared === undefined) {
    throw new RangeError(
      `${path}: (${JSON.stringify(instanceId)}, ${JSON.stringify(pinName)}) must reference a declared pin`,
    );
  }
  return declared;
}

function captureDefinition(value: unknown): CapturedDefinition {
  checkRecord(value, 'definition', ['pins', 'wires', 'connections']);
  const rawPins = value.pins;
  if (!Array.isArray(rawPins)) invalidType('definition.pins', rawPins, 'be an array');
  const pins: CapturedPin[] = [];
  const pinsByKey = new Map<string, CapturedPin>();
  const instances = new Set<string>();
  for (let index = 0; index < rawPins.length; index += 1) {
    const path = `definition.pins[${index}]`;
    const entry = rawPins[index];
    checkRecord(entry, path, ['instanceId', 'pinName', 'kind']);
    const instanceId = entry.instanceId;
    const pinName = entry.pinName;
    checkIdentity(instanceId, `${path}.instanceId`);
    checkIdentity(pinName, `${path}.pinName`);
    const kind = checkChoice(entry.kind, PIN_KINDS, `${path}.kind`);
    const key = pinKey(instanceId, pinName);
    if (pinsByKey.has(key)) {
      invalidType(
        `${path}.pinName`,
        pinName,
        `be unique for instance ${JSON.stringify(instanceId)}`,
      );
    }
    const ref = Object.freeze({ instanceId, pinName });
    const pin = Object.freeze({ instanceId, pinName, kind, key, ref });
    pinsByKey.set(key, pin);
    pins.push(pin);
    instances.add(instanceId);
  }

  const rawWires = value.wires;
  if (!Array.isArray(rawWires)) invalidType('definition.wires', rawWires, 'be an array');
  const wires: CapturedWire[] = [];
  const wireIds = new Set<string>();
  for (let index = 0; index < rawWires.length; index += 1) {
    const path = `definition.wires[${index}]`;
    const entry = rawWires[index];
    checkRecord(entry, path, ['wireId', 'pins', 'globalGnd']);
    const wireId = entry.wireId;
    checkIdentity(wireId, `${path}.wireId`);
    if (wireIds.has(wireId)) {
      invalidType(`${path}.wireId`, wireId, 'be unique among external wires');
    }
    wireIds.add(wireId);
    const rawWirePins = entry.pins;
    if (!Array.isArray(rawWirePins)) {
      invalidType(`${path}.pins`, rawWirePins, 'be an array');
    }
    if (rawWirePins.length === 0) {
      throw new RangeError(`${path}.pins: expected at least one pin`);
    }
    const wirePins: CapturedPin[] = [];
    const wirePinKeys = new Set<string>();
    for (let pinIndex = 0; pinIndex < rawWirePins.length; pinIndex += 1) {
      const pin = capturePinReference(
        rawWirePins[pinIndex],
        `${path}.pins[${pinIndex}]`,
        pinsByKey,
      );
      if (wirePinKeys.has(pin.key)) {
        invalidType(
          `${path}.pins[${pinIndex}].pinName`,
          pin.pinName,
          `be unique within wire ${JSON.stringify(wireId)}`,
        );
      }
      wirePinKeys.add(pin.key);
      wirePins.push(pin);
    }
    let globalGnd = false;
    if ('globalGnd' in entry) {
      checkBoolean(entry.globalGnd, `${path}.globalGnd`);
      globalGnd = entry.globalGnd;
    }
    wires.push(Object.freeze({ wireId, pins: Object.freeze(wirePins), globalGnd }));
  }

  const rawConnections = value.connections;
  if (!Array.isArray(rawConnections)) {
    invalidType('definition.connections', rawConnections, 'be an array');
  }
  const connections: CapturedConnection[] = [];
  const connectionsByKey = new Map<string, CapturedConnection>();
  for (let index = 0; index < rawConnections.length; index += 1) {
    const path = `definition.connections[${index}]`;
    const entry = rawConnections[index];
    checkRecord(entry, path, ['instanceId', 'connectionId', 'pins', 'initial']);
    const instanceId = entry.instanceId;
    const connectionId = entry.connectionId;
    checkIdentity(instanceId, `${path}.instanceId`);
    checkIdentity(connectionId, `${path}.connectionId`);
    if (!instances.has(instanceId)) {
      throw new RangeError(
        `${path}.instanceId: ${JSON.stringify(instanceId)} must reference a declared instance`,
      );
    }
    const key = connectionKey(instanceId, connectionId);
    if (connectionsByKey.has(key)) {
      invalidType(
        `${path}.connectionId`,
        connectionId,
        `be unique for instance ${JSON.stringify(instanceId)}`,
      );
    }
    const rawEndpoints = entry.pins;
    if (!Array.isArray(rawEndpoints) || rawEndpoints.length !== 2) {
      invalidType(`${path}.pins`, rawEndpoints, 'be an array of exactly two pin names');
    }
    const first = rawEndpoints[0];
    const second = rawEndpoints[1];
    checkIdentity(first, `${path}.pins[0]`);
    checkIdentity(second, `${path}.pins[1]`);
    if (first === second) {
      invalidType(`${path}.pins[1]`, second, `differ from ${JSON.stringify(first)}`);
    }
    const pinA = pinsByKey.get(pinKey(instanceId, first));
    if (pinA === undefined) {
      throw new RangeError(
        `${path}.pins[0]: ${JSON.stringify(first)} must reference a pin declared by instance ${JSON.stringify(instanceId)}`,
      );
    }
    const pinB = pinsByKey.get(pinKey(instanceId, second));
    if (pinB === undefined) {
      throw new RangeError(
        `${path}.pins[1]: ${JSON.stringify(second)} must reference a pin declared by instance ${JSON.stringify(instanceId)}`,
      );
    }
    let initial: ConnectionState = 'open';
    if ('initial' in entry) {
      initial = checkChoice(entry.initial, CONNECTION_STATES, `${path}.initial`);
    }
    const connection = Object.freeze({
      instanceId,
      connectionId,
      pinA,
      pinB,
      initial,
      key,
    });
    connectionsByKey.set(key, connection);
    connections.push(connection);
  }
  connections.sort(
    (left, right) =>
      compareText(left.instanceId, right.instanceId) ||
      compareText(left.connectionId, right.connectionId),
  );

  return Object.freeze({
    pins: Object.freeze(pins),
    pinsByKey,
    instances,
    wires: Object.freeze(wires),
    connections: Object.freeze(connections),
    connectionsByKey,
  });
}

function capturePatch(value: unknown, definition: CapturedDefinition): CapturedPatch {
  checkRecord(value, 'patch', ['instanceId', 'connections']);
  const instanceId = value.instanceId;
  checkIdentity(instanceId, 'patch.instanceId');
  if (!definition.instances.has(instanceId)) {
    throw new RangeError(
      `patch.instanceId: ${JSON.stringify(instanceId)} must reference a declared instance`,
    );
  }
  const rawConnections = value.connections;
  if (!Array.isArray(rawConnections)) {
    invalidType('patch.connections', rawConnections, 'be an array');
  }
  if (rawConnections.length === 0) {
    throw new RangeError('patch.connections: expected at least one connection update');
  }
  const seen = new Set<string>();
  const entries: { readonly key: string; readonly state: ConnectionState }[] = [];
  for (let index = 0; index < rawConnections.length; index += 1) {
    const path = `patch.connections[${index}]`;
    const entry = rawConnections[index];
    checkRecord(entry, path, ['connectionId', 'state']);
    const connectionId = entry.connectionId;
    checkIdentity(connectionId, `${path}.connectionId`);
    const state = checkChoice(entry.state, CONNECTION_STATES, `${path}.state`);
    const key = connectionKey(instanceId, connectionId);
    if (!definition.connectionsByKey.has(key)) {
      throw new RangeError(
        `${path}.connectionId: ${JSON.stringify(connectionId)} must reference a connection declared by instance ${JSON.stringify(instanceId)}`,
      );
    }
    if (seen.has(key)) {
      invalidType(
        `${path}.connectionId`,
        connectionId,
        `be unique within patch for instance ${JSON.stringify(instanceId)}`,
      );
    }
    seen.add(key);
    entries.push(Object.freeze({ key, state }));
  }
  return Object.freeze({ instanceId, entries: Object.freeze(entries) });
}

function capturePinState(
  value: unknown,
  path: string,
  definition: CapturedDefinition,
): CapturedPinState {
  const state = snapshotElectricalPin(value, path);
  const key = pinKey(state.instanceId, state.pinName);
  if (!definition.pinsByKey.has(key)) {
    throw new RangeError(
      `${path}: (${JSON.stringify(state.instanceId)}, ${JSON.stringify(state.pinName)}) must reference a declared pin`,
    );
  }
  return Object.freeze({ key, state });
}

function captureFloating(options: Record<string, unknown>): CapturedFloating | undefined {
  if (!('floating' in options)) return undefined;
  const value = options.floating;
  checkRecord(value, 'options.floating', ['seed', 'supplyVoltage', 'samplingEnabled']);
  const seed = value.seed;
  checkInteger(seed, 0, 0xffffffff, 'options.floating.seed');
  const supplyVoltage = value.supplyVoltage;
  if (typeof supplyVoltage !== 'function') {
    invalidType('options.floating.supplyVoltage', supplyVoltage, 'be a function');
  }
  let samplingEnabled: (pin: TopologyPinRef) => boolean = () => true;
  if ('samplingEnabled' in value) {
    const candidate = value.samplingEnabled;
    if (typeof candidate !== 'function') {
      invalidType('options.floating.samplingEnabled', candidate, 'be a function');
    }
    samplingEnabled = candidate as (pin: TopologyPinRef) => boolean;
  }
  return Object.freeze({
    seed: seed as number,
    supplyVoltage: supplyVoltage as (pin: TopologyPinRef) => number | undefined,
    samplingEnabled,
  });
}

function initialConnectionStates(definition: CapturedDefinition): Map<string, ConnectionState> {
  const states = new Map<string, ConnectionState>();
  for (const connection of definition.connections) {
    states.set(connection.key, connection.initial);
  }
  return states;
}

function buildComponents(
  definition: CapturedDefinition,
  connectionStates: ReadonlyMap<string, ConnectionState>,
): readonly Component[] {
  const orderedPins = [...definition.pins].sort(comparePins);
  const indices = new Map<string, number>();
  orderedPins.forEach((pin, index) => indices.set(pin.key, index));
  const parent = orderedPins.map((_, index) => index);

  const find = (node: number): number => {
    let root = node;
    while (parent[root] !== root) {
      const next = parent[root] as number;
      parent[root] = parent[next] as number;
      root = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };

  for (const wire of definition.wires) {
    const first = wire.pins[0];
    if (first === undefined) continue;
    const firstIndex = indices.get(first.key);
    if (firstIndex === undefined) continue;
    for (let index = 1; index < wire.pins.length; index += 1) {
      const pin = wire.pins[index];
      const pinIndex = pin === undefined ? undefined : indices.get(pin.key);
      if (pinIndex !== undefined) union(firstIndex, pinIndex);
    }
  }
  for (const connection of definition.connections) {
    if (connectionStates.get(connection.key) !== 'closed') continue;
    const left = indices.get(connection.pinA.key);
    const right = indices.get(connection.pinB.key);
    if (left !== undefined && right !== undefined) union(left, right);
  }

  const groups = new Map<number, CapturedPin[]>();
  for (const pin of orderedPins) {
    const index = indices.get(pin.key);
    if (index === undefined) continue;
    const root = find(index);
    const group = groups.get(root);
    if (group === undefined) groups.set(root, [pin]);
    else group.push(pin);
  }

  const groundedRoots = new Set<number>();
  for (const wire of definition.wires) {
    if (!wire.globalGnd) continue;
    const first = wire.pins[0];
    const firstIndex = first === undefined ? undefined : indices.get(first.key);
    if (firstIndex !== undefined) groundedRoots.add(find(firstIndex));
  }

  const components: Component[] = [];
  for (const [root, pins] of groups) {
    const canonical = pins[0];
    if (canonical === undefined) continue;
    components.push(
      Object.freeze({
        networkId: `net:${escapeNetworkIdentity(canonical.instanceId)}/${escapeNetworkIdentity(canonical.pinName)}`,
        pins: Object.freeze(pins),
        groundReady: pins.some((pin) => pin.kind === 'gnd') && groundedRoots.has(root),
      }),
    );
  }
  components.sort((left, right) => compareText(left.networkId, right.networkId));
  return Object.freeze(components);
}

function indexComponents(components: readonly Component[]): Map<string, Component> {
  const byPin = new Map<string, Component>();
  for (const component of components) {
    for (const pin of component.pins) byPin.set(pin.key, component);
  }
  return byPin;
}

function resolveComponent(
  component: Component,
  pinStates: ReadonlyMap<string, ElectricalPinInput>,
): ElectricalNetworkResult {
  const pins = component.pins.map((pin) => {
    const state = pinStates.get(pin.key);
    if (state === undefined) {
      throw new Error(
        `Invariant: missing committed pin state for (${pin.instanceId}, ${pin.pinName})`,
      );
    }
    return state;
  });
  return resolveElectricalNetwork({ networkId: component.networkId, pins });
}

function readySupply(options: CapturedFloating, pin: TopologyPinRef): number | undefined {
  if (!options.samplingEnabled(pin)) return undefined;
  return options.supplyVoltage(pin);
}

class TopologyRuntimeImpl implements TopologyRuntime {
  readonly #scheduler: Scheduler;
  readonly #definition: CapturedDefinition;
  readonly #floatingOptions: CapturedFloating | undefined;
  readonly #target: SchedulerTarget;
  readonly #instance: SchedulerInstance;
  #connectionStates: Map<string, ConnectionState>;
  #pinStates: Map<string, ElectricalPinInput>;
  #components: readonly Component[];
  #componentByPin: Map<string, Component>;
  #results: Map<string, ElectricalNetworkResult>;
  readonly #floating = new Map<string, FloatingTrack>();
  readonly #commands: Command[] = [];
  #destroyed = false;

  constructor(
    scheduler: Scheduler,
    definitionInput: TopologyDefinition,
    optionsInput: TopologyOptions,
  ) {
    const definition = captureDefinition(definitionInput);
    checkRecord(optionsInput, 'options', ['instanceId', 'pinStates', 'floating']);
    const instanceId = optionsInput.instanceId;
    checkIdentity(instanceId, 'options.instanceId');
    const rawPinStates = optionsInput.pinStates;
    if (!Array.isArray(rawPinStates)) {
      invalidType('options.pinStates', rawPinStates, 'be an array');
    }
    const pinStates = new Map<string, ElectricalPinInput>();
    for (let index = 0; index < rawPinStates.length; index += 1) {
      const path = `options.pinStates[${index}]`;
      const captured = capturePinState(rawPinStates[index], path, definition);
      if (pinStates.has(captured.key)) {
        invalidType(
          `${path}.pinName`,
          captured.state.pinName,
          'be unique among initial pin states',
        );
      }
      pinStates.set(captured.key, captured.state);
    }
    for (const pin of definition.pins) {
      if (!pinStates.has(pin.key)) {
        throw new RangeError(
          `options.pinStates: missing state for (${JSON.stringify(pin.instanceId)}, ${JSON.stringify(pin.pinName)})`,
        );
      }
    }
    const floatingOptions = captureFloating(optionsInput as Record<string, unknown>);

    const connectionStates = initialConnectionStates(definition);
    const components = buildComponents(definition, connectionStates);
    const results = new Map<string, ElectricalNetworkResult>();
    for (const component of components) {
      results.set(component.networkId, resolveComponent(component, pinStates));
    }

    this.#scheduler = scheduler;
    this.#definition = definition;
    this.#floatingOptions = floatingOptions;
    this.#connectionStates = connectionStates;
    this.#pinStates = pinStates;
    this.#components = components;
    this.#componentByPin = indexComponents(components);
    this.#results = results;
    this.#updateFloating(components, results);
    this.#target = Object.freeze({
      name: 'topology.commit',
      kind: 'control',
      params: Object.freeze([]),
    });
    this.#instance = scheduler.addInstance({
      instanceId,
      targets: [this.#target],
      executor: { execute: () => this.#runNextCommand() },
    });
    Object.freeze(this);
  }

  get instance(): SchedulerInstance {
    return this.#instance;
  }

  submit(patch: TopologyConnectionPatch): void {
    this.#enqueue({ kind: 'patch', patch: capturePatch(patch, this.#definition) });
  }

  updatePinStates(states: readonly ElectricalPinInput[]): void {
    if (!Array.isArray(states)) invalidType('states', states, 'be an array');
    if (states.length === 0) return;
    const updates: CapturedPinState[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < states.length; index += 1) {
      const captured = capturePinState(states[index], `states[${index}]`, this.#definition);
      if (seen.has(captured.key)) {
        invalidType(
          `states[${index}].pinName`,
          captured.state.pinName,
          'be unique within one pin-state update',
        );
      }
      seen.add(captured.key);
      updates.push(captured);
    }
    this.#enqueue({ kind: 'pins', updates: Object.freeze(updates) });
  }

  refresh(pins?: readonly TopologyPinRef[]): void {
    if (pins === undefined) {
      this.#enqueue({ kind: 'refresh', pins: undefined });
      return;
    }
    if (!Array.isArray(pins)) invalidType('pins', pins, 'be an array');
    if (pins.length === 0) return;
    const captured: CapturedPin[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < pins.length; index += 1) {
      const pin = capturePinReference(pins[index], `pins[${index}]`, this.#definition.pinsByKey);
      if (seen.has(pin.key)) continue;
      seen.add(pin.key);
      captured.push(pin);
    }
    this.#enqueue({ kind: 'refresh', pins: Object.freeze(captured) });
  }

  connectionState(instanceId: string, connectionId: string): ConnectionState {
    checkIdentity(instanceId, 'instanceId');
    checkIdentity(connectionId, 'connectionId');
    const state = this.#connectionStates.get(connectionKey(instanceId, connectionId));
    if (state === undefined) {
      throw new RangeError(
        `(${JSON.stringify(instanceId)}, ${JSON.stringify(connectionId)}) must reference a declared connection`,
      );
    }
    return state;
  }

  networks(): readonly TopologyNetwork[] {
    return Object.freeze(this.#components.map((component) => this.#snapshot(component)));
  }

  networkOf(pin: TopologyPinRef): TopologyNetwork | undefined {
    const captured = capturePinReference(pin, 'pin', this.#definition.pinsByKey);
    const component = this.#componentByPin.get(captured.key);
    return component === undefined ? undefined : this.#snapshot(component);
  }

  floatingInput(pin: TopologyPinRef): FloatingInput | undefined {
    const captured = capturePinReference(pin, 'pin', this.#definition.pinsByKey);
    if (this.#floatingOptions === undefined) return undefined;
    return this.#track(captured).input;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#commands.length = 0;
    this.#scheduler.destroyInstance(this.#instance);
  }

  #enqueue(command: Command): void {
    this.#commands.push(command);
    try {
      this.#scheduler.enqueueControl(this.#instance, this.#target, []);
    } catch (cause) {
      this.#commands.pop();
      throw cause;
    }
  }

  #runNextCommand(): void {
    const command = this.#commands.shift();
    if (command === undefined) {
      throw new Error('Topology control entry has no pending command');
    }
    switch (command.kind) {
      case 'patch':
        this.#applyPatch(command.patch);
        return;
      case 'pins':
        this.#applyPinStates(command.updates);
        return;
      case 'refresh':
        this.#applyRefresh(command.pins);
        return;
    }
  }

  #applyPatch(patch: CapturedPatch): void {
    let nextStates: Map<string, ConnectionState> | undefined;
    const changed = new Set<string>();
    for (const entry of patch.entries) {
      const current = this.#connectionStates.get(entry.key);
      if (current === undefined) {
        throw new Error('Invariant: patch references an unknown connection state');
      }
      if (current === entry.state) continue;
      if (nextStates === undefined) nextStates = new Map(this.#connectionStates);
      nextStates.set(entry.key, entry.state);
      const connection = this.#definition.connectionsByKey.get(entry.key);
      if (connection === undefined) {
        throw new Error('Invariant: patch references an unknown connection declaration');
      }
      changed.add(connection.pinA.key);
      changed.add(connection.pinB.key);
    }
    if (nextStates === undefined) return;

    const nextComponents = buildComponents(this.#definition, nextStates);
    const nextByPin = indexComponents(nextComponents);
    const affected = new Set<string>();
    for (const key of changed) {
      const before = this.#componentByPin.get(key);
      const after = nextByPin.get(key);
      if (before !== undefined) affected.add(before.networkId);
      if (after !== undefined) affected.add(after.networkId);
    }
    const targets = nextComponents.filter((component) => affected.has(component.networkId));

    let nextResults: Map<string, ElectricalNetworkResult>;
    try {
      nextResults = this.#resolve(targets, this.#pinStates);
    } catch (cause) {
      // The committed topology survives the failed electrical resolution.
      this.#connectionStates = nextStates;
      this.#components = nextComponents;
      this.#componentByPin = nextByPin;
      this.#pruneResults(nextComponents);
      this.#clearResults(targets);
      throw cause;
    }
    this.#connectionStates = nextStates;
    this.#components = nextComponents;
    this.#componentByPin = nextByPin;
    this.#pruneResults(nextComponents);
    for (const [networkId, result] of nextResults) this.#results.set(networkId, result);
    this.#updateFloating(targets, nextResults);
  }

  #applyPinStates(updates: readonly CapturedPinState[]): void {
    const nextStates = new Map(this.#pinStates);
    const updated = new Set<string>();
    for (const update of updates) {
      nextStates.set(update.key, update.state);
      updated.add(update.key);
    }
    const targets = this.#components.filter((component) =>
      component.pins.some((pin) => updated.has(pin.key)),
    );
    let nextResults: Map<string, ElectricalNetworkResult>;
    try {
      nextResults = this.#resolve(targets, nextStates);
    } catch (cause) {
      this.#pinStates = nextStates;
      this.#clearResults(targets);
      throw cause;
    }
    this.#pinStates = nextStates;
    for (const [networkId, result] of nextResults) this.#results.set(networkId, result);
    this.#updateFloating(targets, nextResults);
  }

  #applyRefresh(pins: readonly CapturedPin[] | undefined): void {
    let targets: readonly Component[];
    if (pins === undefined) {
      targets = this.#components;
    } else {
      const keys = new Set(pins.map((pin) => pin.key));
      targets = this.#components.filter((component) =>
        component.pins.some((pin) => keys.has(pin.key)),
      );
    }
    let nextResults: Map<string, ElectricalNetworkResult>;
    try {
      nextResults = this.#resolve(targets, this.#pinStates);
    } catch (cause) {
      this.#clearResults(targets);
      throw cause;
    }
    for (const [networkId, result] of nextResults) this.#results.set(networkId, result);
    this.#updateFloating(targets, nextResults);
  }

  #resolve(
    targets: readonly Component[],
    pinStates: ReadonlyMap<string, ElectricalPinInput>,
  ): Map<string, ElectricalNetworkResult> {
    const results = new Map<string, ElectricalNetworkResult>();
    for (const component of targets) {
      results.set(component.networkId, resolveComponent(component, pinStates));
    }
    return results;
  }

  #clearResults(targets: readonly Component[]): void {
    for (const component of targets) this.#results.delete(component.networkId);
  }

  #pruneResults(components: readonly Component[]): void {
    const ids = new Set(components.map((component) => component.networkId));
    for (const networkId of [...this.#results.keys()]) {
      if (!ids.has(networkId)) this.#results.delete(networkId);
    }
  }

  #updateFloating(
    targets: readonly Component[],
    results: ReadonlyMap<string, ElectricalNetworkResult>,
  ): void {
    const options = this.#floatingOptions;
    if (options === undefined) return;
    const now = this.#scheduler.now;
    for (const component of targets) {
      const result = results.get(component.networkId);
      if (result === undefined) continue;
      const floating = result.state === 'floating';
      for (const pin of component.pins) {
        const track = this.#track(pin);
        if (!floating) {
          track.physical = 'driven';
          track.pendingInitialization = false;
          continue;
        }
        if (track.physical !== 'floating') {
          const supply = readySupply(options, pin.ref);
          if (supply === undefined) {
            track.input.beginFloating();
            track.pendingInitialization = true;
          } else {
            track.input.beginFloating(supply);
            track.pendingInitialization = false;
          }
          track.physical = 'floating';
        } else if (track.pendingInitialization) {
          const supply = readySupply(options, pin.ref);
          if (supply !== undefined) {
            // The recovery resolution point initializes V0; the value itself is not an observation.
            track.input.sample(supply, now, true);
            track.pendingInitialization = false;
          }
        }
      }
    }
  }

  #track(pin: CapturedPin): FloatingTrack {
    let track = this.#floating.get(pin.key);
    if (track === undefined) {
      const options = this.#floatingOptions;
      if (options === undefined) {
        throw new Error('Invariant: floating track requested without floating options');
      }
      track = {
        input: createFloatingInput(options.seed, pin.instanceId, pin.pinName),
        physical: 'unknown',
        pendingInitialization: false,
      };
      this.#floating.set(pin.key, track);
    }
    return track;
  }

  #snapshot(component: Component): TopologyNetwork {
    return Object.freeze({
      networkId: component.networkId,
      pins: Object.freeze(component.pins.map((pin) => pin.ref)),
      groundReady: component.groundReady,
      result: this.#results.get(component.networkId),
    });
  }
}

export function createTopologyRuntime(
  scheduler: Scheduler,
  definition: TopologyDefinition,
  options: TopologyOptions,
): TopologyRuntime {
  return new TopologyRuntimeImpl(scheduler, definition, options);
}
