import { CORE_INSTRUCTION_NAMES } from './builder';
import {
  assertHexBits,
  isFloatType,
  isIntegerType,
  isNumericType,
  isScalarType,
  isSignedIntegerType,
  normalizeScalarLiteral,
} from './runtime';
import { refKind } from './types';
import type {
  InstructionNode,
  InstructionOperand,
  MemoryDefinition,
  MemoryKind,
  ScalarType,
  StaticRef,
} from './types';
import { isReservedOperation } from './validation-internal';
import type { InstructionValidationState } from './validation-internal';
import type { IRDiagnosticCode } from './validation-types';

const CORE_INSTRUCTIONS = new Set(CORE_INSTRUCTION_NAMES);
const TERMINATORS = new Set(['return', 'jump', 'branch', 'trap']);
const PREDICATES = new Set(['eq', 'ne', 'lt', 'le', 'gt', 'ge']);
const INTEGER_WIDTH: Readonly<Record<string, number>> = {
  u8: 8,
  i8: 8,
  u16: 16,
  i16: 16,
  u32: 32,
  i32: 32,
};

type OperandKind = InstructionOperand['kind'];
type Access = 'read' | 'write' | 'update';
type TypePredicate = (type: unknown) => boolean;

export function validateInstruction(
  node: InstructionNode,
  state: InstructionValidationState,
): void {
  if (!validatePolicy(node, state)) {
    return;
  }
  if (TERMINATORS.has(node.op)) {
    state.report('invalid-terminator', `${node.op} must be encoded as a block terminator`);
    return;
  }
  switch (node.op) {
    case 'const': {
      if (!operands(node, state, ['literal']) || !resultCount(node, state, 1)) {
        return;
      }
      try {
        normalizeScalarLiteral(node.results[0]!.type, literal(node, 0));
      } catch (error) {
        state.report('type-mismatch', errorMessage(error));
      }
      return;
    }
    case 'const.bits': {
      if (!operands(node, state, ['literal']) || !resultCount(node, state, 1)) {
        return;
      }
      const type = node.results[0]!.type;
      if (type !== 'f32' && type !== 'f64') {
        state.report('type-mismatch', 'const.bits result must be f32 or f64');
        return;
      }
      try {
        assertHexBits(type, literal(node, 0));
      } catch (error) {
        state.report('type-mismatch', errorMessage(error));
      }
      return;
    }
    case 'bool.not':
      sameType(node, state, 1, (type) => type === 'bool');
      return;
    case 'bool.and':
    case 'bool.or':
    case 'bool.xor':
      sameType(node, state, 2, (type) => type === 'bool');
      return;
    case 'int.add':
    case 'int.sub':
    case 'int.mul':
    case 'int.div':
    case 'int.rem':
    case 'int.and':
    case 'int.or':
    case 'int.xor':
      sameType(node, state, 2, isIntegerType);
      return;
    case 'int.not':
      sameType(node, state, 1, isIntegerType);
      return;
    case 'int.shl':
    case 'int.lshr':
    case 'int.ashr': {
      if (!operands(node, state, ['ssa', 'ssa'])) {
        return;
      }
      const type = valueType(node, 0);
      requireType(
        state,
        node.op === 'int.ashr' ? isSignedIntegerType(type) : isIntegerType(type),
        `${node.op} value must be ${node.op === 'int.ashr' ? 'a signed integer' : 'an integer'}`,
      );
      value(node, state, 1, 'u32');
      results(node, state, [type]);
      return;
    }
    case 'int.cmp':
    case 'float.cmp': {
      if (!operands(node, state, ['literal', 'ssa', 'ssa'])) {
        return;
      }
      const predicate = literal(node, 0);
      requireType(
        state,
        typeof predicate === 'string' && PREDICATES.has(predicate),
        `${node.op} predicate must be eq, ne, lt, le, gt, or ge`,
      );
      const type = valueType(node, 1);
      requireType(
        state,
        node.op === 'int.cmp' ? isIntegerType(type) : isFloatType(type),
        `${node.op} operands must be ${node.op === 'int.cmp' ? 'integers' : 'floats'}`,
      );
      value(node, state, 2, type);
      results(node, state, ['bool']);
      return;
    }
    case 'int.zext':
    case 'int.sext':
    case 'int.trunc':
    case 'int.reinterpret':
    case 'convert.intToFloat':
    case 'convert.floatToInt':
    case 'convert.float':
    case 'bitcast':
      conversion(node, state);
      return;
    case 'float.add':
    case 'float.sub':
    case 'float.mul':
    case 'float.div':
      sameType(node, state, 2, isFloatType);
      return;
    case 'float.fma':
      sameType(node, state, 3, isFloatType);
      return;
    case 'float.isNaN':
    case 'float.isFinite':
      sameType(node, state, 1, isFloatType, 'bool');
      return;
    case 'select': {
      if (!operands(node, state, ['ssa', 'ssa', 'ssa'])) {
        return;
      }
      value(node, state, 0, 'bool');
      const type = valueType(node, 1);
      value(node, state, 2, type);
      results(node, state, [type]);
      return;
    }
    case 'state.load':
    case 'state.store':
    case 'array.load':
    case 'array.store':
      scalarMemory(node, state);
      return;
    case 'bytes.load':
    case 'bytes.store':
      byteMemory(node, state);
      return;
    case 'resource.update_bytes':
    case 'bytes.copy': {
      if (!operands(node, state, ['static', 'ssa', 'static', 'ssa', 'ssa'])) {
        return;
      }
      memory(node, state, 0, ['bytes'], node.op === 'bytes.copy' ? 'write' : 'update');
      memory(node, state, 2, ['bytes', 'inbox'], 'read');
      value(node, state, 1, 'u32');
      value(node, state, 3, 'u32');
      value(node, state, 4, 'u32');
      results(node, state, []);
      return;
    }
    case 'resource.fill_bytes': {
      if (!operands(node, state, ['static', 'ssa', 'ssa', 'ssa'])) return;
      memory(node, state, 0, ['bytes'], 'update');
      value(node, state, 1, 'u32');
      value(node, state, 2, 'u32');
      value(node, state, 3, 'u8');
      results(node, state, []);
      return;
    }
    case 'bridge.send':
      bridgeSend(node, state);
      return;
    case 'bridge.send_bytes':
      bridgeSendBytes(node, state);
      return;
    case 'event.now':
      if (operands(node, state, [])) results(node, state, ['f64']);
      return;
    case 'event.cancel':
      if (operands(node, state, ['ssa'])) {
        value(node, state, 0, 'u32');
        results(node, state, []);
      }
      return;
    case 'event.at':
      eventAt(node, state);
      return;
    case 'call':
      call(node, state);
      return;
    default:
      domain(node, state);
  }
}

function validatePolicy(node: InstructionNode, state: InstructionValidationState): boolean {
  // Future privileged capabilities cannot be introduced through a domain declaration.
  if (isReservedOperation(node.op)) {
    state.report(
      'unsupported-instruction',
      `Instruction "${node.op}" is reserved for a future capability`,
    );
    return false;
  }
  if (!CORE_INSTRUCTIONS.has(node.op) && !state.declarations.has(node.op)) {
    state.report('unknown-instruction', `Instruction "${node.op}" is not declared`);
    return false;
  }
  let allowed = true;
  if (!state.options.supportedInstructions?.includes(node.op)) {
    state.report(
      'unsupported-instruction',
      `Instruction "${node.op}" is not supported by this backend`,
    );
    allowed = false;
  }
  if (!state.options.authorizedInstructions?.includes(node.op)) {
    state.report('unauthorized-instruction', `Instruction "${node.op}" is not authorized`);
    allowed = false;
  }
  return allowed;
}

function operands(
  node: InstructionNode,
  state: InstructionValidationState,
  kinds: readonly OperandKind[],
  code: IRDiagnosticCode = 'type-mismatch',
): boolean {
  if (node.operands.length !== kinds.length) {
    state.report(
      'signature-mismatch',
      `${node.op} requires ${kinds.length} operands, received ${node.operands.length}`,
    );
    return false;
  }
  let valid = true;
  kinds.forEach((kind, index) => {
    if (node.operands[index]!.kind !== kind) {
      state.report(code, `${node.op} operand ${index} must be ${kind}`);
      valid = false;
    }
  });
  return valid;
}

function resultCount(
  node: InstructionNode,
  state: InstructionValidationState,
  count: number,
): boolean {
  if (node.results.length === count) {
    return true;
  }
  state.report(
    'signature-mismatch',
    `${node.op} requires ${count} results, received ${node.results.length}`,
  );
  return false;
}

function results(
  node: InstructionNode,
  state: InstructionValidationState,
  types: readonly ScalarType[],
  code: IRDiagnosticCode = 'type-mismatch',
): boolean {
  if (!resultCount(node, state, types.length)) {
    return false;
  }
  let valid = true;
  types.forEach((type, index) => {
    if (node.results[index]!.type !== type) {
      state.report(code, `${node.op} result ${index} must have type ${type}`);
      valid = false;
    }
  });
  return valid;
}

function literal(node: InstructionNode, index: number): boolean | number | string {
  return (node.operands[index] as Extract<InstructionOperand, { kind: 'literal' }>).value;
}

function valueType(node: InstructionNode, index: number): ScalarType {
  return (node.operands[index] as Extract<InstructionOperand, { kind: 'ssa' }>).value.type;
}

function staticRef(node: InstructionNode, index: number): StaticRef {
  return (node.operands[index] as Extract<InstructionOperand, { kind: 'static' }>).ref;
}

function value(
  node: InstructionNode,
  state: InstructionValidationState,
  index: number,
  type: ScalarType,
  code: IRDiagnosticCode = 'type-mismatch',
): boolean {
  if (valueType(node, index) === type) {
    return true;
  }
  state.report(code, `${node.op} operand ${index} must have type ${type}`);
  return false;
}

function requireType(state: InstructionValidationState, valid: boolean, message: string): void {
  if (!valid) {
    state.report('type-mismatch', message);
  }
}

function sameType(
  node: InstructionNode,
  state: InstructionValidationState,
  count: number,
  accepts: TypePredicate,
  resultType?: ScalarType,
): void {
  if (!operands(node, state, Array<OperandKind>(count).fill('ssa'))) {
    return;
  }
  const type = valueType(node, 0);
  requireType(state, accepts(type), `${node.op} does not accept ${type} operands`);
  for (let index = 1; index < count; index += 1) {
    value(node, state, index, type);
  }
  results(node, state, [resultType ?? type]);
}

function conversion(node: InstructionNode, state: InstructionValidationState): void {
  if (!operands(node, state, ['literal', 'ssa'])) {
    return;
  }
  const target = literal(node, 0);
  if (!isScalarType(target)) {
    state.report('type-mismatch', `${node.op} target must be a scalar type`);
    return;
  }
  const source = valueType(node, 1);
  let valid = false;
  switch (node.op) {
    case 'int.zext':
    case 'int.sext':
    case 'int.trunc':
    case 'int.reinterpret': {
      if (isIntegerType(source) && isIntegerType(target)) {
        const sourceWidth = INTEGER_WIDTH[source]!;
        const targetWidth = INTEGER_WIDTH[target]!;
        switch (node.op) {
          case 'int.zext':
            valid = targetWidth > sourceWidth;
            break;
          case 'int.sext':
            valid = isSignedIntegerType(source) && targetWidth > sourceWidth;
            break;
          case 'int.trunc':
            valid = targetWidth < sourceWidth;
            break;
          case 'int.reinterpret':
            valid =
              targetWidth === sourceWidth &&
              isSignedIntegerType(source) !== isSignedIntegerType(target);
            break;
        }
      }
      break;
    }
    case 'convert.intToFloat':
      valid = isIntegerType(source) && isFloatType(target);
      break;
    case 'convert.floatToInt':
      valid = isFloatType(source) && isIntegerType(target);
      break;
    case 'convert.float':
      valid = isFloatType(source) && isFloatType(target);
      break;
    case 'bitcast':
      valid =
        (source === 'f32' && (target === 'u32' || target === 'i32')) ||
        ((source === 'u32' || source === 'i32') && target === 'f32');
      break;
  }
  requireType(state, valid, `${node.op} does not allow conversion from ${source} to ${target}`);
  results(node, state, [target]);
}

function hasGrant(state: InstructionValidationState, ref: StaticRef, access?: Access): boolean {
  return state.options.resources.some(
    (permission) =>
      permission.ref === ref &&
      (access === undefined ||
        permission.access === access ||
        (access !== 'update' && permission.access === 'read-write')),
  );
}

function memory(
  node: InstructionNode,
  state: InstructionValidationState,
  index: number,
  kinds: readonly MemoryKind[],
  access: Access,
): MemoryDefinition | undefined {
  const ref = staticRef(node, index);
  const definition = state.memories.get(ref);
  if (
    definition === undefined ||
    !kinds.includes(definition.kind) ||
    ref[refKind] !== definition.kind
  ) {
    state.report(
      'invalid-static-reference',
      `${node.op} operand ${index} must reference a listed ${kinds.join(' or ')} memory`,
    );
    return undefined;
  }
  if (access === 'write' && !definition.writable) {
    state.report('invalid-resource', `${node.op} operand ${index} must reference writable memory`);
  }
  if (!hasGrant(state, ref, access)) {
    state.report('unauthorized-resource', `${node.op} operand ${index} requires ${access} access`);
  }
  return definition;
}

function scalarMemory(node: InstructionNode, state: InstructionValidationState): void {
  const store = node.op.endsWith('.store');
  const array = node.op.startsWith('array.');
  const kinds: OperandKind[] = ['static'];
  if (array) kinds.push('ssa');
  if (store) kinds.push('ssa');
  if (!operands(node, state, kinds)) {
    return;
  }
  const definition = memory(node, state, 0, [array ? 'array' : 'state'], store ? 'write' : 'read');
  if (array) value(node, state, 1, 'u32');
  if (definition === undefined) {
    resultCount(node, state, store ? 0 : 1);
    return;
  }
  if (definition.layout.kind !== 'scalar') {
    state.report('invalid-resource', `${node.op} requires scalar memory layout`);
    return;
  }
  const type = definition.layout.scalarType;
  if (store) value(node, state, array ? 2 : 1, type);
  results(node, state, store ? [] : [type]);
}

function byteMemory(node: InstructionNode, state: InstructionValidationState): void {
  const store = node.op === 'bytes.store';
  if (
    !operands(
      node,
      state,
      store
        ? ['literal', 'literal', 'static', 'ssa', 'ssa']
        : ['literal', 'literal', 'static', 'ssa'],
    )
  ) {
    return;
  }
  const type = literal(node, 0);
  const endian = literal(node, 1);
  requireType(state, isNumericType(type), `${node.op} type must be numeric`);
  requireType(
    state,
    endian === 'little' || endian === 'big',
    `${node.op} endian must be little or big`,
  );
  const definition = memory(
    node,
    state,
    2,
    store ? ['bytes'] : ['bytes', 'inbox'],
    store ? 'write' : 'read',
  );
  if (definition !== undefined && definition.layout.kind !== 'bytes') {
    state.report('invalid-resource', `${node.op} requires byte memory layout`);
  }
  value(node, state, 3, 'u32');
  if (isScalarType(type)) {
    if (store) value(node, state, 4, type);
    results(node, state, store ? [] : [type]);
  } else {
    resultCount(node, state, store ? 0 : 1);
  }
}

function bridgeSend(node: InstructionNode, state: InstructionValidationState): void {
  const operand = node.operands[0];
  if (operand?.kind !== 'static') {
    state.report('invalid-static-reference', 'bridge.send requires a static scalar output target');
    return;
  }
  const output = state.outputs.get(operand.ref);
  if (
    output === undefined ||
    output.kind !== 'scalar-output' ||
    operand.ref[refKind] !== 'scalar-output'
  ) {
    state.report(
      'invalid-static-reference',
      'bridge.send target must be a scalar output declared by this module',
    );
    return;
  }
  const kinds: OperandKind[] = ['static', ...output.params.map(() => 'ssa' as const)];
  if (!operands(node, state, kinds)) {
    return;
  }
  output.params.forEach((type, index) => value(node, state, index + 1, type));
  results(node, state, ['bool']);
}

function bridgeSendBytes(node: InstructionNode, state: InstructionValidationState): void {
  if (!operands(node, state, ['static', 'static', 'ssa', 'ssa'])) {
    return;
  }
  const operand = node.operands[0];
  if (operand?.kind !== 'static') {
    state.report(
      'invalid-static-reference',
      'bridge.send_bytes target must be a bytes output declared by this module',
    );
    return;
  }
  const output = state.outputs.get(operand.ref);
  if (
    output === undefined ||
    output.kind !== 'bytes-output' ||
    operand.ref[refKind] !== 'bytes-output'
  ) {
    state.report(
      'invalid-static-reference',
      'bridge.send_bytes target must be a bytes output declared by this module',
    );
    return;
  }
  memory(node, state, 1, ['bytes', 'inbox'], 'read');
  value(node, state, 2, 'u32');
  value(node, state, 3, 'u32');
  results(node, state, ['bool']);
}

function eventAt(node: InstructionNode, state: InstructionValidationState): void {
  const operand = node.operands[0];
  if (operand?.kind !== 'static') {
    state.report('invalid-call-target', 'event.at requires a static ordinary entry target');
    return;
  }
  const target = state.functions.get(operand.ref);
  if (target === undefined) {
    state.report('invalid-static-reference', 'event.at target must be listed in this module');
    return;
  }
  if (target.category !== 'entry' || operand.ref[refKind] !== 'entry') {
    state.report('invalid-call-target', 'event.at target must be an ordinary entry');
  }
  if (!operands(node, state, ['static', 'ssa', ...target.params.map(() => 'ssa' as const)])) {
    return;
  }
  value(node, state, 1, 'f64');
  target.params.forEach((type, index) => value(node, state, index + 2, type));
  results(node, state, ['u32']);
}

function call(node: InstructionNode, state: InstructionValidationState): void {
  let valid = true;
  node.operands.forEach((operand, index) => {
    if (index > 0 && operand.kind !== 'ssa') {
      state.report('signature-mismatch', `call operand ${index} must be ssa`);
      valid = false;
    }
  });
  const operand = node.operands[0];
  if (operand?.kind !== 'static') {
    state.report('invalid-call-target', 'call requires a static ordinary function target');
    return;
  }
  const target = state.functions.get(operand.ref);
  if (target === undefined) {
    state.report(
      'invalid-static-reference',
      'call target must be a function listed in this module',
    );
    return;
  }
  if (target.category !== 'function' || operand.ref[refKind] !== 'function') {
    state.report(
      'invalid-call-target',
      'call target must be an ordinary function listed in this module',
    );
    valid = false;
  }
  if (node.operands.length !== target.params.length + 1) {
    state.report('signature-mismatch', `call requires ${target.params.length} arguments`);
    valid = false;
  }
  if (!results(node, state, target.results, 'signature-mismatch')) valid = false;
  target.params.forEach((type, index) => {
    if (
      node.operands[index + 1]?.kind === 'ssa' &&
      !value(node, state, index + 1, type, 'signature-mismatch')
    )
      valid = false;
  });
  if (valid) state.call(target, node);
}

function domain(node: InstructionNode, state: InstructionValidationState): void {
  const declaration = state.declarations.get(node.op);
  if (declaration === undefined) {
    state.report('unknown-instruction', `Instruction "${node.op}" is not declared`);
    return;
  }
  const validator = state.validators.get(node.op);
  if (validator === undefined) {
    state.report(
      'unsupported-instruction',
      `Instruction "${node.op}" requires a trusted validator`,
    );
    return;
  }
  const kinds = declaration.operands.map((operand): OperandKind => {
    switch (operand.kind) {
      case 'value':
        return 'ssa';
      case 'value-list':
        return 'ssa-list';
      case 'static':
      case 'static-list':
      case 'literal':
        return operand.kind;
    }
  });
  if (!operands(node, state, kinds, 'signature-mismatch')) {
    return;
  }
  let valid = results(node, state, declaration.results, 'signature-mismatch');
  declaration.operands.forEach((descriptor, index) => {
    if (descriptor.kind === 'value') {
      if (!value(node, state, index, descriptor.type, 'signature-mismatch')) valid = false;
    } else if (descriptor.kind === 'static') {
      if (!domainStatic(node, state, index, descriptor.category)) valid = false;
    } else if (descriptor.kind === 'value-list') {
      const list = node.operands[index] as Extract<InstructionOperand, { kind: 'ssa-list' }>;
      if (!listLength(node, state, index, list.values.length, descriptor.minLength)) valid = false;
      list.values.forEach((item, itemIndex) => {
        if (item.type !== descriptor.type) {
          state.report(
            'signature-mismatch',
            `${node.op} operand ${index}[${itemIndex}] must have type ${descriptor.type}`,
          );
          valid = false;
        }
      });
    } else if (descriptor.kind === 'static-list') {
      const list = node.operands[index] as Extract<InstructionOperand, { kind: 'static-list' }>;
      if (!listLength(node, state, index, list.refs.length, descriptor.minLength)) valid = false;
      list.refs.forEach((ref, itemIndex) => {
        if (
          !checkDomainStatic(
            ref,
            state,
            descriptor.category,
            `${node.op} operand ${index}[${itemIndex}]`,
          )
        ) {
          valid = false;
        }
      });
    }
  });
  if (!valid) {
    return;
  }
  try {
    const callback = validator.validate;
    const kind = Object.prototype.toString.call(callback);
    if (
      typeof callback !== 'function' ||
      kind === '[object AsyncFunction]' ||
      kind === '[object GeneratorFunction]' ||
      kind === '[object AsyncGeneratorFunction]'
    ) {
      state.report(
        'extension-error',
        `Validator for "${node.op}" must be synchronous and non-generator`,
      );
      return;
    }
    const context = Object.freeze({
      module: state.module,
      fn: state.fn,
      block: state.block,
      instruction: node,
      location: state.location,
      resources: Object.freeze(
        state.options.resources.map((permission) => Object.freeze({ ...permission })),
      ),
    });
    const messages: unknown = callback.call(validator, context);
    if (consumeThenable(messages)) {
      state.report('extension-error', `Validator for "${node.op}" returned a promise`);
      return;
    }
    const diagnostics: unknown[] | undefined = Array.isArray(messages)
      ? Array.from(messages)
      : undefined;
    if (diagnostics === undefined || !diagnostics.every((message) => typeof message === 'string')) {
      state.report(
        'extension-error',
        `Validator for "${node.op}" must return an array of diagnostic strings`,
      );
      return;
    }
    for (const message of diagnostics) state.report('domain-validation', message as string);
  } catch (error) {
    consumeThenable(error);
    state.report('extension-error', `Validator for "${node.op}" failed: ${errorMessage(error)}`);
  }
}

function domainStatic(
  node: InstructionNode,
  state: InstructionValidationState,
  index: number,
  category: string,
): boolean {
  return checkDomainStatic(staticRef(node, index), state, category, `${node.op} operand ${index}`);
}

function checkDomainStatic(
  ref: StaticRef,
  state: InstructionValidationState,
  category: string,
  label: string,
): boolean {
  const kind = ref[refKind];
  const memoryDefinition = state.memories.get(ref);
  const functionDefinition = state.functions.get(ref);
  const domainDefinition = state.domains.get(ref);
  let listed: boolean;
  let resource = false;
  switch (kind) {
    case 'state':
    case 'array':
    case 'bytes':
    case 'inbox':
      listed = memoryDefinition?.kind === kind;
      resource = true;
      break;
    case 'function':
    case 'entry':
    case 'lifecycle':
      listed = functionDefinition?.category === kind;
      break;
    default:
      listed = domainDefinition !== undefined && domainDefinition.kind === kind;
      resource = true;
  }
  if (!listed) {
    state.report('invalid-static-reference', `${label} must reference a listed ${category}`);
    return false;
  }
  if (kind !== category) {
    state.report('signature-mismatch', `${label} must have category ${category}`);
    return false;
  }
  if (resource && !hasGrant(state, ref)) {
    state.report('unauthorized-resource', `${label} requires a resource grant`);
    return false;
  }
  return true;
}

function listLength(
  node: InstructionNode,
  state: InstructionValidationState,
  index: number,
  length: number,
  minimum: number | undefined,
): boolean {
  if (minimum === undefined || length >= minimum) return true;
  state.report(
    'signature-mismatch',
    `${node.op} operand ${index} requires at least ${minimum} item(s)`,
  );
  return false;
}

function consumeThenable(value: unknown): boolean {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return false;
  }
  try {
    if (typeof (value as { readonly then?: unknown }).then !== 'function') return false;
    void Promise.resolve(value).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'Unknown validation error';
  }
}
