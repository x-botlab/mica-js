/**
 * IR model for the M3-class DBT benchmark.
 *
 * Shape (issue #150):
 *  - 16 × u32 guest registers + NZCV flags, all as IR `state`;
 *  - 256 KiB byte-addressed RAM (`bytes`, 64-byte version units);
 *  - a `blocks` provider keyed by guest pc that decodes one basic block from
 *    the read-only `flash` image and translates it to IR;
 *  - every translated block ends by tail-dispatching `blocks(nextPc)`;
 *  - once the cycle budget (`sliceEnd`) is reached the block stores `pc`,
 *    calls `event.at(step, …)` and returns to the host (teaching-mcu style).
 *
 * The provider is pre-generated for a fixed ring of `N` block addresses, so
 * the measured loop is a steady-state tail-dispatch chain.
 */
import { createIRModule } from '../../src/index';
import type {
  BytesRef,
  EntryRef,
  FunctionBuilder,
  GeneratedFunctionBuilder,
  IRExecutionContext,
  IREventHost,
  IRInterpreter,
  IRModule,
  IRValidationOptions,
  ProviderRef,
  StateRef,
  Value,
} from '../../src/index';
import { CORE_INSTRUCTION_NAMES } from '../../src/builder';
import { Cond, Op, RAM_BASE, RAM_SIZE, decodeBlock } from './isa';
import type { DecodedInstruction } from './isa';
import type { FirmwareImage } from './firmware';

/** Upper bound for one decoded guest basic block. */
export const MAX_BLOCK_INSTRUCTIONS = 64;

type U32 = Value<'u32'>;
type U32Ref = StateRef<'u32'>;
type FlagRef = StateRef<'bool'>;

const ZERO = 0;
const SIGN_BIT = 0x8000_0000;
const LINK_REGISTER = 14;

const INITIAL_REGISTERS: readonly number[] = Object.freeze([
  0x1111_1111,
  0x2222_2222,
  0x3333_3333,
  0x4444_4444,
  0x5555_5555,
  0x6666_6666,
  0x7777_7777,
  0x8888_8888,
  0x9999_9999,
  0xaaaa_aaaa,
  0xbbbb_bbbb,
  0xcccc_cccc,
  0xdddd_dddd,
  3,
  0,
  RAM_BASE,
]);

export interface FlagRefs {
  readonly n: FlagRef;
  readonly z: FlagRef;
  readonly c: FlagRef;
  readonly v: FlagRef;
}

export interface MachineRefs {
  readonly regs: readonly U32Ref[];
  readonly flags: FlagRefs;
  readonly pc: U32Ref;
  readonly cycles: U32Ref;
  readonly sliceEnd: U32Ref;
  readonly halted: U32Ref;
  readonly ram: BytesRef<false>;
  readonly step: EntryRef<readonly []>;
}

export interface M3FixtureOptions {
  readonly firmware: FirmwareImage;
  /** Guest cycles per `step` invocation; must be a multiple of the ring length. */
  readonly slice: number;
}

export interface M3Fixture {
  readonly module: IRModule;
  readonly step: EntryRef<readonly []>;
  readonly warm: EntryRef<readonly ['u32']>;
  readonly refs: MachineRefs;
  readonly blockPcs: readonly number[];
  /** Guest instructions executed by one `step` call. */
  readonly instructionsPerSlice: number;
  readonly validation: IRValidationOptions;
  readonly eventHost: CountingEventHost;
  readonly context: IRExecutionContext;
  readonly slice: number;
}

/** Deterministic event sink: one `at()` per exhausted cycle slice. */
export class CountingEventHost implements IREventHost {
  count = 0;
  lastDeadline = 0;

  now(): number {
    return 0;
  }

  at(_target: EntryRef, deadline: number): number {
    this.count += 1;
    this.lastDeadline = deadline;
    return 1;
  }

  cancel(): void {
    /* The benchmark never cancels events. */
  }
}

export function createM3Fixture(options: M3FixtureOptions): M3Fixture {
  const { firmware, slice } = options;
  if (!Number.isSafeInteger(slice) || slice <= 0 || slice % firmware.loopInstructions !== 0) {
    throw new Error(
      `M3 benchmark slice must be a positive multiple of ${firmware.loopInstructions} guest instructions`,
    );
  }

  const module = createIRModule();
  const flash = module.bytes('flash', firmware.bytes, { readonly: true, unitBytes: 256 });
  const ram = module.bytes('ram', initialRam(), { readonly: false, unitBytes: 64 });

  const regs = INITIAL_REGISTERS.map((initial, index) => module.state(`r${index}`, 'u32', initial));
  const flags: FlagRefs = Object.freeze({
    n: module.state('n', 'bool', false),
    z: module.state('z', 'bool', false),
    c: module.state('c', 'bool', false),
    v: module.state('v', 'bool', false),
  });
  const pc = module.state('pc', 'u32', 0);
  const cycles = module.state('cycles', 'u32', 0);
  const sliceEnd = module.state('sliceEnd', 'u32', 0);
  const halted = module.state('halted', 'u32', 0);

  const step = module.entry('step', []);
  const warm = module.entry('warm', ['u32']);

  const refs: MachineRefs = Object.freeze({
    regs: Object.freeze(regs),
    flags,
    pc,
    cycles,
    sliceEnd,
    halted,
    ram,
    step,
  });

  const blocks: ProviderRef<readonly ['u32'], readonly [], readonly []> = module.provider(
    'blocks',
    {
      keyTypes: ['u32'],
      params: [],
      results: [],
      reads: [flash],
      imports: [
        ram,
        ...regs,
        flags.n,
        flags.z,
        flags.c,
        flags.v,
        pc,
        cycles,
        sliceEnd,
        halted,
        step,
      ],
    },
    (gen, [key]) => {
      const address = key as number;
      const remaining = firmware.bytes.byteLength - address;
      if (remaining < 4) throw new Error(`M3 guest pc ${address} is outside the flash image`);
      const bytes = gen.readBytes(flash, address, Math.min(MAX_BLOCK_INSTRUCTIONS * 4, remaining));
      const decoded = decodeBlock(bytes, address, MAX_BLOCK_INSTRUCTIONS);
      return gen.function((b) => {
        emitBlock(b, decoded, refs, blocks);
      });
    },
  );

  step.body((b) => {
    const stop = b.block([]);
    const run = b.block([]);
    b.branch(
      b.int.cmp('ne', b.state.load(halted), b.const('u32', ZERO)),
      { target: stop, args: [] },
      { target: run, args: [] },
    );
    b.at(stop, (inner) => inner.return([]));
    b.at(run, (inner) => {
      inner.state.store(cycles, inner.const('u32', 0));
      inner.state.store(sliceEnd, inner.const('u32', slice));
      inner.dispatch(blocks, [inner.state.load(pc)], []);
    });
  });

  warm.body((b, [address]) => {
    b.state.store(cycles, b.const('u32', 0));
    b.state.store(sliceEnd, b.const('u32', firmware.blockInstructions));
    b.dispatch(blocks, [address], []);
  });

  const validation: IRValidationOptions = Object.freeze({
    supportedInstructions: CORE_INSTRUCTION_NAMES,
    authorizedInstructions: CORE_INSTRUCTION_NAMES,
    resources: Object.freeze(
      module.memories.map((memory) => ({
        ref: memory.ref,
        access: memory.writable ? ('read-write' as const) : ('read' as const),
      })),
    ),
  });

  return {
    module,
    step,
    warm,
    refs,
    blockPcs: firmware.blockPcs,
    instructionsPerSlice: slice,
    validation,
    eventHost: new CountingEventHost(),
    context: Object.freeze({ instanceId: 'm3-bench', virtualTime: 0 }),
    slice,
  };
}

/**
 * Force the provider to generate and compile every block, then leave the
 * machine at pc 0 and run one complete slice so the first measured iteration
 * does not include compilation.
 */
export function prepareFixture(runtime: IRInterpreter, fixture: M3Fixture): void {
  for (const pc of fixture.blockPcs) {
    runtime.execute(fixture.warm, [pc], fixture.context);
  }
  resetMachine(runtime, fixture);
  const before = fixture.eventHost.count;
  runtime.execute(fixture.step, [], fixture.context);
  const cycles = runtime.storage.loadState(fixture.refs.cycles);
  if (cycles !== fixture.slice) {
    throw new Error(`M3 slice exited after ${cycles} guest cycles, expected ${fixture.slice}`);
  }
  if (fixture.eventHost.count !== before + 1) {
    throw new Error('M3 slice must yield exactly one event');
  }
  if (runtime.storage.loadState(fixture.refs.pc) !== 0) {
    throw new Error('M3 slice did not return to the entry pc');
  }
}

export function resetMachine(runtime: IRInterpreter, fixture: M3Fixture): void {
  runtime.storage.storeState(fixture.refs.pc, 0);
  runtime.storage.storeState(fixture.refs.cycles, 0);
  runtime.storage.storeState(fixture.refs.halted, 0);
}

function initialRam(): Uint8Array {
  const bytes = new Uint8Array(RAM_SIZE);
  let seed = 0x1234_5678;
  for (let index = 0; index < bytes.length; index += 1) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[index] = seed >>> 24;
  }
  return bytes;
}

/* -------------------------------------------------------------------------
 * Guest → IR translation
 * ---------------------------------------------------------------------- */

function emitBlock(
  b: GeneratedFunctionBuilder<readonly []>,
  decoded: readonly DecodedInstruction[],
  refs: MachineRefs,
  blocks: ProviderRef<readonly ['u32'], readonly [], readonly []>,
): void {
  let nextPc: U32 | undefined;
  let halt = false;

  for (const instruction of decoded) {
    switch (instruction.op) {
      case Op.B: {
        const taken = instruction.pc + 4 + instruction.simm22 * 4;
        const fallthrough = instruction.pc + 4;
        nextPc =
          instruction.cond === Cond.AL
            ? b.const('u32', taken)
            : b.select(
                emitCondition(b, instruction.cond, refs),
                b.const('u32', taken),
                b.const('u32', fallthrough),
              );
        break;
      }
      case Op.BL: {
        b.state.store(refs.regs[LINK_REGISTER]!, b.const('u32', (instruction.pc + 4) >>> 0));
        nextPc = b.const('u32', (instruction.pc + 4 + instruction.simm26 * 4) >>> 0);
        break;
      }
      case Op.BX: {
        nextPc = b.int.and(b.state.load(refs.regs[instruction.rn]!), b.const('u32', 0xffff_fffe));
        break;
      }
      case Op.HALT: {
        b.state.store(refs.halted, b.const('u32', 2));
        halt = true;
        break;
      }
      default:
        emitInstruction(b, instruction, refs);
        break;
    }
  }

  const executed = decoded.length;
  const nextCycles = b.int.add(b.state.load(refs.cycles), b.const('u32', executed));
  b.state.store(refs.cycles, nextCycles);

  if (halt) {
    b.return([]);
    return;
  }

  const next = nextPc ?? b.const('u32', (decoded[decoded.length - 1]!.pc + 4) >>> 0);
  const keepRunning = b.block([]);
  const yieldToHost = b.block([]);
  b.branch(
    b.int.cmp('lt', nextCycles, b.state.load(refs.sliceEnd)),
    { target: keepRunning, args: [] },
    { target: yieldToHost, args: [] },
  );
  b.at(keepRunning, (inner) => {
    inner.dispatch(blocks, [next], []);
  });
  b.at(yieldToHost, (inner) => {
    inner.state.store(refs.pc, next);
    inner.event.at(refs.step, inner.convert.intToFloat('f64', nextCycles), []);
    inner.return([]);
  });
}

function emitInstruction(
  b: FunctionBuilder<readonly []>,
  instruction: DecodedInstruction,
  refs: MachineRefs,
): void {
  const load = (index: number): U32 => b.state.load(refs.regs[index]!);
  const store = (index: number, value: U32): void => {
    b.state.store(refs.regs[index]!, value);
  };
  const immediate = (): U32 => b.const('u32', instruction.imm16);
  const offset = (): U32 =>
    b.int.sub(
      b.int.add(load(instruction.rn), b.const('u32', instruction.imm16)),
      b.const('u32', RAM_BASE),
    );

  switch (instruction.op) {
    case Op.MOVI:
      store(instruction.rd, immediate());
      return;
    case Op.MOVT:
      store(
        instruction.rd,
        b.int.or(
          b.int.and(load(instruction.rd), b.const('u32', 0xffff)),
          b.const('u32', (instruction.imm16 << 16) >>> 0),
        ),
      );
      return;
    case Op.ADD:
      store(instruction.rd, b.int.add(load(instruction.rn), load(instruction.rm)));
      return;
    case Op.SUB:
      store(instruction.rd, b.int.sub(load(instruction.rn), load(instruction.rm)));
      return;
    case Op.AND:
      store(instruction.rd, b.int.and(load(instruction.rn), load(instruction.rm)));
      return;
    case Op.ORR:
      store(instruction.rd, b.int.or(load(instruction.rn), load(instruction.rm)));
      return;
    case Op.EOR:
      store(instruction.rd, b.int.xor(load(instruction.rn), load(instruction.rm)));
      return;
    case Op.LSL:
      store(instruction.rd, b.int.shl(load(instruction.rn), load(instruction.rm)));
      return;
    case Op.LSR:
      store(instruction.rd, b.int.lshr(load(instruction.rn), load(instruction.rm)));
      return;
    case Op.ASR: {
      const shifted = b.int.ashr(
        b.int.reinterpret('i32', load(instruction.rn)),
        load(instruction.rm),
      );
      store(instruction.rd, b.int.reinterpret('u32', shifted));
      return;
    }
    case Op.MUL:
      store(instruction.rd, b.int.mul(load(instruction.rn), load(instruction.rm)));
      return;
    case Op.ADDI:
      store(instruction.rd, b.int.add(load(instruction.rn), immediate()));
      return;
    case Op.SUBI:
      store(instruction.rd, b.int.sub(load(instruction.rn), immediate()));
      return;
    case Op.CMP: {
      const left = load(instruction.rn);
      const right = load(instruction.rm);
      emitSubFlags(b, refs, left, right, b.int.sub(left, right));
      return;
    }
    case Op.CMPI: {
      const left = load(instruction.rn);
      const right = immediate();
      emitSubFlags(b, refs, left, right, b.int.sub(left, right));
      return;
    }
    case Op.ADDS: {
      const left = load(instruction.rn);
      const right = load(instruction.rm);
      const result = b.int.add(left, right);
      store(instruction.rd, result);
      emitAddFlags(b, refs, result, left, right);
      return;
    }
    case Op.SUBS: {
      const left = load(instruction.rn);
      const right = load(instruction.rm);
      const result = b.int.sub(left, right);
      store(instruction.rd, result);
      emitSubFlags(b, refs, left, right, result);
      return;
    }
    case Op.LDR:
      store(instruction.rd, b.bytes.load('u32', 'little', refs.ram, offset()));
      return;
    case Op.STR:
      b.bytes.store('u32', 'little', refs.ram, offset(), load(instruction.rd));
      return;
    case Op.LDRB:
      store(instruction.rd, b.int.zext('u32', b.bytes.load('u8', 'little', refs.ram, offset())));
      return;
    case Op.STRB:
      b.bytes.store('u8', 'little', refs.ram, offset(), b.int.trunc('u8', load(instruction.rd)));
      return;
    default:
      throw new Error(`Unsupported guest opcode ${instruction.op}`);
  }
}

/**
 * Set NZCV for a subtraction. `result` is `left - right` and is passed in so
 * SUBS can reuse it; CMP lets the caller compute it from freshly loaded values.
 */
function emitSubFlags(
  b: FunctionBuilder<readonly []>,
  refs: MachineRefs,
  left: U32,
  right: U32,
  result: U32,
): void {
  const zero = b.const('u32', ZERO);
  const sign = b.const('u32', SIGN_BIT);
  const overflow = b.int.and(b.int.xor(left, right), b.int.xor(left, result));
  b.state.store(refs.flags.n, b.int.cmp('ne', b.int.and(result, sign), zero));
  b.state.store(refs.flags.z, b.int.cmp('eq', result, zero));
  b.state.store(refs.flags.c, b.int.cmp('ge', left, right));
  b.state.store(refs.flags.v, b.int.cmp('ne', b.int.and(overflow, sign), zero));
}

function emitAddFlags(
  b: FunctionBuilder<readonly []>,
  refs: MachineRefs,
  result: U32,
  left: U32,
  right: U32,
): void {
  const zero = b.const('u32', ZERO);
  const sign = b.const('u32', SIGN_BIT);
  const overflow = b.int.and(b.int.xor(left, result), b.int.xor(left, right));
  b.state.store(refs.flags.n, b.int.cmp('ne', b.int.and(result, sign), zero));
  b.state.store(refs.flags.z, b.int.cmp('eq', result, zero));
  b.state.store(refs.flags.c, b.int.cmp('lt', result, left));
  b.state.store(refs.flags.v, b.int.cmp('ne', b.int.and(overflow, sign), zero));
}

function emitCondition(
  b: FunctionBuilder<readonly []>,
  cond: number,
  refs: MachineRefs,
): Value<'bool'> {
  const n = (): Value<'bool'> => b.state.load(refs.flags.n);
  const z = (): Value<'bool'> => b.state.load(refs.flags.z);
  const c = (): Value<'bool'> => b.state.load(refs.flags.c);
  const v = (): Value<'bool'> => b.state.load(refs.flags.v);
  switch (cond) {
    case Cond.EQ:
      return z();
    case Cond.NE:
      return b.bool.not(z());
    case Cond.CS:
      return c();
    case Cond.CC:
      return b.bool.not(c());
    case Cond.MI:
      return n();
    case Cond.PL:
      return b.bool.not(n());
    case Cond.VS:
      return v();
    case Cond.VC:
      return b.bool.not(v());
    case Cond.HI:
      return b.bool.and(c(), b.bool.not(z()));
    case Cond.LS:
      return b.bool.or(b.bool.not(c()), z());
    case Cond.GE:
      return b.bool.not(b.bool.xor(n(), v()));
    case Cond.LT:
      return b.bool.xor(n(), v());
    case Cond.GT:
      return b.bool.and(b.bool.not(z()), b.bool.not(b.bool.xor(n(), v())));
    case Cond.LE:
      return b.bool.or(z(), b.bool.xor(n(), v()));
    case Cond.AL:
      return b.const('bool', true);
    default:
      throw new Error(`Unsupported guest condition ${cond}`);
  }
}
