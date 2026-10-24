import type {
  ArrayRef,
  BytesRef,
  FunctionBuilder,
  FunctionRef,
  IRModule,
  IRValidationOptions,
  ScalarType,
  Value,
} from '@mica-js/ir';

/**
 * Types for the unified IR compiler (U01).
 *
 * The compiler turns several device descriptions plus a pin-to-pin netlist into
 * one `@mica-js/ir` module. Device logic, the electrical solve and the main
 * loop all share one global pin space, one state space and one engine entry, so
 * a tick costs one interpreter/JIT call for the whole circuit.
 *
 * The shared constants (`UNIFIED_PIN_CAPACITY`, `DEVICE_PIN_STRIDE`, `PIN_MODE`)
 * live in `../types` and are reused here; the prototype's MCU/LED generators in
 * `../device-mcu.ts` / `../device-led.ts` are the reference implementations the
 * generic device generator is extracted from.
 */

/** Electrical intent of one device pin. */
export type DevicePinDirection = 'input' | 'output' | 'bidirectional' | 'passive';

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

/** Pin operations a behavior may use; each call inlines into global memory. */
export interface DevicePinHandle {
  readonly name: string;
  readonly globalId: number;
  /** `pin.configure`: writes `pin_mode[globalId]`. */
  configure(mode: number): void;
  /** `pin.write_digital`: writes `pin_output[globalId]`. */
  writeDigital(level: Value<'bool'>): void;
  /** `pin.sample_digital`: reads the solved `pin_input[globalId]`. */
  sampleDigital(): Value<'bool'>;
  /** Reads the device's own `pin_output[globalId]`. */
  readDrivenDigital(): Value<'bool'>;
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

/** Build surface handed to one device behavior. */
export interface DeviceBehaviorApi {
  readonly deviceId: string;
  readonly builder: FunctionBuilder<readonly []>;
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
  readonly states?: Readonly<Record<string, DeviceStateDescription>>;
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

/** Pin memories every device and every net solver shares. */
export interface CompiledCircuitMemory {
  readonly mode: ArrayRef<'u8'>;
  readonly output: ArrayRef<'bool'>;
  readonly input: ArrayRef<'bool'>;
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

/** Diagnostic codes produced by the compiler's electrical analysis. */
export type CompilationDiagnosticCode =
  'driver-conflict' | 'power-short' | 'rail-conflict' | 'floating-net';

export type CompilationDiagnosticSeverity = 'error' | 'warning';

/** One electrical-analysis finding; errors abort `compileCircuit`. */
export interface CompilationDiagnostic {
  readonly code: CompilationDiagnosticCode;
  readonly severity: CompilationDiagnosticSeverity;
  readonly message: string;
  readonly netId: number | undefined;
  readonly endpoints: readonly string[];
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

/** The compiled circuit: one module for every device, net and the main loop. */
export interface CompiledCircuit {
  readonly module: IRModule;
  readonly entryPoints: CompiledEntryPoints;
  /** `'mcu1.PA0'` -> global pin id. */
  readonly pinMap: ReadonlyMap<string, number>;
  readonly deviceMap: ReadonlyMap<string, DeviceMetadata>;
  readonly netlist: CompiledNetlist;
  readonly pins: GlobalPinMap;
  readonly states: GlobalStateMap;
  readonly memory: CompiledCircuitMemory;
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
