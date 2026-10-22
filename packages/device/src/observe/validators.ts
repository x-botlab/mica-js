import type { IRInstructionValidationContext, IRInstructionValidator } from '@mica-js/ir';
import type { ObserverRef } from '../types';
import type { ObserveCatalog } from './catalog';

export function createObserveValidators(
  catalog: ObserveCatalog,
): readonly IRInstructionValidator[] {
  return [
    {
      op: 'observe.configure',
      validate: (context) => configure(context, catalog),
    },
  ];
}

function configure(
  context: IRInstructionValidationContext,
  catalog: ObserveCatalog,
): readonly string[] {
  const binding = context.instruction.operands[0];
  if (binding?.kind !== 'static') {
    return ['observe.configure requires a static observation binding'];
  }
  if (catalog.descriptor(binding.ref as ObserverRef) === undefined) {
    return ['observe.configure observation binding is not declared by this device'];
  }
  const messages: string[] = [];
  const enabled = context.instruction.operands[1];
  if (enabled?.kind !== 'literal' || typeof enabled.value !== 'boolean') {
    messages.push('observe.configure enabled must be a boolean literal');
  }
  const edges = context.instruction.operands[2];
  if (
    edges?.kind !== 'literal' ||
    typeof edges.value !== 'number' ||
    !Number.isInteger(edges.value) ||
    edges.value < 1 ||
    edges.value > 3
  ) {
    messages.push('observe.configure edges must be an integer literal 1, 2, or 3');
  }
  return messages;
}
