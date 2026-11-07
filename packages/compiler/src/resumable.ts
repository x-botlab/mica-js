import type { InputPath, OperationIR, RegionIR, ValueRegionIR } from '@mica-js/device-model';
import { analyzeBody } from './analysis.js';
import type { BodyAnalysis } from './analysis.js';
import type { Node } from './analysis.js';
import { Emitter, local, value } from './compiler.js';
import { createEnum, runtimeHelpers } from './values.js';
import { RESUMABLE_RECEIVE, RESUMABLE_TICKS } from './types.js';
import type { CompileOptions, InternalGraph, ResumableProgram } from './types.js';

const unsupported = Symbol('unsupported resumable body');

/** Generated-block terminator. A suspended block records its own pc before returning. */
type Term =
  | { readonly kind: 'jump'; readonly to: number }
  | { readonly kind: 'branch'; readonly test: string; readonly yes: number; readonly no: number }
  | { readonly kind: 'suspend' }
  | { readonly kind: 'done' };

interface Block {
  readonly id: number;
  readonly code: string[];
  term?: Term;
}

interface LoopContext {
  readonly breakTo?: number;
  readonly continueTo?: number;
}

/** `const v3 = ...` becomes `v3 = ...`; every v/l slot is declared once per body. */
const declaredSlot = /^(\s*)(?:const|let) (v\d+|l\d+)( = |;)/;

/**
 * Compiles a process body into one plain function with an explicit pc and a reused
 * local frame. Every suspension returns a boolean instead of yielding a signal object.
 * The body is admitted only as a whole: a shape outside the supported set rejects the
 * program, so the caller keeps its generator body for that process.
 */
export function compileResumableBody(
  region: RegionIR,
  options: CompileOptions = {},
): ResumableProgram | undefined {
  if (!pureValueRegions(region)) return undefined;
  try {
    return new ResumableEmitter(analyzeBody(region, options, false), options, false).compileMachine(
      region,
    );
  } catch {
    // Unsupported shapes and any internal gap fall back to the generator whole.
    return undefined;
  }
}

class ResumableEmitter extends Emitter {
  private readonly blocks: Block[] = [];
  private readonly slots = new Map<string, number>();
  /** Fixed resources in first-use order; the frame binds them once per instance. */
  private readonly resources: [string, string][] = [];
  private readonly resourceIndex = new Map<string, number>();
  private current: Block | undefined;
  private graph: InternalGraph | undefined;

  constructor(analysis: BodyAnalysis, options: CompileOptions, captureMetadata: boolean) {
    super(analysis, options, captureMetadata);
    if (options.bindResources) this.bindingFor = (kind, name) => this.bindResource(kind, name);
  }

  private bindResource(kind: 'pin' | 'state' | 'memory', name: string): string {
    const key = `${kind}\0${name}`;
    let index = this.resourceIndex.get(key);
    if (index === undefined) {
      index = this.resources.push([kind, name]) - 1;
      this.resourceIndex.set(key, index);
    }
    return `F.resources[${index}]`;
  }

  compileMachine(region: RegionIR): ResumableProgram {
    // The graph getter builds the control-flow graph and assigns every node's resume
    // block; the liveness of those resume blocks is the frame contract used below.
    this.graph = this.analysis.graph;
    for (const node of this.analysis.nodes)
      if ('result' in node.operation) this.types.set(node.operation.result, node.operation.type);
    const entry = this.reserve();
    const done = this.reserve();
    this.blocks[done]!.term = { kind: 'done' };
    const start = this.buildRegion(region, done, {}, []);
    this.blocks[entry]!.term = { kind: 'jump', to: start };
    const locals = [...this.locals()].sort();
    const lines = [
      'function resumableBody(host, args = [], reaction, F) {',
      ...(locals.length ? [`let ${locals.join(', ')};`] : []),
      ...(this.resources.length
        ? [
            `if (F.resources === void 0) F.resources = host.bind(${this.capture(
              Object.freeze(this.resources.slice()),
            )});`,
          ]
        : []),
      'for (;;) {',
      'switch (F.pc) {',
    ];
    for (const block of this.blocks) {
      lines.push(`case ${block.id}: {`);
      for (const line of block.code) lines.push(line);
      lines.push(...terminator(block));
      lines.push('}');
    }
    lines.push('default: throw new TypeError("Unknown resumable continuation");', '}', '}', '}');
    const source = lines.join('\n');
    const constants = Object.freeze(this.constants.slice());
    // Only compiler-owned templates enter Function; all IR constants are captured data.
    const factory = new Function('C', 'H', `"use strict"; return (${source});`) as (
      constants: readonly unknown[],
      helpers: typeof runtimeHelpers,
    ) => ResumableProgram['run'];
    return Object.freeze({
      run: factory(constants, runtimeHelpers),
      slotCount: this.slots.size,
      start: 0,
    });
  }

  private locals(): Set<string> {
    const names = new Set<string>();
    for (const node of this.analysis.nodes) {
      const operation = node.operation;
      if ('result' in operation) names.add(value(operation.result));
      if (
        operation.kind === 'local' ||
        operation.kind === 'localRead' ||
        operation.kind === 'localWrite'
      )
        names.add(`l${operation.local}`);
    }
    return names;
  }

  private buildRegion(
    region: RegionIR,
    cont: number,
    context: LoopContext,
    path: InputPath,
    entry?: number,
  ): number {
    this.current = undefined;
    let next = cont;
    let chunks: string[][] = [];
    for (let index = region.operations.length - 1; index >= 0; index--) {
      const operation = region.operations[index]!;
      const operationPath: InputPath = [...path, 'operations', index];
      if (straight(operation)) {
        chunks.unshift(this.emitStraight(operation, operationPath));
        continue;
      }
      next = this.flush(chunks, next);
      chunks = [];
      next = this.buildControl(operation, next, context, operationPath);
    }
    if (entry !== undefined) {
      if (chunks.length) {
        const block = this.blocks[entry]!;
        for (const chunk of chunks) block.code.push(...chunk);
        block.term = { kind: 'jump', to: next };
      } else if (entry !== next) this.blocks[entry]!.term = { kind: 'jump', to: next };
      return entry;
    }
    return this.flush(chunks, next);
  }

  /** Straight-line IR keeps the generator emitter's own code generation. */
  private emitStraight(operation: OperationIR, path: InputPath): string[] {
    const lines = this.lines;
    const indent = this.indent;
    this.lines = [];
    this.indent = 0;
    let emitted: string[];
    try {
      super.operation(operation, path);
      emitted = this.lines;
    } finally {
      this.lines = lines;
      this.indent = indent;
    }
    return hoist(emitted);
  }

  private flush(chunks: string[][], next: number): number {
    if (!chunks.length) return next;
    const block = this.open();
    for (const chunk of chunks) block.code.push(...chunk);
    this.current = undefined;
    block.term = { kind: 'jump', to: next };
    return block.id;
  }

  private buildControl(
    operation: OperationIR,
    cont: number,
    context: LoopContext,
    path: InputPath,
  ): number {
    switch (operation.kind) {
      case 'if': {
        const yes = this.reserve();
        const no = operation.no ? this.reserve() : cont;
        const block = this.open();
        block.term = {
          kind: 'branch',
          test: `H.checkBoolean(${value(operation.condition)})`,
          yes,
          no,
        };
        this.current = undefined;
        this.buildRegion(operation.yes, cont, context, [...path, 'yes'], yes);
        if (operation.no) this.buildRegion(operation.no, cont, context, [...path, 'no'], no);
        return block.id;
      }
      case 'match': {
        const otherwise = operation.otherwise ? this.reserve() : cont;
        let target = otherwise;
        for (let index = operation.arms.length - 1; index >= 0; index--) {
          const arm = operation.arms[index]!;
          const body = this.reserve();
          this.buildRegion(arm.body, cont, context, [...path, 'arms', index, 'body'], body);
          const pattern = arm.pattern;
          const constant =
            pattern.kind === 'none'
              ? null
              : pattern.kind === 'enum'
                ? createEnum(pattern.name, pattern.member)
                : pattern.value;
          const block = this.open();
          block.term = {
            kind: 'branch',
            test: `H.equalValues(${value(operation.value)}, ${this.capture(constant)})`,
            yes: body,
            no: target,
          };
          this.current = undefined;
          target = block.id;
        }
        if (operation.otherwise)
          this.buildRegion(operation.otherwise, cont, context, [...path, 'otherwise'], otherwise);
        return target;
      }
      case 'while': {
        const test = this.reserve();
        const body = this.buildRegion(operation.body, test, { breakTo: cont, continueTo: test }, [
          ...path,
          'body',
        ]);
        this.fillTest(test, operation.test, [...path, 'test'], (slot) => ({
          kind: 'branch',
          test: `H.checkBoolean(${slot})`,
          yes: body,
          no: cont,
        }));
        return test;
      }
      case 'loop': {
        const head = this.reserve();
        const body = this.buildRegion(operation.body, head, { breakTo: cont, continueTo: head }, [
          ...path,
          'body',
        ]);
        this.blocks[head]!.term = { kind: 'jump', to: body };
        return head;
      }
      case 'break':
      case 'continue': {
        const target = operation.kind === 'break' ? context.breakTo : context.continueTo;
        if (target === undefined) throw unsupported;
        const block = this.open();
        block.term = { kind: 'jump', to: target };
        this.current = undefined;
        return block.id;
      }
      case 'return':
      case 'returnValue': {
        const block = this.open();
        block.term = { kind: 'done' };
        this.current = undefined;
        return block.id;
      }
      case 'wait': {
        const duration = `duration${this.serial++}`;
        const block = this.open();
        block.code.push(`const ${duration} = H.checkDuration(${value(operation.duration)});`);
        const resume = this.resumeBlock(operation);
        block.code.push(
          ...this.save(operation),
          `F.pc = ${resume};`,
          `F.kind = ${RESUMABLE_TICKS};`,
          `F.duration = ${duration};`,
        );
        block.term = { kind: 'suspend' };
        this.current = undefined;
        this.link(resume, cont);
        return block.id;
      }
      case 'receive': {
        const block = this.open();
        const resume = this.resumeBlock(operation);
        block.code.push(
          ...this.save(operation),
          `F.pc = ${resume};`,
          `F.kind = ${RESUMABLE_RECEIVE};`,
          `F.channel = ${this.capture(operation.channel)};`,
        );
        block.term = { kind: 'suspend' };
        this.current = undefined;
        this.link(resume, cont);
        return block.id;
      }
      default:
        throw unsupported;
    }
  }

  /** A while test stays in one block: value regions cannot suspend. */
  private fillTest(
    entry: number,
    region: ValueRegionIR,
    path: InputPath,
    term: (slot: string) => Term,
  ): void {
    const block = this.blocks[entry]!;
    const slot = `condition${this.serial++}`;
    const lines = this.lines;
    const indent = this.indent;
    this.lines = block.code;
    this.indent = 0;
    try {
      this.line(`let ${slot};`);
      this.valueRegion(region, slot, path);
    } finally {
      this.lines = lines;
      this.indent = indent;
    }
    this.current = undefined;
    block.term = term(slot);
  }

  /** First block after a suspension: restore live slots, then continue. */
  private resumeBlock(operation: OperationIR): number {
    const id = this.reserve();
    const block = this.blocks[id]!;
    const node = this.analysis.byOperation.get(operation)!;
    const result = 'result' in operation ? value(operation.result) : undefined;
    for (const key of this.liveIn(node)) {
      if (key === result) continue;
      block.code.push(`${this.slotName(key)} = F.slots[${this.slot(key)}];`);
    }
    if (result) block.code.push(`${result} = F.value;`);
    return id;
  }

  private link(resume: number, cont: number): void {
    const block = this.blocks[resume]!;
    block.code.push(`F.pc = ${cont};`);
    block.term = { kind: 'jump', to: cont };
  }

  private save(operation: OperationIR): string[] {
    const node = this.analysis.byOperation.get(operation)!;
    const result = 'result' in operation ? value(operation.result) : undefined;
    const lines: string[] = [];
    for (const key of this.liveIn(node)) {
      if (key === result) continue;
      lines.push(`F.slots[${this.slot(key)}] = ${this.slotName(key)};`);
    }
    return lines;
  }

  /** Slots crossing this suspension; arguments and reaction frames are re-supplied. */
  private liveIn(node: Node): string[] {
    if (node.resumeBlock === undefined) throw unsupported;
    const graph = (this.graph ??= this.analysis.graph);
    return graph.blocks[node.resumeBlock]!.liveIn.filter(
      (key) => key.startsWith('value:') || key.startsWith('local:'),
    );
  }

  private slotName(key: string): string {
    const separator = key.indexOf(':');
    const id = Number(key.slice(separator + 1));
    if (!Number.isSafeInteger(id) || id < 0) throw unsupported;
    return key.startsWith('value:') ? value(id) : local(id);
  }

  private slot(key: string): number {
    const existing = this.slots.get(key);
    if (existing !== undefined) return existing;
    const index = this.slots.size;
    this.slots.set(key, index);
    return index;
  }

  private reserve(): number {
    const block: Block = { id: this.blocks.length, code: [] };
    this.blocks.push(block);
    return block.id;
  }

  private open(): Block {
    if (this.current) return this.current;
    const block: Block = { id: this.blocks.length, code: [] };
    this.blocks.push(block);
    this.current = block;
    return block;
  }
}

function hoist(emitted: readonly string[]): string[] {
  const lines: string[] = [];
  for (const raw of emitted) {
    const match = declaredSlot.exec(raw);
    if (!match) {
      lines.push(raw);
      continue;
    }
    // The slot is declared once at function scope; keep only the assignment.
    if (match[3] === ';') continue;
    lines.push(`${match[1]}${match[2]}${match[3]}${raw.slice(match[0].length)}`);
  }
  return lines;
}

function terminator(block: Block): string[] {
  const term = block.term;
  if (!term) throw unsupported;
  switch (term.kind) {
    case 'jump':
      return [`F.pc = ${term.to};`, 'break;'];
    case 'branch':
      return [`if (${term.test}) F.pc = ${term.yes};`, `else F.pc = ${term.no};`, 'break;'];
    case 'suspend':
      return ['return true;'];
    case 'done':
      return ['F.pc = 0;', 'return false;'];
    default:
      throw unsupported;
  }
}

const control = new Set<OperationIR['kind']>([
  'if',
  'match',
  'while',
  'loop',
  'break',
  'continue',
  'return',
  'returnValue',
  'wait',
  'receive',
]);

/** Suspension and termination shapes this emitter does not model; they reject the body. */
const rejected = new Set<OperationIR['kind']>([
  'elapse',
  'call',
  'callValue',
  'waitUntil',
  'redirect',
  'stop',
  'yield',
]);

function straight(operation: OperationIR): boolean {
  return !control.has(operation.kind) && !rejected.has(operation.kind);
}

/** Whole-body admission also requires suspension-free value regions. */
function pureValueRegions(region: RegionIR): boolean {
  for (const operation of region.operations) {
    switch (operation.kind) {
      case 'if':
        if (!pureValueRegions(operation.yes)) return false;
        if (operation.no && !pureValueRegions(operation.no)) return false;
        break;
      case 'match':
        for (const arm of operation.arms) if (!pureValueRegions(arm.body)) return false;
        if (operation.otherwise && !pureValueRegions(operation.otherwise)) return false;
        break;
      case 'while':
        if (!pureValueRegion(operation.test.body)) return false;
        if (!pureValueRegions(operation.body)) return false;
        break;
      case 'loop':
        if (!pureValueRegions(operation.body)) return false;
        break;
      case 'and':
      case 'or':
        if (!pureValueRegion(operation.right.body)) return false;
        break;
      case 'select':
        if (!pureValueRegion(operation.yes.body) || !pureValueRegion(operation.no.body))
          return false;
        break;
      case 'assert':
        if (operation.message && !pureValueRegion(operation.message.body)) return false;
        break;
      default:
        break;
    }
  }
  return true;
}

function pureValueRegion(region: RegionIR): boolean {
  for (const operation of region.operations) {
    if (operation.kind === 'yield') continue;
    if (control.has(operation.kind) || rejected.has(operation.kind)) return false;
    if (!pureValueRegions({ operations: [operation] })) return false;
  }
  return true;
}
