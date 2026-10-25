import type {
  ArrayRef,
  FunctionBuilder,
  FunctionRef,
  IRModule,
  ScalarType,
  Value,
} from '@mica-js/ir';
import {
  PIN_MODE,
  PIN_MODE_BY_NAME,
  PIN_PULL,
  PIN_PULL_BY_NAME,
  type PinModeName,
  type PinPull,
  type PinPullName,
} from '../pin-space';
import { stateOffsetOf } from './allocator';
import type { DomainLoweringSurface } from './lowering';
import { emitPinPowered, selectPowered, type PowerGating } from './power';
import type { TopicEndpointRegistry } from './topics';
import {
  UnifiedIRCompilerError,
  type CompiledCircuitMemory,
  type DeviceBehaviorApi,
  type DeviceBehaviors,
  type DeviceConfig,
  type DeviceConnectionApi,
  type DeviceConnectionEntry,
  type DeviceDescription,
  type DeviceKernelRuntime,
  type DeviceMetadata,
  type DeviceObserveApi,
  type DeviceObserveEdge,
  type DeviceObserveOptions,
  type DeviceObserverHandler,
  type DeviceObserverSlot,
  type DevicePinAllocation,
  type DevicePinConfigureMode,
  type DevicePinDescription,
  type DevicePinGroupApi,
  type DevicePinHandle,
  type DeviceStateDescription,
  type DeviceStateHandle,
  type DeviceStateSlot,
  type DeviceTopicApi,
  type DeviceTopicHandler,
  type DeviceTopicHandlerApi,
  type GlobalPinMap,
  type GlobalStateMap,
  type LedDescriptionOptions,
  type McuDescriptionOptions,
} from './types';

/**
 * A pin group packs into one `u32`, so it addresses at most 32 pins (RFC 0004).
 * Group index `i` is bit `i`, i.e. the first name is the least significant bit.
 */
const MAX_PIN_GROUP_BITS = 32;

/** Upper bound of an authored analog voltage or threshold, catching unit mistakes. */
const MAX_THRESHOLD_VOLTAGE = 1000;

/** Refs the main loop calls for one device; `undefined` means "no such phase". */
export interface DeviceLoopEntry {
  readonly deviceId: string;
  readonly initialize: FunctionRef<readonly [], readonly []> | undefined;
  readonly tick: FunctionRef<readonly [], readonly []> | undefined;
  readonly update: FunctionRef<readonly [], readonly []> | undefined;
}

/** One generated device: public metadata plus the refs the main loop needs. */
export interface GeneratedDevice {
  readonly metadata: DeviceMetadata;
  readonly entry: DeviceLoopEntry;
}

interface GeneratedPhase {
  readonly name: string;
  readonly ref: FunctionRef<readonly [], readonly []>;
}

/** A device type with a built-in IR kernel. */
export interface BuiltinDeviceKernel {
  /** Canonical type name. */
  readonly type: string;
  /** Additional type names that select this kernel. */
  readonly aliases: readonly string[];
  readonly defaultPins: Readonly<Record<string, DevicePinDescription>>;
  readonly defaultStates: Readonly<Record<string, DeviceStateDescription>>;
  readonly behaviors: DeviceBehaviors;
}

/**
 * MCU kernel, extracted from the prototype `device-mcu.ts`.
 *
 * ```text
 * mcu_tick:
 *   PIN_OUTPUT[PA0] = !PIN_OUTPUT[PA0]     // one toggle per output pin
 *   PIN_MODE[PA0]   = PUSH_PULL
 * ```
 */
const MCU_BEHAVIORS: DeviceBehaviors = Object.freeze({
  initialize: (api: DeviceBehaviorApi) => {
    for (const pin of api.outputs) pin.configure(PIN_MODE.pushPull);
  },
  tick: (api: DeviceBehaviorApi) => {
    const b = api.builder;
    for (const pin of api.outputs) {
      const current = pin.readDrivenDigital();
      pin.writeDigital(b.bool.not(current));
      pin.configure(PIN_MODE.pushPull);
    }
  },
});

/**
 * LED kernel, extracted from the prototype `device-led.ts`.
 *
 * ```text
 * led_update:
 *   LED_STATE[i] = PIN_INPUT[anode] && !PIN_INPUT[cathode]
 * ```
 */
const LED_BEHAVIORS: DeviceBehaviors = Object.freeze({
  update: (api: DeviceBehaviorApi) => {
    const b = api.builder;
    const anode = api.pin('anode').sampleDigital();
    const cathode = api.pin('cathode').sampleDigital();
    api.state<'bool'>('lamp').store(b.bool.and(anode, b.bool.not(cathode)));
  },
});

/** Built-in kernels the compiler ships; a description may also supply its own. */
export const BUILTIN_DEVICE_KERNELS: readonly BuiltinDeviceKernel[] = Object.freeze([
  Object.freeze({
    type: 'mcu',
    aliases: Object.freeze(['teaching-mcu']),
    defaultPins: Object.freeze({ PA0: Object.freeze({ direction: 'output' as const }) }),
    defaultStates: Object.freeze({}),
    behaviors: MCU_BEHAVIORS,
  }),
  Object.freeze({
    type: 'led',
    aliases: Object.freeze(['ideal-led']),
    defaultPins: Object.freeze({
      anode: Object.freeze({ direction: 'passive' as const }),
      cathode: Object.freeze({ direction: 'passive' as const }),
    }),
    defaultStates: Object.freeze({
      lamp: Object.freeze({ type: 'bool' as const, initial: false }),
    }),
    behaviors: LED_BEHAVIORS,
  }),
]);

const KERNELS_BY_TYPE: ReadonlyMap<string, BuiltinDeviceKernel> = new Map(
  BUILTIN_DEVICE_KERNELS.flatMap((kernel) =>
    [kernel.type, ...kernel.aliases].map((type) => [type, kernel] as const),
  ),
);

/** Every device type that compiles without an explicit `description.behaviors`. */
export const BUILTIN_DEVICE_TYPES: readonly string[] = Object.freeze(
  BUILTIN_DEVICE_KERNELS.flatMap((kernel) => [kernel.type, ...kernel.aliases]),
);

/** Resolves the built-in kernel of one type, if any. */
export function builtinDeviceKernel(type: string): BuiltinDeviceKernel | undefined {
  return KERNELS_BY_TYPE.get(type);
}

/**
 * Applies the built-in defaults of `device.type` to a description.
 *
 * A description always wins: declared pins, states and behaviors are kept, and
 * only the missing pieces are filled in. Devices of an unknown type pass
 * through untouched so the generator can report a precise error.
 */
export function resolveDeviceDescription(device: DeviceConfig): DeviceConfig {
  const kernel = builtinDeviceKernel(device.type);
  if (kernel === undefined) return device;
  const pins = device.description.pins;
  const hasPins = pins instanceof Map ? pins.size > 0 : Object.keys(pins).length > 0;
  const states = device.description.states;
  return Object.freeze({
    ...device,
    description: Object.freeze({
      ...device.description,
      pins: hasPins ? pins : kernel.defaultPins,
      states:
        states === undefined
          ? kernel.defaultStates
          : Object.freeze({ ...kernel.defaultStates, ...states }),
      behaviors: device.description.behaviors ?? kernel.behaviors,
    }),
  });
}

/** Builds the prototype MCU description: push-pull outputs that toggle each tick. */
export function createMcuDescription(options: McuDescriptionOptions = {}): DeviceDescription {
  const names = options.pins ?? ['PA0'];
  const direction = options.direction ?? 'output';
  const pins: Record<string, DevicePinDescription> = {};
  for (const name of names) pins[name] = Object.freeze({ direction });
  return Object.freeze({ name: 'teaching-mcu', pins: Object.freeze(pins) });
}

/** Builds the prototype LED description: passive anode/cathode plus a lamp state. */
export function createLedDescription(options: LedDescriptionOptions = {}): DeviceDescription {
  const anode = options.anode ?? 'anode';
  const cathode = options.cathode ?? 'cathode';
  return Object.freeze({
    name: 'ideal-led',
    pins: Object.freeze({
      [anode]: Object.freeze({ direction: 'passive' as const }),
      [cathode]: Object.freeze({ direction: 'passive' as const }),
    }),
    states: Object.freeze({ lamp: Object.freeze({ type: 'bool' as const, initial: false }) }),
  });
}

/** Everything the device generator reads from the prior compilation stages. */
export interface DeviceGenerationContext {
  readonly module: IRModule;
  readonly memory: CompiledCircuitMemory;
  readonly pins: GlobalPinMap;
  readonly states: GlobalStateMap;
  /**
   * Topic endpoints declared before generation. Omitted by the low-level
   * generator tests that only exercise pins, states and phases.
   */
  readonly topics?: TopicEndpointRegistry;
  /**
   * Domain lowering surface. Required by devices that declare `connections` or
   * `observers`; omitted by the low-level tests that only exercise pins.
   */
  readonly lowering?: DomainLoweringSurface;
  /**
   * Power-domain gating (RFC 0007). A pin bound to an unpowered domain samples
   * the determinate level `0`; omitted by the low-level tests and by circuits
   * that declare no domains.
   */
  readonly power?: PowerGating;
  /**
   * Global pin ids whose behaviour called `pin.pull`. The voltage solver reads
   * the weak tier for these pins only: a circuit without pull resistors pays
   * nothing for it. Omitted by low-level tests, which then read every pin.
   */
  readonly pullPins?: Set<number>;
  /**
   * Global pin ids whose behaviour overrode a threshold through
   * `pin.configure({ lowThreshold, highThreshold })`. A rail node with only
   * seeded thresholds has a compile-time digital level.
   */
  readonly thresholdPins?: Set<number>;
}

/** One `observe.configure` call recorded while a phase body runs. */
interface PendingObserver {
  readonly slot: DeviceObserverSlot;
  readonly edges: DeviceObserveEdge;
  readonly handler: DeviceObserverHandler;
}

/**
 * Generates one IR function per device phase into the unified module.
 *
 * Domain operations are inlined while the behavior runs: `pin.configure`,
 * `pin.writeDigital` and `pin.sampleDigital` become `array.store`/`array.load`
 * on the shared `pin_mode` / `pin_output` / `pin_input` memories, so no device
 * keeps its own module, protocol or host hop. A device without an explicit
 * `initialize` still gets one that configures its output pins as push-pull.
 *
 * Descriptions must already carry their built-in defaults, i.e. they go through
 * {@link resolveDeviceDescription} (`compileCircuit` does this before
 * allocating pins and states).
 */
export class DeviceIRGenerator {
  private readonly context: DeviceGenerationContext;

  constructor(context: DeviceGenerationContext) {
    this.context = context;
  }

  /**
   * @throws {UnifiedIRCompilerError} when the device has no kernel/behaviors or
   *   a behavior reaches for a pin or state the description does not declare.
   */
  generate(device: DeviceConfig): GeneratedDevice {
    const allocation = this.context.pins.devices.get(device.id);
    if (allocation === undefined) {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        `Device "${device.id}" has no pin allocation; allocate resources before generating IR`,
        { deviceId: device.id },
      );
    }
    const kernelResult = device.description.kernel?.({
      deviceId: device.id,
      config: device.config,
      module: this.context.module,
      memory: this.context.memory,
      pins: [...allocation.resolved.values()].map((pin) =>
        Object.freeze({
          name: pin.name,
          globalPinId: pin.globalPinId,
          role: pin.role,
        }),
      ),
    });
    const kernelRuntime =
      kernelResult !== undefined && isKernelRuntime(kernelResult) ? kernelResult : undefined;
    const behaviors =
      kernelRuntime === undefined
        ? ((kernelResult as DeviceBehaviors | undefined) ?? device.description.behaviors)
        : undefined;

    let initialize: GeneratedPhase | undefined;
    let tick: GeneratedPhase | undefined;
    let update: GeneratedPhase | undefined;
    // Subscriptions are collected while the phase bodies run but generated
    // afterwards: an entry body may not nest inside another function body.
    const subscriptions: { port: string; handler: DeviceTopicHandler }[] = [];
    // `observe.configure` only records the handler here; its IR function is
    // generated after the phase bodies close, for the same reason.
    const observers = new Map<string, PendingObserver>();
    if (kernelRuntime !== undefined) {
      initialize = phaseFromRef(this.context.module, device.id, kernelRuntime.initialize);
      tick = phaseFromRef(this.context.module, device.id, kernelRuntime.tick);
      update = phaseFromRef(this.context.module, device.id, kernelRuntime.update);
    } else if (behaviors === undefined || !hasAnyBehavior(behaviors)) {
      // A device that only declares topic ports is a pure message endpoint:
      // its entries are the logic, so it needs no phase of its own.
      if (!declaresPorts(device)) {
        throw new UnifiedIRCompilerError(
          'unsupported-device',
          `Device "${device.id}" of type "${device.type}" declares no behaviors and the type has no built-in kernel. Provide description.behaviors, declare topic ports, or use one of: [${BUILTIN_DEVICE_TYPES.join(', ')}]`,
          { deviceId: device.id },
        );
      }
      initialize = this.generateDefaultInitialize(device, allocation);
    } else {
      initialize =
        this.generatePhase(
          device,
          allocation,
          'initialize',
          behaviors.initialize,
          subscriptions,
          observers,
        ) ?? this.generateDefaultInitialize(device, allocation);
      tick = this.generatePhase(
        device,
        allocation,
        'tick',
        behaviors.tick,
        subscriptions,
        observers,
      );
      update = this.generatePhase(
        device,
        allocation,
        'update',
        behaviors.update,
        subscriptions,
        observers,
      );
    }
    const observerFunctions = this.generateObservers(device, allocation, observers, subscriptions);
    const topics = this.context.topics;
    for (const subscription of subscriptions) {
      if (topics === undefined) {
        throw new UnifiedIRCompilerError(
          'invalid-input',
          `Device "${device.id}" subscribes to topic port "${subscription.port}" but the compiler has no topic registry`,
          { deviceId: device.id },
        );
      }
      topics.bind(device.id, subscription.port, (builder, params) => {
        subscription.handler(this.createTopicHandlerApi(device, allocation, builder, params));
      });
    }

    const functions: string[] = [];
    for (const phase of [initialize, tick, update]) {
      if (phase !== undefined) functions.push(phase.name);
    }
    functions.push(...observerFunctions);

    const metadata: DeviceMetadata = Object.freeze({
      deviceId: device.id,
      type: device.type,
      pinOffset: allocation.offset,
      stateOffset: stateOffsetOf(this.context.states, device.id),
      pins: allocation.pins,
      states: this.context.states.devices.get(device.id) ?? new Map(),
      powerDomains: this.context.power?.devices.get(device.id) ?? new Map(),
      functions: Object.freeze(functions),
      initialize: initialize?.name,
      tick: tick?.name,
      update: update?.name,
      accessor: device.description.accessor,
      kernel: device.description.kernel,
    });

    return Object.freeze({
      metadata,
      entry: Object.freeze({
        deviceId: device.id,
        initialize: initialize?.ref,
        tick: tick?.ref,
        update: update?.ref,
      }),
    });
  }

  private generatePhase(
    device: DeviceConfig,
    allocation: DevicePinAllocation,
    phase: 'initialize' | 'tick' | 'update',
    behavior: ((api: DeviceBehaviorApi) => void) | undefined,
    subscriptions: { port: string; handler: DeviceTopicHandler }[],
    observers: Map<string, PendingObserver>,
  ): GeneratedPhase | undefined {
    if (behavior === undefined) return undefined;
    const name = `${device.id}_${phase}`;
    const ref = this.context.module.func(name, { params: [], results: [] });
    ref.body((b) => {
      behavior(this.createApi(device, allocation, b, subscriptions, observers));
      b.return([]);
    });
    return { name, ref };
  }

  /**
   * Generates one `<deviceId>_observe_<name>` function per enabled
   * `observe.configure` and activates it in the lowering.
   *
   * The handler body is generated after the phase bodies close (the IR builder
   * forbids nesting function bodies), exactly like topic subscriptions. The
   * parameters are the levels captured when the edge fired.
   */
  private generateObservers(
    device: DeviceConfig,
    allocation: DevicePinAllocation,
    observers: ReadonlyMap<string, PendingObserver>,
    subscriptions: { port: string; handler: DeviceTopicHandler }[],
  ): readonly string[] {
    const names: string[] = [];
    for (const [name, pending] of observers) {
      const functionName = `${device.id}_observe_${name}`;
      const ref = this.context.module.func(functionName, {
        params: pending.slot.capturePinIds.map(() => 'bool' as const),
        results: [],
      });
      ref.body((b, captured) => {
        // `undefined` observers: a handler may not reconfigure observations.
        const api = this.createApi(device, allocation, b, subscriptions, undefined);
        pending.handler(api, captured);
        b.return([]);
      });
      this.context.lowering?.observers.activate({
        slot: pending.slot,
        edges: pending.edges,
        target: ref,
      });
      names.push(functionName);
    }
    return Object.freeze(names);
  }

  private generateDefaultInitialize(
    device: DeviceConfig,
    allocation: DevicePinAllocation,
  ): GeneratedPhase | undefined {
    const outputs = [...allocation.resolved.values()].filter((pin) => pin.role === 'driver');
    if (outputs.length === 0) return undefined;
    const name = `${device.id}_initialize`;
    const ref = this.context.module.func(name, { params: [], results: [] });
    ref.body((b) => {
      for (const pin of outputs) {
        b.array.store(
          this.context.memory.mode,
          b.const('u32', pin.globalPinId),
          b.const('u8', PIN_MODE.pushPull),
        );
      }
      b.return([]);
    });
    return { name, ref };
  }

  private createApi(
    device: DeviceConfig,
    allocation: DevicePinAllocation,
    builder: FunctionBuilder<readonly []>,
    subscriptions: { port: string; handler: DeviceTopicHandler }[],
    observers: Map<string, PendingObserver> | undefined,
  ): DeviceBehaviorApi {
    const handles = this.pinHandlesOf(device, allocation, builder);
    const pins = [...handles.values()];
    const outputs = [...allocation.resolved.values()]
      .filter((pin) => pin.role === 'driver')
      .flatMap((pin) => {
        const handle = handles.get(pin.name);
        return handle === undefined ? [] : [handle];
      });
    const topics = this.createTopicApi(device, builder, subscriptions);
    return Object.freeze({
      deviceId: device.id,
      builder,
      module: this.context.module,
      memory: this.context.memory,
      config: device.config,
      topics,
      connection: this.createConnectionApi(device, builder),
      observe: this.createObserveApi(device, builder, observers),
      pins: Object.freeze(pins),
      outputs: Object.freeze(outputs),
      pin: (name: string) => requirePinHandle(device.id, handles, name),
      pinGroup: (names: readonly string[]) =>
        this.createPinGroupApi(device, handles, builder, names),
      state: <T extends ScalarType = ScalarType>(name: string) =>
        this.requireStateHandle<T>(device, name, builder),
    });
  }

  /**
   * `connection.apply` surface of one device.
   *
   * Entries are resolved against the device's declarations and handed to the
   * lowering, which emits `connection_states` stores plus the net propagation.
   */
  private createConnectionApi(
    device: DeviceConfig,
    builder: FunctionBuilder<readonly []>,
  ): DeviceConnectionApi {
    const deviceId = device.id;
    const requireLowering = (): DomainLoweringSurface => {
      const lowering = this.context.lowering;
      if (lowering === undefined) {
        throw new UnifiedIRCompilerError(
          'invalid-input',
          `Device "${deviceId}" applies a connection but the compiler has no domain lowering`,
          { deviceId },
        );
      }
      return lowering;
    };
    const apply = (entries: readonly DeviceConnectionEntry[]): void => {
      const lowering = requireLowering();
      if (!Array.isArray(entries) || entries.length === 0) {
        throw new UnifiedIRCompilerError(
          'invalid-input',
          `Device "${deviceId}" connection.apply requires at least one entry`,
          { deviceId },
        );
      }
      const patch = entries.map((entry, index) => {
        if (entry === null || typeof entry !== 'object') {
          throw new UnifiedIRCompilerError(
            'invalid-input',
            `Device "${deviceId}" connection.apply entry ${index} must be an object`,
            { deviceId },
          );
        }
        const slot = lowering.connections.slotOf(deviceId, entry.connection);
        if (slot === undefined) {
          const available = this.declaredNames(device, 'connections');
          throw new UnifiedIRCompilerError(
            'invalid-input',
            `Device "${deviceId}" applies undeclared connection "${String(entry.connection)}". Available: [${available.join(', ')}]`,
            { deviceId },
          );
        }
        const closed = entry.closed;
        if (typeof closed !== 'boolean' && (typeof closed !== 'object' || closed === null)) {
          throw new UnifiedIRCompilerError(
            'invalid-input',
            `Device "${deviceId}" connection.apply entry "${entry.connection}" needs a bool value or a boolean constant`,
            { deviceId },
          );
        }
        return { slot, closed };
      });
      lowering.connections.emitPatch(builder, patch);
    };
    return Object.freeze({
      apply,
      set(connection: string, closed: Value<'bool'> | boolean): void {
        apply([{ connection, closed }]);
      },
    });
  }

  /**
   * `observe.configure` surface of one device.
   *
   * `enabled: false` lowers to nothing; an enabled observation seeds its
   * baseline here and queues the handler function for generation after the
   * current phase body closes.
   */
  private createObserveApi(
    device: DeviceConfig,
    builder: FunctionBuilder<readonly []>,
    observers: Map<string, PendingObserver> | undefined,
  ): DeviceObserveApi {
    const deviceId = device.id;
    const declared = (field: 'connections' | 'observers'): readonly string[] =>
      domainNames(device, field);
    const lowering = this.context.lowering;
    return Object.freeze({
      configure(name: string, options: DeviceObserveOptions): void {
        if (observers === undefined) {
          throw new UnifiedIRCompilerError(
            'invalid-input',
            `Device "${deviceId}" cannot configure observation "${String(name)}" from inside an observer handler`,
            { deviceId },
          );
        }
        if (lowering === undefined) {
          throw new UnifiedIRCompilerError(
            'invalid-input',
            `Device "${deviceId}" configures an observation but the compiler has no domain lowering`,
            { deviceId },
          );
        }
        const slot = lowering.observers.slotOf(deviceId, name);
        if (slot === undefined) {
          const available = declared('observers');
          throw new UnifiedIRCompilerError(
            'invalid-input',
            `Device "${deviceId}" configures undeclared observation "${String(name)}". Available: [${available.join(', ')}]`,
            { deviceId },
          );
        }
        if (options === null || typeof options !== 'object') {
          throw new UnifiedIRCompilerError(
            'invalid-input',
            `Device "${deviceId}" observe.configure("${name}") requires an options object`,
            { deviceId },
          );
        }
        const enabled = options.enabled ?? true;
        if (typeof enabled !== 'boolean') {
          throw new UnifiedIRCompilerError(
            'invalid-input',
            `Device "${deviceId}" observe.configure("${name}") enabled must be a boolean`,
            { deviceId },
          );
        }
        const edges = options.edges ?? slot.edges;
        if (edges !== 'rising' && edges !== 'falling' && edges !== 'both') {
          throw new UnifiedIRCompilerError(
            'invalid-input',
            `Device "${deviceId}" observe.configure("${name}") edges must be "rising", "falling" or "both"`,
            { deviceId },
          );
        }
        if (typeof options.handler !== 'function') {
          throw new UnifiedIRCompilerError(
            'invalid-input',
            `Device "${deviceId}" observe.configure("${name}") requires a handler function`,
            { deviceId },
          );
        }
        if (!enabled) {
          observers.delete(name);
          return;
        }
        observers.set(name, Object.freeze({ slot, edges, handler: options.handler }));
        lowering.observers.emitBaseline(builder, slot);
      },
    });
  }

  /** Names a device declares for one domain map; used by error messages. */
  private declaredNames(
    device: DeviceConfig,
    field: 'connections' | 'observers',
  ): readonly string[] {
    return domainNames(device, field);
  }

  /** Pin handles of one device, bound to `builder`; declaration order is kept. */
  private pinHandlesOf(
    device: DeviceConfig,
    allocation: DevicePinAllocation,
    builder: FunctionBuilder<readonly []>,
  ): ReadonlyMap<string, DevicePinHandle> {
    const handles = new Map<string, DevicePinHandle>();
    for (const pin of allocation.resolved.values()) {
      handles.set(pin.name, this.createPinHandle(pin.globalPinId, pin.name, builder));
    }
    return handles;
  }

  private requireStateHandle<T extends ScalarType>(
    device: DeviceConfig,
    name: string,
    builder: FunctionBuilder<readonly []>,
  ): DeviceStateHandle<T> {
    const slots = this.context.states.devices.get(device.id);
    const slot = slots?.get(name);
    if (slot === undefined) {
      throw new UnifiedIRCompilerError(
        'state-not-found',
        `Device "${device.id}" has no state "${name}". Available: [${[...(slots?.keys() ?? [])].join(', ')}]`,
        { deviceId: device.id },
      );
    }
    return createStateHandle<T>(device.id, slot, builder);
  }

  /** Build surface handed to the entry body of one input topic port. */
  private createTopicHandlerApi(
    device: DeviceConfig,
    allocation: DevicePinAllocation,
    builder: FunctionBuilder<readonly []>,
    args: readonly Value<ScalarType>[],
  ): DeviceTopicHandlerApi {
    const handles = this.pinHandlesOf(device, allocation, builder);
    return Object.freeze({
      deviceId: device.id,
      builder,
      module: this.context.module,
      config: device.config,
      args,
      connection: this.createConnectionApi(device, builder),
      pin: (name: string) => requirePinHandle(device.id, handles, name),
      pinGroup: (names: readonly string[]) =>
        this.createPinGroupApi(device, handles, builder, names),
      state: <T extends ScalarType = ScalarType>(name: string) =>
        this.requireStateHandle<T>(device, name, builder),
    });
  }

  /**
   * Topic surface of one phase.
   *
   * `publish` resolves the port's output endpoint and emits `bridge.send` with
   * the phase's own values. `subscribe` only records the handler; the entry
   * body is generated after the phase body closes, because `@mica-js/ir` does
   * not allow nesting one function body inside another.
   */
  private createTopicApi(
    device: DeviceConfig,
    builder: FunctionBuilder<readonly []>,
    subscriptions: { port: string; handler: DeviceTopicHandler }[],
  ): DeviceTopicApi {
    const registry = this.context.topics;
    const requireRegistry = (): TopicEndpointRegistry => {
      if (registry === undefined) {
        throw new UnifiedIRCompilerError(
          'invalid-input',
          `Device "${device.id}" uses topic endpoints but the compiler has no topic registry`,
          { deviceId: device.id },
        );
      }
      return registry;
    };
    return Object.freeze({
      publish(port: string, args: readonly Value<ScalarType>[]): void {
        const topics = requireRegistry();
        const output = topics.output(device.id, port);
        const declared = topics.port(device.id, port);
        if (declared !== undefined && args.length !== declared.params.length) {
          throw new UnifiedIRCompilerError(
            'invalid-input',
            `Port '${declared.key}' expects ${declared.params.length} scalar argument(s) (${declared.params.join(', ')}), received ${args.length}`,
            { deviceId: device.id },
          );
        }
        builder.output(output, args);
      },
      subscribe(port: string, handler: DeviceTopicHandler): void {
        // Resolving the entry validates that the port exists and is an input.
        requireRegistry().entry(device.id, port);
        if (typeof handler !== 'function') {
          throw new UnifiedIRCompilerError(
            'invalid-input',
            `Subscriber of '${device.id}.${port}' must be a function`,
            { deviceId: device.id },
          );
        }
        subscriptions.push({ port, handler });
      },
    });
  }

  /**
   * `pinGroup` surface of one device (RFC 0004).
   *
   * The group is validated once, when the behavior asks for it, and then
   * lowered in place: `writeDigital` stores one `pin_output` bit per member and
   * `readDigital` folds one `pin_input` load per member, both LSB first.
   */
  private createPinGroupApi(
    device: DeviceConfig,
    handles: ReadonlyMap<string, DevicePinHandle>,
    builder: FunctionBuilder<readonly []>,
    names: readonly string[],
  ): DevicePinGroupApi {
    const deviceId = device.id;
    if (!Array.isArray(names) || names.length === 0) {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        `Device "${deviceId}" pinGroup() needs a non-empty array of pin names`,
        { deviceId },
      );
    }
    if (names.length > MAX_PIN_GROUP_BITS) {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        `Device "${deviceId}" pinGroup() holds ${names.length} pins; a u32 bit field supports at most ${MAX_PIN_GROUP_BITS}`,
        { deviceId },
      );
    }
    const members: DevicePinHandle[] = [];
    const seen = new Set<string>();
    for (const [bit, name] of names.entries()) {
      if (typeof name !== 'string') {
        throw new UnifiedIRCompilerError(
          'invalid-input',
          `Device "${deviceId}" pinGroup() entry ${bit} must be a pin name`,
          { deviceId },
        );
      }
      if (seen.has(name)) {
        throw new UnifiedIRCompilerError(
          'invalid-input',
          `Device "${deviceId}" pinGroup() lists pin "${name}" more than once`,
          { deviceId },
        );
      }
      seen.add(name);
      members.push(requirePinHandle(deviceId, handles, name));
    }
    const memory = this.context.memory;
    const indexOf = (member: DevicePinHandle): Value<'u32'> =>
      builder.const('u32', member.globalId);
    return Object.freeze({
      names: Object.freeze([...names]),
      globalIds: Object.freeze(members.map((member) => member.globalId)),
      writeDigital(value: Value<'u32'> | number): void {
        const bits = pinGroupBits(deviceId, value, builder);
        for (const [bit, member] of members.entries()) {
          const mask = builder.const('u32', 2 ** bit);
          const set = builder.int.cmp('ne', builder.int.and(bits, mask), builder.const('u32', 0));
          builder.array.store(memory.output, indexOf(member), set);
        }
      },
      readDigital(): Value<'u32'> {
        let packed = builder.const('u32', 0);
        for (const [bit, member] of members.entries()) {
          const level = builder.array.load(memory.input, indexOf(member));
          const value = builder.select(
            level,
            builder.const('u32', 2 ** bit),
            builder.const('u32', 0),
          );
          packed = builder.int.or(packed, value);
        }
        return packed;
      },
      pin(name: string): DevicePinHandle {
        const handle = seen.has(name) ? handles.get(name) : undefined;
        if (handle === undefined) {
          const group = members.map((member) => member.name);
          throw new UnifiedIRCompilerError(
            'pin-not-found',
            `Pin "${name}" is not in the pin group of device "${deviceId}". Group: [${group.join(', ')}]`,
            { deviceId, pinName: name },
          );
        }
        return handle;
      },
    });
  }

  private createPinHandle(
    globalId: number,
    name: string,
    builder: FunctionBuilder<readonly []>,
  ): DevicePinHandle {
    const memory = this.context.memory;
    const power = this.context.power;
    const pullPins = this.context.pullPins;
    const thresholdPins = this.context.thresholdPins;
    // Resolved lazily so a behavior that only samples a pin does not also emit
    // an unused constant for every other pin of the device.
    const index = (): Value<'u32'> => builder.const('u32', globalId);
    return Object.freeze({
      name,
      globalId,
      configure(mode: DevicePinConfigureMode): void {
        if (mode !== null && typeof mode === 'object') {
          const value = resolvePinMode(mode, name);
          if (value !== undefined) {
            builder.array.store(memory.mode, index(), builder.const('u8', value));
          }
          const low =
            mode.lowThreshold === undefined
              ? undefined
              : resolveThreshold(mode.lowThreshold, name, 'lowThreshold');
          const high =
            mode.highThreshold === undefined
              ? undefined
              : resolveThreshold(mode.highThreshold, name, 'highThreshold');
          if (low !== undefined && high !== undefined && low > high) {
            throw new UnifiedIRCompilerError(
              'invalid-input',
              `Pin "${name}" configure() needs lowThreshold <= highThreshold, received ${low} > ${high}`,
            );
          }
          if (low !== undefined) {
            const target = memory.lowThreshold;
            if (target === undefined) {
              throw new UnifiedIRCompilerError(
                'invalid-input',
                `Pin "${name}" configure() needs the circuit's pin_low_threshold memory`,
              );
            }
            thresholdPins?.add(globalId);
            builder.array.store(target, index(), builder.const('f32', low));
          }
          if (high !== undefined) {
            const target = memory.highThreshold;
            if (target === undefined) {
              throw new UnifiedIRCompilerError(
                'invalid-input',
                `Pin "${name}" configure() needs the circuit's pin_high_threshold memory`,
              );
            }
            thresholdPins?.add(globalId);
            builder.array.store(target, index(), builder.const('f32', high));
          }
          return;
        }
        const value = resolvePinMode(mode, name);
        // `{ }` configures nothing, so it emits no store at all.
        if (value === undefined) return;
        builder.array.store(memory.mode, index(), builder.const('u8', value));
      },
      pull(mode: PinPullName | PinPull): void {
        const target = memory.pull;
        if (target === undefined) {
          throw new UnifiedIRCompilerError(
            'invalid-input',
            `Pin "${name}" pull(${String(mode)}) needs the circuit's pin_pull memory`,
          );
        }
        pullPins?.add(globalId);
        builder.array.store(target, index(), builder.const('u8', resolvePinPull(mode, name)));
      },
      writeDigital(level: Value<'bool'>): void {
        builder.array.store(memory.output, index(), level);
      },
      writeAnalog(voltage: Value<'f32'> | number): void {
        const intent = memory.voltageIntent;
        if (intent === undefined) {
          throw new UnifiedIRCompilerError(
            'invalid-input',
            `Pin "${name}" writeAnalog() needs the circuit's pin_voltage_intent memory`,
          );
        }
        builder.array.store(intent, index(), resolveAnalogIntent(voltage, name, builder));
        // Analog output is a drive mode of its own: an intent only reaches the
        // solve while the pin is configured `analog` *and* its output is
        // enabled. `configure({ mode: 'analog' })` alone stays released, so a
        // bidirectional pin can read an analog net without driving it.
        builder.array.store(memory.output, index(), builder.const('bool', true));
        builder.array.store(memory.mode, index(), builder.const('u8', PIN_MODE.analog));
      },
      sampleDigital(): Value<'bool'> {
        // RFC 0007: an unpowered domain reads the determinate level 0 rather
        // than the solved net, so device logic never observes a live signal
        // without power. The gate costs one array load and one select.
        const level = builder.array.load(memory.input, index());
        return selectPowered(builder, emitPinPowered(builder, power, globalId), level);
      },
      sampleAnalog(): Value<'f32'> {
        const voltage = memory.voltage;
        if (voltage === undefined) {
          throw new UnifiedIRCompilerError(
            'invalid-input',
            `Pin "${name}" sampleAnalog() needs the circuit's pin_voltage memory`,
          );
        }
        const solved = builder.array.load(voltage, index());
        const powered = emitPinPowered(builder, power, globalId);
        // RFC 0007: an unpowered domain samples +0 V, matching the digital rule.
        return powered === undefined
          ? solved
          : builder.select(powered, solved, builder.const('f32', 0));
      },
      readDrivenDigital(): Value<'bool'> {
        return builder.array.load(memory.output, index());
      },
    });
  }
}

function createStateHandle<T extends ScalarType>(
  deviceId: string,
  slot: DeviceStateSlot,
  builder: FunctionBuilder<readonly []>,
): DeviceStateHandle<T> {
  // The array was declared with `slot.type`, so a matching `T` is exactly the
  // array's element type; the cast only recovers that from the untied slot.
  const array = slot.array as unknown as ArrayRef<T>;
  const index = builder.const('u32', slot.index);
  return Object.freeze({
    name: slot.name,
    type: slot.type as T,
    index: slot.index,
    load(): Value<T> {
      return builder.array.load(array, index);
    },
    store(value: Value<T>): void {
      builder.array.store(array, index, value);
    },
  });
}

/**
 * Normalises a `pin.configure` argument into a `pin_mode` value.
 *
 * Accepts the numeric `PIN_MODE` constant (what the low-level kernels use), the
 * authored mode name and the `{ mode }` object form. `undefined` means "write
 * nothing", which is what an object without a `mode` asks for.
 */
function resolvePinMode(mode: DevicePinConfigureMode, pinName: string): number | undefined {
  if (typeof mode === 'number') {
    if (!Number.isInteger(mode) || mode < 0 || mode > 0xff) {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        `Pin "${pinName}" configure(${String(mode)}) needs a u8 pin mode`,
      );
    }
    return mode;
  }
  if (typeof mode === 'string') {
    const value = PIN_MODE_BY_NAME[mode as PinModeName];
    if (value === undefined) {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        `Pin "${pinName}" configure(${JSON.stringify(mode)}) needs one of ${Object.keys(PIN_MODE_BY_NAME).join(', ')}`,
      );
    }
    return value;
  }
  if (mode !== null && typeof mode === 'object') {
    const nested = (mode as { readonly mode?: PinModeName | undefined }).mode;
    return nested === undefined ? undefined : resolvePinMode(nested, pinName);
  }
  throw new UnifiedIRCompilerError(
    'invalid-input',
    `Pin "${pinName}" configure(${String(mode)}) needs a pin mode, a mode name or { mode }`,
  );
}

/**
 * Validates one `pin.configure` threshold.
 *
 * Thresholds are absolute volts. The upper bound only catches unit mistakes
 * (millivolts passed as volts); the electrical model itself has no ceiling.
 */
function resolveThreshold(value: number, pinName: string, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > MAX_THRESHOLD_VOLTAGE) {
    throw new UnifiedIRCompilerError(
      'invalid-input',
      `Pin "${pinName}" configure(${field}) needs a finite voltage in [0, ${MAX_THRESHOLD_VOLTAGE}], received ${String(value)}`,
    );
  }
  return value;
}

/** Resolves the `writeAnalog` argument: an IR `f32` value or a volt literal. */
function resolveAnalogIntent(
  voltage: Value<'f32'> | number,
  pinName: string,
  builder: FunctionBuilder<readonly []>,
): Value<'f32'> {
  if (typeof voltage === 'number') {
    if (!Number.isFinite(voltage) || voltage < 0 || voltage > MAX_THRESHOLD_VOLTAGE) {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        `Pin "${pinName}" writeAnalog(${String(voltage)}) needs a finite voltage in [0, ${MAX_THRESHOLD_VOLTAGE}]`,
      );
    }
    return builder.const('f32', voltage);
  }
  if (voltage === null || typeof voltage !== 'object' || voltage.type !== 'f32') {
    throw new UnifiedIRCompilerError(
      'invalid-input',
      `Pin "${pinName}" writeAnalog() needs an f32 IR value or a voltage literal`,
    );
  }
  return voltage;
}

/** Normalises a `pin.pull` argument into a `pin_pull` value. */
function resolvePinPull(mode: PinPullName | PinPull, pinName: string): PinPull {
  if (typeof mode === 'number') {
    if (mode !== PIN_PULL.none && mode !== PIN_PULL.up && mode !== PIN_PULL.down) {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        `Pin "${pinName}" pull(${String(mode)}) needs PIN_PULL.none, PIN_PULL.up or PIN_PULL.down`,
      );
    }
    return mode;
  }
  const value = PIN_PULL_BY_NAME[mode];
  if (value === undefined) {
    throw new UnifiedIRCompilerError(
      'invalid-input',
      `Pin "${pinName}" pull(${JSON.stringify(mode)}) needs one of ${Object.keys(PIN_PULL_BY_NAME).join(', ')}`,
    );
  }
  return value;
}

/** Looks one pin handle up, reporting the pins the device actually declares. */
function requirePinHandle(
  deviceId: string,
  handles: ReadonlyMap<string, DevicePinHandle>,
  name: string,
): DevicePinHandle {
  const handle = handles.get(name);
  if (handle === undefined) {
    const available = [...handles.keys()].map((entry) => `${deviceId}.${entry}`);
    throw new UnifiedIRCompilerError(
      'pin-not-found',
      `Pin '${deviceId}.${name}' not found. Available: [${available.join(', ')}]`,
      { deviceId, pinName: name },
    );
  }
  return handle;
}

/**
 * Resolves the `writeDigital` argument of a pin group: an IR `u32` value or an
 * integer literal, which becomes a `const u32` at the call site.
 */
function pinGroupBits(
  deviceId: string,
  value: Value<'u32'> | number,
  builder: FunctionBuilder<readonly []>,
): Value<'u32'> {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        `Device "${deviceId}" pinGroup().writeDigital(${String(value)}) needs an integer in [0, 4294967295]`,
        { deviceId },
      );
    }
    return builder.const('u32', value);
  }
  if (value === null || typeof value !== 'object' || value.type !== 'u32') {
    throw new UnifiedIRCompilerError(
      'invalid-input',
      `Device "${deviceId}" pinGroup().writeDigital() needs a u32 IR value or an integer literal`,
      { deviceId },
    );
  }
  return value;
}

/** True when the description declares at least one logical topic port. */
function declaresPorts(device: DeviceConfig): boolean {
  const ports = device.description.ports;
  if (ports === undefined) return false;
  return ports instanceof Map ? ports.size > 0 : Object.keys(ports).length > 0;
}

/** Names a device declares in its `connections` / `observers` map. */
function domainNames(device: DeviceConfig, field: 'connections' | 'observers'): readonly string[] {
  const map =
    field === 'connections' ? device.description.connections : device.description.observers;
  if (map === undefined) return [];
  return map instanceof Map ? [...map.keys()] : Object.keys(map);
}

function hasAnyBehavior(behaviors: DeviceBehaviors): boolean {
  return (
    behaviors.initialize !== undefined ||
    behaviors.tick !== undefined ||
    behaviors.update !== undefined
  );
}

/** Bulk kernel results carry phase refs; behaviour hooks are plain functions. */
function isKernelRuntime(
  value: DeviceBehaviors | DeviceKernelRuntime,
): value is DeviceKernelRuntime {
  if (value === null || typeof value !== 'object') return false;
  // A kernel may own any subset of the phases (an LED only needs `update`), so
  // the first phase ref that is an object — not a behaviour callback — decides.
  const phases: readonly (keyof DeviceKernelRuntime)[] = ['initialize', 'tick', 'update'];
  return phases.some((phase) => typeof value[phase] === 'object');
}

/** Resolves one kernel phase ref to its generated function name. */
function phaseFromRef(
  module: IRModule,
  deviceId: string,
  ref: FunctionRef<readonly [], readonly []> | undefined,
): GeneratedPhase | undefined {
  if (ref === undefined) return undefined;
  const definition = module.functions.find((fn) => fn.ref === ref);
  if (definition === undefined) {
    throw new UnifiedIRCompilerError(
      'invalid-ir',
      `Device "${deviceId}" returned a kernel phase ref that is not part of the module`,
      { deviceId },
    );
  }
  return { name: definition.name, ref };
}
