import type { IRInstructionValidationContext, IRInstructionValidator } from '@mica-js/ir';
import type { PinCatalog } from './catalog';
import type { PinRef } from '../types';

export function createPinValidators(catalog: PinCatalog): readonly IRInstructionValidator[] {
  return [
    {
      op: 'pin.configure',
      validate: (context) => configure(context, catalog),
    },
    {
      op: 'pin.write_digital',
      validate: (context) => writeDigital(context, catalog),
    },
    {
      op: 'pin.sample_digital',
      validate: (context) => sampleDigital(context, catalog),
    },
  ];
}

function signalPin(
  context: IRInstructionValidationContext,
  catalog: PinCatalog,
): string | undefined {
  const operand = context.instruction.operands[0];
  if (operand?.kind !== 'static') {
    return undefined;
  }
  const descriptor = catalog.descriptor(operand.ref as PinRef);
  if (descriptor === undefined) {
    return 'pin instruction must reference a pin declared by this device';
  }
  if (descriptor.kind !== 'signal') {
    return `pin ${JSON.stringify(descriptor.key)} is a ${descriptor.kind} pin and does not support I/O`;
  }
  return undefined;
}

function literal(
  context: IRInstructionValidationContext,
  index: number,
): boolean | number | string | undefined {
  const operand = context.instruction.operands[index];
  return operand?.kind === 'literal' ? operand.value : undefined;
}

function configure(
  context: IRInstructionValidationContext,
  catalog: PinCatalog,
): readonly string[] {
  const invalidPin = signalPin(context, catalog);
  if (invalidPin !== undefined) {
    return [invalidPin];
  }
  const mode = literal(context, 1);
  const outputEnabled = literal(context, 2);
  const pull = literal(context, 3);
  const messages: string[] = [];
  if (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0 || mode > 3) {
    messages.push('pin.configure mode must be an integer in [0, 3]');
  }
  if (typeof outputEnabled !== 'boolean') {
    messages.push('pin.configure outputEnabled must be a boolean');
  }
  if (typeof pull !== 'number' || !Number.isInteger(pull) || pull < 0 || pull > 2) {
    messages.push('pin.configure pull must be an integer in [0, 2]');
  }
  return messages;
}

function writeDigital(
  context: IRInstructionValidationContext,
  catalog: PinCatalog,
): readonly string[] {
  const invalidPin = signalPin(context, catalog);
  if (invalidPin !== undefined) {
    return [invalidPin];
  }
  const level = context.instruction.operands[1];
  if (level?.kind !== 'ssa' || level.value.type !== 'bool') {
    return ['pin.write_digital level must be a bool SSA value'];
  }
  return [];
}

function sampleDigital(
  context: IRInstructionValidationContext,
  catalog: PinCatalog,
): readonly string[] {
  const invalidPin = signalPin(context, catalog);
  return invalidPin === undefined ? [] : [invalidPin];
}
