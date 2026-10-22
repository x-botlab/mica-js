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
  | {
      readonly kind: 'propagate';
      readonly epoch: number;
      readonly opened: readonly string[];
    }
  | { readonly kind: 'notify' };

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
  readonly #topology: TopologyRuntime;
  readonly #target: SchedulerTarget;
  readonly #instance: SchedulerInstance;
  readonly #inputMode: PowerInputMode;
  readonly #maxPropagationRounds: number;
  readonly #signalPins: readonly CapturedPin[];
  readonly #intents: Map<string, ElectricalPinInput>;
  readonly #effective: Map<string, ElectricalPinInput>;
  readonly #submittedGate: Map<string, boolean>;
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
  #topologyEpoch = 0;
  #appliedEpoch = 0;

  constructor(scheduler: Scheduler, definitionInput: unknown, optionsInput: unknown) {
    const definition = capturePowerDefinition(definitionInput);
    const options = capturePowerOptions(optionsInput, definition);
    this.#scheduler = scheduler;
    this.#definition = definition;
    this.#inputMode = options.inputMode;
    this.#maxPropagationRounds = options.maxPropagationRounds;
    this.#observer = options.observer;
    this.#intents = new Map(options.intents);
    this.#effective = new Map(
      options.initialStates.map((state) => [pinKey(state.instanceId, state.pinName), state]),
    );
    this.#submittedGate = new Map(
      options.initialStates.map((state) => [
        pinKey(state.instanceId, state.pinName),
        state.powerReady,
      ]),
    );
    this.#signalPins = Object.freeze(definition.pins.filter((pin) => pin.kind === 'signal'));
    for (const pin of this.#signalPins) this.#memory.set(pin.key, 0);
    for (const domain of definition.domainsInOrder) this.#notified.set(domain.key, 'off');

    this.#target = Object.freeze({
      name: 'power.propagate',
      kind: 'control',
      params: Object.freeze([]),
    });
    let instance: SchedulerInstance | undefined;
    let topology: TopologyRuntime | undefined;
    try {
      // Reserve the power identity first: a duplicate id must not create a topology orphan.
      instance = scheduler.addInstance({
        instanceId: options.instanceId,
        targets: [this.#target],
        executor: { execute: () => this.#runNextCommand() },
      });
      this.#instance = instance;
      topology = createTopologyRuntime(scheduler, definition.topology, {
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
      this.#topology = topology;
      this.#domains = this.#computeDomains();
      for (const domain of definition.domainsInOrder) {
        if (this.#domains.get(domain.key)?.state === 'on') this.#pendingOpen.add(domain.key);
      }
      this.#topologyReady = true;
      this.#interpretPins();
      this.#enqueuePropagate(0, NO_OPENED);
    } catch (cause) {
      if (topology !== undefined) {
        try {
          topology.destroy();
        } catch {
          // Preserve the construction failure; the orphan cleanup is best effort.
        }
      }
      if (instance !== undefined) {
        try {
          scheduler.destroyInstance(instance);
        } catch {
          // Preserve the construction failure; the orphan cleanup is best effort.
        }
      }
      throw cause;
    }
    Object.freeze(this);
  }

  get instance(): SchedulerInstance {
    return this.#instance;
  }

  get inputMode(): PowerInputMode {
    return this.#inputMode;
  }

  submit(patch: TopologyConnectionPatch): void {
    this.#assertAlive();
    this.#topology.submit(patch);
    this.#topologyEpoch += 1;
    this.#enqueuePropagate(this.#topologyEpoch, NO_OPENED);
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
    this.#enqueuePropagate(this.#topologyEpoch, NO_OPENED);
  }

  refresh(pins?: readonly TopologyPinRef[]): void {
    this.#assertAlive();
    if (pins !== undefined) {
      if (!Array.isArray(pins)) invalidType('pins', pins, 'be an array');
      if (pins.length === 0) return;
    }
    this.#topology.refresh(pins);
    this.#topologyEpoch += 1;
    this.#enqueuePropagate(this.#topologyEpoch, NO_OPENED);
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
    this.#assertAlive();
    this.#observer = observer === undefined ? undefined : captureObserver(observer, 'observer');
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#observer = undefined;
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

  #enqueuePropagate(epoch: number, opened: readonly string[]): void {
    this.#enqueue(Object.freeze({ kind: 'propagate', epoch, opened }));
  }

  #runNextCommand(): void {
    const command = this.#commands.shift();
    if (command === undefined) {
      throw new Error('Power control entry has no pending command');
    }
    if (command.kind === 'notify') {
      this.#notify();
      return;
    }
    this.#propagate(command.epoch, command.opened);
  }

  #propagate(epoch: number, opened: readonly string[]): void {
    const now = this.#scheduler.now;
    if (this.#budgetTime !== now) {
      this.#budgetTime = now;
      this.#rounds = 0;
    }
    this.#rounds += 1;
    if (this.#rounds > this.#maxPropagationRounds) {
      throw new PowerFeedbackError(
        now,
        this.#rounds,
        this.#maxPropagationRounds,
        this.#snapshots(),
      );
    }
    if (epoch > this.#appliedEpoch) this.#appliedEpoch = epoch;
    if (this.#appliedEpoch < this.#topologyEpoch) {
      // A newer topology commit is queued after this entry; wait before reading its state.
      this.#enqueuePropagate(this.#topologyEpoch, opened);
      return;
    }
    for (const key of opened) this.#pendingOpen.delete(key);

    this.#domains = this.#computeDomains();
    const updates = this.#desiredUpdates();
    if (updates.off.size > 0) {
      this.#submitUpdates(updates.off, false);
      this.#enqueuePropagate(this.#topologyEpoch, NO_OPENED);
      return;
    }
    if (this.#hasNotificationChange()) {
      this.#enqueue(Object.freeze({ kind: 'notify' }));
      return;
    }
    if (updates.on.size > 0) {
      const openedDomains = this.#submitUpdates(updates.on, true);
      this.#enqueuePropagate(this.#topologyEpoch, openedDomains);
      return;
    }
    this.#interpretPins();
  }

  #notify(): void {
    if (this.#appliedEpoch < this.#topologyEpoch) {
      this.#enqueuePropagate(this.#topologyEpoch, NO_OPENED);
      return;
    }
    let updates = this.#desiredUpdates();
    if (updates.off.size > 0) {
      this.#submitUpdates(updates.off, false);
      this.#enqueuePropagate(this.#topologyEpoch, NO_OPENED);
      return;
    }

    const changes = this.#notificationChanges();
    const opened = new Set<string>();
    for (const change of changes) {
      const key = domainKey(change.instanceId, change.domainId);
      if (change.state === 'on') {
        // The observer must see the gate as opening until this notification returns.
        this.#pendingOpen.add(key);
        opened.add(key);
      } else {
        this.#pendingOpen.delete(key);
      }
    }
    if (changes.length > 0) {
      this.#interpretPins();
      const ordered = sortChanges(changes, this.#definition.domainsByKey);
      if (this.#observer !== undefined) {
        this.#observer.notify.call(this.#observer.receiver, ordered, this.#snapshots());
      }
      for (const change of changes) {
        this.#notified.set(domainKey(change.instanceId, change.domainId), change.state);
      }
    }

    // Recompute after the observer so intents submitted during the callback win.
    updates = this.#desiredUpdates();
    if (updates.off.size > 0) this.#submitUpdates(updates.off, false);
    if (updates.on.size > 0) {
      for (const key of this.#submitUpdates(updates.on, true)) opened.add(key);
    }
    if (opened.size > 0 || updates.on.size > 0 || updates.off.size > 0) {
      this.#enqueuePropagate(this.#topologyEpoch, Object.freeze([...opened].sort(compareText)));
      return;
    }
    this.#interpretPins();
  }

  #notificationChanges(): readonly PowerDomainChange[] {
    const changes: PowerDomainChange[] = [];
    const now = this.#scheduler.now;
    for (const domain of this.#definition.domainsInOrder) {
      const previous = this.#notified.get(domain.key) ?? 'off';
      const snapshot = this.#domains.get(domain.key) as PowerDomainSnapshot;
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
    return changes;
  }

  #hasNotificationChange(): boolean {
    for (const domain of this.#definition.domainsInOrder) {
      const previous = this.#notified.get(domain.key) ?? 'off';
      if ((this.#domains.get(domain.key) as PowerDomainSnapshot).state !== previous) return true;
    }
    return false;
  }

  #desiredUpdates(): {
    readonly off: ReadonlyMap<string, ElectricalPinInput>;
    readonly on: ReadonlyMap<string, ElectricalPinInput>;
  } {
    const off = new Map<string, ElectricalPinInput>();
    const on = new Map<string, ElectricalPinInput>();
    for (const pin of this.#definition.pins) {
      const intent = this.#intents.get(pin.key) as ElectricalPinInput;
      const desired =
        pin.domain === undefined
          ? intent.powerReady
          : this.#domains.get(pin.domain.key)?.state === 'on';
      if (!this.#dirty.has(pin.key) && this.#submittedGate.get(pin.key) === desired) continue;
      const state =
        pin.domain === undefined ? intent : Object.freeze({ ...intent, powerReady: desired });
      if (desired) on.set(pin.key, state);
      else off.set(pin.key, state);
    }
    return { off, on };
  }

  #submitUpdates(
    updates: ReadonlyMap<string, ElectricalPinInput>,
    desired: boolean,
  ): readonly string[] {
    if (updates.size === 0) return NO_OPENED;
    const opened = new Set<string>();
    for (const [key, state] of updates) {
      const pin = this.#definition.pinsByKey.get(key) as CapturedPin;
      const wasSubmitted = this.#submittedGate.get(key) === true;
      this.#effective.set(key, state);
      this.#submittedGate.set(key, desired);
      this.#dirty.delete(key);
      if (pin.domain === undefined) continue;
      if (desired) {
        if (!wasSubmitted) {
          this.#pendingOpen.add(pin.domain.key);
          opened.add(pin.domain.key);
        }
      } else {
        this.#pendingOpen.delete(pin.domain.key);
      }
    }
    this.#topology.updatePinStates(sortStates(updates));
    this.#topologyEpoch += 1;
    return Object.freeze([...opened].sort(compareText));
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
    } else if (this.#inputMode === 'three-state') {
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
