import type {
  ArgumentIR,
  BinaryOperator,
  ComputationIR,
  ConstantIR,
  InputPath,
  MemoryRefIR,
  OperationIR,
  PinRefIR,
  RegionIR,
  SourceInfo,
  ValueRegionIR,
  ValueTypeIR,
} from '@mica-js/device-model';
import type {
  Artifact,
  CompiledBody,
  CompiledComputation,
  CompileOptions,
  GeneratedRange,
  GeneratedPosition,
  ResumePoint,
} from './types.js';
import { createBytes, createEnum, createRecord, runtimeHelpers } from './values.js';
import { analyzeBody } from './analysis.js';
import type { BodyAnalysis } from './analysis.js';
import { layoutMetadata } from './metadata.js';
import type { GeneratedTemporary } from './metadata.js';

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
const numericBuiltins = new Set([
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
const numberBuiltins = new Set(['isNaN', 'isFinite', 'isInteger', 'isSafeInteger']);

/** Inputs must already have passed device-model validation and contextual binding. */
export function compileBody(region: RegionIR, options: CompileOptions = {}): CompiledBody {
  return new Emitter(analyzeBody(region, options, false), options, false).compileExecutable(region);
}

export function compileBodyArtifact(
  region: RegionIR,
  options: CompileOptions = {},
): Artifact<CompiledBody> {
  return new Emitter(analyzeBody(region, options), options).compile(region);
}

export function compileComputation(
  computation: ComputationIR,
  options: CompileOptions = {},
): CompiledComputation {
  return completeComputation(compileBody(computation.body, options));
}

export function compileComputationArtifact(
  computation: ComputationIR,
  options: CompileOptions = {},
): Artifact<CompiledComputation> {
  const body = compileBodyArtifact(
    computation.source && !computation.body.source
      ? { ...computation.body, source: computation.source }
      : computation.body,
    options,
  );
  return Object.freeze(
    Object.defineProperties(
      {},
      {
        ...Object.getOwnPropertyDescriptors(body),
        execute: { value: completeComputation(body.execute), enumerable: true },
      },
    ),
  ) as Artifact<CompiledComputation>;
}

function completeComputation(body: CompiledBody): CompiledComputation {
  return (host) => {
    const generator = body(host);
    const result = generator.next();
    if (!result.done) {
      generator.return(undefined);
      throw new TypeError(`Computation unexpectedly suspended with ${result.value.kind}`);
    }
    return result.value;
  };
}

function name(prefix: string, id: number): string {
  if (!Number.isSafeInteger(id) || id < 0)
    throw new TypeError('IR identifiers must be nonnegative safe integers');
  return `${prefix}${id}`;
}
const value = (id: number): string => name('v', id);
const local = (id: number): string => name('l', id);
const quote = (text: string): string => JSON.stringify(text);

function snapshotSource(source: SourceInfo): SourceInfo {
  if (source.uri !== undefined) {
    return Object.freeze({
      ...source,
      range: Object.freeze({
        start: Object.freeze({ ...source.range.start }),
        end: Object.freeze({ ...source.range.end }),
      }),
    });
  }
  return Object.freeze({ ...source });
}

class Emitter {
  constructor(
    private readonly analysis: BodyAnalysis,
    private readonly options: CompileOptions,
    private readonly captureMetadata = true,
  ) {}

  private readonly ranges = new Map<number, GeneratedRange>();
  private readonly temporaries: GeneratedTemporary[] = [];
  private readonly lines: string[] = [];
  private readonly constants: unknown[] = [];
  private readonly primitiveConstants = new Map<unknown, number>();
  private readonly negativeZero = Symbol('negative zero');
  private readonly positions: GeneratedPosition[] = [];
  private readonly resume: ResumePoint[] = [];
  private readonly types = new Map<number, ValueTypeIR>();
  private indent = 0;
  private serial = 0;

  compileExecutable(region: RegionIR): CompiledBody {
    return this.generate(region).execute;
  }

  compile(region: RegionIR): Artifact<CompiledBody> {
    const generated = this.generate(region);
    const analysis = this.analysis;
    let layout: ReturnType<typeof layoutMetadata> | undefined;
    const metadata = (): ReturnType<typeof layoutMetadata> =>
      (layout ??= layoutMetadata(
        analysis,
        this.ranges,
        this.resume,
        generated.source,
        this.options,
        this.temporaries,
      ));
    return Object.freeze({
      ...generated,
      positions: Object.freeze(this.positions.slice()),
      resume: Object.freeze(this.resume.slice()),
      optimizations: analysis.optimizations,
      get effects() {
        return analysis.effects;
      },
      get mir() {
        return analysis.graph;
      },
      get dependencies() {
        return metadata().dependencies;
      },
      get sourceMap() {
        return metadata().sourceMap;
      },
      get frameLayout() {
        return metadata().frameLayout;
      },
      get resumeMap() {
        return metadata().resumeMap;
      },
      get exitMap() {
        return metadata().exitMap;
      },
    });
  }

  private generate(region: RegionIR): {
    execute: CompiledBody;
    source: string;
    constants: readonly unknown[];
  } {
    this.line('function* compiledBody(host, args = [], reaction) {');
    this.indent++;
    this.region(region, []);
    this.indent--;
    this.line('}');
    const source = this.lines.join('\n');
    const constants = Object.freeze(this.constants.slice());
    // Only trusted templates enter Function; model strings and numbers are captured data.
    const factory = new Function('C', 'H', `"use strict"; return (${source});`) as (
      constants: readonly unknown[],
      helpers: typeof runtimeHelpers,
    ) => CompiledBody;
    return { execute: factory(constants, runtimeHelpers), source, constants };
  }

  private line(text: string): void {
    this.lines.push(`${'  '.repeat(this.indent)}${text}`);
  }

  private block(header: string, body: () => void): void {
    this.line(`${header} {`);
    this.indent++;
    body();
    this.indent--;
    this.line('}');
  }

  private capture(input: unknown): string {
    const primitive = input === null || typeof input !== 'object';
    const key = Object.is(input, -0) ? this.negativeZero : input;
    const existing = primitive ? this.primitiveConstants.get(key) : undefined;
    if (existing !== undefined) return `C[${existing}]`;
    const index = this.constants.push(input) - 1;
    if (primitive) this.primitiveConstants.set(key, index);
    return `C[${index}]`;
  }

  private ref(ref: PinRefIR | MemoryRefIR): string {
    return ref.kind === 'parameter' ? `args[${ref.index}]` : this.capture(ref.name);
  }

  private argument(argument: ArgumentIR): string {
    return argument.kind === 'value' ? value(argument.value) : this.ref(argument);
  }

  private constant(constant: ConstantIR): unknown {
    switch (constant.kind) {
      case 'number':
      case 'bool':
      case 'string':
        return constant.value;
      case 'none':
        return null;
      case 'enum':
        return createEnum(constant.name, constant.member);
      case 'bytes':
        return Object.freeze(Array.from(createBytes(constant.value)));
      case 'record':
        return createRecord(constant.fields.map((field) => [field.name, field.value]));
      default:
        return exhaustive(constant);
    }
  }

  private position(operation: OperationIR, path: InputPath): GeneratedPosition {
    const position: GeneratedPosition = Object.freeze({
      path: Object.freeze([...path]),
      kind: operation.kind,
      line: this.lines.length + 1,
      column: this.indent * 2 + 1,
      ...(this.analysis.byOperation.get(operation)?.source
        ? { source: snapshotSource(this.analysis.byOperation.get(operation)!.source!) }
        : {}),
    });
    this.positions.push(position);
    return position;
  }

  private suspension(position: GeneratedPosition | undefined, delegated = false): void {
    if (!position) return;
    this.resume.push(
      Object.freeze({
        ...position,
        line: this.lines.length + 1,
        column: this.indent * 2 + 1,
        id: this.resume.length,
        delegated,
      }),
    );
  }

  private region(
    region: RegionIR,
    path: InputPath,
    output?: { slot: string; label: string },
  ): void {
    region.operations.forEach((operation, index) => {
      this.operation(operation, [...path, 'operations', index], output);
    });
  }

  private valueRegion(region: ValueRegionIR, slot: string, path: InputPath): void {
    if (this.captureMetadata && !slot.startsWith('v')) {
      const key = JSON.stringify([...path, 'body']);
      const owner = this.analysis.nodes.find((node) =>
        [...node.children.values()].some((child) => JSON.stringify(child.path) === key),
      )!;
      const nested = [...owner.children.values()].find(
        (child) => JSON.stringify(child.path) === key,
      )!;
      this.temporaries.push({
        key: `region:${nested.id}`,
        name: slot,
        region: owner.region,
        definition: owner.position,
        type: region.type,
      });
    }
    const label = `valueRegion${this.serial++}`;
    this.block(`${label}:`, () => this.region(region.body, [...path, 'body'], { slot, label }));
  }

  private equality(left: number, right: number): string {
    let type = this.types.get(left);
    if (type?.kind === 'optional') type = type.inner;
    if (type && (type.kind === 'number' || type.kind === 'string' || type.kind === 'bool')) {
      return `(${value(left)} === ${value(right)})`;
    }
    return `H.equalValues(${value(left)}, ${value(right)})`;
  }

  private operation(
    operation: OperationIR,
    path: InputPath,
    output?: { slot: string; label: string },
  ): void {
    if ('result' in operation) this.types.set(operation.result, operation.type);
    const node = this.analysis.byOperation.get(operation)!;
    if (this.analysis.eliminated.has(node.position)) return;
    const position = this.captureMetadata ? this.position(operation, path) : undefined;
    try {
      if ('result' in operation && this.analysis.folded.has(node.position)) {
        this.line(
          `const ${value(operation.result)} = ${this.capture(this.analysis.folded.get(node.position))};`,
        );
      } else this.emitOperation(operation, path, position, output);
    } finally {
      if (position)
        this.ranges.set(
          node.position,
          Object.freeze({
            start: Object.freeze({ line: position.line, column: position.column }),
            end: Object.freeze({
              line: this.lines.length,
              column: this.lines[this.lines.length - 1]!.length + 1,
            }),
          }),
        );
    }
  }

  private emitOperation(
    operation: OperationIR,
    path: InputPath,
    position: GeneratedPosition | undefined,
    output?: { slot: string; label: string },
  ): void {
    const assign = (expression: string): void => {
      if (!('result' in operation)) throw new TypeError('Expected a result-producing operation');
      this.line(`const ${value(operation.result)} = ${expression};`);
    };
    const child = (region: RegionIR, key: string): void =>
      this.region(region, [...path, key], output);
    switch (operation.kind) {
      case 'constant': {
        const captured = this.capture(this.constant(operation.constant));
        assign(operation.constant.kind === 'bytes' ? `H.createBytes(${captured})` : captured);
        break;
      }
      case 'read':
        assign(`host.read(${this.capture(operation.resource)}, ${this.capture(operation.name)})`);
        break;
      case 'parameter':
        assign(`args[${operation.index}]`);
        break;
      case 'reactionValue':
        assign(`H.reactionValue(reaction, ${quote(operation.binding)})`);
        break;
      case 'reactionCapture':
        assign(`H.reactionCapture(reaction, ${operation.index})`);
        break;
      case 'unary': {
        const operators = { positive: '+', negate: '-', not: '!', bitNot: '~' };
        const operator = operators[operation.operator];
        if (!operator) throw new TypeError('Unknown unary operator');
        assign(`(${operator}${value(operation.value)})`);
        break;
      }
      case 'binary': {
        if (operation.operator === 'equal' || operation.operator === 'notEqual') {
          assign(
            `${operation.operator === 'notEqual' ? '!' : ''}${this.equality(operation.left, operation.right)}`,
          );
        } else {
          const operator = binaryOperators[operation.operator];
          if (!operator) throw new TypeError('Unknown binary operator');
          assign(`(${value(operation.left)} ${operator} ${value(operation.right)})`);
        }
        break;
      }
      case 'numeric': {
        if (!numericBuiltins.has(operation.builtin)) throw new TypeError('Unknown numeric builtin');
        const receiver = numberBuiltins.has(operation.builtin) ? 'Number' : 'Math';
        assign(`${receiver}.${operation.builtin}(${operation.args.map(value).join(', ')})`);
        break;
      }
      case 'record':
        assign(
          `H.createRecord([${operation.fields.map((field) => `[${this.capture(field.name)}, ${value(field.value)}]`).join(', ')}])`,
        );
        break;
      case 'field':
        assign(`${value(operation.value)}[${this.capture(operation.field)}]`);
        break;
      case 'bytes':
        assign(`H.createBytes([${operation.elements.map(value).join(', ')}])`);
        break;
      case 'length':
        assign(`${value(operation.value)}.length`);
        break;
      case 'index':
        assign(`H.readIndex(${value(operation.value)}, ${value(operation.index)})`);
        break;
      case 'optional':
        assign(value(operation.value));
        break;
      case 'isNone':
        assign(`(${value(operation.value)} === null)`);
        break;
      case 'nonNull':
        assign(`H.nonNull(${value(operation.value)})`);
        break;
      case 'localRead':
        assign(local(operation.local));
        break;
      case 'local':
        this.line(`let ${local(operation.local)} = ${value(operation.initial)};`);
        break;
      case 'localWrite':
        this.line(`${local(operation.local)} = ${value(operation.value)};`);
        break;
      case 'write':
        this.line(`host.write(${this.capture(operation.name)}, ${value(operation.value)});`);
        break;
      case 'memoryLength':
        assign(`host.memoryLength(${this.ref(operation.memory)})`);
        break;
      case 'load8':
      case 'load16le':
      case 'load16be':
      case 'load32le':
      case 'load32be':
        assign(
          `host.load(${quote(operation.kind)}, ${this.ref(operation.memory)}, ${value(operation.offset)})`,
        );
        break;
      case 'store8':
      case 'store16le':
      case 'store16be':
      case 'store32le':
      case 'store32be':
        this.line(
          `host.store(${quote(operation.kind)}, ${this.ref(operation.memory)}, ${value(operation.offset)}, ${value(operation.value)});`,
        );
        break;
      case 'copyBytes':
        assign(
          `host.copyBytes(${this.ref(operation.memory)}, ${value(operation.offset)}, ${value(operation.length)})`,
        );
        break;
      case 'readSample':
        assign(`host.sample(${this.ref(operation.pin)})`);
        break;
      case 'resistor':
        assign(`host.resistor(${this.ref(operation.to)}, ${value(operation.resistance)})`);
        break;
      case 'combineIntents':
        assign(`H.combineIntents([${operation.values.map(value).join(', ')}])`);
        break;
      case 'refEqual':
        assign(`(${this.ref(operation.left)} === ${this.ref(operation.right)})`);
        break;
      case 'writeIntent':
        this.line(`host.intent(${this.ref(operation.pin)}, ${value(operation.value)});`);
        break;
      case 'call':
      case 'callValue': {
        this.suspension(position, true);
        const slot = `call${this.serial++}`;
        this.line(
          `const ${slot} = yield* H.delegate(host.call(${this.capture(operation.name)}, [${operation.args.map((argument) => this.argument(argument)).join(', ')}]));`,
        );
        this.line(`if (${slot} === H.terminated) return;`);
        if (operation.kind === 'callValue') assign(slot);
        break;
      }
      case 'send':
        this.line(`host.send(${this.capture(operation.channel)}, ${value(operation.value)});`);
        break;
      case 'notify':
        this.line(`host.notify(${this.capture(operation.notification)});`);
        break;
      case 'receive':
        this.suspension(position);
        assign(`yield { kind: "receive", channel: ${this.capture(operation.channel)} }`);
        break;
      case 'now':
        assign('host.now()');
        break;
      case 'random':
        assign('host.random()');
        break;
      case 'if':
        this.block(`if (H.checkBoolean(${value(operation.condition)}))`, () =>
          child(operation.yes, 'yes'),
        );
        if (operation.no) this.block('else', () => child(operation.no!, 'no'));
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
            `${index ? 'else if' : 'if'} (H.equalValues(${value(operation.value)}, ${this.capture(constant)}))`,
            () => {
              this.region(arm.body, [...path, 'arms', index, 'body'], output);
            },
          );
        });
        if (operation.otherwise) {
          this.block(operation.arms.length ? 'else' : '', () =>
            child(operation.otherwise!, 'otherwise'),
          );
        }
        break;
      }
      case 'while':
        this.block('while (true)', () => {
          const slot = `condition${this.serial++}`;
          this.line(`let ${slot};`);
          this.valueRegion(operation.test, slot, [...path, 'test']);
          this.line(`if (!H.checkBoolean(${slot})) break;`);
          this.block('', () => child(operation.body, 'body'));
        });
        break;
      case 'loop':
        this.block('while (true)', () => child(operation.body, 'body'));
        break;
      case 'and':
      case 'or': {
        const slot = value(operation.result);
        this.line(`let ${slot} = H.checkBoolean(${value(operation.left)});`);
        this.block(`if (${operation.kind === 'or' ? '!' : ''}${slot})`, () => {
          this.valueRegion(operation.right, slot, [...path, 'right']);
          this.line(`${slot} = H.checkBoolean(${slot});`);
        });
        break;
      }
      case 'select': {
        const slot = value(operation.result);
        this.line(`let ${slot};`);
        this.block(`if (H.checkBoolean(${value(operation.condition)}))`, () =>
          this.valueRegion(operation.yes, slot, [...path, 'yes']),
        );
        this.block('else', () => this.valueRegion(operation.no, slot, [...path, 'no']));
        break;
      }
      case 'assert':
        this.block(`if (!H.checkBoolean(${value(operation.condition)}))`, () => {
          if (operation.message) {
            const slot = `message${this.serial++}`;
            this.line(`let ${slot};`);
            this.valueRegion(operation.message, slot, [...path, 'message']);
            this.line(`host.assert(false, ${slot});`);
          } else this.line('host.assert(false, undefined);');
        });
        break;
      case 'wait':
      case 'elapse': {
        const duration = `duration${this.serial++}`;
        this.line(`const ${duration} = H.checkDuration(${value(operation.duration)});`);
        this.suspension(position);
        const signal = `yield { kind: ${quote(operation.kind === 'wait' ? 'ticks' : 'elapse')}, duration: ${duration} };`;
        if (operation.kind === 'elapse') this.line(`if (${duration} !== 0) ${signal}`);
        else this.line(signal);
        break;
      }
      case 'waitUntil':
        this.suspension(position);
        this.line(`yield { kind: "waitUntil", predicate: ${this.capture(operation.predicate)} };`);
        this.line('return;');
        break;
      case 'redirect':
        this.suspension(position);
        this.line(
          `yield { kind: "redirect", pc: H.checkPc(${value(operation.target)}), delay: H.checkDuration(${value(operation.delay)}) };`,
        );
        this.line('return;');
        break;
      case 'stop':
        this.suspension(position);
        this.line('yield { kind: "stop" };');
        this.line('return;');
        break;
      case 'return':
        this.line('return;');
        break;
      case 'returnValue':
        this.line(`return ${value(operation.value)};`);
        break;
      case 'break':
        this.line('break;');
        break;
      case 'continue':
        this.line('continue;');
        break;
      case 'yield':
        if (!output) throw new TypeError('Value-region yield is outside a value region');
        this.line(`${output.slot} = ${value(operation.value)};`);
        this.line(`break ${output.label};`);
        break;
      default:
        exhaustive(operation);
    }
  }
}

function exhaustive(value: never): never {
  throw new TypeError(`Unsupported IR operation: ${String((value as { kind?: unknown }).kind)}`);
}
