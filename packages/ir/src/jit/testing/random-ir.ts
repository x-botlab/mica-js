/**
 * Seeded random IR generator for JIT parity fuzzing (#149).
 *
 * The generator is deliberately structured rather than grammar-driven: every
 * program is built with the public builder, so it is valid by construction and
 * `randomProgram` re-checks it with `validateIR` before returning. A program
 * always exposes:
 *
 * - a `run` function `(u32, u32, f64, bool) -> (u32, f64, bool)`;
 * - integer, float, boolean and conversion arithmetic;
 * - state, array and byte storage (including updates, fills and overlapping
 *   copies);
 * - nested diamonds and counted loops (bounded, never unbounded);
 * - an optional provider whose artifact reads a mutable byte resource, with a
 *   dispatch sequence that hits, invalidates and re-generates the cache.
 *
 * Everything derives from `mulberry32(seed)`, so a failure reported by seed can
 * be reproduced exactly. The module is never exported from the package entry
 * point; the `jit/testing` directory is test-only.
 */
import { CORE_INSTRUCTION_NAMES } from '../../builder';
import { createIRModule } from '../../module';
import { FLOAT_TYPES, INTEGER_TYPES } from '../../types';
import type {
  ArrayRef,
  BytesRef,
  Endian,
  FloatBits,
  FloatType,
  FunctionBuilder,
  FunctionRef,
  HexBits,
  InboxRef,
  IntegerType,
  IRModule,
  Predicate,
  ReadableBytesRef,
  RuntimeScalar,
  ScalarType,
  StateRef,
  Value,
} from '../../types';
import { validateIR } from '../../validate';
import type { IRResourcePermission, IRValidationOptions } from '../../validation-types';

/* -------------------------------------------------------------------------
 * PRNG
 * ---------------------------------------------------------------------- */

/** Deterministic 32-bit PRNG; the same seed always produces the same stream. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

export interface RandomSource {
  readonly next: () => number;
  int(min: number, max: number): number;
  chance(probability: number): boolean;
  pick<T>(values: readonly T[]): T;
  weighted<T>(entries: readonly (readonly [T, number])[]): T;
}

export function createRandomSource(seed: number): RandomSource {
  const next = mulberry32(seed);
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(values: readonly T[]): T => values[int(0, values.length - 1)]!;
  return {
    next,
    int,
    chance: (probability) => next() < probability,
    pick,
    weighted<T>(entries: readonly (readonly [T, number])[]): T {
      const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
      let threshold = next() * total;
      for (const [value, weight] of entries) {
        threshold -= weight;
        if (threshold < 0) return value;
      }
      return entries[entries.length - 1]![0];
    },
  };
}

/* -------------------------------------------------------------------------
 * Public shapes
 * ---------------------------------------------------------------------- */

export type RandomProfile =
  'default' | 'float-heavy' | 'provider-heavy' | 'deep-recursion' | 'storage-heavy';

export interface RandomProgramConfig {
  readonly seed: number;
  readonly profile?: RandomProfile;
  /** Inclusive target range for the number of emitted instruction nodes. */
  readonly instructionRange?: readonly [number, number];
  /** Per-scalar-type weights; merged over the profile defaults. */
  readonly typeDistribution?: Partial<Record<ScalarType, number>>;
  /** Maximum nesting depth of diamonds and loops. */
  readonly maxDepth?: number;
  /** Upper bound for a generated loop counter (inclusive). */
  readonly maxLoopIterations?: number;
  /** Number of sequential executions of the same engine instance. */
  readonly invocations?: number;
  /** Omit the provider fixture when false. */
  readonly provider?: boolean;
  /** Omit storage instructions when false. */
  readonly storage?: boolean;
  readonly controlFlow?: boolean;
  readonly maxSteps?: number;
}

export const RANDOM_PROGRAM_SIGNATURE = {
  params: ['u32', 'u32', 'f64', 'bool'],
  results: ['u32', 'f64', 'bool'],
} as const;

export type RandomProgramTarget = FunctionRef<
  typeof RANDOM_PROGRAM_SIGNATURE.params,
  typeof RANDOM_PROGRAM_SIGNATURE.results
>;

export interface RandomProgramSummary {
  readonly functions: number;
  readonly blocks: number;
  readonly instructions: number;
  readonly loops: number;
  readonly branches: number;
  readonly providers: number;
  readonly targetInstructions: number;
}

export interface RandomProgram {
  readonly seed: number;
  readonly profile: RandomProfile;
  readonly module: IRModule;
  readonly target: RandomProgramTarget;
  /** Executed in order against one engine instance. */
  readonly invocations: readonly (readonly RuntimeScalar[])[];
  readonly validation: IRValidationOptions;
  readonly maxSteps: number | undefined;
  readonly summary: RandomProgramSummary;
  /**
   * Successful provider generations seen so far, plus the keys that caused
   * them. Reset by the oracle before each engine run; equal values imply equal
   * `ProviderRuntime.cacheEpoch` because every successful generation bumps
   * that counter exactly once.
   */
  readonly stats: { generated: number; keys: number[] };
}

/* -------------------------------------------------------------------------
 * Profiles
 * ---------------------------------------------------------------------- */

interface ProfileDefaults {
  readonly instructionRange: readonly [number, number];
  readonly typeDistribution: Readonly<Record<ScalarType, number>>;
  readonly maxDepth: number;
  readonly maxLoopIterations: number;
  readonly invocations: number;
}

const BASE_TYPES: Record<ScalarType, number> = {
  bool: 1,
  u8: 1,
  u16: 1,
  u32: 3,
  i8: 1,
  i16: 1,
  i32: 2,
  f32: 2,
  f64: 3,
};

const PROFILES: Readonly<Record<RandomProfile, ProfileDefaults>> = {
  default: {
    instructionRange: [24, 56],
    typeDistribution: BASE_TYPES,
    maxDepth: 2,
    maxLoopIterations: 3,
    invocations: 3,
  },
  'float-heavy': {
    instructionRange: [24, 56],
    typeDistribution: {
      bool: 1,
      u8: 1,
      u16: 1,
      u32: 2,
      i8: 1,
      i16: 1,
      i32: 2,
      f32: 8,
      f64: 8,
    },
    maxDepth: 1,
    maxLoopIterations: 2,
    invocations: 3,
  },
  'provider-heavy': {
    instructionRange: [20, 48],
    typeDistribution: BASE_TYPES,
    maxDepth: 2,
    maxLoopIterations: 2,
    invocations: 6,
  },
  'deep-recursion': {
    instructionRange: [32, 72],
    typeDistribution: BASE_TYPES,
    maxDepth: 4,
    maxLoopIterations: 2,
    invocations: 3,
  },
  'storage-heavy': {
    instructionRange: [24, 56],
    typeDistribution: {
      bool: 1,
      u8: 3,
      u16: 3,
      u32: 4,
      i8: 2,
      i16: 2,
      i32: 3,
      f32: 3,
      f64: 3,
    },
    maxDepth: 2,
    maxLoopIterations: 3,
    invocations: 3,
  },
};

interface ResolvedConfig {
  readonly profile: RandomProfile;
  readonly instructionRange: readonly [number, number];
  readonly typeDistribution: Readonly<Record<ScalarType, number>>;
  readonly maxDepth: number;
  readonly maxLoopIterations: number;
  readonly invocations: number;
  readonly provider: boolean;
  readonly storage: boolean;
  readonly controlFlow: boolean;
  readonly maxSteps: number | undefined;
}

function resolveConfig(config: RandomProgramConfig): ResolvedConfig {
  const profile = config.profile ?? 'default';
  const defaults = PROFILES[profile];
  const distribution = { ...defaults.typeDistribution };
  if (config.typeDistribution !== undefined) {
    for (const type of Object.keys(config.typeDistribution) as ScalarType[]) {
      const weight = config.typeDistribution[type];
      if (weight !== undefined) distribution[type] = weight;
    }
  }
  return {
    profile,
    instructionRange: config.instructionRange ?? defaults.instructionRange,
    typeDistribution: distribution,
    maxDepth: config.maxDepth ?? defaults.maxDepth,
    maxLoopIterations: config.maxLoopIterations ?? defaults.maxLoopIterations,
    invocations: config.invocations ?? defaults.invocations,
    provider: config.provider ?? true,
    storage: config.storage ?? true,
    controlFlow: config.controlFlow ?? true,
    maxSteps: config.maxSteps,
  };
}

/* -------------------------------------------------------------------------
 * Values and loose typed-operation helpers
 * ---------------------------------------------------------------------- */

type AnyValue = Value<ScalarType>;

/**
 * The builder exposes precise generic operations; the generator picks types at
 * run time. These casts keep the call sites readable while `createIRModule`
 * still performs the real validation on every operand.
 */
function loose(fn: unknown, ...args: readonly unknown[]): AnyValue {
  return (fn as (...values: readonly unknown[]) => AnyValue)(...args);
}

const INTEGER_SET: readonly IntegerType[] = INTEGER_TYPES;
const FLOAT_SET: readonly FloatType[] = FLOAT_TYPES;

const INT_LIMITS: Readonly<Record<IntegerType, readonly [number, number]>> = {
  u8: [0, 0xff],
  u16: [0, 0xffff],
  u32: [0, 0xffff_ffff],
  i8: [-0x80, 0x7f],
  i16: [-0x8000, 0x7fff],
  i32: [-0x8000_0000, 0x7fff_ffff],
};

const FLOAT_BITS: Readonly<Record<FloatType, readonly HexBits[]>> = {
  f32: [
    '0x00000000',
    '0x80000000',
    '0x7f800000',
    '0xff800000',
    '0x7fc00000',
    '0x7fc00001',
    '0x7FA00002',
    '0xffc00000',
    '0x00000001',
    '0x3f800000',
    '0x40490fdb',
  ],
  f64: [
    '0x0000000000000000',
    '0x8000000000000000',
    '0x7ff0000000000000',
    '0xfff0000000000000',
    '0x7ff8000000000000',
    '0x7ff8000000000001',
    '0x7FF0000000000002',
    '0xfff8000000000000',
    '0x0000000000000001',
    '0x3ff0000000000000',
    '0x400921fb54442d18',
  ],
};

const ZEXT_PAIRS: readonly (readonly [IntegerType, IntegerType])[] = [
  ['u8', 'u16'],
  ['u8', 'u32'],
  ['u8', 'i16'],
  ['u8', 'i32'],
  ['u16', 'u32'],
  ['u16', 'i32'],
  ['i8', 'u16'],
  ['i8', 'i32'],
  ['i8', 'i16'],
  ['i16', 'u32'],
  ['i16', 'i32'],
];

const SEXT_PAIRS: readonly (readonly [IntegerType, IntegerType])[] = [
  ['i8', 'i16'],
  ['i8', 'i32'],
  ['i16', 'i32'],
];

const TRUNC_PAIRS: readonly (readonly [IntegerType, IntegerType])[] = ZEXT_PAIRS.map(
  ([from, to]) => [to, from] as const,
);

const REINTERPRET_PAIRS: readonly (readonly [IntegerType, IntegerType])[] = [
  ['u8', 'i8'],
  ['i8', 'u8'],
  ['u16', 'i16'],
  ['i16', 'u16'],
  ['u32', 'i32'],
  ['i32', 'u32'],
];

/* -------------------------------------------------------------------------
 * Generator
 * ---------------------------------------------------------------------- */

interface Memories {
  readonly stateWord: StateRef<'u32'>;
  readonly stateSigned: StateRef<'i32'>;
  readonly stateFloat: StateRef<'f64'>;
  readonly stateFlag: StateRef<'bool'>;
  readonly arrayWord: ArrayRef<'u16'>;
  readonly arrayFloat: ArrayRef<'f32'>;
  readonly ram: BytesRef<false>;
  readonly rom: BytesRef<true>;
  readonly inbox: InboxRef;
  readonly firmware: BytesRef<true>;
}

interface ProviderFixture {
  readonly helper: FunctionRef<readonly ['u32', 'u32'], readonly ['u32']>;
}

interface BlockParameter {
  readonly type: ScalarType;
  readonly value: AnyValue;
}

class BlockEmitter<R extends readonly ScalarType[]> {
  readonly #pool = new Map<ScalarType, AnyValue[]>();
  readonly #u32Constants = new Map<number, Value<'u32'>>();

  constructor(
    readonly b: FunctionBuilder<R>,
    readonly generator: ProgramGenerator,
    parameters: readonly BlockParameter[],
  ) {
    for (const parameter of parameters) this.add(parameter.type, parameter.value);
  }

  add(type: ScalarType, value: AnyValue): void {
    const values = this.#pool.get(type);
    if (values === undefined) this.#pool.set(type, [value]);
    else values.push(value);
  }

  value<T extends ScalarType>(type: T): Value<T> {
    const values = this.#pool.get(type);
    if (values !== undefined && values.length > 0 && this.generator.rng.chance(0.65)) {
      return this.generator.rng.pick(values) as Value<T>;
    }
    const constant = this.generator.emitConstant(this.b, type);
    this.add(type, constant);
    return constant as Value<T>;
  }

  /** A small u32 constant, cached per block so offsets do not flood the IR. */
  u32(value: number): Value<'u32'> {
    const cached = this.#u32Constants.get(value);
    if (cached !== undefined) return cached;
    const constant = this.generator.emitConstant(this.b, 'u32', value) as Value<'u32'>;
    this.#u32Constants.set(value, constant);
    return constant;
  }

  integer(): IntegerType {
    return this.generator.pickInteger();
  }

  float(): FloatType {
    return this.generator.pickFloat();
  }

  scalar(): ScalarType {
    return this.generator.pickScalar();
  }
}

class ProgramGenerator {
  readonly rng: RandomSource;
  readonly config: ResolvedConfig;
  readonly memories: Memories;
  readonly counters = { loops: 0, branches: 0 };
  targetInstructions = 0;
  instructionCount = 0;

  constructor(config: ResolvedConfig, seed: number, memories: Memories) {
    this.config = config;
    this.rng = createRandomSource(seed);
    this.memories = memories;
    this.targetInstructions = this.rng.int(config.instructionRange[0], config.instructionRange[1]);
  }

  pickInteger(): IntegerType {
    return this.rng.weighted(INTEGER_SET.map((type) => [type, this.weight(type)] as const));
  }

  pickFloat(): FloatType {
    return this.rng.weighted(FLOAT_SET.map((type) => [type, this.weight(type)] as const));
  }

  pickScalar(): ScalarType {
    return this.rng.weighted(
      ([...INTEGER_SET, ...FLOAT_SET, 'bool'] as const).map(
        (type) => [type, this.weight(type)] as const,
      ),
    );
  }

  weight(type: ScalarType): number {
    return this.config.typeDistribution[type];
  }

  occupied(): boolean {
    return this.instructionCount >= this.targetInstructions;
  }

  noteInstruction(): void {
    this.instructionCount += 1;
  }

  emitConstant<R extends readonly ScalarType[]>(
    b: FunctionBuilder<R>,
    type: ScalarType,
    forced?: number,
  ): AnyValue {
    this.noteInstruction();
    if (type === 'bool') return b.const('bool', this.rng.chance(0.5));
    if (type === 'f32' || type === 'f64') {
      const bits = this.rng.pick(FLOAT_BITS[type]);
      if (this.rng.chance(0.45)) return b.bits(type, bits);
      return b.const(type, this.rng.pick([0, 1, -1, 0.5, -2.25, 1e10, -1e-10]));
    }
    const [min, max] = INT_LIMITS[type];
    if (forced !== undefined) return b.const(type, forced);
    const boundary = this.rng.weighted([
      [0, 3],
      [1, 2],
      [type.startsWith('u') ? 0 : -1, 2],
      [min, 1],
      [max, 1],
      [this.rng.int(min, max), 4],
    ]);
    return b.const(type, boundary);
  }

  /** Emit one random instruction, or a constant once the target is reached. */
  emitRandomOp<R extends readonly ScalarType[]>(emitter: BlockEmitter<R>): void {
    if (this.occupied()) {
      const type = emitter.scalar();
      const value = this.emitConstant(emitter.b, type);
      emitter.add(type, value);
      return;
    }
    const category = this.rng.weighted([
      ['int', 4],
      ['float', 3],
      ['bool', 1],
      ['select', 1],
      ['convert', 1],
      ['memory', this.config.storage ? 3 : 0],
    ] as const);
    switch (category) {
      case 'int':
        this.emitInteger(emitter);
        return;
      case 'float':
        this.emitFloat(emitter);
        return;
      case 'bool':
        this.emitBoolean(emitter);
        return;
      case 'select':
        this.emitSelect(emitter);
        return;
      case 'convert':
        this.emitConversion(emitter);
        return;
      case 'memory':
        this.emitMemory(emitter);
        return;
    }
  }

  emitInteger<R extends readonly ScalarType[]>(emitter: BlockEmitter<R>): void {
    const b = emitter.b;
    const type = emitter.integer();
    const left = emitter.value(type);
    const right = emitter.value(type);
    const choice = this.rng.weighted([
      ['add', 3],
      ['sub', 3],
      ['mul', 3],
      ['div', 1],
      ['rem', 1],
      ['and', 2],
      ['or', 2],
      ['xor', 2],
      ['not', 1],
      ['shl', 2],
      ['lshr', 2],
      ['ashr', type.startsWith('i') ? 2 : 0],
      ['cmp', 3],
    ] as const);
    this.noteInstruction();
    switch (choice) {
      case 'add':
        emitter.add(type, loose(b.int.add, left, right));
        return;
      case 'sub':
        emitter.add(type, loose(b.int.sub, left, right));
        return;
      case 'mul':
        emitter.add(type, loose(b.int.mul, left, right));
        return;
      case 'div':
        emitter.add(type, loose(b.int.div, left, right));
        return;
      case 'rem':
        emitter.add(type, loose(b.int.rem, left, right));
        return;
      case 'and':
        emitter.add(type, loose(b.int.and, left, right));
        return;
      case 'or':
        emitter.add(type, loose(b.int.or, left, right));
        return;
      case 'xor':
        emitter.add(type, loose(b.int.xor, left, right));
        return;
      case 'not':
        emitter.add(type, loose(b.int.not, left));
        return;
      case 'shl':
        emitter.add(type, loose(b.int.shl, left, emitter.value('u32')));
        return;
      case 'lshr':
        emitter.add(type, loose(b.int.lshr, left, emitter.value('u32')));
        return;
      case 'ashr':
        emitter.add(type, loose(b.int.ashr, left, emitter.value('u32')));
        return;
      case 'cmp': {
        const predicate: Predicate = this.rng.pick(['eq', 'ne', 'lt', 'le', 'gt', 'ge']);
        emitter.add('bool', loose(b.int.cmp, predicate, left, right));
        return;
      }
    }
  }

  emitFloat<R extends readonly ScalarType[]>(emitter: BlockEmitter<R>): void {
    const b = emitter.b;
    const type = emitter.float();
    const choice = this.rng.weighted([
      ['add', 2],
      ['sub', 2],
      ['mul', 2],
      ['div', 2],
      ['fma', 2],
      ['cmp', 2],
      ['isNaN', 1],
      ['isFinite', 1],
    ] as const);
    this.noteInstruction();
    switch (choice) {
      case 'add':
        emitter.add(type, loose(b.float.add, emitter.value(type), emitter.value(type)));
        return;
      case 'sub':
        emitter.add(type, loose(b.float.sub, emitter.value(type), emitter.value(type)));
        return;
      case 'mul':
        emitter.add(type, loose(b.float.mul, emitter.value(type), emitter.value(type)));
        return;
      case 'div':
        emitter.add(type, loose(b.float.div, emitter.value(type), emitter.value(type)));
        return;
      case 'fma':
        emitter.add(
          type,
          loose(b.float.fma, emitter.value(type), emitter.value(type), emitter.value(type)),
        );
        return;
      case 'cmp': {
        const predicate: Predicate = this.rng.pick(['eq', 'ne', 'lt', 'le', 'gt', 'ge']);
        emitter.add(
          'bool',
          loose(b.float.cmp, predicate, emitter.value(type), emitter.value(type)),
        );
        return;
      }
      case 'isNaN':
        emitter.add('bool', loose(b.float.isNaN, emitter.value(type)));
        return;
      case 'isFinite':
        emitter.add('bool', loose(b.float.isFinite, emitter.value(type)));
        return;
    }
  }

  emitBoolean<R extends readonly ScalarType[]>(emitter: BlockEmitter<R>): void {
    const b = emitter.b;
    const choice = this.rng.weighted([
      ['not', 1],
      ['and', 2],
      ['or', 2],
      ['xor', 2],
      ['cmp', 2],
    ] as const);
    this.noteInstruction();
    switch (choice) {
      case 'not':
        emitter.add('bool', loose(b.bool.not, emitter.value('bool')));
        return;
      case 'and':
        emitter.add('bool', loose(b.bool.and, emitter.value('bool'), emitter.value('bool')));
        return;
      case 'or':
        emitter.add('bool', loose(b.bool.or, emitter.value('bool'), emitter.value('bool')));
        return;
      case 'xor':
        emitter.add('bool', loose(b.bool.xor, emitter.value('bool'), emitter.value('bool')));
        return;
      case 'cmp': {
        const type = emitter.integer();
        const predicate: Predicate = this.rng.pick(['eq', 'ne', 'lt', 'le', 'gt', 'ge']);
        emitter.add('bool', loose(b.int.cmp, predicate, emitter.value(type), emitter.value(type)));
        return;
      }
    }
  }

  emitSelect<R extends readonly ScalarType[]>(emitter: BlockEmitter<R>): void {
    const b = emitter.b;
    const condition = emitter.value('bool');
    const type = emitter.scalar();
    this.noteInstruction();
    emitter.add(type, loose(b.select, condition, emitter.value(type), emitter.value(type)));
  }

  emitConversion<R extends readonly ScalarType[]>(emitter: BlockEmitter<R>): void {
    const b = emitter.b;
    const choice = this.rng.weighted([
      ['zext', 2],
      ['sext', 1],
      ['trunc', 2],
      ['reinterpret', 2],
      ['intToFloat', 2],
      ['floatToInt', 2],
      ['float', 2],
      ['bitcast', 2],
    ] as const);
    this.noteInstruction();
    switch (choice) {
      case 'zext': {
        const [from, to] = this.rng.pick(ZEXT_PAIRS);
        emitter.add(to, loose(b.int.zext, to, emitter.value(from)));
        return;
      }
      case 'sext': {
        const [from, to] = this.rng.pick(SEXT_PAIRS);
        emitter.add(to, loose(b.int.sext, to, emitter.value(from)));
        return;
      }
      case 'trunc': {
        const [from, to] = this.rng.pick(TRUNC_PAIRS);
        emitter.add(to, loose(b.int.trunc, to, emitter.value(from)));
        return;
      }
      case 'reinterpret': {
        const [from, to] = this.rng.pick(REINTERPRET_PAIRS);
        emitter.add(to, loose(b.int.reinterpret, to, emitter.value(from)));
        return;
      }
      case 'intToFloat': {
        const from = emitter.integer();
        const to = emitter.float();
        emitter.add(to, loose(b.convert.intToFloat, to, emitter.value(from)));
        return;
      }
      case 'floatToInt': {
        const from = emitter.float();
        const to = emitter.integer();
        emitter.add(to, loose(b.convert.floatToInt, to, emitter.value(from)));
        return;
      }
      case 'float': {
        const from = emitter.float();
        const to: FloatType = from === 'f32' ? 'f64' : 'f32';
        emitter.add(to, loose(b.convert.float, to, emitter.value(from)));
        return;
      }
      case 'bitcast': {
        // The core bitcast only crosses f32 <-> u32/i32; f64 is not a source.
        if (this.rng.chance(0.5)) {
          const to: IntegerType = this.rng.pick(['u32', 'i32']);
          emitter.add(to, loose(b.bitcast, to, emitter.value('f32')));
        } else {
          const from: IntegerType = this.rng.pick(['u32', 'i32']);
          emitter.add('f32', loose(b.bitcast, 'f32', emitter.value(from)));
        }
        return;
      }
    }
  }

  emitMemory<R extends readonly ScalarType[]>(emitter: BlockEmitter<R>): void {
    const b = emitter.b;
    const m = this.memories;
    const choice = this.rng.weighted([
      ['stateStore', 2],
      ['stateLoad', 2],
      ['array', 2],
      ['bytesLoad', 3],
      ['bytesStore', 3],
      ['copy', 1],
      ['update', 1],
      ['fill', 1],
      ['oob', 1],
    ] as const);
    this.noteInstruction();
    switch (choice) {
      case 'stateStore': {
        const which = this.rng.int(0, 3);
        if (which === 0) b.state.store(m.stateWord, emitter.value('u32'));
        else if (which === 1) b.state.store(m.stateSigned, emitter.value('i32'));
        else if (which === 2) b.state.store(m.stateFloat, emitter.value('f64'));
        else b.state.store(m.stateFlag, emitter.value('bool'));
        return;
      }
      case 'stateLoad': {
        const which = this.rng.int(0, 3);
        if (which === 0) emitter.add('u32', b.state.load(m.stateWord));
        else if (which === 1) emitter.add('i32', b.state.load(m.stateSigned));
        else if (which === 2) emitter.add('f64', b.state.load(m.stateFloat));
        else emitter.add('bool', b.state.load(m.stateFlag));
        return;
      }
      case 'array': {
        if (this.rng.chance(0.5)) {
          const index = emitter.u32(this.rng.int(0, 3));
          b.array.store(m.arrayWord, index, emitter.value('u16'));
        } else {
          const index = emitter.u32(this.rng.int(0, 2));
          const float = this.rng.chance(0.5);
          emitter.add(
            float ? 'f32' : 'u16',
            float ? b.array.load(m.arrayFloat, index) : b.array.load(m.arrayWord, index),
          );
        }
        return;
      }
      case 'bytesLoad': {
        const type = emitter.integer();
        const endian: Endian = this.rng.chance(0.5) ? 'little' : 'big';
        const width = type === 'u16' || type === 'i16' ? 2 : type === 'u8' || type === 'i8' ? 1 : 4;
        const source = this.rng.weighted<ReadableBytesRef>([
          [m.ram, 3],
          [m.rom, 2],
          [m.inbox, 1],
        ] as const);
        // The inbox is shorter than the byte regions; keep ordinary loads in
        // bounds and leave out-of-range coverage to the explicit `oob` case.
        const capacity = source === m.inbox ? 4 : 8;
        const offset = emitter.u32(this.rng.int(0, capacity - width));
        emitter.add(type, b.bytes.load(type, endian, source, offset));
        return;
      }
      case 'bytesStore': {
        const type = this.rng.pick(['u8', 'u16', 'u32', 'i8', 'i16', 'i32'] as const);
        const endian: Endian = this.rng.chance(0.5) ? 'little' : 'big';
        const width = type === 'u16' || type === 'i16' ? 2 : type === 'u8' || type === 'i8' ? 1 : 4;
        const offset = emitter.u32(this.rng.int(0, 8 - width));
        b.bytes.store(type, endian, m.ram, offset, emitter.value(type));
        return;
      }
      case 'copy': {
        if (this.rng.chance(0.5)) {
          b.bytes.copy(m.ram, emitter.u32(0), m.rom, emitter.u32(0), emitter.u32(2));
        } else {
          // Overlapping source and destination inside the same region.
          b.bytes.copy(m.ram, emitter.u32(0), m.ram, emitter.u32(1), emitter.u32(3));
        }
        return;
      }
      case 'update':
        b.resource.updateBytes(m.ram, emitter.u32(0), m.rom, emitter.u32(0), emitter.u32(2));
        return;
      case 'fill':
        b.resource.fillBytes(m.ram, emitter.u32(0), emitter.u32(2), emitter.value('u8'));
        return;
      case 'oob':
        emitter.add('u8', b.bytes.load('u8', 'little', m.ram, emitter.u32(64)));
        return;
    }
  }

  /** Emit random operations followed by nested control flow, then `finish`. */
  emitFlow<R extends readonly ScalarType[]>(
    builder: FunctionBuilder<R>,
    parameters: readonly BlockParameter[],
    depth: number,
    finish: (emitter: BlockEmitter<R>) => void,
  ): void {
    const emitter = new BlockEmitter(builder, this, parameters);
    const operations = this.rng.int(1, 5);
    for (let index = 0; index < operations && !this.occupied(); index += 1) {
      this.emitRandomOp(emitter);
    }
    if (!this.config.controlFlow || depth >= this.config.maxDepth || this.occupied()) {
      finish(emitter);
      return;
    }
    if (this.rng.chance(0.5)) this.emitLoop(emitter, depth, finish);
    else this.emitDiamond(emitter, depth, finish);
  }

  emitDiamond<R extends readonly ScalarType[]>(
    emitter: BlockEmitter<R>,
    depth: number,
    finish: (emitter: BlockEmitter<R>) => void,
  ): void {
    this.counters.branches += 1;
    const b = emitter.b;
    const type = this.rng.pick(['u32', 'i32', 'f64', 'f32', 'bool'] as const);
    const yes = b.block([type]);
    const no = b.block([type]);
    const merge = b.block([type]);
    const condition = emitter.value('bool');
    b.branch(
      condition,
      { target: yes, args: [emitter.value(type)] },
      { target: no, args: [emitter.value(type)] },
    );
    b.at(yes, (inner, [value]) => {
      this.emitFlow(inner, [{ type, value }], depth + 1, (branchEmitter) => {
        inner.jump(merge, [branchEmitter.value(type)]);
      });
    });
    b.at(no, (inner, [value]) => {
      this.emitFlow(inner, [{ type, value }], depth + 1, (branchEmitter) => {
        inner.jump(merge, [branchEmitter.value(type)]);
      });
    });
    b.at(merge, (inner, [value]) => {
      this.emitFlow(inner, [{ type, value }], depth + 1, finish);
    });
  }

  emitLoop<R extends readonly ScalarType[]>(
    emitter: BlockEmitter<R>,
    depth: number,
    finish: (emitter: BlockEmitter<R>) => void,
  ): void {
    this.counters.loops += 1;
    const b = emitter.b;
    const accumulated = this.rng.pick(['u32', 'i32', 'f64', 'f32'] as const);
    const head = b.block(['u32', accumulated]);
    const body = b.block(['u32', accumulated]);
    const after = b.block([accumulated]);
    const bound = emitter.u32(this.rng.int(0, this.config.maxLoopIterations));
    b.jump(head, [emitter.u32(0), emitter.value(accumulated)]);
    b.at(head, (inner, [index, value]) => {
      const condition = inner.int.cmp('lt', index as Value<'u32'>, bound);
      inner.branch(
        condition,
        { target: body, args: [index, value] },
        { target: after, args: [value] },
      );
    });
    b.at(body, (inner, [index, value]) => {
      this.emitFlow(
        inner,
        [
          { type: 'u32', value: index },
          { type: accumulated, value },
        ],
        depth + 1,
        (bodyEmitter) => {
          inner.jump(head, [
            inner.int.add(index as Value<'u32'>, bodyEmitter.u32(1)),
            bodyEmitter.value(accumulated),
          ]);
        },
      );
    });
    b.at(after, (inner, [value]) => {
      this.emitFlow(inner, [{ type: accumulated, value }], depth + 1, finish);
    });
  }
}

/* -------------------------------------------------------------------------
 * Module assembly
 * ---------------------------------------------------------------------- */

const RAM_BYTES = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);
const ROM_BYTES = new Uint8Array([0x90, 0x81, 0x72, 0x63, 0x54, 0x45, 0x36, 0x27]);
const FIRMWARE_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

function declareMemories(module: IRModule): Memories {
  return {
    stateWord: module.state('state_word', 'u32', 0x1234_5678),
    stateSigned: module.state('state_signed', 'i32', -7),
    stateFloat: module.state('state_float', 'f64', 1.5),
    stateFlag: module.state('state_flag', 'bool', false),
    arrayWord: module.array('array_word', 'u16', [0, 1, 2, 3]),
    arrayFloat: module.array('array_float', 'f32', [0, 0.5, -1.25]),
    ram: module.bytes('ram', RAM_BYTES, { readonly: false, unitBytes: 2 }),
    rom: module.bytes('rom', ROM_BYTES, { readonly: true, unitBytes: 2 }),
    inbox: module.inbox('inbox', 4),
    // Readonly to the IR (`bytes.store` cannot change it), mutable through
    // `resource.update_bytes`, which is exactly what a provider depends on.
    firmware: module.bytes('firmware', FIRMWARE_BYTES, { readonly: true }),
  };
}

function declareProvider(
  module: IRModule,
  memories: Memories,
  stats: { generated: number; keys: number[] },
): ProviderFixture {
  const provider = module.provider(
    'lookup',
    {
      keyTypes: ['u32'],
      params: ['u32'],
      results: ['u32'],
      reads: [memories.firmware],
      imports: [],
    },
    (gen, [key]) => {
      stats.generated += 1;
      stats.keys.push(Math.trunc(key));
      const byte = gen.readBytes(memories.firmware, 0, 1)[0]!;
      const bias = (Math.trunc(key) * 7 + byte) >>> 0;
      return gen.function((b, [value]) => b.return([b.int.add(value, b.const('u32', bias))]));
    },
  );
  const helper = module.func('via_provider', { params: ['u32', 'u32'], results: ['u32'] });
  helper.body((b, [value, key]) => b.dispatch(provider, [key], [value]));
  return { helper };
}

function buildPolicy(module: IRModule): IRValidationOptions {
  const resources: IRResourcePermission[] = module.memories.map((memory) => ({
    ref: memory.ref,
    access: memory.writable ? ('read-write' as const) : ('read' as const),
  }));
  for (const memory of module.memories) {
    if (memory.kind === 'bytes') {
      resources.push({ ref: memory.ref, access: 'update' });
    }
  }
  return Object.freeze({
    supportedInstructions: CORE_INSTRUCTION_NAMES,
    authorizedInstructions: CORE_INSTRUCTION_NAMES,
    resources: Object.freeze(resources),
  });
}

function generateInvocations(
  generator: ProgramGenerator,
  provider: boolean,
): readonly (readonly RuntimeScalar[])[] {
  const floatArgument = (): RuntimeScalar =>
    generator.rng.chance(0.15)
      ? ({ type: 'f64', bits: generator.rng.pick(FLOAT_BITS.f64) } satisfies FloatBits)
      : generator.rng.pick([0, 1, -1, 0.5, 2.5, -3.75, 1e6]);
  if (provider) {
    // key=1 twice around a firmware update, then key=1 (cache hit) and key=2.
    return [
      [1, 0, floatArgument(), generator.rng.chance(0.5)],
      [1, 1, floatArgument(), generator.rng.chance(0.5)],
      [1, 0, floatArgument(), generator.rng.chance(0.5)],
      [2, 0, floatArgument(), generator.rng.chance(0.5)],
    ];
  }
  const count = Math.max(1, generator.config.invocations);
  return Array.from({ length: count }, () => [
    generator.rng.int(0, 8),
    generator.rng.int(0, 8),
    floatArgument(),
    generator.rng.chance(0.5),
  ]);
}

/**
 * Build one deterministic random program. Throws when the builder produced an
 * invalid module, which would be a generator bug rather than a JIT divergence.
 */
export function randomProgram(config: RandomProgramConfig): RandomProgram {
  const seed = config.seed;
  const resolved = resolveConfig(config);
  const module = createIRModule();
  const memories = declareMemories(module);
  const stats: { generated: number; keys: number[] } = { generated: 0, keys: [] };
  const providerFixture = resolved.provider ? declareProvider(module, memories, stats) : undefined;

  const target = module.func('run', RANDOM_PROGRAM_SIGNATURE);
  const generator = new ProgramGenerator(resolved, seed, memories);
  target.body((b, [first, second, floatArgument, flag]) => {
    if (providerFixture !== undefined) {
      // Update exactly `second` bytes: invocations use 0 (no-op) and 1.
      b.resource.updateBytes(
        memories.firmware,
        b.const('u32', 0),
        memories.rom,
        b.const('u32', 0),
        second as Value<'u32'>,
      );
    }
    generator.emitFlow(
      b,
      [
        { type: 'u32', value: first },
        { type: 'u32', value: second },
        { type: 'f64', value: floatArgument },
        { type: 'bool', value: flag },
      ],
      0,
      (emitter) => {
        const word = emitter.value('u32');
        const float = emitter.value('f64');
        const bool = emitter.value('bool');
        if (providerFixture === undefined) {
          b.return([word, float, bool]);
          return;
        }
        const [provided] = b.call(providerFixture.helper, [word, first as Value<'u32'>]);
        b.state.store(memories.stateWord, provided!);
        b.return([provided!, float, bool]);
      },
    );
  });

  const validation = buildPolicy(module);
  const result = validateIR(module, validation);
  if (!result.ok) {
    throw new Error(
      `random IR generator produced an invalid module (seed=${seed}, profile=${resolved.profile}): ` +
        result.diagnostics.map((diagnostic) => diagnostic.message).join('; '),
    );
  }
  return {
    seed,
    profile: resolved.profile,
    module,
    target: target as RandomProgramTarget,
    invocations: generateInvocations(generator, providerFixture !== undefined),
    validation,
    maxSteps: resolved.maxSteps,
    summary: Object.freeze({
      functions: module.functions.length,
      blocks: module.functions.reduce((sum, fn) => sum + (fn.body?.blocks.length ?? 0), 0),
      instructions: generator.instructionCount,
      loops: generator.counters.loops,
      branches: generator.counters.branches,
      providers: module.providers.length,
      targetInstructions: generator.targetInstructions,
    }),
    stats,
  };
}
