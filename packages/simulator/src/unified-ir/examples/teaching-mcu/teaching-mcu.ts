/**
 * Unified-IR teaching MCU (U03).
 *
 * A Cortex-M3-class teaching device compiled straight into the unified
 * circuit module: sixteen 32-bit registers, NZCV flags, a byte-addressed
 * flash/RAM/peripheral map, GPIO ports wired into the shared electrical pin
 * space and a small NVIC that turns pending IRQs into a tail-dispatched
 * exception handler.
 *
 * The IR factory owns no scheduler callbacks. `createTeachingMCUIR` returns
 *   - a standalone `@mica-js/ir` module (initialize / tick / update),
 *   - a `DeviceDescription` whose behaviours emit the very same IR into any
 *     unified circuit module, and
 *   - the layout the accessor uses to read registers, memory, GPIO and NVIC.
 *
 * Two instruction sets are supported:
 *
 * | `isa`        | encoding | source                                           |
 * | ------------ | -------- | ------------------------------------------------ |
 * | `'m3'`       | 32-bit   | `packages/ir/bench/m3` Cortex-M3-class benchmark  |
 * | `'teaching'` | 16-bit   | the original `teaching-mcu` example device        |
 *
 * The `'teaching'` mode keeps the original device's observable behaviour so
 * migration can be validated instruction-for-instruction.
 */
import { createIRModule } from '@mica-js/ir';
import type {
  ArrayRef,
  BytesRef,
  FunctionBuilder,
  FunctionRef,
  GeneratedFunctionBuilder,
  IRModule,
  IRValidationOptions,
  ProviderRef,
  ScalarType,
  StateRef,
  Value,
} from '@mica-js/ir';
import type { DeviceAccessorFactoryContext, DeviceConfig, DeviceDescription } from '../../compiler';
import { Circuit, type CircuitRuntimeOptions } from '../../runtime';
import { createModuleValidation } from '../../validation';
import { PIN_MODE } from '../../pin-space';
import { TeachingMCUError } from './teaching-mcu.errors';
import {
  buildAccessor,
  registerTeachingMCULayout,
  type StorageAccessor,
  type TeachingMCUAccessor,
  type TeachingMCUAccessorOptions,
} from './teaching-mcu.ac';

export { TeachingMCUError } from './teaching-mcu.errors';
export type { TeachingMCUErrorCode, TeachingMCUErrorOptions } from './teaching-mcu.errors';

/** Device type used by `Circuit.create` for the unified kernel. */
export const TEACHING_MCU_IR_TYPE = 'teaching-mcu-ir';

/** Byte address of the instruction flash window. */
export const FLASH_BASE = 0x0000_0000;
/** Byte address of the SRAM window. */
export const RAM_BASE = 0x2000_0000;
/** Byte address of the peripheral window. */
export const PERIPHERAL_BASE = 0x4000_0000;

/** Size of one GPIO port's register block. */
export const GPIO_PORT_STRIDE = 0x10;
export const GPIO_ODR = 0x00;
export const GPIO_DIR = 0x04;
export const GPIO_IDR = 0x08;

/** Offsets inside the NVIC register block (relative to its base). */
export const NVIC_ENABLE = 0x00;
export const NVIC_PENDING = 0x04;
export const NVIC_ACTIVE = 0x08;
export const NVIC_PRIORITY = 0x0c;

/** Size of the NVIC register block. */
export const NVIC_BLOCK_SIZE = 0x20;

/** Guest-visible register count (r0–r15). */
export const REGISTER_COUNT = 16;

/** Stack frame pushed on exception entry: r0-r3, r12, lr, pc, xPSR. */
const EXCEPTION_FRAME_SIZE = 32;
const EXCEPTION_RETURN_LR = 0xffff_fff9;
const EXCEPTION_RETURN_MASK = 0xffff_fff0;
const SIGN_BIT = 0x8000_0000;

/** Instruction-set flavour. */
export type TeachingMCUISAType = 'm3' | 'teaching';

/** One GPIO pin that raises an NVIC interrupt. */
export interface TeachingMCUInterruptConfig {
  /** IRQ number in `[0, irqCount - 1]`. */
  readonly irq: number;
  /** Port name, e.g. `'A'`. */
  readonly port: string;
  /** Bit index inside the port. */
  readonly bit: number;
  /** Edge that latches the IRQ; defaults to `'both'`. */
  readonly edge?: 'rising' | 'falling' | 'both';
}

/** Author-facing configuration of one teaching MCU instance. */
export interface TeachingMCUConfig {
  /** Instruction encoding. Defaults to `'m3'`. */
  readonly isa?: TeachingMCUISAType;
  /** GPIO port names. Defaults to `['A', 'B']`. */
  readonly ports?: readonly string[];
  /** Pins per port, 1–32. Defaults to 16. */
  readonly portWidth?: number;
  /** Instruction flash size in bytes. Defaults to 64 KiB. */
  readonly flashSize?: number;
  /** SRAM size in bytes. Defaults to 32 KiB. */
  readonly ramSize?: number;
  /** Initial flash image. Defaults to the original teaching firmware. */
  readonly firmware?: Uint8Array | readonly number[];
  /** Initial SRAM image. */
  readonly ramInitial?: Uint8Array | readonly number[];
  /** Initial r0–r15 values. */
  readonly registers?: readonly number[];
  /** Initial program counter. Defaults to `0`. */
  readonly pc?: number;
  /** Initial stack pointer (r13). Defaults to the top of SRAM. */
  readonly sp?: number;
  /** Base address of the exception vector table. Defaults to `0`. */
  readonly vectorBase?: number;
  /** Guest instructions retired per circuit tick. Defaults to `1`. */
  readonly instructionsPerTick?: number;
  /** Maximum instructions decoded into one translated block. */
  readonly maxBlockInstructions?: number;
  /** Number of NVIC IRQ lines. Defaults to `32`, maximum `32`. */
  readonly irqCount?: number;
  /** GPIO-backed interrupt lines. */
  readonly interrupts?: readonly TeachingMCUInterruptConfig[];
  /** Initial ODR words keyed by port name. */
  readonly initialOutputs?: Readonly<Record<string, number>>;
  /** Initial direction words keyed by port name (`1` = output). */
  readonly initialDirections?: Readonly<Record<string, number>>;
  /** Cycles charged for exception entry. Defaults to `12`. */
  readonly exceptionCycles?: number;
}

/** Fully resolved configuration returned by {@link createTeachingMCUIR}. */
export interface ResolvedTeachingMCUConfig {
  readonly isa: TeachingMCUISAType;
  readonly ports: readonly string[];
  readonly portWidth: number;
  readonly flashSize: number;
  readonly ramSize: number;
  readonly firmware: Uint8Array;
  readonly ramInitial: Uint8Array;
  readonly registers: readonly number[];
  readonly pc: number;
  readonly sp: number;
  readonly vectorBase: number;
  readonly instructionsPerTick: number;
  readonly maxBlockInstructions: number;
  readonly irqCount: number;
  readonly interrupts: readonly TeachingMCUInterruptConfig[];
  readonly initialOutputs: Readonly<Record<string, number>>;
  readonly initialDirections: Readonly<Record<string, number>>;
  readonly exceptionCycles: number;
}

/** Pin memories the device writes; structurally equal to `CompiledCircuitMemory`. */
export interface TeachingMCUPinMemory {
  readonly mode: ArrayRef<'u8'>;
  readonly output: ArrayRef<'bool'>;
  readonly input: ArrayRef<'bool'>;
}

/** One GPIO pin mapped into the global pin space. */
export interface TeachingMCUPin {
  readonly name: string;
  readonly port: string;
  readonly portIndex: number;
  readonly bit: number;
  readonly globalPinId: number;
}

/** Ref/layout description the accessor needs; produced during IR generation. */
export interface TeachingMCULayout {
  readonly deviceId: string;
  readonly isa: TeachingMCUISAType;
  readonly config: ResolvedTeachingMCUConfig;
  readonly pins: ReadonlyMap<string, TeachingMCUPin>;
  readonly pinNames: readonly string[];
  readonly pinMemory: TeachingMCUPinMemory;
  readonly registers: ArrayRef<'u32'>;
  /** Read-only instruction image used by the provider's tracked reads. */
  readonly flash: BytesRef<true>;
  /** Writable unified data image: flash copy + SRAM + peripherals. */
  readonly memory: BytesRef<false>;
  readonly flashSize: number;
  readonly ramSize: number;
  readonly memorySize: number;
  readonly flashBase: number;
  readonly ramBase: number;
  readonly peripheralBase: number;
  readonly peripheralOffset: number;
  readonly peripheralSize: number;
  readonly gpioOffset: number;
  readonly nvicOffset: number;
  readonly portCount: number;
  readonly portWidth: number;
  readonly registerCount: number;
  readonly registerNames: readonly string[];
  readonly flags: {
    readonly n: StateRef<'bool'>;
    readonly z: StateRef<'bool'>;
    readonly c: StateRef<'bool'>;
    readonly v: StateRef<'bool'>;
  };
  readonly pc: StateRef<'u32'>;
  readonly cycles: StateRef<'u32'>;
  readonly sliceEnd: StateRef<'u32'>;
  readonly halted: StateRef<'bool'>;
  readonly fault: StateRef<'bool'>;
  readonly sleeping: StateRef<'bool'>;
  readonly yieldRequested: StateRef<'bool'>;
  readonly ipsr: StateRef<'u32'>;
  /** NVIC register file kept as scalar states; memory is the MMIO mirror. */
  readonly nvic: {
    readonly enabled: StateRef<'u32'>;
    readonly pending: StateRef<'u32'>;
    readonly active: StateRef<'u32'>;
    readonly priority: StateRef<'u32'>;
  };
  readonly entries: {
    readonly initialize: FunctionRef<readonly [], readonly []>;
    readonly tick: FunctionRef<readonly [], readonly []>;
    readonly update: FunctionRef<readonly [], readonly []>;
  };
  readonly functions: {
    readonly load32: FunctionRef<readonly ['u32'], readonly ['u32']>;
    readonly load8: FunctionRef<readonly ['u32'], readonly ['u32']>;
    readonly store32: FunctionRef<readonly ['u32', 'u32'], readonly []>;
    readonly store8: FunctionRef<readonly ['u32', 'u32'], readonly []>;
    readonly enterException: FunctionRef<readonly ['bool'], readonly []>;
    readonly returnFromException: FunctionRef<readonly [], readonly []>;
    readonly fetch: ProviderRef<readonly ['u32'], readonly [], readonly []>;
  };
  /** Executable prefix length (firmware bytes), used by instruction fetch. */
  readonly executableSize: number;
  /** Memory-mapped address of one GPIO register. */
  gpioAddress(portIndex: number, register: number): number;
  /** Memory-mapped address of one NVIC register. */
  nvicAddress(register: number): number;
}

/** A generated unified teaching MCU: standalone module plus circuit template. */
export interface IRDevice {
  readonly id: string;
  readonly type: typeof TEACHING_MCU_IR_TYPE;
  readonly config: ResolvedTeachingMCUConfig;
  /** Standalone module containing initialize/tick/update. */
  readonly module: IRModule;
  /** Layout of the standalone module. */
  readonly layout: TeachingMCULayout;
  /** Device config for `Circuit.create`. */
  readonly device: DeviceConfig;
  /** Validation grants for the standalone module. */
  readonly validation: IRValidationOptions;
  /** Builds an accessor over storage holding the standalone layout. */
  buildAccessor(
    storage: StorageAccessor,
    options?: TeachingMCUAccessorOptions,
  ): TeachingMCUAccessor;
}

/* -------------------------------------------------------------------------
 * Instruction encoding
 * ---------------------------------------------------------------------- */

/** Unified internal opcodes; teaching-only opcodes live above 100. */
const Op = {
  HALT: 0,
  MOVI: 1,
  MOVT: 2,
  ADD: 3,
  SUB: 4,
  AND: 5,
  ORR: 6,
  EOR: 7,
  LSL: 8,
  LSR: 9,
  ASR: 10,
  MUL: 11,
  ADDI: 12,
  SUBI: 13,
  CMP: 14,
  CMPI: 15,
  ADDS: 16,
  SUBS: 17,
  LDR: 18,
  STR: 19,
  LDRB: 20,
  STRB: 21,
  B: 22,
  BL: 23,
  BX: 24,
  WFI: 25,
  NOP: 26,
  TADD: 100,
  TJMP: 101,
  TJNZ: 102,
  TFAULT: 103,
} as const;

const Cond = {
  EQ: 0,
  NE: 1,
  CS: 2,
  CC: 3,
  MI: 4,
  PL: 5,
  VS: 6,
  VC: 7,
  HI: 8,
  LS: 9,
  GE: 10,
  LT: 11,
  GT: 12,
  LE: 13,
  AL: 14,
} as const;

interface DecodedInstruction {
  readonly pc: number;
  readonly size: number;
  readonly op: number;
  readonly rd: number;
  readonly rn: number;
  readonly rm: number;
  readonly imm16: number;
  readonly imm8: number;
  readonly target: number;
  readonly cond: number;
  readonly simm22: number;
  readonly simm26: number;
}

const INITIAL_TEACHING_FIRMWARE: readonly number[] = Object.freeze([
  0x10, 1, 0x10, 2, 0x30, 8, 0x00, 0x00, 0x10, 4, 0x20, 0,
]);

function decodeM3Word(word: number, pc: number): DecodedInstruction {
  let simm22 = word & 0x3f_ffff;
  if ((simm22 & 0x20_0000) !== 0) simm22 -= 0x40_0000;
  let simm26 = word & 0x3ff_ffff;
  if ((simm26 & 0x200_0000) !== 0) simm26 -= 0x400_0000;
  return Object.freeze({
    pc,
    size: 4,
    op: word >>> 26,
    rd: (word >>> 22) & 0xf,
    rn: (word >>> 18) & 0xf,
    rm: (word >>> 14) & 0xf,
    imm16: word & 0xffff,
    imm8: word & 0xff,
    target: 0,
    cond: (word >>> 22) & 0xf,
    simm22,
    simm26,
  });
}

function isM3Terminator(op: number): boolean {
  return op === Op.B || op === Op.BL || op === Op.BX || op === Op.HALT || op === Op.WFI;
}

/** True when the instruction ends a guest basic block. */
function isTerminator(isa: TeachingMCUISAType, op: number): boolean {
  if (isa === 'teaching') {
    return op === Op.TJMP || op === Op.TJNZ || op === Op.HALT || op === Op.TFAULT;
  }
  return isM3Terminator(op);
}

/** Static branch target of one instruction, when the encoding carries one. */
function staticTarget(
  isa: TeachingMCUISAType,
  instruction: DecodedInstruction,
): number | undefined {
  if (isa === 'teaching') {
    return instruction.op === Op.TJMP || instruction.op === Op.TJNZ
      ? instruction.target >>> 0
      : undefined;
  }
  if (instruction.op === Op.B) return (instruction.pc + 4 + instruction.simm22 * 4) >>> 0;
  if (instruction.op === Op.BL) return (instruction.pc + 4 + instruction.simm26 * 4) >>> 0;
  return undefined;
}

/**
 * One translated guest block: a straight-line instruction run plus the
 * terminator that decides where control goes next.
 *
 * | `terminator`   | successors                                  |
 * | -------------- | ------------------------------------------- |
 * | `'jump'`       | `takenPc`                                   |
 * | `'branch'`     | `takenPc` (condition true) / `fallthroughPc` |
 * | `'fallthrough'`| `fallthroughPc`                             |
 * | `'halt'`       | none — leaves with `takenPc`                |
 * | `'wfi'`        | none — leaves with `takenPc`                |
 * | `'fault'`      | none — leaves with `takenPc`                |
 * | `'bx'`         | none — leaves with the dynamic target       |
 */
export type GuestTerminator = 'jump' | 'branch' | 'fallthrough' | 'halt' | 'wfi' | 'fault' | 'bx';

/**
 * One translated block: exactly one guest basic block, i.e. the straight-line
 * instruction run that starts at `pc` plus the terminator that decides where
 * control goes next.
 *
 * The provider therefore pays one dispatch per basic block. Guest loops are
 * closed on the host side by the JIT's region compiler, which fuses a hot
 * dispatch chain into a single compiled function (see
 * `region-performance.test.ts` and the README).
 *
 * Exported for the translation tests; the device API does not surface it.
 */
export interface GuestBlock {
  readonly pc: number;
  readonly instructions: readonly DecodedInstruction[];
  readonly terminator: GuestTerminator;
  /** Branch target (or the single successor for `'jump'`/`'fallthrough'`). */
  readonly takenPc: number;
  /** Not-taken successor of a conditional branch. */
  readonly fallthroughPc: number;
  /** The block contains HALT/WFI/TFAULT, so a yield request must be honoured. */
  readonly mayStop: boolean;
  /** True when the block can change peripheral output state. */
  readonly syncAfterBlock: boolean;
}

function decodeGuestInstruction(
  isa: TeachingMCUISAType,
  bytes: Uint8Array,
  view: DataView,
  index: number,
  pc: number,
): DecodedInstruction {
  if (isa === 'teaching') {
    const offset = index * 2;
    const opcode = bytes[offset] as number;
    const operand = bytes[offset + 1] as number;
    if (opcode === 0x10) return makeTeachingInstruction(Op.TADD, pc, operand, operand);
    if (opcode === 0x20) return makeTeachingInstruction(Op.TJMP, pc, operand, operand);
    if (opcode === 0x30) return makeTeachingInstruction(Op.TJNZ, pc, operand, operand);
    if (opcode === 0x00) return makeTeachingInstruction(Op.HALT, pc, 0, 0);
    return makeTeachingInstruction(Op.TFAULT, pc, 0, 0);
  }
  return decodeM3Word(view.getUint32(index * 4, true), pc);
}

/**
 * Decodes one translated block from a read-only instruction slice: the guest
 * basic block that starts at `startPc`, ending at (and including) its first
 * terminator or when the decode budget runs out.
 *
 * `bytes` is the read-only window that starts at `startPc` (the provider passes
 * the flash slice it fetched), and `maxInstructions` bounds one artifact.
 *
 * One provider artifact therefore covers one guest basic block. Closing guest
 * loops is the JIT's job: its region compiler fuses the hot dispatch chain into
 * one compiled function (see the README), so the provider no longer carries a
 * window-CFG translation of its own.
 *
 * Exported for the translation tests; the device API does not surface it.
 */
export function decodeGuestBlock(
  bytes: Uint8Array,
  startPc: number,
  maxInstructions: number,
  isa: TeachingMCUISAType,
): GuestBlock {
  const size = isa === 'teaching' ? 2 : 4;
  const limit = Math.min(maxInstructions, Math.floor(bytes.byteLength / size));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const instructions: DecodedInstruction[] = [];
  for (let index = 0; index < limit; index += 1) {
    const pc = startPc + index * size;
    const instruction = decodeGuestInstruction(isa, bytes, view, index, pc);
    instructions.push(instruction);
    if (isTerminator(isa, instruction.op)) break;
  }
  const last = instructions[instructions.length - 1];
  if (last === undefined) {
    // Nothing decodable: the caller already installed a fault for an unaligned
    // or out-of-range fetch, so this unit only repeats that state.
    return Object.freeze({
      pc: startPc,
      instructions: Object.freeze([]),
      terminator: 'fault',
      takenPc: startPc,
      fallthroughPc: startPc,
      mayStop: true,
      syncAfterBlock: isa === 'teaching',
    });
  }

  const nextPc = (last.pc + last.size) >>> 0;
  let terminator: GuestTerminator = 'fallthrough';
  let takenPc = nextPc;
  if (isTerminator(isa, last.op)) {
    const target = (staticTarget(isa, last) ?? nextPc) >>> 0;
    switch (last.op) {
      case Op.B:
        terminator = last.cond === Cond.AL ? 'jump' : 'branch';
        takenPc = target;
        break;
      case Op.BL:
      case Op.TJMP:
        terminator = 'jump';
        takenPc = target;
        break;
      case Op.TJNZ:
        terminator = 'branch';
        takenPc = target;
        break;
      case Op.BX:
        terminator = 'bx';
        break;
      case Op.HALT:
        terminator = 'halt';
        break;
      case Op.WFI:
        terminator = 'wfi';
        break;
      case Op.TFAULT:
        terminator = 'fault';
        takenPc = last.pc >>> 0;
        break;
      default:
        break;
    }
  }

  return Object.freeze({
    pc: startPc,
    instructions: Object.freeze(instructions),
    terminator,
    takenPc,
    fallthroughPc: nextPc,
    mayStop: terminator === 'halt' || terminator === 'wfi' || terminator === 'fault',
    syncAfterBlock:
      isa === 'teaching' ||
      instructions.some((instruction) => instruction.op === Op.STR || instruction.op === Op.STRB),
  });
}

function makeTeachingInstruction(
  op: number,
  pc: number,
  operand: number,
  target: number,
): DecodedInstruction {
  return Object.freeze({
    pc,
    size: 2,
    op,
    rd: 0,
    rn: 0,
    rm: 0,
    imm16: operand,
    imm8: operand,
    target,
    cond: Cond.AL,
    simm22: 0,
    simm26: 0,
  });
}

/* -------------------------------------------------------------------------
 * IR emission
 * ---------------------------------------------------------------------- */

type Builder<R extends readonly ScalarType[] = readonly []> = FunctionBuilder<R>;
type GeneratedBuilder = GeneratedFunctionBuilder<readonly []>;

interface MemoryNumbers {
  readonly flashSize: number;
  readonly ramSize: number;
  readonly ramBase: number;
  readonly peripheralBase: number;
  readonly peripheralOffset: number;
  readonly peripheralSize: number;
}

interface EmitContext {
  readonly isa: TeachingMCUISAType;
  readonly regs: ArrayRef<'u32'>;
  readonly memory: BytesRef<false>;
  readonly pc: StateRef<'u32'>;
  readonly cycles: StateRef<'u32'>;
  readonly sliceEnd: StateRef<'u32'>;
  readonly halted: StateRef<'bool'>;
  readonly fault: StateRef<'bool'>;
  readonly sleeping: StateRef<'bool'>;
  readonly yieldRequested: StateRef<'bool'>;
  readonly ipsr: StateRef<'u32'>;
  readonly flags: TeachingMCULayout['flags'];
  readonly load32: FunctionRef<readonly ['u32'], readonly ['u32']>;
  readonly load8: FunctionRef<readonly ['u32'], readonly ['u32']>;
  readonly store32: FunctionRef<readonly ['u32', 'u32'], readonly []>;
  readonly store8: FunctionRef<readonly ['u32', 'u32'], readonly []>;
  readonly returnFromException: FunctionRef<readonly [], readonly []>;
  readonly fetch: ProviderRef<readonly ['u32'], readonly [], readonly []>;
  /** Emitted after a teaching-ISA block: PA0 mirrors bit 0 of r0. */
  readonly legacyGpioOffset: number | undefined;
  /** Pin memories and GPIO layout used to publish outputs after a block. */
  readonly pinMemory: TeachingMCUPinMemory;
  readonly pins: ReadonlyMap<string, TeachingMCUPin>;
  readonly gpioMemoryOffset: (portIndex: number, register: number) => number;
  readonly portCount: number;
  /** Whether this block can change peripheral output state. */
  readonly syncAfterBlock: boolean;
}

function u32<R extends readonly ScalarType[]>(b: FunctionBuilder<R>, value: number): Value<'u32'> {
  return b.const('u32', value >>> 0);
}

function loadReg<R extends readonly ScalarType[]>(
  b: FunctionBuilder<R>,
  regs: ArrayRef<'u32'>,
  index: number,
): Value<'u32'> {
  return b.array.load(regs, b.const('u32', index));
}

function storeReg<R extends readonly ScalarType[]>(
  b: FunctionBuilder<R>,
  regs: ArrayRef<'u32'>,
  index: number,
  value: Value<'u32'>,
): void {
  b.array.store(regs, b.const('u32', index), value);
}

function memoryIndex<R extends readonly ScalarType[]>(
  b: FunctionBuilder<R>,
  address: Value<'u32'>,
  sizes: MemoryNumbers,
): { readonly index: Value<'u32'>; readonly valid: Value<'bool'> } {
  const flashOk = b.int.cmp('lt', address, u32(b, sizes.flashSize));
  const isRam = b.int.cmp('ge', address, u32(b, sizes.ramBase));
  const ramOk = b.bool.and(isRam, b.int.cmp('lt', address, u32(b, sizes.ramBase + sizes.ramSize)));
  const isPeripheral = b.int.cmp('ge', address, u32(b, sizes.peripheralBase));
  const peripheralOk = b.bool.and(
    isPeripheral,
    b.int.cmp('lt', address, u32(b, sizes.peripheralBase + sizes.peripheralSize)),
  );
  const ramIndex = b.int.add(u32(b, sizes.flashSize), b.int.sub(address, u32(b, sizes.ramBase)));
  const peripheralIndex = b.int.add(
    u32(b, sizes.peripheralOffset),
    b.int.sub(address, u32(b, sizes.peripheralBase)),
  );
  const index = b.select(isPeripheral, peripheralIndex, b.select(isRam, ramIndex, address));
  return Object.freeze({
    index,
    valid: b.bool.or(flashOk, b.bool.or(ramOk, peripheralOk)),
  });
}

function generateLoad(
  module: IRModule,
  name: string,
  memory: BytesRef<false>,
  fault: StateRef<'bool'>,
  halted: StateRef<'bool'>,
  sizes: MemoryNumbers,
  width: 1 | 4,
): FunctionRef<readonly ['u32'], readonly ['u32']> {
  const ref = module.func(name, { params: ['u32'], results: ['u32'] });
  ref.body((b, [address]) => {
    const { index, valid } = memoryIndex(b, address, sizes);
    const done = b.block(['u32']);
    const loadBlock = b.block(['u32']);
    const faultBlock = b.block([]);
    b.branch(valid, { target: loadBlock, args: [index] }, { target: faultBlock, args: [] });
    b.at(loadBlock, (ib, [offset]) => {
      const value =
        width === 4
          ? ib.bytes.load('u32', 'little', memory, offset)
          : ib.int.zext('u32', ib.bytes.load('u8', 'little', memory, offset));
      ib.jump(done, [value]);
    });
    b.at(faultBlock, (ib) => {
      ib.state.store(fault, ib.const('bool', true));
      ib.state.store(halted, ib.const('bool', true));
      ib.jump(done, [u32(ib, 0)]);
    });
    b.at(done, (ib, [value]) => ib.return([value]));
  });
  return ref;
}

interface NvicStateRefs {
  readonly enabled: StateRef<'u32'>;
  readonly pending: StateRef<'u32'>;
  readonly active: StateRef<'u32'>;
  readonly priority: StateRef<'u32'>;
  readonly address: (register: number) => number;
}

function generateStore(
  module: IRModule,
  name: string,
  memory: BytesRef<false>,
  fault: StateRef<'bool'>,
  halted: StateRef<'bool'>,
  sizes: MemoryNumbers,
  width: 1 | 4,
  nvic?: NvicStateRefs,
): FunctionRef<readonly ['u32', 'u32'], readonly []> {
  const ref = module.func(name, { params: ['u32', 'u32'], results: [] });
  ref.body((b, [address, value]) => {
    const { index, valid } = memoryIndex(b, address, sizes);
    const writable = b.bool.and(valid, b.int.cmp('ge', index, u32(b, sizes.flashSize)));
    if (width === 4 && nvic !== undefined) {
      // Keep the scalar NVIC register file in sync with firmware MMIO stores.
      const mirror = (target: StateRef<'u32'>, register: number): void => {
        const match = b.int.cmp('eq', address, u32(b, nvic.address(register)));
        b.state.store(target, b.select(match, value, b.state.load(target)));
      };
      mirror(nvic.enabled, NVIC_ENABLE);
      mirror(nvic.pending, NVIC_PENDING);
      mirror(nvic.active, NVIC_ACTIVE);
      mirror(nvic.priority, NVIC_PRIORITY);
    }
    const writeBlock = b.block(['u32', 'u32']);
    const faultBlock = b.block([]);
    const done = b.block([]);
    b.branch(
      writable,
      { target: writeBlock, args: [index, value] },
      { target: faultBlock, args: [] },
    );
    b.at(writeBlock, (ib, [offset, stored]) => {
      if (width === 4) {
        ib.bytes.store('u32', 'little', memory, offset, stored);
      } else {
        ib.bytes.store('u8', 'little', memory, offset, ib.int.trunc('u8', stored));
      }
      ib.jump(done, []);
    });
    b.at(faultBlock, (ib) => {
      ib.state.store(fault, ib.const('bool', true));
      ib.state.store(halted, ib.const('bool', true));
      ib.jump(done, []);
    });
    b.at(done, (ib) => ib.return([]));
  });
  return ref;
}

function emitCondition<R extends readonly ScalarType[]>(
  b: FunctionBuilder<R>,
  cond: number,
  flags: EmitContext['flags'],
): Value<'bool'> {
  const n = (): Value<'bool'> => b.state.load(flags.n);
  const z = (): Value<'bool'> => b.state.load(flags.z);
  const c = (): Value<'bool'> => b.state.load(flags.c);
  const v = (): Value<'bool'> => b.state.load(flags.v);
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
    default:
      return b.const('bool', true);
  }
}

function emitSubFlags<R extends readonly ScalarType[]>(
  b: FunctionBuilder<R>,
  ctx: EmitContext,
  left: Value<'u32'>,
  right: Value<'u32'>,
  result: Value<'u32'>,
): void {
  const zero = u32(b, 0);
  const sign = u32(b, SIGN_BIT);
  const overflow = b.int.and(b.int.xor(left, right), b.int.xor(left, result));
  b.state.store(ctx.flags.n, b.int.cmp('ne', b.int.and(result, sign), zero));
  b.state.store(ctx.flags.z, b.int.cmp('eq', result, zero));
  b.state.store(ctx.flags.c, b.int.cmp('ge', left, right));
  b.state.store(ctx.flags.v, b.int.cmp('ne', b.int.and(overflow, sign), zero));
}

function emitAddFlags<R extends readonly ScalarType[]>(
  b: FunctionBuilder<R>,
  ctx: EmitContext,
  result: Value<'u32'>,
  left: Value<'u32'>,
  right: Value<'u32'>,
): void {
  const zero = u32(b, 0);
  const sign = u32(b, SIGN_BIT);
  const overflow = b.int.and(b.int.xor(left, result), b.int.xor(left, right));
  b.state.store(ctx.flags.n, b.int.cmp('ne', b.int.and(result, sign), zero));
  b.state.store(ctx.flags.z, b.int.cmp('eq', result, zero));
  b.state.store(ctx.flags.c, b.int.cmp('lt', result, left));
  b.state.store(ctx.flags.v, b.int.cmp('ne', b.int.and(overflow, sign), zero));
}

function emitM3Instruction<R extends readonly ScalarType[]>(
  b: FunctionBuilder<R>,
  instruction: DecodedInstruction,
  ctx: EmitContext,
): void {
  const load = (index: number): Value<'u32'> => loadReg(b, ctx.regs, index);
  const store = (index: number, value: Value<'u32'>): void => storeReg(b, ctx.regs, index, value);
  const immediate = (): Value<'u32'> => u32(b, instruction.imm16);
  const address = (): Value<'u32'> => b.int.add(load(instruction.rn), u32(b, instruction.imm16));

  switch (instruction.op) {
    case Op.MOVI:
      store(instruction.rd, immediate());
      return;
    case Op.MOVT:
      store(
        instruction.rd,
        b.int.or(
          b.int.and(load(instruction.rd), u32(b, 0xffff)),
          u32(b, (instruction.imm16 << 16) >>> 0),
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
      emitSubFlags(b, ctx, left, right, b.int.sub(left, right));
      return;
    }
    case Op.CMPI: {
      const left = load(instruction.rn);
      const right = immediate();
      emitSubFlags(b, ctx, left, right, b.int.sub(left, right));
      return;
    }
    case Op.ADDS: {
      const left = load(instruction.rn);
      const right = load(instruction.rm);
      const result = b.int.add(left, right);
      store(instruction.rd, result);
      emitAddFlags(b, ctx, result, left, right);
      return;
    }
    case Op.SUBS: {
      const left = load(instruction.rn);
      const right = load(instruction.rm);
      const result = b.int.sub(left, right);
      store(instruction.rd, result);
      emitSubFlags(b, ctx, left, right, result);
      return;
    }
    case Op.LDR: {
      const [value] = b.call(ctx.load32, [address()]);
      store(instruction.rd, value!);
      return;
    }
    case Op.STR: {
      b.call(ctx.store32, [address(), load(instruction.rd)]);
      return;
    }
    case Op.LDRB: {
      const [value] = b.call(ctx.load8, [address()]);
      store(instruction.rd, value!);
      return;
    }
    case Op.STRB: {
      b.call(ctx.store8, [address(), load(instruction.rd)]);
      return;
    }
    case Op.NOP:
      return;
    case Op.TADD: {
      // Teaching ISA: `ADD R0, #imm` on the single accumulator register.
      storeReg(
        b,
        ctx.regs,
        instruction.rd,
        b.int.add(loadReg(b, ctx.regs, instruction.rd), u32(b, instruction.imm8)),
      );
      return;
    }
    default: {
      // Unknown encoding: latch a fault instead of aborting the host.
      b.state.store(ctx.fault, b.const('bool', true));
      b.state.store(ctx.halted, b.const('bool', true));
      return;
    }
  }
}

/**
 * Emits one translated block: the instruction run, its terminator, the
 * slice-budget gate that used to sit at every guest block boundary, and the two
 * exits (yield or dispatch).
 *
 * A `jump` back to the block's own entry stays an IR loop, so a self-looping
 * basic block still runs inside one compiled function. Every other successor
 * leaves through `ctx.fetch`, where the JIT's dispatch cache and region
 * compiler take over.
 *
 * ## One gate per block, not one per edge
 *
 * Both successors of a conditional branch share the same stop condition, so the
 * pending PC travels as a block parameter (`select`) and the artifact keeps a
 * single diamond instead of a pair of gates that join on the same two exits.
 * The edge that chooses the successor is a plain `jump`, i.e. a *fusible* edge:
 * it carries no host boundary and no duplicated exit block, which lets the JIT
 * region compiler structurize the artifact instead of running it through a
 * `switch (pc)` loop — the difference between a fused region and a dispatch per
 * guest basic block.
 */
function emitBlock(b: GeneratedBuilder, block: GuestBlock, ctx: EmitContext): void {
  const returnBlock = b.block(['u32', 'u32']);
  const dispatchBlock = b.block(['u32', 'u32']);
  const bodyBlock = b.block(['u32']);
  /** Successor PCs of this block; a self edge stays an IR loop. */
  const edges = blockEdges(block).filter((pc): pc is number => pc !== undefined);
  const selfLoop = edges.includes(block.pc);
  /** A self-loop-only block never leaves through the dispatch cache. */
  const leavesBlock = edges.some((pc) => pc !== block.pc);
  /**
   * One gate covers every successor unless the block both loops to itself and
   * leaves: that mixed shape keeps one gate per edge, because a single gate
   * would give the IR loop a second exit target and the structurizer (used by
   * region compilation) cannot express that.
   */
  const mergedGate = !(selfLoop && leavesBlock);
  /** The single boundary every successor passes through (`mergedGate`). */
  const gateBlock = mergedGate ? b.block(['u32', 'u32']) : undefined;
  const gateBlocks = mergedGate ? [] : edges.map(() => b.block(['u32', 'u32']));
  const deferred: (() => void)[] = [];

  b.jump(bodyBlock, [b.state.load(ctx.cycles)]);

  const emitExits = (): void => {
    b.at(returnBlock, (ib, [nextPc, count]) => {
      // The pc state is only observable between ticks, so the hot path keeps it
      // in a value and writes it once when the unit yields.
      ib.state.store(ctx.pc, nextPc!);
      ib.state.store(ctx.cycles, count!);
      ib.state.store(ctx.yieldRequested, ib.const('bool', false));
      if (ctx.syncAfterBlock) emitGpioBlockSync(ib, ctx);
      ib.return([]);
    });
    b.at(dispatchBlock, (ib, [nextPc, count]) => {
      ib.state.store(ctx.cycles, count!);
      // No pin publish here: a dispatch stays inside the same tick, and the
      // pin memory is only observable by the host at a tick boundary (the
      // `returnBlock` above). Publishing per block instead of per tick costs a
      // read-modify-write of every GPIO port on every guest basic block.
      ib.dispatch(ctx.fetch, [nextPc!], []);
    });
  };

  /** Shared boundary: honour the cycle budget/faults, then continue or leave. */
  const emitStop = (ib: GeneratedBuilder, count: Value<'u32'>): Value<'bool'> => {
    const sliceDone = ib.int.cmp('ge', count, ib.state.load(ctx.sliceEnd));
    return block.mayStop
      ? ib.bool.or(
          ib.bool.or(sliceDone, ib.state.load(ctx.fault)),
          ib.bool.or(ib.state.load(ctx.halted), ib.state.load(ctx.yieldRequested)),
        )
      : ib.bool.or(sliceDone, ib.state.load(ctx.fault));
  };
  if (gateBlock !== undefined) {
    b.at(gateBlock, (ib, [pendingPc, count]) => {
      const stop = emitStop(ib, count!);
      if (selfLoop) {
        ib.branch(
          stop,
          { target: returnBlock, args: [pendingPc!, count!] },
          { target: bodyBlock, args: [count!] },
        );
        return;
      }
      ib.branch(
        stop,
        { target: returnBlock, args: [pendingPc!, count!] },
        { target: dispatchBlock, args: [pendingPc!, count!] },
      );
    });
  } else {
    edges.forEach((successorPc, gateIndex) => {
      b.at(gateBlocks[gateIndex]!, (ib, [pendingPc, count]) => {
        const stop = emitStop(ib, count!);
        // The block's own entry is the only interior successor a single
        // translated block can have: every other target leaves through the
        // dispatch cache.
        if (successorPc === block.pc) {
          ib.branch(
            stop,
            { target: returnBlock, args: [pendingPc!, count!] },
            { target: bodyBlock, args: [count!] },
          );
        } else {
          ib.branch(
            stop,
            { target: returnBlock, args: [pendingPc!, count!] },
            { target: dispatchBlock, args: [pendingPc!, count!] },
          );
        }
      });
    });
  }

  /** Target block for a computed successor PC. */
  const gateTarget = (): NonNullable<typeof gateBlock> => gateBlock ?? gateBlocks[0]!;

  b.at(bodyBlock, (ib, [carried]) => {
    const count = carried!;
    const terminal = block.instructions.length - 1;
    let condition: Value<'bool'> | undefined;
    let direct: { readonly pc: number } | undefined;
    let bxTerminator: (() => void) | undefined;
    for (let index = 0; index < block.instructions.length; index += 1) {
      const instruction = block.instructions[index]!;
      if (index !== terminal || !isTerminator(ctx.isa, instruction.op)) {
        emitM3Instruction(ib, instruction, ctx);
        continue;
      }
      switch (instruction.op) {
        case Op.B:
          if (instruction.cond !== Cond.AL) {
            condition = emitCondition(ib, instruction.cond, ctx.flags);
          }
          break;
        case Op.TJNZ:
          condition = ib.int.cmp('ne', loadReg(ib, ctx.regs, 0), u32(ib, 0));
          break;
        case Op.BL:
          storeReg(ib, ctx.regs, 14, u32(ib, (instruction.pc + instruction.size) >>> 0));
          break;
        case Op.BX: {
          const value = loadReg(ib, ctx.regs, instruction.rn);
          const exceptionReturn = ib.int.cmp('ge', value, u32(ib, EXCEPTION_RETURN_MASK));
          const target = ib.int.and(value, u32(ib, 0xffff_fffe));
          const exceptionBlock = b.block(['u32']);
          const normalBlock = b.block(['u32', 'u32']);
          bxTerminator = () => {
            ib.branch(
              exceptionReturn,
              { target: exceptionBlock, args: [count] },
              { target: normalBlock, args: [count, target] },
            );
          };
          deferred.push(() => {
            b.at(exceptionBlock, (eb, [carriedCount]) => {
              eb.call(ctx.returnFromException, []);
              eb.jump(gateTarget(), [
                eb.state.load(ctx.pc),
                eb.int.add(carriedCount!, u32(eb, block.instructions.length)),
              ]);
            });
            b.at(normalBlock, (nb, [carriedCount, targetPc]) => {
              nb.jump(gateTarget(), [
                targetPc!,
                nb.int.add(carriedCount!, u32(nb, block.instructions.length)),
              ]);
            });
          });
          break;
        }
        case Op.HALT:
          ib.state.store(ctx.halted, ib.const('bool', true));
          direct = { pc: block.takenPc };
          break;
        case Op.WFI:
          ib.state.store(ctx.sleeping, ib.const('bool', true));
          ib.state.store(ctx.yieldRequested, ib.const('bool', true));
          direct = { pc: block.takenPc };
          break;
        case Op.TFAULT:
          ib.state.store(ctx.fault, ib.const('bool', true));
          ib.state.store(ctx.halted, ib.const('bool', true));
          direct = { pc: block.takenPc };
          break;
        default:
          break;
      }
    }

    if (ctx.isa === 'teaching' && ctx.legacyGpioOffset !== undefined) {
      // The original device published `r0 & 1` on its GPIO pin after each block.
      const odr = ib.bytes.load('u32', 'little', ctx.memory, u32(ib, ctx.legacyGpioOffset));
      const bit = ib.int.and(loadReg(ib, ctx.regs, 0), u32(ib, 1));
      ib.bytes.store(
        'u32',
        'little',
        ctx.memory,
        u32(ib, ctx.legacyGpioOffset),
        ib.int.or(ib.int.and(odr, u32(ib, 0xffff_fffe)), bit),
      );
    }

    const next = ib.int.add(count, u32(ib, block.instructions.length));
    if (direct !== undefined) {
      ib.jump(returnBlock, [u32(ib, direct.pc), next]);
      return;
    }
    if (bxTerminator !== undefined) {
      bxTerminator();
      return;
    }
    if (condition !== undefined) {
      if (gateBlock !== undefined) {
        // The successor choice is a value, not a control-flow split: the single
        // gate below is the only boundary the block pays for.
        const pendingPc = ib.select(
          condition,
          u32(ib, block.takenPc),
          u32(ib, block.fallthroughPc),
        );
        ib.jump(gateBlock, [pendingPc, next]);
        return;
      }
      ib.branch(
        condition,
        { target: gateBlocks[0]!, args: [u32(ib, block.takenPc), next] },
        { target: gateBlocks[1]!, args: [u32(ib, block.fallthroughPc), next] },
      );
      return;
    }
    ib.jump(gateTarget(), [
      u32(ib, block.terminator === 'fallthrough' ? block.fallthroughPc : block.takenPc),
      next,
    ]);
  });

  emitExits();
  for (const emit of deferred) emit();
}

/** Successor PCs that need a gate, in the order the terminator may take them. */
function blockEdges(block: GuestBlock): readonly (number | undefined)[] {
  switch (block.terminator) {
    case 'jump':
      return [block.takenPc];
    case 'fallthrough':
      return [block.fallthroughPc];
    case 'branch':
      return [block.takenPc, block.fallthroughPc];
    case 'bx':
      return [undefined];
    default:
      return [];
  }
}

/* -------------------------------------------------------------------------
 * Generation
 * ---------------------------------------------------------------------- */

/** Publishes every GPIO port's ODR/DIR pair into the shared pin memory. */
function emitGpioBlockSync<R extends readonly ScalarType[]>(
  ib: FunctionBuilder<R>,
  ctx: EmitContext,
): void {
  for (let portIndex = 0; portIndex < ctx.portCount; portIndex += 1) {
    const odr = ib.bytes.load(
      'u32',
      'little',
      ctx.memory,
      u32(ib, ctx.gpioMemoryOffset(portIndex, GPIO_ODR)),
    );
    const dir = ib.bytes.load(
      'u32',
      'little',
      ctx.memory,
      u32(ib, ctx.gpioMemoryOffset(portIndex, GPIO_DIR)),
    );
    emitPortDrive(ib, { pins: ctx.pins, pinMemory: ctx.pinMemory, portIndex }, odr, dir);
  }
}

interface GenerateOptions {
  readonly module: IRModule;
  readonly deviceId: string;
  readonly config: ResolvedTeachingMCUConfig;
  /** Existing global pin memory when generating into a circuit. */
  readonly pinMemory?: TeachingMCUPinMemory;
  /** Pin name -> global pin id when generating into a circuit. */
  readonly pinIds?: ReadonlyMap<string, number>;
}

interface GeneratedKernel {
  readonly layout: TeachingMCULayout;
  readonly entries: TeachingMCULayout['entries'];
}

function generateKernel(options: GenerateOptions): GeneratedKernel {
  const { module, deviceId, config } = options;
  const portCount = config.ports.length;
  const portWidth = config.portWidth;
  const gpioSize = portCount * GPIO_PORT_STRIDE;
  const peripheralOffset = config.flashSize + config.ramSize;
  const peripheralSize = gpioSize + NVIC_BLOCK_SIZE;
  const memorySize = peripheralOffset + peripheralSize;
  const nvicOffset = peripheralOffset + gpioSize;
  const gpioAddress = (portIndex: number, register: number): number =>
    PERIPHERAL_BASE + portIndex * GPIO_PORT_STRIDE + register;
  const nvicAddress = (register: number): number => PERIPHERAL_BASE + gpioSize + register;
  const gpioMemoryOffset = (portIndex: number, register: number): number =>
    peripheralOffset + portIndex * GPIO_PORT_STRIDE + register;
  const nvicMemoryOffset = (register: number): number => nvicOffset + register;

  const pinMemory: TeachingMCUPinMemory =
    options.pinMemory === undefined
      ? createStandalonePinMemory(module, deviceId)
      : options.pinMemory;
  const pins = resolvePins(deviceId, config, options.pinIds);

  const registerNames = Array.from({ length: REGISTER_COUNT }, (_, index) => `r${index}`);
  const registers = module.array(`${deviceId}_regs`, 'u32', config.registers);
  const flash = module.bytes(`${deviceId}_flash`, config.firmware, {
    readonly: true,
    unitBytes: config.isa === 'teaching' ? 2 : 4,
  });
  const memory = module.bytes(`${deviceId}_memory`, createMemoryImage(config), {
    readonly: false,
    unitBytes: 64,
  });
  const n = module.state(`${deviceId}_n`, 'bool', false);
  const z = module.state(`${deviceId}_z`, 'bool', false);
  const c = module.state(`${deviceId}_c`, 'bool', false);
  const v = module.state(`${deviceId}_v`, 'bool', false);
  const pc = module.state(`${deviceId}_pc`, 'u32', config.pc);
  const cycles = module.state(`${deviceId}_cycles`, 'u32', 0);
  const sliceEnd = module.state(`${deviceId}_slice_end`, 'u32', 0);
  const halted = module.state(`${deviceId}_halted`, 'bool', false);
  const fault = module.state(`${deviceId}_fault`, 'bool', false);
  const sleeping = module.state(`${deviceId}_sleeping`, 'bool', false);
  const yieldRequested = module.state(`${deviceId}_yield`, 'bool', false);
  const runRequested = module.state(`${deviceId}_run_requested`, 'bool', true);
  const ipsr = module.state(`${deviceId}_ipsr`, 'u32', 0);
  const nvicEnabled = module.state(`${deviceId}_nvic_enabled`, 'u32', 0);
  const nvicPending = module.state(`${deviceId}_nvic_pending`, 'u32', 0);
  const nvicActive = module.state(`${deviceId}_nvic_active`, 'u32', 0);
  const nvicPriority = module.state(`${deviceId}_nvic_priority`, 'u32', 0);
  const nvic = Object.freeze({
    enabled: nvicEnabled,
    pending: nvicPending,
    active: nvicActive,
    priority: nvicPriority,
  });

  const sizes: MemoryNumbers = {
    flashSize: config.flashSize,
    ramSize: config.ramSize,
    ramBase: RAM_BASE,
    peripheralBase: PERIPHERAL_BASE,
    peripheralOffset,
    peripheralSize,
  };

  const load32 = generateLoad(module, `${deviceId}_load32`, memory, fault, halted, sizes, 4);
  const load8 = generateLoad(module, `${deviceId}_load8`, memory, fault, halted, sizes, 1);
  const store32 = generateStore(module, `${deviceId}_store32`, memory, fault, halted, sizes, 4, {
    ...nvic,
    address: nvicAddress,
  });
  const store8 = generateStore(module, `${deviceId}_store8`, memory, fault, halted, sizes, 1);

  const flags = Object.freeze({ n, z, c, v });

  const firstPendingIrq = module.func(`${deviceId}_first_irq`, {
    params: ['u32'],
    results: ['u32'],
  });
  firstPendingIrq.body((b, [value]) => b.return([lowestBitIndex(b, value)]));

  const exceptionOptions: ExceptionOptions = {
    module,
    memory,
    deviceId,
    config,
    registers,
    flags,
    pc,
    cycles,
    firstPendingIrq,
    sleeping,
    ipsr,
    fault,
    halted,
    load32,
    store32,
    nvic,
    nvicOffset: nvicMemoryOffset,
  };
  const enterException = generateEnterException(exceptionOptions);
  const returnFromException = generateReturnFromException(exceptionOptions);

  // Declared before the provider so the generated block can tail-dispatch to
  // itself; the callback runs after the provider ref exists.
  const fetch: ProviderRef<readonly ['u32'], readonly [], readonly []> = module.provider(
    `${deviceId}_fetch`,
    {
      keyTypes: ['u32'],
      params: [],
      results: [],
      reads: [flash],
      imports: [
        registers,
        flash,
        memory,
        pinMemory.mode,
        pinMemory.output,
        pc,
        cycles,
        sliceEnd,
        halted,
        fault,
        sleeping,
        yieldRequested,
        ipsr,
        n,
        z,
        c,
        v,
        load32,
        load8,
        store32,
        store8,
        returnFromException,
      ],
    },
    (gen, [key]) => {
      const address = (key as number) >>> 0;
      const instructionSize = config.isa === 'teaching' ? 2 : 4;
      const executableSize = Math.min(config.firmware.byteLength, config.flashSize);
      const aligned = address % instructionSize === 0;
      const available = executableSize - address;
      if (!aligned || available < instructionSize) {
        return gen.function((b) => {
          b.state.store(fault, b.const('bool', true));
          b.state.store(halted, b.const('bool', true));
          b.state.store(pc, u32(b, address));
          b.return([]);
        });
      }
      const maxInstructions = config.isa === 'teaching' ? 4096 : config.maxBlockInstructions;
      const length = Math.min(maxInstructions * instructionSize, available);
      const bytes = gen.readBytes(flash, address, length);
      const block = decodeGuestBlock(bytes, address, maxInstructions, config.isa);
      return gen.function((b) => {
        emitBlock(b, block, {
          isa: config.isa,
          regs: registers,
          memory,
          pc,
          cycles,
          sliceEnd,
          halted,
          fault,
          sleeping,
          yieldRequested,
          ipsr,
          flags,
          load32,
          load8,
          store32,
          store8,
          returnFromException,
          fetch,
          legacyGpioOffset: config.isa === 'teaching' ? peripheralOffset : undefined,
          pinMemory,
          pins,
          gpioMemoryOffset,
          portCount,
          // Teaching blocks always publish `r0 & 1`; M3 blocks only touch the
          // peripheral window through stores.
          syncAfterBlock: block.syncAfterBlock,
        });
      });
    },
  );

  const emitSyncPort = (b: Builder, portIndex: number): void => {
    const odr = b.bytes.load(
      'u32',
      'little',
      memory,
      u32(b, gpioMemoryOffset(portIndex, GPIO_ODR)),
    );
    const dir = b.bytes.load(
      'u32',
      'little',
      memory,
      u32(b, gpioMemoryOffset(portIndex, GPIO_DIR)),
    );
    emitPortDrive(b, { pins, pinMemory, portIndex }, odr, dir);
  };
  const emitUpdatePort = (b: Builder, portIndex: number): void => {
    emitUpdatePortBody(b, {
      memory,
      portIndex,
      pins,
      pinMemory,
      gpioOffset: gpioMemoryOffset,
      nvicOffset: nvicMemoryOffset,
      nvic,
      interrupts: config.interrupts.filter((entry) => entry.port === config.ports[portIndex]),
    });
  };

  const initialize = module.func(`${deviceId}_ir_initialize`, { params: [], results: [] });
  initialize.body((b) => {
    for (const pin of pins.values()) {
      b.array.store(pinMemory.mode, u32(b, pin.globalPinId), b.const('u8', PIN_MODE.highZ));
      b.array.store(pinMemory.output, u32(b, pin.globalPinId), b.const('bool', false));
    }
    b.state.store(sleeping, b.const('bool', false));
    b.state.store(yieldRequested, b.const('bool', false));
    for (let portIndex = 0; portIndex < config.ports.length; portIndex += 1) {
      emitSyncPort(b, portIndex);
      emitUpdatePort(b, portIndex);
    }
    b.return([]);
  });

  const serviceInterrupts = module.func(`${deviceId}_service_interrupts`, {
    params: [],
    results: [],
  });
  serviceInterrupts.body((b) => {
    const pending = b.state.load(nvic.pending);
    const enabled = b.state.load(nvic.enabled);
    const running = b.state.load(nvic.active);
    const ready = b.int.and(b.int.and(pending, enabled), b.int.not(running));
    const canEnter = b.bool.and(
      b.int.cmp('eq', b.state.load(ipsr), u32(b, 0)),
      b.int.cmp('ne', ready, u32(b, 0)),
    );
    const awake = b.bool.or(b.bool.not(b.state.load(sleeping)), canEnter);
    b.call(enterException, [canEnter]);
    b.state.store(
      runRequested,
      b.bool.and(
        awake,
        b.bool.and(b.bool.not(b.state.load(fault)), b.bool.not(b.state.load(halted))),
      ),
    );
    b.return([]);
  });

  const tick = module.func(`${deviceId}_ir_tick`, { params: [], results: [] });
  tick.body((b) => {
    const run = b.block([]);
    const check = b.block([]);
    const service = b.block([]);
    const idle = b.block([]);
    b.branch(
      b.bool.or(b.state.load(halted), b.state.load(fault)),
      { target: idle, args: [] },
      { target: check, args: [] },
    );
    b.at(check, (ib) => {
      // Skip the NVIC service call entirely unless sleep state or a ready IRQ
      // can change it. This is the common case for single-step execution.
      const ready = ib.int.and(
        ib.int.and(ib.state.load(nvic.pending), ib.state.load(nvic.enabled)),
        ib.int.not(ib.state.load(nvic.active)),
      );
      ib.branch(
        ib.bool.or(ib.state.load(sleeping), ib.int.cmp('ne', ready, u32(ib, 0))),
        { target: service, args: [] },
        { target: run, args: [] },
      );
    });
    b.at(service, (ib) => {
      ib.call(serviceInterrupts, []);
      ib.branch(ib.state.load(runRequested), { target: run, args: [] }, { target: idle, args: [] });
    });
    b.at(run, (ib) => {
      // Host writes to ODR/DIR are published by the accessor; guest writes are
      // published by the translated block that performed them. The tick itself
      // only sets up the cycle slice and tail-dispatches.
      const nextSlice = ib.int.add(ib.state.load(cycles), u32(ib, config.instructionsPerTick));
      ib.state.store(sliceEnd, nextSlice);
      ib.state.store(sleeping, ib.const('bool', false));
      ib.dispatch(fetch, [ib.state.load(pc)], []);
    });
    b.at(idle, (ib) => ib.return([]));
  });

  const update = module.func(`${deviceId}_ir_update`, { params: [], results: [] });
  update.body((b) => {
    for (let portIndex = 0; portIndex < config.ports.length; portIndex += 1) {
      emitUpdatePort(b, portIndex);
    }
    b.return([]);
  });

  const layout: TeachingMCULayout = Object.freeze({
    deviceId,
    isa: config.isa,
    config,
    pins,
    pinNames: Object.freeze([...pins.keys()]),
    pinMemory,
    registers,
    flash,
    memory,
    flashSize: config.flashSize,
    ramSize: config.ramSize,
    memorySize,
    flashBase: FLASH_BASE,
    ramBase: RAM_BASE,
    peripheralBase: PERIPHERAL_BASE,
    peripheralOffset,
    peripheralSize,
    gpioOffset: peripheralOffset,
    nvicOffset,
    portCount,
    portWidth,
    registerCount: REGISTER_COUNT,
    registerNames: Object.freeze(registerNames),
    flags,
    pc,
    cycles,
    sliceEnd,
    halted,
    fault,
    sleeping,
    yieldRequested,
    ipsr,
    nvic,
    entries: Object.freeze({ initialize, tick, update }),
    functions: Object.freeze({
      load32,
      load8,
      store32,
      store8,
      enterException,
      returnFromException,
      fetch,
    }),
    executableSize: Math.min(config.firmware.byteLength, config.flashSize),
    gpioAddress,
    nvicAddress,
  });

  return Object.freeze({ layout, entries: layout.entries });
}

function lowestBitIndex<R extends readonly ScalarType[]>(
  b: FunctionBuilder<R>,
  value: Value<'u32'>,
): Value<'u32'> {
  let index = u32(b, 0);
  for (let bit = 31; bit >= 0; bit -= 1) {
    const mask = (1 << bit) >>> 0;
    const set = b.int.cmp('ne', b.int.and(value, u32(b, mask)), u32(b, 0));
    index = b.select(set, u32(b, bit), index);
  }
  return index;
}

interface ExceptionOptions {
  readonly module: IRModule;
  readonly memory: BytesRef<false>;
  readonly deviceId: string;
  readonly config: ResolvedTeachingMCUConfig;
  readonly registers: ArrayRef<'u32'>;
  readonly flags: TeachingMCULayout['flags'];
  readonly pc: StateRef<'u32'>;
  readonly cycles: StateRef<'u32'>;
  readonly firstPendingIrq: FunctionRef<readonly ['u32'], readonly ['u32']>;
  readonly sleeping: StateRef<'bool'>;
  readonly ipsr: StateRef<'u32'>;
  readonly fault: StateRef<'bool'>;
  readonly halted: StateRef<'bool'>;
  readonly load32: FunctionRef<readonly ['u32'], readonly ['u32']>;
  readonly store32: FunctionRef<readonly ['u32', 'u32'], readonly []>;
  readonly nvic: {
    readonly enabled: StateRef<'u32'>;
    readonly pending: StateRef<'u32'>;
    readonly active: StateRef<'u32'>;
    readonly priority: StateRef<'u32'>;
  };
  /** Memory offset of the NVIC register block. */
  readonly nvicOffset: (register: number) => number;
}

function generateEnterException(
  options: ExceptionOptions,
): FunctionRef<readonly ['bool'], readonly []> {
  const {
    module,
    memory,
    deviceId,
    config,
    registers,
    flags,
    pc,
    cycles,
    firstPendingIrq,
    sleeping,
    ipsr,
    fault,
    halted,
    load32,
    store32,
    nvic,
    nvicOffset,
  } = options;
  const ref = module.func(`${deviceId}_enter_exception`, {
    params: ['bool'],
    results: [],
  });
  ref.body((b, [enter]) => {
    const push = b.block([]);
    const checked = b.block([]);
    const stackFault = b.block([]);
    const skip = b.block([]);
    const done = b.block([]);
    b.branch(enter, { target: checked, args: [] }, { target: skip, args: [] });
    b.at(checked, (ib) => {
      const sp = loadReg(ib, registers, 13);
      const frame = ib.int.sub(sp, u32(ib, EXCEPTION_FRAME_SIZE));
      const inRange = ib.bool.and(
        ib.int.cmp('ge', frame, u32(ib, RAM_BASE)),
        ib.int.cmp('le', frame, u32(ib, RAM_BASE + config.ramSize - EXCEPTION_FRAME_SIZE)),
      );
      ib.branch(inRange, { target: push, args: [] }, { target: stackFault, args: [] });
    });
    b.at(stackFault, (ib) => {
      ib.state.store(fault, ib.const('bool', true));
      ib.state.store(halted, ib.const('bool', true));
      ib.jump(done, []);
    });
    b.at(skip, (ib) => ib.jump(done, []));
    b.at(push, (ib) => {
      const sp = loadReg(ib, registers, 13);
      const base = ib.int.sub(sp, u32(ib, EXCEPTION_FRAME_SIZE));
      const pending = ib.state.load(nvic.pending);
      const enabled = ib.state.load(nvic.enabled);
      const running = ib.state.load(nvic.active);
      const ready = ib.int.and(ib.int.and(pending, enabled), ib.int.not(running));
      const [irq] = ib.call(firstPendingIrq, [ready]);
      const irqValue = irq!;
      const store = (offset: number, value: Value<'u32'>): void => {
        ib.call(store32, [ib.int.add(base, u32(ib, offset)), value]);
      };
      for (let index = 0; index < 4; index += 1) {
        store(index * 4, loadReg(ib, registers, index));
      }
      store(16, loadReg(ib, registers, 12));
      store(20, loadReg(ib, registers, 14));
      store(24, ib.state.load(pc));
      const flagBits = (refValue: StateRef<'bool'>, mask: number): Value<'u32'> =>
        ib.select(ib.state.load(refValue), u32(ib, mask), u32(ib, 0));
      const xpsr = ib.int.or(
        flagBits(flags.n, SIGN_BIT),
        ib.int.or(
          flagBits(flags.z, 0x4000_0000),
          ib.int.or(
            flagBits(flags.c, 0x2000_0000),
            ib.int.or(flagBits(flags.v, 0x1000_0000), ib.int.add(irqValue, u32(ib, 16))),
          ),
        ),
      );
      store(28, xpsr);
      storeReg(ib, registers, 13, base);
      storeReg(ib, registers, 14, u32(ib, EXCEPTION_RETURN_LR));

      const bit = ib.int.shl(u32(ib, 1), irqValue);
      const nextPending = ib.int.and(pending, ib.int.not(bit));
      ib.state.store(nvic.pending, nextPending);
      ib.bytes.store('u32', 'little', memory, u32(ib, nvicOffset(NVIC_PENDING)), nextPending);
      const nextActive = ib.int.or(running, bit);
      ib.state.store(nvic.active, nextActive);
      ib.bytes.store('u32', 'little', memory, u32(ib, nvicOffset(NVIC_ACTIVE)), nextActive);
      ib.state.store(ipsr, ib.int.add(irqValue, u32(ib, 16)));
      ib.state.store(sleeping, ib.const('bool', false));

      const vectorAddress = ib.int.add(
        u32(ib, config.vectorBase),
        ib.int.mul(ib.int.add(irqValue, u32(ib, 16)), u32(ib, 4)),
      );
      const [vector] = ib.call(load32, [vectorAddress]);
      ib.state.store(pc, vector!);
      if (config.exceptionCycles > 0) {
        ib.state.store(cycles, ib.int.add(ib.state.load(cycles), u32(ib, config.exceptionCycles)));
      }
      ib.jump(done, []);
    });
    b.at(done, (ib) => ib.return([]));
  });
  return ref;
}

function generateReturnFromException(
  options: ExceptionOptions,
): FunctionRef<readonly [], readonly []> {
  const {
    module,
    memory,
    deviceId,
    config,
    registers,
    flags,
    pc,
    ipsr,
    fault,
    load32,
    nvic,
    nvicOffset,
  } = options;
  const ref = module.func(`${deviceId}_return_exception`, { params: [], results: [] });
  ref.body((b) => {
    const sp = loadReg(b, registers, 13);
    const inRange = b.bool.and(
      b.int.cmp('ge', sp, u32(b, RAM_BASE)),
      b.int.cmp('le', sp, u32(b, RAM_BASE + config.ramSize - EXCEPTION_FRAME_SIZE)),
    );
    const pop = b.block([]);
    const fail = b.block([]);
    const done = b.block([]);
    b.branch(inRange, { target: pop, args: [] }, { target: fail, args: [] });
    b.at(pop, (ib) => {
      const base = loadReg(ib, registers, 13);
      const load = (offset: number): Value<'u32'> =>
        ib.call(load32, [ib.int.add(base, u32(ib, offset))])[0]!;
      for (let index = 0; index < 4; index += 1) {
        storeReg(ib, registers, index, load(index * 4));
      }
      storeReg(ib, registers, 12, load(16));
      storeReg(ib, registers, 14, load(20));
      ib.state.store(pc, load(24));
      const xpsr = load(28);
      const bitSet = (mask: number): Value<'bool'> =>
        ib.int.cmp('ne', ib.int.and(xpsr, u32(ib, mask)), u32(ib, 0));
      ib.state.store(flags.n, bitSet(SIGN_BIT));
      ib.state.store(flags.z, bitSet(0x4000_0000));
      ib.state.store(flags.c, bitSet(0x2000_0000));
      ib.state.store(flags.v, bitSet(0x1000_0000));
      storeReg(ib, registers, 13, ib.int.add(base, u32(ib, EXCEPTION_FRAME_SIZE)));
      ib.state.store(ipsr, u32(ib, 0));
      ib.state.store(nvic.active, u32(ib, 0));
      ib.bytes.store('u32', 'little', memory, u32(ib, nvicOffset(NVIC_ACTIVE)), u32(ib, 0));
      ib.jump(done, []);
    });
    b.at(fail, (ib) => {
      ib.state.store(fault, ib.const('bool', true));
      ib.jump(done, []);
    });
    b.at(done, (ib) => ib.return([]));
  });
  return ref;
}

interface PortDriveOptions {
  readonly pins: ReadonlyMap<string, TeachingMCUPin>;
  readonly pinMemory: TeachingMCUPinMemory;
  readonly portIndex: number;
}

function emitPortDrive<R extends readonly ScalarType[]>(
  ib: FunctionBuilder<R>,
  options: PortDriveOptions,
  odr: Value<'u32'>,
  dir: Value<'u32'>,
): void {
  for (const pin of options.pins.values()) {
    if (pin.portIndex !== options.portIndex) continue;
    const mask = (1 << pin.bit) >>> 0;
    const isOutput = ib.int.cmp('ne', ib.int.and(dir, u32(ib, mask)), u32(ib, 0));
    const level = ib.int.cmp('ne', ib.int.and(odr, u32(ib, mask)), u32(ib, 0));
    ib.array.store(
      options.pinMemory.mode,
      u32(ib, pin.globalPinId),
      ib.select(isOutput, ib.const('u8', PIN_MODE.pushPull), ib.const('u8', PIN_MODE.highZ)),
    );
    ib.array.store(options.pinMemory.output, u32(ib, pin.globalPinId), level);
  }
}

function emitUpdatePortBody<R extends readonly ScalarType[]>(
  b: FunctionBuilder<R>,
  options: UpdatePortOptions,
): void {
  const odr = b.bytes.load(
    'u32',
    'little',
    options.memory,
    u32(b, options.gpioOffset(options.portIndex, GPIO_ODR)),
  );
  const dir = b.bytes.load(
    'u32',
    'little',
    options.memory,
    u32(b, options.gpioOffset(options.portIndex, GPIO_DIR)),
  );
  const oldIdr = b.bytes.load(
    'u32',
    'little',
    options.memory,
    u32(b, options.gpioOffset(options.portIndex, GPIO_IDR)),
  );
  let nextIdr = u32(b, 0);
  for (const pin of options.pins.values()) {
    if (pin.portIndex !== options.portIndex) continue;
    const mask = (1 << pin.bit) >>> 0;
    const isOutput = b.int.cmp('ne', b.int.and(dir, u32(b, mask)), u32(b, 0));
    const outputLevel = b.int.cmp('ne', b.int.and(odr, u32(b, mask)), u32(b, 0));
    const sample = b.array.load(options.pinMemory.input, u32(b, pin.globalPinId));
    const level = b.select(isOutput, outputLevel, sample);
    nextIdr = b.int.or(nextIdr, b.select(level, u32(b, mask), u32(b, 0)));
  }
  b.bytes.store(
    'u32',
    'little',
    options.memory,
    u32(b, options.gpioOffset(options.portIndex, GPIO_IDR)),
    nextIdr,
  );
  for (const interrupt of options.interrupts) {
    const mask = (1 << interrupt.bit) >>> 0;
    const oldBit = b.int.cmp('ne', b.int.and(oldIdr, u32(b, mask)), u32(b, 0));
    const newBit = b.int.cmp('ne', b.int.and(nextIdr, u32(b, mask)), u32(b, 0));
    const edge = interrupt.edge ?? 'both';
    const fired =
      edge === 'rising'
        ? b.bool.and(b.bool.not(oldBit), newBit)
        : edge === 'falling'
          ? b.bool.and(oldBit, b.bool.not(newBit))
          : b.bool.xor(oldBit, newBit);
    const pending = b.state.load(options.nvic.pending);
    const nextPending = b.select(
      fired,
      b.int.or(pending, u32(b, (1 << interrupt.irq) >>> 0)),
      pending,
    );
    b.state.store(options.nvic.pending, nextPending);
    b.bytes.store(
      'u32',
      'little',
      options.memory,
      u32(b, options.nvicOffset(NVIC_PENDING)),
      nextPending,
    );
  }
}

interface UpdatePortOptions {
  readonly memory: BytesRef<false>;
  readonly portIndex: number;
  readonly pins: ReadonlyMap<string, TeachingMCUPin>;
  readonly pinMemory: TeachingMCUPinMemory;
  /** Memory offset of the port's register block. */
  readonly gpioOffset: (portIndex: number, register: number) => number;
  /** Memory offset of the NVIC register block. */
  readonly nvicOffset: (register: number) => number;
  readonly nvic: {
    readonly enabled: StateRef<'u32'>;
    readonly pending: StateRef<'u32'>;
    readonly active: StateRef<'u32'>;
    readonly priority: StateRef<'u32'>;
  };
  readonly interrupts: readonly TeachingMCUInterruptConfig[];
}

/** Standalone pin memory used when the device is not compiled into a circuit. */
function createStandalonePinMemory(module: IRModule, deviceId: string): TeachingMCUPinMemory {
  return Object.freeze({
    mode: module.array(
      `${deviceId}_pin_mode`,
      'u8',
      Array.from({ length: 64 }, () => PIN_MODE.highZ),
    ),
    output: module.array(
      `${deviceId}_pin_output`,
      'bool',
      Array.from({ length: 64 }, () => false),
    ),
    input: module.array(
      `${deviceId}_pin_input`,
      'bool',
      Array.from({ length: 64 }, () => false),
    ),
  });
}

function resolvePins(
  deviceId: string,
  config: ResolvedTeachingMCUConfig,
  pinIds: ReadonlyMap<string, number> | undefined,
): ReadonlyMap<string, TeachingMCUPin> {
  const pins = new Map<string, TeachingMCUPin>();
  let standaloneId = 0;
  for (const [portIndex, port] of config.ports.entries()) {
    for (let bit = 0; bit < config.portWidth; bit += 1) {
      const name = `P${port}${bit}`;
      const globalPinId = pinIds?.get(name) ?? standaloneId;
      standaloneId += 1;
      pins.set(name, Object.freeze({ name, port, portIndex, bit, globalPinId }));
    }
  }
  if (pinIds !== undefined) {
    for (const name of pinIds.keys()) {
      if (!pins.has(name)) {
        throw new TeachingMCUError(
          'unknown-pin',
          `Device "${deviceId}" declared pin "${name}" but the teaching MCU config has no such GPIO pin`,
          { deviceId, pinName: name },
        );
      }
    }
  }
  return pins;
}

function createMemoryImage(config: ResolvedTeachingMCUConfig): Uint8Array {
  const peripheralOffset = config.flashSize + config.ramSize;
  const gpioSize = config.ports.length * GPIO_PORT_STRIDE;
  const memory = new Uint8Array(peripheralOffset + gpioSize + NVIC_BLOCK_SIZE);
  const firmware = config.firmware.subarray(
    0,
    Math.min(config.firmware.byteLength, config.flashSize),
  );
  memory.set(firmware, 0);
  memory.set(
    config.ramInitial.subarray(0, Math.min(config.ramInitial.byteLength, config.ramSize)),
    config.flashSize,
  );
  for (const [portIndex, port] of config.ports.entries()) {
    const base = peripheralOffset + portIndex * GPIO_PORT_STRIDE;
    const odr = (config.initialOutputs[port] ?? 0) >>> 0;
    const dir = (config.initialDirections[port] ?? 0) >>> 0;
    writeU32(memory, base + GPIO_ODR, odr);
    writeU32(memory, base + GPIO_DIR, dir);
    writeU32(memory, base + GPIO_IDR, odr & dir);
  }
  return memory;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

/* -------------------------------------------------------------------------
 * Configuration
 * ---------------------------------------------------------------------- */

/** Resolves and validates one teaching MCU configuration. */
export function resolveTeachingMCUConfig(
  config: TeachingMCUConfig = {},
): ResolvedTeachingMCUConfig {
  if (config === null || typeof config !== 'object') {
    throw new TeachingMCUError('invalid-config', 'TeachingMCUConfig must be an object');
  }
  const isa = config.isa ?? 'm3';
  if (isa !== 'm3' && isa !== 'teaching') {
    throw new TeachingMCUError(
      'invalid-config',
      `TeachingMCUConfig.isa must be "m3" or "teaching", received ${String(isa)}`,
    );
  }
  const ports = [...(config.ports ?? ['A', 'B'])].map((port) => port.toUpperCase());
  if (ports.length === 0) {
    throw new TeachingMCUError('invalid-config', 'TeachingMCUConfig.ports must not be empty');
  }
  for (const port of ports) {
    if (!/^[A-Z]$/.test(port)) {
      throw new TeachingMCUError(
        'invalid-config',
        `TeachingMCUConfig.ports entries must be single letters, received ${JSON.stringify(port)}`,
      );
    }
  }
  if (new Set(ports).size !== ports.length) {
    throw new TeachingMCUError('invalid-config', 'TeachingMCUConfig.ports must be unique');
  }
  const portWidth = config.portWidth ?? 16;
  if (!Number.isInteger(portWidth) || portWidth < 1 || portWidth > 32) {
    throw new TeachingMCUError(
      'invalid-config',
      `TeachingMCUConfig.portWidth must be an integer in [1, 32], received ${String(portWidth)}`,
    );
  }
  const flashSize = config.flashSize ?? 64 * 1024;
  const ramSize = config.ramSize ?? 32 * 1024;
  for (const [name, value] of [
    ['flashSize', flashSize],
    ['ramSize', ramSize],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0 || value > 0x0100_0000) {
      throw new TeachingMCUError(
        'invalid-config',
        `TeachingMCUConfig.${name} must be an integer in [1, 16 MiB], received ${String(value)}`,
      );
    }
  }
  const firmware = toBytes(
    config.firmware ??
      (isa === 'teaching' ? Uint8Array.from(INITIAL_TEACHING_FIRMWARE) : new Uint8Array(4)),
  );
  if (firmware.byteLength > flashSize) {
    throw new TeachingMCUError(
      'invalid-config',
      `TeachingMCUConfig.firmware is ${firmware.byteLength} bytes, larger than flashSize ${flashSize}`,
    );
  }
  const ramInitial = toBytes(config.ramInitial ?? new Uint8Array(0));
  if (ramInitial.byteLength > ramSize) {
    throw new TeachingMCUError(
      'invalid-config',
      `TeachingMCUConfig.ramInitial is ${ramInitial.byteLength} bytes, larger than ramSize ${ramSize}`,
    );
  }
  const sp = config.sp ?? RAM_BASE + ramSize;
  const registers = new Array<number>(REGISTER_COUNT).fill(0);
  registers[13] = sp;
  registers[15] = RAM_BASE;
  if (config.registers !== undefined) {
    if (config.registers.length > REGISTER_COUNT) {
      throw new TeachingMCUError(
        'invalid-config',
        `TeachingMCUConfig.registers may hold at most ${REGISTER_COUNT} entries`,
      );
    }
    for (const [index, value] of config.registers.entries()) {
      registers[index] = value >>> 0;
    }
  }
  if (config.sp !== undefined) registers[13] = sp >>> 0;
  const pc = config.pc ?? 0;
  if (!Number.isInteger(pc) || pc < 0 || pc > 0xffff_ffff) {
    throw new TeachingMCUError(
      'invalid-config',
      `TeachingMCUConfig.pc must be a u32, received ${String(pc)}`,
    );
  }
  const vectorBase = config.vectorBase ?? 0;
  if (!Number.isInteger(vectorBase) || vectorBase < 0 || vectorBase > 0xffff_ffff) {
    throw new TeachingMCUError(
      'invalid-config',
      `TeachingMCUConfig.vectorBase must be a u32, received ${String(vectorBase)}`,
    );
  }
  const instructionsPerTick = config.instructionsPerTick ?? 1;
  if (
    !Number.isInteger(instructionsPerTick) ||
    instructionsPerTick < 1 ||
    instructionsPerTick > 0xffff_ffff
  ) {
    throw new TeachingMCUError(
      'invalid-config',
      `TeachingMCUConfig.instructionsPerTick must be a positive u32, received ${String(instructionsPerTick)}`,
    );
  }
  const maxBlockInstructions =
    config.maxBlockInstructions ?? Math.min(Math.max(instructionsPerTick, 1), 64);
  if (
    !Number.isInteger(maxBlockInstructions) ||
    maxBlockInstructions < 1 ||
    maxBlockInstructions > 4096
  ) {
    throw new TeachingMCUError(
      'invalid-config',
      `TeachingMCUConfig.maxBlockInstructions must be an integer in [1, 4096], received ${String(maxBlockInstructions)}`,
    );
  }
  const irqCount = config.irqCount ?? 32;
  if (!Number.isInteger(irqCount) || irqCount < 1 || irqCount > 32) {
    throw new TeachingMCUError(
      'invalid-config',
      `TeachingMCUConfig.irqCount must be an integer in [1, 32], received ${String(irqCount)}`,
    );
  }
  const interrupts = [...(config.interrupts ?? [])];
  const normalizedInterrupts: TeachingMCUInterruptConfig[] = [];
  for (const interrupt of interrupts) {
    if (!Number.isInteger(interrupt.irq) || interrupt.irq < 0 || interrupt.irq >= irqCount) {
      throw new TeachingMCUError(
        'invalid-config',
        `Interrupt IRQ must be in [0, ${irqCount - 1}], received ${String(interrupt.irq)}`,
      );
    }
    const portIndex = ports.findIndex((port) => port === interrupt.port.toUpperCase());
    if (portIndex < 0) {
      throw new TeachingMCUError(
        'invalid-config',
        `Interrupt port ${JSON.stringify(interrupt.port)} is not one of [${ports.join(', ')}]`,
      );
    }
    if (!Number.isInteger(interrupt.bit) || interrupt.bit < 0 || interrupt.bit >= portWidth) {
      throw new TeachingMCUError(
        'invalid-config',
        `Interrupt bit must be in [0, ${portWidth - 1}], received ${String(interrupt.bit)}`,
      );
    }
    normalizedInterrupts.push(Object.freeze({ ...interrupt, port: ports[portIndex] as string }));
  }
  const initialDirections: Record<string, number> = {};
  const initialOutputs: Record<string, number> = {};
  for (const port of ports) {
    const directionKey = Object.keys(config.initialDirections ?? {}).find(
      (key) => key.toUpperCase() === port,
    );
    initialDirections[port] =
      directionKey === undefined
        ? isa === 'teaching' && port === 'A'
          ? 1
          : 0
        : (config.initialDirections?.[directionKey] ?? 0) >>> 0;
    const outputKey = Object.keys(config.initialOutputs ?? {}).find(
      (key) => key.toUpperCase() === port,
    );
    initialOutputs[port] =
      outputKey === undefined ? 0 : (config.initialOutputs?.[outputKey] ?? 0) >>> 0;
  }
  const exceptionCycles = config.exceptionCycles ?? 12;
  if (!Number.isInteger(exceptionCycles) || exceptionCycles < 0) {
    throw new TeachingMCUError(
      'invalid-config',
      'TeachingMCUConfig.exceptionCycles must be a non-negative integer',
    );
  }
  return Object.freeze({
    isa,
    ports: Object.freeze(ports),
    portWidth,
    flashSize,
    ramSize,
    firmware,
    ramInitial,
    registers: Object.freeze(registers),
    pc,
    sp,
    vectorBase,
    instructionsPerTick,
    maxBlockInstructions,
    irqCount,
    interrupts: Object.freeze(normalizedInterrupts),
    initialOutputs: Object.freeze(initialOutputs),
    initialDirections: Object.freeze(initialDirections),
    exceptionCycles,
  });
}

function toBytes(value: Uint8Array | readonly number[]): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  return Uint8Array.from(value, (entry) => entry & 0xff);
}

/* -------------------------------------------------------------------------
 * Public factory
 * ---------------------------------------------------------------------- */

/**
 * Creates the unified-IR teaching MCU.
 *
 * ```ts
 * const mcu = createTeachingMCUIR('mcu', { firmware });
 * const circuit = await Circuit.create({
 *   devices: [mcu.device],
 *   connections: [{ from: 'mcu.PA0', to: 'led1.anode' }],
 * });
 * circuit.devices.mcu.getPC();
 * ```
 *
 * The standalone `module` runs without a circuit, which makes instruction
 * parity and throughput measurements independent from the electrical solve.
 */
export function createTeachingMCUIR(id: string, config: TeachingMCUConfig = {}): IRDevice {
  if (typeof id !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) {
    throw new TeachingMCUError(
      'invalid-config',
      `Teaching MCU id must be an identifier, received ${JSON.stringify(id)}`,
      { deviceId: id },
    );
  }
  const resolved = resolveTeachingMCUConfig(config);
  const module = createIRModule();
  const generated = generateKernel({ module, deviceId: id, config: resolved });
  const validation = createModuleValidation(module, [generated.layout.flash]);
  registerTeachingMCULayout(id, generated.layout);

  const holder: { layout: TeachingMCULayout | undefined } = { layout: undefined };
  const description = createTeachingMCUDescription(id, resolved, holder);
  const device: DeviceConfig = Object.freeze({
    id,
    type: TEACHING_MCU_IR_TYPE,
    description,
    config: resolved as unknown as Readonly<Record<string, unknown>>,
  });

  return Object.freeze({
    id,
    type: TEACHING_MCU_IR_TYPE,
    config: resolved,
    module,
    layout: generated.layout,
    device,
    validation,
    buildAccessor(
      storage: StorageAccessor,
      options: TeachingMCUAccessorOptions = {},
    ): TeachingMCUAccessor {
      return buildAccessor(id, storage, generated.layout, options);
    },
  });
}

/** Builds the device description used by `Circuit.create`. */
export function createTeachingMCUDescription(
  id: string,
  config: TeachingMCUConfig = {},
  holder: { layout: TeachingMCULayout | undefined } = { layout: undefined },
): DeviceDescription {
  const resolved = resolveTeachingMCUConfig(config);
  const pins: Record<string, { readonly direction: 'bidirectional' }> = {};
  for (const port of resolved.ports) {
    for (let bit = 0; bit < resolved.portWidth; bit += 1) {
      pins[`P${port}${bit}`] = Object.freeze({ direction: 'bidirectional' as const });
    }
  }
  const updateResources: BytesRef[] = [];
  let generated: GeneratedKernel | undefined;
  const description: DeviceDescription = {
    name: 'teaching-mcu',
    pins: Object.freeze(pins),
    updateResources,
    kernel: (context) => {
      generated = generateKernel({
        module: context.module,
        deviceId: context.deviceId,
        config: resolved,
        pinMemory: context.memory,
        pinIds: new Map(context.pins.map((pin) => [pin.name, pin.globalPinId])),
      });
      holder.layout = generated.layout;
      updateResources.push(generated.layout.flash);
      return generated.entries;
    },
    accessor: (context: DeviceAccessorFactoryContext) => {
      const layout = holder.layout;
      if (layout === undefined) {
        throw new TeachingMCUError(
          'layout-not-found',
          `Teaching MCU "${id}" has no generated layout; compile the circuit before building its accessor`,
          { deviceId: id },
        );
      }
      return buildAccessor(id, context.storage as StorageAccessor, layout, {
        assertActive: context.assertActive,
        step: context.step,
        runBatch: context.runBatch,
      });
    },
  };
  return Object.freeze(description);
}

/** One-device compilation input of {@link createTeachingMCUCircuit}. */
export interface TeachingMCUCircuitInput<Id extends string> {
  readonly devices: readonly [
    {
      readonly id: Id;
      readonly type: typeof TEACHING_MCU_IR_TYPE;
      readonly description: DeviceDescription;
    },
  ];
  readonly connections: readonly [];
}

/** Creates a one-device circuit whose accessor is the typed MCU surface. */
export async function createTeachingMCUCircuit<const Id extends string>(
  id: Id,
  config: TeachingMCUConfig = {},
  options?: CircuitRuntimeOptions,
): Promise<Circuit<TeachingMCUCircuitInput<Id>>> {
  const mcu = createTeachingMCUIR(id, config);
  const input: TeachingMCUCircuitInput<Id> = {
    devices: [
      {
        id,
        type: TEACHING_MCU_IR_TYPE,
        description: mcu.device.description,
      },
    ],
    connections: [],
  };
  return Circuit.create(input, options);
}
