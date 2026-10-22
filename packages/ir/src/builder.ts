import { fail } from './errors';
import type {
  ArrayRef,
  BlockRef,
  DomainInstruction,
  EntryRef,
  FunctionBuilder,
  FunctionRef,
  InstructionOperand,
  ScalarType,
  StateRef,
  StaticRef,
  Value,
} from './types';
import { refKind, scalarType, INTEGER_TYPES } from './types';
import type { BlockState, BuilderState, FunctionDeclarationState, MemoryState } from './state';
import { BlockState as Block } from './state';
import {
  assertEdgeLayout,
  assertHexBits,
  assertName,
  assertScalarType,
  assertScalarTypeList,
  assertStaticRef,
  assertSynchronousCallback,
  assertValue,
  assertValueList,
  createBlockRef,
  createValue,
  getFunctionMetadata,
  getInstructionMetadata,
  getMemoryMetadata,
  getValueMetadata,
  isFloatType,
  isIntegerType,
  invokeSynchronousCallback,
  isNumericType,
  isSignedIntegerType,
  normalizeScalarLiteral,
  requireBlock,
} from './runtime';

const INTEGER_WIDTH = {
  u8: 8,
  u16: 16,
  u32: 32,
  i8: 8,
  i16: 16,
  i32: 32,
} as const;

const CORE_OPERATIONS = [
  'const',
  'const.bits',
  'bool.not',
  'bool.and',
  'bool.or',
  'bool.xor',
  'int.add',
  'int.sub',
  'int.mul',
  'int.div',
  'int.rem',
  'int.and',
  'int.or',
  'int.xor',
  'int.not',
  'int.shl',
  'int.lshr',
  'int.ashr',
  'int.cmp',
  'int.zext',
  'int.sext',
  'int.trunc',
  'int.reinterpret',
  'float.add',
  'float.sub',
  'float.mul',
  'float.div',
  'float.fma',
  'float.cmp',
  'float.isNaN',
  'float.isFinite',
  'convert.intToFloat',
  'convert.floatToInt',
  'convert.float',
  'bitcast',
  'select',
  'state.load',
  'state.store',
  'array.load',
  'array.store',
  'bytes.load',
  'bytes.store',
  'bytes.copy',
  'resource.update_bytes',
  'resource.fill_bytes',
  'call',
  'event.now',
  'event.at',
  'event.cancel',
  'return',
  'jump',
  'branch',
  'trap',
] as const;

export const CORE_INSTRUCTION_NAMES: readonly string[] = CORE_OPERATIONS;

const PREDICATES = new Set(['eq', 'ne', 'lt', 'le', 'gt', 'ge']);
const ENDIANS = new Set(['little', 'big']);

export function defineFunctionBody(declaration: FunctionDeclarationState, callback: unknown): void {
  if (declaration.body !== undefined) {
    fail(`Function "${declaration.name}" already has a body`);
  }
  if (declaration.defining) {
    fail(`Function "${declaration.name}" is already being defined`);
  }
  const bodyLabel = `Body callback for "${declaration.name}"`;
  assertSynchronousCallback(callback, bodyLabel);
  if (declaration.module.bodyDepth > 0) {
    fail(`Cannot define function "${declaration.name}" inside another function body`);
  }

  declaration.defining = true;
  declaration.module.bodyDepth += 1;
  let state: BuilderState | undefined;
  try {
    const currentState = createBuilderState(declaration);
    state = currentState;
    const builder = createBuilderObject(currentState) as FunctionBuilder;
    const params = declaration.params.map((type, index) => createValue(currentState, type, index));
    currentState.entry.params.push(...params);
    currentState.valueSeq = params.length;

    invokeSynchronousCallback(callback, [builder, params], bodyLabel);
    if (currentState.invalidated) {
      fail(`Function "${declaration.name}" cannot be committed after a failed block definition`);
    }
    finishBody(currentState);
    declaration.body = {
      entry: currentState.entry,
      blocks: currentState.blocks,
    };
  } catch (error) {
    if (state !== undefined) {
      state.invalidated = true;
    }
    throw error;
  } finally {
    declaration.defining = false;
    declaration.module.bodyDepth -= 1;
  }
}

function createBuilderState(declaration: FunctionDeclarationState): BuilderState {
  const state = {
    module: declaration.module,
    declaration,
    entry: undefined as unknown as BlockState,
    blocks: [] as BlockState[],
    insertion: [] as BlockState[],
    valueSeq: 0,
    blockSeq: 1,
    finished: false,
    invalidated: false,
  };
  const entry = new Block(state, 0, []);
  entry.defined = true;
  state.entry = entry;
  state.blocks.push(entry);
  state.insertion.push(entry);
  return state;
}

function finishBody(state: BuilderState): void {
  if (state.invalidated) {
    fail(
      `Function "${state.declaration.name}" cannot be committed after a failed block definition`,
    );
  }
  if (state.entry.terminator === undefined) {
    fail(`Entry block of "${state.declaration.name}" must end with a terminator`);
  }
  for (const block of state.blocks) {
    if (!block.defined) {
      fail(`Block ${block.id} of "${state.declaration.name}" was created but never defined`);
    }
    if (block.terminator === undefined) {
      fail(`Block ${block.id} of "${state.declaration.name}" has no terminator`);
    }
  }
  state.finished = true;
}

function createBuilderObject(state: BuilderState): unknown {
  const module = state.module;

  const current = (operation: string): BlockState => {
    if (state.invalidated) {
      fail(`Function "${state.declaration.name}" cannot continue after a failed block definition`);
    }
    if (state.finished) {
      fail(`Cannot add ${operation} after the function body has finished`);
    }
    const block = state.insertion[state.insertion.length - 1];
    if (block === undefined) {
      fail(`Cannot add ${operation} outside a function block`);
    }
    if (block.terminator !== undefined) {
      fail(`Cannot add ${operation} after a terminator in block ${block.id}`);
    }
    return block;
  };

  const createResults = (types: readonly ScalarType[]): Value[] => {
    const checked = assertScalarTypeList(types, 'result types');
    return checked.map((type) => createValue(state, type, state.valueSeq++));
  };

  const emit = (
    operation: string,
    operands: readonly InstructionOperand[],
    resultTypes: readonly ScalarType[],
  ): Value[] => {
    const block = current(operation);
    const results = createResults(resultTypes);
    block.instructions.push({ op: operation, operands, results });
    return results;
  };

  const emitOne = <T extends ScalarType>(
    operation: string,
    operands: readonly InstructionOperand[],
    type: T,
  ): Value<T> => {
    const results = emit(operation, operands, [type]);
    return results[0] as Value<T>;
  };

  const valueType = (value: Value, label: string): ScalarType => {
    if (typeof value !== 'object' || value === null) {
      fail(`${label} must be an SSA value`);
    }
    const metadata = getValueMetadata(value);
    if (metadata === undefined) {
      fail(`${label} is not an SSA value created by this builder`);
    }
    if (metadata.owner !== state) {
      fail(`${label} belongs to another function`);
    }
    return metadata.type;
  };

  const requireStatic = (ref: StaticRef, kind: string, label: string): void => {
    assertStaticRef(ref, module, kind, label);
  };

  const requireMemory = (
    ref: StaticRef,
    kind: 'state' | 'array' | 'bytes' | 'inbox',
    label: string,
  ): MemoryState => {
    requireStatic(ref, kind, label);
    const memory = getMemoryMetadata(ref);
    if (memory === undefined || memory.module !== module) {
      fail(`${label} is not a declared memory resource`);
    }
    return memory;
  };

  const requireByteMemory = (ref: StaticRef, label: string): MemoryState => {
    const kind = ref[refKind];
    if (kind !== 'bytes' && kind !== 'inbox') {
      fail(`${label} must be a byte resource`);
    }
    const memory = getMemoryMetadata(ref);
    if (memory === undefined || memory.module !== module) {
      fail(`${label} is not a declared byte resource`);
    }
    return memory;
  };

  const requireEntry = (ref: StaticRef, label: string): FunctionDeclarationState => {
    const declaration = getFunctionMetadata(ref);
    if (declaration === undefined || declaration.module !== module) {
      fail(`${label} is not a function declared by this module`);
    }
    return declaration;
  };

  const requireCallable = (ref: StaticRef, label: string): FunctionDeclarationState => {
    const declaration = requireEntry(ref, label);
    if (declaration.category !== 'function') {
      fail(`${label} must be an ordinary function, not a ${declaration.category}`);
    }
    return declaration;
  };

  const requireInteger = (value: Value, label: string): (typeof INTEGER_TYPES)[number] => {
    const type = valueType(value, label);
    if (!isIntegerType(type)) {
      fail(`${label} must be an integer, received ${type}`);
    }
    return type as (typeof INTEGER_TYPES)[number];
  };

  const requireFloat = (value: Value, label: string): 'f32' | 'f64' => {
    const type = valueType(value, label);
    if (!isFloatType(type)) {
      fail(`${label} must be a float, received ${type}`);
    }
    return type as 'f32' | 'f64';
  };

  const requireBool = (value: Value, label: string): void => {
    valueType(value, label);
    assertValue(value, state, 'bool', label);
  };

  const requireU32 = (value: Value, label: string): void => {
    valueType(value, label);
    assertValue(value, state, 'u32', label);
  };

  const binaryInteger = (operation: string, left: Value, right: Value): Value<ScalarType> => {
    const type = requireInteger(left, `${operation} left`);
    valueType(right, `${operation} right`);
    assertValue(right, state, type, `${operation} right`);
    return emitOne(operation, [ssa(left), ssa(right)], type);
  };

  const binaryFloat = (operation: string, left: Value, right: Value): Value<ScalarType> => {
    const type = requireFloat(left, `${operation} left`);
    valueType(right, `${operation} right`);
    assertValue(right, state, type, `${operation} right`);
    return emitOne(operation, [ssa(left), ssa(right)], type);
  };

  const compareInteger = (
    operation: 'int.cmp',
    predicate: string,
    left: Value,
    right: Value,
  ): Value<'bool'> => {
    if (!PREDICATES.has(predicate)) {
      fail(`${operation} predicate must be one of ${[...PREDICATES].join(', ')}`);
    }
    const type = requireInteger(left, `${operation} left`);
    valueType(right, `${operation} right`);
    assertValue(right, state, type, `${operation} right`);
    return emitOne(operation, [literal(predicate), ssa(left), ssa(right)], 'bool');
  };

  const compareFloat = (
    operation: 'float.cmp',
    predicate: string,
    left: Value,
    right: Value,
  ): Value<'bool'> => {
    if (!PREDICATES.has(predicate)) {
      fail(`${operation} predicate must be one of ${[...PREDICATES].join(', ')}`);
    }
    const type = requireFloat(left, `${operation} left`);
    valueType(right, `${operation} right`);
    assertValue(right, state, type, `${operation} right`);
    return emitOne(operation, [literal(predicate), ssa(left), ssa(right)], 'bool');
  };

  const convertInteger = (operation: string, target: string, value: Value): Value<ScalarType> => {
    assertScalarType(target, `${operation} target`);
    const source = requireInteger(value, `${operation} value`);
    const sourceWidth = INTEGER_WIDTH[source];
    const targetWidth = INTEGER_WIDTH[target as (typeof INTEGER_TYPES)[number]];
    if (targetWidth === undefined) {
      fail(`${operation} target must be an integer type`);
    }
    switch (operation) {
      case 'int.zext':
        if (targetWidth <= sourceWidth) {
          fail(`${operation} must widen from ${source} to ${target}`);
        }
        break;
      case 'int.sext':
        if (!isSignedIntegerType(source)) {
          fail(`${operation} requires a signed source, received ${source}`);
        }
        if (targetWidth <= sourceWidth) {
          fail(`${operation} must widen from ${source} to ${target}`);
        }
        break;
      case 'int.trunc':
        if (targetWidth >= sourceWidth) {
          fail(`${operation} must narrow from ${source} to ${target}`);
        }
        break;
      case 'int.reinterpret': {
        if (targetWidth !== sourceWidth) {
          fail(`${operation} requires equal widths, received ${source} and ${target}`);
        }
        const sourceSigned = isSignedIntegerType(source);
        const targetSigned = isSignedIntegerType(target);
        if (sourceSigned === targetSigned) {
          fail(`${operation} must change signedness`);
        }
        break;
      }
    }
    return emitOne(operation, [literal(target), ssa(value)], target);
  };

  const ssa = (value: Value): InstructionOperand => ({ kind: 'ssa', value });
  const staticOperand = (ref: StaticRef): InstructionOperand => ({ kind: 'static', ref });
  const literal = (value: boolean | number | string): InstructionOperand => ({
    kind: 'literal',
    value,
  });

  const boolOperations = {
    not(value: Value<'bool'>): Value<'bool'> {
      requireBool(value, 'bool.not value');
      return emitOne('bool.not', [ssa(value)], 'bool');
    },
    and(left: Value<'bool'>, right: Value<'bool'>): Value<'bool'> {
      requireBool(left, 'bool.and left');
      requireBool(right, 'bool.and right');
      return emitOne('bool.and', [ssa(left), ssa(right)], 'bool');
    },
    or(left: Value<'bool'>, right: Value<'bool'>): Value<'bool'> {
      requireBool(left, 'bool.or left');
      requireBool(right, 'bool.or right');
      return emitOne('bool.or', [ssa(left), ssa(right)], 'bool');
    },
    xor(left: Value<'bool'>, right: Value<'bool'>): Value<'bool'> {
      requireBool(left, 'bool.xor left');
      requireBool(right, 'bool.xor right');
      return emitOne('bool.xor', [ssa(left), ssa(right)], 'bool');
    },
  };

  const intOperations = {
    add(left: Value, right: Value) {
      return binaryInteger('int.add', left, right);
    },
    sub(left: Value, right: Value) {
      return binaryInteger('int.sub', left, right);
    },
    mul(left: Value, right: Value) {
      return binaryInteger('int.mul', left, right);
    },
    div(left: Value, right: Value) {
      return binaryInteger('int.div', left, right);
    },
    rem(left: Value, right: Value) {
      return binaryInteger('int.rem', left, right);
    },
    and(left: Value, right: Value) {
      return binaryInteger('int.and', left, right);
    },
    or(left: Value, right: Value) {
      return binaryInteger('int.or', left, right);
    },
    xor(left: Value, right: Value) {
      return binaryInteger('int.xor', left, right);
    },
    not(value: Value) {
      const type = requireInteger(value, 'int.not value');
      return emitOne('int.not', [ssa(value)], type);
    },
    shl(value: Value, count: Value) {
      const type = requireInteger(value, 'int.shl value');
      requireU32(count, 'int.shl count');
      return emitOne('int.shl', [ssa(value), ssa(count)], type);
    },
    lshr(value: Value, count: Value) {
      const type = requireInteger(value, 'int.lshr value');
      requireU32(count, 'int.lshr count');
      return emitOne('int.lshr', [ssa(value), ssa(count)], type);
    },
    ashr(value: Value, count: Value) {
      const type = requireInteger(value, 'int.ashr value');
      if (!isSignedIntegerType(type)) {
        fail('int.ashr requires a signed integer value');
      }
      requireU32(count, 'int.ashr count');
      return emitOne('int.ashr', [ssa(value), ssa(count)], type);
    },
    cmp(predicate: string, left: Value, right: Value) {
      return compareInteger('int.cmp', predicate, left, right);
    },
    zext(target: string, value: Value) {
      return convertInteger('int.zext', target, value);
    },
    sext(target: string, value: Value) {
      return convertInteger('int.sext', target, value);
    },
    trunc(target: string, value: Value) {
      return convertInteger('int.trunc', target, value);
    },
    reinterpret(target: string, value: Value) {
      return convertInteger('int.reinterpret', target, value);
    },
  };

  const floatOperations = {
    add(left: Value, right: Value) {
      return binaryFloat('float.add', left, right);
    },
    sub(left: Value, right: Value) {
      return binaryFloat('float.sub', left, right);
    },
    mul(left: Value, right: Value) {
      return binaryFloat('float.mul', left, right);
    },
    div(left: Value, right: Value) {
      return binaryFloat('float.div', left, right);
    },
    fma(a: Value, b: Value, c: Value) {
      const type = requireFloat(a, 'float.fma a');
      valueType(b, 'float.fma b');
      valueType(c, 'float.fma c');
      assertValue(b, state, type, 'float.fma b');
      assertValue(c, state, type, 'float.fma c');
      return emitOne('float.fma', [ssa(a), ssa(b), ssa(c)], type);
    },
    cmp(predicate: string, left: Value, right: Value) {
      return compareFloat('float.cmp', predicate, left, right);
    },
    isNaN(value: Value) {
      requireFloat(value, 'float.isNaN value');
      return emitOne('float.isNaN', [ssa(value)], 'bool');
    },
    isFinite(value: Value) {
      requireFloat(value, 'float.isFinite value');
      return emitOne('float.isFinite', [ssa(value)], 'bool');
    },
  };

  const convertOperations = {
    intToFloat(target: string, value: Value) {
      assertScalarType(target, 'convert.intToFloat target');
      if (!isFloatType(target)) {
        fail('convert.intToFloat target must be a float type');
      }
      requireInteger(value, 'convert.intToFloat value');
      return emitOne('convert.intToFloat', [literal(target), ssa(value)], target);
    },
    floatToInt(target: string, value: Value) {
      assertScalarType(target, 'convert.floatToInt target');
      if (!isIntegerType(target)) {
        fail('convert.floatToInt target must be an integer type');
      }
      requireFloat(value, 'convert.floatToInt value');
      return emitOne('convert.floatToInt', [literal(target), ssa(value)], target);
    },
    float(target: string, value: Value) {
      assertScalarType(target, 'convert.float target');
      if (!isFloatType(target)) {
        fail('convert.float target must be a float type');
      }
      requireFloat(value, 'convert.float value');
      return emitOne('convert.float', [literal(target), ssa(value)], target);
    },
  };

  const stateOperations = {
    load(ref: StateRef): Value {
      const memory = requireMemory(ref, 'state', 'state.load resource');
      const type = stateType(ref, memory);
      return emitOne('state.load', [staticOperand(ref)], type);
    },
    store(ref: StateRef, value: Value): undefined {
      const memory = requireMemory(ref, 'state', 'state.store resource');
      const type = stateType(ref, memory);
      valueType(value, 'state.store value');
      assertValue(value, state, type, 'state.store value');
      emit('state.store', [staticOperand(ref), ssa(value)], []);
      return undefined;
    },
  };

  const stateType = (ref: StaticRef, memory: MemoryState): ScalarType => {
    if (memory.definition.layout.kind !== 'scalar') {
      fail('state reference does not describe a scalar state resource');
    }
    const type = (ref as StateRef)[scalarType];
    assertScalarType(type, 'state element type');
    return type;
  };

  const arrayOperations = {
    load(ref: ArrayRef, index: Value): Value {
      const memory = requireMemory(ref, 'array', 'array.load resource');
      if (memory.definition.layout.kind !== 'scalar') {
        fail('array reference does not describe a scalar array resource');
      }
      const type = (ref as ArrayRef)[scalarType];
      assertScalarType(type, 'array element type');
      requireU32(index, 'array.load index');
      return emitOne('array.load', [staticOperand(ref), ssa(index)], type);
    },
    store(ref: ArrayRef, index: Value, value: Value): undefined {
      const memory = requireMemory(ref, 'array', 'array.store resource');
      if (memory.definition.layout.kind !== 'scalar') {
        fail('array reference does not describe a scalar array resource');
      }
      const type = (ref as ArrayRef)[scalarType];
      assertScalarType(type, 'array element type');
      requireU32(index, 'array.store index');
      valueType(value, 'array.store value');
      assertValue(value, state, type, 'array.store value');
      emit('array.store', [staticOperand(ref), ssa(index), ssa(value)], []);
      return undefined;
    },
  };

  const requireByteLayout = (memory: MemoryState, label: string): void => {
    if (memory.definition.layout.kind !== 'bytes') {
      fail(`${label} does not describe a byte resource`);
    }
  };

  const bytesOperations = {
    load(type: string, endian: string, ref: StaticRef, offset: Value) {
      assertScalarType(type, 'bytes.load type');
      if (!isNumericType(type)) {
        fail('bytes.load type must be numeric');
      }
      requireEndian(endian, 'bytes.load endian');
      const memory = requireByteMemory(ref, 'bytes.load resource');
      requireByteLayout(memory, 'bytes.load resource');
      requireU32(offset, 'bytes.load offset');
      return emitOne(
        'bytes.load',
        [literal(type), literal(endian), staticOperand(ref), ssa(offset)],
        type,
      );
    },
    store(type: string, endian: string, ref: StaticRef, offset: Value, value: Value) {
      assertScalarType(type, 'bytes.store type');
      if (!isNumericType(type)) {
        fail('bytes.store type must be numeric');
      }
      requireEndian(endian, 'bytes.store endian');
      const memory = requireMemory(ref, 'bytes', 'bytes.store resource');
      requireByteLayout(memory, 'bytes.store resource');
      if (!memory.definition.writable) {
        fail('bytes.store destination must be writable');
      }
      requireU32(offset, 'bytes.store offset');
      valueType(value, 'bytes.store value');
      assertValue(value, state, type, 'bytes.store value');
      emit(
        'bytes.store',
        [literal(type), literal(endian), staticOperand(ref), ssa(offset), ssa(value)],
        [],
      );
      return undefined;
    },
    copy(
      destination: StaticRef,
      destinationOffset: Value,
      source: StaticRef,
      sourceOffset: Value,
      length: Value,
    ) {
      const destinationMemory = requireMemory(destination, 'bytes', 'bytes.copy destination');
      requireByteLayout(destinationMemory, 'bytes.copy destination');
      if (!destinationMemory.definition.writable) {
        fail('bytes.copy destination must be writable');
      }
      const sourceKind = source[refKind];
      if (sourceKind !== 'bytes' && sourceKind !== 'inbox') {
        fail('bytes.copy source must be a readable byte resource');
      }
      const sourceMemory = requireByteMemory(source, 'bytes.copy source');
      requireByteLayout(sourceMemory, 'bytes.copy source');
      requireU32(destinationOffset, 'bytes.copy destinationOffset');
      requireU32(sourceOffset, 'bytes.copy sourceOffset');
      requireU32(length, 'bytes.copy length');
      emit(
        'bytes.copy',
        [
          staticOperand(destination),
          ssa(destinationOffset),
          staticOperand(source),
          ssa(sourceOffset),
          ssa(length),
        ],
        [],
      );
      return undefined;
    },
  };

  const resourceOperations = {
    updateBytes(
      destination: StaticRef,
      destinationOffset: Value,
      source: StaticRef,
      sourceOffset: Value,
      length: Value,
    ) {
      requireByteLayout(
        requireMemory(destination, 'bytes', 'resource.update_bytes destination'),
        'resource.update_bytes destination',
      );
      requireByteLayout(
        requireByteMemory(source, 'resource.update_bytes source'),
        'resource.update_bytes source',
      );
      requireU32(destinationOffset, 'resource.update_bytes destinationOffset');
      requireU32(sourceOffset, 'resource.update_bytes sourceOffset');
      requireU32(length, 'resource.update_bytes length');
      emit(
        'resource.update_bytes',
        [
          staticOperand(destination),
          ssa(destinationOffset),
          staticOperand(source),
          ssa(sourceOffset),
          ssa(length),
        ],
        [],
      );
      return undefined;
    },
    fillBytes(destination: StaticRef, offset: Value, length: Value, value: Value) {
      requireByteLayout(
        requireMemory(destination, 'bytes', 'resource.fill_bytes destination'),
        'resource.fill_bytes destination',
      );
      requireU32(offset, 'resource.fill_bytes offset');
      requireU32(length, 'resource.fill_bytes length');
      assertValue(value, state, 'u8', 'resource.fill_bytes value');
      emit(
        'resource.fill_bytes',
        [staticOperand(destination), ssa(offset), ssa(length), ssa(value)],
        [],
      );
      return undefined;
    },
  };

  const call = (target: FunctionRef, args: readonly Value[]): Value[] => {
    const declaration = requireCallable(target, 'call target');
    assertValueList(args, state, declaration.params, 'call args');
    const block = current('call');
    const results = createResults(declaration.results);
    block.instructions.push({
      op: 'call',
      operands: [staticOperand(target), ...args.map((value) => ssa(value))],
      results,
    });
    return results;
  };

  const makeBlock = (types: readonly ScalarType[]): BlockRef => {
    if (state.invalidated) {
      fail(`Function "${state.declaration.name}" cannot continue after a failed block definition`);
    }
    if (state.finished) {
      fail('Cannot create a block after the function body has finished');
    }
    const checked = assertScalarTypeList(types, 'block parameter types');
    const block = new Block(state, state.blockSeq++, checked);
    state.blocks.push(block);
    return createBlockRef(block);
  };

  const at = (
    ref: BlockRef,
    callback: (builder: unknown, params: Value[]) => unknown,
  ): undefined => {
    if (state.invalidated) {
      fail(`Function "${state.declaration.name}" cannot continue after a failed block definition`);
    }
    if (state.finished) {
      fail('Cannot define a block after the function body has finished');
    }
    const block = requireBlock(ref, state, 'block');
    if (block.defined || block.defining) {
      fail(`Block ${block.id} is already defined`);
    }
    const label = `Block ${block.id} callback`;
    assertSynchronousCallback(callback, label);
    block.defining = true;
    block.params = block.paramTypes.map((type) => createValue(state, type, state.valueSeq++));
    state.insertion.push(block);
    try {
      invokeSynchronousCallback(callback, [createBuilderObject(state), block.params], label);
      if (state.invalidated) {
        fail(`Block ${block.id} cannot be committed after a nested failure`);
      }
      if (block.terminator === undefined) {
        state.invalidated = true;
        fail(`Block ${block.id} must end with a terminator`);
      }
      block.defined = true;
    } catch (error) {
      state.invalidated = true;
      throw error;
    } finally {
      state.insertion.pop();
      block.defining = false;
    }
    return undefined;
  };

  const terminate = (
    terminator: NonNullable<BlockState['terminator']>,
    operation: string,
  ): undefined => {
    current(operation).terminator = terminator;
    return undefined;
  };

  const invoke = (instruction: DomainInstruction, operands: readonly unknown[]): Value[] => {
    const metadata = getInstructionMetadata(instruction);
    if (metadata === undefined || metadata.module !== module) {
      fail('invoke target is not a domain instruction declared by this module');
    }
    if (!Array.isArray(operands)) {
      fail(`Instruction "${metadata.name}" operands must be an array`);
    }
    const expected = metadata.definition.operands;
    if (operands.length !== expected.length) {
      fail(
        `Instruction "${metadata.name}" expects ${expected.length} operand(s), received ${operands.length}`,
      );
    }
    const checkedOperands = expected.map((descriptor, index) => {
      const operand = operands[index];
      switch (descriptor.kind) {
        case 'value':
          if (typeof operand !== 'object' || operand === null) {
            fail(`Instruction "${metadata.name}" operand ${index} must be an SSA value`);
          }
          valueType(operand as Value, `Instruction "${metadata.name}" operand ${index}`);
          assertValue(
            operand as Value,
            state,
            descriptor.type,
            `Instruction "${metadata.name}" operand ${index}`,
          );
          return ssa(operand as Value);
        case 'static':
          if (typeof operand !== 'object' || operand === null) {
            fail(`Instruction "${metadata.name}" operand ${index} must be a static reference`);
          }
          if ((operand as StaticRef)[refKind] !== descriptor.category) {
            fail(
              `Instruction "${metadata.name}" operand ${index} must have category ${descriptor.category}`,
            );
          }
          assertStaticRef(
            operand as StaticRef,
            module,
            descriptor.category,
            `Instruction "${metadata.name}" operand ${index}`,
          );
          return staticOperand(operand as StaticRef);
        case 'literal':
          if (
            typeof operand !== 'boolean' &&
            typeof operand !== 'number' &&
            typeof operand !== 'string'
          ) {
            fail(
              `Instruction "${metadata.name}" operand ${index} must be a boolean, number, or string`,
            );
          }
          return literal(operand);
      }
    });
    const block = current(`instruction "${metadata.name}"`);
    const results = createResults(metadata.definition.results);
    block.instructions.push({
      op: metadata.name,
      operands: checkedOperands,
      results,
    });
    return results;
  };

  const builder = {
    const<T extends ScalarType>(type: T, value: unknown): Value<T> {
      assertScalarType(type, 'const type');
      const literalValue = normalizeScalarLiteral(type, value);
      return emitOne('const', [literal(literalValue)], type);
    },
    bits<T extends 'f32' | 'f64'>(type: T, bits: string): Value<T> {
      assertScalarType(type, 'const.bits type');
      if (!isFloatType(type)) {
        fail('const.bits type must be f32 or f64');
      }
      assertHexBits(type, bits);
      return emitOne('const.bits', [literal(bits)], type);
    },
    bool: boolOperations,
    int: intOperations,
    float: floatOperations,
    convert: convertOperations,
    bitcast(target: string, value: Value): Value {
      assertScalarType(target, 'bitcast target');
      const source = valueType(value, 'bitcast value');
      const valid =
        (source === 'f32' && (target === 'u32' || target === 'i32')) ||
        ((source === 'u32' || source === 'i32') && target === 'f32');
      if (!valid) {
        fail(`bitcast does not allow ${source} to ${target}`);
      }
      assertValue(value, state, source, 'bitcast value');
      return emitOne('bitcast', [literal(target), ssa(value)], target);
    },
    select(condition: Value, yes: Value, no: Value): Value {
      requireBool(condition, 'select condition');
      const type = valueType(yes, 'select yes');
      valueType(no, 'select no');
      assertValue(no, state, type, 'select no');
      return emitOne('select', [ssa(condition), ssa(yes), ssa(no)], type);
    },
    state: stateOperations,
    array: arrayOperations,
    bytes: bytesOperations,
    resource: resourceOperations,
    event: {
      now(): Value<'f64'> {
        return emitOne('event.now', [], 'f64');
      },
      at(target: EntryRef, deadline: Value<'f64'>, args: readonly Value[]): Value<'u32'> {
        const declaration = requireEntry(target, 'event.at target');
        if (declaration.category !== 'entry') {
          fail('event.at target must be an ordinary entry');
        }
        assertValue(deadline, state, 'f64', 'event.at deadline');
        assertValueList(args, state, declaration.params, 'event.at arguments');
        return emitOne('event.at', [staticOperand(target), ssa(deadline), ...args.map(ssa)], 'u32');
      },
      cancel(id: Value<'u32'>): void {
        requireU32(id, 'event.cancel id');
        emit('event.cancel', [ssa(id)], []);
      },
    },
    call(target: FunctionRef, args: readonly Value[]): Value[] {
      return call(target, args);
    },
    block(types: readonly ScalarType[]): BlockRef {
      return makeBlock(types);
    },
    at(
      ref: BlockRef,
      callback: (builder: FunctionBuilder, params: Value[]) => undefined,
    ): undefined {
      return at(ref, callback as (builder: unknown, params: Value[]) => unknown);
    },
    invoke(instruction: DomainInstruction, operands: readonly unknown[]): Value[] {
      return invoke(instruction, operands);
    },
    return(values: readonly Value[]): undefined {
      assertValueList(values, state, state.declaration.results, 'return values');
      return terminate({ kind: 'return', values: [...values] }, 'return');
    },
    jump(ref: BlockRef, args: readonly Value[]): undefined {
      const block = requireBlock(ref, state, 'jump target');
      assertEdgeLayout(block, args, state, 'jump arguments');
      return terminate({ kind: 'jump', target: block, args: [...args] }, 'jump');
    },
    branch(
      condition: Value,
      yes: { target: BlockRef; args: readonly Value[] },
      no: { target: BlockRef; args: readonly Value[] },
    ): undefined {
      requireBool(condition, 'branch condition');
      if (typeof yes !== 'object' || yes === null || typeof no !== 'object' || no === null) {
        fail('branch requires yes and no edges');
      }
      const yesBlock = requireBlock(yes.target, state, 'branch yes target');
      const noBlock = requireBlock(no.target, state, 'branch no target');
      assertEdgeLayout(yesBlock, yes.args, state, 'branch yes arguments');
      assertEdgeLayout(noBlock, no.args, state, 'branch no arguments');
      return terminate(
        {
          kind: 'branch',
          condition: condition as Value<'bool'>,
          yes: { target: yesBlock, args: [...yes.args] },
          no: { target: noBlock, args: [...no.args] },
        },
        'branch',
      );
    },
    trap(code: string): undefined {
      assertName(code, 'trap code');
      return terminate({ kind: 'trap', code }, 'trap');
    },
  };

  for (const extension of state.module.builderExtensions) {
    const label = `Builder extension "${extension.namespace}"`;
    let namespace: unknown;
    try {
      namespace = extension.create.call(extension.receiver, builder as unknown as FunctionBuilder);
    } catch (error) {
      fail(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof namespace !== 'object' || namespace === null || Array.isArray(namespace)) {
      fail(`${label} must return a namespace object`);
    }
    for (const key of Object.keys(namespace)) {
      const member = (namespace as Record<string, unknown>)[key];
      if (typeof member !== 'function') {
        fail(`${label} member "${key}" must be a function`);
      }
      assertSynchronousCallback(member, `${label} member "${key}"`);
    }
    let frozen: unknown;
    try {
      frozen = Object.freeze(namespace);
    } catch {
      fail(`${label} must return a freezeable object`);
    }
    Object.defineProperty(builder, extension.namespace, {
      value: frozen,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  return builder;
}

function requireEndian(value: unknown, label: string): void {
  if (typeof value !== 'string' || !ENDIANS.has(value)) {
    fail(`${label} must be "little" or "big"`);
  }
}
