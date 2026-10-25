import type {
  ArrayRef,
  BytesRef,
  EntryRef,
  FunctionBuilder,
  FunctionRef,
  IRModule,
  IRValidationOptions,
  OutputRef,
  ScalarType,
  Value,
} from '@mica-js/ir';
import type { TopicPayloadType } from '@mica-js/device';
import type { PinModeName, PinPull, PinPullName } from '../pin-space';

/**
 * Types for the unified IR compiler (U01).
 *
 * The compiler turns several device descriptions plus a pin-to-pin netlist into
 * one `@mica-js/ir` module. Device logic, the electrical solve and the main
 * loop all share one global pin space, one state space and one engine entry, so
 * a tick costs one interpreter/JIT call for the whole circuit.
 *
 * The shared constants (`UNIFIED_PIN_CAPACITY`, `DEVICE_PIN_STRIDE`, `PIN_MODE`,
 * `PIN_PULL`) live in `../pin-space` and are reused here; the built-in `mcu` /
 * `led` kernels in `device-gen.ts` are the reference implementations.
 */

/** Electrical intent of one device pin. */
export type DevicePinDirection = 'input' | 'output' | 'bidirectional' | 'passive';

/** Payload type of one logical topic port; shared with the schematic format. */
export type DevicePortPayloadType = TopicPayloadType;

/** Direction of one logical topic port. */
export type DeviceTopicDirection = 'input' | 'output';

/**
 * One logical topic port of a device.
 *
 * Output ports become IR `bridge.send` endpoints the device behaviour can
 * write; input ports become IR entries the host calls when a payload is
 * delivered. Ports carry no electrical meaning: they are the device-to-device
 * message channel, not a net.
 */
export interface DevicePortDescription {
  readonly direction: DeviceTopicDirection;
  readonly type: DevicePortPayloadType;
  readonly title?: string;
}

/**
 * Declared topic ports of one device. A `Map` keeps duplicate names impossible
 * and an object keeps authored descriptions terse, mirroring
 * {@link DevicePinMap}.
 */
export type DevicePortMap =
  ReadonlyMap<string, DevicePortDescription> | Readonly<Record<string, DevicePortDescription>>;

/** Role a pin plays on its net; v1 supports one driver per net. */
export type CompiledPinRole = 'driver' | 'load';

/** One pin declared by a device description. */
export interface DevicePinDescription {
  /** Defaults to `'passive'`: the pin only senses the net. */
  readonly direction?: DevicePinDirection;
  /** Overrides the role derived from `direction`. */
  readonly role?: CompiledPinRole;
  /** Purely informational kind, e.g. `'signal'`, `'power'`, `'gnd'`. */
  readonly kind?: string;
  /**
   * Power domain gating this pin (RFC 0007). Defaults to the device's primary
   * domain (the first one it declares); an explicit name must be declared by
   * `DeviceDescription.powerDomains`.
   */
  readonly powerDomain?: string;
}

/**
 * Declared pins of one device. A `Map` keeps duplicate names impossible and an
 * object keeps authored descriptions terse; both preserve declaration order.
 */
export type DevicePinMap =
  ReadonlyMap<string, DevicePinDescription> | Readonly<Record<string, DevicePinDescription>>;

/** One scalar internal state of a device, allocated in the global state space. */
export interface DeviceStateDescription {
  readonly type: ScalarType;
  readonly initial: boolean | number;
}

/**
 * One power domain a device declares (RFC 0007).
 *
 * The domain is one `bool` in `power_ready`: `true` while powered, `false`
 * after `turnOff`. `voltage` is the nominal supply; the RFC 0002 voltage solver
 * uses it as the high level of every pin bound to the domain and to seed the
 * pin's default thresholds.
 */
export interface PowerDomainDescription {
  readonly name: string;
  /** Nominal supply voltage in volts. */
  readonly voltage: number;
}

/**
 * One switchable internal connection of a device: the dynamic counterpart of a
 * `CircuitCompilationInput.connections` wire.
 *
 * The two pins are separate nets while the switch is open and one merged net
 * while it is closed. `initial` seeds the `connection_states` array, so a
 * normally-closed pole conducts from the very first tick.
 */
export interface DeviceConnectionDescription {
  /** The two device pins the switch joins when closed. */
  readonly pins: readonly [string, string];
  /** State at `t = 0`. Defaults to `'open'`, like a push button. */
  readonly initial?: 'open' | 'closed';
}

/**
 * Declared switchable connections of one device. Mirrors {@link DevicePinMap}:
 * a `Map` or a plain object, both preserving declaration order.
 */
export type DeviceConnectionMap =
  | ReadonlyMap<string, DeviceConnectionDescription>
  | Readonly<Record<string, DeviceConnectionDescription>>;

/** Edge a digital observation reacts to. */
export type DeviceObserveEdge = 'rising' | 'falling' | 'both';

/**
 * One digital observation of a device: a trigger pin whose solved level is
 * compared against a per-observer baseline at the end of every tick.
 *
 * `captures` are the pins sampled (from `pin_input`) when the edge fires; the
 * captured levels become the parameters of the observer handler.
 */
export interface DeviceObserverDescription {
  /** Pin whose solved level is watched. */
  readonly trigger: string;
  /** Pins sampled on the edge; defaults to `[trigger]`. */
  readonly captures?: readonly string[];
  /** Edge polarity; defaults to `'both'`. */
  readonly edges?: DeviceObserveEdge;
}

/** Declared observations of one device, in declaration order. */
export type DeviceObserverMap =
  | ReadonlyMap<string, DeviceObserverDescription>
  | Readonly<Record<string, DeviceObserverDescription>>;

/**
 * Argument of `pin.configure`.
 *
 * The numeric form (`PIN_MODE.pushPull`) keeps the low-level device kernels
 * terse; the authored names and the `{ mode }` object are what device authors
 * write. Omitting `mode` configures nothing. The object form also carries the
 * RFC 0002 §4.6 thresholds of an analog-capable pin, in volts.
 */
export type DevicePinConfigureMode =
  | number
  | PinModeName
  | {
      readonly mode?: PinModeName | undefined;
      /** Voltage below which the pin reads digital 0. */
      readonly lowThreshold?: number | undefined;
      /** Voltage above which the pin reads digital 1. */
      readonly highThreshold?: number | undefined;
    };

/** Pin operations a behavior may use; each call inlines into global memory. */
export interface DevicePinHandle {
  readonly name: string;
  readonly globalId: number;
  /** `pin.configure`: writes `pin_mode` and, optionally, the two thresholds. */
  configure(mode: DevicePinConfigureMode): void;
  /**
   * `pin.pull`: writes `pin_pull[globalId]`.
   *
   * The bias is independent of the drive mode, the output latch and the
   * digital intent: a released net with a pull-up reads high, a strong driver
   * always wins over it (RFC 0002).
   */
  pull(mode: PinPullName | PinPull): void;
  /** `pin.write_digital`: writes `pin_output[globalId]`. */
  writeDigital(level: Value<'bool'>): void;
  /**
   * `pin.write_analog`: writes `pin_voltage_intent[globalId]`, enables the
   * output latch and switches the pin to `analog` drive mode (RFC 0002 §5).
   *
   * The intent is a voltage in volts. The next electrical solve arbitrates it
   * against rails and other drivers. Only `writeAnalog` enables the drive:
   * `pin.configure({ mode: 'analog' })` alone keeps the pin released, so a
   * bidirectional pin can read an analog net with custom thresholds without
   * fighting its driver.
   */
  writeAnalog(voltage: Value<'f32'> | number): void;
  /** `pin.sample_digital`: reads the solved `pin_input[globalId]`. */
  sampleDigital(): Value<'bool'>;
  /** `pin.sample_analog`: reads the solved `pin_voltage[globalId]` in volts. */
  sampleAnalog(): Value<'f32'>;
  /** Reads the device's own `pin_output[globalId]`. */
  readDrivenDigital(): Value<'bool'>;
}

/**
 * Ordered pins of one device addressed as one bit field (RFC 0004).
 *
 * The first name of the group is the least significant bit, so
 * `['D0', 'D1', 'D2']` maps the value `0b101` to `D0 = 1`, `D1 = 0`,
 * `D2 = 1`. A group is always bound to the builder of the phase (or topic
 * handler) that created it, exactly like {@link DevicePinHandle}.
 */
export interface DevicePinGroupApi {
  /** Pin names in group order; index `i` is bit `i`. */
  readonly names: readonly string[];
  /** Global pin ids in group order, one per name. */
  readonly globalIds: readonly number[];
  /**
   * `pin.write_digital` for every member, LSB first.
   *
   * A `number` is a compile-time constant in `[0, 2^32 - 1]`; an IR value must
   * be `u32`.
   */
  writeDigital(value: Value<'u32'> | number): void;
  /** Reads every solved member level into one `u32`, LSB first. */
  readDigital(): Value<'u32'>;
  /**
   * One member pin, bound to the same builder as the group.
   *
   * @throws {UnifiedIRCompilerError} `pin-not-found` when the name is not part
   *   of the group.
   */
  pin(name: string): DevicePinHandle;
}

/** Internal state slot a behavior may read and write. */
export interface DeviceStateHandle<T extends ScalarType = ScalarType> {
  readonly name: string;
  readonly type: T;
  /** Index inside the generated `device_state_<type>` array. */
  readonly index: number;
  load(): Value<T>;
  store(value: Value<T>): void;
}

/**
 * One `connection.apply` entry: a declared switch and the level it should take.
 *
 * A `boolean` is a compile-time constant, which lets the lowering eliminate the
 * `connection_states` round-trip entirely (a statically open contact costs no
 * instruction at all).
 */
export interface DeviceConnectionEntry {
  /** Name of a connection declared by the device description. */
  readonly connection: string;
  readonly closed: Value<'bool'> | boolean;
}

/** `connection.apply` surface: one atomic patch of switch states. */
export interface DeviceConnectionApi {
  /**
   * Lowers one atomic patch into `array.store` + the affected net propagation.
   * Every entry is validated against the device's declarations.
   */
  apply(entries: readonly DeviceConnectionEntry[]): void;
  /** Convenience wrapper for a single connection. */
  set(connection: string, closed: Value<'bool'> | boolean): void;
}

/** Body of one observation handler, generated once per `observe.configure`. */
export type DeviceObserverHandler = (
  api: DeviceBehaviorApi,
  captured: readonly Value<'bool'>[],
) => void;

/** Options of one `observe.configure` call. */
export interface DeviceObserveOptions {
  /** Activates the observer. Defaults to `true`; `false` lowers to nothing. */
  readonly enabled?: boolean;
  /** Overrides the edge declared by the description. */
  readonly edges?: DeviceObserveEdge;
  /** Runs inside the main loop when the edge fires. */
  readonly handler: DeviceObserverHandler;
}

/** `observe.configure` surface. */
export interface DeviceObserveApi {
  /** Enables one declared observation and installs its edge handler. */
  configure(name: string, options: DeviceObserveOptions): void;
}

/** One pin as seen by a device kernel factory (no builder attached yet). */
export interface DeviceKernelPin {
  readonly name: string;
  readonly globalPinId: number;
  readonly role: CompiledPinRole;
}

/**
 * Everything a complex device kernel needs to declare its own IR before any
 * phase function body is opened: the module (for `array`/`bytes`/`provider`),
 * the shared pin memories and the allocated pin ids.
 */
export interface DeviceKernelContext {
  readonly deviceId: string;
  readonly config: Readonly<Record<string, unknown>> | undefined;
  readonly module: IRModule;
  readonly memory: CompiledCircuitMemory;
  readonly pins: readonly DeviceKernelPin[];
}

/**
 * Direct phase refs a complex kernel may return instead of behaviour hooks.
 * The compiler then uses these functions as the device's loop entries, with
 * no wrapper phase around them.
 */
export interface DeviceKernelRuntime {
  readonly initialize?: FunctionRef<readonly [], readonly []>;
  readonly tick?: FunctionRef<readonly [], readonly []>;
  readonly update?: FunctionRef<readonly [], readonly []>;
}

/**
 * Builds the phase hooks of a complex device after resource allocation but
 * before phase functions are generated. Declaring arrays, byte memories and
 * providers is only legal here (never inside a function body).
 *
 * Returning {@link DeviceKernelRuntime} lets the kernel own its phase
 * functions directly; returning {@link DeviceBehaviors} asks the compiler to
 * generate `<id>_initialize` / `<id>_tick` / `<id>_update` wrappers.
 */
export type DeviceKernelFactory = (
  context: DeviceKernelContext,
) => DeviceBehaviors | DeviceKernelRuntime;

/**
 * Build surface handed to one topic entry handler.
 *
 * Every handle is bound to the entry's own builder (never to the phase that
 * registered the handler), so a handler can write device state and pins without
 * reaching for a builder that already closed.
 */
export interface DeviceTopicHandlerApi {
  readonly deviceId: string;
  readonly builder: FunctionBuilder<readonly []>;
  readonly module: IRModule;
  readonly config: Readonly<Record<string, unknown>> | undefined;
  /** Entry parameters in declaration order — one per IR scalar of the payload. */
  readonly args: readonly Value<ScalarType>[];
  /** Switchable connections, lowered at generation time. */
  readonly connection: DeviceConnectionApi;
  pin(name: string): DevicePinHandle;
  /**
   * Ordered subset of the device pins addressed as one bit field (RFC 0004).
   *
   * @throws {UnifiedIRCompilerError} when a name is undeclared, repeated, or
   *   the group holds more than 32 pins.
   */
  pinGroup(names: readonly string[]): DevicePinGroupApi;
  state<T extends ScalarType = ScalarType>(name: string): DeviceStateHandle<T>;
}

/** Body of one topic input entry. */
export type DeviceTopicHandler = (api: DeviceTopicHandlerApi) => void;

/**
 * Topic surface of one device behavior.
 *
 * `publish` writes the output endpoint of `port` from the running phase;
 * `subscribe` fills the input entry of `port`, which the runtime calls with the
 * decoded payload scalars. Both reserve the port's declaration in
 * `description.ports`, so an undeclared port is a compile error.
 */
export interface DeviceTopicApi {
  /**
   * Emits one output endpoint; `args` follow the port's payload encoding.
   *
   * @param port - The port name to publish to.
   * @param args - Payload values in declaration order.
   * @param condition - Optional boolean condition; publish only when true.
   *   Defaults to always publishing. Use this to avoid emitting unchanged data.
   */
  publish(port: string, args: readonly Value<ScalarType>[], condition?: Value<'bool'>): void;
  /**
   * Registers the handler of one input endpoint. The body is generated after
   * the phase bodies close, so it may declare its own builder instructions.
   */
  subscribe(port: string, handler: DeviceTopicHandler): void;
}

/** Build surface handed to one device behavior. */
export interface DeviceBehaviorApi {
  readonly deviceId: string;
  readonly builder: FunctionBuilder<readonly []>;
  /** Topic endpoints of this device, resolved at compile time. */
  readonly topics: DeviceTopicApi;
  /**
   * Switchable connections of this device. `apply` lowers at generation time,
   * so a closed contact becomes direct `pin_input` stores — never an executor
   * call.
   */
  readonly connection: DeviceConnectionApi;
  /** Digital observations of this device, lowered into the main loop. */
  readonly observe: DeviceObserveApi;
  /**
   * Module the phase is generated into. Complex devices use it to declare
   * their own typed arrays (`module.array`, `module.bytes`) and providers;
   * simple devices never need to touch it.
   */
  readonly module: IRModule;
  /** Shared `pin_mode` / `pin_output` / `pin_input` memories. */
  readonly memory: CompiledCircuitMemory;
  /** Instance configuration from {@link DeviceConfig.config}. */
  readonly config: Readonly<Record<string, unknown>> | undefined;
  /** Every declared pin of the device, in declaration order. */
  readonly pins: readonly DevicePinHandle[];
  /** Pins whose role is `driver`. */
  readonly outputs: readonly DevicePinHandle[];
  pin(name: string): DevicePinHandle;
  /**
   * Ordered subset of the device pins addressed as one bit field (RFC 0004).
   *
   * @throws {UnifiedIRCompilerError} when a name is undeclared, repeated, or
   *   the group holds more than 32 pins.
   */
  pinGroup(names: readonly string[]): DevicePinGroupApi;
  state<T extends ScalarType = ScalarType>(name: string): DeviceStateHandle<T>;
}

/**
 * Structural surface every device accessor exposes.
 *
 * The compiler keeps this declaration independent from the runtime's
 * `DeviceAccessor` so a device kernel can ship its own typed accessor without
 * making the compiler depend on the runtime module.
 */
export interface DeviceAccessorSurface {
  readonly deviceId: string;
  readonly type: string;
  readonly pinNames: readonly string[];
  readonly stateNames: readonly string[];
  readPin(pinName: string): boolean;
  writePin(pinName: string, value: boolean): void;
  getState(name: string): unknown;
  setState(name: string, value: unknown): void;
}

/** Host services handed to a device accessor factory at circuit creation. */
export interface DeviceAccessorFactoryContext {
  readonly deviceId: string;
  /** Live engine storage (`IRStorage` in practice). */
  readonly storage: unknown;
  /** Throws once the owning circuit has been disposed. */
  readonly assertActive: () => void;
  /** Advances the owning circuit by one tick. */
  readonly step: () => void;
  /** Advances the owning circuit by `count` ticks. */
  readonly runBatch: (count: number) => void;
}

/**
 * Builds the typed accessor of a device after its module is compiled.
 *
 * A description that supplies `accessor` replaces the generic accessor the
 * runtime would otherwise synthesize from `type`. The factory runs once per
 * circuit and closes over the layout its IR factory allocated.
 */
export type DeviceAccessorFactory = (
  context: DeviceAccessorFactoryContext,
) => DeviceAccessorSurface;

/**
 * Per-device behavior hooks. The compiler emits one IR function per hook:
 * `initialize` -> `<id>_initialize`, `tick` -> `<id>_tick`,
 * `update` -> `<id>_update`. Missing hooks simply produce no function.
 */
export interface DeviceBehaviors {
  readonly initialize?: (api: DeviceBehaviorApi) => void;
  readonly tick?: (api: DeviceBehaviorApi) => void;
  readonly update?: (api: DeviceBehaviorApi) => void;
}

/** IR-level device description consumed by the compiler. */
export interface DeviceDescription {
  readonly name?: string;
  readonly pins: DevicePinMap;
  /** Switchable internal connections (contacts, relay poles). */
  readonly connections?: DeviceConnectionMap;
  /** Digital observations lowered into the main loop. */
  readonly observers?: DeviceObserverMap;
  /** Logical topic ports; each output becomes an IR output, each input an IR entry. */
  readonly ports?: DevicePortMap;
  readonly states?: Readonly<Record<string, DeviceStateDescription>>;
  /**
   * Power domains the device declares (RFC 0007), in declaration order.
   *
   * The first entry is the device's primary domain: it gates the device's own
   * `tick`/`update` phases, and it is the domain every pin without an explicit
   * `powerDomain` binds to. `voltage` drives the RFC 0002 voltage solver and
   * seeds the pin thresholds.
   */
  readonly powerDomains?: readonly PowerDomainDescription[];
  readonly behaviors?: DeviceBehaviors;
  /**
   * Complex-kernel hook. Runs once per module before phase generation so the
   * kernel may declare typed arrays, byte memories and providers, then return
   * the behaviour hooks the compiler should call inside each phase.
   */
  readonly kernel?: DeviceKernelFactory;
  /**
   * Optional typed accessor factory. Complex kernels (an MCU with its own
   * register file, memory and NVIC) use it to expose a richer surface than
   * the generic state/pin accessor.
   */
  readonly accessor?: DeviceAccessorFactory;
  /**
   * Read-only byte regions the kernel wants host updates for. The compiler
   * grants `update` access on top of the normal `read` grant so kernels can
   * expose firmware patching without allowing guest stores.
   */
  readonly updateResources?: readonly BytesRef[];
}

/** One device instance of the circuit. */
export interface DeviceConfig {
  /** Circuit-unique identity; prefix of every generated function name. */
  readonly id: string;
  /** Device type, e.g. `'teaching-mcu'`; selects a built-in kernel when present. */
  readonly type: string;
  readonly description: DeviceDescription;
  /** Instance configuration; reserved for device kernels that take parameters. */
  readonly config?: Readonly<Record<string, unknown>>;
}

/** One pin-to-pin (or pin-to-rail) connection. */
export interface Connection {
  /** `'mcu1.PA0'` or a rail name such as `'GND'`. */
  readonly from: string;
  readonly to: string;
}

/** Options for the compiler. */
export interface CircuitCompilationOptions {
  /** Named fixed-level rails; merged over `GND`/`VCC`/`VDD`. */
  readonly rails?: Readonly<Record<string, boolean>>;
  /**
   * Nominal supply voltage in volts (RFC 0002 §5). Used for pins that belong
   * to no power domain and for rails whose name carries no voltage. Defaults
   * to 3.3 V.
   */
  readonly supplyVoltage?: number;
  /**
   * Accept nets with more than one driver pin and solve them as a wired-OR.
   * Defaults to `false`, which reports a `driver-conflict` instead.
   */
  readonly allowMultiDriver?: boolean;
  /** Runs `validateIR` over the generated module. Defaults to `true`. */
  readonly validate?: boolean;
  /** Overrides for the generated entry-point names. */
  readonly entryPointNames?: {
    readonly tick?: string;
    readonly initialize?: string;
    readonly batch?: string;
  };
}

/** Compiler input: devices plus the connections between their pins. */
export interface CircuitCompilationInput {
  readonly devices: readonly DeviceConfig[];
  readonly connections: readonly Connection[];
}

/** One resolved pin in the global pin space. */
export interface ResolvedDevicePin {
  readonly name: string;
  readonly deviceId: string;
  readonly globalPinId: number;
  readonly direction: DevicePinDirection;
  readonly role: CompiledPinRole;
  /** Whether the device reads the solved value of this pin. */
  readonly senses: boolean;
}

/** Pins of one device mapped into the global pin space. */
export interface DevicePinAllocation {
  readonly deviceId: string;
  /** First global pin id of the device. */
  readonly offset: number;
  readonly pins: ReadonlyMap<string, number>;
  readonly resolved: ReadonlyMap<string, ResolvedDevicePin>;
}

/** Result of the global pin allocation. */
export interface GlobalPinMap {
  /** `'mcu1.PA0'` -> global pin id. */
  readonly pins: ReadonlyMap<string, number>;
  readonly devices: ReadonlyMap<string, DevicePinAllocation>;
  readonly totalPins: number;
  readonly capacity: number;
}

/** One device state slot inside the global state space. */
export interface DeviceStateSlot {
  readonly name: string;
  readonly deviceId: string;
  readonly type: ScalarType;
  /** Generated array that holds the slot. */
  readonly array: ArrayRef;
  /** Index inside {@link array}. */
  readonly index: number;
  /** Ordinal in the whole state space, across scalar types. */
  readonly slot: number;
}

/** Result of the global state allocation. */
export interface GlobalStateMap {
  readonly devices: ReadonlyMap<string, ReadonlyMap<string, DeviceStateSlot>>;
  /** One generated array per scalar type actually used. */
  readonly arrays: ReadonlyMap<ScalarType, ArrayRef>;
  /** Slot count per scalar type. */
  readonly totals: ReadonlyMap<ScalarType, number>;
  readonly totalStates: number;
}

/** One declared switch resolved into `connection_states`. */
export interface DeviceConnectionSlot {
  readonly name: string;
  readonly deviceId: string;
  /** Index inside the `connection_states` array. */
  readonly index: number;
  /** Global pin id of `pins[0]`. */
  readonly fromPinId: number;
  /** Global pin id of `pins[1]`. */
  readonly toPinId: number;
  /** Level seeded into `connection_states`. */
  readonly initialClosed: boolean;
}

/** Every declared switch of the circuit. */
export interface GlobalConnectionMap {
  readonly devices: ReadonlyMap<string, ReadonlyMap<string, DeviceConnectionSlot>>;
  /** Every switch, in declaration order. */
  readonly slots: readonly DeviceConnectionSlot[];
  readonly totalConnections: number;
}

/** One declared observation resolved into `observe_baselines`. */
export interface DeviceObserverSlot {
  readonly name: string;
  readonly deviceId: string;
  /** Index inside the `observe_baselines` array. */
  readonly index: number;
  readonly triggerPinId: number;
  /** Global pin ids sampled when the edge fires. */
  readonly capturePinIds: readonly number[];
  readonly edges: DeviceObserveEdge;
}

/** Every declared observation of the circuit. */
export interface GlobalObserverMap {
  readonly devices: ReadonlyMap<string, ReadonlyMap<string, DeviceObserverSlot>>;
  /** Every observer, in declaration order. */
  readonly slots: readonly DeviceObserverSlot[];
  readonly totalObservers: number;
}

/** One declared power domain resolved into the `power_ready` array. */
export interface DevicePowerDomainSlot {
  readonly name: string;
  readonly deviceId: string;
  /** Index inside `power_ready`. */
  readonly index: number;
  /** Nominal supply voltage in volts: high level of every pin in the domain. */
  readonly voltage: number;
}

/** Every declared power domain of the circuit (RFC 0007). */
export interface GlobalPowerDomainMap {
  readonly devices: ReadonlyMap<string, ReadonlyMap<string, DevicePowerDomainSlot>>;
  /** Every domain, in declaration order across devices. */
  readonly slots: readonly DevicePowerDomainSlot[];
  readonly totalDomains: number;
  /** Global pin id -> index of the domain gating that pin. */
  readonly pinDomains: ReadonlyMap<number, number>;
  /** Device id -> index of its primary (first declared) domain. */
  readonly primary: ReadonlyMap<string, number>;
}

/** Pin memories every device and every net solver shares. */
export interface CompiledCircuitMemory {
  readonly mode: ArrayRef<'u8'>;
  readonly output: ArrayRef<'bool'>;
  readonly input: ArrayRef<'bool'>;
  /**
   * One `PIN_PULL` value per global pin: the weak bias of the pin, independent
   * of its drive mode. `undefined` only for memories built before RFC 0002.
   */
  readonly pull?: ArrayRef<'u8'>;
  /**
   * One `bool` per declared switch; `undefined` when the circuit declares no
   * connections. Seeded from `DeviceConnectionDescription.initial`.
   */
  readonly connectionStates?: ArrayRef<'bool'>;
  /**
   * One `bool` per declared observation: the level the trigger pin had at the
   * previous tick. `undefined` when the circuit declares no observers.
   */
  readonly observeBaselines?: ArrayRef<'bool'>;
  /**
   * One `bool` per declared power domain, seeded `true` so every domain starts
   * powered. `undefined` when no device declares a domain (RFC 0007).
   */
  readonly powerReady?: ArrayRef<'bool'>;
  /**
   * One `f32` per global pin: the voltage the node settled at during the last
   * solve, in volts (RFC 0002 §4.3). `undefined` only for memories built
   * before the analog model.
   */
  readonly voltage?: ArrayRef<'f32'>;
  /**
   * One `f32` per global pin: the analog output intent written by
   * `pin.writeAnalog`, in volts (RFC 0002 §5).
   */
  readonly voltageIntent?: ArrayRef<'f32'>;
  /**
   * One `f32` per global pin: the voltage below which the pin reads digital 0
   * (RFC 0002 §4.6). Seeded per pin from its domain supply.
   */
  readonly lowThreshold?: ArrayRef<'f32'>;
  /** One `f32` per global pin: the voltage above which the pin reads digital 1. */
  readonly highThreshold?: ArrayRef<'f32'>;
  /**
   * One `u8` fault slot (`ELECTRICAL_FAULT`). A strong-drive conflict latches
   * `conflict`, and the main loop then pauses before any device sees the tick.
   */
  readonly electricalFault?: ArrayRef<'u8'>;
}

/** One pin resolved onto a net. */
export interface CompiledPinConnection {
  /** `'mcu1.PA0'`. */
  readonly endpoint: string;
  readonly deviceId: string;
  readonly pinName: string;
  readonly globalPinId: number;
  readonly role: CompiledPinRole;
  readonly senses: boolean;
}

/** One fixed-level rail on a net, e.g. `GND` (low) or `VCC` (high). */
export interface CompiledRail {
  readonly name: string;
  readonly level: boolean;
}

/**
 * RFC 0002 §4.5 — the floating sample of one compiled circuit.
 *
 * A net with no strong driver and no rail is not held at any level, so an
 * unbiased one samples {@link sampleFloating} instead of reading a constant.
 * The seed is a hash of the netlist (topology-dependent), and the clock is the
 * `u32 × 2` picosecond counter the main loop advances once per tick.
 */
export interface CompiledFloating {
  /** Deterministic seed derived from the compiled topology. */
  readonly seed: number;
  /** Net ids whose level comes from the floating sample. */
  readonly nets: readonly number[];
  /**
   * `[low, high]` words of the sample clock in picoseconds, advanced by the
   * main loop. `undefined` when no net floats, so the memory layout of a
   * circuit without floating nets is unchanged.
   */
  readonly clock?: ArrayRef<'u32'>;
}

/** Where a net's level comes from. */
export type CompiledNetSource = 'driver' | 'rail' | 'floating';

/** One electrical net: a connected component of pins and rails. */
export interface CompiledNet {
  readonly netId: number;
  readonly pins: readonly CompiledPinConnection[];
  readonly rails: readonly CompiledRail[];
  readonly drivers: readonly CompiledPinConnection[];
  /** Pins whose role is `load`. */
  readonly loads: readonly CompiledPinConnection[];
  /** Every pin that reads the solved level, including bidirectional drivers. */
  readonly sinks: readonly CompiledPinConnection[];
  readonly source: CompiledNetSource;
  /** Constant level of a driver-less net; unused when `source === 'driver'`. */
  readonly level: boolean;
}

/**
 * Diagnostic codes produced by the compiler.
 *
 * The electrical codes come from {@link NetworkTopologyAnalyzer}; the schematic
 * codes come from `compileSchematicToCircuit`, which reports what the sheet
 * could not express instead of throwing.
 */
export type CompilationDiagnosticCode =
  | 'driver-conflict'
  | 'power-short'
  | 'rail-conflict'
  | 'floating-net'
  | 'invalid-device-reference'
  | 'unknown-device'
  | 'invalid-property'
  | 'invalid-power-net'
  | 'invalid-ground-net'
  | 'unsupported-device'
  | 'invalid-topology';

export type CompilationDiagnosticSeverity = 'error' | 'warning';

/** One compilation finding; errors abort `compileCircuit` and `loadSchematic`. */
export interface CompilationDiagnostic {
  readonly code: CompilationDiagnosticCode;
  readonly severity: CompilationDiagnosticSeverity;
  readonly message: string;
  /** Electrical net the finding belongs to, when it is attributable to one. */
  readonly netId?: number | undefined;
  /** Endpoints (or rail names) the finding names. */
  readonly endpoints?: readonly string[];
  /** Symbol the finding belongs to, when it is attributable to one. */
  readonly symbol?: string | undefined;
}

/** Result of the network topology analysis. */
export interface CompiledNetlist {
  readonly nets: readonly CompiledNet[];
  readonly diagnostics: readonly CompilationDiagnostic[];
}

/** Metadata of one compiled device. */
export interface DeviceMetadata {
  readonly deviceId: string;
  readonly type: string;
  /** First global pin id of the device. */
  readonly pinOffset: number;
  /** First slot ordinal of the device in the global state space. */
  readonly stateOffset: number;
  readonly pins: ReadonlyMap<string, number>;
  readonly states: ReadonlyMap<string, DeviceStateSlot>;
  /** Declared power domains of this device, in declaration order (RFC 0007). */
  readonly powerDomains: ReadonlyMap<string, DevicePowerDomainSlot>;
  /** Every IR function generated for this device. */
  readonly functions: readonly string[];
  readonly initialize: string | undefined;
  readonly tick: string | undefined;
  readonly update: string | undefined;
  /** Typed accessor factory supplied by the device description, if any. */
  readonly accessor: DeviceAccessorFactory | undefined;
  /** Kernel factory that generated the device's extra IR resources. */
  readonly kernel: DeviceKernelFactory | undefined;
}

/** Generated entry points, both by name and as executable refs. */
export interface CompiledEntryPoints {
  readonly tick: string;
  readonly initialize: string;
  readonly batch: string;
  readonly refs: {
    readonly tick: FunctionRef<readonly [], readonly []>;
    readonly initialize: FunctionRef<readonly [], readonly []>;
    readonly batch: FunctionRef<readonly ['u32'], readonly []>;
  };
}

/** One device topic port resolved to its IR endpoint. */
export interface CompiledTopicPort {
  readonly deviceId: string;
  readonly port: string;
  /** `<deviceId>.<port>`: the key `Circuit.deliverTopic` accepts. */
  readonly key: string;
  readonly direction: DeviceTopicDirection;
  readonly type: DevicePortPayloadType;
  readonly title?: string;
  /** IR scalar parameters of the payload encoding. */
  readonly params: readonly ScalarType[];
  /** Output endpoint of an `output` port. */
  readonly output: OutputRef | undefined;
  /** Input entry of an `input` port. */
  readonly entry: EntryRef | undefined;
}

/** Every topic endpoint of the compiled circuit. */
export interface CompiledTopics {
  readonly ports: readonly CompiledTopicPort[];
  readonly byKey: ReadonlyMap<string, CompiledTopicPort>;
}

/** The compiled circuit: one module for every device, net and the main loop. */
export interface CompiledCircuit {
  readonly module: IRModule;
  readonly entryPoints: CompiledEntryPoints;
  /** Topic endpoints of every device, in declaration order. */
  readonly topics: CompiledTopics;
  /** `'mcu1.PA0'` -> global pin id. */
  readonly pinMap: ReadonlyMap<string, number>;
  readonly deviceMap: ReadonlyMap<string, DeviceMetadata>;
  readonly netlist: CompiledNetlist;
  readonly pins: GlobalPinMap;
  readonly states: GlobalStateMap;
  /** Declared switches of every device, resolved into `connection_states`. */
  readonly connections: GlobalConnectionMap;
  /** Declared observations of every device, resolved into `observe_baselines`. */
  readonly observers: GlobalObserverMap;
  /** Declared power domains of every device, resolved into `power_ready`. */
  readonly powerDomains: GlobalPowerDomainMap;
  readonly memory: CompiledCircuitMemory;
  /** RFC 0002 §4.5 floating sample: topology seed, sampling nets and clock. */
  readonly floating: CompiledFloating;
  /** Validation grants covering every instruction and memory of the module. */
  readonly validation: IRValidationOptions;
  /** Device ids in dependency order (drivers before the devices they feed). */
  readonly executionOrder: readonly string[];
  /** Every generated function name, in definition order. */
  readonly functions: readonly string[];
}

/** Error codes raised by {@link UnifiedIRCompilerError}. */
export type UnifiedIRCompilerErrorCode =
  | 'invalid-input'
  | 'duplicate-device'
  | 'unknown-device'
  | 'pin-not-found'
  | 'state-not-found'
  | 'invalid-connection'
  | 'capacity-exceeded'
  | 'unsupported-device'
  | 'driver-conflict'
  | 'power-short'
  | 'rail-conflict'
  | 'invalid-ir';

export interface UnifiedIRCompilerErrorOptions {
  readonly deviceId?: string;
  readonly pinName?: string;
  readonly netId?: number;
  readonly diagnostics?: readonly CompilationDiagnostic[];
  readonly cause?: unknown;
}

/** Error raised while compiling a circuit. */
export class UnifiedIRCompilerError extends Error {
  override readonly name = 'UnifiedIRCompilerError';
  readonly code: UnifiedIRCompilerErrorCode;
  readonly deviceId: string | undefined;
  readonly pinName: string | undefined;
  readonly netId: number | undefined;
  readonly diagnostics: readonly CompilationDiagnostic[];

  constructor(
    code: UnifiedIRCompilerErrorCode,
    message: string,
    options: UnifiedIRCompilerErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.deviceId = options.deviceId;
    this.pinName = options.pinName;
    this.netId = options.netId;
    this.diagnostics = options.diagnostics ?? [];
  }
}

/** Options for {@link createMcuDescription}. */
export interface McuDescriptionOptions {
  /** Output pin names; defaults to `['PA0']`. */
  readonly pins?: readonly string[];
  /** Direction assigned to every declared pin; defaults to `'output'`. */
  readonly direction?: DevicePinDirection;
}

/** Options for {@link createLedDescription}. */
export interface LedDescriptionOptions {
  readonly anode?: string;
  readonly cathode?: string;
}
