import type { ElectricalPinInput, FloatingInput } from '../electrical/types';
import type { SchedulerInstance } from '../scheduler/types';
import type { TimePs } from '../scheduler/time';
import type {
  ConnectionState,
  TopologyConnectionPatch,
  TopologyDefinition,
  TopologyNetwork,
  TopologyPinRef,
} from '../topology/types';

export type PowerInputMode = 'two-state' | 'three-state';

export type PowerDomainState = 'off' | 'on';

export type PowerDownReason =
  'ground-not-ready' | 'supply-indeterminate' | 'dependency-off' | 'below-turn-off';

export interface PowerLevels {
  /** Proportion of the domain voltage at or below which the input is low. */
  readonly low: number;
  /** Proportion of the domain voltage at or above which the input is high. */
  readonly high: number;
}

export interface PowerPinBinding {
  /** Signal pin binding to a domain declared by the same device. */
  readonly powerDomain?: string;
  /** Optional proportional input levels; requires `powerDomain`. */
  readonly levels?: PowerLevels;
}

export interface PowerDomainDeclaration {
  /** Pin name of a `kind: 'power'` pin declared by the same device. */
  readonly supply: string;
  /** Pin name of a `kind: 'gnd'` pin declared by the same device. */
  readonly ground: string;
  readonly voltage: {
    /** Power-up threshold in volts; strictly greater than `turnOff`. */
    readonly turnOn: number;
    /** Power-down threshold in volts; finite and nonnegative. */
    readonly turnOff: number;
  };
  /** Same-device domains that must be on; unique and acyclic. */
  readonly dependsOn?: readonly string[];
}

export interface PowerDeviceDefinition {
  readonly instanceId: string;
  readonly powerDomains: Readonly<Record<string, PowerDomainDeclaration>>;
  readonly pins?: Readonly<Record<string, PowerPinBinding>>;
}

export interface PowerDefinition {
  readonly topology: TopologyDefinition;
  readonly devices: readonly PowerDeviceDefinition[];
}

export interface PowerDomainSnapshot {
  readonly instanceId: string;
  readonly domainId: string;
  readonly state: PowerDomainState;
  /** Supply voltage relative to the fixed global 0 V reference, or null. */
  readonly voltage: number | null;
  readonly groundReady: boolean;
  readonly dependenciesReady: boolean;
}

export interface PowerDomainChange extends PowerDomainSnapshot {
  readonly timePs: TimePs;
  readonly previousState: PowerDomainState;
  readonly reasons: readonly PowerDownReason[];
}

export interface PowerDomainObserver {
  onPowerDomainChange(
    changes: readonly PowerDomainChange[],
    snapshot: readonly PowerDomainSnapshot[],
  ): void;
}

export type PowerPinGateReason = 'powered' | 'opening' | 'domain-off' | 'no-domain';

export interface PowerPinGate {
  readonly instanceId: string;
  readonly pinName: string;
  readonly domainId: string | null;
  readonly ready: boolean;
  readonly reason: PowerPinGateReason;
}

export type PowerDigitalSource = 'sampled' | 'floating' | 'threshold-range' | 'gated';

export interface PowerDigitalSample {
  readonly value: 0 | 1;
  readonly ready: boolean;
  readonly source: PowerDigitalSource;
}

export type PowerVoltageSource = 'sampled' | 'floating' | 'gated';

export interface PowerVoltageSample {
  readonly voltage: number;
  readonly ready: boolean;
  readonly source: PowerVoltageSource;
}

/** One digital pin interpretation that changed in a completed electrical resolution phase. */
export interface PowerDigitalPinChange {
  readonly instanceId: string;
  readonly pinName: string;
  readonly sample: PowerDigitalSample;
}

/**
 * Change-only digital pin observer. Registrations receive no initial replay; current values are
 * read through {@link PowerRuntime.sampleDigital}. Callbacks run synchronously at the end of a
 * resolution phase and must only enqueue work or read state.
 */
export interface PowerDigitalPinObserver {
  onDigitalPinChange(changes: readonly PowerDigitalPinChange[]): void;
}

export interface PowerFloatingOptions {
  /** u32 seed used by `mica-floating-v2`. */
  readonly seed: number;
}

export interface PowerOptions {
  /** Scheduler instance identity for the power control target; must be unique. */
  readonly instanceId: string;
  /** Topology scheduler identity; defaults to `${instanceId}:topology`. */
  readonly topologyInstanceId?: string;
  /** Complete held-intent snapshot, one entry per declared topology pin. */
  readonly pinStates: readonly ElectricalPinInput[];
  /** Enables deterministic analog floating sampling through the topology layer. */
  readonly floating?: PowerFloatingOptions;
  /** Digital input interpretation; defaults to three-state. */
  readonly inputMode?: PowerInputMode;
  /** Maximum power propagation entries per virtual time; defaults to 10000. */
  readonly maxPropagationRounds?: number;
  readonly observer?: PowerDomainObserver;
}

export interface PowerRuntime {
  /** Registered control instance; use `destroy`, not the scheduler directly. */
  readonly instance: SchedulerInstance;
  readonly inputMode: PowerInputMode;
  /** Submit an atomic topology connection patch, then re-evaluate power. */
  submit(patch: TopologyConnectionPatch): void;
  /** Replace held pin intents; gating is applied in the public control phase. */
  updatePinStates(states: readonly ElectricalPinInput[]): void;
  /** Request an electrical resolution point, then re-evaluate power. */
  refresh(pins?: readonly TopologyPinRef[]): void;
  connectionState(instanceId: string, connectionId: string): ConnectionState;
  networks(): readonly TopologyNetwork[];
  networkOf(pin: TopologyPinRef): TopologyNetwork | undefined;
  floatingInput(pin: TopologyPinRef): FloatingInput | undefined;
  domain(instanceId: string, domainId: string): PowerDomainSnapshot;
  domains(instanceId?: string): readonly PowerDomainSnapshot[];
  pinGate(pin: TopologyPinRef): PowerPinGate;
  /** Last submitted held intent; for domain pins the electrical gate is owned by the runtime. */
  pinIntent(pin: TopologyPinRef): ElectricalPinInput;
  sampleDigital(pin: TopologyPinRef): PowerDigitalSample;
  sampleVoltage(pin: TopologyPinRef): PowerVoltageSample;
  /** Replace or clear the single domain-change observer. */
  observe(observer: PowerDomainObserver | undefined): void;
  /**
   * Register a digital pin change observer. Multiple observers are called in registration
   * order after each completed electrical resolution phase; the returned disposer is idempotent.
   * Throwing stops later observers and faults the current scheduler entry.
   */
  addDigitalPinObserver(observer: PowerDigitalPinObserver): () => void;
  destroy(): void;
}
