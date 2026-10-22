import type { IRBuilderExtension, IRInstructionValidator, IRModule } from '@mica-js/ir';
import type { DevicePinDescriptor, DevicePinHost } from '../types';
import { createPinBuilderExtension } from './builder';
import { PinCatalog } from './catalog';
import { declarePinInstructions, type PinInstructionSet } from './instructions';
import { collectPinReferences, PinRuntime } from './runtime';
import { createPinValidators } from './validators';

/** Device-side pin domain: declarations, builder operations, validators and execution state. */
export class PinDomain {
  readonly catalog: PinCatalog;
  readonly extension: IRBuilderExtension;
  readonly #module: () => IRModule;
  readonly #deviceId: string;
  #instructions: PinInstructionSet | undefined;

  constructor(
    pins: ReadonlyMap<string, DevicePinDescriptor>,
    module: () => IRModule,
    deviceId: string,
  ) {
    this.catalog = new PinCatalog(pins);
    this.#module = module;
    this.#deviceId = deviceId;
    this.extension = createPinBuilderExtension(this.catalog, () => this.instructions());
  }

  instructions(): PinInstructionSet {
    this.#instructions ??= declarePinInstructions(this.#module());
    return this.#instructions;
  }

  validators(): readonly IRInstructionValidator[] {
    return createPinValidators(this.catalog);
  }

  createRuntime(instanceId: string, host: DevicePinHost | undefined): PinRuntime {
    return new PinRuntime(instanceId, this.#deviceId, this.catalog, host);
  }

  references(module: IRModule): readonly string[] {
    return collectPinReferences(module, this.catalog);
  }
}
