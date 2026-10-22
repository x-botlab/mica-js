import type {
  EntryRef,
  IRInstructionExecution,
  IRInstructionExecutor,
  RuntimeScalar,
} from '@mica-js/ir';
import type { PowerDigitalPinChange, PowerDigitalSample, TopologyPinRef } from '@mica-js/core';
import { DeviceError } from '../errors';
import type { DevicePinHost, ObserverRef, PinRef } from '../types';
import {
  type ObserveCatalog,
  type ObserverDescriptor,
  observeConfigError,
  observeUnavailableError,
} from './catalog';
import type { ObserveEdgeCode } from './instructions';

type Continuity = 'disabled' | 'definite' | 'unavailable' | 'indeterminate' | 'floating';

interface ObserverState {
  readonly enabled: boolean;
  readonly edges: ObserveEdgeCode;
  readonly baseline: 0 | 1 | undefined;
  readonly continuity: Continuity;
}

const DISABLED: ObserverState = Object.freeze({
  enabled: false,
  edges: 1,
  baseline: undefined,
  continuity: 'disabled',
});

interface ObserveRuntimeHost {
  enqueueMessage(target: EntryRef, args: readonly RuntimeScalar[]): number;
}

/**
 * Per-instance digital edge observation: baseline tracking, capture payload construction and
 * ordinary-entry delivery. Thresholds, gating and electrical interpretation stay in #51.
 */
export class ObserveRuntime {
  readonly #instanceId: string;
  readonly #deviceId: string;
  readonly #catalog: ObserveCatalog;
  readonly #host: DevicePinHost | undefined;
  readonly #states = new Map<ObserverRef, ObserverState>();
  #runtime: ObserveRuntimeHost | undefined;
  #dispose: (() => void) | undefined;
  #released = false;

  constructor(
    instanceId: string,
    deviceId: string,
    catalog: ObserveCatalog,
    host: DevicePinHost | undefined,
  ) {
    this.#instanceId = instanceId;
    this.#deviceId = deviceId;
    this.#catalog = catalog;
    this.#host = host;
  }

  executors(): readonly IRInstructionExecutor[] {
    return [{ op: 'observe.configure', execute: (context) => this.#configure(context) }];
  }

  /** @throws {DeviceError} when observation is declared without a capable pin host. */
  assertReady(): void {
    if (this.#catalog.entries().length === 0) {
      return;
    }
    const host = this.#host;
    if (host === undefined) {
      throw observeUnavailableError(
        this.#deviceId,
        'observation requires DeviceInstanceOptions.pinHost',
      );
    }
    if (typeof host.addDigitalPinObserver !== 'function') {
      throw observeUnavailableError(
        this.#deviceId,
        'the pin host does not provide digital pin change observation',
      );
    }
  }

  pinReferences(): readonly string[] {
    const keys = new Set<string>();
    for (const descriptor of this.#catalog.entries()) {
      keys.add(descriptor.triggerKey);
      for (const key of descriptor.captureKeys) keys.add(key);
    }
    return Object.freeze([...keys].sort());
  }

  attach(runtime: ObserveRuntimeHost): void {
    if (this.#released) {
      throw observeUnavailableError(this.#deviceId, 'observation is no longer available');
    }
    this.#runtime = runtime;
  }

  /** Subscribes to the host after link succeeds; must be paired with {@link release}. */
  register(): void {
    if (this.#catalog.entries().length === 0 || this.#dispose !== undefined) {
      return;
    }
    const host = this.#host;
    if (host === undefined || typeof host.addDigitalPinObserver !== 'function') {
      throw observeUnavailableError(
        this.#deviceId,
        'the pin host does not provide digital pin change observation',
      );
    }
    let dispose: unknown;
    try {
      dispose = host.addDigitalPinObserver.call(host, {
        onDigitalPinChange: (changes) => this.#onDigitalPinChange(changes),
      });
    } catch (cause) {
      throw observeUnavailableError(
        this.#deviceId,
        'the pin host rejected digital pin change observation',
        cause,
      );
    }
    if (typeof dispose !== 'function') {
      throw observeUnavailableError(
        this.#deviceId,
        'the pin host did not return an observation disposer',
      );
    }
    this.#dispose = dispose as () => void;
  }

  /** Best-effort unsubscription; observation state is dropped even if the host throws. */
  release(): void {
    if (this.#released) {
      return;
    }
    this.#released = true;
    this.#runtime = undefined;
    this.#states.clear();
    const dispose = this.#dispose;
    this.#dispose = undefined;
    if (dispose !== undefined) {
      try {
        dispose();
      } catch {
        // Destroy must still complete when the host rejects unsubscription.
      }
    }
  }

  #configure(context: IRInstructionExecution): readonly [] {
    if (this.#released) {
      throw observeUnavailableError(this.#deviceId, 'observe.configure was used after release');
    }
    const binding = context.instruction.operands[0];
    if (binding?.kind !== 'static') {
      throw observeConfigError(
        this.#deviceId,
        'observe.configure requires a static observation binding',
      );
    }
    const descriptor = this.#catalog.descriptor(binding.ref as ObserverRef);
    if (descriptor === undefined) {
      throw observeConfigError(
        this.#deviceId,
        'observe.configure references an observation binding outside this device',
      );
    }
    const enabled = literal(context, 1);
    if (typeof enabled !== 'boolean') {
      throw observeConfigError(
        this.#deviceId,
        'observe.configure enabled must be a boolean literal',
      );
    }
    const edges = literal(context, 2);
    if (edges === 0) {
      throw observeConfigError(
        this.#deviceId,
        'observe.configure edges=0 state observation is not supported for digital edge bindings',
      );
    }
    if (typeof edges !== 'number' || !Number.isInteger(edges) || edges < 1 || edges > 3) {
      throw observeConfigError(
        this.#deviceId,
        'observe.configure edges must be an integer literal 1, 2, or 3',
      );
    }
    const next = enabled
      ? this.#baseline(descriptor.trigger, edges as ObserveEdgeCode)
      : { ...DISABLED, edges: edges as ObserveEdgeCode };
    this.#states.set(descriptor.ref, next);
    return [];
  }

  #onDigitalPinChange(changes: readonly PowerDigitalPinChange[]): void {
    if (this.#released) {
      return;
    }
    const changed = new Set<string>();
    for (const change of changes) {
      if (change.instanceId === this.#instanceId) changed.add(change.pinName);
    }
    if (changed.size === 0) {
      return;
    }
    for (const descriptor of this.#catalog.entries()) {
      if (!changed.has(descriptor.triggerKey)) {
        continue;
      }
      const state = this.#states.get(descriptor.ref) ?? DISABLED;
      if (!state.enabled) {
        continue;
      }
      const sample = this.#sample(descriptor.trigger);
      if (!sample.ready) {
        if (state.continuity !== 'unavailable' || state.baseline !== undefined) {
          this.#states.set(descriptor.ref, {
            ...state,
            baseline: undefined,
            continuity: 'unavailable',
          });
        }
        continue;
      }
      if (sample.source === 'sampled') {
        if (state.continuity !== 'definite' || state.baseline === undefined) {
          this.#states.set(descriptor.ref, {
            ...state,
            baseline: sample.value,
            continuity: 'definite',
          });
          continue;
        }
        if (sample.value === state.baseline) {
          continue;
        }
        this.#states.set(descriptor.ref, { ...state, baseline: sample.value });
        const edge: ObserveEdgeCode = sample.value === 1 ? 1 : 2;
        if (state.edges === edge || state.edges === 3) {
          this.#deliver(descriptor.target as EntryRef, descriptor, edge);
        }
        continue;
      }
      if (sample.source === 'floating') {
        this.#states.set(descriptor.ref, {
          ...state,
          baseline: 0,
          continuity: 'floating',
        });
        continue;
      }
      if (sample.source === 'threshold-range') {
        this.#states.set(descriptor.ref, {
          ...state,
          baseline: undefined,
          continuity: 'indeterminate',
        });
        continue;
      }
      this.#states.set(descriptor.ref, {
        ...state,
        baseline: undefined,
        continuity: 'unavailable',
      });
    }
  }

  #deliver(target: EntryRef, descriptor: ObserverDescriptor, edge: ObserveEdgeCode): void {
    const runtime = this.#runtime;
    if (runtime === undefined) {
      throw observeUnavailableError(this.#deviceId, 'observation is not attached to an instance');
    }
    const payload: RuntimeScalar[] = [edge];
    for (const pin of descriptor.captures) payload.push(this.#sample(pin).value);
    runtime.enqueueMessage(target, payload);
  }

  #baseline(trigger: PinRef, edges: ObserveEdgeCode): ObserverState {
    const sample = this.#sample(trigger);
    if (sample.ready && sample.source === 'sampled') {
      return { enabled: true, edges, baseline: sample.value, continuity: 'definite' };
    }
    if (sample.ready && sample.source === 'floating') {
      return { enabled: true, edges, baseline: 0, continuity: 'floating' };
    }
    if (sample.ready && sample.source === 'threshold-range') {
      return { enabled: true, edges, baseline: undefined, continuity: 'indeterminate' };
    }
    return { enabled: true, edges, baseline: undefined, continuity: 'unavailable' };
  }

  #sample(pin: PinRef): PowerDigitalSample {
    const host = this.#host;
    if (host === undefined) {
      throw observeUnavailableError(this.#deviceId, 'observation requires a pin host');
    }
    try {
      return host.sampleDigital(this.#ref(pin));
    } catch (cause) {
      throw observeUnavailableError(
        this.#deviceId,
        'the pin host rejected observation sampling',
        cause,
      );
    }
  }

  #ref(pin: PinRef): TopologyPinRef {
    const key = this.#catalog.pinKey(pin);
    if (key === undefined) {
      throw new DeviceError(
        'device/observe-pin',
        `Device ${JSON.stringify(this.#deviceId)} observation pin is not declared by this device.`,
        { deviceId: this.#deviceId },
      );
    }
    return Object.freeze({ instanceId: this.#instanceId, pinName: key });
  }
}

function literal(
  context: IRInstructionExecution,
  index: number,
): boolean | number | string | undefined {
  const operand = context.instruction.operands[index];
  return operand?.kind === 'literal' ? operand.value : undefined;
}
