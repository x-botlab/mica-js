/**
 * Source emitter for J6: turns one MIR function into a JavaScript factory body.
 *
 * Shape (see the issue specification):
 *
 * ```js
 * 'use strict';
 * const K0 = k[0], K4 = k[4];
 * const S0 = H.res[0];
 * const F = k[9];
 * return function f12(p0, p1) {
 *   const d = rt.depth;
 *   if (d >= rt.maxDepth) return rt.deep(12, p0, p1);
 *   rt.depth = d + 1;
 *   let L = -1;
 *   let v0 = 0, v1 = false;
 *   try { ... } catch (e) { rt.depth = d; throw rt.unwind(e, L, F); }
 * };
 * //# sourceURL=mica-ir-jit/f12.js
 * ```
 *
 * Every identifier in the output is generated here (`f<n>`, `v<n>`, `p<n>`,
 * `K<n>`, `S<n>`, `L`, `F`, `d`). User text (function names, block ids, trap
 * codes, provider names, bit strings) only ever appears through `k[i]`.
 */
import { analyzeCFG } from '../cfg';
import type { FunctionSummary } from '../effects';
import { Op } from '../mir';
import type { MBlock, MFunction, MTerm, ValueId } from '../mir';
import type { JitFrame } from '../runtime-core';
import { ConstantPool, emitInstruction } from './ops';
import type { OpsContext } from './ops';
import { planFunction } from './segments';
import type { FunctionPlan, PlannedItem, PlannedSegment } from './segments';
import { StructurizationError, structurize } from './structure';
import type {
  GotoShape,
  SideShape,
  StructuredNode,
  StructuredProgram,
  TermShape,
} from './structure';
import type { ScalarType } from '../../types';

/** Compile-time inputs for one function. */
export interface EmitEnv {
  /** Module-wide constant table used by `const.bits` (indices are stable). */
  readonly constants: readonly unknown[];
  /** `storageInternals.littleEndianHost`; selects typed-view or DataView access. */
  readonly littleEndian: boolean;
  /** Model memory references, indexed by `MInst.refs` memory indices. */
  readonly memoryRefs: readonly unknown[];
  /** Function summaries for `call` result layout and transfer detection. */
  readonly summaries?: ReadonlyMap<number, FunctionSummary>;
  /** Dependency set when compiling a provider artifact. */
  readonly artifactDependencies?: readonly unknown[];
  /** Debug: force the `switch (pc)` form. */
  readonly forceSwitch?: boolean;
}

export interface EmittedFunction {
  /** Factory body; `new Function('rt', 'k', 'H', source)` returns the function. */
  readonly source: string;
  /** Constant table to pass as `k`. */
  readonly constants: readonly unknown[];
  readonly frame: JitFrame;
  /** False when the irreducible/unsupported fallback was used. */
  readonly structured: boolean;
  /** Why the structurizer was skipped, when it was. */
  readonly fallback?: string;
}

type Context =
  | { readonly kind: 'if'; readonly join: number | undefined }
  | { readonly kind: 'loop'; readonly exit: number | undefined; readonly label: string };

const INDENT = '  ';

class Emitter implements OpsContext {
  readonly fn: MFunction;
  readonly plan: FunctionPlan;
  readonly le: boolean;
  readonly pool: ConstantPool;
  readonly frame: JitFrame;
  readonly shape: StructuredProgram | undefined;
  readonly fallback: string | undefined;
  readonly #env: EmitEnv;
  readonly #used = new Set<number>();
  readonly #resources = new Set<number>();
  readonly #blocks: Map<number, MBlock>;
  #temps = 0;
  #indent = 0;
  readonly #lines: string[] = [];
  readonly #contexts: Context[] = [];
  readonly depthName = 'd';

  constructor(fn: MFunction, env: EmitEnv) {
    this.fn = fn;
    this.#env = env;
    this.le = env.littleEndian;
    this.plan = planFunction(fn);
    this.frame = Object.freeze({
      locations: Object.freeze([...this.plan.locations]),
      stepsAfter: this.plan.stepsAfter,
    });
    this.pool = new ConstantPool(env.constants);
    this.#blocks = new Map(fn.blocks.map((block) => [block.id, block]));
    if (env.forceSwitch === true) {
      this.shape = undefined;
      this.fallback = 'switch mode requested';
    } else {
      const attempt = tryStructurize(fn);
      this.shape = attempt.shape;
      this.fallback = attempt.reason;
    }
  }

  // --- OpsContext -------------------------------------------------------

  line(text: string): void {
    this.#lines.push(`${INDENT.repeat(this.#indent)}${text}`);
  }

  constant(value: unknown): string {
    const index = this.pool.intern(value);
    this.#used.add(index);
    return `K${index}`;
  }

  constantAt(index: number): string {
    this.#used.add(index);
    return `K${index}`;
  }

  resource(index: number): string {
    this.#resources.add(index);
    return `S${index}`;
  }

  memory(index: number): unknown {
    const ref = this.#env.memoryRefs[index];
    if (ref === undefined) {
      throw new Error(`JIT codegen is missing memory reference #${index}`);
    }
    return ref;
  }

  temp(): string {
    const name = `t${this.#temps}`;
    this.#temps += 1;
    return name;
  }

  value(id: ValueId): string {
    return `v${id}`;
  }

  numeric(id: ValueId): string {
    const value = this.value(id);
    return isFloatValue(this.fn, id) && this.repOf(id) === 'U' ? `H.toNum(${value})` : value;
  }

  boundary(id: ValueId): string {
    const value = this.value(id);
    return isFloatValue(this.fn, id)
      ? `H.toBoundary(${this.typeConstant(this.typeOf(id))}, ${value})`
      : value;
  }

  typeOf(id: ValueId): ScalarType {
    return this.fn.values[id]!.type;
  }

  repOf(id: ValueId): 'bool' | 'int' | 'i32u' | 'D' | 'U' {
    return this.fn.values[id]!.rep;
  }

  typeConstant(type: ScalarType): string {
    return this.constant(type);
  }

  hasTransfer(callee: number): boolean {
    return this.#env.summaries?.get(callee)?.hasTransfer === true;
  }

  get artifactDependencies(): readonly unknown[] | undefined {
    return this.#env.artifactDependencies;
  }

  // --- Driver -----------------------------------------------------------

  emit(): EmittedFunction {
    if (this.shape !== undefined) {
      this.#emitStructured(this.shape.nodes);
    } else {
      this.#emitSwitch();
    }
    return this.#assemble();
  }

  #emitStructured(nodes: readonly StructuredNode[]): void {
    for (const node of nodes) {
      if (node.kind === 'block') {
        this.#emitBlock(node.id, node.term);
        continue;
      }
      this.line(`${node.label}: for (;;) {`);
      this.#indent += 1;
      this.#contexts.push({ kind: 'loop', exit: node.exit, label: node.label });
      this.#emitStructured(node.body);
      this.#contexts.pop();
      this.#indent -= 1;
      this.line('}');
    }
  }

  #emitSwitch(): void {
    // Only reachable blocks; unreachable ones contribute no code.
    const analysis = analyzeCFG(this.fn);
    this.line('pc = ' + analysis.cfg.entry + ';');
    this.line('Ldispatch: for (;;) {');
    this.#indent += 1;
    this.line('switch (pc) {');
    this.#indent += 1;
    for (const id of analysis.cfg.order) {
      const block = this.#block(id);
      this.line(`case ${id}: {`);
      this.#indent += 1;
      this.#emitBlock(id, { kind: 'native' }, block);
      this.line('break;');
      this.#indent -= 1;
      this.line('}');
    }
    this.line('default:');
    this.line("  throw new Error('JIT dispatch reached an unknown block');");
    this.#indent -= 1;
    this.line('}');
    this.#indent -= 1;
    this.line('}');
  }

  #block(id: number): MBlock {
    const block = this.#blocks.get(id);
    if (block === undefined) throw new Error(`JIT codegen: unknown block ${id}`);
    return block;
  }

  /** Emit a block: segments, then its terminator. */
  #emitBlock(id: number, term: TermShape, switchBlock?: MBlock): void {
    const segments = this.plan.blocks.get(id);
    if (segments === undefined) throw new Error(`JIT codegen: no segment plan for block ${id}`);
    const block = switchBlock ?? this.#block(id);
    for (const segment of segments) {
      this.#emitSegment(segment);
    }
    if (switchBlock !== undefined) {
      this.#emitSwitchTerm(block);
      return;
    }
    this.#emitTerm(term, block);
  }

  // --- Segments ---------------------------------------------------------

  #emitSegment(segment: PlannedSegment): void {
    const items = segment.items;
    const terminator = segment.terminator ? items[items.length - 1]! : undefined;
    const body = terminator === undefined ? items : items.slice(0, -1);
    const steps = segment.steps;

    if (terminator === undefined) {
      if (steps === 0) {
        for (const item of items) this.#emitStepZero(item);
        return;
      }
      this.line(`if (rt.steps + ${steps} > rt.limit) {`);
      this.#indent += 1;
      for (const item of items) this.#emitExactItem(item);
      this.#indent -= 1;
      this.line('} else {');
      this.#indent += 1;
      this.line(`rt.steps += ${steps};`);
      for (const item of items) this.#emitFastItem(item);
      this.#indent -= 1;
      this.line('}');
      return;
    }

    // The terminator shares one location in both paths (`stepsAfter` is 0), so
    // its code is emitted once instead of duplicating the whole control-flow
    // subtree. Segment boundaries are an internal optimization: splitting the
    // terminator into its own segment keeps step accounting identical.
    const prefix = steps - terminator.step;
    const termLoc = `L = ${terminator.loc};`;
    if (prefix === 0) {
      this.line(termLoc);
      this.line('if (rt.steps + 1 > rt.limit) {');
      this.#indent += 1;
      this.line(`if (rt.steps >= rt.limit) rt.limitReached(F.locations[${terminator.loc}]);`);
      this.line('rt.steps += 1;');
      this.#indent -= 1;
      this.line('} else {');
      this.#indent += 1;
      this.line('rt.steps += 1;');
      this.#indent -= 1;
      this.line('}');
      return;
    }
    this.line(`if (rt.steps + ${steps} > rt.limit) {`);
    this.#indent += 1;
    for (const item of body) this.#emitExactItem(item);
    this.line(termLoc);
    this.line(`if (rt.steps >= rt.limit) rt.limitReached(F.locations[${terminator.loc}]);`);
    this.line('rt.steps += 1;');
    this.#indent -= 1;
    this.line('} else {');
    this.#indent += 1;
    this.line(`rt.steps += ${steps};`);
    for (const item of body) this.#emitFastItem(item);
    this.line(termLoc);
    this.#indent -= 1;
    this.line('}');
  }

  #emitFastItem(item: PlannedItem): void {
    if (item.inst === undefined) return;
    if (item.throwable) this.line(`L = ${item.loc};`);
    emitInstruction(item.inst, this);
  }

  #emitExactItem(item: PlannedItem): void {
    if (item.inst === undefined) return;
    // `L` precedes the budget check: an exhausted budget reports this item,
    // even when the item itself cannot throw.
    if (item.step === 1 || item.throwable) this.line(`L = ${item.exactLoc};`);
    if (item.step === 1) {
      this.line(`if (rt.steps >= rt.limit) rt.limitReached(F.locations[${item.exactLoc}]);`);
      this.line('rt.steps += 1;');
    }
    emitInstruction(item.inst, this);
  }

  #emitStepZero(item: PlannedItem): void {
    if (item.inst === undefined) return;
    if (item.throwable) this.line(`L = ${item.loc};`);
    emitInstruction(item.inst, this);
  }

  // --- Terminators ------------------------------------------------------

  #emitTerm(term: TermShape, block: MBlock): void {
    if (term.kind === 'native') {
      this.#emitNative(block);
      return;
    }
    if (term.kind === 'goto') {
      this.#emitGoto(term);
      return;
    }
    this.line(`if (${this.value(term.cond)}) {`);
    this.#indent += 1;
    this.#contexts.push({ kind: 'if', join: term.join });
    this.#emitSide(term.yes);
    this.#contexts.pop();
    this.#indent -= 1;
    this.line('} else {');
    this.#indent += 1;
    this.#contexts.push({ kind: 'if', join: term.join });
    this.#emitSide(term.no);
    this.#contexts.pop();
    this.#indent -= 1;
    this.line('}');
  }

  #emitSide(side: SideShape): void {
    this.#emitEdge(side.edge);
    if (side.kind === 'transfer') {
      this.#emitTransfer(side.transfer);
      return;
    }
    this.#emitStructured(side.body);
  }

  #emitSwitchTerm(block: MBlock): void {
    const term = block.term;
    switch (term.kind) {
      case 'jump':
        this.#emitEdge(term);
        this.line(`pc = ${term.target};`);
        this.line('continue Ldispatch;');
        return;
      case 'branch': {
        this.line(`if (${this.value(term.cond)}) {`);
        this.#indent += 1;
        this.#emitEdge(term.yes);
        this.line(`pc = ${term.yes.target};`);
        this.#indent -= 1;
        this.line('} else {');
        this.#indent += 1;
        this.#emitEdge(term.no);
        this.line(`pc = ${term.no.target};`);
        this.#indent -= 1;
        this.line('}');
        this.line('continue Ldispatch;');
        return;
      }
      default:
        this.#emitNative(block);
    }
  }

  #emitGoto(goto: GotoShape): void {
    this.#emitEdge(goto.edge);
    this.#emitTransfer(goto);
  }

  /** The control part of a transfer; the edge has already been assigned. */
  #emitTransfer(goto: GotoShape): void {
    switch (goto.mode) {
      case 'fallthrough':
        return;
      case 'continue':
        this.line(`continue ${goto.label};`);
        return;
      case 'break':
        this.line(`break ${goto.label};`);
        return;
      case 'stop': {
        for (let index = this.#contexts.length - 1; index >= 0; index -= 1) {
          const context = this.#contexts[index]!;
          if (context.kind === 'loop') {
            if (context.exit === goto.edge.target) {
              this.line(`break ${context.label};`);
              return;
            }
            throw new StructurizationError(
              `cannot leave loop ${context.label} for block ${goto.edge.target}`,
            );
          }
          if (context.join === goto.edge.target) return;
        }
        throw new StructurizationError(`unresolved stop at block ${goto.edge.target}`);
      }
    }
  }

  /** Edge arguments are a parallel copy: read everything before assigning. */
  #emitEdge(edge: { readonly target: number; readonly args: readonly ValueId[] }): void {
    const target = this.#block(edge.target);
    const params = target.params;
    if (edge.args.length !== params.length) {
      throw new Error(
        `JIT codegen: edge to block ${edge.target} has ${edge.args.length} arguments for ${params.length} parameters`,
      );
    }
    const parallel = edge.args.some((arg) => params.includes(arg));
    if (!parallel) {
      edge.args.forEach((arg, index) => {
        const param = params[index]!;
        if (param !== arg) this.line(`${this.value(param)} = ${this.value(arg)};`);
      });
      return;
    }
    const temps = edge.args.map(() => this.temp());
    edge.args.forEach((arg, index) => {
      this.line(`${temps[index]} = ${this.value(arg)};`);
    });
    temps.forEach((temp, index) => {
      this.line(`${this.value(params[index]!)} = ${temp};`);
    });
  }

  #emitNative(block: MBlock): void {
    const term = block.term;
    switch (term.kind) {
      case 'return':
        this.#emitReturn(term);
        return;
      case 'trap':
        this.line(`throw H.trap(${this.constantAt(term.code)});`);
        return;
      case 'dispatch':
        this.#emitDispatch(term);
        return;
      default:
        // `jump`/`branch` are always handled by the structured emitter.
        throw new Error(`JIT codegen: unexpected ${term.kind} terminator in native position`);
    }
  }

  #emitReturn(term: Extract<MTerm, { kind: 'return' }>): void {
    const values = term.values;
    if (values.length === 0) {
      this.line(`rt.depth = ${this.depthName};`);
      this.line('return;');
      return;
    }
    if (values.length === 1) {
      const value = this.value(values[0]!);
      this.line(`rt.depth = ${this.depthName};`);
      this.line(`return ${value};`);
      return;
    }
    values.forEach((id, index) => {
      this.line(`rt.ret[${index}] = ${this.value(id)};`);
    });
    this.line(`rt.depth = ${this.depthName};`);
    this.line('return;');
  }

  #emitDispatch(term: Extract<MTerm, { kind: 'dispatch' }>): void {
    const keys = term.key
      .map((id) =>
        isFloatValue(this.fn, id) && this.repOf(id) === 'U' ? this.numeric(id) : this.value(id),
      )
      .join(', ');
    const args = term.args.map((id) => this.boundary(id)).join(', ');
    const temp = this.temp();
    this.line('rt.beforeHost();');
    this.line(`${temp} = H.materialize(${term.provider}, [${keys}], [${args}]);`);
    this.line('rt.afterHost();');
    this.line(`rt.tailFn = ${temp}.fn; rt.tailArgs = ${temp}.args;`);
    this.line(`rt.depth = ${this.depthName};`);
    this.line('return rt.TAIL;');
  }

  // --- Assembly ---------------------------------------------------------

  #assemble(): EmittedFunction {
    const pool = this.pool;
    const frameIndex = pool.intern(this.frame);
    const lines: string[] = [];
    lines.push("'use strict';");
    const constants: string[] = [];
    for (const index of [...this.#used].sort((a, b) => a - b)) {
      constants.push(`K${index} = k[${index}]`);
    }
    if (constants.length > 0) lines.push(`const ${constants.join(', ')};`);
    for (const index of [...this.#resources].sort((a, b) => a - b)) {
      lines.push(`const S${index} = H.res[${index}];`);
    }
    lines.push(`const F = k[${frameIndex}];`);
    const params = this.fn.params.map((_type, index) => `p${index}`);
    lines.push(`return function f${this.fn.functionIndex}(${params.join(', ')}) {`);
    lines.push(`${INDENT}const d = rt.depth;`);
    const deepArgs = [String(this.fn.functionIndex), ...params].join(', ');
    lines.push(`${INDENT}if (d >= rt.maxDepth) return rt.deep(${deepArgs});`);
    lines.push(`${INDENT}rt.depth = d + 1;`);
    lines.push(`${INDENT}let L = -1;`);
    if (this.#temps > 0) {
      const temps = Array.from({ length: this.#temps }, (_value, index) => `t${index} = 0`);
      lines.push(`${INDENT}let ${temps.join(', ')};`);
    }
    const locals = this.fn.values.map((value) => `v${value.id} = ${initialValue(value.rep)}`);
    if (this.shape === undefined) {
      lines.push(`${INDENT}let pc = -1;`);
    }
    if (locals.length > 0) lines.push(`${INDENT}let ${locals.join(', ')};`);
    const entry = this.#block(0);
    entry.params.forEach((param, index) => {
      lines.push(`${INDENT}${this.value(param)} = p${index};`);
    });
    lines.push(`${INDENT}try {`);
    for (const line of this.#lines) lines.push(`${INDENT}${line}`);
    lines.push(`${INDENT}} catch (e) {`);
    lines.push(`${INDENT}${INDENT}rt.depth = d;`);
    lines.push(`${INDENT}${INDENT}throw rt.unwind(e, L, F);`);
    lines.push(`${INDENT}}`);
    lines.push('};');
    lines.push(`//# sourceURL=mica-ir-jit/f${this.fn.functionIndex}.js`);
    return {
      source: lines.join('\n'),
      constants: pool.values,
      frame: this.frame,
      structured: this.shape !== undefined,
      ...(this.fallback === undefined ? {} : { fallback: this.fallback }),
    };
  }
}

function initialValue(rep: string): string {
  switch (rep) {
    case 'bool':
      return 'false';
    case 'D':
      return '0.0';
    case 'U':
      return '0';
    default:
      return '0';
  }
}

function isFloatValue(fn: MFunction, id: ValueId): boolean {
  const type = fn.values[id]!.type;
  return type === 'f32' || type === 'f64';
}

function tryStructurize(fn: MFunction): {
  readonly shape: StructuredProgram | undefined;
  readonly reason: string | undefined;
} {
  try {
    return { shape: structurize(fn), reason: undefined };
  } catch (error) {
    if (error instanceof StructurizationError) {
      return { shape: undefined, reason: error.message };
    }
    throw error;
  }
}

/** Generate the factory body of one function. */
export function emitFunction(fn: MFunction, env: EmitEnv): EmittedFunction {
  return new Emitter(fn, env).emit();
}

/** The opcode set the emitter understands; used by tests and later passes. */
export const SUPPORTED_OPS: ReadonlySet<Op> = new Set(Object.values(Op));
