import { IRConstructionError } from '@mica-js/ir';
import type { FunctionBuilder, IRBuilderExtension, Value } from '@mica-js/ir';
import type { PinConfig, PinOperations, PinRef } from '../types';
import type { PinCatalog } from './catalog';
import {
  PIN_MODE_CODES,
  PIN_PULL_CODES,
  type PinInstructionSet,
  type PinMode,
  type PinPull,
} from './instructions';

/** Lowers `b.pin` calls to the declared explicit pin instructions. */
export function createPinBuilderExtension(
  catalog: PinCatalog,
  instructions: () => PinInstructionSet,
): IRBuilderExtension {
  return {
    namespace: 'pin',
    create(builder: FunctionBuilder): Readonly<Record<string, unknown>> {
      const pins = instructions();
      const operations: PinOperations = {
        configure(pin, config) {
          requireSignal(catalog, pin, 'configure');
          if (typeof config !== 'object' || config === null) {
            throw new IRConstructionError('pin.configure requires a configuration object');
          }
          const mode = modeCode(config.mode);
          if (typeof config.outputEnabled !== 'boolean') {
            throw new IRConstructionError('pin.configure outputEnabled must be a boolean');
          }
          const pull = pullCode(config.pull);
          builder.invoke(pins.configure, [pin, mode, config.outputEnabled, pull]);
          return undefined;
        },
        writeDigital(pin, level) {
          requireSignal(catalog, pin, 'writeDigital');
          builder.invoke(pins.writeDigital, [pin, level]);
          return undefined;
        },
        sampleDigital(pin) {
          requireSignal(catalog, pin, 'sampleDigital');
          return builder.invoke(pins.sampleDigital, [pin])[0] as Value<'u32'>;
        },
      };
      return operations as unknown as Readonly<Record<string, unknown>>;
    },
  };
}

function requireSignal(catalog: PinCatalog, pin: PinRef, operation: string): void {
  const descriptor = catalog.descriptor(pin);
  if (descriptor !== undefined && descriptor.kind !== 'signal') {
    throw new IRConstructionError(
      `pin.${operation} requires a signal pin; ${JSON.stringify(descriptor.key)} is ${descriptor.kind}`,
    );
  }
}

function modeCode(mode: PinConfig['mode']): number {
  if (typeof mode !== 'string' || !(mode in PIN_MODE_CODES)) {
    throw new IRConstructionError(`Unknown pin mode ${JSON.stringify(mode)}`);
  }
  return PIN_MODE_CODES[mode as PinMode];
}

function pullCode(pull: PinConfig['pull']): number {
  if (typeof pull !== 'string' || !(pull in PIN_PULL_CODES)) {
    throw new IRConstructionError(`Unknown pin pull ${JSON.stringify(pull)}`);
  }
  return PIN_PULL_CODES[pull as PinPull];
}
