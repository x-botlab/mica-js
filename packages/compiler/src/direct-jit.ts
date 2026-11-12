import type {
  BinaryOperator,
  MatchPatternIR,
  MemoryRefIR,
  OperationIR,
  RegionIR,
  UnaryOperator,
  ValueRegionIR,
} from '@mica-js/device-model';
import type {
  DirectJitBinding,
  DirectJitFrame,
  DirectJitProgram,
  DirectJitReason,
} from './types.js';
import {
  checkBoolean,
  checkDuration,
  checkPc,
  combineIntents,
  createBytes,
  equalValues,
  nonNull,
  readIndex,
} from './values.js';

const binary: Partial<Record<BinaryOperator, string>> = {
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
  equal: '===',
  notEqual: '!==',
  bitAnd: '&',
  bitOr: '|',
  bitXor: '^',
  shiftLeft: '<<',
  shiftRight: '>>',
  shiftRightUnsigned: '>>>',
};
const unary: Partial<Record<UnaryOperator, string>> = {
  positive: '+',
  negate: '-',
  not: '!',
  bitNot: '~',
};
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
const predicates = new Set(['isNaN', 'isFinite', 'isInteger', 'isSafeInteger']);
/** Operations whose results may stay outside the scalar number/bool slot set. */
const wideResults = new Set([
  'field',
  'optional',
  'nonNull',
  'readSample',
  'resistor',
  'combineIntents',
  'bytes',
  // A string result is only produced by indexing a string, which stays a plain slot value.
  'index',
  // A wide select keeps its branches in one slot and never enters the state bank, so a
  // pin-intent choice such as `select(level, [resistor(...)], [])` stays direct.
  'select',
  'match',
]);
/**
 * Result types whose runtime value is an object, so `===` is not the host's value equality.
 * Bytes compare element by element in `equalValues`, and intents compare by branch content.
 */
const referenceResults = new Set(['bytes', 'record', 'sample', 'intent', 'optional']);
/** Operations admitted only when the runtime supplied a direct host for the frame. */
const hosted = new Set([
  'send',
  'notify',
  'readSample',
  'writeIntent',
  'resistor',
  'random',
  'assert',
]);

function offset(memory: Uint8Array, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new TypeError('offset must be a safe integer');
  if (value < 0) throw new RangeError('offset must be nonnegative');
  if (value >= memory.length) throw new RangeError('Memory range is out of bounds');
  return value;
}

function byte(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new TypeError('stored value must be a safe integer');
  return value;
}

const views = new WeakMap<Uint8Array, DataView>();

/** One cached wrapper per bank; wide accesses never assemble bytes or allocate per operation. */
function view(memory: Uint8Array): DataView {
  let cached = views.get(memory);
  if (cached === undefined) {
    cached = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
    views.set(memory, cached);
  }
  return cached;
}

/** Address check order matches the generic host: safe integer, nonnegative, whole range. */
function address(memory: Uint8Array, value: unknown, size: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new TypeError('offset must be a safe integer');
  if (value < 0) throw new RangeError('offset must be nonnegative');
  if (value > memory.length || size > memory.length - value)
    throw new RangeError('Memory range is out of bounds');
  return value;
}

function load16(memory: Uint8Array, value: unknown, little: boolean): number {
  return view(memory).getUint16(address(memory, value, 2), little);
}

function load32(memory: Uint8Array, value: unknown, little: boolean): number {
  return view(memory).getUint32(address(memory, value, 4), little);
}

function store16(memory: Uint8Array, value: unknown, stored: unknown, little: boolean): void {
  const at = address(memory, value, 2);
  view(memory).setUint16(at, byte(stored), little);
}

function store32(memory: Uint8Array, value: unknown, stored: unknown, little: boolean): void {
  const at = address(memory, value, 4);
  view(memory).setUint32(at, byte(stored), little);
}

const helpers = Object.freeze({
  checkBoolean,
  checkDuration,
  checkPc,
  combineIntents,
  createBytes,
  equalValues,
  nonNull,
  readIndex,
  offset,
  byte,
  load16,
  load32,
  store16,
  store32,
});
const unsupported = Symbol('unsupported direct instruction');
/**
 * Code budget for one generated shard. Emitted characters, not registers, predict where V8
 * stops optimizing a function: measured blocks slow down sharply from ~35 KB of source.
 */
const SHARD_CODE_BUDGET = 36_000;
/**
 * Below this summed source size the monolithic form stays inside the range V8 optimizes, and
 * it avoids the dispatcher hop; larger programs split into shards.
 */
const MONOLITH_CODE_LIMIT = 48_000;

/** Inputs have already passed model validation and contextual binding. */
export function compileDirectJit(
  instructions: readonly {
    readonly pc: number;
    readonly nextPc: number;
    readonly body: RegionIR;
  }[],
  binding: DirectJitBinding,
): DirectJitProgram | undefined {
  if (!validIndex(binding.pc.index) || binding.states.get(binding.pc.name) !== binding.pc.index)
    return undefined;
  const constants: unknown[] = [];
  const capture = (value: unknown): string => `C[${constants.push(value) - 1}]`;
  const entries: Instruction[] = [];
  const seen = new Set<number>();
  for (const instruction of instructions) {
    if (!Number.isFinite(instruction.pc) || seen.has(instruction.pc)) continue;
    // Even an unsupported first occurrence owns this PC, matching runtime lookup.
    seen.add(instruction.pc);
    if (!Number.isFinite(instruction.nextPc)) continue;
    try {
      entries.push(new Instruction(binding, capture).compile(instruction));
    } catch (error) {
      if (error !== unsupported) throw error;
    }
  }
  if (!entries.length) return undefined;
  const localCount = Math.max(...entries.map((entry) => entry.slots.length));
  const registers = Array.from({ length: localCount }, (_, index) => `v${index}`);
  const options = binding as DirectJitBinding & {
    readonly split?: boolean;
    readonly shardSize?: number;
    readonly shardSlotLimit?: number;
  };
  // An explicit slot limit keeps the historical slot-based switch; otherwise the emitted
  // source size decides, because register reuse makes slot counts wildly optimistic.
  const slotLimit = validIndex(options.shardSlotLimit) ? options.shardSlotLimit : undefined;
  const split =
    options.split === true &&
    (slotLimit === undefined
      ? entries.reduce((sum, entry) => sum + entry.size, 0) > MONOLITH_CODE_LIMIT
      : entries.reduce((sum, entry) => sum + entry.slots.length, 0) > slotLimit);
  const shardSize = validIndex(options.shardSize) && options.shardSize > 0 ? options.shardSize : 48;
  const lines = split
    ? shardProgram(entries, binding, shardSize)
    : monolithicProgram(entries, binding, registers);
  // Only compiler templates/indices and compiler-validated primitive number, boolean and
  // JSON-encoded string literals enter source; every other IR value stays closure data in C.
  const factory = new Function(
    'C',
    'H',
    split
      ? `"use strict";\n${lines.join('\n')}\nreturn run;`
      : `"use strict"; return (${lines.join('\n')});`,
  ) as (
    constants: readonly unknown[],
    runtimeHelpers: typeof helpers,
  ) => (frame: DirectJitFrame, deadline: number) => DirectJitReason;
  const names = (field: 'readStates' | 'writeStates' | 'readMemories' | 'writeMemories') =>
    Object.freeze([...new Set(entries.flatMap((entry) => [...entry[field]]))]);
  return Object.freeze({
    run: factory(Object.freeze(constants), helpers),
    localCount,
    readStates: names('readStates'),
    writeStates: names('writeStates'),
    readMemories: names('readMemories'),
    writeMemories: names('writeMemories'),
  });
}

/**
 * `BS` / `BM` are the runtime write barriers: word masks of the state and memory slots the
 * simulator currently observes. They stay outside `DirectJitFrame` because the runtime
 * mutates them in place, so one compiled program stays valid across observer changes. A frame
 * built without them (compiler tests) yields an empty mask and never blocks.
 */
const prelude = (slots: readonly string[]): string[] => [
  'const S = F.states, M = F.memories, L = F.locals, SD = F.stateDirty, MD = F.memoryDirty;',
  'const BS = F.blockedStates ?? [], BM = F.blockedMemories ?? [];',
  ...(slots.length ? [`let ${slots.join(',')};`] : []),
];

/** One function holds the dispatcher, every continuation and every instruction body. */
function monolithicProgram(
  entries: readonly Instruction[],
  binding: DirectJitBinding,
  registers: readonly string[],
): string[] {
  const lines = [
    'function run(F, deadline) {',
    ...prelude(registers),
    'while (true) {',
    'if (F.time >= deadline) return "deadline";',
    'if (F.resume !== 0) {',
    'if (F.due >= deadline) { F.time = deadline; return "deadline"; }',
    'F.time = Math.max(F.time, F.due);',
    'switch (F.resume) {',
  ];
  entries.forEach((entry, index) => {
    lines.push(`case ${index + 1}: {`);
    entry.slots.forEach((slot, slotIndex) => lines.push(`${slot} = L[${slotIndex}];`));
    lines.push('F.resume = 0;', ...entry.suffix, finish(entry.stop), '}');
  });
  lines.push(
    'default: throw new TypeError("Unknown direct JIT continuation");',
    '}',
    '}',
    'if (F.stopAfterInstruction) return "invalidated";',
    `switch (H.checkPc(S[${binding.pc.index}])) {`,
  );
  entries.forEach((entry, index) => {
    lines.push(
      `case ${entry.pc}: {`,
      ...entry.barrier,
      ...entry.guard,
      `S[${binding.pc.index}] = ${entry.nextPc};`,
      dirty('SD', binding.pc.index),
      ...entry.prefix,
    );
    if (entry.duration !== undefined) lines.push(...elapsed(entry, index));
    lines.push(...entry.suffix, finish(entry.stop), '}');
  });
  lines.push('default: return "fallback";', '}', '}', '}');
  return lines;
}

/** A light dispatcher plus one step/resume shard keeps every generated function small. */
function shardProgram(
  entries: readonly Instruction[],
  binding: DirectJitBinding,
  shardSize: number,
): string[] {
  const sorted = [...entries].sort((left, right) => left.pcValue - right.pcValue);
  // Generated function size follows the emitted source, so group by a code budget instead of
  // a fixed count: one oversized block then gets a shard of its own.
  const groups: Instruction[][] = [];
  let current: Instruction[] = [];
  let budget = 0;
  for (const entry of sorted) {
    if (
      current.length &&
      (current.length >= shardSize || budget + entry.size > SHARD_CODE_BUDGET)
    ) {
      groups.push(current);
      current = [];
      budget = 0;
    }
    current.push(entry);
    budget += entry.size;
  }
  if (current.length) groups.push(current);
  let start = 0;
  const shards = groups.map((slice) => {
    const shard = {
      start,
      entries: slice,
      maxSlots: Math.max(...slice.map((entry) => entry.slots.length)),
      lastPc: slice[slice.length - 1]!.pc,
      lastResume: start + slice.length,
      resumable: slice.some((entry) => entry.duration !== undefined),
    };
    start += slice.length;
    return shard;
  });
  const registers = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `v${index}`);
  const lines: string[] = [];
  shards.forEach((shard, shardIndex) => {
    const lower = shardIndex ? shards[shardIndex - 1]!.lastPc : undefined;
    lines.push(
      `function stepShard${shardIndex}(F, deadline, pc) {`,
      ...prelude(registers(shard.maxSlots)),
      'while (true) {',
      'switch (pc) {',
    );
    shard.entries.forEach((entry, offset) => {
      lines.push(
        `case ${entry.pc}: {`,
        ...entry.barrier,
        ...entry.guard,
        `S[${binding.pc.index}] = ${entry.nextPc};`,
        dirty('SD', binding.pc.index),
        ...entry.prefix,
        ...elapsed(entry, shard.start + offset),
        ...entry.suffix,
        stepFinish(entry.stop, lower, shard.lastPc, binding.pc.index),
        '}',
      );
    });
    lines.push('default: return "fallback";', '}', '}', '}');
  });
  shards.forEach((shard, shardIndex) => {
    if (!shard.resumable) return;
    lines.push(
      `function resumeShard${shardIndex}(F, resume) {`,
      ...prelude(registers(shard.maxSlots)),
      'switch (resume) {',
    );
    shard.entries.forEach((entry, offset) => {
      if (entry.duration === undefined) return;
      lines.push(`case ${shard.start + offset + 1}: {`);
      entry.slots.forEach((slot, slotIndex) => lines.push(`${slot} = L[${slotIndex}];`));
      lines.push('F.resume = 0;', ...entry.suffix, splitFinish(entry.stop), '}');
    });
    lines.push('default: throw new TypeError("Unknown direct JIT continuation");', '}', '}');
  });
  lines.push(
    'function run(F, deadline) {',
    'const S = F.states;',
    'while (true) {',
    'if (F.time >= deadline) return "deadline";',
    'let status;',
    'if (F.resume !== 0) {',
    'if (F.due >= deadline) { F.time = deadline; return "deadline"; }',
    'F.time = Math.max(F.time, F.due);',
    'const resume = F.resume;',
  );
  const resumable = shards
    .map((shard, shardIndex) => ({ shard, shardIndex }))
    .filter(({ shard }) => shard.resumable);
  if (resumable.length) {
    resumable.forEach(({ shard, shardIndex }, position) => {
      const keyword = position ? 'else if' : 'if';
      lines.push(
        `${keyword} (resume <= ${shard.lastResume}) status = resumeShard${shardIndex}(F, resume);`,
      );
    });
    lines.push('else throw new TypeError("Unknown direct JIT continuation");');
  } else lines.push('throw new TypeError("Unknown direct JIT continuation");');
  lines.push(
    '} else {',
    'if (F.stopAfterInstruction) return "invalidated";',
    `const pc = H.checkPc(S[${binding.pc.index}]);`,
  );
  shards.forEach((shard, shardIndex) => {
    const keyword = shardIndex ? 'else if' : 'if';
    lines.push(
      `${keyword} (pc <= ${shard.lastPc}) status = stepShard${shardIndex}(F, deadline, pc);`,
    );
  });
  lines.push('else return "fallback";', '}', 'if (status !== "next") return status;', '}', '}');
  return lines;
}

/** Elapse due time, resume save and deadline split shared by both emitters. */
function elapsed(entry: Instruction, index: number): string[] {
  if (entry.duration === undefined) return [];
  // A computed duration is validated where the generic host validates it, before it is used.
  const duration = entry.dynamicDuration ? `H.checkDuration(${entry.duration})` : entry.duration;
  return [
    `F.due = F.time + ${duration};`,
    'if (F.due > 7200000000000000) throw new RangeError("Time out of range");',
    'if (F.due >= deadline) {',
    ...entry.slots.map((slot, slotIndex) => `L[${slotIndex}] = ${slot};`),
    `F.resume = ${index + 1};`,
    'F.time = deadline;',
    'return "deadline";',
    '}',
    'F.time = F.due;',
  ];
}

function finish(stop: boolean): string {
  return stop ? 'return "stopped";' : 'if (F.stopAfterInstruction) return "invalidated"; continue;';
}

function splitFinish(stop: boolean): string {
  return stop
    ? 'return "stopped";'
    : 'if (F.stopAfterInstruction) return "invalidated"; return "next";';
}

/**
 * A condition slot holds a boolean in every conforming program, so the type check is a
 * `typeof` test inlined at the use site; the host helper only runs on the failure path.
 * A call per condition dominated small instruction blocks.
 */
function guard(condition: string): string {
  return `(typeof ${condition} === "boolean" ? ${condition} : H.checkBoolean(${condition}))`;
}

/**
 * A shard keeps executing while the next PC still routes to it, which removes the
 * dispatcher hop (and its range checks) from every instruction inside one shard. The
 * bounds repeat the dispatcher's own routing predicate, so a PC outside them returns
 * exactly as before.
 */
function stepFinish(
  stop: boolean,
  lower: string | undefined,
  upper: string,
  pcIndex: number,
): string {
  if (stop) return 'return "stopped";';
  const inside = lower === undefined ? `pc <= ${upper}` : `pc <= ${upper} && pc > ${lower}`;
  // The finite-number guard is inlined: a call per instruction costs more than the test.
  return `if (F.stopAfterInstruction) return "invalidated"; pc = S[${pcIndex}]; if (!(typeof pc === "number" && pc < Infinity && pc > -Infinity)) H.checkPc(pc); if (${inside}) continue; return "next";`;
}

function dirty(bank: 'SD' | 'MD', index: number): string {
  return `${bank}[${index >>> 5}] |= ${1 << (index & 31)};`;
}

function validIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

class Instruction {
  readonly readStates = new Set<string>();
  readonly writeStates = new Set<string>();
  readonly readMemories = new Set<string>();
  readonly writeMemories = new Set<string>();
  slots: string[] = [];
  /** Emitted source characters (bodies and guard); bounds the size of one generated function. */
  size = 0;
  /** Emitted before the implicit PC write; a declared busy-wait head folds rounds here. */
  readonly guard: string[] = [];
  /** Entry test against the runtime write barrier; empty when the block writes no slot. */
  barrier: string[] = [];
  prefix: string[] = [];
  suffix: string[] = [];
  /** Numeric instruction key; shards sort by it while `pc` holds the emitted literal. */
  pcValue = 0;
  pc = '';
  nextPc = '';
  duration?: string;
  /** Set when `duration` is a computed slot instead of a compile-time literal. */
  dynamicDuration = false;
  /** Zero-duration terminator: no due time, no continuation, prefix and suffix stay inline. */
  immediate = false;
  stop = false;
  private readonly values = new Map<number, string>();
  private readonly locals = new Map<number, string>();
  private readonly literals = new Map<number, number | boolean>();
  /** Slots this block writes; the runtime barrier is emitted from these indices. */
  private readonly writtenStates = new Set<number>();
  private readonly writtenMemories = new Set<number>();
  /** Results whose type is an object value; identity comparison would change their meaning. */
  private readonly references = new Set<number>();
  private labels = 0;

  constructor(
    private readonly binding: DirectJitBinding,
    private readonly capture: (value: unknown) => string,
  ) {}

  compile(instruction: { pc: number; nextPc: number; body: RegionIR }): this {
    this.pcValue = instruction.pc;
    this.pc = this.literal(instruction.pc);
    this.nextPc = this.literal(instruction.nextPc);
    this.readStates.add(this.binding.pc.name);
    this.state(this.binding.pc.name, true);
    const delay = this.binding.delayLoops?.get(instruction.pc);
    if (delay !== undefined && validIndex(delay.counter) && validIndex(delay.cycles))
      this.guard.push(
        `if (S[${delay.counter}] > 1) {`,
        // Fold only the rounds that end before the horizon: the deadline split stays exact,
        // and a short horizon still makes progress instead of failing to skip at all.
        `const rounds = Math.min(S[${delay.counter}] - 1, Math.floor((deadline - F.time) / ${delay.cycles}));`,
        'if (rounds > 0) {',
        `F.time += rounds * ${delay.cycles};`,
        'if (F.time > 7200000000000000) throw new RangeError("Time out of range");',
        `S[${delay.counter}] = S[${delay.counter}] - rounds;`,
        dirty('SD', delay.counter),
        '}',
        'if (F.time >= deadline) { F.time = deadline; return "deadline"; }',
        '}',
      );
    let output = this.prefix;
    let terminal = false;
    for (const operation of instruction.body.operations) {
      if (terminal) throw unsupported;
      if (operation.kind === 'elapse') {
        if (this.terminated) throw unsupported;
        this.terminate(this.delay(operation.duration));
        output = this.suffix;
      } else if (operation.kind === 'redirect') {
        if (this.terminated) throw unsupported;
        const delay = this.delay(operation.delay);
        output.push(
          `S[${this.binding.pc.index}] = H.checkPc(${this.value(operation.target)});`,
          dirty('SD', this.binding.pc.index),
        );
        this.terminate(delay);
        output = this.suffix;
        terminal = true;
      } else if (operation.kind === 'stop') {
        this.stop = true;
        terminal = true;
      } else if (operation.kind === 'yield') {
        // A bare yield carries no result. Model validation rejects it today, so only the
        // tail-of-body shape is admitted: any later operation is dead code and declines the
        // whole block. Treating it as a zero-duration exit reuses the `elapse 0` path, which
        // advances no time and needs no continuation slot.
        if (this.terminated) throw unsupported;
        this.terminate({ value: '0', zero: true, dynamic: false });
        terminal = true;
      } else {
        this.operation(operation, output);
      }
    }
    if (!this.terminated && !this.stop) throw unsupported;
    this.compact();
    this.barrier = this.emitBarrier();
    this.size = [...this.barrier, ...this.guard, ...this.prefix, ...this.suffix].reduce(
      (sum, line) => sum + line.length,
      0,
    );
    return this;
  }

  /**
   * Runtime write barrier. A block that may write a state or memory the runtime currently
   * observes returns `fallback` before it touches any slot, so the interpreter performs that
   * instruction and observers still see every write. Testing the masks at entry — instead of
   * declining the block at compile time — keeps one program valid across observer changes.
   * Resumed instructions keep their old behaviour: a continuation always completes its
   * suffix, because the interpreter can no longer replay it from that PC.
   */
  private emitBarrier(): string[] {
    const lines: string[] = [];
    const emit = (bank: 'BS' | 'BM', indices: ReadonlySet<number>): void => {
      if (!indices.size) return;
      const words = new Map<number, number>();
      for (const index of indices)
        words.set(index >>> 5, (words.get(index >>> 5) ?? 0) | (1 << (index & 31)));
      for (const [word, mask] of [...words].sort(([left], [right]) => left - right))
        lines.push(`if (${bank}[${word}] & ${mask >>> 0}) return "fallback";`);
    };
    emit('BS', this.writtenStates);
    emit('BM', this.writtenMemories);
    return lines;
  }

  private get terminated(): boolean {
    return this.duration !== undefined || this.immediate;
  }

  /**
   * Register reuse. Every IR result takes its own virtual slot, and a fully decoded Thumb
   * instruction produces well over a thousand of them: the generated function then carries
   * a thousand locals, which keeps V8 from optimising it and makes every execution pay for
   * a huge frame. Values whose live ranges do not overlap can share one slot, so the
   * emitted lines are scanned once: a slot is allocated at its definition and released
   * after the last line that mentions it. Slots assigned more than once (locals, branch
   * outputs) keep the same slot from the first definition through the last use.
   */
  private compact(): void {
    const bound = this.prefix.length;
    const lines = [...this.prefix, ...this.suffix];
    const names = (line: string): number[] =>
      (line.match(/\bv\d+\b/g) ?? []).map((name) => Number(name.slice(1)));
    const definedAt: number[][] = lines.map(() => []);
    const usesAt: number[][] = [];
    const lastDef = new Map<number, number>();
    const firstUse = new Map<number, number>();
    const lastUse = new Map<number, number>();

    lines.forEach((line, index) => {
      const used = names(line);
      const head = /^v(\d+) = /.exec(line);
      if (head !== null) {
        const virtual = Number(head[1]);
        definedAt[index]!.push(virtual);
        lastDef.set(virtual, index);
        const position = used.indexOf(virtual);
        if (position >= 0) used.splice(position, 1);
      }
      for (const virtual of used) {
        if (!firstUse.has(virtual)) firstUse.set(virtual, index);
        lastUse.set(virtual, index);
      }
      usesAt.push(used);
    });

    // Only the define-before-use shape is compacted; anything else keeps the virtual slots,
    // which is always correct.
    const firstDef = new Map<number, number>();
    definedAt.forEach((defs, index) => {
      for (const virtual of defs) if (!firstDef.has(virtual)) firstDef.set(virtual, index);
    });
    for (const [virtual, index] of firstUse)
      if ((firstDef.get(virtual) ?? Infinity) > index) return;

    const end = new Map<number, number>();
    for (const virtual of lastDef.keys())
      end.set(virtual, Math.max(lastDef.get(virtual)!, lastUse.get(virtual) ?? -1));

    const physical = new Map<number, string>();
    const live = new Map<number, string>();
    const free: string[] = [];
    let count = 0;
    const release = (virtual: number): void => {
      const slot = live.get(virtual);
      if (slot === undefined) return;
      live.delete(virtual);
      free.push(slot);
    };

    lines.forEach((_, index) => {
      for (const virtual of definedAt[index]!) {
        if (physical.has(virtual)) continue;
        const slot = free.pop() ?? `v${count++}`;
        physical.set(virtual, slot);
        live.set(virtual, slot);
      }
      for (const virtual of [...definedAt[index]!, ...usesAt[index]!])
        if (end.get(virtual) === index) release(virtual);
    });

    const rewrite = (line: string): string =>
      line.replace(/\bv(\d+)\b/g, (whole, digits: string) => physical.get(Number(digits)) ?? whole);
    this.prefix = lines.slice(0, bound).map((line) => rewrite(line));
    this.suffix = lines.slice(bound).map((line) => rewrite(line));
    if (this.duration !== undefined) this.duration = rewrite(this.duration);
    this.slots = Array.from({ length: count }, (_, index) => `v${index}`);
  }

  /** A zero duration advances no time, so the instruction needs no continuation slot. */
  private terminate(delay: { value: string; zero: boolean; dynamic: boolean }): void {
    if (delay.zero) this.immediate = true;
    else {
      this.duration = delay.value;
      this.dynamicDuration = delay.dynamic;
    }
  }

  private delay(id: number): { value: string; zero: boolean; dynamic: boolean } {
    const literal = this.literals.get(id);
    if (typeof literal === 'number') {
      try {
        checkDuration(literal);
      } catch {
        throw unsupported;
      }
      return { value: this.literal(literal), zero: literal === 0, dynamic: false };
    }
    // A computed duration keeps its slot: the emitted body validates it at the operation's
    // own position, exactly like the generator backend's `H.checkDuration`.
    const slot = this.values.get(id);
    if (slot === undefined) throw unsupported;
    return { value: slot, zero: false, dynamic: true };
  }

  /**
   * Literal source text for values the compiler has already validated as primitive numbers or
   * booleans. NaN, infinities and non-safe integers keep travelling as closure data.
   */
  private literal(value: unknown): string {
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
      return Object.is(value, -0) ? '-0' : String(value);
    }
    if (typeof value === 'string') {
      // JSON encoding is a complete, injection-safe JavaScript string literal; the line
      // separators need escaping for older parsers but remain the same string at runtime.
      return JSON.stringify(value)
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
    }
    return this.capture(value);
  }

  private value(id: number): string {
    const slot = this.values.get(id);
    if (!slot) throw unsupported;
    return slot;
  }

  private slot(): string {
    const slot = `v${this.slots.length}`;
    this.slots.push(slot);
    return slot;
  }

  private state(name: string, write: boolean): number {
    const index = this.binding.states.get(name);
    if (!validIndex(index) || (write && this.binding.blockedStates?.has(name))) throw unsupported;
    (write ? this.writeStates : this.readStates).add(name);
    if (write) this.writtenStates.add(index);
    return index;
  }

  private memory(operation: { readonly kind: string; readonly memory: MemoryRefIR }): number {
    if (operation.memory.kind !== 'memory') throw unsupported;
    const name = operation.memory.name;
    const index = this.binding.memories.get(name);
    const write = operation.kind.startsWith('store');
    // Only stores are write barriers; every load kind, including the wide ones, stays eligible.
    if (!validIndex(index) || (write && this.binding.blockedMemories?.has(name))) throw unsupported;
    (write ? this.writeMemories : this.readMemories).add(name);
    if (write) this.writtenMemories.add(index);
    return index;
  }

  /**
   * A value region that is exactly one last yield over pure scalar operations folds into a
   * single expression. Anything else returns undefined and keeps the labeled block.
   */
  private expression(region: ValueRegionIR): string | undefined {
    if (region.type.kind !== 'number' && region.type.kind !== 'bool') return undefined;
    const { operations } = region.body;
    const last = operations[operations.length - 1];
    if (last?.kind !== 'yield') return undefined;
    const values = new Map<number, string>();
    for (let index = 0; index < operations.length - 1; index++) {
      if (!this.fold(operations[index]!, values)) return undefined;
    }
    return values.get(last.value) ?? this.values.get(last.value);
  }

  /** Local expression for one pure scalar operation; operands fall back to emitted slots. */
  private fold(operation: OperationIR, values: Map<number, string>): boolean {
    if (!('result' in operation) || !('type' in operation)) return false;
    if (operation.type.kind !== 'number' && operation.type.kind !== 'bool') return false;
    const operand = (id: number): string | undefined => values.get(id) ?? this.values.get(id);
    switch (operation.kind) {
      case 'constant': {
        if (operation.constant.kind !== 'number' && operation.constant.kind !== 'bool')
          return false;
        this.literals.set(operation.result, operation.constant.value);
        values.set(operation.result, this.literal(operation.constant.value));
        return true;
      }
      case 'read': {
        if (operation.resource !== 'state') return false;
        values.set(operation.result, `S[${this.state(operation.name, false)}]`);
        return true;
      }
      case 'localRead': {
        const slot = this.locals.get(operation.local);
        if (!slot) return false;
        values.set(operation.result, slot);
        return true;
      }
      case 'unary': {
        const operator = unary[operation.operator];
        const value = operand(operation.value);
        if (!operator || value === undefined) return false;
        values.set(operation.result, `(${operator}${value})`);
        return true;
      }
      case 'binary': {
        const operator = binary[operation.operator];
        const left = operand(operation.left);
        const right = operand(operation.right);
        if (!operator || left === undefined || right === undefined) return false;
        values.set(operation.result, `(${left} ${operator} ${right})`);
        return true;
      }
      case 'numeric': {
        if (!numeric.has(operation.builtin)) return false;
        const args: string[] = [];
        for (const id of operation.args) {
          const value = operand(id);
          if (value === undefined) return false;
          args.push(value);
        }
        const owner = predicates.has(operation.builtin) ? 'Number' : 'Math';
        values.set(operation.result, `${owner}.${operation.builtin}(${args.join(',')})`);
        return true;
      }
      default:
        return false;
    }
  }

  /** Host-based operations require the runtime to have supplied a frame host. */
  private requireHost(): void {
    if (this.binding.host !== true) throw unsupported;
  }

  /** Assertion messages admit only a string constant region, so they stay compile-time data. */
  private message(region: ValueRegionIR): string {
    const operations = region.body.operations;
    const constant = operations[0];
    const delivered = operations[1];
    if (
      operations.length !== 2 ||
      constant?.kind !== 'constant' ||
      constant.constant.kind !== 'string' ||
      delivered?.kind !== 'yield' ||
      delivered.value !== constant.result
    )
      throw unsupported;
    return this.literal(constant.constant.value);
  }

  /** Match constants: validated numbers/booleans inline, names and strings stay data. */
  private pattern(pattern: MatchPatternIR): string {
    switch (pattern.kind) {
      case 'none':
        return 'null';
      case 'number':
      case 'bool':
        return this.literal(pattern.value);
      case 'string':
        return this.literal(pattern.value);
      case 'enum':
        return this.literal(pattern.member);
    }
  }

  private region(
    region: RegionIR,
    lines: string[],
    output?: { slot: string; label: string },
  ): void {
    for (const operation of region.operations) {
      if (operation.kind === 'yield') {
        if (!output) throw unsupported;
        lines.push(`${output.slot} = ${this.value(operation.value)}; break ${output.label};`);
      } else {
        this.operation(operation, lines, output);
      }
    }
  }

  private operation(
    operation: OperationIR,
    lines: string[],
    output?: { slot: string; label: string },
  ): void {
    let result: string | undefined;
    if (hosted.has(operation.kind)) this.requireHost();
    if ('result' in operation) {
      const kind = operation.type.kind;
      if (kind !== 'number' && kind !== 'bool') {
        const allowed =
          wideResults.has(operation.kind) ||
          (operation.kind === 'constant' &&
            (kind === 'string' || kind === 'enum' || kind === 'bytes'));
        if (!allowed) throw unsupported;
      }
      result = this.slot();
      this.values.set(operation.result, result);
      if (referenceResults.has(kind)) this.references.add(operation.result);
    }
    const assign = (expression: string): void => {
      lines.push(`${result!} = ${expression};`);
    };
    switch (operation.kind) {
      case 'constant': {
        const { constant } = operation;
        if (constant.kind === 'number' || constant.kind === 'bool') {
          this.literals.set(operation.result, constant.value);
          assign(this.literal(constant.value));
        } else if (constant.kind === 'string') {
          assign(this.literal(constant.value));
        } else if (constant.kind === 'enum') {
          assign(this.literal(constant.member));
        } else if (constant.kind === 'bytes') {
          // The generic host materialises the literal when it compiles the body, so an
          // out-of-range element declines compilation here and keeps that same error.
          let bytes: readonly number[];
          try {
            bytes = Object.freeze(Array.from(createBytes(constant.value)));
          } catch {
            throw unsupported;
          }
          // Every evaluation still gets a fresh Uint8Array, exactly like `H.createBytes`.
          assign(`H.createBytes(${this.capture(bytes)})`);
        } else throw unsupported;
        break;
      }
      case 'read':
        if (operation.resource !== 'state') throw unsupported;
        assign(`S[${this.state(operation.name, false)}]`);
        break;
      case 'write': {
        const index = this.state(operation.name, true);
        lines.push(`S[${index}] = ${this.value(operation.value)};`, dirty('SD', index));
        break;
      }
      case 'unary': {
        const operator = unary[operation.operator];
        if (!operator) throw unsupported;
        assign(`(${operator}${this.value(operation.value)})`);
        break;
      }
      case 'binary': {
        const operator = binary[operation.operator];
        if (!operator) throw unsupported;
        const left = this.value(operation.left);
        const right = this.value(operation.right);
        // Byte sequences and intents compare by content in the generic host; `===` would
        // compare identity and silently change the result.
        if (
          (operation.operator === 'equal' || operation.operator === 'notEqual') &&
          (this.references.has(operation.left) || this.references.has(operation.right))
        ) {
          assign(`${operation.operator === 'notEqual' ? '!' : ''}H.equalValues(${left},${right})`);
          break;
        }
        assign(`(${left} ${operator} ${right})`);
        break;
      }
      case 'numeric':
        if (!numeric.has(operation.builtin)) throw unsupported;
        assign(
          `${predicates.has(operation.builtin) ? 'Number' : 'Math'}.${operation.builtin}(${operation.args.map((id) => this.value(id)).join(',')})`,
        );
        break;
      case 'send':
        lines.push(
          `F.host.send(${this.capture(operation.channel)}, ${this.value(operation.value)});`,
        );
        break;
      case 'notify':
        lines.push(`F.host.notify(${this.capture(operation.notification)});`);
        break;
      case 'readSample':
        if (operation.pin.kind !== 'pin') throw unsupported;
        assign(`F.host.sample(${this.capture(operation.pin.name)})`);
        break;
      case 'writeIntent':
        if (operation.pin.kind !== 'pin') throw unsupported;
        lines.push(
          `F.host.intent(${this.capture(operation.pin.name)}, ${this.value(operation.value)});`,
        );
        break;
      case 'resistor':
        if (operation.to.kind !== 'pin') throw unsupported;
        assign(
          `F.host.resistor(${this.capture(operation.to.name)}, ${this.value(operation.resistance)})`,
        );
        break;
      case 'combineIntents':
        assign(`H.combineIntents([${operation.values.map((id) => this.value(id)).join(',')}])`);
        break;
      case 'field':
        assign(`${this.value(operation.value)}[${this.capture(operation.field)}]`);
        break;
      case 'bytes':
        assign(`H.createBytes([${operation.elements.map((id) => this.value(id)).join(',')}])`);
        break;
      case 'index':
        assign(`H.readIndex(${this.value(operation.value)},${this.value(operation.index)})`);
        break;
      case 'refEqual':
        if (operation.left.kind === 'parameter' || operation.right.kind === 'parameter')
          throw unsupported;
        assign(operation.left.name === operation.right.name ? 'true' : 'false');
        break;
      case 'length':
        assign(`${this.value(operation.value)}.length`);
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
      case 'now':
        // The frame clock already holds this board time; host.now() would lag it.
        assign('F.time');
        break;
      case 'random':
        assign('F.host.random()');
        break;
      case 'assert': {
        const message =
          operation.message === undefined ? 'undefined' : this.message(operation.message);
        lines.push(
          `if (!${guard(this.value(operation.condition))}) F.host.assert(false, ${message});`,
        );
        break;
      }
      case 'local': {
        if (operation.type.kind !== 'number' && operation.type.kind !== 'bool') throw unsupported;
        const slot = this.slot();
        this.locals.set(operation.local, slot);
        lines.push(`${slot} = ${this.value(operation.initial)};`);
        break;
      }
      case 'localRead': {
        const slot = this.locals.get(operation.local);
        if (!slot) throw unsupported;
        assign(slot);
        break;
      }
      case 'localWrite': {
        const slot = this.locals.get(operation.local);
        if (!slot) throw unsupported;
        lines.push(`${slot} = ${this.value(operation.value)};`);
        break;
      }
      case 'load8': {
        const memory = `M[${this.memory(operation)}]`;
        assign(`${memory}[H.offset(${memory},${this.value(operation.offset)})]`);
        break;
      }
      case 'store8': {
        const index = this.memory(operation);
        const memory = `M[${index}]`;
        // Check the address before the value, as the generic host does.
        lines.push(
          `${memory}[H.offset(${memory},${this.value(operation.offset)})] = H.byte(${this.value(operation.value)});`,
          dirty('MD', index),
        );
        break;
      }
      case 'load16le':
      case 'load16be': {
        const memory = `M[${this.memory(operation)}]`;
        const little = operation.kind.endsWith('le') ? 'true' : 'false';
        assign(`H.load16(${memory},${this.value(operation.offset)},${little})`);
        break;
      }
      case 'load32le':
      case 'load32be': {
        const memory = `M[${this.memory(operation)}]`;
        const little = operation.kind.endsWith('le') ? 'true' : 'false';
        assign(`H.load32(${memory},${this.value(operation.offset)},${little})`);
        break;
      }
      case 'store16le':
      case 'store16be':
      case 'store32le':
      case 'store32be': {
        const index = this.memory(operation);
        const memory = `M[${index}]`;
        const store = operation.kind.startsWith('store16') ? 'store16' : 'store32';
        const little = operation.kind.endsWith('le') ? 'true' : 'false';
        // Address validation precedes the stored-value check inside the helper.
        lines.push(
          `H.${store}(${memory},${this.value(operation.offset)},${this.value(operation.value)},${little});`,
          dirty('MD', index),
        );
        break;
      }
      case 'and':
      case 'or': {
        if (operation.right.body.operations.at(-1)?.kind !== 'yield') throw unsupported;
        const label = `${operation.kind}${this.labels++}`;
        lines.push(
          `${result} = ${guard(this.value(operation.left))};`,
          `${operation.kind === 'or' ? 'if (!' : 'if ('}${result}) {`,
          `${label}: {`,
        );
        this.region(operation.right.body, lines, { slot: result!, label });
        lines.push('}', `${result} = ${guard(result!)};`, '}');
        break;
      }
      case 'match': {
        const value = this.value(operation.value);
        if (!operation.arms.length && !operation.otherwise) throw unsupported;
        // Without an else arm a value-position match could leave its output unassigned.
        if (!operation.otherwise && output) throw unsupported;
        operation.arms.forEach((arm, index) => {
          const pattern = this.pattern(arm.pattern);
          lines.push(`${index ? '} else if' : 'if'} (H.equalValues(${value}, ${pattern})) {`);
          this.region(arm.body, lines, output);
        });
        if (operation.otherwise) {
          lines.push(operation.arms.length ? '} else {' : '{');
          this.region(operation.otherwise, lines, output);
        }
        lines.push('}');
        break;
      }
      case 'if':
        lines.push(`if (${guard(this.value(operation.condition))}) {`);
        this.region(operation.yes, lines, output);
        if (operation.no) {
          lines.push('} else {');
          this.region(operation.no, lines, output);
        }
        lines.push('}');
        break;
      case 'select': {
        const condition = this.value(operation.condition);
        const yes = this.expression(operation.yes);
        const no = yes === undefined ? undefined : this.expression(operation.no);
        if (yes !== undefined && no !== undefined) {
          lines.push(`${result} = ${guard(condition)} ? ${yes} : ${no};`);
          break;
        }
        const label = `select${this.labels++}`;
        lines.push(`${label}: {`, `if (${guard(condition)}) {`);
        this.region(operation.yes.body, lines, { slot: result!, label });
        lines.push('} else {');
        this.region(operation.no.body, lines, { slot: result!, label });
        lines.push('}', '}');
        break;
      }
      default:
        throw unsupported;
    }
  }
}
