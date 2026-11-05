import { fail } from './errors.js';
import type { BlockIR, DeviceIR, InputPath, OperationIR, SourceRange, ValueTypeIR } from './ir.js';

// Schema nodes are untrusted until this pass has checked every field.
export type Node = Record<string, unknown>;
export const builtins: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Logic: ['low', 'high', 'unknown'],
  SampleStatus: ['valid', 'floating'],
  Overflow: ['drop_new', 'drop_oldest', 'error'],
});
export const unary = ['positive', 'negate', 'not', 'bitNot'];
export const binary = [
  'add',
  'subtract',
  'multiply',
  'divide',
  'remainder',
  'power',
  'lessThan',
  'lessThanOrEqual',
  'greaterThan',
  'greaterThanOrEqual',
  'equal',
  'notEqual',
  'concat',
  'bitAnd',
  'bitOr',
  'bitXor',
  'shiftLeft',
  'shiftRight',
  'shiftRightUnsigned',
];
export const numeric = [
  'isNaN',
  'isFinite',
  'isInteger',
  'isSafeInteger',
  'abs',
  'floor',
  'ceil',
  'trunc',
  'round',
  'sqrt',
  'min',
  'max',
  'pow',
];
export const loads = ['load8', 'load16le', 'load16be', 'load32le', 'load32be'];
export const stores = ['store8', 'store16le', 'store16be', 'store32le', 'store32be'];
const valueKinds = ['number', 'bool', 'string', 'bytes', 'sample', 'intent', 'enum', 'record'];

export function object(value: unknown, path: InputPath): asserts value is Node {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail('IR_SCHEMA', 'Expected a data object.', path);
}
export function fields(
  n: Node,
  required: string[],
  optional: string[],
  p: InputPath,
  located = true,
): void {
  for (const key of required)
    if (!Object.hasOwn(n, key)) fail('IR_SCHEMA', `Missing field ${key}.`, [...p, key]);
  for (const key of Object.keys(n))
    if (![...required, ...optional, ...(located ? ['source'] : [])].includes(key))
      fail('IR_SCHEMA', `Unexpected field ${key}.`, [...p, key]);
  if (Object.hasOwn(n, 'source')) source(n.source, [...p, 'source']);
}
export function text(v: unknown, p: InputPath): asserts v is string {
  if (typeof v !== 'string') fail('IR_SCHEMA', 'Expected a string.', p);
}
export function bool(v: unknown, p: InputPath): void {
  if (typeof v !== 'boolean') fail('IR_SCHEMA', 'Expected a boolean.', p);
}
export function num(v: unknown, p: InputPath): void {
  if (typeof v !== 'number') fail('IR_SCHEMA', 'Expected a number.', p);
}
export function id(v: unknown, p: InputPath): void {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
    fail('IR_SCHEMA', 'Expected a nonnegative safe integer.', p);
}
export function choice<const Choices extends readonly string[]>(
  v: unknown,
  choices: Choices,
  p: InputPath,
): asserts v is Choices[number] {
  if (!choices.includes(v as string))
    fail('IR_SCHEMA', `Expected one of ${choices.join(', ')}.`, p);
}
export function list(
  v: unknown,
  p: InputPath,
  visit: (v: unknown, p: InputPath) => void,
): asserts v is unknown[] {
  if (!Array.isArray(v)) fail('IR_SCHEMA', 'Expected an array.', p);
  for (let i = 0; i < v.length; i++) visit(v[i], [...p, i]);
}
function source(v: unknown, p: InputPath): void {
  object(v, p);
  const hasUri = Object.hasOwn(v, 'uri');
  for (const key of Object.keys(v))
    if (!['uri', 'range', 'label'].includes(key))
      fail('IR_SCHEMA', 'Invalid source field.', [...p, key]);
  if (Object.hasOwn(v, 'label')) text(v.label, [...p, 'label']);
  if (!hasUri) {
    if (!Object.hasOwn(v, 'label') || Object.hasOwn(v, 'range'))
      fail('IR_SCHEMA', 'Source requires a label or URI and range.', p);
    return;
  }
  text(v.uri, [...p, 'uri']);
  object(v.range, [...p, 'range']);
  const r = v.range;
  for (const key of Object.keys(r))
    if (!['start', 'end'].includes(key))
      fail('IR_SCHEMA', 'Invalid range field.', [...p, 'range', key]);
  for (const key of ['start', 'end']) {
    const position = r[key];
    object(position, [...p, 'range', key]);
    for (const k of Object.keys(position))
      if (!['line', 'column'].includes(k))
        fail('IR_SCHEMA', 'Invalid position field.', [...p, 'range', key, k]);
    for (const k of ['line', 'column'])
      if (!Number.isSafeInteger(position[k]) || (position[k] as number) < 1)
        fail('IR_SCHEMA', 'Positions start at one.', [...p, 'range', key, k]);
  }
  const { start, end } = r as unknown as SourceRange;
  if (end.line < start.line || (end.line === start.line && end.column < start.column))
    fail('IR_SCHEMA', 'Source range is reversed.', p);
}
export function valueType(v: unknown, p: InputPath, optional = true): asserts v is ValueTypeIR {
  object(v, p);
  if (v.kind === 'optional' && optional) {
    fields(v, ['kind', 'inner'], [], p);
    valueType(v.inner, [...p, 'inner'], false);
  } else {
    choice(v.kind, valueKinds, [...p, 'kind']);
    fields(v, ['kind', ...(['enum', 'record'].includes(v.kind) ? ['name'] : [])], [], p);
    if (['enum', 'record'].includes(v.kind)) text(v.name, [...p, 'name']);
  }
  if (Object.hasOwn(v, 'source'))
    fail('IR_SCHEMA', 'Type descriptors cannot carry source information.', p);
}
function ref(v: unknown, p: InputPath, category?: string): void {
  object(v, p);
  if (Object.hasOwn(v, 'source'))
    fail('IR_SCHEMA', 'Resource references cannot carry source information.', p);
  choice(v.kind, ['pin', 'memory', 'parameter'], [...p, 'kind']);
  if (v.kind === 'parameter') {
    fields(v, ['kind', 'resource', 'index'], [], p);
    choice(v.resource, ['pin', 'memory'], [...p, 'resource']);
    id(v.index, [...p, 'index']);
    if (category && v.resource !== category)
      fail('IR_REFERENCE', 'Resource category does not match.', p);
  } else {
    fields(v, ['kind', 'name'], [], p);
    text(v.name, [...p, 'name']);
    if (category && v.kind !== category)
      fail('IR_REFERENCE', 'Resource category does not match.', p);
  }
}
function constant(v: unknown, p: InputPath, pattern = false): void {
  object(v, p);
  if (Object.hasOwn(v, 'source'))
    fail('IR_SCHEMA', 'Constants and patterns cannot carry source information.', p);
  const choices = pattern
    ? ['number', 'bool', 'string', 'enum', 'none']
    : ['number', 'bool', 'string', 'bytes', 'enum', 'record', 'none'];
  choice(v.kind, choices, [...p, 'kind']);
  switch (v.kind) {
    case 'none':
      fields(v, ['kind'], [], p);
      break;
    case 'enum':
      fields(v, ['kind', 'name', 'member'], [], p);
      text(v.name, [...p, 'name']);
      text(v.member, [...p, 'member']);
      break;
    case 'record':
      fields(v, ['kind', 'name', 'fields'], [], p);
      text(v.name, [...p, 'name']);
      list(v.fields, [...p, 'fields'], (f, q) => {
        object(f, q);
        fields(f, ['name', 'value'], [], q);
        text(f.name, [...q, 'name']);
        if (!['number', 'boolean'].includes(typeof f.value))
          fail('IR_SCHEMA', 'Expected a number or boolean field.', [...q, 'value']);
      });
      break;
    case 'bytes':
      fields(v, ['kind', 'value'], [], p);
      list(v.value, [...p, 'value'], (n, q) => {
        if (!Number.isInteger(n) || (n as number) < 0 || (n as number) > 255)
          fail('IR_SCHEMA', 'Expected a byte.', q);
      });
      break;
    default:
      fields(v, ['kind', 'value'], [], p);
      if (v.kind === 'number') {
        num(v.value, [...p, 'value']);
        if (pattern && !Number.isFinite(v.value))
          fail('IR_CONTROL_FLOW', 'Numeric match patterns must be finite.', p);
      } else if (v.kind === 'bool') bool(v.value, [...p, 'value']);
      else text(v.value, [...p, 'value']);
  }
}
export function region(v: unknown, p: InputPath): void {
  object(v, p);
  fields(v, ['operations'], [], p);
  list(v.operations, [...p, 'operations'], operation);
}
function computation(v: unknown, p: InputPath): void {
  object(v, p);
  fields(v, ['type', 'body'], [], p);
  valueType(v.type, [...p, 'type']);
  region(v.body, [...p, 'body']);
}
export function operation(v: unknown, p: InputPath): asserts v is OperationIR {
  object(v, p);
  text(v.kind, [...p, 'kind']);
  let required: string[] = [],
    optional: string[] = [],
    result = false;
  const resultFields = (names: string[]) => {
    required = names;
    result = true;
  };
  switch (v.kind) {
    case 'constant':
      resultFields(['constant']);
      constant(v.constant, [...p, 'constant']);
      break;
    case 'read':
      resultFields(['resource', 'name']);
      choice(v.resource, ['property', 'const', 'state', 'derived'], [...p, 'resource']);
      text(v.name, [...p, 'name']);
      break;
    case 'parameter':
    case 'reactionCapture':
      resultFields(['index']);
      id(v.index, [...p, 'index']);
      break;
    case 'reactionValue':
      resultFields(['binding']);
      choice(v.binding, ['previous', 'current'], [...p, 'binding']);
      break;
    case 'unary':
      resultFields(['operator', 'value']);
      choice(v.operator, unary, [...p, 'operator']);
      break;
    case 'binary':
      resultFields(['operator', 'left', 'right']);
      choice(v.operator, binary, [...p, 'operator']);
      break;
    case 'numeric':
      resultFields(['builtin', 'args']);
      choice(v.builtin, numeric, [...p, 'builtin']);
      list(v.args, [...p, 'args'], id);
      break;
    case 'record':
      resultFields(['fields']);
      list(v.fields, [...p, 'fields'], (f, q) => {
        object(f, q);
        fields(f, ['name', 'value'], [], q);
        text(f.name, [...q, 'name']);
        id(f.value, [...q, 'value']);
      });
      break;
    case 'field':
      resultFields(['value', 'field']);
      text(v.field, [...p, 'field']);
      break;
    case 'bytes':
      resultFields(['elements']);
      list(v.elements, [...p, 'elements'], id);
      break;
    case 'length':
    case 'optional':
    case 'isNone':
    case 'nonNull':
      resultFields(['value']);
      break;
    case 'index':
      resultFields(['value', 'index']);
      id(v.index, [...p, 'index']);
      break;
    case 'localRead':
      resultFields(['local']);
      id(v.local, [...p, 'local']);
      break;
    case 'local':
      required = ['local', 'type', 'initial'];
      id(v.local, [...p, 'local']);
      valueType(v.type, [...p, 'type']);
      break;
    case 'localWrite':
      required = ['local', 'value'];
      id(v.local, [...p, 'local']);
      break;
    case 'write':
      required = ['resource', 'name', 'value'];
      choice(v.resource, ['state'], [...p, 'resource']);
      text(v.name, [...p, 'name']);
      break;
    case 'memoryLength':
      resultFields(['memory']);
      ref(v.memory, [...p, 'memory'], 'memory');
      break;
    case 'load8':
    case 'load16le':
    case 'load16be':
    case 'load32le':
    case 'load32be':
      resultFields(['memory', 'offset']);
      ref(v.memory, [...p, 'memory'], 'memory');
      break;
    case 'store8':
    case 'store16le':
    case 'store16be':
    case 'store32le':
    case 'store32be':
      required = ['memory', 'offset', 'value'];
      ref(v.memory, [...p, 'memory'], 'memory');
      break;
    case 'copyBytes':
      resultFields(['memory', 'offset', 'length']);
      ref(v.memory, [...p, 'memory'], 'memory');
      break;
    case 'readSample':
      resultFields(['pin']);
      ref(v.pin, [...p, 'pin'], 'pin');
      break;
    case 'resistor':
      resultFields(['to', 'resistance']);
      ref(v.to, [...p, 'to'], 'pin');
      break;
    case 'combineIntents':
      resultFields(['values']);
      list(v.values, [...p, 'values'], id);
      break;
    case 'refEqual':
      resultFields(['left', 'right']);
      ref(v.left, [...p, 'left']);
      ref(v.right, [...p, 'right']);
      break;
    case 'writeIntent':
      required = ['pin', 'value'];
      ref(v.pin, [...p, 'pin'], 'pin');
      break;
    case 'call':
    case 'callValue':
      required = ['name', 'pure', 'args'];
      result = v.kind === 'callValue';
      text(v.name, [...p, 'name']);
      bool(v.pure, [...p, 'pure']);
      list(v.args, [...p, 'args'], (a, q) => {
        object(a, q);
        if (a.kind === 'value') {
          fields(a, ['kind', 'value'], [], q);
          id(a.value, [...q, 'value']);
        } else ref(a, q);
      });
      break;
    case 'send':
      required = ['channel', 'value'];
      text(v.channel, [...p, 'channel']);
      break;
    case 'notify':
      required = ['notification'];
      text(v.notification, [...p, 'notification']);
      break;
    case 'receive':
      resultFields(['channel']);
      text(v.channel, [...p, 'channel']);
      break;
    case 'now':
    case 'random':
      resultFields([]);
      break;
    case 'if':
      required = ['condition', 'yes'];
      optional = ['no'];
      region(v.yes, [...p, 'yes']);
      if (Object.hasOwn(v, 'no')) region(v.no, [...p, 'no']);
      break;
    case 'match':
      required = ['value', 'arms'];
      optional = ['otherwise'];
      list(v.arms, [...p, 'arms'], (a, q) => {
        object(a, q);
        fields(a, ['pattern', 'body'], [], q);
        constant(a.pattern, [...q, 'pattern'], true);
        region(a.body, [...q, 'body']);
      });
      if (Object.hasOwn(v, 'otherwise')) region(v.otherwise, [...p, 'otherwise']);
      break;
    case 'while':
      required = ['test', 'body'];
      computation(v.test, [...p, 'test']);
      region(v.body, [...p, 'body']);
      break;
    case 'loop':
      required = ['body'];
      region(v.body, [...p, 'body']);
      break;
    case 'and':
    case 'or':
      resultFields(['left', 'right']);
      computation(v.right, [...p, 'right']);
      break;
    case 'select':
      resultFields(['condition', 'yes', 'no']);
      computation(v.yes, [...p, 'yes']);
      computation(v.no, [...p, 'no']);
      break;
    case 'assert':
      required = ['condition'];
      optional = ['message'];
      if (Object.hasOwn(v, 'message')) computation(v.message, [...p, 'message']);
      break;
    case 'wait':
    case 'elapse':
      required = ['duration'];
      break;
    case 'waitUntil':
      required = ['predicate'];
      text(v.predicate, [...p, 'predicate']);
      break;
    case 'redirect':
      required = ['target', 'delay'];
      break;
    case 'return':
    case 'break':
    case 'continue':
    case 'stop':
      break;
    case 'returnValue':
    case 'yield':
      required = ['value'];
      break;
    default:
      fail('IR_SCHEMA', `Unknown operation ${v.kind}.`, [...p, 'kind']);
  }
  fields(v, ['kind', ...required, ...(result ? ['result', 'type'] : [])], optional, p);
  if (result) {
    id(v.result, [...p, 'result']);
    valueType(v.type, [...p, 'type']);
  }
  const ids = [
    'value',
    'left',
    'right',
    'condition',
    'initial',
    'offset',
    'length',
    'resistance',
    'duration',
    'target',
    'delay',
  ];
  for (const key of ids) {
    if (
      Object.hasOwn(v, key) &&
      typeof v[key] !== 'object' &&
      !(key === 'value' && ['constant', 'read'].includes(v.kind))
    )
      id(v[key], [...p, key]);
    else if (
      Object.hasOwn(v, key) &&
      typeof v[key] === 'object' &&
      !['refEqual', 'and', 'or'].includes(v.kind)
    )
      fail('IR_SCHEMA', 'Expected a result identifier.', [...p, key]);
  }
}
export function deviceSchema(v: unknown): asserts v is DeviceIR {
  object(v, []);
  fields(v, ['kind', 'name', 'declarations'], [], []);
  choice(v.kind, ['device'], ['kind']);
  text(v.name, ['name']);
  list(v.declarations, ['declarations'], (d, p) => {
    object(d, p);
    text(d.kind, [...p, 'kind']);
    const required = ['kind'];
    let optional: string[] = [];
    if (!['start', 'assert'].includes(d.kind)) {
      required.push('name');
      text(d.name, [...p, 'name']);
    }
    switch (d.kind) {
      case 'enum':
        required.push('members');
        list(d.members, [...p, 'members'], text);
        break;
      case 'record':
        required.push('fields');
        list(d.fields, [...p, 'fields'], (f, q) => {
          object(f, q);
          fields(f, ['name', 'type'], [], q);
          text(f.name, [...q, 'name']);
          choice(f.type, ['number', 'bool'], [...q, 'type']);
        });
        break;
      case 'property':
        required.push('type');
        optional = ['default'];
        if (Object.hasOwn(d, 'default')) computation(d.default, [...p, 'default']);
        break;
      case 'const':
      case 'derived':
        required.push('type', 'value');
        computation(d.value, [...p, 'value']);
        break;
      case 'state':
        required.push('type', 'initial');
        computation(d.initial, [...p, 'initial']);
        break;
      case 'pin':
        optional = ['initial', 'low', 'high'];
        for (const k of optional) if (Object.hasOwn(d, k)) computation(d[k], [...p, k]);
        if (Object.hasOwn(d, 'low') !== Object.hasOwn(d, 'high'))
          fail('IR_SCHEMA', 'Pin thresholds must be provided together.', p);
        break;
      case 'memory':
        required.push('public', 'length');
        bool(d.public, [...p, 'public']);
        computation(d.length, [...p, 'length']);
        break;
      case 'channel':
        required.push('direction', 'type', 'capacity');
        optional = ['maxLength', 'overflow'];
        computation(d.capacity, [...p, 'capacity']);
        for (const k of optional) if (Object.hasOwn(d, k)) computation(d[k], [...p, k]);
        break;
      case 'notification':
        required.push('direction');
        break;
      case 'function':
        required.push('pure', 'params', 'body');
        optional = ['returns'];
        bool(d.pure, [...p, 'pure']);
        list(d.params, [...p, 'params'], (param, q) => {
          object(param, q);
          fields(param, ['name', 'type'], [], q);
          text(param.name, [...q, 'name']);
          object(param.type, [...q, 'type']);
          if (['pin', 'memory'].includes(param.type.kind as string))
            fields(param.type, ['kind'], [], [...q, 'type']);
          else valueType(param.type, [...q, 'type']);
        });
        if (Object.hasOwn(d, 'returns')) valueType(d.returns, [...p, 'returns']);
        region(d.body, [...p, 'body']);
        break;
      case 'start':
      case 'assert':
        required.push('body');
        region(d.body, [...p, 'body']);
        break;
      case 'on':
        required.push('sourcePath', 'body');
        list(d.sourcePath, [...p, 'sourcePath'], text);
        region(d.body, [...p, 'body']);
        break;
      case 'reaction':
        required.push('sourcePath', 'sourceType', 'previous', 'current', 'captures', 'body');
        list(d.sourcePath, [...p, 'sourcePath'], text);
        valueType(d.sourceType, [...p, 'sourceType']);
        text(d.previous, [...p, 'previous']);
        text(d.current, [...p, 'current']);
        list(d.captures, [...p, 'captures'], (c, q) => {
          object(c, q);
          fields(c, ['name', 'value'], [], q);
          text(c.name, [...q, 'name']);
          computation(c.value, [...q, 'value']);
        });
        region(d.body, [...p, 'body']);
        break;
      default:
        fail('IR_SCHEMA', `Unknown declaration ${d.kind}.`, [...p, 'kind']);
    }
    fields(d, required, optional, p);
    if (Object.hasOwn(d, 'type')) valueType(d.type, [...p, 'type']);
    if (['channel', 'notification'].includes(d.kind))
      choice(d.direction, ['input', 'output'], [...p, 'direction']);
  });
}
export function blockSchema(v: unknown): asserts v is BlockIR {
  object(v, []);
  fields(v, ['kind', 'instructions'], [], []);
  choice(v.kind, ['block'], ['kind']);
  list(v.instructions, ['instructions'], (instruction, p) => {
    object(instruction, p);
    fields(instruction, ['pc', 'nextPc', 'body'], [], p);
    for (const key of ['pc', 'nextPc'])
      if (typeof instruction[key] !== 'number' || !Number.isFinite(instruction[key]))
        fail('IR_SCHEMA', 'Instruction positions must be finite numbers.', [...p, key]);
    region(instruction.body, [...p, 'body']);
  });
  const instructions = v.instructions as BlockIR['instructions'];
  if (!instructions.length)
    fail('IR_JIT_BOUNDARY', 'A block requires at least one instruction.', ['instructions']);
  for (let i = 1; i < instructions.length; i++)
    if (instructions[i - 1]!.nextPc !== instructions[i]!.pc)
      fail('IR_JIT_BOUNDARY', 'Adjacent instruction boundaries do not match.', [
        'instructions',
        i,
        'pc',
      ]);
}
