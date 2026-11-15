import type { InputPath, OperationIR, RegionIR } from '@mica-js/device-model';
import { analyzeBody } from './analysis.js';
import type { BodyAnalysis } from './analysis.js';
import { Emitter } from './compiler.js';
import { value } from './compiler.js';
import type {
  CompileOptions,
  ExecutionHost,
  GeneratedPosition,
  ReactionFrame,
  ResourceHandle,
} from './types.js';
import { runtimeHelpers } from './values.js';

/**
 * Synchronous reaction/function compiler.
 *
 * A `SynchronousProgram` is instance independent: it owns the emitted functions and a
 * compiler-owned constant pool. `bind(host)` creates the per-instance resource handles and
 * returns a runner, so one program may be shared by many device instances without leaking
 * state between them.
 *
 * The compiler admits a body only when the complete reachable static call graph is
 * suspension free and acyclic. Anything it cannot prove falls back as a whole by returning
 * `undefined`; it never executes part of a body and then discovers a suspension.
 */
export type SynchronousResolver = (name: string) => RegionIR | undefined;

export interface SynchronousCompileOptions extends CompileOptions {
  /**
   * Fixed resource handles are bound by default because synchronous reactions are the hot
   * path this backend exists for. Set this to `false` to emit the same generic `host.read`,
   * `host.sample`, `host.load`, ... operations as the generator backend; `program.bind` then
   * never calls `host.bind`.
   */
  readonly bindResources?: boolean;
  /**
   * Static function resolver. Every `call`/`callValue` reachable from the root must resolve
   * to a region, otherwise the whole program is rejected. The reachable call graph must be
   * acyclic; a recursive or mutually recursive graph is rejected as a whole. The resolver is
   * consulted once per call name.
   */
  readonly resolveFunction?: SynchronousResolver;
}

export type SynchronousRunner = (args?: readonly unknown[], reaction?: ReactionFrame) => unknown;

export interface SynchronousProgram {
  /** Generated source, retained for diagnostics; it is not evaluated again by `bind`. */
  readonly source: string;
  /** Names of the non-root functions compiled into this program, in first-use order. */
  readonly functions: readonly string[];
  /**
   * Fixed resource names per compiled body; body 0 is the root. Exposed so a runtime can
   * inspect bindings and tests can assert per-instance isolation.
   */
  readonly resources: readonly (readonly (readonly [ResourceKind, string])[])[];
  /**
   * Bind the program to one host/instance. When resource binding is enabled, handles are
   * cached for the lifetime of the returned runner; the program itself never captures a
   * host or an instance.
   */
  bind(host: ExecutionHost): SynchronousRunner;
}

export type ResourceKind = 'pin' | 'state' | 'memory';

/** Shared immutable argument list for calls and runners that pass no arguments. */
const EMPTY_ARGS: readonly unknown[] = Object.freeze([]);

interface ResolvedBody {
  readonly name: string;
  readonly region: RegionIR;
  readonly analysis: BodyAnalysis;
}

const suspensionOperations = new Set<OperationIR['kind']>([
  'wait',
  'elapse',
  'receive',
  'waitUntil',
  'redirect',
  'stop',
]);

/**
 * One compiler-owned constant table shared by every emitted function. This mirrors the
 * generator emitter's capture rules (primitive de-duplication and signed zero), but keeps
 * the table in one place so separate function emitters can share it.
 */
class ConstantPool {
  private readonly values: unknown[] = [];
  private readonly primitives = new Map<unknown, number>();
  private readonly negativeZero = Symbol('negative zero');

  capture(input: unknown): string {
    const primitive = input === null || typeof input !== 'object';
    const key = Object.is(input, -0) ? this.negativeZero : input;
    if (primitive) {
      const existing = this.primitives.get(key);
      if (existing !== undefined) return `C[${existing}]`;
    }
    const index = this.values.push(input) - 1;
    if (primitive) this.primitives.set(key, index);
    return `C[${index}]`;
  }

  freeze(): readonly unknown[] {
    return Object.freeze(this.values.slice());
  }
}

/** Resource names bound per body; body 0 is the root. */
class ResourcePlan {
  readonly specs: [ResourceKind, string][][];

  private readonly indices = new Map<string, number>();

  constructor(count: number) {
    this.specs = Array.from({ length: count }, () => []);
  }

  expression(body: number, kind: ResourceKind, name: string): string {
    const key = `${body}\0${kind}\0${name}`;
    let index = this.indices.get(key);
    if (index === undefined) {
      index = this.specs[body]!.length;
      this.specs[body]!.push([kind, name]);
      this.indices.set(key, index);
    }
    return `F.h[${body}][${index}]`;
  }
}

/**
 * The generator emitter's operation emission is reused verbatim. Only the call operation is
 * replaced: static calls become direct calls to the emitted synchronous function instead of
 * `host.call` plus `yield* H.delegate`. No source text is rewritten after emission.
 */
class SynchronousEmitter extends Emitter {
  constructor(
    analysis: BodyAnalysis,
    options: CompileOptions,
    private readonly pool: ConstantPool,
    private readonly plan: ResourcePlan,
    private readonly bodyIndex: number,
    private readonly functions: ReadonlyMap<string, number>,
    private readonly emptyArgs: string,
    bindResources: boolean,
  ) {
    super(analysis, options, false);
    if (bindResources) {
      this.bindingFor = (kind, name) => this.plan.expression(this.bodyIndex, kind, name);
    }
  }

  protected override capture(input: unknown): string {
    return this.pool.capture(input);
  }

  emitFunction(index: number, region: RegionIR): string[] {
    this.lines = [];
    this.indent = 0;
    this.line(`function f${index}(host, args = [], reaction, F) {`);
    this.indent++;
    this.region(region, []);
    this.indent--;
    this.line('}');
    return this.lines;
  }

  protected override emitOperation(
    operation: OperationIR,
    path: InputPath,
    position: GeneratedPosition | undefined,
    output?: { slot: string; label: string },
  ): void {
    if (operation.kind === 'call' || operation.kind === 'callValue') {
      const target = this.functions.get(operation.name);
      if (target === undefined) throw new Unsupported();
      const args = operation.args.map((argument) => this.argument(argument)).join(', ');
      const callArgs = args.length ? `[${args}]` : this.emptyArgs;
      // Model functions are invoked like Instance.invoke: no reaction frame is inherited.
      const call = `f${target}(host, ${callArgs}, undefined, F)`;
      if (operation.kind === 'callValue') {
        this.line(`const ${value(operation.result)} = ${call};`);
      } else {
        this.line(`${call};`);
      }
      return;
    }
    super.emitOperation(operation, path, position, output);
  }
}

class Unsupported extends Error {}

function analyze(region: RegionIR, options: CompileOptions): BodyAnalysis | undefined {
  try {
    return analyzeBody(region, options, false);
  } catch {
    return undefined;
  }
}

/**
 * Walk the reachable call graph once. A body is rejected as a whole when it contains a
 * suspension/terminal operation, an unresolvable call, or a call cycle. `byName` records
 * completed functions; `visiting` makes self/mutual recursion fail closed instead of relying
 * on native JavaScript stack depth or generator delegation behavior.
 */
function resolveBodies(
  root: RegionIR,
  resolveFunction: SynchronousResolver | undefined,
  options: CompileOptions,
): ResolvedBody[] | undefined {
  const rootAnalysis = analyze(root, options);
  if (rootAnalysis === undefined) return undefined;
  const bodies: ResolvedBody[] = [{ name: '', region: root, analysis: rootAnalysis }];
  const byName = new Map<string, number>();
  const visiting = new Set<string>();

  const visit = (body: ResolvedBody): boolean => {
    for (const node of body.analysis.nodes) {
      const operation = node.operation;
      if (suspensionOperations.has(operation.kind)) return false;
      if (operation.kind !== 'call' && operation.kind !== 'callValue') continue;
      if (visiting.has(operation.name)) return false;
      if (byName.has(operation.name)) continue;
      const resolved = resolveFunction?.(operation.name);
      if (resolved === undefined) return false;
      const index = bodies.length;
      byName.set(operation.name, index);
      visiting.add(operation.name);
      const analysis = analyze(resolved, options);
      if (analysis === undefined) return false;
      const callee: ResolvedBody = { name: operation.name, region: resolved, analysis };
      bodies.push(callee);
      if (!visit(callee)) return false;
      visiting.delete(operation.name);
    }
    return true;
  };

  return visit(bodies[0]!) ? bodies : undefined;
}

/**
 * Compile a model body into one ordinary JavaScript function (plus one function per
 * statically called model function). Returns `undefined` before executing anything when the
 * body or its reachable call graph is not supported.
 */
export function compileSynchronousBody(
  region: RegionIR,
  options: SynchronousCompileOptions = {},
): SynchronousProgram | undefined {
  try {
    const bodies = resolveBodies(region, options.resolveFunction, options);
    if (bodies === undefined) return undefined;
    const indexByName = new Map<string, number>();
    bodies.forEach((body, index) => {
      if (index > 0) indexByName.set(body.name, index);
    });
    const pool = new ConstantPool();
    const plan = new ResourcePlan(bodies.length);
    const bindResources = options.bindResources !== false;
    const emptyArgs = pool.capture(EMPTY_ARGS);
    const lines: string[] = [];
    for (let index = 0; index < bodies.length; index++) {
      const body = bodies[index]!;
      const emitter = new SynchronousEmitter(
        body.analysis,
        options,
        pool,
        plan,
        index,
        indexByName,
        emptyArgs,
        bindResources,
      );
      lines.push(...emitter.emitFunction(index, body.region));
    }
    lines.push('return f0;');
    const source = `"use strict";\n${lines.join('\n')}`;
    // Only compiler templates enter Function; model constants and names stay in `C`.
    const factory = new Function('C', 'H', source) as (
      constants: readonly unknown[],
      helpers: typeof runtimeHelpers,
    ) => (
      host: ExecutionHost,
      args: readonly unknown[],
      reaction: ReactionFrame | undefined,
      frame: SyncFrame,
    ) => unknown;
    const execute = factory(pool.freeze(), runtimeHelpers);
    const resources = Object.freeze(
      plan.specs.map((specs) =>
        Object.freeze(specs.map(([kind, name]) => Object.freeze([kind, name] as const))),
      ),
    );
    const names = Object.freeze(bodies.slice(1).map((body) => body.name));

    return Object.freeze({
      source,
      functions: names,
      resources,
      bind(host: ExecutionHost): SynchronousRunner {
        const handles = resources.map((specs) =>
          bindHandles(host, specs as readonly (readonly [ResourceKind, string])[]),
        );
        const frame: SyncFrame = { h: handles };
        return (args?: readonly unknown[], reaction?: ReactionFrame): unknown =>
          execute(host, args ?? EMPTY_ARGS, reaction, frame);
      },
    });
  } catch {
    // The fallback is all-or-nothing: a partially emitted body is never exposed.
    return undefined;
  }
}

interface SyncFrame {
  readonly h: readonly (readonly ResourceHandle[])[];
}

const emptyHandles: readonly ResourceHandle[] = Object.freeze([]);

function bindHandles(
  host: ExecutionHost,
  specs: readonly (readonly [ResourceKind, string])[],
): readonly ResourceHandle[] {
  if (!specs.length) return emptyHandles;
  if (typeof host.bind === 'function') return host.bind(specs);
  return Object.freeze(specs.map(([kind, name]) => genericHandle(host, kind, name)));
}

/**
 * A host without the optional `bind` capability still gets a synchronous runner. Every
 * method delegates to the original generic host operation at the moment it is used, so an
 * unknown resource name fails at the operation, never when the runner is bound.
 */
function genericHandle(host: ExecutionHost, kind: ResourceKind, name: string): ResourceHandle {
  if (kind === 'pin') {
    return Object.freeze({
      sample: () => host.sample(name),
      intent: (value: unknown) => host.intent(name, value),
      resistor: (resistance: unknown) => host.resistor(name, resistance),
    });
  }
  if (kind === 'state') {
    return Object.freeze({
      read: () => host.read('state', name),
      write: (value: unknown) => host.write(name, value),
    });
  }
  return Object.freeze({
    load8: (offset: unknown) => host.load('load8', name, offset),
    load16le: (offset: unknown) => host.load('load16le', name, offset),
    load16be: (offset: unknown) => host.load('load16be', name, offset),
    load32le: (offset: unknown) => host.load('load32le', name, offset),
    load32be: (offset: unknown) => host.load('load32be', name, offset),
    store8: (offset: unknown, value: unknown) => host.store('store8', name, offset, value),
    store16le: (offset: unknown, value: unknown) => host.store('store16le', name, offset, value),
    store16be: (offset: unknown, value: unknown) => host.store('store16be', name, offset, value),
    store32le: (offset: unknown, value: unknown) => host.store('store32le', name, offset, value),
    store32be: (offset: unknown, value: unknown) => host.store('store32be', name, offset, value),
    length: () => host.memoryLength(name),
    copy: (offset: unknown, length: unknown) => host.copyBytes(name, offset, length),
  });
}
