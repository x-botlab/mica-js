import type { PropertyValue } from '@mica-js/core/schematic';
import type {
  ContactDeclaration,
  ElectricalFactoryContext,
  ResistorDeclaration,
} from '../../electrical-authoring';
import type {
  ArrayRef,
  BytesRef,
  FunctionBuilder,
  FunctionRef,
  IRModule,
  IRValidationOptions,
  ScalarType,
  StateRef,
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
 * live in `../pin-space` and are reused here. The compiler ships no device
 * models: every description is supplied by the caller.
 */

/** One pin declared by the paired electrical device definition. */
export interface DevicePinDescription {
  readonly kind: 'signal' | 'power' | 'gnd';
  readonly side?: 'left' | 'right' | 'top' | 'bottom';
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
  /** Selects the physical output configuration. */
  configure(mode: number): void;
  setOutputEnabled(enabled: Value<'bool'>): void;
  setPull(pull: 'none' | 'up' | 'down'): void;
  writeVoltage(voltage: Value<'f64'>): void;
  /** Writes digital drive intent through the finite output impedance. */
  writeDigital(level: Value<'bool'>): void;
  /** Samples the solved voltage with the explicitly declared input thresholds. */
  sampleDigital(): Value<'bool'>;
  sampleVoltage(): Value<'f64'>;
  /** Reads this pin's digital drive intent. */
  readDrivenDigital(): Value<'bool'>;
}

export interface DeviceResistorHandle {
  setResistance(ohms: Value<'f64'>): void;
  setEnabled(enabled: Value<'bool'>): void;
  /** Solved current in amperes, positive from the first declared pin to the second. */
  sampleCurrent(): Value<'f64'>;
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
}

/**
 * Everything a complex device kernel needs to declare its own IR before any
 * phase function body is opened: the module (for `array`/`bytes`/`provider`),
 * typed operations through `bind(builder)` and the allocated pin ids.
 */
export interface DeviceKernelContext {
  readonly deviceId: string;
  readonly config: Readonly<Record<string, unknown>> | undefined;
  readonly module: IRModule;
  bind(builder: FunctionBuilder<readonly []>): DeviceBehaviorApi;
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
  /** Instance configuration from {@link DeviceConfig.config}. */
  readonly config: Readonly<Record<string, unknown>> | undefined;
  /** Every declared pin of the device, in declaration order. */
  readonly pins: readonly DevicePinHandle[];
  /** Pins initialized with physical drive capability. */
  readonly outputs: readonly DevicePinHandle[];
  pin(name: string): DevicePinHandle;
  resistor(name: string): DeviceResistorHandle;
  writeDigitalGroup(names: readonly string[], levels: readonly Value<'bool'>[]): void;
  applyResistors(names: readonly string[], ohms: readonly Value<'f64'>[]): void;
  applyConnections(names: readonly string[], closed: readonly Value<'bool'>[]): void;
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
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly resistors?: Readonly<Record<string, ResistorDeclaration>>;
  readonly connections?: Readonly<Record<string, ContactDeclaration>>;
  /** Paired synchronous JS factory, invoked once per instance before IR generation. */
  readonly factory: (context: ElectricalFactoryContext) => DeviceBehaviors | void;
  readonly states?: Readonly<Record<string, DeviceStateDescription>>;
  readonly behaviors?: DeviceBehaviors;
  /**
   * Complex-kernel hook. Runs once per module before phase generation so the
   * kernel may declare typed arrays, byte memories and providers, then return
   * the behaviour hooks the compiler should call inside each phase.
   */
  readonly kernel?: DeviceKernelFactory;
  /**
   * Optional typed accessor factory. Kernels with a richer surface than the
   * generic state/pin accessor (a register file, a memory map) use it.
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
  /** Device type, e.g. `'push-pull-driver'`; free-form label of the device model. */
  readonly type: string;
  readonly description: DeviceDescription;
  /** Persistent instance values resolved against the JSON property declarations. */
  readonly properties?: Readonly<Record<string, PropertyValue>>;
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
  /** Explicit GND-referenced voltage sources; GND itself is always 0 V. */
  readonly sources?: Readonly<Record<string, { readonly voltage: number }>>;
  readonly interpretation?: 'two-state' | 'retain-in-band';
  /** Reproducible mica-floating-v2 input seed; defaults to 0. */
  readonly floatingSeed?: number;
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
  /** Completed ticks in the most recent step/batch, including before a fault. */
  readonly progress: StateRef<'u32'>;
  /** `'mcu1.PA0'` -> global pin id. */
  readonly pinMap: ReadonlyMap<string, number>;
  readonly deviceMap: ReadonlyMap<string, DeviceMetadata>;
  readonly pins: GlobalPinMap;
  readonly states: GlobalStateMap;
  /** Validation grants covering every instruction and memory of the module. */
  readonly validation: IRValidationOptions;
  /** Device ids in stable declaration order. */
  readonly executionOrder: readonly string[];
  /** Every generated function name, in definition order. */
  readonly functions: readonly string[];
}

/** Error codes raised by {@link UnifiedIRCompilerError}. */
export type UnifiedIRCompilerErrorCode =
  'invalid-input' | 'duplicate-device' | 'state-not-found' | 'capacity-exceeded' | 'invalid-ir';

export interface UnifiedIRCompilerErrorOptions {
  readonly deviceId?: string;
  readonly pinName?: string;
  readonly cause?: unknown;
}

/** Error raised while compiling a circuit. */
export class UnifiedIRCompilerError extends Error {
  override readonly name = 'UnifiedIRCompilerError';
  readonly code: UnifiedIRCompilerErrorCode;
  readonly deviceId: string | undefined;
  readonly pinName: string | undefined;

  constructor(
    code: UnifiedIRCompilerErrorCode,
    message: string,
    options: UnifiedIRCompilerErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.deviceId = options.deviceId;
    this.pinName = options.pinName;
  }
}
