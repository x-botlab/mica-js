import type {
  InputPath,
  OperationIR,
  RegionIR,
  SourceInfo,
  ValueTypeIR,
} from '@mica-js/device-model';
import type {
  BasicBlock,
  CompileOptions,
  ControlEdge,
  EdgeKind,
  EffectMetadata,
  InternalGraph,
  InternalAttribute,
  InternalRegion,
  OperationEffects,
  OptimizationMetadata,
} from './types.js';

export type Primitive = number | boolean | string | null;
interface Block {
  id: number;
  region: number;
  role: BasicBlock['role'];
  position: number | null;
  uses: Set<string>;
  definitions: Set<string>;
  liveIn: Set<string>;
  liveOut: Set<string>;
}
interface Region {
  id: number;
  parent: number | null;
  path: InputPath;
  entry: number;
  exit: number;
  nodes: Node[];
}
export interface Node {
  operation: OperationIR;
  position: number;
  block: number;
  region: number;
  path: InputPath;
  source?: SourceInfo;
  inputs: readonly number[];
  effects: OperationEffects;
  children: Map<string, Region>;
  definitionBlock: number;
  resumeBlock?: number;
  completionBlock?: number;
  failureBlock?: number;
}
interface Context {
  breakTo?: number;
  continueTo?: number;
  yieldTo?: number;
}
export interface BodyAnalysis {
  nodes: readonly Node[];
  byOperation: ReadonlyMap<OperationIR, Node>;
  graph: InternalGraph;
  folded: ReadonlyMap<number, Primitive>;
  constants: ReadonlyMap<number, Primitive>;
  eliminated: ReadonlySet<number>;
  effects: EffectMetadata;
  resources: readonly string[];
  optimizations: OptimizationMetadata;
}

export function sourceSnapshot(source: SourceInfo): SourceInfo {
  return source.uri === undefined
    ? Object.freeze({ ...source })
    : Object.freeze({
        ...source,
        range: Object.freeze({
          start: Object.freeze({ ...source.range.start }),
          end: Object.freeze({ ...source.range.end }),
        }),
      });
}
export function typeSnapshot(type: ValueTypeIR): ValueTypeIR {
  return type.kind === 'optional'
    ? Object.freeze({ ...type, inner: Object.freeze({ ...type.inner }) })
    : Object.freeze({ ...type });
}

export function inputs(op: OperationIR): readonly number[] {
  switch (op.kind) {
    case 'unary':
    case 'field':
    case 'length':
    case 'optional':
    case 'isNone':
    case 'nonNull':
    case 'localWrite':
    case 'write':
    case 'writeIntent':
    case 'send':
    case 'match':
    case 'returnValue':
    case 'yield':
      return [op.value];
    case 'binary':
      return [op.left, op.right];
    case 'numeric':
      return [...op.args];
    case 'record':
      return op.fields.map((field) => field.value);
    case 'bytes':
      return [...op.elements];
    case 'index':
      return [op.value, op.index];
    case 'local':
      return [op.initial];
    case 'load8':
    case 'load16le':
    case 'load16be':
    case 'load32le':
    case 'load32be':
      return [op.offset];
    case 'store8':
    case 'store16le':
    case 'store16be':
    case 'store32le':
    case 'store32be':
      return [op.offset, op.value];
    case 'copyBytes':
      return [op.offset, op.length];
    case 'resistor':
      return [op.resistance];
    case 'combineIntents':
      return [...op.values];
    case 'call':
    case 'callValue':
      return op.args.flatMap((arg) => (arg.kind === 'value' ? [arg.value] : []));
    case 'if':
    case 'select':
    case 'assert':
      return [op.condition];
    case 'and':
    case 'or':
      return [op.left];
    case 'wait':
    case 'elapse':
      return [op.duration];
    case 'redirect':
      return [op.target, op.delay];
    default:
      return [];
  }
}

export function argumentUses(op: OperationIR): readonly string[] {
  const uses: string[] = [];
  const ref = (input: { kind: string; index?: number }): void => {
    if (input.kind === 'parameter') uses.push(`argument:${input.index}`);
  };
  if ('memory' in op) ref(op.memory);
  if ('pin' in op) ref(op.pin);
  if (op.kind === 'resistor') ref(op.to);
  if (op.kind === 'refEqual') {
    ref(op.left);
    ref(op.right);
  }
  if (op.kind === 'call' || op.kind === 'callValue')
    op.args.forEach((arg) => {
      if (arg.kind !== 'value') ref(arg);
    });
  if (op.kind === 'parameter') uses.push(`argument:${op.index}`);
  if (op.kind === 'reactionValue' || op.kind === 'reactionCapture') uses.push('reaction');
  return uses;
}

function resourceName(ref: { kind: string; name?: string; index?: number }): string {
  return ref.kind === 'parameter' ? `$${ref.index}` : ref.name!;
}
function effects(op: OperationIR): OperationEffects {
  const reads: string[] = [],
    writes: string[] = [],
    calls: string[] = [];
  const call = op.kind === 'call' || op.kind === 'callValue';
  const maySuspend =
    call || ['wait', 'elapse', 'receive', 'waitUntil', 'redirect'].includes(op.kind);
  const mayThrow =
    call ||
    [
      'read',
      'write',
      'readSample',
      'writeIntent',
      'resistor',
      'bytes',
      'index',
      'nonNull',
      'field',
      'length',
      'memoryLength',
      'copyBytes',
      'send',
      'receive',
      'notify',
      'now',
      'random',
      'reactionValue',
      'reactionCapture',
      'if',
      'select',
      'and',
      'or',
      'assert',
      'wait',
      'elapse',
      'redirect',
    ].includes(op.kind) ||
    op.kind.startsWith('load') ||
    op.kind.startsWith('store');
  if (op.kind === 'read') reads.push(`${op.resource}:${op.name}`);
  if (op.kind === 'write') writes.push(`state:${op.name}`);
  if ('memory' in op)
    (op.kind.startsWith('store') ? writes : reads).push(`memory:${resourceName(op.memory)}`);
  if (op.kind === 'readSample') reads.push(`pin:${resourceName(op.pin)}`);
  if (op.kind === 'writeIntent') writes.push(`pin:${resourceName(op.pin)}`);
  if (op.kind === 'send') writes.push(`channel:${op.channel}`);
  if (op.kind === 'receive') {
    reads.push(`channel:${op.channel}`);
    writes.push(`channel:${op.channel}`);
  }
  if (op.kind === 'notify') writes.push(`notification:${op.notification}`);
  if (op.kind === 'waitUntil') {
    reads.push('*');
    calls.push(op.predicate);
  }
  if (call) {
    calls.push(op.name);
    reads.push('*');
    writes.push('*');
  }
  return Object.freeze({
    reads: Object.freeze(reads),
    writes: Object.freeze(writes),
    calls: Object.freeze(calls),
    operations: Object.freeze([op.kind]),
    maySuspend,
    mayThrow,
    mayRedirect: call || op.kind === 'redirect',
    mayStop: call || op.kind === 'stop',
    timeDependent: call || op.kind === 'now',
    random: call || op.kind === 'random',
  });
}

function fold(
  op: OperationIR,
  known: ReadonlyMap<number, Primitive>,
): { value: Primitive } | undefined {
  const values = inputs(op);
  if (values.some((id) => !known.has(id))) return undefined;
  const a = known.get(values[0]!)!,
    b = known.get(values[1]!)!;
  switch (op.kind) {
    case 'constant': {
      const c = op.constant;
      if (c.kind === 'none') return { value: null };
      if (c.kind === 'enum') return { value: c.member };
      if (c.kind === 'number' || c.kind === 'bool' || c.kind === 'string')
        return { value: c.value };
      return undefined;
    }
    case 'optional':
      return { value: a };
    case 'isNone':
      return { value: a === null };
    case 'nonNull':
      return a === null ? undefined : { value: a };
    case 'unary':
      switch (op.operator) {
        case 'positive':
          return { value: +(a as number) };
        case 'negate':
          return { value: -(a as number) };
        case 'not':
          return { value: !a };
        case 'bitNot':
          return { value: ~(a as number) };
      }
      break;
    case 'binary': {
      const x = a as number,
        y = b as number;
      switch (op.operator) {
        case 'add':
          return { value: x + y };
        case 'subtract':
          return { value: x - y };
        case 'multiply':
          return { value: x * y };
        case 'divide':
          return { value: x / y };
        case 'remainder':
          return { value: x % y };
        case 'power':
          return { value: x ** y };
        case 'lessThan':
          return { value: x < y };
        case 'lessThanOrEqual':
          return { value: x <= y };
        case 'greaterThan':
          return { value: x > y };
        case 'greaterThanOrEqual':
          return { value: x >= y };
        case 'equal':
          return { value: a === b };
        case 'notEqual':
          return { value: a !== b };
        case 'concat':
          return { value: (a as string) + (b as string) };
        case 'bitAnd':
          return { value: x & y };
        case 'bitOr':
          return { value: x | y };
        case 'bitXor':
          return { value: x ^ y };
        case 'shiftLeft':
          return { value: x << y };
        case 'shiftRight':
          return { value: x >> y };
        case 'shiftRightUnsigned':
          return { value: x >>> y };
      }
      break;
    }
    case 'numeric': {
      const args = op.args.map((id) => known.get(id) as number);
      if (op.builtin === 'isNaN') return { value: Number.isNaN(args[0]) };
      if (op.builtin === 'isFinite') return { value: Number.isFinite(args[0]) };
      if (op.builtin === 'isInteger') return { value: Number.isInteger(args[0]) };
      if (op.builtin === 'isSafeInteger') return { value: Number.isSafeInteger(args[0]) };
      const fn = Math[op.builtin] as (...values: number[]) => number;
      return { value: fn(...args) };
    }
  }
  return undefined;
}

function removable(
  op: OperationIR,
  types: ReadonlyMap<number, ValueTypeIR>,
  folded: ReadonlyMap<number, Primitive>,
): boolean {
  switch (op.kind) {
    case 'constant':
      return op.constant.kind !== 'bytes' && op.constant.kind !== 'record';
    case 'parameter':
    case 'localRead':
    case 'optional':
    case 'isNone':
    case 'unary':
    case 'numeric':
      return true;
    case 'nonNull':
      return folded.has(op.result);
    case 'binary': {
      if (op.operator !== 'equal' && op.operator !== 'notEqual') return true;
      let type = types.get(op.left);
      if (type?.kind === 'optional') type = type.inner;
      return !!type && ['number', 'string', 'bool', 'enum'].includes(type.kind);
    }
    default:
      return false;
  }
}

function attributes(op: OperationIR): Readonly<Record<string, InternalAttribute>> {
  const copy = (value: unknown): InternalAttribute => {
    if (value === null || typeof value !== 'object')
      return value as string | number | boolean | null;
    if (Array.isArray(value)) return Object.freeze(value.map(copy));
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, copy(value)]),
      ),
    );
  };
  return Object.freeze(
    Object.fromEntries(
      Object.entries(op).flatMap(([key, value]) => {
        if (
          ['kind', 'type', 'source', 'body', 'test', 'message', 'yes', 'no'].includes(key) ||
          value === undefined ||
          (key === 'right' && typeof value === 'object')
        )
          return [];
        return [
          [
            key,
            copy(
              key === 'arms'
                ? (op as Extract<OperationIR, { kind: 'match' }>).arms.map((arm) => arm.pattern)
                : value,
            ),
          ],
        ];
      }),
    ),
  );
}

export function analyzeBody(
  body: RegionIR,
  options: CompileOptions,
  metadata = true,
): BodyAnalysis {
  return new Analyzer(body, options.optimize !== false, metadata).analyze();
}
class Analyzer {
  private readonly nodes: Node[] = [];
  private readonly regions: Region[] = [];
  private blocks: Block[] = [];
  private readonly blockSpecs: Pick<Block, 'id' | 'region' | 'role' | 'position'>[] = [];
  private buildingGraph = false;
  private readonly edges: ControlEdge[] = [];
  private readonly byOperation = new Map<OperationIR, Node>();
  private readonly folded = new Map<number, Primitive>();
  private readonly eliminated = new Set<number>();
  private readonly root: Region;
  private readonly throwExit: number;
  private readonly stopExit: number;
  private readonly redirectExit: number;

  constructor(
    body: RegionIR,
    private readonly optimize: boolean,
    private readonly metadata: boolean,
  ) {
    this.root = this.index(body, [], null, body.source);
    this.throwExit = this.block(0, 'throw');
    this.stopExit = this.block(0, 'stop');
    this.redirectExit = this.block(0, 'redirect');
  }
  private block(region: number, role: BasicBlock['role'], position: number | null = null): number {
    const id = this.blockSpecs.length;
    const spec = { id, region, role, position };
    this.blockSpecs.push(spec);
    if (this.buildingGraph) this.blocks.push(this.allocateBlock(spec));
    return id;
  }
  private allocateBlock(spec: Pick<Block, 'id' | 'region' | 'role' | 'position'>): Block {
    return {
      ...spec,
      uses: new Set(),
      definitions: new Set(),
      liveIn: new Set(),
      liveOut: new Set(),
    };
  }
  private edge(
    from: number,
    to: number,
    kind: EdgeKind,
    extra: { arm?: number; value?: number } = {},
  ): void {
    this.edges.push(Object.freeze({ from, to, kind, ...extra }));
  }
  private index(
    input: RegionIR,
    path: InputPath,
    parent: number | null,
    inherited?: SourceInfo,
  ): Region {
    const id = this.regions.length;
    const region: Region = {
      id,
      parent,
      path: Object.freeze([...path]),
      entry: this.block(id, 'entry'),
      exit: this.block(id, 'exit'),
      nodes: [],
    };
    this.regions.push(region);
    input.operations.forEach((operation, index) => {
      const position = this.nodes.length;
      const block = this.block(id, 'operation', position);
      const source = this.metadata ? (operation.source ?? input.source ?? inherited) : undefined;
      let effectSummary: OperationEffects | undefined;
      const node: Node = {
        operation,
        position,
        block,
        definitionBlock: block,
        region: id,
        path: Object.freeze([...path, 'operations', index]),
        inputs: Object.freeze(inputs(operation)),
        get effects() {
          return (effectSummary ??= effects(operation));
        },
        children: new Map(),
        ...(source ? { source: sourceSnapshot(source) } : {}),
      };
      region.nodes.push(node);
      this.nodes.push(node);
      this.byOperation.set(operation, node);
      const child = (
        key: string,
        body: RegionIR,
        suffix: InputPath = [key],
        inherited = source,
      ): void => {
        node.children.set(key, this.index(body, [...node.path, ...suffix], id, inherited));
      };
      switch (operation.kind) {
        case 'if':
          child('yes', operation.yes);
          if (operation.no) child('no', operation.no);
          break;
        case 'match':
          operation.arms.forEach((arm, i) =>
            child(`arm${i}`, arm.body, ['arms', i, 'body'], arm.source ?? source),
          );
          if (operation.otherwise) child('otherwise', operation.otherwise);
          break;
        case 'while':
          child('test', operation.test.body, ['test', 'body']);
          child('body', operation.body);
          break;
        case 'loop':
          child('body', operation.body);
          break;
        case 'select':
          child('yes', operation.yes.body, ['yes', 'body']);
          child('no', operation.no.body, ['no', 'body']);
          break;
        case 'and':
        case 'or':
          child('right', operation.right.body, ['right', 'body']);
          break;
        case 'assert':
          if (operation.message) child('message', operation.message.body, ['message', 'body']);
          break;
      }
    });
    return region;
  }
  private link(
    region: Region,
    target: number | null,
    context: Context,
    exitKind: EdgeKind = 'next',
  ): void {
    this.edge(region.entry, region.nodes[0]?.block ?? region.exit, 'next');
    if (target !== null) this.edge(region.exit, target, exitKind);
    region.nodes.forEach((node, index) => {
      const op = node.operation,
        head = node.block;
      const next = region.nodes[index + 1]?.block ?? region.exit;
      const child = (
        key: string,
        destination = next,
        ctx = context,
        kind: EdgeKind = 'next',
      ): Region => {
        const nested = node.children.get(key)!;
        this.link(nested, destination, ctx, kind);
        return nested;
      };
      const valueChild = (key: string, destination: number | null): Region => {
        const nested = node.children.get(key)!;
        this.link(nested, destination, { yieldTo: nested.exit });
        return nested;
      };
      if (node.effects.mayThrow && op.kind !== 'assert') this.edge(head, this.throwExit, 'throw');
      switch (op.kind) {
        case 'if':
          this.edge(head, child('yes').entry, 'true');
          this.edge(head, node.children.has('no') ? child('no').entry : next, 'false');
          break;
        case 'match':
          op.arms.forEach((_, i) => this.edge(head, child(`arm${i}`).entry, 'arm', { arm: i }));
          if (op.otherwise) this.edge(head, child('otherwise').entry, 'default');
          break;
        case 'while': {
          const test = valueChild('test', null);
          const loopContext = { ...context, breakTo: next, continueTo: test.entry };
          const body = child('body', test.entry, loopContext, 'backedge');
          this.edge(head, test.entry, 'next');
          this.edge(test.exit, body.entry, 'true');
          this.edge(test.exit, next, 'false');
          break;
        }
        case 'loop': {
          const body = node.children.get('body')!;
          child(
            'body',
            body.entry,
            { ...context, breakTo: next, continueTo: body.entry },
            'backedge',
          );
          this.edge(head, body.entry, 'next');
          break;
        }
        case 'select':
        case 'and':
        case 'or': {
          const join = this.block(region.id, 'join', node.position);
          node.definitionBlock = join;
          this.edge(join, next, 'next');
          if (op.kind === 'select') {
            this.edge(head, valueChild('yes', join).entry, 'true');
            this.edge(head, valueChild('no', join).entry, 'false');
          } else {
            const right = valueChild('right', join);
            this.edge(head, right.entry, op.kind === 'and' ? 'true' : 'false');
            this.edge(head, join, op.kind === 'and' ? 'false' : 'true', { value: op.left });
          }
          break;
        }
        case 'assert': {
          const failure = this.block(region.id, 'throw', node.position);
          node.failureBlock = failure;
          this.edge(head, next, 'true');
          this.edge(failure, this.throwExit, 'throw');
          this.edge(head, op.message ? valueChild('message', failure).entry : failure, 'false');
          break;
        }
        case 'break':
          if (context.breakTo === undefined) throw new TypeError('Break has no loop target');
          this.edge(head, context.breakTo, 'break');
          break;
        case 'continue':
          if (context.continueTo === undefined) throw new TypeError('Continue has no loop target');
          this.edge(head, context.continueTo, 'continue');
          break;
        case 'yield':
          if (context.yieldTo === undefined)
            throw new TypeError('Yield has no value-region target');
          this.edge(head, context.yieldTo, 'yield', { value: op.value });
          break;
        case 'return':
        case 'returnValue':
          this.edge(head, this.root.exit, 'return');
          break;
        case 'redirect':
          this.edge(head, this.redirectExit, 'redirect');
          break;
        case 'stop':
          this.edge(head, this.stopExit, 'stop');
          break;
        case 'wait':
        case 'elapse':
        case 'receive':
        case 'waitUntil':
        case 'call':
        case 'callValue': {
          const resume = this.block(region.id, 'resume', node.position);
          node.resumeBlock = resume;
          const call = op.kind === 'call' || op.kind === 'callValue';
          this.edge(head, resume, 'suspend');
          if (call) {
            const completion = this.block(region.id, 'join', node.position);
            node.completionBlock = completion;
            node.definitionBlock = completion;
            this.edge(head, completion, 'next');
            this.edge(resume, resume, 'suspend');
            this.edge(resume, completion, 'resume');
            this.edge(completion, next, 'next');
            for (const from of [head, resume]) {
              this.edge(from, this.redirectExit, 'redirect');
              this.edge(from, this.stopExit, 'stop');
            }
            this.edge(resume, this.throwExit, 'throw');
          } else {
            if (op.kind === 'receive') node.definitionBlock = resume;
            this.edge(resume, op.kind === 'waitUntil' ? this.root.exit : next, 'resume');
            if (op.kind === 'elapse') this.edge(head, next, 'next');
          }
          break;
        }
        default:
          this.edge(head, next, 'next');
      }
    });
  }
  analyze(): BodyAnalysis {
    const types = new Map<number, ValueTypeIR>();
    for (const node of this.nodes)
      if ('result' in node.operation) types.set(node.operation.result, node.operation.type);
    const known = new Map<number, Primitive>();
    if (this.optimize) {
      for (const node of this.nodes) {
        if (!('result' in node.operation)) continue;
        const constant = fold(node.operation, known);
        if (constant) {
          known.set(node.operation.result, constant.value);
          if (node.operation.kind !== 'constant') this.folded.set(node.position, constant.value);
        }
      }
      const foldedByResult = new Map<number, Primitive>();
      for (const node of this.nodes)
        if ('result' in node.operation && this.folded.has(node.position))
          foldedByResult.set(node.operation.result, this.folded.get(node.position)!);
      const definitions = new Map(
        this.nodes.flatMap((node) =>
          'result' in node.operation ? [[node.operation.result, node] as const] : [],
        ),
      );
      const required = new Set<number>();
      const queue: number[] = [];
      const require = (id: number): void => {
        if (!required.has(id)) {
          required.add(id);
          queue.push(id);
        }
      };
      // Retain unknown inputs of even dead operations for baseline exit recovery.
      // Only known folded inputs can be discarded and reconstructed from recipes.
      for (const node of this.nodes) {
        if (!this.folded.has(node.position)) node.inputs.forEach(require);
      }
      for (let i = 0; i < queue.length; i++) {
        const node = definitions.get(queue[i]!);
        if (node && !this.folded.has(node.position)) node.inputs.forEach(require);
      }
      for (const node of this.nodes)
        if (
          'result' in node.operation &&
          !required.has(node.operation.result) &&
          removable(node.operation, types, foldedByResult)
        )
          this.eliminated.add(node.position);
    }
    let completed: BodyAnalysis | undefined;
    const complete = (): BodyAnalysis => (completed ??= this.complete(known));
    return {
      nodes: this.nodes,
      byOperation: this.byOperation,
      folded: this.folded,
      constants: known,
      eliminated: this.eliminated,
      optimizations: Object.freeze({
        enabled: this.optimize,
        foldedPositions: Object.freeze(
          [...this.folded.keys()].filter((id) => !this.eliminated.has(id)),
        ),
        eliminatedPositions: Object.freeze([...this.eliminated]),
      }),
      get graph() {
        return complete().graph;
      },
      get effects() {
        return complete().effects;
      },
      get resources() {
        return complete().resources;
      },
    };
  }
  private complete(known: ReadonlyMap<number, Primitive>): BodyAnalysis {
    this.buildingGraph = true;
    this.blocks = this.blockSpecs.map((spec) => this.allocateBlock(spec));
    this.link(this.root, null, {});
    for (const node of this.nodes) {
      if (this.eliminated.has(node.position)) continue;
      const block = this.blocks[node.block]!,
        op = node.operation;
      if (!this.folded.has(node.position)) {
        node.inputs.forEach((id) => block.uses.add(`value:${id}`));
        argumentUses(op).forEach((key) => block.uses.add(key));
        if (op.kind === 'localRead') block.uses.add(`local:${op.local}`);
      }
      if ('result' in op) this.blocks[node.definitionBlock]!.definitions.add(`value:${op.result}`);
      if (op.kind === 'local' || op.kind === 'localWrite')
        block.definitions.add(`local:${op.local}`);
    }
    const regionOutputs = new Map<number, string>();
    for (const node of this.nodes) {
      const child =
        node.operation.kind === 'while'
          ? node.children.get('test')
          : node.operation.kind === 'assert'
            ? node.children.get('message')
            : undefined;
      if (!child) continue;
      const key = `region:${child.id}`;
      regionOutputs.set(child.exit, key);
      this.blocks[node.failureBlock ?? child.exit]!.uses.add(key);
    }
    for (const edge of this.edges)
      if (edge.kind === 'yield' && regionOutputs.has(edge.to))
        this.blocks[edge.from]!.definitions.add(regionOutputs.get(edge.to)!);
    const outgoing = this.blocks.map(() => [] as number[]),
      incoming = this.blocks.map(() => [] as number[]);
    this.edges.forEach((edge) => {
      outgoing[edge.from]!.push(edge.to);
      incoming[edge.to]!.push(edge.from);
    });
    const baselineUses = this.blocks.map(
      (block) => new Set([...block.uses].filter((key) => key.startsWith('region:'))),
    );
    const baselineDefinitions = this.blocks.map(
      (block) => new Set([...block.definitions].filter((key) => key.startsWith('region:'))),
    );
    for (const node of this.nodes) {
      const op = node.operation;
      node.inputs.forEach((id) => baselineUses[node.block]!.add(`value:${id}`));
      argumentUses(op).forEach((key) => baselineUses[node.block]!.add(key));
      if (op.kind === 'localRead') baselineUses[node.block]!.add(`local:${op.local}`);
      if ('result' in op) baselineDefinitions[node.definitionBlock]!.add(`value:${op.result}`);
      if (op.kind === 'local' || op.kind === 'localWrite')
        baselineDefinitions[node.block]!.add(`local:${op.local}`);
    }
    const liveness = (
      uses: readonly Set<string>[],
      definitions: readonly Set<string>[],
    ): { input: Set<string>[]; output: Set<string>[] } => {
      const input = this.blocks.map(() => new Set<string>());
      const output = this.blocks.map(() => new Set<string>());
      let changed = true;
      while (changed) {
        changed = false;
        for (let i = this.blocks.length - 1; i >= 0; i--) {
          const out = new Set(outgoing[i]!.flatMap((id) => [...input[id]!]));
          const incoming = new Set([
            ...uses[i]!,
            ...[...out].filter((key) => !definitions[i]!.has(key)),
          ]);
          if (
            out.size !== output[i]!.size ||
            [...out].some((key) => !output[i]!.has(key)) ||
            incoming.size !== input[i]!.size ||
            [...incoming].some((key) => !input[i]!.has(key))
          ) {
            changed = true;
            output[i] = out;
            input[i] = incoming;
          }
        }
      }
      return { input, output };
    };
    const optimizedLive = liveness(
      this.blocks.map((block) => block.uses),
      this.blocks.map((block) => block.definitions),
    );
    const baselineLive = liveness(baselineUses, baselineDefinitions);
    this.blocks.forEach((block, index) => {
      block.liveIn = optimizedLive.input[index]!;
      block.liveOut = optimizedLive.output[index]!;
    });
    const yieldInputs = new Map<number, number[]>();
    for (const edge of this.edges)
      if (edge.kind === 'yield' && edge.value !== undefined) {
        const values = yieldInputs.get(edge.to) ?? [];
        values.push(edge.value);
        yieldInputs.set(edge.to, values);
      }
    const users = new Map<number, number[]>();
    for (const node of this.nodes)
      for (const input of node.inputs) {
        const positions = users.get(input) ?? [];
        positions.push(node.position);
        users.set(input, positions);
      }
    const values = this.nodes.flatMap((node) => {
      const op = node.operation;
      if (!('result' in op)) return [];
      const phi = op.kind === 'select' || op.kind === 'and' || op.kind === 'or';
      const phiInputs = phi
        ? [...node.children.values()].flatMap((region) => yieldInputs.get(region.exit) ?? [])
        : [];
      if (op.kind === 'and' || op.kind === 'or') phiInputs.unshift(op.left);
      return [
        Object.freeze({
          result: op.result,
          type: typeSnapshot(op.type),
          position: node.position,
          region: node.region,
          block: node.definitionBlock,
          form: phi ? ('phi' as const) : ('operation' as const),
          inputs: Object.freeze(phi ? phiInputs : [...node.inputs]),
          users: Object.freeze(users.get(op.result) ?? []),
          eliminated: this.eliminated.has(node.position),
          folded: this.folded.has(node.position),
        }),
      ];
    });
    const graph: InternalGraph = Object.freeze({
      entry: this.root.entry,
      normalExit: this.root.exit,
      regions: Object.freeze(
        this.regions.map(({ id, parent, path, entry, exit }): InternalRegion =>
          Object.freeze({ id, parent, path, entry, exit }),
        ),
      ),
      blocks: Object.freeze(
        this.blocks.map((block): BasicBlock =>
          Object.freeze({
            ...block,
            predecessors: Object.freeze([...new Set(incoming[block.id])]),
            successors: Object.freeze([...new Set(outgoing[block.id])]),
            uses: Object.freeze([...block.uses]),
            definitions: Object.freeze([...block.definitions]),
            liveIn: Object.freeze([...block.liveIn]),
            liveOut: Object.freeze([...block.liveOut]),
            baselineLiveIn: Object.freeze([...baselineLive.input[block.id]!]),
            baselineLiveOut: Object.freeze([...baselineLive.output[block.id]!]),
          }),
        ),
      ),
      edges: Object.freeze([...this.edges]),
      values: Object.freeze(values),
      operations: Object.freeze(
        this.nodes.map((node) =>
          Object.freeze({
            position: node.position,
            block: node.block,
            region: node.region,
            kind: node.operation.kind,
            path: node.path,
            ...(node.source ? { source: node.source } : {}),
            inputs: node.inputs,
            attributes: attributes(node.operation),
            regions: Object.freeze(
              [...node.children].map(([role, region]) =>
                Object.freeze({ role, region: region.id }),
              ),
            ),
            effects: node.effects,
            eliminated: this.eliminated.has(node.position),
            folded: this.folded.has(node.position),
          }),
        ),
      ),
    });
    const summaries = this.nodes.map((node) => node.effects);
    const union = (key: 'reads' | 'writes' | 'calls' | 'operations'): readonly string[] =>
      Object.freeze([...new Set(summaries.flatMap((summary) => summary[key]))]);
    const effectMetadata: EffectMetadata = Object.freeze({
      reads: union('reads'),
      writes: union('writes'),
      calls: union('calls'),
      operations: union('operations') as EffectMetadata['operations'],
      maySuspend: summaries.some((e) => e.maySuspend),
      mayRedirect: summaries.some((e) => e.mayRedirect),
      mayStop: summaries.some((e) => e.mayStop),
      timeDependent: summaries.some((e) => e.timeDependent),
      random: summaries.some((e) => e.random),
    });
    const resources = new Set(
      [...effectMetadata.reads, ...effectMetadata.writes].filter((key) => key !== '*'),
    );
    for (const node of this.nodes) {
      const op = node.operation;
      if (op.kind === 'resistor') resources.add(`pin:${resourceName(op.to)}`);
      if (op.kind === 'refEqual')
        for (const ref of [op.left, op.right])
          resources.add(
            `${ref.kind === 'parameter' ? ref.resource : ref.kind}:${resourceName(ref)}`,
          );
      if (op.kind === 'call' || op.kind === 'callValue')
        for (const arg of op.args)
          if (arg.kind !== 'value')
            resources.add(
              `${arg.kind === 'parameter' ? arg.resource : arg.kind}:${resourceName(arg)}`,
            );
    }
    return {
      nodes: this.nodes,
      byOperation: this.byOperation,
      graph,
      folded: this.folded,
      constants: known,
      eliminated: this.eliminated,
      effects: effectMetadata,
      resources: Object.freeze([...resources]),
      optimizations: Object.freeze({
        enabled: this.optimize,
        foldedPositions: Object.freeze(
          [...this.folded.keys()].filter((id) => !this.eliminated.has(id)),
        ),
        eliminatedPositions: Object.freeze([...this.eliminated]),
      }),
    };
  }
}
