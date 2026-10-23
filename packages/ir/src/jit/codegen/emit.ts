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
import type { ArtifactState, DispatchKey, ProviderDispatchInfo } from '../dispatch-ic';
import { EFFECT_INFO } from '../effects';
import type { FunctionSummary } from '../effects';
import { Op } from '../mir';
import type { LayoutProfile, MBlock, MFunction, MInst, MPromotion, MTerm, ValueId } from '../mir';
import { analyzeRepresentation } from '../repr';
import type { RegionPromotion } from '../region';
import { collectRegionPromotions } from '../region';
import type { JitFrame } from '../runtime-core';
import { isFloatType } from '../../runtime';
import {
  ConstantPool,
  emitFastStateWrite,
  emitInstruction,
  emitPromotionSpill,
  fastScalarLoad,
  inlineConstantText,
  numberLiteral,
  promotionDirty,
  promotionLocal,
} from './ops';
import type { OpsContext, PromotionContext, RegionPromotionNames } from './ops';
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
  /** Artifact state of the function being compiled (J14 checkpoint fast path). */
  readonly artifactState?: ArtifactState;
  /** Provider metadata for dispatch ICs and region keys (J14). */
  readonly providers?: readonly ProviderDispatchInfo[];
  /** Dispatch inline caches and jump cache; default on. */
  readonly dispatchIC?: boolean;
  /** Checkpoint epoch guard; default on. */
  readonly checkpointFast?: boolean;
  /** Tier-2 block weights; hotter blocks are emitted first (J13). */
  readonly layout?: LayoutProfile;
  /** Emit the tier-1 promotion counter in the function prologue (J13). */
  readonly tierUp?: boolean;
  /** Debug: force the `switch (pc)` form. */
  readonly forceSwitch?: boolean;
  /**
   * Emit the exact (per-item) budget copy. Set to `false` only when the step
   * budget is provably unreachable, which removes half of the generated code
   * from every segment (default: `true`).
   */
  readonly exactSteps?: boolean;
}

/** Per-member emission options for {@link emitRegion} (J14). */
export interface RegionEmitterOptions {
  /** Runtime state constant name (`RS`). */
  readonly runtimeName: string;
  /** Region cursor variable (`Rcur`). */
  readonly cursorName: string;
  /** Loop label that member dispatches `continue`. */
  readonly label: string;
  readonly memberIndex: number;
  readonly memberCount: number;
  /** Artifact-state constant declared at the top of this member's case. */
  readonly stateName: string;
  readonly keyTypes: readonly ScalarType[];
  readonly providerIndex: number;
  /** Member keys, used by `switch`/`if` matching. */
  readonly keys: readonly (readonly DispatchKey[])[];
  /** Region argument names (`a0`, `a1`, ...). */
  readonly parameterNames: readonly string[];
  /** Local-variable prefix for member `index` (`m0_`). */
  readonly memberPrefix: (index: number) => string;
  /** Region-wide promoted state locations (shared locals). */
  readonly promotions: readonly RegionPromotion[];
  /** Model memory index → region promotion id. */
  readonly promotionByMemory: ReadonlyMap<number, number>;
}

interface EmitterOptions {
  /** Prefix for every generated local and label (region members). */
  readonly prefix?: string;
  /** Shared constant pool (region members). */
  readonly pool?: ConstantPool;
  /** Skip the function prologue parameter copy (region members). */
  readonly skipEntryParams?: boolean;
  /** Region dispatch mode. */
  readonly region?: RegionEmitterOptions;
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
  readonly #options: EmitterOptions;
  readonly #prefix: string;
  readonly #used = new Set<number>();
  readonly #resources = new Set<number>();
  readonly #blocks: Map<number, MBlock>;
  readonly #sites: { readonly providerIndex: number }[] = [];
  /** Region-wide state promotions (J14); `undefined` outside regions. */
  readonly regionPromotion: ((memory: number) => RegionPromotionNames | undefined) | undefined;
  /** `false` when the step budget provably cannot be reached. */
  readonly #exactSteps: boolean;
  /** Single-definition integer/boolean constants, inlined at every use. */
  readonly #constText = new Map<ValueId, string>();
  /** How many instructions (or block parameters) define each value. */
  readonly #definitions: Map<ValueId, number>;
  /** Load instructions whose result is substituted at every use. */
  readonly #inlineInst = new Map<MInst, string>();
  #temps = 0;
  #indent = 0;
  #lines: string[] = [];
  readonly #contexts: Context[] = [];
  readonly depthName = 'd';

  constructor(fn: MFunction, env: EmitEnv, options: EmitterOptions = {}) {
    this.fn = fn;
    this.#env = env;
    this.#options = options;
    this.#prefix = options.prefix ?? '';
    this.le = env.littleEndian;
    this.#exactSteps = env.exactSteps !== false;
    this.plan = planFunction(fn);
    this.frame = Object.freeze({
      locations: Object.freeze([...this.plan.locations]),
      stepsAfter: this.plan.stepsAfter,
      parent: this.plan.parent,
      inlineFrames: this.plan.inlineFrames,
    });
    this.pool = options.pool ?? new ConstantPool(env.constants);
    this.#blocks = new Map(fn.blocks.map((block) => [block.id, block]));
    this.#definitions = new Map<ValueId, number>();
    for (const block of fn.blocks) {
      for (const param of block.params) {
        this.#definitions.set(param, (this.#definitions.get(param) ?? 0) + 1);
      }
      for (const inst of block.insts) {
        for (const result of inst.results) {
          this.#definitions.set(result, (this.#definitions.get(result) ?? 0) + 1);
        }
      }
    }
    const region = options.region;
    if (region !== undefined && region.promotions.length > 0) {
      this.regionPromotion = (memory) => {
        const id = region.promotionByMemory.get(memory);
        if (id === undefined) return undefined;
        const promotion = region.promotions[id]!;
        return { local: `rp${id}`, dirty: `rp${id}d`, type: promotion.type };
      };
    } else {
      this.regionPromotion = undefined;
    }
    if (env.forceSwitch === true) {
      this.shape = undefined;
      this.fallback = 'switch mode requested';
    } else {
      const attempt = tryStructurize(fn);
      this.shape = attempt.shape;
      this.fallback = attempt.reason;
    }
    this.#collectInlinableCopies(fn);
  }

  /**
   * Mark promoted-location loads whose result can replace the value directly.
   *
   * A load is inlined only when the value has exactly one definition, every use
   * stays in the same block after the load, and nothing between the load and
   * its last use can change the backing local (a host boundary reloads
   * promotions, and a store to the same location overwrites it). Otherwise the
   * snapshot the instruction materializes is load-bearing.
   */
  #collectInlinableCopies(fn: MFunction): void {
    interface UseInfo {
      block: number;
      last: number;
      count: number;
      crossBlock: boolean;
    }
    const uses = new Map<ValueId, UseInfo>();
    const note = (id: ValueId, block: number, index: number): void => {
      const entry = uses.get(id);
      if (entry === undefined) {
        uses.set(id, { block, last: index, count: 1, crossBlock: false });
        return;
      }
      entry.count += 1;
      if (entry.block !== block) entry.crossBlock = true;
      else if (index > entry.last) entry.last = index;
    };
    // Terminator operands are conservatively treated as cross-block uses: a
    // value handed to a successor must keep its snapshot semantics.
    const termRefs = new Set<ValueId>();
    for (const block of fn.blocks) {
      const term = block.term;
      if (term.kind === 'return') {
        for (const id of term.values) termRefs.add(id);
      } else if (term.kind === 'dispatch') {
        for (const id of term.key) termRefs.add(id);
        for (const id of term.args) termRefs.add(id);
      } else if (term.kind === 'branch') {
        termRefs.add(term.cond);
        for (const id of term.yes.args) termRefs.add(id);
        for (const id of term.no.args) termRefs.add(id);
      } else if (term.kind === 'jump') {
        for (const id of term.args) termRefs.add(id);
      }
      block.insts.forEach((inst, index) => {
        for (const arg of inst.args) note(arg, block.id, index);
      });
    }
    for (const block of fn.blocks) {
      block.insts.forEach((inst, index) => {
        const result = inst.results[0];
        if (result === undefined || inst.results.length !== 1) return;
        if ((this.#definitions.get(result) ?? 0) !== 1) return;
        let text: string | undefined;
        let memory: number | undefined;
        if (inst.op === Op.PromoteLoad) {
          text = promotionLocal(inst.refs[0]!);
        } else if (inst.op === Op.StateLoad) {
          memory = inst.refs[0];
          text = this.regionPromotion?.(inst.refs[0]!)?.local;
        }
        if (text === undefined) return;
        const info = uses.get(result);
        if (info === undefined || info.crossBlock || info.block !== block.id) return;
        if (termRefs.has(result)) return;
        for (let cursor = index + 1; cursor <= info.last; cursor += 1) {
          const next = block.insts[cursor]!;
          if (EFFECT_INFO[next.op].host) return;
          if (
            next.op === Op.PromoteLoad ||
            next.op === Op.PromoteStore ||
            next.op === Op.PromoteReload ||
            next.op === Op.Spill
          ) {
            return;
          }
          if (next.op === Op.StateStore && next.refs[0] === memory) return;
          if (next.op === Op.StateLoad && next.refs[0] === memory) return;
        }
        this.#inlineInst.set(inst, text);
      });
    }
  }

  /** The planned frame, used by the region assembler. */
  get savedFrame(): JitFrame {
    return this.frame;
  }

  /** Number of generated temporaries (region assembler declarations). */
  get tempCount(): number {
    return this.#temps;
  }

  /** Constant indices referenced by this emitter (union across region members). */
  get usedConstants(): readonly number[] {
    return [...this.#used];
  }

  /** Resource indices referenced by this emitter (union across region members). */
  get usedResources(): readonly number[] {
    return [...this.#resources];
  }

  /** Emitted body lines (region assembler). */
  get bodyLines(): readonly string[] {
    return this.#lines;
  }

  /** Run `action` into a fresh line buffer (region prologue/catch snippets). */
  captureLines(action: () => void): string[] {
    const savedLines = this.#lines;
    const savedIndent = this.#indent;
    this.#lines = [];
    this.#indent = 0;
    try {
      action();
      return this.#lines;
    } finally {
      this.#lines = savedLines;
      this.#indent = savedIndent;
    }
  }

  /** Load every shared region promotion from storage (region entry). */
  sharedPromotionReloadLines(): string[] {
    return this.captureLines(() => this.#emitSharedReload());
  }

  /** Write back every dirty shared region promotion (region exit/catch). */
  sharedPromotionSpillLines(): string[] {
    return this.captureLines(() => this.#emitSharedSpill());
  }

  #sharedPromotions(): readonly RegionPromotion[] {
    return this.#options.region?.promotions ?? [];
  }

  #emitSharedReload(): void {
    for (const promotion of this.#sharedPromotions()) {
      const record = this.resource(promotion.memory);
      this.line(`rp${promotion.id} = ${fastScalarLoad(this, record, '0', promotion.type)};`);
      this.line(`rp${promotion.id}d = 0;`);
    }
  }

  #emitSharedSpill(): void {
    for (const promotion of this.#sharedPromotions()) {
      const record = this.resource(promotion.memory);
      this.line(`if (rp${promotion.id}d !== 0) {`);
      this.#indent += 1;
      emitFastStateWrite(this, record, promotion.type, `rp${promotion.id}`);
      this.line(`  rp${promotion.id}d = 0;`);
      this.#indent -= 1;
      this.line('}');
    }
  }

  /** Local declarations for every SSA value and promotion (region members). */
  localDeclarations(): string[] {
    const locals: string[] = [];
    for (const value of this.fn.values) {
      // Inlined constants have no local of their own.
      if (this.#constText.has(value.id)) continue;
      locals.push(`${this.value(value.id)} = ${initialValue(value.rep)}`);
    }
    for (const promotion of this.fn.promotions) {
      // Initialize from the backing view in the prologue: the entry block can
      // be a loop header, so an entry instruction would reload every iteration.
      locals.push(
        `${promotionLocal(promotion.id)} = ${fastScalarLoad(
          this,
          this.resource(promotion.memory),
          String(promotion.index ?? 0),
          promotion.type,
        )}`,
      );
      locals.push(`${promotionDirty(promotion.id)} = 0`);
    }
    return locals;
  }

  /** Entry-block parameter ids, in signature order. */
  get entryParams(): readonly ValueId[] {
    return this.#block(0).params;
  }

  /** Region-local name of one SSA value. */
  regionValue(member: number, id: ValueId): string {
    return `${this.#options.region?.memberPrefix(member) ?? ''}v${id}`;
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
    const name = `${this.#prefix}t${this.#temps}`;
    this.#temps += 1;
    return name;
  }

  value(id: ValueId): string {
    const constant = this.#constText.get(id);
    if (constant !== undefined) return constant;
    return `${this.#prefix}v${id}`;
  }

  /** Region-wide labels are prefixed so members cannot collide. */
  #label(name: string): string {
    return `${this.#prefix}${name}`;
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

  promotion(id: number): MPromotion {
    const promotion = this.fn.promotions[id];
    if (promotion === undefined) {
      throw new Error(`JIT codegen: unknown promoted location ${id}`);
    }
    return promotion;
  }

  hasTransfer(callee: number): boolean {
    return this.#env.summaries?.get(callee)?.hasTransfer === true;
  }

  get artifactDependencies(): readonly unknown[] | undefined {
    return this.#env.artifactDependencies;
  }

  get checkpointFast(): boolean {
    return this.#env.checkpointFast !== false;
  }

  artifactStateName(): string | undefined {
    if (this.#env.artifactState === undefined) return undefined;
    return this.#options.region?.stateName ?? 'ST';
  }

  // --- Driver -----------------------------------------------------------

  emit(): EmittedFunction {
    this.emitBody();
    return this.#assemble();
  }

  /**
   * Emit only the block bodies (no function prologue). Region compilation
   * embeds several bodies in one function and shares this exact emitter, so
   * instruction templates, step batching and branch structuring stay single
   * sourced.
   */
  emitBody(): void {
    if (this.#options.region !== undefined && this.#env.artifactState !== undefined) {
      this.line(
        `const ${this.#options.region.stateName} = ${this.constant(this.#env.artifactState)};`,
      );
    }
    if (this.shape === undefined) this.line(`let ${this.#prefix}pc = -1;`);
    if (this.shape !== undefined) {
      this.#emitStructured(this.shape.nodes);
    } else {
      this.#emitSwitch();
    }
  }

  #emitStructured(nodes: readonly StructuredNode[]): void {
    for (const node of nodes) {
      if (node.kind === 'block') {
        this.#emitBlock(node.id, node.term);
        continue;
      }
      this.line(`${this.#label(node.label)}: for (;;) {`);
      this.#indent += 1;
      this.#contexts.push({ kind: 'loop', exit: node.exit, label: this.#label(node.label) });
      this.#emitStructured(node.body);
      this.#contexts.pop();
      this.#indent -= 1;
      this.line('}');
    }
  }

  #emitSwitch(): void {
    // Only reachable blocks; unreachable ones contribute no code.
    const analysis = analyzeCFG(this.fn);
    const pc = `${this.#prefix}pc`;
    const dispatchLabel = this.#label('Ldispatch');
    this.line(`${pc} = ${analysis.cfg.entry};`);
    this.line(`${dispatchLabel}: for (;;) {`);
    this.#indent += 1;
    this.line(`switch (${pc}) {`);
    this.#indent += 1;
    // Tier-2 layout bias: emit the hottest case first. Case order has no
    // semantic meaning (the entry assignment selects the start block).
    const weights = this.#env.layout?.blockWeights;
    const position = new Map(analysis.cfg.order.map((id, index) => [id, index]));
    const order =
      weights === undefined
        ? analysis.cfg.order
        : [...analysis.cfg.order].sort(
            (left, right) =>
              (weights.get(right) ?? 0) - (weights.get(left) ?? 0) ||
              (position.get(left) ?? 0) - (position.get(right) ?? 0),
          );
    for (const id of order) {
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

    if (!this.#exactSteps) {
      // The step budget is provably unreachable (unbounded `maxSteps`, no step
      // observer and no host budget), so only the fast copy is emitted.
      if (steps !== 0) this.line(`rt.steps += ${steps};`);
      for (const item of body) this.#emitFastItem(item);
      if (terminator !== undefined && terminator.step === 1) {
        this.line(`L = ${terminator.loc};`);
      }
      return;
    }

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
    // A synthetic step-0 jump enters an inlined body (J13); it consumes no
    // source step and cannot exhaust the budget.
    const stepped = terminator.step === 1;
    if (prefix === 0) {
      if (!stepped) {
        // A step-0 terminator still must run the step-0 instructions that
        // precede it (promotion writebacks, bounds guards).
        for (const item of body) this.#emitStepZero(item);
        return;
      }
      if (body.length === 0) {
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
      this.line('if (rt.steps + 1 > rt.limit) {');
      this.#indent += 1;
      for (const item of body) this.#emitExactItem(item);
      this.line(termLoc);
      this.line(`if (rt.steps >= rt.limit) rt.limitReached(F.locations[${terminator.loc}]);`);
      this.line('rt.steps += 1;');
      this.#indent -= 1;
      this.line('} else {');
      this.#indent += 1;
      for (const item of body) this.#emitFastItem(item);
      this.line(termLoc);
      this.line('rt.steps += 1;');
      this.#indent -= 1;
      this.line('}');
      return;
    }
    this.line(`if (rt.steps + ${steps} > rt.limit) {`);
    this.#indent += 1;
    for (const item of body) this.#emitExactItem(item);
    if (stepped) {
      this.line(termLoc);
      this.line(`if (rt.steps >= rt.limit) rt.limitReached(F.locations[${terminator.loc}]);`);
      this.line('rt.steps += 1;');
    }
    this.#indent -= 1;
    this.line('} else {');
    this.#indent += 1;
    this.line(`rt.steps += ${steps};`);
    for (const item of body) this.#emitFastItem(item);
    if (stepped) this.line(termLoc);
    this.#indent -= 1;
    this.line('}');
  }

  /**
   * Emit one instruction. In a region, host code is a promotion barrier:
   * dirty shared locals are written back first and reloaded afterwards, so the
   * host observes exactly the reference storage contents.
   */
  #emitItemInstruction(inst: MInst): void {
    if (this.#inlineConstant(inst)) return;
    const copy = this.#inlineInst.get(inst);
    if (copy !== undefined) {
      this.#constText.set(inst.results[0]!, copy);
      return;
    }
    const barrier =
      this.#sharedPromotions().length > 0 &&
      (EFFECT_INFO[inst.op].host || inst.op === Op.Checkpoint);
    if (barrier) this.#emitSharedSpill();
    emitInstruction(inst, this);
    if (barrier) this.#emitSharedReload();
  }

  /**
   * Fold a single-definition `const` into every use instead of materializing a
   * local. The value never exists at run time, so it costs neither a statement
   * nor a slot in the generated function.
   */
  #inlineConstant(inst: MInst): boolean {
    const result = inst.results[0];
    if (result === undefined || inst.results.length !== 1) return false;
    const text = inlineConstantText(inst);
    if (text === undefined || isFloatValue(this.fn, result)) return false;
    if ((this.#definitions.get(result) ?? 0) !== 1) return false;
    this.#constText.set(result, text);
    return true;
  }

  #emitFastItem(item: PlannedItem): void {
    if (item.inst === undefined) return;
    if (item.throwable) this.line(`L = ${item.loc};`);
    this.#emitItemInstruction(item.inst);
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
    this.#emitItemInstruction(item.inst);
  }

  #emitStepZero(item: PlannedItem): void {
    if (item.inst === undefined) return;
    if (item.throwable) this.line(`L = ${item.loc};`);
    this.#emitItemInstruction(item.inst);
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
    // Tier-2 layout bias: put the hotter arm first (`if` rather than `else`).
    const invert = this.#invertBranch(term);
    const first = invert ? term.no : term.yes;
    const second = invert ? term.yes : term.no;
    this.line(`if (${invert ? '!' : ''}${this.value(term.cond)}) {`);
    this.#indent += 1;
    this.#contexts.push({ kind: 'if', join: term.join });
    this.#emitSide(first);
    this.#contexts.pop();
    this.#indent -= 1;
    this.line('} else {');
    this.#indent += 1;
    this.#contexts.push({ kind: 'if', join: term.join });
    this.#emitSide(second);
    this.#contexts.pop();
    this.#indent -= 1;
    this.line('}');
  }

  #invertBranch(term: Extract<TermShape, { kind: 'branch' }>): boolean {
    const weights = this.#env.layout?.blockWeights;
    if (weights === undefined) return false;
    return (weights.get(term.no.edge.target) ?? 0) > (weights.get(term.yes.edge.target) ?? 0);
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
    const pc = `${this.#prefix}pc`;
    const dispatchLabel = this.#label('Ldispatch');
    switch (term.kind) {
      case 'jump':
        this.#emitEdge(term);
        this.line(`${pc} = ${term.target};`);
        this.line(`continue ${dispatchLabel};`);
        return;
      case 'branch': {
        this.line(`if (${this.value(term.cond)}) {`);
        this.#indent += 1;
        this.#emitEdge(term.yes);
        this.line(`${pc} = ${term.yes.target};`);
        this.#indent -= 1;
        this.line('} else {');
        this.#indent += 1;
        this.#emitEdge(term.no);
        this.line(`${pc} = ${term.no.target};`);
        this.#indent -= 1;
        this.line('}');
        this.line(`continue ${dispatchLabel};`);
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
        this.line(`continue ${this.#label(goto.label ?? 'L0')};`);
        return;
      case 'break':
        this.line(`break ${this.#label(goto.label ?? 'L0')};`);
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
    // A region exit must publish dirty promoted values before returning.
    if (this.#options.region !== undefined) this.#emitSharedSpill();
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

  /** Key expressions in the provider's normalized representation. */
  #keyExpressions(term: Extract<MTerm, { kind: 'dispatch' }>): string[] {
    return term.key.map((id) =>
      isFloatValue(this.fn, id) && this.repOf(id) === 'U' ? this.numeric(id) : this.value(id),
    );
  }

  /** Boundary-argument expressions passed to `H.materialize`. */
  #boundaryArguments(term: Extract<MTerm, { kind: 'dispatch' }>): string[] {
    return term.args.map((id) => this.boundary(id));
  }

  /** MIR-representation arguments for a direct artifact call. */
  #mirArguments(term: Extract<MTerm, { kind: 'dispatch' }>): string[] {
    return term.args.map((id) => this.value(id));
  }

  /**
   * Convert boundary arguments for a direct call into the artifact's MIR
   * representation. Only floats differ; every other scalar is identity.
   */
  #tailArguments(params: readonly ScalarType[], boundary: readonly string[]): string {
    return params
      .map((type, index) => {
        const value = boundary[index] ?? 'undefined';
        return isFloatType(type) ? `H.argument(${this.typeConstant(type)}, ${value})` : value;
      })
      .join(', ');
  }

  #providerInfo(providerIndex: number): ProviderDispatchInfo | undefined {
    return this.#env.providers?.[providerIndex];
  }

  #emitDispatch(term: Extract<MTerm, { kind: 'dispatch' }>): void {
    if (this.#options.region !== undefined) {
      this.#emitRegionDispatch(term);
      return;
    }
    const info = this.#providerInfo(term.provider);
    const keyExprs = this.#keyExpressions(term);
    const boundary = this.#boundaryArguments(term);
    const temp = this.temp();
    const site =
      info !== undefined && this.#env.dispatchIC !== false
        ? this.#newSite(term.provider)
        : undefined;
    if (site !== undefined) {
      const index = `IC${site}`;
      for (let slot = 0; slot < 4; slot += 1) {
        const guards = [
          `${index}.states[${slot}] !== undefined`,
          ...keyExprs.map((expr, position) =>
            this.#keyCompare(
              `${index}.keys[${slot}][${position}]`,
              expr,
              info!.keyTypes[position]!,
            ),
          ),
          `${index}.es[${slot}] === H.ctl.epoch`,
          `${index}.cs[${slot}] === H.prov.cacheEpoch`,
        ];
        this.line(`if (${guards.join(' && ')}) {`);
        this.#indent += 1;
        this.line(`${index}.hits += 1;`);
        this.line(`${temp} = ${index}.states[${slot}];`);
        this.#emitHitTail(temp, info!.params, boundary);
        this.#indent -= 1;
        this.line('}');
      }
      this.line(
        `${temp} = H.ic.jumpHit(${term.provider}, [${keyExprs.join(', ')}], H.ctl.epoch, ` +
          'H.prov.cacheEpoch);',
      );
      this.line(`if (${temp} !== undefined) {`);
      this.#indent += 1;
      this.#emitHitTail(temp, info!.params, boundary);
      this.#indent -= 1;
      this.line('}');
    }
    this.line('rt.beforeHost();');
    this.line(
      `${temp} = H.materialize(${term.provider}, [${keyExprs.join(', ')}], [${boundary.join(', ')}]);`,
    );
    this.line('rt.afterHost();');
    if (site !== undefined) {
      this.line(
        `H.ic.record(IC${site}, [${keyExprs.join(', ')}], ${temp}.state, H.ctl.epoch, ` +
          'H.prov.cacheEpoch);',
      );
    }
    this.line(`rt.tailFn = ${temp}.fn; rt.tailArgs = ${temp}.args; rt.tailState = ${temp}.state;`);
    this.line(`rt.depth = ${this.depthName};`);
    this.line('return rt.TAIL;');
  }

  /** Emit the direct-call part of an IC hit; `state` is a temp name. */
  #emitHitTail(state: string, params: readonly ScalarType[], boundary: readonly string[]): void {
    this.line(`${state}.validatedEpoch = H.ctl.epoch;`);
    this.line(`${state}.storageEpoch = H.ctl.epoch;`);
    this.line(`${state}.providerEpoch = H.prov.cacheEpoch;`);
    this.line(`rt.tailFn = ${state}.compiled.fn;`);
    this.line(`rt.tailArgs = [${this.#tailArguments(params, boundary)}];`);
    this.line(`rt.tailState = ${state};`);
    this.line(`rt.depth = ${this.depthName};`);
    this.line('return rt.TAIL;');
  }

  #newSite(providerIndex: number): number {
    const id = this.#sites.length;
    this.#sites.push({ providerIndex });
    return id;
  }

  #keyCompare(left: string, right: string, type: ScalarType): string {
    // Object.is reproduces normalizeKey's bit identity: NaN == NaN and
    // 0 != -0 for floats; every other scalar uses strict equality.
    return isFloatType(type) ? `Object.is(${left}, ${right})` : `${left} === ${right}`;
  }

  /**
   * Region dispatch (J14): a key + epoch match turns the transfer into a
   * `cur = j; continue` assignment; every other path fills the generic
   * `materialize` fallback. If the materialized artifact happens to be a
   * member, the region stays alive and adopts it.
   */
  #emitRegionDispatch(term: Extract<MTerm, { kind: 'dispatch' }>): void {
    const region = this.#options.region!;
    const rs = region.runtimeName;
    const cursor = region.cursorName;
    const keyExprs = this.#keyExpressions(term);
    const boundary = this.#boundaryArguments(term);
    const mirArgs = this.#mirArguments(term);
    const direct = (member: number): void => {
      this.#emitMemberEntry(member, rs, cursor, region, mirArgs);
    };
    if (keyExprs.length === 1 && !isFloatType(region.keyTypes[0]!)) {
      // Single integer/bool key: a switch over *literal* member keys. The keys
      // are fixed when the region is compiled, so the host can turn a dense
      // case set into a jump table instead of comparing computed expressions.
      this.line(`switch (${keyExprs[0]}) {`);
      this.#indent += 1;
      for (let member = 0; member < region.memberCount; member += 1) {
        const key = region.keys[member]![0];
        this.line(`case ${typeof key === 'boolean' ? String(key) : numberLiteral(key as number)}:`);
        this.#indent += 1;
        this.line(
          `if (H.ctl.epoch === ${rs}.es[${member}] && ` +
            `H.prov.cacheEpoch === ${rs}.cs[${member}]) {`,
        );
        this.#indent += 1;
        direct(member);
        this.#indent -= 1;
        this.line('}');
        this.#indent -= 1;
        this.line('break;');
      }
      this.#indent -= 1;
      this.line('}');
    } else {
      for (let member = 0; member < region.memberCount; member += 1) {
        const conditions = [
          ...keyExprs.map((expr, position) =>
            this.#keyCompare(
              `${rs}.keys[${member}][${position}]`,
              expr,
              region.keyTypes[position]!,
            ),
          ),
          `H.ctl.epoch === ${rs}.es[${member}]`,
          `H.prov.cacheEpoch === ${rs}.cs[${member}]`,
        ];
        this.line(`if (${conditions.join(' && ')}) {`);
        this.#indent += 1;
        direct(member);
        this.#indent -= 1;
        this.line('}');
      }
    }
    const temp = this.temp();
    // A region exit (or re-entry through materialize) is a host boundary: all
    // dirty shared promotions must be visible to the provider cache first.
    this.#emitSharedSpill();
    const info = this.#providerInfo(term.provider);
    if (info !== undefined && this.#env.dispatchIC !== false) {
      // Hot exit: the jump cache holds the target artifact at the current
      // epochs, so the transfer needs no provider-cache round trip.
      this.line(
        `${temp} = H.ic.jumpHit(${term.provider}, [${keyExprs.join(', ')}], H.ctl.epoch, ` +
          'H.prov.cacheEpoch);',
      );
      this.line(`if (${temp} !== undefined) {`);
      this.#indent += 1;
      this.#emitHitTail(temp, info.params, boundary);
      this.#indent -= 1;
      this.line('}');
    }
    this.line('rt.beforeHost();');
    this.line(
      `${temp} = H.materialize(${term.provider}, [${keyExprs.join(', ')}], [${boundary.join(', ')}]);`,
    );
    this.line('rt.afterHost();');
    for (let member = 0; member < region.memberCount; member += 1) {
      this.line(`if (${temp}.state === ${rs}.states[${member}]) {`);
      this.#indent += 1;
      this.line(`${rs}.es[${member}] = H.ctl.epoch;`);
      this.line(`${rs}.cs[${member}] = H.prov.cacheEpoch;`);
      this.line(`${rs}.states[${member}].validatedEpoch = H.ctl.epoch;`);
      region.parameterNames.forEach((name, index) => {
        this.line(`${name} = ${temp}.args[${index}];`);
      });
      this.line(`${cursor} = ${member};`);
      this.line(`continue ${region.label};`);
      this.#indent -= 1;
      this.line('}');
    }
    this.line(`rt.tailFn = ${temp}.fn; rt.tailArgs = ${temp}.args; rt.tailState = ${temp}.state;`);
    this.line(`rt.depth = ${this.depthName};`);
    this.line('return rt.TAIL;');
  }

  /**
   * Write the next member's arguments into the shared region parameters and
   * loop back. The case prologue copies those into the member's own locals, so
   * a direct jump re-enters the member exactly like a fresh region call.
   */
  #emitMemberEntry(
    member: number,
    rs: string,
    cursor: string,
    region: RegionEmitterOptions,
    sources: readonly string[],
  ): void {
    region.parameterNames.forEach((name, index) => {
      this.line(`${name} = ${sources[index] ?? 'undefined'};`);
    });
    this.line(`${rs}.states[${member}].validatedEpoch = H.ctl.epoch;`);
    this.line(`${cursor} = ${member};`);
    this.line(`continue ${region.label};`);
  }

  // --- Assembly ---------------------------------------------------------

  #assemble(): EmittedFunction {
    const pool = this.pool;
    // Catch-block writeback runs before any promotion-relevant stack is torn
    // down; generating it first also registers the resources it touches.
    const catchSpillLines: string[] = [];
    if (this.fn.promotions.length > 0) {
      const catchContext: PromotionContext = {
        le: this.le,
        line: (text) => catchSpillLines.push(`${INDENT}${INDENT}${text}`),
        resource: (index) => this.resource(index),
        constant: (value) => this.constant(value),
        memory: (index) => this.memory(index),
        value: (id) => this.value(id),
        numeric: (id) => this.numeric(id),
        boundary: (id) => this.boundary(id),
        typeOf: (id) => this.typeOf(id),
        repOf: (id) => this.repOf(id),
        promotion: (id) => this.promotion(id),
      };
      emitPromotionSpill(
        catchContext,
        this.fn.promotions.map((promotion) => promotion.id),
      );
    }
    const frameIndex = pool.intern(this.frame);
    // Intern before the constant list is assembled: site/state references are
    // part of the factory prelude and must have declarations.
    const artifactStateRef =
      this.#env.artifactState === undefined ? undefined : this.constant(this.#env.artifactState);
    const siteFromRefs = this.#sites.map(() =>
      this.#env.artifactState === undefined ? undefined : this.constant(this.#env.artifactState),
    );
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
    if (artifactStateRef !== undefined) {
      lines.push(`const ST = ${artifactStateRef};`);
    }
    for (const [index, site] of this.#sites.entries()) {
      const fromRef = siteFromRefs[index] ?? 'undefined';
      lines.push(`const IC${index} = H.ic.site(${site.providerIndex}, ${fromRef});`);
    }
    const params = this.fn.params.map((_type, index) => `p${index}`);
    lines.push(`return function f${this.fn.functionIndex}(${params.join(', ')}) {`);
    lines.push(`${INDENT}const d = rt.depth;`);
    const deepArgs = [String(this.fn.functionIndex), ...params].join(', ');
    lines.push(`${INDENT}if (d >= rt.maxDepth) return rt.deep(${deepArgs});`);
    if (this.#env.tierUp === true && this.#options.region === undefined) {
      const index = this.fn.functionIndex;
      // Tier-1 entry counter (J13). Promotes synchronously; the current
      // activation keeps running this tier-1 body (no OSR).
      lines.push(
        `${INDENT}if (rt.counters[${index}] >= 0 && ++rt.counters[${index}] >= rt.tierUpThreshold) rt.tierUp(${index});`,
      );
    }
    lines.push(`${INDENT}rt.depth = d + 1;`);
    lines.push(`${INDENT}let L = -1;`);
    if (this.#temps > 0) {
      const temps = Array.from({ length: this.#temps }, (_value, index) => `t${index} = 0`);
      lines.push(`${INDENT}let ${temps.join(', ')};`);
    }
    const locals = this.localDeclarations();
    if (locals.length > 0) lines.push(`${INDENT}let ${locals.join(', ')};`);
    const entry = this.#block(0);
    entry.params.forEach((param, index) => {
      lines.push(`${INDENT}${this.value(param)} = p${index};`);
    });
    lines.push(`${INDENT}try {`);
    for (const line of this.#lines) lines.push(`${INDENT}${line}`);
    lines.push(`${INDENT}} catch (e) {`);
    lines.push(`${INDENT}${INDENT}rt.depth = d;`);
    // Failure must leave the same storage behind as the reference: every
    // promoted store that already ran is written back before unwinding.
    for (const line of catchSpillLines) lines.push(line);
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

/** Initial value of a promoted local; integers stay `0`, booleans `false`. */
function initialPromotionValue(type: ScalarType): string {
  return type === 'bool' ? 'false' : '0';
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

/** One artifact compiled as a region member (J14). */
export interface RegionMemberEmit {
  readonly state: ArtifactState;
  readonly mir: MFunction;
  readonly key: readonly DispatchKey[];
  readonly keyTypes: readonly ScalarType[];
  readonly params: readonly ScalarType[];
  readonly providerIndex: number;
}

export interface EmittedRegion {
  /** Factory body; `new Function('rt', 'k', 'H', source)` returns the region. */
  readonly source: string;
  readonly constants: readonly unknown[];
  readonly frames: readonly JitFrame[];
}

/**
 * Compile a hot dispatch chain into one JavaScript state machine.
 *
 * Members share the module constant pool but keep private locals, labels and
 * frames (each member is emitted by the same {@link Emitter} used for a normal
 * function). Member entry parameters are the union of the provider signature;
 * a cross-member dispatch assigns them and `continue`s the region loop, while
 * a miss performs the generic materialize and either re-enters a member or
 * leaves with `TAIL`.
 */
export function emitRegion(
  members: readonly RegionMemberEmit[],
  env: EmitEnv,
  runtime: unknown,
): EmittedRegion {
  if (members.length === 0) throw new Error('JIT region compilation needs at least one member');
  const pool = new ConstantPool(env.constants);
  const runtimeIndex = pool.intern(runtime);
  const prefix = (index: number): string => `m${index}_`;
  const memberParams = members.map((member) => [...member.mir.blocks[0]!.params]);
  const memberKeys = members.map((member) => member.key);
  const paramCount = members.reduce((max, member) => Math.max(max, member.params.length), 0);
  const parameterNames = Array.from({ length: paramCount }, (_value, index) => `a${index}`);
  // Region-wide state promotion: a state accessed more than once across the
  // member set becomes one shared local. This is what keeps a DBT register
  // file live across block boundaries without storage round trips.
  const promotions = collectRegionPromotions(members);
  const promotionByMemory = new Map(
    promotions.map((promotion) => [promotion.memory, promotion.id]),
  );
  const emitters: Emitter[] = [];
  const frames: JitFrame[] = [];
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index]!;
    analyzeCFG(member.mir);
    analyzeRepresentation(member.mir, env.summaries);
    if (member.state.mir.promotions.length > 0) {
      // Promotion locals are not namespaced yet; keeping such artifacts out of
      // regions is correctness-preserving (they keep the normal dispatch path).
      throw new Error('JIT region compilation does not support promoted artifacts');
    }
    const emitter = new Emitter(
      member.mir,
      {
        ...env,
        artifactDependencies: member.state.dependencies,
        artifactState: member.state,
      },
      {
        prefix: prefix(index),
        pool,
        skipEntryParams: true,
        region: {
          runtimeName: 'RS',
          cursorName: 'Rcur',
          label: 'Lregion',
          memberIndex: index,
          memberCount: members.length,
          stateName: `ST${index}`,
          keyTypes: member.keyTypes,
          providerIndex: member.providerIndex,
          keys: memberKeys,
          parameterNames,
          memberPrefix: prefix,
          promotions,
          promotionByMemory,
        },
      },
    );
    emitter.emitBody();
    emitters.push(emitter);
    frames.push(emitter.savedFrame);
  }
  const framesIndex = pool.intern(frames);
  // Captured before collecting the resource/constant unions: the snippets
  // reference `S<n>` records and type constants.
  const first = emitters[0]!;
  const reloadLines = first.sharedPromotionReloadLines();
  const spillLines = first.sharedPromotionSpillLines();
  const used = new Set<number>([runtimeIndex, framesIndex]);
  const resources = new Set<number>();
  for (const emitter of emitters) {
    for (const index of emitter.usedConstants) used.add(index);
    for (const index of emitter.usedResources) resources.add(index);
  }

  const lines: string[] = [];
  lines.push("'use strict';");
  const constants = [...used]
    .sort((left, right) => left - right)
    .map((index) => `K${index} = k[${index}]`);
  if (constants.length > 0) lines.push(`const ${constants.join(', ')};`);
  for (const index of [...resources].sort((left, right) => left - right)) {
    lines.push(`const S${index} = H.res[${index}];`);
  }
  // `RS` is the runtime epoch/key table, `FS` the per-member frames.
  lines.push(`const RS = K${runtimeIndex};`);
  lines.push(`const FS = K${framesIndex};`);
  lines.push(`return function region(${['Rcur', ...parameterNames].join(', ')}) {`);
  lines.push(`${INDENT}const d = rt.depth;`);
  const deepArgs = ['RS.ids[Rcur]', ...parameterNames].join(', ');
  lines.push(`${INDENT}if (d >= rt.maxDepth) return rt.deep(${deepArgs});`);
  lines.push(`${INDENT}rt.depth = d + 1;`);
  lines.push(`${INDENT}let L = -1;`);
  lines.push(`${INDENT}let F = FS[Rcur];`);
  if (promotions.length > 0) {
    const shared = promotions.flatMap((promotion) => [
      `rp${promotion.id} = ${initialPromotionValue(promotion.type)}`,
      `rp${promotion.id}d = 0`,
    ]);
    lines.push(`${INDENT}let ${shared.join(', ')};`);
  }
  lines.push(`${INDENT}RS.es[Rcur] = H.ctl.epoch;`);
  lines.push(`${INDENT}RS.cs[Rcur] = H.prov.cacheEpoch;`);
  lines.push(`${INDENT}RS.states[Rcur].validatedEpoch = H.ctl.epoch;`);
  lines.push(`${INDENT}try {`);
  for (const line of reloadLines) lines.push(`${INDENT}${INDENT}${line}`);
  lines.push(`${INDENT}${INDENT}Lregion: for (;;) {`);
  lines.push(`${INDENT}${INDENT}${INDENT}switch (Rcur) {`);
  for (let index = 0; index < members.length; index += 1) {
    const emitter = emitters[index]!;
    lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}case ${index}: {`);
    lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}F = FS[${index}];`);
    // Declarations must precede the entry-parameter copy: `m0_v0` is a block
    // scoped `let` and the copy targets it.
    const locals = emitter.localDeclarations();
    if (locals.length > 0) {
      lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}let ${locals.join(', ')};`);
    }
    if (emitter.tempCount > 0) {
      const temps = Array.from(
        { length: emitter.tempCount },
        (_value, position) => `${prefix(index)}t${position} = 0`,
      );
      lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}let ${temps.join(', ')};`);
    }
    memberParams[index]!.forEach((param, position) => {
      lines.push(
        `${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}${prefix(index)}v${param} = ${
          parameterNames[position] ?? 'undefined'
        };`,
      );
    });
    for (const line of emitter.bodyLines) {
      lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}${line}`);
    }
    lines.push(
      `${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}throw new Error('JIT region member fell through');`,
    );
    lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}}`);
  }
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}default:`);
  lines.push(
    `${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}throw new Error('JIT region reached an unknown member');`,
  );
  lines.push(`${INDENT}${INDENT}${INDENT}}`);
  lines.push(`${INDENT}${INDENT}}`);
  lines.push(`${INDENT}} catch (e) {`);
  // An error must leave the same storage behind as the reference: every
  // promoted store that already ran is written back before unwinding.
  for (const line of spillLines) lines.push(`${INDENT}${INDENT}${line}`);
  lines.push(`${INDENT}${INDENT}rt.depth = d;`);
  lines.push(`${INDENT}${INDENT}throw rt.unwind(e, L, F);`);
  lines.push(`${INDENT}}`);
  lines.push('};');
  lines.push('//# sourceURL=mica-ir-jit/region.js');
  return { source: lines.join('\n'), constants: pool.values, frames };
}

/** The opcode set the emitter understands; used by tests and later passes. */
export const SUPPORTED_OPS: ReadonlySet<Op> = new Set(Object.values(Op));
