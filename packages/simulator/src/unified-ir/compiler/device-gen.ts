import type {
  ArrayRef,
  FunctionBuilder,
  FunctionRef,
  IRModule,
  ScalarType,
  Value,
} from '@mica-js/ir';
import { PIN_MODE } from '../pin-space';
import type { ElectricalOperations } from './electrical-operations';
import { stateOffsetOf } from './allocator';
import {
  UnifiedIRCompilerError,
  type CompiledCircuitMemory,
  type DeviceBehaviorApi,
  type DeviceBehaviors,
  type DeviceConfig,
  type DeviceKernelRuntime,
  type DeviceMetadata,
  type DevicePinAllocation,
  type DevicePinHandle,
  type DeviceStateHandle,
  type DeviceStateSlot,
  type GlobalPinMap,
  type GlobalStateMap,
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

/** Everything the device generator reads from the prior compilation stages. */
export interface DeviceGenerationContext {
  readonly module: IRModule;
  readonly memory: CompiledCircuitMemory;
  readonly pins: GlobalPinMap;
  readonly states: GlobalStateMap;
  readonly electrical?: ElectricalOperations;
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
 * The compiler ships no device models: every description must declare its own
 * pins, states and behaviors (or a `kernel`) before it reaches this generator.
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
      bind: (builder) => this.createApi(device, allocation, builder),
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
      if (
        this.context.electrical === undefined &&
        (behaviors === undefined || !hasAnyBehavior(behaviors))
      ) {
        throw new UnifiedIRCompilerError(
          'unsupported-device',
          `Device "${device.id}" of type "${device.type}" declares no behaviors. Provide description.behaviors or description.kernel`,
          { deviceId: device.id },
        );
      }
      initialize =
        this.generatePhase(device, allocation, 'initialize', behaviors?.initialize) ??
        (this.context.electrical === undefined
          ? this.generateDefaultInitialize(device, allocation)
          : undefined);
      tick = this.generatePhase(device, allocation, 'tick', behaviors?.tick);
      update = this.generatePhase(device, allocation, 'update', behaviors?.update);
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
    const electrical = this.context.electrical?.bindDevice(
      device.id,
      builder,
      new Map([...allocation.resolved].map(([name, pin]) => [name, pin.globalPinId])),
    );
    const requireElectrical = (): never => {
      throw new UnifiedIRCompilerError(
        'unsupported-device',
        `Device "${device.id}" requires the resistive electrical compiler`,
      );
    };
    return Object.freeze({
      deviceId: device.id,
      builder,
      module: this.context.module,
      config: device.config,
      pins: electrical?.pins ?? Object.freeze(pins),
      outputs: electrical?.outputs ?? Object.freeze(outputs),
      resistor: electrical?.resistor ?? requireElectrical,
      writeDigitalGroup: electrical?.writeDigitalGroup ?? requireElectrical,
      applyResistors: electrical?.applyResistors ?? requireElectrical,
      applyConnections: electrical?.applyConnections ?? requireElectrical,
      pin(name: string): DevicePinHandle {
        if (electrical !== undefined) return electrical.pin(name);
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
      setOutputEnabled(): never {
        throw new UnifiedIRCompilerError(
          'unsupported-device',
          'Output enable requires the resistive electrical compiler',
        );
      },
      setPull(): never {
        throw new UnifiedIRCompilerError(
          'unsupported-device',
          'Pull selection requires the resistive electrical compiler',
        );
      },
      writeVoltage(): never {
        throw new UnifiedIRCompilerError(
          'unsupported-device',
          'Voltage output requires the resistive electrical compiler',
        );
      },
      writeDigital(level: Value<'bool'>): void {
        builder.array.store(memory.output, index(), level);
      },
      sampleDigital(): Value<'bool'> {
        return builder.array.load(memory.input, index());
      },
      sampleVoltage(): never {
        throw new UnifiedIRCompilerError(
          'unsupported-device',
          'Voltage sampling requires the resistive electrical compiler',
        );
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
  if (value === null || typeof value !== 'object') return false;
  // A kernel may own any subset of the phases (a passive sink only needs
  // `update`), so the first phase ref that is an object — not a behaviour
  // callback — decides.
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
