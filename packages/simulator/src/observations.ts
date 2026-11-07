import type {
  ArgumentIR,
  BinaryOperator,
  DeclarationIR,
  MemoryRefIR,
  NumericBuiltin,
  OperationIR,
  PinRefIR,
  RegionIR,
  UnaryOperator,
  ValueRegionIR,
  ValueTypeIR,
} from '@mica-js/device-model';
import {
  checkBoolean,
  createBytes,
  createEnum,
  createRecord,
  equalValues,
  nonNull,
  readIndex,
} from '@mica-js/compiler';
import { range, same } from './values.js';

/**
 * A generated observation plan for one static source path.
 *
 * The generic path already compiles each computation to JavaScript; what this plan adds
 * is binding. The source path, its projection, the resource objects and the resource
 * slots are resolved once, so a publication round performs no host or resource name
 * resolution, no dependency-stack tracking, no derived cache staleness check and no
 * per-round dependency map merge. Every operation of every branch is emitted from the
 * supported set; anything outside it rejects the whole plan and the caller keeps the
 * generic path.
 */
export interface PlannedSlot {
  readonly version: number;
}

export interface ObservationMemory {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly slot: PlannedSlot;
}

export interface ObservationTarget {
  readonly declarations: ReadonlyMap<string, DeclarationIR>;
  readonly states: ReadonlyMap<string, unknown>;
  readonly pins: ReadonlyMap<string, { readonly sample: unknown }>;
  readonly stateResources: ReadonlyMap<string, PlannedSlot>;
  readonly sampleResources: ReadonlyMap<string, PlannedSlot>;
  readonly memoryResources: ReadonlyMap<string, PlannedSlot>;
  memoryPlan(ref: unknown): ObservationMemory;
  read(kind: string, name: string): unknown;
}

export interface CompiledObservation {
  readonly key: string;
  readonly path: readonly string[];
  /** Generated reader source; kept for tests and diagnostics, not evaluated again. */
  readonly source: string;
  /** Generated comparator source. */
  readonly comparison: string;
  readonly slots: readonly PlannedSlot[];
  /** Raw value of the source path, exactly what an unmodified derived read returns. */
  readonly evaluate: () => unknown;
  readonly equals: (previous: unknown, current: unknown) => boolean;
  /** Non-primitive results are snapshotted for the immutable observation baseline. */
  readonly needsSnapshot: boolean;
}

export type ObservationCompilation =
  | { readonly ok: true; readonly plan: CompiledObservation }
  | { readonly ok: false; readonly reason: string };

const unaryOperators: Partial<Record<UnaryOperator, string>> = {
  positive: '+',
  negate: '-',
  not: '!',
  bitNot: '~',
};
const binaryOperators: Partial<Record<BinaryOperator, string>> = {
  add: '+',
  subtract: '-',
  multiply: '*',
  divide: '/',
  remainder: '%',
  power: '**',
  lessThan: '<',
  lessThanOrEqual: '<=',
  greaterThan: '>',
  greaterThanOrEqual: '>=',
  concat: '+',
  bitAnd: '&',
  bitOr: '|',
  bitXor: '^',
  shiftLeft: '<<',
  shiftRight: '>>',
  shiftRightUnsigned: '>>>',
};
const numericBuiltins = new Set<NumericBuiltin>([
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
const numberBuiltins = new Set<NumericBuiltin>(['isNaN', 'isFinite', 'isInteger', 'isSafeInteger']);

function load(kind: string, memory: ObservationMemory, offset: unknown): number {
  const size = kind.startsWith('load8') ? 1 : kind.startsWith('load16') ? 2 : 4;
  const at = range(memory.bytes, offset, size);
  if (size === 1) return memory.bytes[at]!;
  return size === 2
    ? memory.view.getUint16(at, kind.endsWith('le'))
    : memory.view.getUint32(at, kind.endsWith('le'));
}
function copyBytes(memory: ObservationMemory, offset: unknown, length: unknown): Uint8Array {
  const at = range(memory.bytes, offset, length);
  return memory.bytes.slice(at, at + Number(length));
}
function assertFalse(message: unknown): never {
  throw new Error(message === undefined ? 'Assertion failed' : String(message));
}
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}
const helpers = Object.freeze({
  checkBoolean,
  createBytes,
  createEnum,
  createRecord,
  equalValues,
  nonNull,
  readIndex,
  load,
  copyBytes,
  assertFalse,
  sameBytes,
});

class Unsupported extends Error {}

function reject(reason: string): never {
  throw new Unsupported(reason);
}

/** Emits one generated reader; every unsupported operation rejects the whole plan. */
class ReaderEmitter {
  private readonly bindings: unknown[] = [];
  private readonly bindingIds = new Map<unknown, number>();
  private readonly slots: PlannedSlot[] = [];
  private readonly nested: string[] = [];
  private readonly named = new Map<string, string>();
  private readonly visiting = new Set<string>();
  /** Result ids already defined by an emitted operation, for static legality checks. */
  private readonly results = new Set<number>();
  private readonly buffers: string[][] = [[]];
  private depth = 0;
  private serial = 0;

  constructor(private readonly target: ObservationTarget) {
    this.bindings.push(target);
    this.bindingIds.set(target, 0);
  }

  build(declaration: Extract<DeclarationIR, { kind: 'derived' }>, path: readonly string[]): string {
    const read = this.nestedDerived(declaration);
    // The observation source is the full static path: project every suffix field with
    // the same step the generic source walk performs, so the reader value, the
    // comparator type and the snapshot decision all describe the observed field.
    if (path.length === 1) {
      this.line(`return ${read}();`);
    } else {
      this.line(`let projected = ${read}();`);
      for (let index = 1; index < path.length; index++)
        this.line(`projected = projected[${this.ref(path[index]!)}];`);
      this.line('return projected;');
    }
    return [
      'function () {',
      ...this.nested.map((text) => text),
      ...this.buffers[0]!.map((text) => `  ${text}`),
      '}',
    ].join('\n');
  }

  slotsUsed(): readonly PlannedSlot[] {
    return this.slots;
  }

  bindingTable(): readonly unknown[] {
    return this.bindings;
  }

  private get lines(): string[] {
    return this.buffers[this.buffers.length - 1]!;
  }

  private line(text: string): void {
    this.lines.push(`${'  '.repeat(this.depth)}${text}`);
  }

  private block(header: string, body: () => void): void {
    this.line(`${header} {`);
    this.depth++;
    body();
    this.depth--;
    this.line('}');
  }

  private bind(value: unknown): number {
    const object = value !== null && typeof value === 'object';
    if (!object && Object.is(value, -0)) return this.bindings.push(value) - 1;
    const existing = this.bindingIds.get(value);
    if (existing !== undefined) return existing;
    const index = this.bindings.push(value) - 1;
    this.bindingIds.set(value, index);
    return index;
  }

  private ref(value: unknown): string {
    return `B[${this.bind(value)}]`;
  }

  private slot(slot: PlannedSlot): void {
    if (!this.slots.includes(slot)) this.slots.push(slot);
  }

  private nestedSource(name: string, params: readonly string[], body: () => void): string {
    this.buffers.push([]);
    const outer = this.depth;
    this.depth = 0;
    try {
      body();
    } finally {
      this.depth = outer;
    }
    const lines = this.buffers.pop()!;
    const text = [`function ${name}(${params.join(', ')}) {`, ...lines, '}'].join('\n');
    this.nested.push(text);
    return name;
  }

  private nestedDerived(declaration: Extract<DeclarationIR, { kind: 'derived' }>): string {
    const key = `derived:${declaration.name}`;
    const existing = this.named.get(key);
    if (existing) return existing;
    if (this.visiting.has(key)) reject(`recursive derived ${declaration.name}`);
    const name = `d${this.serial++}`;
    this.named.set(key, name);
    this.visiting.add(key);
    try {
      this.nestedSource(name, [], () => this.region(declaration.value.body, undefined));
    } finally {
      this.visiting.delete(key);
    }
    return name;
  }

  private nestedFunction(
    name: string,
    declaration: Extract<DeclarationIR, { kind: 'function' }>,
  ): string {
    const key = `function:${name}`;
    const existing = this.named.get(key);
    if (existing) return existing;
    if (this.visiting.has(key)) reject(`recursive pure call ${name}`);
    const id = `f${this.serial++}`;
    this.named.set(key, id);
    this.visiting.add(key);
    try {
      const params = declaration.params.map((_, index) => `p${index}`);
      this.nestedSource(id, params, () => {
        const outer = this.params;
        this.params = params;
        try {
          this.region(declaration.body, undefined);
        } finally {
          this.params = outer;
        }
      });
    } finally {
      this.visiting.delete(key);
    }
    return id;
  }

  private params: readonly string[] | undefined;

  private value(id: number): string {
    if (!this.results.has(id)) reject(`result ${id} is used before it is defined`);
    return `v${id}`;
  }

  private defineResult(id: number): string {
    this.results.add(id);
    return `v${id}`;
  }

  private region(region: RegionIR, output: { slot: string; label: string } | undefined): void {
    for (const operation of region.operations) this.operation(operation, output);
  }

  private valueRegion(region: ValueRegionIR, slot: string): void {
    const label = `s${this.serial++}`;
    this.line(`${label}: {`);
    this.depth++;
    this.region(region.body, { slot, label });
    this.depth--;
    this.line('}');
  }

  private argument(argument: ArgumentIR): string {
    if (argument.kind !== 'value') reject('resource argument');
    return this.value(argument.value);
  }

  private memoryRef(ref: MemoryRefIR, kind: string): ObservationMemory {
    if (ref.kind === 'parameter') reject(`parameterised memory ${kind}`);
    const memory = this.target.memoryPlan(ref.name);
    this.slot(memory.slot);
    return memory;
  }

  private pinRef(ref: PinRefIR, kind: string): { readonly sample: unknown } {
    if (ref.kind === 'parameter') reject(`parameterised pin ${kind}`);
    const pin = this.target.pins.get(ref.name);
    const slot = this.target.sampleResources.get(ref.name);
    if (!pin || !slot) reject(`unknown pin ${ref.name}`);
    this.slot(slot);
    return pin;
  }

  private operation(
    operation: OperationIR,
    output: { slot: string; label: string } | undefined,
  ): void {
    const assign = (expression: string): void => {
      if (!('result' in operation)) reject('resultless operation');
      this.line(`const ${this.defineResult(operation.result)} = ${expression};`);
    };
    const child = (region: RegionIR): void => this.region(region, output);
    switch (operation.kind) {
      case 'constant': {
        const constant = operation.constant;
        if (constant.kind === 'bytes')
          assign(
            `H.createBytes(${this.ref(Object.freeze(Array.from(createBytes(constant.value))))})`,
          );
        else if (constant.kind === 'enum')
          assign(this.ref(createEnum(constant.name, constant.member)));
        else if (constant.kind === 'record')
          assign(
            this.ref(
              createRecord(constant.fields.map((field) => [field.name, field.value] as const)),
            ),
          );
        else if (constant.kind === 'none') assign('null');
        else assign(this.ref(constant.value));
        break;
      }
      case 'read': {
        if (operation.resource === 'state') {
          const slot = this.target.stateResources.get(operation.name);
          if (!slot || !this.target.states.has(operation.name))
            reject(`unknown state ${operation.name}`);
          this.slot(slot);
          assign(`${this.ref(this.target.states)}.get(${this.ref(operation.name)})`);
        } else if (operation.resource === 'derived') {
          const declaration = this.target.declarations.get(operation.name);
          if (declaration?.kind !== 'derived') reject(`unknown derived ${operation.name}`);
          assign(`${this.nestedDerived(declaration)}()`);
        } else {
          assign(
            `${this.ref(this.target)}.read(${this.ref(operation.resource)}, ${this.ref(operation.name)})`,
          );
        }
        break;
      }
      case 'parameter': {
        const params = this.params;
        if (!params || operation.index >= params.length) reject('value parameter outside a call');
        assign(params[operation.index]!);
        break;
      }
      case 'unary': {
        const operator = unaryOperators[operation.operator];
        if (!operator) reject(`unsupported unary ${operation.operator}`);
        assign(`(${operator}${this.value(operation.value)})`);
        break;
      }
      case 'binary': {
        if (operation.operator === 'equal' || operation.operator === 'notEqual')
          assign(
            `${operation.operator === 'notEqual' ? '!' : ''}H.equalValues(${this.value(operation.left)}, ${this.value(operation.right)})`,
          );
        else {
          const operator = binaryOperators[operation.operator];
          if (!operator) reject(`unsupported binary ${operation.operator}`);
          assign(`(${this.value(operation.left)} ${operator} ${this.value(operation.right)})`);
        }
        break;
      }
      case 'numeric': {
        if (!numericBuiltins.has(operation.builtin))
          reject(`unsupported builtin ${operation.builtin}`);
        const receiver = numberBuiltins.has(operation.builtin) ? 'Number' : 'Math';
        assign(
          `${receiver}.${operation.builtin}(${operation.args.map((id) => this.value(id)).join(', ')})`,
        );
        break;
      }
      case 'record':
        assign(
          `H.createRecord([${operation.fields
            .map((field) => `[${this.ref(field.name)}, ${this.value(field.value)}]`)
            .join(', ')}])`,
        );
        break;
      case 'field':
        assign(`${this.value(operation.value)}[${this.ref(operation.field)}]`);
        break;
      case 'bytes':
        assign(`H.createBytes([${operation.elements.map((id) => this.value(id)).join(', ')}])`);
        break;
      case 'length':
        assign(`${this.value(operation.value)}.length`);
        break;
      case 'index':
        assign(`H.readIndex(${this.value(operation.value)}, ${this.value(operation.index)})`);
        break;
      case 'optional':
        assign(this.value(operation.value));
        break;
      case 'isNone':
        assign(`(${this.value(operation.value)} === null)`);
        break;
      case 'nonNull':
        assign(`H.nonNull(${this.value(operation.value)})`);
        break;
      case 'localRead':
        assign(`l${operation.local}`);
        break;
      case 'local':
        this.line(`let l${operation.local} = ${this.value(operation.initial)};`);
        break;
      case 'localWrite':
        this.line(`l${operation.local} = ${this.value(operation.value)};`);
        break;
      case 'memoryLength':
        assign(`${this.ref(this.memoryRef(operation.memory, operation.kind))}.bytes.length`);
        break;
      case 'load8':
      case 'load16le':
      case 'load16be':
      case 'load32le':
      case 'load32be':
        assign(
          `H.load(${this.ref(operation.kind)}, ${this.ref(this.memoryRef(operation.memory, operation.kind))}, ${this.value(operation.offset)})`,
        );
        break;
      case 'copyBytes': {
        const memory = this.memoryRef(operation.memory, operation.kind);
        assign(
          `H.copyBytes(${this.ref(memory)}, ${this.value(operation.offset)}, ${this.value(operation.length)})`,
        );
        break;
      }
      case 'readSample':
        assign(`${this.ref(this.pinRef(operation.pin, operation.kind))}.sample`);
        break;
      case 'callValue': {
        if (!operation.pure) reject('impure call');
        const declaration = this.target.declarations.get(operation.name);
        if (declaration?.kind !== 'function' || !declaration.pure)
          reject(`unknown pure function ${operation.name}`);
        assign(
          `${this.nestedFunction(operation.name, declaration)}(${operation.args
            .map((argument) => this.argument(argument))
            .join(', ')})`,
        );
        break;
      }
      case 'if':
        this.block(`if (H.checkBoolean(${this.value(operation.condition)}))`, () =>
          child(operation.yes),
        );
        if (operation.no) this.block('else', () => child(operation.no!));
        break;
      case 'match': {
        operation.arms.forEach((arm, index) => {
          const pattern = arm.pattern;
          const constant =
            pattern.kind === 'none'
              ? null
              : pattern.kind === 'enum'
                ? createEnum(pattern.name, pattern.member)
                : pattern.value;
          this.block(
            `${index ? 'else if' : 'if'} (H.equalValues(${this.value(operation.value)}, ${this.ref(constant)}))`,
            () => child(arm.body),
          );
        });
        if (operation.otherwise)
          this.block(operation.arms.length ? 'else' : '', () => child(operation.otherwise!));
        break;
      }
      case 'while':
        this.block('while (true)', () => {
          const slot = `s${this.serial++}`;
          this.line(`let ${slot};`);
          this.valueRegion(operation.test, slot);
          this.line(`if (!H.checkBoolean(${slot})) break;`);
          this.block('', () => child(operation.body));
        });
        break;
      case 'loop':
        this.block('while (true)', () => child(operation.body));
        break;
      case 'and':
      case 'or': {
        const slot = this.defineResult(operation.result);
        this.line(`let ${slot} = H.checkBoolean(${this.value(operation.left)});`);
        this.block(`if (${operation.kind === 'or' ? '!' : ''}${slot})`, () => {
          this.valueRegion(operation.right, slot);
          this.line(`${slot} = H.checkBoolean(${slot});`);
        });
        break;
      }
      case 'select': {
        const slot = this.defineResult(operation.result);
        this.line(`let ${slot};`);
        this.block(`if (H.checkBoolean(${this.value(operation.condition)}))`, () =>
          this.valueRegion(operation.yes, slot),
        );
        this.block('else', () => this.valueRegion(operation.no, slot));
        break;
      }
      case 'assert':
        this.block(`if (!H.checkBoolean(${this.value(operation.condition)}))`, () => {
          if (operation.message) {
            const slot = `s${this.serial++}`;
            this.line(`let ${slot};`);
            this.valueRegion(operation.message, slot);
            this.line(`H.assertFalse(${slot});`);
          } else this.line('H.assertFalse(undefined);');
        });
        break;
      case 'return':
        this.line('return;');
        break;
      case 'returnValue':
        this.line(`return ${this.value(operation.value)};`);
        break;
      case 'break':
        this.line('break;');
        break;
      case 'continue':
        this.line('continue;');
        break;
      case 'yield':
        if (!output) reject('yield outside a value region');
        this.line(`${output.slot} = ${this.value(operation.value)};`);
        this.line(`break ${output.label};`);
        break;
      default: {
        const kind = (operation as { kind?: unknown }).kind;
        reject(`unsupported operation ${String(kind)}`);
      }
    }
  }
}

interface SemanticType {
  readonly type: ValueTypeIR | undefined;
}

function fieldType(
  declarations: ReadonlyMap<string, DeclarationIR>,
  type: ValueTypeIR | undefined,
  field: string,
): ValueTypeIR | undefined {
  if (!type) return undefined;
  if (type.kind === 'optional') return undefined;
  if (type.kind === 'record') {
    const declaration = declarations.get(type.name);
    if (declaration?.kind !== 'record') return undefined;
    const entry = declaration.fields.find((candidate) => candidate.name === field);
    return entry ? { kind: entry.type } : undefined;
  }
  if (type.kind === 'sample') {
    if (field === 'voltage') return { kind: 'optional', inner: { kind: 'number' } };
    if (field === 'level' || field === 'status') return { kind: 'enum', name: 'Logic' };
  }
  return undefined;
}

function resolvePathType(
  declarations: ReadonlyMap<string, DeclarationIR>,
  type: ValueTypeIR,
  path: readonly string[],
): SemanticType {
  let current: ValueTypeIR | undefined = type;
  for (let index = 1; index < path.length; index++)
    current = fieldType(declarations, current, path[index]!);
  return { type: current };
}

function primitive(type: ValueTypeIR | undefined): boolean {
  if (!type) return false;
  if (type.kind === 'optional') return primitive(type.inner);
  return ['number', 'bool', 'string', 'enum'].includes(type.kind);
}

/**
 * Stable observation comparison for the declared source type. Numbers compare NaN as
 * equal and treat positive and negative zero as equal; bytes compare length and
 * content; records and samples compare their declared fields recursively; nullables
 * compare none first. Language equality is deliberately not reused here.
 */
function comparison(
  declarations: ReadonlyMap<string, DeclarationIR>,
  type: ValueTypeIR | undefined,
  left: string,
  right: string,
): string | undefined {
  if (!type) return undefined;
  switch (type.kind) {
    case 'number':
      return `(${left} === ${right} || (${left} !== ${left} && ${right} !== ${right}))`;
    case 'bool':
    case 'string':
    case 'enum':
      return `(${left} === ${right})`;
    case 'bytes':
      return `(${left} === ${right} || (${left} !== null && ${right} !== null && typeof ${left} === "object" && typeof ${right} === "object" && ${left}.length === ${right}.length && H.sameBytes(${left}, ${right})))`;
    case 'sample': {
      const fields = ['voltage', 'level', 'status'].map((field) =>
        comparison(
          declarations,
          fieldType(declarations, type, field),
          `${left}[${JSON.stringify(field)}]`,
          `${right}[${JSON.stringify(field)}]`,
        ),
      );
      if (fields.some((field) => field === undefined)) return undefined;
      return `(${left} === ${right} || (${left} !== null && ${right} !== null && typeof ${left} === "object" && typeof ${right} === "object" && ${fields.join(' && ')}))`;
    }
    case 'record': {
      const declaration = declarations.get(type.name);
      if (declaration?.kind !== 'record' || !declaration.fields.length) return undefined;
      const fields = declaration.fields.map((field) =>
        comparison(
          declarations,
          { kind: field.type },
          `${left}[${JSON.stringify(field.name)}]`,
          `${right}[${JSON.stringify(field.name)}]`,
        ),
      );
      if (fields.some((field) => field === undefined)) return undefined;
      return `(${left} === ${right} || (${left} !== null && ${right} !== null && typeof ${left} === "object" && typeof ${right} === "object" && ${fields.join(' && ')}))`;
    }
    case 'optional': {
      const inner = comparison(declarations, type.inner, left, right);
      if (inner === undefined) return undefined;
      return `(${left} === ${right} || (${left} === null ? ${right} === null : (${right} !== null && ${inner})))`;
    }
    default:
      return undefined;
  }
}

/** Bind a source path to one generated reader and one generated comparator. */
export function compileObservation(
  target: ObservationTarget,
  key: string,
  path: readonly string[],
): ObservationCompilation {
  const declaration = target.declarations.get(path[0]!);
  if (declaration?.kind !== 'derived')
    return { ok: false, reason: 'source root is not a derived declaration' };
  const { type } = resolvePathType(target.declarations, declaration.type, path);
  if (type === undefined) return { ok: false, reason: 'source field type is not resolvable' };
  if (type.kind === 'intent')
    return { ok: false, reason: 'intent has no stable content comparison' };
  try {
    const emitter = new ReaderEmitter(target);
    const source = emitter.build(declaration, path);
    const factory = new Function('B', 'H', `"use strict"; return (${source});`) as (
      bindings: readonly unknown[],
      helpers: unknown,
    ) => () => unknown;
    const evaluate = factory(emitter.bindingTable(), helpers);
    const compare = comparison(target.declarations, type, 'a', 'b');
    const comparisonSource = `function (a, b) { return ${compare ?? 'H.same(a, b)'}; }`;
    const comparer = new Function('H', `"use strict"; return (${comparisonSource});`)({
      ...helpers,
      same,
    }) as (previous: unknown, current: unknown) => boolean;
    return {
      ok: true,
      plan: {
        key,
        path: [...path],
        source,
        comparison: comparisonSource,
        slots: emitter.slotsUsed(),
        evaluate,
        equals: comparer,
        needsSnapshot: !primitive(type),
      },
    };
  } catch (cause) {
    return {
      ok: false,
      reason:
        cause instanceof Unsupported
          ? cause.message
          : `unexpected code generation failure: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}
