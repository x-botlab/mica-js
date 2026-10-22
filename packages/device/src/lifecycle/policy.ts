import type {
  IRInstructionValidationContext,
  IRInstructionValidator,
  IRModule,
  IRResourcePermission,
  IRValidationOptions,
  StaticRef,
} from '@mica-js/ir';
import type { DeviceConnectionDescriptor } from '../connection/types';

/**
 * Reference-interpreter policy for a device instance.
 *
 * Every instruction used by the factory is offered to validation; declared domain instructions
 * without a trusted validator still fail at link time. Writable byte resources additionally
 * receive the independent update grant required by `resource.update_bytes` /
 * `resource.fill_bytes`. Connection declarations receive a write grant only when the device
 * description declares the same id.
 */
export function createValidationPolicy(
  module: IRModule,
  connections: ReadonlyMap<string, DeviceConnectionDescriptor> = new Map(),
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
  for (const declaration of module.domainDeclarations) {
    if (declaration.kind !== 'connection' || !connections.has(declaration.name)) continue;
    resources.push({ ref: declaration.ref, access: 'write' });
  }
  const names = Object.freeze([...instructions]);
  const validators: IRInstructionValidator[] = [];
  if (instructions.has('connection.apply')) {
    validators.push(connectionValidator(module, connections));
  }
  return Object.freeze({
    supportedInstructions: names,
    authorizedInstructions: names,
    resources: Object.freeze(resources.map((permission) => Object.freeze(permission))),
    ...(validators.length === 0 ? {} : { validators: Object.freeze(validators) }),
  });
}

function connectionValidator(
  module: IRModule,
  connections: ReadonlyMap<string, DeviceConnectionDescriptor>,
): IRInstructionValidator {
  const names = new Map<StaticRef, string>();
  for (const declaration of module.domainDeclarations) {
    if (declaration.kind === 'connection') {
      names.set(declaration.ref, declaration.name);
    }
  }
  return Object.freeze({
    op: 'connection.apply',
    validate(context: IRInstructionValidationContext) {
      const refs = context.instruction.operands[0];
      const values = context.instruction.operands[1];
      if (refs?.kind !== 'static-list' || values?.kind !== 'ssa-list') {
        return ['connection.apply requires a connection list and a matching bool list'];
      }
      if (refs.refs.length !== values.values.length) {
        return ['connection.apply connection and value lists must have the same length'];
      }
      if (refs.refs.length === 0) {
        return ['connection.apply requires at least one connection'];
      }
      const seen = new Set<StaticRef>();
      const diagnostics: string[] = [];
      refs.refs.forEach((ref: StaticRef, index: number) => {
        if (seen.has(ref)) {
          diagnostics.push(`connection.apply connection ${index} is repeated in one patch`);
          return;
        }
        seen.add(ref);
        const name = names.get(ref);
        if (name === undefined || !connections.has(name)) {
          diagnostics.push(
            `connection.apply connection ${index} is not declared by this device instance`,
          );
        }
      });
      return diagnostics;
    },
  });
}
