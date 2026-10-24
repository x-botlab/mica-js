import type { BytesRef, IRModule, IRResourcePermission, IRValidationOptions } from '@mica-js/ir';

/**
 * Builds the validation grants a module needs to run on the reference engine or
 * the JIT: every instruction the model uses, authorized once, plus a grant for
 * each declared memory.
 *
 * `@mica-js/ir` deliberately keeps its core instruction list internal, so the
 * names are collected from the generated bodies instead of being restated here.
 *
 * @param module - Generated module whose bodies and memories are granted.
 * @param updateResources - Read-only byte regions that opt into the host-only
 *   versioned update path (for example MCU firmware patching).
 */
export function createModuleValidation(
  module: IRModule,
  updateResources: readonly BytesRef[] = [],
): IRValidationOptions {
  const names = new Set<string>();
  for (const fn of module.functions) {
    const body = fn.body;
    if (body === undefined) continue;
    // `body.blocks` already contains the entry block.
    for (const block of body.blocks) {
      for (const instruction of block.instructions) names.add(instruction.op);
      if (block.terminator !== undefined) names.add(block.terminator.kind);
    }
  }
  const instructions = Object.freeze([...names]);
  const resources: IRResourcePermission[] = module.memories.map((memory) =>
    Object.freeze({
      ref: memory.ref,
      access: memory.writable ? ('read-write' as const) : ('read' as const),
    }),
  );
  // Read-only byte regions such as firmware stay unreadable to guest stores but
  // can opt into the host-only versioned update path (`patchFirmware`).
  const memories = new Set(module.memories.map((memory) => memory.ref));
  for (const ref of new Set(updateResources)) {
    if (!memories.has(ref)) continue;
    resources.push(Object.freeze({ ref, access: 'update' as const }));
  }
  return Object.freeze({
    supportedInstructions: instructions,
    authorizedInstructions: instructions,
    resources: Object.freeze(resources),
  });
}
