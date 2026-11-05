import type { BinaryOperator, MemoryRefIR, OperationIR, RegionIR } from '@mica-js/device-model';
import type {
  DirectJitBinding,
  DirectJitFrame,
  DirectJitProgram,
  DirectJitReason,
} from './types.js';
import { checkBoolean, checkDuration, checkPc } from './values.js';

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

const helpers = Object.freeze({ checkBoolean, checkPc, offset, byte });
const unsupported = Symbol('unsupported direct instruction');

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
  const lines = [
    'function run(F, deadline) {',
    'const S = F.states, M = F.memories, L = F.locals, SD = F.stateDirty, MD = F.memoryDirty;',
    ...(registers.length ? [`let ${registers.join(',')};`] : []),
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
      `S[${binding.pc.index}] = ${entry.nextPc};`,
      dirty('SD', binding.pc.index),
      ...entry.prefix,
    );
    if (entry.duration !== undefined) {
      lines.push(
        `F.due = F.time + ${entry.duration};`,
        'if (F.due > 7200000000000000) throw new RangeError("Time out of range");',
        'if (F.due >= deadline) {',
      );
      entry.slots.forEach((slot, slotIndex) => lines.push(`L[${slotIndex}] = ${slot};`));
      lines.push(`F.resume = ${index + 1};`, 'F.time = deadline;', 'return "deadline";', '}');
      lines.push('F.time = F.due;');
    }
    lines.push(...entry.suffix, finish(entry.stop), '}');
  });
  lines.push('default: return "fallback";', '}', '}', '}');
  // Only compiler-owned templates/indices enter source; all IR constants are closure data.
  const factory = new Function('C', 'H', `"use strict"; return (${lines.join('\n')});`) as (
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

function finish(stop: boolean): string {
  return stop ? 'return "stopped";' : 'if (F.stopAfterInstruction) return "invalidated"; continue;';
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
  readonly slots: string[] = [];
  prefix: string[] = [];
  suffix: string[] = [];
  pc = '';
  nextPc = '';
  duration?: string;
  stop = false;
  private readonly values = new Map<number, string>();
  private readonly locals = new Map<number, string>();
  private readonly literals = new Map<number, number | boolean>();
  private labels = 0;

  constructor(
    private readonly binding: DirectJitBinding,
    private readonly capture: (value: unknown) => string,
  ) {}

  compile(instruction: { pc: number; nextPc: number; body: RegionIR }): this {
    this.pc = this.capture(instruction.pc);
    this.nextPc = this.capture(instruction.nextPc);
    this.readStates.add(this.binding.pc.name);
    this.state(this.binding.pc.name, true);
    let output = this.prefix;
    let terminal = false;
    for (const operation of instruction.body.operations) {
      if (terminal) throw unsupported;
      if (operation.kind === 'elapse') {
        if (this.duration !== undefined) throw unsupported;
        this.duration = this.delay(operation.duration);
        output = this.suffix;
      } else if (operation.kind === 'redirect') {
        if (this.duration !== undefined) throw unsupported;
        const duration = this.delay(operation.delay);
        output.push(
          `S[${this.binding.pc.index}] = H.checkPc(${this.value(operation.target)});`,
          dirty('SD', this.binding.pc.index),
        );
        this.duration = duration;
        output = this.suffix;
        terminal = true;
      } else if (operation.kind === 'stop') {
        this.stop = true;
        terminal = true;
      } else {
        this.operation(operation, output);
      }
    }
    if (this.duration === undefined && !this.stop) throw unsupported;
    return this;
  }

  private delay(id: number): string {
    const duration = this.literals.get(id);
    if (typeof duration !== 'number') throw unsupported;
    try {
      checkDuration(duration);
    } catch {
      throw unsupported;
    }
    if (duration <= 0) throw unsupported;
    return this.capture(duration);
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
    return index;
  }

  private memory(operation: { readonly kind: string; readonly memory: MemoryRefIR }): number {
    if (operation.memory.kind !== 'memory') throw unsupported;
    const name = operation.memory.name;
    const index = this.binding.memories.get(name);
    if (
      !validIndex(index) ||
      (operation.kind !== 'load8' && this.binding.blockedMemories?.has(name))
    )
      throw unsupported;
    (operation.kind === 'load8' ? this.readMemories : this.writeMemories).add(name);
    return index;
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
    if ('result' in operation) {
      if (operation.type.kind !== 'number' && operation.type.kind !== 'bool') throw unsupported;
      result = this.slot();
      this.values.set(operation.result, result);
    }
    const assign = (expression: string): void => {
      lines.push(`${result!} = ${expression};`);
    };
    switch (operation.kind) {
      case 'constant':
        if (operation.constant.kind !== 'number' && operation.constant.kind !== 'bool')
          throw unsupported;
        this.literals.set(operation.result, operation.constant.value);
        assign(this.capture(operation.constant.value));
        break;
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
        const operator = { positive: '+', negate: '-', not: '!', bitNot: '~' }[operation.operator];
        if (!operator) throw unsupported;
        assign(`(${operator}${this.value(operation.value)})`);
        break;
      }
      case 'binary': {
        const operator = binary[operation.operator];
        if (!operator) throw unsupported;
        assign(`(${this.value(operation.left)} ${operator} ${this.value(operation.right)})`);
        break;
      }
      case 'numeric':
        if (!numeric.has(operation.builtin)) throw unsupported;
        assign(
          `${predicates.has(operation.builtin) ? 'Number' : 'Math'}.${operation.builtin}(${operation.args.map((id) => this.value(id)).join(',')})`,
        );
        break;
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
      case 'if':
        lines.push(`if (H.checkBoolean(${this.value(operation.condition)})) {`);
        this.region(operation.yes, lines, output);
        if (operation.no) {
          lines.push('} else {');
          this.region(operation.no, lines, output);
        }
        lines.push('}');
        break;
      case 'select': {
        const label = `select${this.labels++}`;
        lines.push(`${label}: {`, `if (H.checkBoolean(${this.value(operation.condition)})) {`);
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
