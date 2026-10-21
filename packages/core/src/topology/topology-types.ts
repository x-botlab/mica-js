import type {
  ElectricalNetworkResult,
  ElectricalPinInput,
  FloatingInput,
} from '../electrical/electrical-types';
import type { Scheduler, SchedulerInstance } from '../scheduler/scheduler-types';

/** Declared state of one internal connection. */
export type ConnectionState = 'open' | 'closed';

/** Identity of one physical pin. */
export interface TopologyPinRef {
  readonly instanceId: string;
  readonly pinName: string;
}

export interface TopologyPinDeclaration extends TopologyPinRef {
  readonly kind: 'signal' | 'power' | 'gnd';
}

/** Immutable external wiring supplied by the circuit layer. */
export interface TopologyExternalWire {
  readonly wireId: string;
  readonly pins: readonly TopologyPinRef[];
  /** True when this wire belongs to the explicit global GND node. */
  readonly globalGnd?: boolean;
}

/** Static internal connection declared by a device instance. */
export interface TopologyConnectionDeclaration {
  readonly instanceId: string;
  readonly connectionId: string;
  readonly pins: readonly [string, string];
  /** Defaults to `open`. */
  readonly initial?: ConnectionState;
}

export interface TopologyDefinition {
  readonly pins: readonly TopologyPinDeclaration[];
  readonly wires: readonly TopologyExternalWire[];
  readonly connections: readonly TopologyConnectionDeclaration[];
}

export interface TopologyConnectionUpdate {
  readonly connectionId: string;
  readonly state: ConnectionState;
}

/** One atomic multi-touch commit for a single instance. */
export interface TopologyConnectionPatch {
  readonly instanceId: string;
  readonly connections: readonly TopologyConnectionUpdate[];
}

export interface TopologyFloatingOptions {
  /** u32 seed used by `mica-floating-v2`. */
  readonly seed: number;
  /** Current supply for the pin, or `undefined` while it is not known/ready. */
  readonly supplyVoltage: (pin: TopologyPinRef) => number | undefined;
  /** Defaults to true; false keeps floating episodes uninitialized while they still count. */
  readonly samplingEnabled?: (pin: TopologyPinRef) => boolean;
}

export interface TopologyOptions {
  /** Scheduler instance identity; must be unique and is never reused. */
  readonly instanceId: string;
  /** Exactly one committed electrical state per declared pin. */
  readonly pinStates: readonly ElectricalPinInput[];
  readonly floating?: TopologyFloatingOptions;
}

export interface TopologyNetwork {
  /**
   * Canonical identity, `net:<escaped instanceId>/<escaped pinName>` of the smallest member.
   * `%` and `/` are percent-escaped, so distinct raw identities never collide.
   */
  readonly networkId: string;
  readonly pins: readonly TopologyPinRef[];
  /** A `gnd` pin in this network reaches a wire marked `globalGnd`. */
  readonly groundReady: boolean;
  /** `undefined` only after a failed electrical resolution left the committed network unresolved. */
  readonly result: ElectricalNetworkResult | undefined;
}

export interface TopologyRuntime {
  /** Registered control instance; use `submit`/`refresh`/`destroy`, not the scheduler directly. */
  readonly instance: SchedulerInstance;
  /** Validate and queue one atomic connection patch at the next control phase. */
  submit(patch: TopologyConnectionPatch): void;
  /** Validate and queue partial pin-state updates at the next control phase. */
  updatePinStates(states: readonly ElectricalPinInput[]): void;
  /** Queue an electrical resolution point for the given pins, or every network when omitted. */
  refresh(pins?: readonly TopologyPinRef[]): void;
  connectionState(instanceId: string, connectionId: string): ConnectionState;
  networks(): readonly TopologyNetwork[];
  networkOf(pin: TopologyPinRef): TopologyNetwork | undefined;
  /**
   * Floating state for a declared pin; `undefined` when floating is not configured.
   * The topology owns `beginFloating`; read values through `sample` only.
   */
  floatingInput(pin: TopologyPinRef): FloatingInput | undefined;
  destroy(): void;
}

export type CreateTopologyRuntime = (
  scheduler: Scheduler,
  definition: TopologyDefinition,
  options: TopologyOptions,
) => TopologyRuntime;
