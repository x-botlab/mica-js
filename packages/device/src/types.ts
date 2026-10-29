import type { DeliveryKind, PayloadType } from '@mica-js/core/canvas';
import type { PropertyDescriptor, PropertyValue } from '@mica-js/core/schematic';
import type {
  ElectricalPinInput,
  PowerDigitalPinObserver,
  PowerDigitalSample,
  TopologyPinRef,
} from '@mica-js/core';
import type {
  BytesOptions,
  BytesOutputRef,
  BytesRef,
  EntryRef,
  InboxRef,
  IRDeclarations,
  IRStorage,
  LifecycleRef,
  OutputRef,
  ScalarArgs,
  ScalarType,
  StaticRef,
  Value,
} from '@mica-js/ir';
import type {
  ConnectionRef,
  DeviceConnectionDescriptor,
  DeviceConnectionOptions,
} from './connection/types';

/** Payload types of logical topic ports (#10), shared with the canvas format. */
export type TopicPayloadType = PayloadType;

export interface Vec2d {
  readonly x: number;
  readonly y: number;
}

export interface Vec3d extends Vec2d {
  readonly z: number;
}

/** Runtime payload accepted by #10 ports. Tagged byte layouts remain a host concern. */
export type TopicPayload = boolean | number | string | Vec2d | Vec3d | Uint8Array;

/** Topic delivery metadata supplied by the host (#10 envelope). */
export interface TopicMetadata {
  readonly simTime: number;
}

/** IR output metadata: virtual time captured at the `bridge.send` operation. */
export interface IROutputMetadata {
  readonly timePs: number;
}

export type Unsubscribe = () => void;

export type MessageCallback<T, M> = (payload: T, meta: M) => void | Promise<void>;

/** One logical topic port declared by a device description (#10). */
export interface DevicePortDescriptor {
  readonly key: string;
  readonly title?: string;
  readonly description?: string;
  readonly direction: 'input' | 'output';
  readonly type: TopicPayloadType;
  /**
   * How publishes become deliveries (RFC 0017). Omitted means the payload type decides:
   * `boolean` / `number` / `vec2d` / `vec3d` are `level`, the text and byte payloads are `message`.
   * The field is orthogonal to `type`.
   */
  readonly delivery?: DeliveryKind;
}

/** Metadata supplied by the package index or provider for a device description (#11). */
export interface DeviceDescriptionMetadata {
  /** Stable device identity, normally the provider's device id. */
  readonly name: string;
  /** Human-readable name; falls back to `name` when omitted. */
  readonly displayName?: string;
  /** Optional display description. */
  readonly description?: string;
}

export type PinKind = 'power' | 'gnd' | 'signal';
export type PinSide = 'left' | 'right' | 'top' | 'bottom';

/** One physical pin declared by a device description (#12). */
export interface DevicePinDescriptor {
  readonly key: string;
  readonly kind: PinKind;
  /** Schematic presentation side; electrical semantics are carried by `kind` only. */
  readonly side: PinSide;
  /** Optional power-domain binding used by the power layer (#13). */
  readonly powerDomain?: string;
  /** Optional proportional input levels; requires `powerDomain` (#13). */
  readonly levels?: { readonly low: number; readonly high: number };
}

/** One fixed pin group declared by a device description (#12). */
export interface DevicePinGroupDescriptor {
  readonly key: string;
  readonly pins: readonly string[];
}

/**
 * Parsed device description. Instance configuration is fixed at creation time (#7 / #8);
 * this object is the declaration, not a mutable runtime property store.
 */
export interface DeviceDescription {
  readonly name: string;
  readonly displayName: string;
  readonly description: string | undefined;
  readonly properties: ReadonlyMap<string, PropertyDescriptor>;
  readonly ports: ReadonlyMap<string, DevicePortDescriptor>;
  readonly pins: ReadonlyMap<string, DevicePinDescriptor>;
  readonly pinGroups: ReadonlyMap<string, DevicePinGroupDescriptor>;
  readonly connections: ReadonlyMap<string, DeviceConnectionDescriptor>;
  readonly designatorPrefix: string | undefined;
}

/** Already-parsed definition plus implementation source returned by an {@link IDeviceProvider}. */
export interface DeviceDefinition {
  readonly definition: DeviceDescription;
  /** ES module source text of the device factory. */
  readonly code: string;
}

/** Static handle for one physical pin declared by the device description (#12). */
export type PinRef = StaticRef<'pin'>;

export interface PinConfig {
  readonly mode: 'high-z' | 'push-pull' | 'open-drain' | 'analog';
  readonly outputEnabled: boolean;
  readonly pull: 'none' | 'up' | 'down';
}

/** Pin I/O operations attached to every IR function builder (#8 / #25). */
export interface PinOperations {
  configure(pin: PinRef, config: PinConfig): undefined;
  writeDigital(pin: PinRef, level: Value<'bool'>): undefined;
  /** Returns `u32`: bit 0 is the interpreted level, upper bits are zero. */
  sampleDigital(pin: PinRef): Value<'u32'>;
}

/** Trigger selection for a digital edge observation binding (#8 / #25). */
export type ObserveEdge = 'rising' | 'falling' | 'both';

export interface ObserveConfig {
  readonly enabled: boolean;
  readonly edges: ObserveEdge;
}

/** Digital observation control attached to every IR function builder (#8 / #25). */
export interface ObserveOperations {
  configure(observer: ObserverRef, config: ObserveConfig): undefined;
}

/** Static handle for one observation binding declared by the device factory (#8 / #25). */
export type ObserverRef = StaticRef<'observe'>;

export type CapturedPinTypes<P extends readonly PinRef[]> = {
  readonly [I in keyof P]: 'u32';
};

/**
 * Static digital edge observation declaration. The target entry receives one `u8` edge code
 * followed by one `u32` per captured pin, in declaration order.
 */
export interface ObserveDigitalDescriptor<P extends readonly PinRef[]> {
  readonly trigger: PinRef;
  readonly captures: P;
  readonly target: EntryRef<NoInfer<readonly ['u8', ...CapturedPinTypes<P>]>>;
}

/** Static handle for one FIFO record queue declared by the device factory (RFC 0017). */
export type FifoRef = StaticRef<'fifo'>;

/** Fixed shape of a FIFO record queue declared through `api.ir.fifo` (RFC 0017). */
export interface FifoDescriptor {
  /** Largest single record the queue accepts, in bytes. */
  readonly maxRecord: number;
  /** Number of records the queue holds. */
  readonly length: number;
}

/** Instance declaration surface: core declarations plus this device's pins, connections and fifos. */
export interface DeviceIRDeclarations extends Omit<IRDeclarations, 'bytes'> {
  /** RFC 0017 form: a zero-filled, writable byte memory declared by its length. */
  bytes(name: string, length: number): BytesRef<false>;
  /** IR form: explicit initial bytes and options. */
  bytes<const ReadonlyBytes extends boolean>(
    name: string,
    initial: Uint8Array,
    options: BytesOptions<ReadonlyBytes>,
  ): BytesRef<ReadonlyBytes>;
  /** RFC 0017 form: a fixed-capacity record queue, reached through the step hooks' `io`. */
  fifo(name: string, descriptor: FifoDescriptor): FifoRef;
  pin(id: string): PinRef;
  connection(id: string): ConnectionRef;
  observeDigital<const P extends readonly PinRef[]>(
    name: string,
    descriptor: ObserveDigitalDescriptor<P>,
  ): ObserverRef;
}

/** Instance-level factory context (#8): fixed props, declarations and message bridge. */
export interface DeviceAPI {
  /** Independent, recursively frozen property snapshot fixed for this instance. */
  readonly props: DevicePropertySnapshot;
  /** Static IR declaration surface; closed as soon as the synchronous factory returns. */
  readonly ir: DeviceIRDeclarations;

  /** Subscribe to a declared input topic port. Registration is only allowed during the factory. */
  subscribe(port: string, callback: MessageCallback<TopicPayload, TopicMetadata>): Unsubscribe;

  /** Publish to a declared output topic port. Returns void after synchronous admission. */
  publish(port: string, payload: TopicPayload): void;

  /** Request an ordinary entry. Resolution means accepted, not executed. */
  post<P extends readonly ScalarType[]>(
    entry: EntryRef<P>,
    args: ScalarArgs<NoInfer<P>>,
  ): Promise<void>;

  /** Admit a captured byte message into a declared inbox and request its ordinary entry. */
  postBytes(
    entry: EntryRef<readonly ['u32', 'u32']>,
    inbox: InboxRef,
    bytes: Uint8Array,
  ): Promise<void>;

  /** Register the single consumer of an IR scalar output endpoint. */
  onOutput<P extends readonly ScalarType[]>(
    output: OutputRef<P>,
    callback: MessageCallback<ScalarArgs<NoInfer<P>>, IROutputMetadata>,
  ): Unsubscribe;
  /** Register the single consumer of an IR byte output endpoint. */
  onOutput(
    output: BytesOutputRef,
    callback: MessageCallback<Uint8Array, IROutputMetadata>,
  ): Unsubscribe;

  /** Request a versioned byte update. Resolution means content and versions are visible. */
  updateBytes(resource: BytesRef, offset: number, bytes: Uint8Array): Promise<void>;
}

/**
 * `applyInputs` view of one step (RFC 0017): read this step's deliveries and write device memory.
 *
 * Every method validates at runtime and reports through {@link DeviceDiagnostic} instead of
 * throwing, so a misused reference never aborts the step.
 */
export interface DeviceInputIO {
  /** Last payload this step delivered to `port`; `undefined` when the step was silent. */
  takeInput(port: string): TopicPayload | undefined;
  /** Every payload this step delivered to `port`, in publish order. */
  takeInputs(port: string): readonly TopicPayload[];
  /** Writes a declared scalar state; floats take a JS number. */
  writeState(name: string, value: boolean | number): void;
  /** Appends one record to a declared FIFO; `false` when the queue is at capacity. */
  writeFifo(name: string, bytes: Uint8Array): boolean;
  /** Reports a business diagnostic; the simulation state stays unchanged. */
  report(code: string, detail?: string): void;
}

/**
 * `flushOutputs` view of one step (RFC 0017): read device memory and publish.
 *
 * Same reporting contract as {@link DeviceInputIO}: a bad reference becomes a diagnostic.
 */
export interface DeviceOutputIO {
  /** Effective scalar value; floats are JS numbers. `undefined` when the memory is not a state. */
  readState(name: string): boolean | number | undefined;
  /** Snapshot of a declared byte memory. */
  readBytes(name: string): Uint8Array;
  /** Takes every committed record of a declared FIFO, leaving it empty. */
  readFifo(name: string): readonly Uint8Array[];
  /** Publishes a scalar payload on a declared output port. */
  publish(port: string, payload: TopicPayload): void;
  /** Publishes a byte payload on a declared output port. */
  publishBytes(port: string, bytes: Uint8Array): void;
}

/** Flat lifecycle bindings returned by a device factory (#8). */
export interface DeviceBindings {
  readonly initialize?: LifecycleRef<readonly []>;
  readonly reset?: LifecycleRef<readonly []>;
  readonly onDispose?: () => void;
  /** Step start hook (RFC 0017): runs before the step's evaluation rounds. */
  readonly applyInputs?: (io: DeviceInputIO) => void;
  /** Step end hook (RFC 0017): runs after evaluation; its publishes use the step's end time. */
  readonly flushOutputs?: (io: DeviceOutputIO) => void;
}

/**
 * Synchronous device factory. It runs once per instance, builds the static IR, registers message
 * listeners and returns the lifecycle bindings. Pin, observation and connection author surfaces
 * are exposed through {@link DeviceAPI.ir} and the builder.
 */
export type DeviceFactory = (api: DeviceAPI) => DeviceBindings;

/**
 * Codes the device runtime emits itself (RFC 0017). `io.report` may carry any business code, so
 * {@link DeviceDiagnostic.code} stays an open string.
 */
export type DeviceDiagnosticCode =
  | 'device/memory-unknown'
  | 'device/memory-kind'
  | 'device/memory-type'
  | 'device/fifo-record'
  | 'device/port-unused'
  | 'device/topic-unknown'
  | 'device/topic-direction'
  | 'device/topic-rejected'
  | 'topic/backpressure'
  | 'topic/mixed-read';

/** A runtime violation RFC 0017 reports instead of aborting the step. */
export interface DeviceDiagnostic {
  readonly code: DeviceDiagnosticCode | (string & {});
  readonly message: string;
  readonly deviceId?: string;
  readonly port?: string;
  readonly memory?: string;
}

/** Observable lifecycle state of an installed device instance. */
export type DeviceInstanceState = 'initializing' | 'ready' | 'faulted' | 'destroying' | 'destroyed';

/** Bounded admission limits for the instance's messaging bridge. */
export interface DeviceMessagingOptions {
  /** In-flight `post` + `postBytes` entries; default 64. */
  readonly postCapacity?: number;
  /** Accepted-but-unconsumed `publish` messages; default 64. */
  readonly publishCapacity?: number;
  /** Input topic messages waiting for activation or a legal boundary; default 64. */
  readonly deliveryCapacity?: number;
  /** Pending `updateBytes` requests; default 64. */
  readonly updateCapacity?: number;
  /** Total captured byte-output payload budget; default 65536. */
  readonly outputByteBudget?: number;
}

/** One accepted `api.publish` message delivered to the host sink. */
export interface DeviceTopicMessage {
  readonly port: string;
  readonly payload: TopicPayload;
}

/**
 * Public power/electrical capabilities consumed by pin I/O (#51). `PowerRuntime` satisfies this
 * interface structurally; the device layer never owns domains, thresholds or gating state.
 */
export interface DevicePinHost {
  pinIntent(pin: TopologyPinRef): ElectricalPinInput;
  updatePinStates(states: readonly ElectricalPinInput[]): void;
  sampleDigital(pin: TopologyPinRef): PowerDigitalSample;
  /**
   * Change-only digital pin notification required by observation bindings. The returned disposer
   * must be idempotent. Hosts without observation support may omit it.
   */
  addDigitalPinObserver?(observer: PowerDigitalPinObserver): () => void;
}

/** Host options for {@link createDeviceInstance}. */
export interface DeviceInstanceOptions {
  /** Scheduler instance identity; must be unique for the scheduler's lifetime. */
  readonly instanceId: string;
  /** Instance property overrides resolved against the device description. */
  readonly properties?: Readonly<Record<string, PropertyValue>>;
  /** Bounded messaging limits; omitted values use the documented defaults. */
  readonly messaging?: DeviceMessagingOptions;
  /**
   * Declared byte resource names that this instance additionally authorizes for
   * `api.updateBytes`. Writable bytes remain authorized by default; this list grants the
   * independent update path to `readonly` resources without making ordinary guest stores legal.
   */
  readonly updateResources?: readonly string[];
  /** Synchronous host consumer for `api.publish`; omitted messages are dropped at a boundary. */
  readonly onTopic?: (message: DeviceTopicMessage) => void;
  /**
   * Receives the diagnostics RFC 0017 requires instead of aborting a step: misused `io`
   * references, hook-side backpressure, `io.report` calls and the unused-port notice. A throwing
   * sink is ignored.
   */
  readonly onDiagnostic?: (diagnostic: DeviceDiagnostic) => void;
  /** Held-intent and gated-sampling source for declared pins; required by pin instructions. */
  readonly pinHost?: DevicePinHost;
  /**
   * Connection topology bound to this instance. Required when the IR applies connections;
   * the topology must share this instance's scheduler and outlive the instance.
   */
  readonly connections?: DeviceConnectionOptions;
}

/**
 * Installed device instance. The kernel owns IR execution; the host drives the scheduler passed
 * to {@link createDeviceInstance} and delivers input topics through {@link deliver}.
 */
export interface DeviceInstance {
  readonly instanceId: string;
  readonly deviceId: string;
  readonly description: DeviceDescription;
  readonly props: DevicePropertySnapshot;
  readonly state: DeviceInstanceState;
  /**
   * Guarded access to the instance's kernel storage. Every accessor throws
   * `device/instance-destroyed` after destruction, and the guard drops its own reference so a
   * retained handle cannot keep the kernel storage reachable.
   */
  readonly storage: IRStorage;
  /** Request the bound reset lifecycle work. Rejects unsupported or illegal states. */
  reset(): void;
  /** Destroy the kernel instance, release its work/storage and notify `onDispose` once. */
  destroy(): void;
  /**
   * Deliver one input topic message. During initialization it is staged in the bounded input
   * queue; after activation listeners start in acceptance order.
   */
  deliver(port: string, payload: TopicPayload, meta: TopicMetadata): void;
  /**
   * Runs the `applyInputs` hook for the step that is starting (RFC 0017); a no-op when the device
   * declares no hook. The hook sees what {@link deliver} staged since the previous step.
   */
  applyInputs(): void;
  /**
   * Runs the `flushOutputs` hook for the step that just ended (RFC 0017); a no-op when the device
   * declares no hook. Publishes reach `onTopic` before this call returns.
   */
  flushOutputs(): void;
}

/**
 * Host-side source of device modules. The provider owns device id resolution, file location,
 * reading and missing-file diagnostics; the device package never scans or locates files.
 */
export interface IDeviceProvider {
  /** @returns `undefined` when `deviceId` is unknown. */
  resolve(deviceId: string): DeviceDefinition | undefined | Promise<DeviceDefinition | undefined>;
}

/** Result of loading one device module through a provider. */
export interface LoadedDeviceModule {
  readonly deviceId: string;
  readonly description: DeviceDescription;
  readonly factory: DeviceFactory;
}

/** Independent, recursively frozen property snapshot for one device instance (#7 / #8). */
export type DevicePropertySnapshot = Readonly<Record<string, PropertyValue>>;
