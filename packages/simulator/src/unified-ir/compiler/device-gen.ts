import type {
  ArrayRef,
  EntryRef,
  FunctionBuilder,
  FunctionRef,
  IRModule,
  ScalarType,
  Value,
} from '@mica-js/ir';
import type { ElectricalOperations } from './electrical-operations';
import { stateOffsetOf } from './allocator';
import {
  UnifiedIRCompilerError,
  type DeviceBehaviorApi,
  type DeviceBehaviors,
  type DeviceConfig,
  type DeviceKernelRuntime,
  type DeviceMetadata,
  type DevicePinAllocation,
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
  readonly pins: GlobalPinMap;
  readonly states: GlobalStateMap;
  readonly electrical: ElectricalOperations;
}

/**
 * Generates one IR function per device phase into the unified module.
 *
 * Domain operations use the shared resistive electrical network, including
 * explicit output configuration, finite drive impedance and solved sampling.
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
   * @throws {UnifiedIRCompilerError} when a behavior reaches for a pin or state
   *   the paired description does not declare.
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
    const functionOffset = this.context.module.functions.length;
    const kernelResult = device.description.kernel?.({
      deviceId: device.id,
      config: device.config,
      module: this.context.module,
      bind: (builder) => this.createApi(device, allocation, builder),
      pins: [...allocation.resolved.values()].map((pin) =>
        Object.freeze({
          name: pin.name,
          globalPinId: pin.globalPinId,
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
      initialize = this.generatePhase(device, allocation, 'initialize', behaviors?.initialize);
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
      entries: Object.freeze(
        this.context.module.functions
          .slice(functionOffset)
          .filter((fn) => fn.category === 'entry')
          .map((fn) => fn.ref as EntryRef),
      ),
      pinOffset: allocation.offset,
      stateOffset: stateOffsetOf(this.context.states, device.id),
      pins: allocation.pins,
      states: this.context.states.devices.get(device.id) ?? new Map(),
      functions: Object.freeze(functions),
      initialize: initialize?.name,
      tick: tick?.name,
      update: update?.name,
      accessor: device.description.accessor,
      ...(device.description.applyInputs === undefined
        ? {}
        : { applyInputs: device.description.applyInputs }),
      ...(device.description.flushOutputs === undefined
        ? {}
        : { flushOutputs: device.description.flushOutputs }),
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

  private createApi(
    device: DeviceConfig,
    allocation: DevicePinAllocation,
    builder: FunctionBuilder<readonly []>,
  ): DeviceBehaviorApi {
    const slots = this.context.states.devices.get(device.id);
    const electrical = this.context.electrical.bindDevice(
      device.id,
      builder,
      new Map([...allocation.resolved].map(([name, pin]) => [name, pin.globalPinId])),
    );
    return Object.freeze({
      deviceId: device.id,
      builder,
      module: this.context.module,
      config: device.config,
      pins: electrical.pins,
      outputs: electrical.outputs,
      resistor: electrical.resistor,
      writeDigitalGroup: electrical.writeDigitalGroup,
      applyResistors: electrical.applyResistors,
      applyConnections: electrical.applyConnections,
      pin: electrical.pin,
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
