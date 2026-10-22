import type { ElectricalPinInput, FloatingInput } from '../electrical/electrical-types';
import { snapshotElectricalPin } from '../electrical/electrical';
import { checkIdentity, checkRecord, invalidType } from '../electrical/electrical-validation';
import type { Scheduler, SchedulerInstance, SchedulerTarget } from '../scheduler/scheduler-types';
import type { TimePs } from '../scheduler/time';
import { createTopologyRuntime } from '../topology/topology';
import type {
  ConnectionState,
  TopologyConnectionPatch,
  TopologyNetwork,
  TopologyPinRef,
  TopologyRuntime,
} from '../topology/topology-types';
import type {
  PowerDefinition,
  PowerDigitalSample,
  PowerDomainChange,
  PowerDomainObserver,
  PowerDomainSnapshot,
  PowerDomainState,
  PowerDownReason,
  PowerInputMode,
  PowerOptions,
  PowerPinGate,
  PowerPinGateReason,
  PowerRuntime,
  PowerVoltageSample,
} from './power-types';
import {
  captureObserver,
  capturePowerDefinition,
  capturePowerOptions,
  domainKey,
  pinKey,
  type CapturedDomain,
  type CapturedObserver,
  type CapturedPin,
  type CapturedPowerDefinition,
  type CapturedPowerOptions,
} from './power-validation';

const NO_OPENED: readonly string[] = Object.freeze([]);
const NO_REASONS: readonly PowerDownReason[] = Object.freeze([]);
const GATED_DIGITAL: PowerDigitalSample = Object.freeze({
  value: 0,
  ready: false,
  source: 'gated',
});
const GATED_VOLTAGE: PowerVoltageSample = Object.freeze({
  voltage: 0,
  ready: false,
  source: 'gated',
});

type Command =
  | { readonly kind: 'propagate'; readonly opened: readonly string[] }
  | { readonly kind: 'notify'; readonly changes: readonly PowerDomainChange[] };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSnapshots(left: PowerDomainSnapshot, right: PowerDomainSnapshot): number {
  return (
    compareText(left.instanceId, right.instanceId) || compareText(left.domainId, right.domainId)
  );
}

function nextState(
  voltage: number | null,
  groundReady: boolean,
  dependenciesReady: boolean,
  previous: PowerDomainState,
  turnOn: number,
  turnOff: number,
): PowerDomainState {
  if (!groundReady || voltage === null || !dependenciesReady) return 'off';
  if (voltage <= turnOff) return 'off';
  if (voltage >= turnOn) return 'on';
  return previous;
}

function downReasons(
  domain: CapturedDomain,
  snapshot: PowerDomainSnapshot,
): readonly PowerDownReason[] {
  const reasons: PowerDownReason[] = [];
  if (!snapshot.groundReady) reasons.push('ground-not-ready');
  else if (snapshot.voltage === null) reasons.push('supply-indeterminate');
  if (!snapshot.dependenciesReady) reasons.push('dependency-off');
  if (snapshot.groundReady && snapshot.voltage !== null && snapshot.voltage <= domain.turnOff) {
    reasons.push('below-turn-off');
  }
  return Object.freeze(reasons);
}

function sortChanges(
  changes: readonly PowerDomainChange[],
  domainsByKey: ReadonlyMap<string, CapturedDomain>,
): readonly PowerDomainChange[] {
  const depth = (change: PowerDomainChange): number =>
    domainsByKey.get(domainKey(change.instanceId, change.domainId))?.depth ?? 0;
  const down = changes
    .filter((change) => change.state === 'off')
    .sort(
      (left, right) =>
        compareText(left.instanceId, right.instanceId) ||
        depth(right) - depth(left) ||
        compareText(left.domainId, right.domainId),
    );
  const up = changes
    .filter((change) => change.state === 'on')
    .sort(
      (left, right) =>
        compareText(left.instanceId, right.instanceId) ||
        depth(left) - depth(right) ||
        compareText(left.domainId, right.domainId),
    );
  return Object.freeze([...down, ...up]);
}

function sortStates(
  states: ReadonlyMap<string, ElectricalPinInput>,
): readonly ElectricalPinInput[] {
  return Object.freeze(
    [...states.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([, state]) => state),
  );
}

export class PowerFeedbackError extends Error {
  override readonly name = 'PowerFeedbackError' as const;
  readonly timePs: TimePs;
  readonly rounds: number;
  readonly maxRounds: number;
  readonly domains: readonly PowerDomainSnapshot[];

  constructor(
    timePs: TimePs,
    rounds: number,
    maxRounds: number,
    domains: readonly PowerDomainSnapshot[],
  ) {
    super(`Power propagation exceeded ${maxRounds} rounds at ${timePs} ps`);
    this.timePs = timePs;
    this.rounds = rounds;
    this.maxRounds = maxRounds;
    this.domains = Object.freeze(domains.map((domain) => Object.freeze({ ...domain })));
    Object.freeze(this);
  }
}

class PowerRuntimeImpl implements PowerRuntime {
  readonly #scheduler: Scheduler;
  readonly #definition: CapturedPowerDefinition;
  readonly #options: CapturedPowerOptions;
  readonly #topology: TopologyRuntime;
  readonly #target: SchedulerTarget;
  readonly #instance: SchedulerInstance;
  readonly #signalPins: readonly CapturedPin[];
  readonly #pinsByDomain: ReadonlyMap<string, readonly CapturedPin[]>;
  readonly #intents: Map<string, ElectricalPinInput>;
  readonly #effective: Map<string, ElectricalPinInput>;
  readonly #notified = new Map<string, PowerDomainState>();
  readonly #pendingOpen = new Set<string>();
  readonly #digital = new Map<string, PowerDigitalSample>();
  readonly #memory = new Map<string, 0 | 1>();
  readonly #dirty = new Set<string>();
  readonly #commands: Command[] = [];
  #domains = new Map<string, PowerDomainSnapshot>();
  #observer: CapturedObserver | undefined;
  #topologyReady = false;
  #destroyed = false;
  #budgetTime: TimePs | undefined;
  #rounds = 0;

  constructor(scheduler: Scheduler, definitionInput: unknown, optionsInput: unknown) {
    const definition = capturePowerDefinition(definitionInput);
    const options = capturePowerOptions(optionsInput, definition);
    this.#scheduler = scheduler;
    this.#definition = definition;
    this.#options = options;
    this.#observer = options.observer;
    this.#intents = new Map(options.intents);
    this.#effective = new Map(
      options.initialStates.map((state) => [pinKey(state.instanceId, state.pinName), state]),
    );
    this.#signalPins = Object.freeze(definition.pins.filter((pin) => pin.kind === 'signal'));
    const pinsByDomain = new Map<string, CapturedPin[]>();
    for (const pin of definition.pins) {
      if (pin.domain === undefined) continue;
      const list = pinsByDomain.get(pin.domain.key);
      if (list === undefined) pinsByDomain.set(pin.domain.key, [pin]);
      else list.push(pin);
    }
    this.#pinsByDomain = pinsByDomain;
    for (const pin of this.#signalPins) this.#memory.set(pin.key, 0);
    for (const domain of definition.domainsInOrder) this.#notified.set(domain.key, 'off');

    this.#topology = createTopologyRuntime(scheduler, definition.topology, {
      instanceId: options.topologyInstanceId,
      pinStates: options.initialStates,
      ...(options.floating === undefined
        ? {}
        : {
            floating: {
              seed: options.floating.seed,
              supplyVoltage: (pin: TopologyPinRef) => this.#floatingSupply(pin),
              samplingEnabled: (pin: TopologyPinRef) => this.#floatingSamplingEnabled(pin),
            },
          }),
    });
    this.#domains = this.#computeDomains();
    for (const domain of definition.domainsInOrder) {
      if (this.#domains.get(domain.key)?.state === 'on') this.#pendingOpen.add(domain.key);
    }
    this.#topologyReady = true;
    this.#interpretPins();
    this.#target = Object.freeze({
      name: 'power.propagate',
      kind: 'control',
      params: Object.freeze([]),
    });
    this.#instance = scheduler.addInstance({
      instanceId: options.instanceId,
      targets: [this.#target],
      executor: { execute: () => this.#runNextCommand() },
    });
    this.#enqueue(Object.freeze({ kind: 'propagate', opened: NO_OPENED }));
    Object.freeze(this);
  }

  get instance(): SchedulerInstance {
    return this.#instance;
  }

  get inputMode(): PowerInputMode {
    return this.#options.inputMode;
  }

  submit(patch: TopologyConnectionPatch): void {
    this.#assertAlive();
    this.#topology.submit(patch);
    this.#enqueue(Object.freeze({ kind: 'propagate', opened: NO_OPENED }));
  }

  updatePinStates(states: readonly ElectricalPinInput[]): void {
    this.#assertAlive();
    if (!Array.isArray(states)) invalidType('states', states, 'be an array');
    if (states.length === 0) return;
    const updates: { readonly key: string; readonly state: ElectricalPinInput }[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < states.length; index += 1) {
      const state = snapshotElectricalPin(states[index], `states[${index}]`);
      const key = pinKey(state.instanceId, state.pinName);
      if (!this.#definition.pinsByKey.has(key)) {
        throw new RangeError(
          `states[${index}]: (${JSON.stringify(state.instanceId)}, ${JSON.stringify(state.pinName)}) must reference a declared pin`,
        );
      }
      if (seen.has(key)) {
        invalidType(
          `states[${index}].pinName`,
          state.pinName,
          `be unique within instance ${JSON.stringify(state.instanceId)}`,
        );
      }
      seen.add(key);
      updates.push(Object.freeze({ key, state }));
    }
    for (const update of updates) {
      this.#intents.set(update.key, update.state);
      this.#dirty.add(update.key);
    }
    this.#enqueue(Object.freeze({ kind: 'propagate', opened: NO_OPENED }));
  }

  refresh(pins?: readonly TopologyPinRef[]): void {
    this.#assertAlive();
    if (pins !== undefined) {
      if (!Array.isArray(pins)) invalidType('pins', pins, 'be an array');
      if (pins.length === 0) return;
    }
    this.#topology.refresh(pins);
    this.#enqueue(Object.freeze({ kind: 'propagate', opened: NO_OPENED }));
  }

  connectionState(instanceId: string, connectionId: string): ConnectionState {
    return this.#topology.connectionState(instanceId, connectionId);
  }

  networks(): readonly TopologyNetwork[] {
    return this.#topology.networks();
  }

  networkOf(pin: TopologyPinRef): TopologyNetwork | undefined {
    return this.#topology.networkOf(pin);
  }

  floatingInput(pin: TopologyPinRef): FloatingInput | undefined {
    return this.#topology.floatingInput(pin);
  }

  domain(instanceId: string, domainId: string): PowerDomainSnapshot {
    checkIdentity(instanceId, 'instanceId');
    checkIdentity(domainId, 'domainId');
    const key = domainKey(instanceId, domainId);
    if (!this.#definition.domainsByKey.has(key)) {
      throw new RangeError(
        `(${JSON.stringify(instanceId)}, ${JSON.stringify(domainId)}) must reference a declared power domain`,
      );
    }
    return this.#domains.get(key) as PowerDomainSnapshot;
  }

  domains(instanceId?: string): readonly PowerDomainSnapshot[] {
    const snapshot = this.#snapshots();
    if (instanceId === undefined) return snapshot;
    checkIdentity(instanceId, 'instanceId');
    if (!this.#definition.instances.has(instanceId)) {
      throw new RangeError(
        `${JSON.stringify(instanceId)} must reference a declared topology instance`,
      );
    }
    return Object.freeze(snapshot.filter((domain) => domain.instanceId === instanceId));
  }

  pinGate(pin: TopologyPinRef): PowerPinGate {
    const captured = this.#signalPin(pin, 'pin');
    const gate = this.#gateFor(captured);
    return Object.freeze({
      instanceId: captured.ref.instanceId,
      pinName: captured.ref.pinName,
      domainId: gate.domainId,
      ready: gate.ready,
      reason: gate.reason,
    });
  }

  pinIntent(pin: TopologyPinRef): ElectricalPinInput {
    const captured = this.#resolvePin(pin, 'pin');
    return this.#intents.get(captured.key) as ElectricalPinInput;
  }

  sampleDigital(pin: TopologyPinRef): PowerDigitalSample {
    const captured = this.#signalPin(pin, 'pin');
    const sample = this.#digital.get(captured.key);
    if (sample === undefined) {
      throw new Error(
        `Invariant: missing digital interpretation for (${JSON.stringify(captured.ref.instanceId)}, ${JSON.stringify(captured.ref.pinName)})`,
      );
    }
    return sample;
  }

  sampleVoltage(pin: TopologyPinRef): PowerVoltageSample {
    const captured = this.#signalPin(pin, 'pin');
    if (!this.#gateFor(captured).ready) return GATED_VOLTAGE;
    const network = this.#topology.networkOf(captured.ref);
    const result = network?.result;
    if (result === undefined) {
      throw new Error(
        `Invariant: network result missing for (${JSON.stringify(captured.ref.instanceId)}, ${JSON.stringify(captured.ref.pinName)})`,
      );
    }
    if (result.state === 'driven') {
      return Object.freeze({ voltage: result.voltage, ready: true, source: 'sampled' });
    }
    const floating = this.#topology.floatingInput(captured.ref);
    if (floating === undefined) {
      throw new Error(
        `Floating voltage sampling for (${JSON.stringify(captured.ref.instanceId)}, ${JSON.stringify(captured.ref.pinName)}) requires PowerOptions.floating`,
      );
    }
    const supply = this.#floatingSupply(captured.ref);
    if (supply === undefined) {
      throw new RangeError(
        `Floating voltage sampling for (${JSON.stringify(captured.ref.instanceId)}, ${JSON.stringify(captured.ref.pinName)}) requires a nonnegative supply`,
      );
    }
    const sample = floating.sample(supply, this.#scheduler.now, true);
    if (sample.state !== 'ready') {
      throw new Error(
        `Invariant: enabled floating sampling returned disabled for (${JSON.stringify(captured.ref.instanceId)}, ${JSON.stringify(captured.ref.pinName)})`,
      );
    }
    return Object.freeze({ voltage: sample.voltage, ready: true, source: 'floating' });
  }

  observe(observer: PowerDomainObserver | undefined): void {
    this.#observer = observer === undefined ? undefined : captureObserver(observer, 'observer');
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#commands.length = 0;
    this.#topology.destroy();
    this.#scheduler.destroyInstance(this.#instance);
  }

  #assertAlive(): void {
    if (this.#destroyed) throw new Error('Power runtime is destroyed');
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
      throw new Error('Power control entry has no pending command');
    }
    if (command.kind === 'notify') {
      this.#completeBatch(command.changes, true);
      return;
    }
    this.#propagate(command.opened);
  }

  #propagate(opened: readonly string[]): void {
    const now = this.#scheduler.now;
    if (this.#budgetTime !== now) {
      this.#budgetTime = now;
      this.#rounds = 0;
    }
    this.#rounds += 1;
    if (this.#rounds > this.#options.maxPropagationRounds) {
      throw new PowerFeedbackError(
        now,
        this.#rounds,
        this.#options.maxPropagationRounds,
        this.#snapshots(),
      );
    }
    for (const key of opened) this.#pendingOpen.delete(key);

    const next = this.#computeDomains();
    const changes: PowerDomainChange[] = [];
    for (const domain of this.#definition.domainsInOrder) {
      const previous = this.#notified.get(domain.key) ?? 'off';
      const snapshot = next.get(domain.key) as PowerDomainSnapshot;
      if (snapshot.state === previous) continue;
      changes.push(
        Object.freeze({
          ...snapshot,
          timePs: now,
          previousState: previous,
          reasons: snapshot.state === 'off' ? downReasons(domain, snapshot) : NO_REASONS,
        }),
      );
    }
    this.#domains = next;
    for (const change of changes) {
      const key = domainKey(change.instanceId, change.domainId);
      if (change.state === 'on') this.#pendingOpen.add(key);
      else this.#pendingOpen.delete(key);
    }

    const offStates = new Map<string, ElectricalPinInput>();
    for (const change of changes) {
      if (change.state !== 'off') continue;
      const key = domainKey(change.instanceId, change.domainId);
      for (const pin of this.#pinsByDomain.get(key) ?? []) {
        const intent = this.#intents.get(pin.key) as ElectricalPinInput;
        const state = Object.freeze({ ...intent, powerReady: false });
        offStates.set(pin.key, state);
        this.#effective.set(pin.key, state);
      }
    }
    if (offStates.size > 0) this.#topology.updatePinStates(sortStates(offStates));
    this.#interpretPins();

    if (offStates.size > 0) {
      this.#enqueue(Object.freeze({ kind: 'notify', changes: Object.freeze(changes) }));
      return;
    }
    this.#completeBatch(changes, false);
  }

  #completeBatch(changes: readonly PowerDomainChange[], recheck: boolean): void {
    if (changes.length > 0) {
      const ordered = sortChanges(changes, this.#definition.domainsByKey);
      if (this.#observer !== undefined) {
        this.#observer.notify.call(this.#observer.receiver, ordered, this.#snapshots());
      }
      for (const change of changes) {
        this.#notified.set(domainKey(change.instanceId, change.domainId), change.state);
      }
    }

    const post = new Map<string, ElectricalPinInput>();
    for (const change of changes) {
      if (change.state !== 'on') continue;
      const key = domainKey(change.instanceId, change.domainId);
      for (const pin of this.#pinsByDomain.get(key) ?? []) {
        const intent = this.#intents.get(pin.key) as ElectricalPinInput;
        post.set(pin.key, Object.freeze({ ...intent, powerReady: true }));
      }
    }
    for (const key of this.#dirty) {
      const pin = this.#definition.pinsByKey.get(key);
      const intent = this.#intents.get(key);
      if (pin === undefined || intent === undefined) {
        throw new Error(`Invariant: dirty pin ${key} is not declared`);
      }
      post.set(
        key,
        pin.domain === undefined
          ? intent
          : Object.freeze({
              ...intent,
              powerReady: this.#domains.get(pin.domain.key)?.state === 'on',
            }),
      );
    }
    this.#dirty.clear();

    const hasOn = changes.some((change) => change.state === 'on');
    if (post.size > 0) {
      for (const [key, state] of post) this.#effective.set(key, state);
      this.#topology.updatePinStates(sortStates(post));
    }
    if (post.size > 0 || hasOn || recheck) {
      const opened = Object.freeze(
        changes
          .filter((change) => change.state === 'on')
          .map((change) => domainKey(change.instanceId, change.domainId)),
      );
      this.#enqueue(Object.freeze({ kind: 'propagate', opened }));
    }
    this.#interpretPins();
  }

  #computeDomains(): Map<string, PowerDomainSnapshot> {
    const next = new Map<string, PowerDomainSnapshot>();
    for (const domain of this.#definition.domainsInOrder) {
      const groundNetwork = this.#topology.networkOf(domain.ground);
      const supplyNetwork = this.#topology.networkOf(domain.supply);
      const groundReady = groundNetwork?.groundReady === true;
      const supply = supplyNetwork?.result;
      const voltage = groundReady && supply?.state === 'driven' ? supply.voltage : null;
      const dependenciesReady = domain.dependsOn.every(
        (dependency) => next.get(dependency.key)?.state === 'on',
      );
      const previous = this.#domains.get(domain.key)?.state ?? 'off';
      const state = nextState(
        voltage,
        groundReady,
        dependenciesReady,
        previous,
        domain.turnOn,
        domain.turnOff,
      );
      next.set(
        domain.key,
        Object.freeze({
          instanceId: domain.instanceId,
          domainId: domain.domainId,
          state,
          voltage,
          groundReady,
          dependenciesReady,
        }),
      );
    }
    return next;
  }

  #snapshots(): readonly PowerDomainSnapshot[] {
    return Object.freeze([...this.#domains.values()].sort(compareSnapshots));
  }

  #interpretPins(): void {
    for (const pin of this.#signalPins) this.#interpretPin(pin);
  }

  #interpretPin(pin: CapturedPin): void {
    const gate = this.#gateFor(pin);
    if (!gate.ready) {
      this.#digital.set(pin.key, GATED_DIGITAL);
      return;
    }
    const network = this.#topology.networkOf(pin.ref);
    const result = network?.result;
    if (result === undefined) {
      throw new Error(
        `Invariant: network result missing for (${JSON.stringify(pin.ref.instanceId)}, ${JSON.stringify(pin.ref.pinName)})`,
      );
    }
    if (result.state === 'floating') {
      this.#digital.set(pin.key, Object.freeze({ value: 0, ready: true, source: 'floating' }));
      return;
    }
    let low: number;
    let high: number;
    if (pin.levels !== undefined) {
      const domain = pin.domain === undefined ? undefined : this.#domains.get(pin.domain.key);
      if (domain === undefined || domain.voltage === null) {
        throw new Error(`Invariant: missing domain voltage for (${JSON.stringify(pin.key)})`);
      }
      low = pin.levels.low * domain.voltage;
      high = pin.levels.high * domain.voltage;
    } else {
      const effective = this.#effective.get(pin.key);
      if (effective === undefined) {
        throw new Error(`Invariant: missing effective pin state for (${JSON.stringify(pin.key)})`);
      }
      low = effective.model.lowVoltage;
      high = effective.model.highVoltage;
    }
    const voltage = result.voltage;
    let value: 0 | 1;
    let source: PowerDigitalSample['source'];
    if (voltage <= low) {
      value = 0;
      source = 'sampled';
    } else if (voltage >= high) {
      value = 1;
      source = 'sampled';
    } else if (this.#options.inputMode === 'three-state') {
      value = this.#memory.get(pin.key) ?? 0;
      source = 'threshold-range';
    } else {
      value = 0;
      source = 'sampled';
    }
    if (source === 'sampled') this.#memory.set(pin.key, value);
    this.#digital.set(pin.key, Object.freeze({ value, ready: true, source }));
  }

  #gateFor(pin: CapturedPin): {
    readonly domainId: string | null;
    readonly ready: boolean;
    readonly reason: PowerPinGateReason;
  } {
    if (pin.domain === undefined) {
      return { domainId: null, ready: true, reason: 'no-domain' };
    }
    const snapshot = this.#domains.get(pin.domain.key);
    if (snapshot === undefined || snapshot.state === 'off') {
      return { domainId: pin.domain.domainId, ready: false, reason: 'domain-off' };
    }
    if (this.#pendingOpen.has(pin.domain.key)) {
      return { domainId: pin.domain.domainId, ready: false, reason: 'opening' };
    }
    return { domainId: pin.domain.domainId, ready: true, reason: 'powered' };
  }

  #resolvePin(value: unknown, path: string): CapturedPin {
    checkRecord(value, path, ['instanceId', 'pinName']);
    const instanceId = value.instanceId;
    const pinName = value.pinName;
    checkIdentity(instanceId, `${path}.instanceId`);
    checkIdentity(pinName, `${path}.pinName`);
    const captured = this.#definition.pinsByKey.get(pinKey(instanceId, pinName));
    if (captured === undefined) {
      throw new RangeError(
        `${path}: (${JSON.stringify(instanceId)}, ${JSON.stringify(pinName)}) must reference a declared pin`,
      );
    }
    return captured;
  }

  #signalPin(value: unknown, path: string): CapturedPin {
    const pin = this.#resolvePin(value, path);
    if (pin.kind !== 'signal') {
      throw new RangeError(
        `${path}: (${JSON.stringify(pin.ref.instanceId)}, ${JSON.stringify(pin.ref.pinName)}) must be a kind 'signal' pin`,
      );
    }
    return pin;
  }

  #floatingSupply(pin: TopologyPinRef): number | undefined {
    const captured = this.#definition.pinsByKey.get(pinKey(pin.instanceId, pin.pinName));
    if (captured === undefined) return undefined;
    if (captured.domain !== undefined) {
      if (!this.#topologyReady) return undefined;
      const snapshot = this.#domains.get(captured.domain.key);
      if (snapshot === undefined || snapshot.state !== 'on') return undefined;
      return snapshot.voltage ?? undefined;
    }
    const effective = this.#effective.get(captured.key);
    if (effective === undefined) return undefined;
    const maxVoltage = effective.model.maxVoltage;
    return maxVoltage >= 0 ? maxVoltage : undefined;
  }

  #floatingSamplingEnabled(pin: TopologyPinRef): boolean {
    const captured = this.#definition.pinsByKey.get(pinKey(pin.instanceId, pin.pinName));
    if (captured === undefined) return false;
    if (captured.domain === undefined) return true;
    if (!this.#topologyReady) return false;
    return this.#domains.get(captured.domain.key)?.state === 'on';
  }
}

export function createPowerRuntime(
  scheduler: Scheduler,
  definition: PowerDefinition,
  options: PowerOptions,
): PowerRuntime {
  return new PowerRuntimeImpl(scheduler, definition, options);
}
