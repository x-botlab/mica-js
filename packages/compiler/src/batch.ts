import type {
  InstructionIR,
  MemoryRefIR,
  OperationIR,
  RegionIR,
  ValueRegionIR,
} from '@mica-js/device-model';
import type { BodyAnalysis } from './analysis.js';

/** Nonnegative safe literal or a number-state name read at each loop test. */
export type BatchLimit =
  | { readonly kind: 'constant'; readonly value: number }
  | { readonly kind: 'state'; readonly name: string };

/** One round's observable effect. A process also waits; a JIT loop redirects to its head. */
export type BatchEffect =
  | { readonly kind: 'advance' }
  | {
      readonly kind: 'fill';
      readonly destination: string;
      readonly destinationBase: number;
      /** Original safe integer literal; the commit uses `store8`'s low eight bits. */
      readonly value: number;
    }
  | {
      readonly kind: 'copy';
      readonly source: string;
      readonly sourceBase: number;
      readonly destination: string;
      readonly destinationBase: number;
    };

/**
 * Immutable compiler proof for one batch-capable loop. Names remain names: every plan is
 * resolved against the owning instance before use.
 */
export interface BatchPlan {
  readonly cursor: string;
  readonly limit: BatchLimit;
  readonly stepPs: number;
  readonly effect: BatchEffect;
  /** Effect-key form of the slots this loop reads, for instance admission. */
  readonly reads: readonly string[];
  /** Effect-key form of the slots this loop writes, for instance admission. */
  readonly writes: readonly string[];
}

/** Process plan plus the real `frame.pc` of the tail `ticks` continuation. */
export type ProcessBatchPlan = BatchPlan & { readonly resumeBlock: number };

/** Internal result needed by the resumable emitter to verify its generated blocks. */
export interface ProcessBatchProof {
  readonly plan: BatchPlan;
  readonly wait: Extract<OperationIR, { readonly kind: 'wait' }>;
}

interface Entry {
  readonly operation: OperationIR;
  readonly at: number;
}

const loadKinds = new Set<OperationIR['kind']>([
  'load8',
  'load16le',
  'load16be',
  'load32le',
  'load32be',
]);
const storeKinds = new Set<OperationIR['kind']>([
  'store8',
  'store16le',
  'store16be',
  'store32le',
  'store32be',
]);

/** Direct operations of one region with ordered result definitions. */
class Script {
  readonly entries: Entry[] = [];
  private readonly results = new Map<number, Entry>();
  private duplicate = false;

  addRegion(region: RegionIR, at: number): readonly Entry[] {
    const entries: Entry[] = [];
    for (const operation of region.operations) entries.push(this.add(operation, at++));
    return entries;
  }

  add(operation: OperationIR, at: number): Entry {
    const entry = { operation, at };
    this.entries.push(entry);
    if ('result' in operation) {
      if (this.results.has(operation.result)) this.duplicate = true;
      else this.results.set(operation.result, entry);
    }
    return entry;
  }

  result(id: number, at: number): Entry | undefined {
    const entry = this.results.get(id);
    return entry !== undefined && entry.at < at ? entry : undefined;
  }

  use(entry: Entry): void {
    this.consumed.add(entry);
  }

  private readonly consumed = new Set<Entry>();

  complete(): boolean {
    return (
      !this.duplicate &&
      this.entries.length > 0 &&
      this.entries.every((entry) => this.consumed.has(entry))
    );
  }
}

function numberConstant(script: Script, id: number, at: number): number | undefined {
  const entry = script.result(id, at);
  if (entry === undefined) return undefined;
  const operation = entry.operation;
  if (
    operation.kind === 'constant' &&
    operation.constant.kind === 'number' &&
    operation.type.kind === 'number' &&
    Number.isFinite(operation.constant.value)
  ) {
    script.use(entry);
    return operation.constant.value;
  }
  // DDL keeps a signed literal as one unary node over its unsigned literal.
  if (
    operation.kind === 'unary' &&
    (operation.operator === 'positive' || operation.operator === 'negate') &&
    operation.type.kind === 'number'
  ) {
    const inner = script.result(operation.value, entry.at);
    if (
      inner === undefined ||
      inner.operation.kind !== 'constant' ||
      inner.operation.constant.kind !== 'number' ||
      inner.operation.type.kind !== 'number' ||
      !Number.isFinite(inner.operation.constant.value)
    )
      return undefined;
    script.use(inner);
    script.use(entry);
    return operation.operator === 'negate'
      ? -inner.operation.constant.value
      : inner.operation.constant.value;
  }
  return undefined;
}

function integerConstant(script: Script, id: number, at: number): number | undefined {
  const value = numberConstant(script, id, at);
  return value !== undefined && Number.isSafeInteger(value) ? value : undefined;
}

function cursorRead(script: Script, id: number, at: number, cursor: string): boolean {
  const entry = script.result(id, at);
  if (entry === undefined) return false;
  const operation = entry.operation;
  if (
    operation.kind !== 'read' ||
    operation.resource !== 'state' ||
    operation.type.kind !== 'number' ||
    operation.name !== cursor
  )
    return false;
  script.use(entry);
  return true;
}

function limitValue(
  script: Script,
  id: number,
  at: number,
  cursor: string,
): BatchLimit | undefined {
  const entry = script.result(id, at);
  if (entry === undefined) return undefined;
  const operation = entry.operation;
  if (operation.kind === 'read') {
    if (
      operation.resource !== 'state' ||
      operation.type.kind !== 'number' ||
      operation.name.length === 0 ||
      operation.name === cursor
    )
      return undefined;
    script.use(entry);
    return Object.freeze({ kind: 'state', name: operation.name });
  }
  const value = integerConstant(script, id, at);
  return value !== undefined && value >= 0
    ? Object.freeze({ kind: 'constant', value: value === 0 ? 0 : value })
    : undefined;
}

function condition(
  script: Script,
  id: number,
  at: number,
): { readonly cursor: string; readonly limit: BatchLimit } | undefined {
  const entry = script.result(id, at);
  if (entry === undefined) return undefined;
  const operation = entry.operation;
  if (
    operation.kind !== 'binary' ||
    operation.operator !== 'lessThan' ||
    operation.type.kind !== 'bool'
  )
    return undefined;
  const cursorEntry = script.result(operation.left, entry.at);
  if (cursorEntry === undefined || cursorEntry.operation.kind !== 'read') return undefined;
  const left = cursorEntry.operation;
  if (left.resource !== 'state' || left.type.kind !== 'number' || left.name.length === 0)
    return undefined;
  script.use(cursorEntry);
  const limit = limitValue(script, operation.right, entry.at, left.name);
  if (limit === undefined) return undefined;
  script.use(entry);
  return { cursor: left.name, limit };
}

/** Offset is either `cursor` or `cursor + base`, with a nonnegative safe base. */
function offset(script: Script, id: number, at: number, cursor: string): number | undefined {
  const entry = script.result(id, at);
  if (entry === undefined) return undefined;
  if (cursorRead(script, id, at, cursor)) return 0;
  const operation = entry.operation;
  if (
    operation.kind !== 'binary' ||
    operation.operator !== 'add' ||
    operation.type.kind !== 'number'
  )
    return undefined;
  const fromRight = integerConstant(script, operation.right, entry.at);
  if (
    fromRight !== undefined &&
    fromRight >= 0 &&
    cursorRead(script, operation.left, entry.at, cursor)
  ) {
    script.use(entry);
    return fromRight === 0 ? 0 : fromRight;
  }
  const fromLeft = integerConstant(script, operation.left, entry.at);
  if (
    fromLeft !== undefined &&
    fromLeft >= 0 &&
    cursorRead(script, operation.right, entry.at, cursor)
  ) {
    script.use(entry);
    return fromLeft === 0 ? 0 : fromLeft;
  }
  return undefined;
}

/** `cursor = cursor + 1`, accepted with either operand order. */
function increment(script: Script, id: number, at: number, cursor: string): Entry | undefined {
  const entry = script.result(id, at);
  if (entry === undefined) return undefined;
  const operation = entry.operation;
  if (
    operation.kind !== 'binary' ||
    operation.operator !== 'add' ||
    operation.type.kind !== 'number'
  )
    return undefined;
  if (
    integerConstant(script, operation.right, entry.at) === 1 &&
    cursorRead(script, operation.left, entry.at, cursor)
  ) {
    script.use(entry);
    return entry;
  }
  if (
    integerConstant(script, operation.left, entry.at) === 1 &&
    cursorRead(script, operation.right, entry.at, cursor)
  ) {
    script.use(entry);
    return entry;
  }
  return undefined;
}

function memoryName(memory: MemoryRefIR): string | undefined {
  if (memory.kind !== 'memory' || memory.name.length === 0) return undefined;
  return memory.name;
}

function createPlan(
  cursor: string,
  limit: BatchLimit,
  stepPs: number,
  effect: BatchEffect,
): BatchPlan {
  const reads = [`state:${cursor}`];
  if (limit.kind === 'state') reads.push(`state:${limit.name}`);
  if (effect.kind === 'copy') reads.push(`memory:${effect.source}`);
  const writes = [`state:${cursor}`];
  if (effect.kind !== 'advance') writes.push(`memory:${effect.destination}`);
  return Object.freeze({
    cursor,
    limit,
    stepPs,
    effect,
    reads: Object.freeze(reads),
    writes: Object.freeze(writes),
  });
}

interface StepShape {
  readonly effect: BatchEffect;
  readonly stepPs: number;
  readonly terminator: OperationIR;
  readonly local: number | undefined;
}

/**
 * Prove the exact ordered round shared by process tails and JIT loop heads. The caller
 * owns the surrounding test and then checks that the whole script was consumed.
 */
function proveStep(
  script: Script,
  entries: readonly Entry[],
  cursor: string,
  mode: 'process' | 'jit',
  pc?: number,
): StepShape | undefined {
  const last = entries.at(-1);
  if (last === undefined) return undefined;
  let stepPs: number | undefined;
  if (mode === 'process') {
    if (last.operation.kind !== 'wait') return undefined;
    stepPs = integerConstant(script, last.operation.duration, last.at);
  } else {
    if (last.operation.kind !== 'redirect' || pc === undefined) return undefined;
    const target = numberConstant(script, last.operation.target, last.at);
    if (target === undefined || !Object.is(target, pc)) return undefined;
    stepPs = integerConstant(script, last.operation.delay, last.at);
  }
  if (stepPs === undefined || stepPs <= 0) return undefined;
  script.use(last);

  const writes = entries.filter((entry) => entry.operation.kind === 'write');
  if (writes.length !== 1) return undefined;
  const write = writes[0]!;
  if (
    write.operation.kind !== 'write' ||
    write.operation.resource !== 'state' ||
    write.operation.name !== cursor
  )
    return undefined;
  const addition = increment(script, write.operation.value, write.at, cursor);
  if (addition === undefined) return undefined;
  script.use(write);

  const loads: Entry[] = [];
  const stores: Entry[] = [];
  for (const entry of entries) {
    const kind = entry.operation.kind;
    if (kind === 'load8') loads.push(entry);
    else if (kind === 'store8') stores.push(entry);
    else if (loadKinds.has(kind) || storeKinds.has(kind) || kind === 'copyBytes') return undefined;
  }

  let effect: BatchEffect;
  let local: number | undefined;
  let memoryAt: number | undefined;
  if (loads.length === 0) {
    if (stores.length === 0) effect = Object.freeze({ kind: 'advance' });
    else if (stores.length === 1) {
      const store = stores[0]!;
      if (store.operation.kind !== 'store8') return undefined;
      const destination = memoryName(store.operation.memory);
      if (destination === undefined) return undefined;
      const destinationBase = offset(script, store.operation.offset, store.at, cursor);
      const value = integerConstant(script, store.operation.value, store.at);
      if (value === undefined || destinationBase === undefined) return undefined;
      script.use(store);
      effect = Object.freeze({ kind: 'fill', destination, destinationBase, value });
      memoryAt = store.at;
    } else return undefined;
  } else {
    if (loads.length !== 1 || stores.length !== 1) return undefined;
    const load = loads[0]!;
    const store = stores[0]!;
    if (load.operation.kind !== 'load8' || store.operation.kind !== 'store8' || load.at >= store.at)
      return undefined;
    const source = memoryName(load.operation.memory);
    const destination = memoryName(store.operation.memory);
    if (source === undefined || destination === undefined) return undefined;
    const sourceBase = offset(script, load.operation.offset, load.at, cursor);
    const destinationBase = offset(script, store.operation.offset, store.at, cursor);
    if (sourceBase === undefined || destinationBase === undefined) return undefined;
    script.use(load);

    const valueEntry = script.result(store.operation.value, store.at);
    if (valueEntry === undefined) return undefined;
    if (valueEntry === load) {
      // Inline `store8(dst, ..., load8(src, ...))`; the load is the value.
    } else if (valueEntry.operation.kind === 'localRead') {
      // DDL's canonical `let byte = load8(...)` declares one loop-local initialized from
      // the load and only reads it for the store. No localWrite or outer capture is allowed.
      const localRead = valueEntry.operation;
      const localEntries = entries.filter(
        (entry) => entry.operation.kind === 'local' && entry.operation.local === localRead.local,
      );
      if (localEntries.length !== 1) return undefined;
      const localEntry = localEntries[0]!;
      if (
        localEntry.operation.kind !== 'local' ||
        localEntry.operation.initial !== load.operation.result ||
        localEntry.at <= load.at ||
        localEntry.at >= store.at
      )
        return undefined;
      script.use(localEntry);
      script.use(valueEntry);
      local = localRead.local;
    } else return undefined;
    script.use(store);
    effect = Object.freeze({
      kind: 'copy',
      source,
      sourceBase,
      destination,
      destinationBase,
    });
    memoryAt = store.at;
  }

  if (memoryAt !== undefined && addition.at <= memoryAt) return undefined;
  if (write.at <= addition.at) return undefined;
  return Object.freeze({ effect, stepPs, terminator: last.operation, local });
}

function proveProcessTest(
  region: ValueRegionIR,
): { readonly cursor: string; readonly limit: BatchLimit } | undefined {
  if (region.type.kind !== 'bool') return undefined;
  const script = new Script();
  script.addRegion(region.body, 0);
  const last = script.entries.at(-1);
  if (last === undefined || last.operation.kind !== 'yield') return undefined;
  const test = condition(script, last.operation.value, last.at);
  if (test === undefined) return undefined;
  script.use(last);
  return script.complete() ? test : undefined;
}

/**
 * Prove one top-level `while cursor < limit` whose body ends in `await ticks(d)` and is
 * followed by a direct back edge. Rejections leave the existing resumable machine intact.
 */
export function proveProcessBatchLoop(
  analysis: BodyAnalysis,
  operation: Extract<OperationIR, { readonly kind: 'while' }>,
): ProcessBatchProof | undefined {
  try {
    const node = analysis.byOperation.get(operation);
    if (node === undefined) return undefined;
    const testNode = node.children.get('test');
    const bodyNode = node.children.get('body');
    if (testNode === undefined || bodyNode === undefined) return undefined;
    const test = proveProcessTest(operation.test);
    if (test === undefined) return undefined;

    const script = new Script();
    const entries = script.addRegion(operation.body, 0);
    const step = proveStep(script, entries, test.cursor, 'process');
    if (step === undefined || !script.complete()) return undefined;
    const wait = step.terminator as Extract<OperationIR, { readonly kind: 'wait' }>;
    const waitNode = analysis.byOperation.get(wait);
    if (waitNode === undefined || waitNode.resumeBlock === undefined) return undefined;

    const graph = analysis.graph;
    const resume = waitNode.resumeBlock;
    const outgoing = graph.edges.filter((edge) => edge.from === resume);
    if (
      outgoing.length !== 1 ||
      outgoing[0]!.kind !== 'resume' ||
      outgoing[0]!.to !== bodyNode.exit
    )
      return undefined;
    const exits = graph.edges.filter((edge) => edge.from === bodyNode.exit);
    if (exits.length !== 1 || exits[0]!.kind !== 'backedge' || exits[0]!.to !== testNode.entry)
      return undefined;

    // A loop-body temporary must be recomputed after the suspension, not restored from
    // the frame. Outer locals remain legitimate live-in slots.
    const bodyResults = new Set<number>();
    const bodyLocals = new Set<number>();
    for (const entry of entries) {
      const value = entry.operation;
      if ('result' in value) bodyResults.add(value.result);
      if (value.kind === 'local' || value.kind === 'localWrite') bodyLocals.add(value.local);
    }
    const live = graph.blocks[resume]!.liveIn;
    for (const key of live) {
      const separator = key.indexOf(':');
      if (separator < 0) continue;
      const id = Number(key.slice(separator + 1));
      if (!Number.isSafeInteger(id)) return undefined;
      if (key.startsWith('value:') && bodyResults.has(id)) return undefined;
      if (key.startsWith('local:') && bodyLocals.has(id)) return undefined;
    }

    // A loop-local or a value defined by the folded body must not escape the region.
    const bodyOperations = new Set(operation.body.operations);
    if (step.local !== undefined) {
      for (const nested of analysis.nodes) {
        const value = nested.operation;
        if (
          (value.kind === 'local' || value.kind === 'localRead' || value.kind === 'localWrite') &&
          value.local === step.local &&
          !bodyOperations.has(value)
        )
          return undefined;
      }
    }
    for (const value of graph.values) {
      if (!bodyResults.has(value.result)) continue;
      for (const position of value.users) {
        const user = analysis.nodes[position];
        if (user === undefined || !bodyOperations.has(user.operation)) return undefined;
      }
    }

    const plan = createPlan(test.cursor, test.limit, step.stepPs, step.effect);
    return Object.freeze({ plan, wait });
  } catch {
    return undefined;
  }
}

/**
 * Prove one self-jumping JIT instruction. `nextPc` is the distinct fall-through exit;
 * the true branch performs one round and redirects to the exact head PC.
 */
export function proveJitBatch(instruction: InstructionIR): BatchPlan | undefined {
  try {
    if (instruction === null || typeof instruction !== 'object') return undefined;
    const { pc, nextPc, body } = instruction;
    if (!Number.isFinite(pc) || !Number.isFinite(nextPc) || pc === nextPc) return undefined;
    const operations = body.operations;
    const ifIndex = operations.length - 1;
    const branch = operations[ifIndex];
    if (ifIndex < 0 || branch === undefined || branch.kind !== 'if' || branch.no !== undefined)
      return undefined;

    const script = new Script();
    for (let index = 0; index < ifIndex; index++) script.add(operations[index]!, index);
    const branchEntry = script.add(branch, ifIndex);
    const entries = script.addRegion(branch.yes, ifIndex + 1);
    const test = condition(script, branch.condition, branchEntry.at);
    if (test === undefined) return undefined;
    script.use(branchEntry);
    const step = proveStep(script, entries, test.cursor, 'jit', pc);
    if (step === undefined || !script.complete()) return undefined;
    return createPlan(test.cursor, test.limit, step.stepPs, step.effect);
  } catch {
    return undefined;
  }
}
