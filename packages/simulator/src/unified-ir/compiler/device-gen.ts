import type {
  ArrayRef,
  FunctionBuilder,
  FunctionRef,
  IRModule,
  ScalarType,
  Value,
} from '@mica-js/ir';
import { PIN_MODE } from '../types';
import { stateOffsetOf } from './allocator';
import {
  UnifiedIRCompilerError,
  type CompiledCircuitMemory,
  type DeviceBehaviorApi,
  type DeviceBehaviors,
  type DeviceConfig,
  type DeviceDescription,
  type DeviceKernelRuntime,
  type DeviceMetadata,
  type DevicePinAllocation,
  type DevicePinDescription,
  type DevicePinHandle,
  type DeviceStateDescription,
  type DeviceStateHandle,
  type DeviceStateSlot,
  type GlobalPinMap,
  type GlobalStateMap,
  type LedDescriptionOptions,
  type McuDescriptionOptions,
} from './types';

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
    if (kernelRuntime !== undefined) {
      initialize = phaseFromRef(this.context.module, device.id, kernelRuntime.initialize);
      tick = phaseFromRef(this.context.module, device.id, kernelRuntime.tick);
      update = phaseFromRef(this.context.module, device.id, kernelRuntime.update);
    } else {
      if (behaviors === undefined || !hasAnyBehavior(behaviors)) {
        throw new UnifiedIRCompilerError(
          'unsupported-device',
          `Device "${device.id}" of type "${device.type}" declares no behaviors and the type has no built-in kernel. Provide description.behaviors or use one of: [${BUILTIN_DEVICE_TYPES.join(', ')}]`,
          { deviceId: device.id },
        );
      }
      initialize =
        this.generatePhase(device, allocation, 'initialize', behaviors.initialize) ??
        this.generateDefaultInitialize(device, allocation);
      tick = this.generatePhase(device, allocation, 'tick', behaviors.tick);
      update = this.generatePhase(device, allocation, 'update', behaviors.update);
    }

    const functions: string[] = [];
    for (const phase of [initialize, tick, update]) {
      if (phase !== undefined) functions.push(phase.name);
    }

    const metadata: DeviceMetadata = Object.freeze({
      deviceId: device.id,
      type: device.type,
      pinOffset: allocation.offset,
      stateOffset: stateOffsetOf(this.context.states, device.id),
      pins: allocation.pins,
      states: this.context.states.devices.get(device.id) ?? new Map(),
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
  ): GeneratedPhase | undefined {
    if (behavior === undefined) return undefined;
    const name = `${device.id}_${phase}`;
    const ref = this.context.module.func(name, { params: [], results: [] });
    ref.body((b) => {
      behavior(this.createApi(device, allocation, b));
      b.return([]);
    });
    return { name, ref };
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
  ): DeviceBehaviorApi {
    const handles = new Map<string, DevicePinHandle>();
    const pins: DevicePinHandle[] = [];
    const outputs: DevicePinHandle[] = [];
    for (const pin of allocation.resolved.values()) {
      const handle = this.createPinHandle(pin.globalPinId, pin.name, builder);
      handles.set(pin.name, handle);
      pins.push(handle);
      if (pin.role === 'driver') outputs.push(handle);
    }
    const slots = this.context.states.devices.get(device.id);
    return Object.freeze({
      deviceId: device.id,
      builder,
      module: this.context.module,
      memory: this.context.memory,
      config: device.config,
      pins: Object.freeze(pins),
      outputs: Object.freeze(outputs),
      pin(name: string): DevicePinHandle {
        const handle = handles.get(name);
        if (handle === undefined) {
          const available = [...handles.keys()].map((entry) => `${device.id}.${entry}`);
          throw new UnifiedIRCompilerError(
            'pin-not-found',
            `Pin '${device.id}.${name}' not found. Available: [${available.join(', ')}]`,
            { deviceId: device.id, pinName: name },
          );
        }
        return handle;
      },
      state<T extends ScalarType = ScalarType>(name: string): DeviceStateHandle<T> {
        const slot = slots?.get(name);
        if (slot === undefined) {
          throw new UnifiedIRCompilerError(
            'state-not-found',
            `Device "${device.id}" has no state "${name}". Available: [${[...(slots?.keys() ?? [])].join(', ')}]`,
            { deviceId: device.id },
          );
        }
        return createStateHandle<T>(device.id, slot, builder);
      },
    });
  }

  private createPinHandle(
    globalId: number,
    name: string,
    builder: FunctionBuilder<readonly []>,
  ): DevicePinHandle {
    const memory = this.context.memory;
    // Resolved lazily so a behavior that only samples a pin does not also emit
    // an unused constant for every other pin of the device.
    const index = (): Value<'u32'> => builder.const('u32', globalId);
    return Object.freeze({
      name,
      globalId,
      configure(mode: number): void {
        if (!Number.isInteger(mode) || mode < 0 || mode > 0xff) {
          throw new UnifiedIRCompilerError(
            'invalid-input',
            `Pin "${name}" configure(${String(mode)}) needs a u8 pin mode`,
          );
        }
        builder.array.store(memory.mode, index(), builder.const('u8', mode));
      },
      writeDigital(level: Value<'bool'>): void {
        builder.array.store(memory.output, index(), level);
      },
      sampleDigital(): Value<'bool'> {
        return builder.array.load(memory.input, index());
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
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { tick?: unknown }).tick === 'object'
  );
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
