import type {
  IRInstructionValidator,
  IRModule,
  IRResourcePermission,
  IRValidationOptions,
} from '@mica-js/ir';

/**
 * Reference-interpreter policy for a device instance.
 *
 * Every instruction used by the factory is offered to validation; declared domain instructions
 * without a trusted validator still fail, so unsupported capabilities are rejected at link time.
 * Writable byte resources additionally receive the independent update grant required by
 * `resource.update_bytes` / `resource.fill_bytes`.
 */
export function createValidationPolicy(
  module: IRModule,
  validators: readonly IRInstructionValidator[] = [],
): IRValidationOptions {
  const instructions = new Set<string>();
  for (const fn of module.functions) {
    for (const block of fn.body?.blocks ?? []) {
      for (const node of block.instructions) {
        instructions.add(node.op);
      }
      if (block.terminator !== undefined) {
        instructions.add(block.terminator.kind);
      }
    }
  }
  const resources: IRResourcePermission[] = [];
  for (const memory of module.memories) {
    if (memory.writable) {
      resources.push({ ref: memory.ref, access: 'read-write' });
      if (memory.kind === 'bytes') {
        resources.push({ ref: memory.ref, access: 'update' });
      }
    } else {
      resources.push({ ref: memory.ref, access: 'read' });
    }
  }
  // Domain handles (for example physical pins) are resource-like static references and require
  // an explicit grant in the same policy that authorizes their instructions.
  for (const declaration of module.domainDeclarations) {
    resources.push({ ref: declaration.ref, access: 'read-write' });
  }
  const names = Object.freeze([...instructions]);
  return Object.freeze({
    supportedInstructions: names,
    authorizedInstructions: names,
    resources: Object.freeze(resources.map((permission) => Object.freeze(permission))),
    validators: Object.freeze([...validators]),
  });
}
