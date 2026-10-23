import type { PayloadType } from '@mica-js/core/canvas';
import type { PropertyDescriptor, PropertyValue } from '@mica-js/core/schematic';
import type {
  ElectricalPinInput,
  PowerDigitalPinObserver,
  PowerDigitalSample,
  TopologyPinRef,
} from '@mica-js/core';
import type {
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

/** Instance declaration surface: core declarations plus this device's pins and connections. */
export interface DeviceIRDeclarations extends IRDeclarations {
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

/** Flat lifecycle bindings returned by a device factory (#8). */
export interface DeviceBindings {
  readonly initialize?: LifecycleRef<readonly []>;
  readonly reset?: LifecycleRef<readonly []>;
  readonly onDispose?: () => void;
}

/**
 * Synchronous device factory. It runs once per instance, builds the static IR, registers message
 * listeners and returns the lifecycle bindings. Pin, observation and connection author surfaces
 * are exposed through {@link DeviceAPI.ir} and the builder.
 */
export type DeviceFactory = (api: DeviceAPI) => DeviceBindings;

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
