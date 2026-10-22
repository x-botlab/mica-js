import type { ElectricalPinInput } from '@mica-js/core';
import type { IRInstructionExecution, IRInstructionExecutor, IRModule } from '@mica-js/ir';
import { DeviceError } from '../errors';
import type { DevicePinHost, PinRef } from '../types';
import type { PinCatalog } from './catalog';
import { PIN_INSTRUCTION_NAMES } from './instructions';

interface DigitalIntent {
  readonly ready: boolean;
  readonly value: boolean;
}

interface PinRuntimeState {
  readonly mode: ElectricalPinInput['mode'];
  readonly outputEnabled: boolean;
  readonly pull: ElectricalPinInput['pull'];
  readonly digital: DigitalIntent;
}

const INITIAL_STATE: PinRuntimeState = Object.freeze({
  mode: 'high-z',
  outputEnabled: false,
  pull: 'none',
  digital: Object.freeze({ ready: false, value: false }),
});

/** Per-instance held pin configuration and intent, submitted to the #51 pin host. */
export class PinRuntime {
  readonly #instanceId: string;
  readonly #deviceId: string;
  readonly #catalog: PinCatalog;
  readonly #host: DevicePinHost | undefined;
  readonly #states = new Map<string, PinRuntimeState>();
  readonly #bases = new Map<string, ElectricalPinInput>();

  constructor(
    instanceId: string,
    deviceId: string,
    catalog: PinCatalog,
    host: DevicePinHost | undefined,
  ) {
    this.#instanceId = instanceId;
    this.#deviceId = deviceId;
    this.#catalog = catalog;
    this.#host = host;
  }

  executors(): readonly IRInstructionExecutor[] {
    return [
      { op: 'pin.configure', execute: (context) => this.#configure(context) },
      { op: 'pin.write_digital', execute: (context) => this.#writeDigital(context) },
      { op: 'pin.sample_digital', execute: (context) => this.#sampleDigital(context) },
    ];
  }

  /**
   * Read-only link check: every referenced pin must be known by the pin host. Initial states are
   * only submitted by {@link prepare} after the IR module has been accepted.
   */
  assertReady(keys: readonly string[]): void {
    if (keys.length === 0) {
      return;
    }
    const host = this.#host;
    if (host === undefined) {
      throw this.#unavailable('pin instructions require DeviceInstanceOptions.pinHost');
    }
    for (const key of keys) {
      if (this.#bases.has(key)) {
        continue;
      }
      try {
        this.#bases.set(key, host.pinIntent(this.#ref(key)));
      } catch (cause) {
        throw this.#unavailable(`the pin host does not provide pin ${JSON.stringify(key)}`, cause);
      }
    }
  }

  /** Submits the #12 initial state for referenced pins after link succeeds. */
  prepare(keys: readonly string[]): void {
    for (const key of keys) {
      try {
        this.#submit(key, INITIAL_STATE);
      } catch (cause) {
        throw this.#unavailable(
          `the pin host rejected the initial state for pin ${JSON.stringify(key)}`,
          cause,
        );
      }
    }
  }

  /** Best-effort restoration of the host's pre-device intent when the instance is destroyed. */
  release(): void {
    const host = this.#host;
    if (host === undefined) {
      return;
    }
    for (const base of this.#bases.values()) {
      try {
        host.updatePinStates([base]);
      } catch {
        // Destroy must still complete when the scheduler is faulted or the host is gone.
      }
    }
    this.#states.clear();
  }

  #configure(context: IRInstructionExecution): readonly [] {
    const key = this.#key(context);
    const mode = literal(context, 1);
    const outputEnabled = literal(context, 2);
    const pull = literal(context, 3);
    if (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0 || mode > 3) {
      throw new RangeError('pin.configure mode must be an integer in [0, 3]');
    }
    if (typeof outputEnabled !== 'boolean') {
      throw new TypeError('pin.configure outputEnabled must be a boolean');
    }
    if (typeof pull !== 'number' || !Number.isInteger(pull) || pull < 0 || pull > 2) {
      throw new RangeError('pin.configure pull must be an integer in [0, 2]');
    }
    const next: PinRuntimeState = Object.freeze({
      mode: MODES[mode]!,
      outputEnabled,
      pull: PULLS[pull]!,
      digital: this.#state(key).digital,
    });
    this.#submit(key, next);
    this.#states.set(key, next);
    return [];
  }

  #writeDigital(context: IRInstructionExecution): readonly [] {
    const key = this.#key(context);
    const level = context.operands[0];
    if (typeof level !== 'boolean') {
      throw new TypeError('pin.write_digital level must be a bool value');
    }
    const current = this.#state(key);
    const next: PinRuntimeState = Object.freeze({
      ...current,
      digital: Object.freeze({ ready: true, value: level }),
    });
    this.#submit(key, next);
    this.#states.set(key, next);
    return [];
  }

  #sampleDigital(context: IRInstructionExecution): readonly [number] {
    const key = this.#key(context);
    const host = this.#host;
    if (host === undefined) {
      throw new Error(`pin.sample_digital for ${JSON.stringify(key)} requires a pin host`);
    }
    const sample = host.sampleDigital(this.#ref(key));
    return [sample.value];
  }

  #key(context: IRInstructionExecution): string {
    const operand = context.instruction.operands[0];
    if (operand?.kind !== 'static') {
      throw new TypeError('pin instruction requires a static pin reference');
    }
    const descriptor = this.#catalog.descriptor(operand.ref as PinRef);
    if (descriptor === undefined) {
      throw new TypeError('pin instruction references a pin outside this device module');
    }
    if (descriptor.kind !== 'signal') {
      throw new TypeError(
        `pin ${JSON.stringify(descriptor.key)} is a ${descriptor.kind} pin and does not support I/O`,
      );
    }
    return descriptor.key;
  }

  #state(key: string): PinRuntimeState {
    return this.#states.get(key) ?? INITIAL_STATE;
  }

  #submit(key: string, state: PinRuntimeState): void {
    const host = this.#host;
    if (host === undefined) {
      throw new Error(`pin I/O for ${JSON.stringify(key)} requires a pin host`);
    }
    // Preserve the host's current electrical model/readiness while replacing only the device's
    // configuration and held intents. The original link-time snapshot stays untouched for release.
    const current = host.pinIntent(this.#ref(key));
    const submission: ElectricalPinInput = Object.freeze({
      instanceId: this.#instanceId,
      pinName: key,
      powerReady: current.powerReady,
      mode: state.mode,
      outputEnabled: state.outputEnabled,
      pull: state.pull,
      ...(state.digital.ready ? { digitalIntent: state.digital.value } : {}),
      model: current.model,
    });
    host.updatePinStates([submission]);
  }

  #ref(key: string) {
    return Object.freeze({ instanceId: this.#instanceId, pinName: key });
  }

  #unavailable(message: string, cause?: unknown): DeviceError {
    return new DeviceError(
      'device/pin-io-unavailable',
      `Device ${JSON.stringify(this.#deviceId)} cannot use pin I/O: ${message}.`,
      { deviceId: this.#deviceId, ...(cause === undefined ? {} : { cause }) },
    );
  }
}

const MODES: readonly ElectricalPinInput['mode'][] = [
  'high-z',
  'push-pull',
  'open-drain',
  'analog',
];
const PULLS: readonly ElectricalPinInput['pull'][] = ['none', 'up', 'down'];

function literal(
  context: IRInstructionExecution,
  index: number,
): boolean | number | string | undefined {
  const operand = context.instruction.operands[index];
  return operand?.kind === 'literal' ? operand.value : undefined;
}

/** Collects pin ids referenced by the pin instruction subset, sorted for determinism. */
export function collectPinReferences(module: IRModule, catalog: PinCatalog): readonly string[] {
  const keys = new Set<string>();
  for (const fn of module.functions) {
    for (const block of fn.body?.blocks ?? []) {
      for (const node of block.instructions) {
        if (!(PIN_INSTRUCTION_NAMES as readonly string[]).includes(node.op)) {
          continue;
        }
        for (const operand of node.operands) {
          if (operand.kind !== 'static') {
            continue;
          }
          const descriptor = catalog.descriptor(operand.ref as PinRef);
          if (descriptor !== undefined) {
            keys.add(descriptor.key);
          }
        }
      }
    }
  }
  return Object.freeze([...keys].sort());
}
