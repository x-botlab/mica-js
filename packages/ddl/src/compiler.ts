import type { AstNode } from 'langium';
import {
  BuildError,
  validateDeviceIR,
  type ArgumentIR,
  type BinaryOperator,
  type ComparableTypeIR,
  type ComputationIR,
  type DeclarationIR,
  type DeviceIR,
  type DiagnosticCode,
  type MatchPatternIR,
  type MemoryRefIR,
  type NumericBuiltin,
  type OperationIR,
  type ParameterTypeIR,
  type PinRefIR,
  type RegionIR,
  type SourceInfo,
  type ValueRegionIR,
  type ValueTypeIR,
} from '@mica-js/device-model';
import type * as AST from './generated/ast.js';

const numberType = { kind: 'number' } as const;
const boolType = { kind: 'bool' } as const;
const stringType = { kind: 'string' } as const;
const intentType = { kind: 'intent' } as const;
const bytesType = { kind: 'bytes' } as const;
const numeric = new Set([
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
]);
const enumMembers: Readonly<Record<string, readonly string[]>> = {
  Logic: ['low', 'high', 'unknown'],
  SampleStatus: ['valid', 'floating'],
  Overflow: ['drop_new', 'drop_oldest', 'error'],
};
const reserved = new Set([
  'device',
  'default',
  'const',
  'let',
  'enum',
  'record',
  'state',
  'derived',
  'pin',
  'memory',
  'fn',
  'pure',
  'process',
  'on',
  'reaction',
  'as',
  'capture',
  'if',
  'else',
  'match',
  'while',
  'loop',
  'break',
  'continue',
  'return',
  'await',
  'assert',
  'redirect',
  'true',
  'false',
  'none',
  'number',
  'bool',
  'string',
  'bytes',
  'intent',
  'sample',
  'NaN',
  'Infinity',
  ...Object.keys(enumMembers),
  ...numeric,
  'load8',
  'load16le',
  'load16be',
  'load32le',
  'load32be',
  'store8',
  'store16le',
  'store16be',
  'store32le',
  'store32be',
  'copyBytes',
  'resistor',
  'random',
  'now',
  'ticks',
]);
const binaryOperators: Readonly<Record<string, BinaryOperator>> = {
  '+': 'add',
  '-': 'subtract',
  '*': 'multiply',
  '/': 'divide',
  '%': 'remainder',
  '**': 'power',
  '<': 'lessThan',
  '<=': 'lessThanOrEqual',
  '>': 'greaterThan',
  '>=': 'greaterThanOrEqual',
  '==': 'equal',
  '!=': 'notEqual',
  '&': 'bitAnd',
  '|': 'bitOr',
  '^': 'bitXor',
  '<<': 'shiftLeft',
  '>>': 'shiftRight',
  '>>>': 'shiftRightUnsigned',
};

type SymbolNode = AST.Property | Exclude<AST.Member, AST.AssertStmt>;
type Expr = AST.Expr;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type ValueOperation = DistributiveOmit<
  Extract<OperationIR, { readonly result: number }>,
  'result' | 'type'
>;
function isValueType(type: ParameterTypeIR): type is ValueTypeIR {
  return type.kind !== 'pin' && type.kind !== 'memory';
}
interface Value {
  id: number;
  type: ValueTypeIR;
  nonNull?: boolean;
}
interface Binding {
  type: ParameterTypeIR;
  kind: 'local' | 'parameter' | 'previous' | 'current' | 'capture';
  index: number;
  mutable: boolean;
}
type Fact = 'none' | 'nonNull';
interface Counter {
  result: number;
  local: number;
}
interface Context {
  operations: OperationIR[];
  bindings: Map<string, Binding>;
  facts: Map<string, Fact>;
  counter: Counter;
  returns: ValueTypeIR | undefined;
  mode: 'function' | 'process' | 'reaction' | 'computation' | 'assert';
  loops: { breaks: Map<string, Fact>[]; continues: Map<string, Fact>[] }[];
  ended: boolean;
}

function same(a: ValueTypeIR, b: ValueTypeIR): boolean {
  return (
    a.kind === b.kind &&
    (a.kind === 'optional' && b.kind === 'optional'
      ? same(a.inner, b.inner)
      : (a.kind === 'enum' || a.kind === 'record') && (b.kind === 'enum' || b.kind === 'record')
        ? a.name === b.name
        : true)
  );
}
function base(type: ValueTypeIR): Exclude<ValueTypeIR, { kind: 'optional' }> {
  return type.kind === 'optional' ? type.inner : type;
}
function optional(type: ValueTypeIR): ValueTypeIR {
  return type.kind === 'optional' ? type : { kind: 'optional', inner: type };
}
function intersection(paths: readonly Map<string, Fact>[]): Map<string, Fact> {
  const result = new Map(paths[0]);
  for (const [name, fact] of result)
    if (paths.some((path) => path.get(name) !== fact)) result.delete(name);
  return result;
}
function isNone(node: Expr): boolean {
  return node.$type === 'Literal' && node.value === 'none';
}

/** Lowers Langium's structured AST directly into the canonical operation regions. */
export class DDLCompiler {
  private readonly symbols = new Map<string, SymbolNode>();
  private readonly types = new Map<string, ValueTypeIR>();
  private readonly resolving = new Set<string>();
  private readonly sources = new WeakMap<AstNode, SourceInfo>();
  private readonly valueTypes = new WeakMap<AST.ValueType, ValueTypeIR>();

  constructor(
    private readonly device: AST.Device,
    private readonly uri: string,
  ) {
    for (const member of [...device.properties, ...device.members]) {
      if (member.$type === 'AssertStmt') continue;
      this.checkName(member.name, member);
      if (this.symbols.has(member.name))
        this.fail(member, `Duplicate declaration '${member.name}'.`, 'IR_SCOPE');
      this.symbols.set(member.name, member);
    }
  }

  source(node: AstNode): SourceInfo {
    const cached = this.sources.get(node);
    if (cached) return cached;
    const range = node.$cstNode?.range;
    const source: SourceInfo = range
      ? {
          uri: this.uri,
          range: {
            start: { line: range.start.line + 1, column: range.start.character + 1 },
            end: { line: range.end.line + 1, column: range.end.character + 1 },
          },
        }
      : { label: this.device.name };
    this.sources.set(node, source);
    return source;
  }

  private fail(node: AstNode, message: string, code: DiagnosticCode = 'IR_TYPE'): never {
    throw new BuildError([
      { code, message, phase: 'finalize', path: [], source: this.source(node), related: [] },
    ]);
  }

  private checkName(name: string, node: AstNode): void {
    if (reserved.has(name)) this.fail(node, `Name '${name}' is reserved.`, 'IR_SCOPE');
  }

  private type(node: AST.ValueType): ValueTypeIR {
    const cached = this.valueTypes.get(node);
    if (cached) return cached;
    let type: ValueTypeIR;
    switch (node.name) {
      case 'number':
      case 'bool':
      case 'string':
      case 'bytes':
      case 'intent':
      case 'sample':
        type = { kind: node.name };
        break;
      default: {
        if (node.name in enumMembers) {
          type = { kind: 'enum', name: node.name };
          break;
        }
        const decl = this.symbols.get(node.name);
        if (decl?.$type !== 'EnumDecl' && decl?.$type !== 'RecordDecl')
          this.fail(node, `Unknown value type '${node.name}'.`, 'IR_REFERENCE');
        type = { kind: decl.$type === 'EnumDecl' ? 'enum' : 'record', name: node.name };
      }
    }
    if (node.name in enumMembers) type = { kind: 'enum', name: node.name };
    const resolved = node.optional ? optional(type) : type;
    this.valueTypes.set(node, resolved);
    return resolved;
  }

  private parameterType(node: AST.ParameterType): ParameterTypeIR {
    if (node.value) return this.type(node.value);
    return { kind: node.name as 'pin' | 'memory' };
  }

  private context(mode: Context['mode'], returns?: ValueTypeIR): Context {
    return {
      operations: [],
      bindings: new Map(),
      facts: new Map(),
      counter: { result: 0, local: 0 },
      returns,
      mode,
      loops: [],
      ended: false,
    };
  }

  private child(context: Context): Context {
    return {
      ...context,
      operations: [],
      bindings: new Map(context.bindings),
      facts: new Map(context.facts),
      ended: false,
    };
  }

  private emit(context: Context, node: AstNode, operation: OperationIR): void {
    context.operations.push({ ...operation, source: this.source(node) });
  }

  private value(
    context: Context,
    node: AstNode,
    type: ValueTypeIR,
    operation: ValueOperation,
  ): Value {
    const result = context.counter.result++;
    this.emit(context, node, { ...operation, result, type } as OperationIR);
    return { id: result, type, ...(operation.kind === 'optional' ? { nonNull: true } : {}) };
  }

  private constant(
    context: Context,
    node: AstNode,
    type: ValueTypeIR,
    constant: Extract<OperationIR, { kind: 'constant' }>['constant'],
  ): Value {
    return this.value(context, node, type, { kind: 'constant', constant } as ValueOperation);
  }

  private expect(context: Context, node: AstNode, value: Value, expected?: ValueTypeIR): Value {
    if (!expected || same(value.type, expected)) return value;
    if (expected.kind === 'optional' && same(value.type, expected.inner))
      return this.value(context, node, expected, {
        kind: 'optional',
        value: value.id,
      } as ValueOperation);
    return this.fail(
      node,
      `Expected ${this.describe(expected)}, received ${this.describe(value.type)}.`,
    );
  }

  private describe(type: ValueTypeIR): string {
    return type.kind === 'optional'
      ? `${this.describe(type.inner)}?`
      : type.kind === 'enum' || type.kind === 'record'
        ? type.name
        : type.kind;
  }

  private symbolType(name: string, node: AstNode): ValueTypeIR {
    const cached = this.types.get(name);
    if (cached) return cached;
    if (this.resolving.has(name))
      this.fail(node, `Cyclic dependency involving '${name}'.`, 'IR_DEPENDENCY');
    const symbol = this.symbols.get(name);
    if (!symbol) this.fail(node, `Unknown name '${name}'.`, 'IR_REFERENCE');
    this.resolving.add(name);
    let type: ValueTypeIR;
    switch (symbol.$type) {
      case 'Property':
      case 'StateDecl':
      case 'DerivedDecl':
      case 'ChannelDecl':
        type = this.type(symbol.type);
        break;
      case 'ConstantDecl':
        type = symbol.type
          ? this.type(symbol.type)
          : this.expression(this.context('computation'), symbol.value).type;
        break;
      default:
        return this.fail(node, `'${name}' is not a value.`, 'IR_TYPE');
    }
    this.resolving.delete(name);
    this.types.set(name, type);
    return type;
  }

  private bind(context: Context, name: string, binding: Binding, node: AstNode): void {
    this.checkName(name, node);
    if (context.bindings.has(name) || this.symbols.has(name))
      this.fail(node, `Binding '${name}' shadows a visible declaration.`, 'IR_SCOPE');
    context.bindings.set(name, binding);
  }

  private resource(context: Context, node: Expr, kind: 'pin'): PinRefIR;
  private resource(context: Context, node: Expr, kind: 'memory'): MemoryRefIR;
  private resource(context: Context, node: Expr, kind: 'pin' | 'memory'): PinRefIR | MemoryRefIR {
    if (node.$type !== 'Reference')
      return this.fail(node, `Expected a direct ${kind} resource reference.`);
    const binding = context.bindings.get(node.name);
    if (binding?.kind === 'parameter' && binding.type.kind === kind)
      return { kind: 'parameter', resource: kind, index: binding.index };
    const decl = this.symbols.get(node.name);
    if (decl?.$type === (kind === 'pin' ? 'PinDecl' : 'MemoryDecl'))
      return kind === 'pin'
        ? { kind: 'pin', name: node.name }
        : { kind: 'memory', name: node.name };
    return this.fail(node, `'${node.name}' is not a ${kind} resource.`);
  }

  private resourceKind(context: Context, node: Expr): 'pin' | 'memory' | undefined {
    if (node.$type !== 'Reference') return undefined;
    const binding = context.bindings.get(node.name);
    if (binding?.type.kind === 'pin' || binding?.type.kind === 'memory') return binding.type.kind;
    const decl = this.symbols.get(node.name);
    return decl?.$type === 'PinDecl' ? 'pin' : decl?.$type === 'MemoryDecl' ? 'memory' : undefined;
  }

  private read(context: Context, node: AST.Reference): Value {
    const binding = context.bindings.get(node.name);
    if (!binding) {
      const decl = this.symbols.get(node.name);
      const resource =
        decl?.$type === 'Property'
          ? 'property'
          : decl?.$type === 'ConstantDecl'
            ? 'const'
            : decl?.$type === 'StateDecl'
              ? 'state'
              : decl?.$type === 'DerivedDecl'
                ? 'derived'
                : undefined;
      if (!resource)
        this.fail(node, `Name '${node.name}' is not a readable value.`, 'IR_REFERENCE');
      return this.value(context, node, this.symbolType(node.name, node), {
        kind: 'read',
        resource,
        name: node.name,
      } as ValueOperation);
    }
    if (!isValueType(binding.type)) this.fail(node, 'Resources cannot be used as ordinary values.');
    const op =
      binding.kind === 'local'
        ? { kind: 'localRead', local: binding.index }
        : binding.kind === 'parameter'
          ? { kind: 'parameter', index: binding.index }
          : binding.kind === 'capture'
            ? { kind: 'reactionCapture', index: binding.index }
            : { kind: 'reactionValue', binding: binding.kind };
    const value = this.value(context, node, binding.type, op as ValueOperation);
    return binding.type.kind === 'optional' && context.facts.get(node.name) === 'nonNull'
      ? this.value(context, node, binding.type.inner, {
          kind: 'nonNull',
          value: value.id,
        } as ValueOperation)
      : value;
  }

  private number(node: AstNode, text: string): number {
    const value = Number(text.replaceAll('_', ''));
    if (!Number.isFinite(value)) this.fail(node, 'A numeric literal must be finite.');
    return value;
  }

  private string(node: AstNode, text: string): string {
    return text
      .slice(1, -1)
      .replace(
        /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|(["\\nrt]))/g,
        (
          _match: string,
          point: string | undefined,
          unit: string | undefined,
          simple: string | undefined,
        ) => {
          if (point) {
            const value = Number.parseInt(point, 16);
            if (value > 0x10ffff)
              this.fail(node, 'Unicode escape is outside the valid code point range.');
            return String.fromCodePoint(value);
          }
          if (unit) return String.fromCharCode(Number.parseInt(unit, 16));
          return simple === 'n' ? '\n' : simple === 'r' ? '\r' : simple === 't' ? '\t' : simple!;
        },
      );
  }

  private fieldType(node: AstNode, type: ValueTypeIR, field: string): ValueTypeIR {
    if (type.kind === 'sample') {
      if (field === 'voltage') return optional(numberType);
      if (field === 'level') return { kind: 'enum', name: 'Logic' };
      if (field === 'status') return { kind: 'enum', name: 'SampleStatus' };
    }
    if ((type.kind === 'bytes' || type.kind === 'string') && field === 'length') return numberType;
    if (type.kind === 'record') {
      const decl = this.symbols.get(type.name);
      const match =
        decl?.$type === 'RecordDecl'
          ? decl.fields.find((candidate) => candidate.name === field)
          : undefined;
      if (match) return { kind: match.type };
    }
    return this.fail(node, `Unknown field '${field}' on ${this.describe(type)}.`);
  }

  private expression(context: Context, node: Expr, expected?: ValueTypeIR): Value {
    let value: Value;
    switch (node.$type) {
      case 'NumberLiteral':
        value = this.constant(context, node, numberType, {
          kind: 'number',
          value: this.number(node, node.value),
        });
        break;
      case 'StringLiteral':
        value = this.constant(context, node, stringType, {
          kind: 'string',
          value: this.string(node, node.value),
        });
        break;
      case 'Literal': {
        if (node.value === 'none') {
          if (expected?.kind !== 'optional')
            this.fail(node, 'The none literal requires an optional target type.');
          value = this.constant(context, node, expected, { kind: 'none' });
        } else if (node.value === 'true' || node.value === 'false')
          value = this.constant(context, node, boolType, {
            kind: 'bool',
            value: node.value === 'true',
          });
        else
          value = this.constant(context, node, numberType, {
            kind: 'number',
            value: node.value === 'NaN' ? NaN : Infinity,
          });
        break;
      }
      case 'Reference':
        value = this.read(context, node);
        break;
      case 'Unary': {
        const type = node.op === '!' ? boolType : numberType;
        const input = this.expression(context, node.value, type);
        const operator =
          node.op === '+'
            ? 'positive'
            : node.op === '-'
              ? 'negate'
              : node.op === '!'
                ? 'not'
                : 'bitNot';
        value = this.value(context, node, type, {
          kind: 'unary',
          operator,
          value: input.id,
        } as ValueOperation);
        break;
      }
      case 'Binary':
        value = this.binary(context, node);
        break;
      case 'Select':
        value = this.select(context, node, expected);
        break;
      case 'BytesLiteral':
        value = this.value(context, node, bytesType, {
          kind: 'bytes',
          elements: node.elements.map(
            (element) => this.expression(context, element, numberType).id,
          ),
        } as ValueOperation);
        break;
      case 'IntentLiteral':
        value = this.value(context, node, intentType, {
          kind: 'combineIntents',
          values: node.elements.map((element) => this.expression(context, element, intentType).id),
        } as ValueOperation);
        break;
      case 'RecordLiteral': {
        const type = expected && base(expected);
        if (type?.kind !== 'record')
          this.fail(node, 'A record literal requires a named record target type.');
        const decl = this.symbols.get(type.name);
        if (decl?.$type !== 'RecordDecl') this.fail(node, `Unknown record '${type.name}'.`);
        const seen = new Set<string>();
        const fields = node.fields.map((field) => {
          const target = decl.fields.find((candidate) => candidate.name === field.name);
          if (!target || seen.has(field.name))
            this.fail(field, `Unknown or duplicate record field '${field.name}'.`);
          seen.add(field.name);
          return {
            name: field.name,
            value: this.expression(context, field.value, { kind: target.type }).id,
          };
        });
        if (seen.size !== decl.fields.length)
          this.fail(node, 'Record literal is missing required fields.');
        value = this.value(context, node, type, { kind: 'record', fields } as ValueOperation);
        break;
      }
      case 'MemberAccess': {
        if (node.object.$type === 'Reference') {
          const root = node.object.name;
          const decl = this.symbols.get(root);
          const members =
            enumMembers[root] ?? (decl?.$type === 'EnumDecl' ? decl.members : undefined);
          if (members) {
            if (!members.includes(node.member))
              this.fail(node, `Unknown enum member '${root}.${node.member}'.`, 'IR_REFERENCE');
            value = this.constant(
              context,
              node,
              { kind: 'enum', name: root },
              { kind: 'enum', name: root, member: node.member },
            );
            break;
          }
          const resource = this.resourceKind(context, node.object);
          if (resource === 'pin' && node.member === 'sample') {
            value = this.value(context, node, { kind: 'sample' }, {
              kind: 'readSample',
              pin: this.resource(context, node.object, 'pin'),
            } as ValueOperation);
            break;
          }
          if (resource === 'memory' && node.member === 'length') {
            value = this.value(context, node, numberType, {
              kind: 'memoryLength',
              memory: this.resource(context, node.object, 'memory'),
            } as ValueOperation);
            break;
          }
        }
        const object = this.expression(context, node.object);
        const type = this.fieldType(node, object.type, node.member);
        value = this.value(
          context,
          node,
          type,
          node.member === 'length' &&
            (object.type.kind === 'bytes' || object.type.kind === 'string')
            ? { kind: 'length', value: object.id }
            : { kind: 'field', value: object.id, field: node.member },
        );
        const key = this.factKey(context, node);
        if (type.kind === 'optional' && key && context.facts.get(key) === 'nonNull')
          value = this.value(context, node, type.inner, { kind: 'nonNull', value: value.id });
        break;
      }
      case 'IndexAccess': {
        const object = this.expression(context, node.object);
        if (object.type.kind !== 'bytes' && object.type.kind !== 'string')
          this.fail(node, 'Only string and bytes values can be indexed.');
        const index = this.expression(context, node.index, numberType);
        value = this.value(context, node, object.type.kind === 'bytes' ? numberType : stringType, {
          kind: 'index',
          value: object.id,
          index: index.id,
        } as ValueOperation);
        break;
      }
      case 'Call': {
        const result = this.call(context, node, false);
        if (!result) this.fail(node, 'A void call cannot be used as a value.');
        value = result;
        break;
      }
      default:
        return this.fail(node, 'Unsupported expression.', 'IR_SCHEMA');
    }
    return this.expect(context, node, value, expected);
  }

  private infer(context: Context, node: Expr, expected?: ValueTypeIR): ValueTypeIR {
    return this.expression(this.child(context), node, expected).type;
  }

  private binary(context: Context, node: AST.Binary): Value {
    const op = node.op;
    if (op === '&&' || op === '||') {
      const left = this.expression(context, node.left, boolType);
      const branch = this.child(context);
      branch.facts = this.facts(node.left, op === '&&', context);
      const right = this.expression(branch, node.right, boolType);
      this.emit(branch, node.right, { kind: 'yield', value: right.id });
      return this.value(context, node, boolType, {
        kind: op === '&&' ? 'and' : 'or',
        left: left.id,
        right: {
          type: boolType,
          body: { operations: branch.operations, source: this.source(node.right) },
        },
      } as ValueOperation);
    }
    if (op === '==' || op === '!=') {
      let equal: Value;
      const leftResource = this.resourceKind(context, node.left);
      const rightResource = this.resourceKind(context, node.right);
      if (leftResource || rightResource) {
        if (!leftResource || leftResource !== rightResource)
          this.fail(node, 'Resource identity comparison requires matching resource kinds.');
        const left =
          leftResource === 'pin'
            ? this.resource(context, node.left, 'pin')
            : this.resource(context, node.left, 'memory');
        const right =
          rightResource === 'pin'
            ? this.resource(context, node.right, 'pin')
            : this.resource(context, node.right, 'memory');
        equal = this.value(context, node, boolType, {
          kind: 'refEqual',
          left,
          right,
        } as ValueOperation);
        return op === '=='
          ? equal
          : this.value(context, node, boolType, {
              kind: 'unary',
              operator: 'not',
              value: equal.id,
            } as ValueOperation);
      }
      if (isNone(node.left) || isNone(node.right)) {
        if (isNone(node.left) && isNone(node.right))
          equal = this.constant(context, node, boolType, { kind: 'bool', value: true });
        else {
          const input = this.expression(context, isNone(node.left) ? node.right : node.left);
          if (input.type.kind !== 'optional') {
            const original = isNone(node.left) ? node.right : node.left;
            const key = this.factKey(context, original);
            if (
              !key ||
              (context.facts.get(key) !== 'nonNull' &&
                (original.$type !== 'Reference' ||
                  context.bindings.get(original.name)?.type.kind !== 'optional'))
            )
              this.fail(node, 'Only optional values can be compared with none.');
            equal = this.constant(context, node, boolType, { kind: 'bool', value: false });
          } else
            equal = this.value(context, node, boolType, {
              kind: 'isNone',
              value: input.id,
            } as ValueOperation);
        }
        return op === '=='
          ? equal
          : this.value(context, node, boolType, {
              kind: 'unary',
              operator: 'not',
              value: equal.id,
            } as ValueOperation);
      }
    }
    let left = this.expression(context, node.left);
    let right = this.expression(
      context,
      node.right,
      node.right.$type === 'RecordLiteral' ? left.type : undefined,
    );
    if (op === '==' || op === '!=') {
      if (left.type.kind !== 'optional' && right.type.kind === 'optional')
        left = this.expect(context, node.left, left, right.type);
      else if (left.type.kind === 'optional' && right.type.kind !== 'optional')
        right = this.expect(context, node.right, right, left.type);
    }
    let type: ValueTypeIR = numberType;
    let operator = binaryOperators[op]!;
    if (op === '==' || op === '!=') {
      if (!same(left.type, right.type) || base(left.type).kind === 'intent')
        this.fail(node, 'Equality requires comparable values of the same type.');
      type = boolType;
    } else if (op === '+' && left.type.kind === 'string' && right.type.kind === 'string') {
      type = stringType;
      operator = 'concat';
    } else {
      left = this.expect(context, node.left, left, numberType);
      right = this.expect(context, node.right, right, numberType);
      if (['<', '<=', '>', '>='].includes(op)) type = boolType;
    }
    return this.value(context, node, type, {
      kind: 'binary',
      operator,
      left: left.id,
      right: right.id,
    } as ValueOperation);
  }

  private select(context: Context, node: AST.Select, expected?: ValueTypeIR): Value {
    const condition = this.expression(context, node.condition, boolType);
    const yes = this.child(context),
      no = this.child(context);
    yes.facts = this.facts(node.condition, true, context);
    no.facts = this.facts(node.condition, false, context);
    let type = expected;
    if (!type) {
      if (isNone(node.yes) && isNone(node.no))
        this.fail(node, 'Conditional none values require an optional target type.');
      const yesType = isNone(node.yes) ? undefined : this.infer(yes, node.yes);
      const noType = isNone(node.no) ? undefined : this.infer(no, node.no);
      if (!yesType || !noType) type = optional((yesType ?? noType)!);
      else if (same(yesType, noType)) type = yesType;
      else if (same(base(yesType), base(noType))) type = optional(base(yesType));
      else this.fail(node, 'Conditional branches have incompatible types.');
    }
    const y = this.expression(yes, node.yes, type),
      n = this.expression(no, node.no, type);
    this.emit(yes, node.yes, { kind: 'yield', value: y.id });
    this.emit(no, node.no, { kind: 'yield', value: n.id });
    const value = this.value(context, node, type, {
      kind: 'select',
      condition: condition.id,
      yes: { type, body: { operations: yes.operations, source: this.source(node.yes) } },
      no: { type, body: { operations: no.operations, source: this.source(node.no) } },
    } as ValueOperation);
    if ((y.type.kind !== 'optional' || y.nonNull) && (n.type.kind !== 'optional' || n.nonNull))
      value.nonNull = true;
    return value;
  }

  private args(
    context: Context,
    call: AST.Call,
    names: readonly string[],
    types: readonly ParameterTypeIR[],
  ): ArgumentIR[] {
    if (call.args.length !== names.length)
      this.fail(call, `Expected ${names.length} arguments, received ${call.args.length}.`);
    const named = call.args.some((arg) => arg.$type === 'NamedArgument');
    if (named && call.args.some((arg) => arg.$type !== 'NamedArgument'))
      this.fail(call, 'Named and positional arguments cannot be mixed.');
    const args: ArgumentIR[] = new Array(names.length);
    for (let i = 0; i < call.args.length; i++) {
      const arg = call.args[i]!;
      const index = arg.$type === 'NamedArgument' ? names.indexOf(arg.name) : i;
      if (index < 0 || args[index]) this.fail(arg, 'Unknown or duplicate named argument.');
      const type = types[index]!;
      args[index] = isValueType(type)
        ? { kind: 'value', value: this.expression(context, arg.value, type).id }
        : type.kind === 'pin'
          ? this.resource(context, arg.value, 'pin')
          : this.resource(context, arg.value, 'memory');
    }
    return args;
  }

  private call(context: Context, node: AST.Call, discard: boolean): Value | undefined {
    if (node.callee.$type === 'MemberAccess') {
      const callee = node.callee;
      if (callee.object.$type !== 'Reference')
        this.fail(node, 'Only declared endpoint methods may be called.');
      const endpoint = this.symbols.get(callee.object.name);
      if (
        callee.member === 'send' &&
        endpoint?.$type === 'ChannelDecl' &&
        endpoint.direction === 'output'
      ) {
        const args = this.args(context, node, ['value'], [this.type(endpoint.type)]);
        this.emit(context, node, {
          kind: 'send',
          channel: endpoint.name,
          value: (args[0] as { kind: 'value'; value: number }).value,
        });
        return undefined;
      }
      if (
        callee.member === 'notify' &&
        endpoint?.$type === 'NotificationDecl' &&
        endpoint.direction === 'output'
      ) {
        this.args(context, node, [], []);
        this.emit(context, node, { kind: 'notify', notification: endpoint.name });
        return undefined;
      }
      return this.fail(node, 'Invalid endpoint operation or direction.', 'IR_EFFECT');
    }
    if (node.callee.$type !== 'Reference') this.fail(node, 'Dynamic calls are not supported.');
    const name = node.callee.name;
    if (numeric.has(name)) {
      const names =
        name === 'min' || name === 'max'
          ? ['left', 'right']
          : name === 'pow'
            ? ['base', 'exponent']
            : ['value'];
      const args = this.args(
        context,
        node,
        names,
        names.map(() => numberType),
      );
      return this.value(context, node, name.startsWith('is') ? boolType : numberType, {
        kind: 'numeric',
        builtin: name as NumericBuiltin,
        args: args.map((arg) => (arg as { kind: 'value'; value: number }).value),
      } as ValueOperation);
    }
    if (name === 'now' || name === 'random') {
      this.args(context, node, [], []);
      return this.value(context, node, numberType, { kind: name });
    }
    if (/^(load|store)(8|16le|16be|32le|32be)$/.test(name) || name === 'copyBytes') {
      const store = name.startsWith('store');
      const names = store
        ? ['memory', 'offset', 'value']
        : name === 'copyBytes'
          ? ['memory', 'offset', 'length']
          : ['memory', 'offset'];
      const args = this.args(
        context,
        node,
        names,
        names.map((_name, i) => (i === 0 ? { kind: 'memory' } : numberType)),
      );
      const memory = args[0] as MemoryRefIR;
      const offset = (args[1] as { kind: 'value'; value: number }).value;
      if (store) {
        this.emit(context, node, {
          kind: name,
          memory,
          offset,
          value: (args[2] as { kind: 'value'; value: number }).value,
        } as OperationIR);
        return undefined;
      }
      if (name === 'copyBytes')
        return this.value(context, node, bytesType, {
          kind: 'copyBytes',
          memory,
          offset,
          length: (args[2] as { kind: 'value'; value: number }).value,
        } as ValueOperation);
      return this.value(context, node, numberType, {
        kind: name,
        memory,
        offset,
      } as ValueOperation);
    }
    if (name === 'resistor') {
      const args = this.args(context, node, ['to', 'resistance'], [{ kind: 'pin' }, numberType]);
      return this.value(context, node, intentType, {
        kind: 'resistor',
        to: args[0] as PinRefIR,
        resistance: (args[1] as { kind: 'value'; value: number }).value,
      } as ValueOperation);
    }
    const target = this.symbols.get(name);
    if (target?.$type !== 'FunctionDecl')
      this.fail(node, `Unknown synchronous function '${name}'.`, 'IR_REFERENCE');
    const args = this.args(
      context,
      node,
      target.params.map((param) => param.name),
      target.params.map((param) => this.parameterType(param.type)),
    );
    if (!target.returns || discard) {
      this.emit(context, node, { kind: 'call', name, pure: target.pure, args });
      return undefined;
    }
    return this.value(context, node, this.type(target.returns), {
      kind: 'callValue',
      name,
      pure: target.pure,
      args,
    } as ValueOperation);
  }

  private factKey(context: Context, node: Expr): string | undefined {
    if (node.$type === 'Reference') {
      const binding = context.bindings.get(node.name);
      return binding && isValueType(binding.type) ? node.name : undefined;
    }
    if (node.$type === 'MemberAccess') {
      const root = this.factKey(context, node.object);
      return root ? `${root}.${node.member}` : undefined;
    }
    return undefined;
  }

  private facts(node: Expr, truth: boolean, context: Context): Map<string, Fact> {
    const facts = new Map(context.facts);
    if (node.$type === 'Unary' && node.op === '!') return this.facts(node.value, !truth, context);
    if (node.$type === 'Binary') {
      if ((node.op === '==' || node.op === '!=') && (isNone(node.left) || isNone(node.right))) {
        const ref = isNone(node.left) ? node.right : node.left;
        const key = this.factKey(context, ref);
        if (key) facts.set(key, truth === (node.op === '!=') ? 'nonNull' : 'none');
      }
      if (node.op === '&&' || node.op === '||') {
        const first = this.facts(node.left, node.op === '&&', context);
        const next = { ...context, facts: first };
        if (truth === (node.op === '&&')) return this.facts(node.right, truth, next);
        return intersection([
          this.facts(node.left, truth, context),
          this.facts(node.right, truth, next),
        ]);
      }
    }
    return facts;
  }

  private initializer(context: Context, node: AST.Initializer, expected?: ValueTypeIR): Value {
    if (node.$type !== 'AwaitOperation') return this.expression(context, node, expected);
    const result = this.await(context, node);
    if (!result) this.fail(node, 'ticks has no value and cannot initialize a binding.');
    return this.expect(context, node, result, expected);
  }

  private await(context: Context, node: AST.AwaitOperation): Value | undefined {
    if (context.mode !== 'process') this.fail(node, 'Only processes may await.', 'IR_EFFECT');
    if (node.ticks) {
      const duration = this.expression(context, node.duration!, numberType);
      this.emit(context, node, { kind: 'wait', duration: duration.id });
      return undefined;
    }
    const channel = this.symbols.get(node.channel!);
    if (channel?.$type !== 'ChannelDecl' || channel.direction !== 'input')
      this.fail(node, 'receive requires an input channel.', 'IR_EFFECT');
    return this.value(context, node, this.type(channel.type), {
      kind: 'receive',
      channel: channel.name,
    } as ValueOperation);
  }

  private markValue(context: Context, name: string, node: AST.Initializer, value: Value): void {
    for (const key of context.facts.keys())
      if (key === name || key.startsWith(`${name}.`)) context.facts.delete(key);
    if (value.type.kind !== 'optional') return;
    if (node.$type !== 'AwaitOperation' && isNone(node)) context.facts.set(name, 'none');
    else if (value.nonNull) context.facts.set(name, 'nonNull');
  }

  private block(context: Context, block: AST.Block): RegionIR {
    for (const statement of block.statements) {
      if (context.ended) this.fail(statement, 'Unreachable statement.', 'IR_CONTROL_FLOW');
      this.statement(context, statement);
    }
    return { operations: context.operations, source: this.source(block) };
  }

  private statement(context: Context, node: AST.Statement): void {
    switch (node.$type) {
      case 'LocalStmt': {
        const type = node.type ? this.type(node.type) : undefined;
        const initial = this.initializer(context, node.value, type);
        const local = context.counter.local++;
        this.bind(
          context,
          node.name,
          {
            kind: 'local',
            index: local,
            type: type ?? initial.type,
            mutable: node.binding === 'let',
          },
          node,
        );
        this.emit(context, node, {
          kind: 'local',
          local,
          type: type ?? initial.type,
          initial: initial.id,
        });
        this.markValue(context, node.name, node.value, initial);
        break;
      }
      case 'AssignStmt': {
        const binding = context.bindings.get(node.name);
        if (binding) {
          if (binding.kind !== 'local' || !binding.mutable)
            this.fail(node, `Binding '${node.name}' is readonly.`, 'IR_SCOPE');
          if (!isValueType(binding.type)) this.fail(node, 'Resources cannot be assigned.');
          const value = this.initializer(context, node.value, binding.type);
          this.emit(context, node, { kind: 'localWrite', local: binding.index, value: value.id });
          this.markValue(context, node.name, node.value, value);
        } else {
          if (this.symbols.get(node.name)?.$type !== 'StateDecl')
            this.fail(node, `Name '${node.name}' is not writable.`, 'IR_SCOPE');
          const value = this.initializer(context, node.value, this.symbolType(node.name, node));
          this.emit(context, node, {
            kind: 'write',
            resource: 'state',
            name: node.name,
            value: value.id,
          });
        }
        break;
      }
      case 'IntentStmt': {
        const ref = {
          $type: 'Reference',
          name: node.name,
          $cstNode: node.$cstNode,
        } as AST.Reference;
        const pin = this.resource(context, ref, 'pin');
        const value = this.expression(context, node.value, intentType);
        this.emit(context, node, { kind: 'writeIntent', pin, value: value.id });
        break;
      }
      case 'CallStmt': {
        if (node.value.$type !== 'Call')
          this.fail(node, 'Only synchronous calls can be used as expression statements.');
        this.call(context, node.value, true);
        break;
      }
      case 'AssertStmt': {
        const condition = this.expression(context, node.condition, boolType);
        let message: ValueRegionIR | undefined;
        if (node.message) {
          const child = this.child(context);
          const value = this.expression(child, node.message, stringType);
          this.emit(child, node.message, { kind: 'yield', value: value.id });
          message = {
            type: stringType,
            body: { operations: child.operations, source: this.source(node.message) },
          };
        }
        this.emit(context, node, {
          kind: 'assert',
          condition: condition.id,
          ...(message ? { message } : {}),
        });
        break;
      }
      case 'AwaitStmt':
        this.await(context, node.value);
        break;
      case 'IfStmt':
        this.ifStatement(context, node);
        break;
      case 'MatchStmt':
        this.match(context, node);
        break;
      case 'WhileStmt':
      case 'LoopStmt':
        this.loop(context, node);
        break;
      case 'BreakStmt':
      case 'ContinueStmt': {
        const loop = context.loops.at(-1);
        if (!loop)
          this.fail(
            node,
            `${node.$type === 'BreakStmt' ? 'break' : 'continue'} is only valid inside a loop.`,
            'IR_CONTROL_FLOW',
          );
        (node.$type === 'BreakStmt' ? loop.breaks : loop.continues).push(new Map(context.facts));
        this.emit(context, node, { kind: node.$type === 'BreakStmt' ? 'break' : 'continue' });
        context.ended = true;
        break;
      }
      case 'ReturnStmt': {
        if (context.returns) {
          if (!node.value)
            this.fail(node, 'A value-returning function must return a value.', 'IR_CONTROL_FLOW');
          const value = this.expression(context, node.value, context.returns);
          this.emit(context, node, { kind: 'returnValue', value: value.id });
        } else {
          if (node.value) this.fail(node, 'This body has no return value.', 'IR_CONTROL_FLOW');
          this.emit(context, node, { kind: 'return' });
        }
        context.ended = true;
        break;
      }
      case 'RedirectStmt': {
        const target = this.expression(context, node.target, numberType);
        const delay = node.delay
          ? this.expression(context, node.delay, numberType)
          : this.constant(context, node, numberType, { kind: 'number', value: 0 });
        this.emit(context, node, { kind: 'redirect', target: target.id, delay: delay.id });
        context.ended = true;
        break;
      }
    }
  }

  private ifStatement(context: Context, node: AST.IfStmt): void {
    const condition = this.expression(context, node.condition, boolType);
    const yes = this.child(context),
      no = this.child(context);
    yes.facts = this.facts(node.condition, true, context);
    no.facts = this.facts(node.condition, false, context);
    const yesRegion = this.block(yes, node.yes);
    let noRegion: RegionIR | undefined;
    if (node.no) noRegion = this.block(no, node.no);
    else if (node.alternate) {
      this.ifStatement(no, node.alternate);
      noRegion = { operations: no.operations, source: this.source(node.alternate) };
    }
    this.emit(context, node, {
      kind: 'if',
      condition: condition.id,
      yes: yesRegion,
      ...(noRegion ? { no: noRegion } : {}),
    });
    const paths = [yes, no].filter((branch) => !branch.ended).map((branch) => branch.facts);
    context.ended = paths.length === 0;
    context.facts = intersection(paths);
  }

  private pattern(node: AST.Pattern): MatchPatternIR {
    if (node.number !== undefined)
      return {
        kind: 'number',
        value: (node.sign === '-' ? -1 : 1) * this.number(node, node.number),
      };
    if (node.string !== undefined) return { kind: 'string', value: this.string(node, node.string) };
    if (node.literal === 'none') return { kind: 'none' };
    if (node.literal) return { kind: 'bool', value: node.literal === 'true' };
    return { kind: 'enum', name: node.enum!, member: node.member! };
  }

  private match(context: Context, node: AST.MatchStmt): void {
    const value = this.expression(context, node.value);
    const arms: { pattern: MatchPatternIR; body: RegionIR; source: SourceInfo }[] = [];
    let otherwise: RegionIR | undefined;
    let excludedNone = false;
    const paths: Map<string, Fact>[] = [];
    for (let i = 0; i < node.arms.length; i++) {
      const arm = node.arms[i]!;
      const branch = this.child(context);
      const name = this.factKey(context, node.value);
      if (name) {
        if (arm.pattern.literal === 'none') branch.facts.set(name, 'none');
        else if (!arm.pattern.wildcard || excludedNone) branch.facts.set(name, 'nonNull');
      }
      const body = this.block(branch, arm.body);
      if (!branch.ended) paths.push(branch.facts);
      if (arm.pattern.wildcard) {
        if (i !== node.arms.length - 1)
          this.fail(arm, 'The default match arm must be last.', 'IR_CONTROL_FLOW');
        otherwise = body;
      } else {
        const pattern = this.pattern(arm.pattern);
        arms.push({ pattern, body, source: this.source(arm) });
        if (pattern.kind === 'none') excludedNone = true;
      }
    }
    this.emit(context, node, {
      kind: 'match',
      value: value.id,
      arms,
      ...(otherwise ? { otherwise } : {}),
    });
    context.ended = paths.length === 0;
    context.facts = intersection(paths);
  }

  private loop(context: Context, node: AST.WhileStmt | AST.LoopStmt): void {
    let incoming = new Map(context.facts);
    // Facts can only disappear at a loop join; recompute until all backedges agree.
    for (;;) {
      const entry = this.child(context);
      entry.facts = incoming;
      const control = { breaks: [] as Map<string, Fact>[], continues: [] as Map<string, Fact>[] };
      let test: ValueRegionIR | undefined;
      const body = this.child(entry);
      body.loops = [...context.loops, control];
      if (node.$type === 'WhileStmt') {
        const condition = this.expression(entry, node.condition, boolType);
        this.emit(entry, node.condition, { kind: 'yield', value: condition.id });
        test = {
          type: boolType,
          body: { operations: entry.operations, source: this.source(node.condition) },
        };
        body.facts = this.facts(node.condition, true, entry);
      }
      const region = this.block(body, node.body);
      const backedges = [...control.continues, ...(!body.ended ? [body.facts] : [])];
      const joined = intersection([incoming, ...backedges]);
      if (joined.size !== incoming.size) {
        incoming = joined;
        continue;
      }
      if (test) this.emit(context, node, { kind: 'while', test, body: region });
      else this.emit(context, node, { kind: 'loop', body: region });
      const exits = [...control.breaks];
      if (node.$type === 'WhileStmt') exits.push(this.facts(node.condition, false, entry));
      context.facts = intersection(exits);
      context.ended = exits.length === 0;
      return;
    }
  }

  private computation(node: Expr, expected?: ValueTypeIR): ComputationIR {
    const context = this.context('computation', expected);
    const value = this.expression(context, node, expected);
    this.emit(context, node, { kind: 'returnValue', value: value.id });
    return {
      type: expected ?? value.type,
      body: { operations: context.operations, source: this.source(node) },
      source: this.source(node),
    };
  }

  private options(
    node: AST.PinDecl | AST.ChannelDecl,
    allowed: readonly string[],
  ): Map<string, AST.NamedArgument> {
    const result = new Map<string, AST.NamedArgument>();
    for (const option of node.options) {
      if (!allowed.includes(option.name) || result.has(option.name))
        this.fail(option, `Unknown or duplicate option '${option.name}'.`);
      result.set(option.name, option);
    }
    return result;
  }

  private staticNumber(node: Expr, seen = new Set<string>()): number | undefined {
    if (node.$type === 'NumberLiteral') return this.number(node, node.value);
    if (node.$type === 'Literal' && node.value === 'Infinity') return Infinity;
    if (node.$type === 'Literal' && node.value === 'NaN') return NaN;
    if (node.$type === 'Unary' && (node.op === '+' || node.op === '-')) {
      const value = this.staticNumber(node.value, seen);
      return value === undefined ? undefined : node.op === '-' ? -value : value;
    }
    if (node.$type === 'Reference' && !seen.has(node.name)) {
      const decl = this.symbols.get(node.name);
      if (decl?.$type === 'ConstantDecl')
        return this.staticNumber(decl.value, new Set([...seen, node.name]));
    }
    return undefined;
  }

  private sourceType(node: AST.SourcePath): ValueTypeIR {
    const [root, ...fields] = node.parts;
    const decl = this.symbols.get(root!);
    let type: ValueTypeIR;
    if (decl?.$type === 'PinDecl') {
      if (fields.shift() !== 'sample') this.fail(node, 'A pin source must begin with pin.sample.');
      type = { kind: 'sample' };
    } else if (decl?.$type === 'StateDecl' || decl?.$type === 'DerivedDecl')
      type = this.symbolType(root!, node);
    else return this.fail(node, 'Expected a state, derived, or pin.sample source.', 'IR_REFERENCE');
    for (const field of fields) type = this.fieldType(node, type, field);
    if (base(type).kind === 'intent')
      this.fail(node, 'Intent values are not comparable observation sources.');
    return type;
  }

  compile(): DeviceIR {
    const declarations: DeclarationIR[] = [];
    for (const property of this.device.properties) {
      declarations.push({
        kind: 'property',
        name: property.name,
        type: this.type(property.type),
        ...(property.value
          ? { default: this.computation(property.value, this.type(property.type)) }
          : {}),
        source: this.source(property),
      });
    }
    for (const node of this.device.members) {
      const source = this.source(node);
      switch (node.$type) {
        case 'EnumDecl':
          declarations.push({ kind: 'enum', name: node.name, members: node.members, source });
          break;
        case 'RecordDecl':
          declarations.push({
            kind: 'record',
            name: node.name,
            fields: node.fields.map((field) => ({ name: field.name, type: field.type })),
            source,
          });
          break;
        case 'ConstantDecl':
          declarations.push({
            kind: 'const',
            name: node.name,
            type: this.symbolType(node.name, node),
            value: this.computation(node.value, this.symbolType(node.name, node)),
            source,
          });
          break;
        case 'StateDecl':
          declarations.push({
            kind: 'state',
            name: node.name,
            type: this.type(node.type),
            initial: this.computation(node.value, this.type(node.type)),
            source,
          });
          break;
        case 'DerivedDecl':
          declarations.push({
            kind: 'derived',
            name: node.name,
            type: this.type(node.type),
            value: this.computation(node.value, this.type(node.type)),
            source,
          });
          break;
        case 'PinDecl': {
          const opts = this.options(node, ['low', 'high']);
          if (opts.has('low') !== opts.has('high'))
            this.fail(node, 'Pin thresholds require both low and high.');
          if (opts.has('low')) {
            const low = this.staticNumber(opts.get('low')!.value),
              high = this.staticNumber(opts.get('high')!.value);
            if (
              (low !== undefined && !Number.isFinite(low)) ||
              (high !== undefined && !Number.isFinite(high)) ||
              (low !== undefined && high !== undefined && low >= high)
            )
              this.fail(node, 'Pin thresholds must be finite and satisfy low < high.');
          }
          declarations.push({
            kind: 'pin',
            name: node.name,
            ...(opts.has('low')
              ? {
                  low: this.computation(opts.get('low')!.value, numberType),
                  high: this.computation(opts.get('high')!.value, numberType),
                }
              : {}),
            ...(node.value
              ? {
                  initial: this.computation(node.value, intentType) as ComputationIR & {
                    type: typeof intentType;
                  },
                }
              : {}),
            source,
          });
          break;
        }
        case 'MemoryDecl':
          declarations.push({
            kind: 'memory',
            name: node.name,
            public: node.public,
            length: this.computation(node.length, numberType),
            source,
          });
          break;
        case 'ChannelDecl': {
          const opts = this.options(node, ['capacity', 'maxLength', 'overflow']);
          if (!opts.has('capacity')) this.fail(node, 'Channel capacity is required.');
          const type = this.type(node.type);
          if ((type.kind === 'bytes') !== opts.has('maxLength'))
            this.fail(node, 'Exactly bytes channels require maxLength.');
          declarations.push({
            kind: 'channel',
            name: node.name,
            direction: node.direction,
            type,
            capacity: this.computation(opts.get('capacity')!.value, numberType),
            ...(opts.has('maxLength')
              ? { maxLength: this.computation(opts.get('maxLength')!.value, numberType) }
              : {}),
            ...(opts.has('overflow')
              ? {
                  overflow: this.computation(opts.get('overflow')!.value, {
                    kind: 'enum',
                    name: 'Overflow',
                  }),
                }
              : {}),
            source,
          });
          break;
        }
        case 'NotificationDecl':
          declarations.push({
            kind: 'notification',
            name: node.name,
            direction: node.direction,
            source,
          });
          break;
        case 'FunctionDecl': {
          const returns = node.returns ? this.type(node.returns) : undefined;
          const context = this.context('function', returns);
          const params = node.params.map((param, index) => {
            const type = this.parameterType(param.type);
            this.bind(
              context,
              param.name,
              { kind: 'parameter', index, type, mutable: false },
              param,
            );
            return { name: param.name, type, source: this.source(param) };
          });
          const body = this.block(context, node.body);
          if (returns && !context.ended)
            this.fail(node, 'A value-returning function may reach its end.', 'IR_CONTROL_FLOW');
          declarations.push({
            kind: 'function',
            name: node.name,
            pure: node.pure,
            params,
            ...(returns ? { returns } : {}),
            body,
            source,
          });
          break;
        }
        case 'ProcessDecl': {
          const body = this.block(this.context('process'), node.body);
          if (node.name === 'start' && !node.path)
            declarations.push({ kind: 'start', body, source });
          else {
            if (!node.path || node.name === 'start')
              this.fail(node, 'A non-start process requires an on source.');
            const endpoint = this.symbols.get(node.path.parts[0]!);
            if (!(
              node.path.parts.length === 1 &&
              endpoint?.$type === 'NotificationDecl' &&
              endpoint.direction === 'input'
            ))
              this.sourceType(node.path);
            declarations.push({
              kind: 'on',
              name: node.name,
              sourcePath: node.path.parts,
              body,
              source,
            });
          }
          break;
        }
        case 'ReactionDecl': {
          if (node.name === 'start')
            this.fail(node, 'start is reserved for the startup process.', 'IR_SCOPE');
          const sourceType = this.sourceType(node.path) as ComparableTypeIR;
          const captures = node.captures.map((capture) => {
            const value = this.computation(capture.value);
            if (base(value.type).kind === 'intent')
              this.fail(capture, 'Reaction captures must be comparable.');
            return {
              name: capture.name,
              value: value as ComputationIR & { type: ComparableTypeIR },
              source: this.source(capture),
            };
          });
          const context = this.context('reaction');
          this.bind(
            context,
            node.previous,
            { kind: 'previous', type: sourceType, index: 0, mutable: false },
            node,
          );
          this.bind(
            context,
            node.current,
            { kind: 'current', type: sourceType, index: 0, mutable: false },
            node,
          );
          captures.forEach((capture, index) =>
            this.bind(
              context,
              capture.name,
              { kind: 'capture', type: capture.value.type, index, mutable: false },
              node.captures[index]!,
            ),
          );
          declarations.push({
            kind: 'reaction',
            name: node.name,
            sourcePath: node.path.parts as [string, ...string[]],
            sourceType,
            previous: node.previous,
            current: node.current,
            captures,
            body: this.block(context, node.body),
            source,
          });
          break;
        }
        case 'AssertStmt': {
          const context = this.context('assert');
          this.statement(context, node);
          declarations.push({
            kind: 'assert',
            body: { operations: context.operations, source },
            source,
          });
          break;
        }
      }
    }
    return validateDeviceIR({
      kind: 'device',
      name: this.device.name,
      declarations,
      source: this.source(this.device),
    });
  }
}
