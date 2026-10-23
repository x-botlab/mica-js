import type { IRBuilderExtension, IRInstructionValidator, IRModule } from '@mica-js/ir';
import type { PinCatalog } from '../pins/catalog';
import type { DevicePinHost, ObserverRef } from '../types';
import { createObserveBuilderExtension } from './builder';
import { ObserveCatalog } from './catalog';
import { declareObserveInstructions, type ObserveInstructionSet } from './instructions';
import { ObserveRuntime } from './runtime';
import { createObserveValidators } from './validators';

/** Device-side digital observation domain: declarations, builder, validators and runtime. */
export class ObserveDomain {
  readonly catalog: ObserveCatalog;
  readonly extension: IRBuilderExtension;
  readonly #module: () => IRModule;
  readonly #deviceId: string;
  #instructions: ObserveInstructionSet | undefined;

  constructor(pins: PinCatalog, module: () => IRModule, deviceId: string) {
    this.catalog = new ObserveCatalog(pins, deviceId);
    this.#module = module;
    this.#deviceId = deviceId;
    this.extension = createObserveBuilderExtension(
      this.catalog,
      () => this.instructions(),
      deviceId,
    );
  }

  instructions(): ObserveInstructionSet {
    this.#instructions ??= declareObserveInstructions(this.#module());
    return this.#instructions;
  }

  validators(): readonly IRInstructionValidator[] {
    return createObserveValidators(this.catalog);
  }

  declare(module: IRModule, name: unknown, descriptor: unknown): ObserverRef {
    return this.catalog.declare(module, name, descriptor);
  }

  assertReady(module: IRModule): void {
    this.catalog.validate(module);
  }

  createRuntime(instanceId: string, host: DevicePinHost | undefined): ObserveRuntime {
    return new ObserveRuntime(instanceId, this.#deviceId, this.catalog, host);
  }
}
