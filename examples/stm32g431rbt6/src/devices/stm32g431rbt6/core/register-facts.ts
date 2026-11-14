import type { JitTranslateInput } from '@mica-js/sdk/device';
import { decode } from './decode';
import type { KnownRegs } from './decode';
import { FLASH_BASE } from './layout';

interface CodeBytes {
  readonly byteLength: number;
  readonly [index: number]: number | undefined;
}

const CODE_WINDOW = 0x20000;

const emptyRegs = (): KnownRegs => Array<number | undefined>(16).fill(undefined);

const halfAt = (code: CodeBytes, offset: number): number =>
  (code[offset & (CODE_WINDOW - 1)] ?? 0) | ((code[(offset + 1) & (CODE_WINDOW - 1)] ?? 0) << 8);

const wordAt = (code: CodeBytes, offset: number): number =>
  (halfAt(code, offset) | (halfAt(code, offset + 2) << 16)) >>> 0;

const signed = (value: number, bits: number): number => (value << (32 - bits)) >> (32 - bits);

const normalize = (address: number): number => (address >>> 0) & (CODE_WINDOW - 1);

const inside = (address: number, firmwareLength: number): boolean =>
  normalize(address) + 2 <= firmwareLength;

/** Direct branch target and whether execution falls through after the branch. */
function branchTarget16(
  instr: number,
  pc: number,
): { target: number; conditional: boolean } | undefined {
  if ((instr & 0xf000) === 0xd000) {
    const condition = (instr >> 8) & 0xf;

    if (condition >= 14) return undefined;

    return { target: (pc + 4 + signed(instr & 0xff, 8) * 2) >>> 0, conditional: true };
  }

  if ((instr & 0xf800) === 0xe000)
    return { target: (pc + 4 + signed(instr & 0x7ff, 11) * 2) >>> 0, conditional: false };

  if ((instr & 0xf500) === 0xb100) {
    const offset = (((instr >> 9) & 1) << 6) | ((instr >> 3) & 0x1f);

    return { target: (pc + 4 + offset * 2) >>> 0, conditional: true };
  }

  return undefined;
}

/** Direct Thumb-2 branch targets, including BL/BLX calls. */
function branchTarget32(
  h1: number,
  h2: number,
  pc: number,
): { target: number; kind: 'call' | 'conditional' | 'jump' } | undefined {
  if ((h1 & 0xf800) !== 0xf000) return undefined;

  const s = (h1 >> 10) & 1;
  const j1 = (h2 >> 13) & 1;
  const j2 = (h2 >> 11) & 1;
  const i1 = 1 - (j1 ^ s);
  const i2 = 1 - (j2 ^ s);
  const imm10 = h1 & 0x3ff;
  const imm11 = h2 & 0x7ff;

  if ((h2 & 0xd000) === 0xd000) {
    const imm = signed((s << 24) | (i1 << 23) | (i2 << 22) | (imm10 << 12) | (imm11 << 1), 25);

    return { target: (pc + 4 + imm) >>> 0, kind: 'call' };
  }

  if ((h2 & 0xd000) === 0xc000) {
    const imm10l = h2 & 0x7fe;
    const imm = signed((s << 24) | (i1 << 23) | (i2 << 22) | (imm10 << 12) | (imm10l << 1), 25);

    return { target: (((pc + 4) & ~3) + imm) >>> 0, kind: 'call' };
  }

  if ((h2 & 0xd000) === 0x9000) {
    const imm = signed((s << 24) | (i1 << 23) | (i2 << 22) | (imm10 << 12) | (imm11 << 1), 25);

    return { target: (pc + 4 + imm) >>> 0, kind: 'jump' };
  }

  if ((h2 & 0xd000) === 0x8000) {
    const imm6 = h1 & 0x3f;
    const imm = signed((s << 20) | (j2 << 19) | (j1 << 18) | (imm6 << 12) | (imm11 << 1), 21);

    return { target: (pc + 4 + imm) >>> 0, kind: 'conditional' };
  }

  return undefined;
}

interface Flow {
  readonly target?: number;
  readonly kind?: 'call' | 'conditional' | 'jump';
  readonly fallthrough: boolean;
  readonly clearsCallerSaved?: boolean;
}

function flowAt(pc: number, h1: number, h2: number, regs: KnownRegs, endsBatch: boolean): Flow {
  if (h1 >= 0xe800) {
    const branch = branchTarget32(h1, h2, pc);

    if (branch !== undefined)
      return {
        target: branch.target,
        kind: branch.kind,
        fallthrough: branch.kind !== 'jump',
        clearsCallerSaved: branch.kind === 'call',
      };

    return { fallthrough: !endsBatch };
  }

  const branch = branchTarget16(h1, pc);

  if (branch !== undefined)
    return {
      target: branch.target,
      kind: branch.conditional ? 'conditional' : 'jump',
      fallthrough: branch.conditional,
    };

  if ((h1 & 0xff87) === 0x4700 || (h1 & 0xff87) === 0x4780) {
    const target = regs[(h1 >> 3) & 0xf];
    const call = (h1 & 0x0080) !== 0;

    if (target !== undefined && (target & 1) !== 0)
      return {
        target: target & ~1,
        kind: call ? 'call' : 'jump',
        fallthrough: call,
        clearsCallerSaved: call,
      };

    return { fallthrough: false };
  }

  // `writesPc16` is intentionally conservative for batching. Here only true control-flow
  // writes end a linear block; prologue pushes and pop-without-pc continue normally.
  if ((h1 & 0xfc00) === 0x4400) {
    const rd = (h1 & 7) | ((h1 >> 4) & 8);

    return { fallthrough: rd !== 15 };
  }
  if ((h1 & 0xfe00) === 0xb400) return { fallthrough: true };
  if ((h1 & 0xfe00) === 0xbc00) return { fallthrough: (h1 & 0x0100) === 0 };
  if ((h1 & 0xf000) === 0xc000) return { fallthrough: (h1 & 0x0800) === 0 || (h1 & 0x0100) === 0 };
  if (h1 >= 0xb000 && h1 < 0xc000) return { fallthrough: true };

  return { fallthrough: !endsBatch };
}

const clobberCallerSaved = (regs: KnownRegs): void => {
  for (const register of [0, 1, 2, 3, 12, 14]) regs[register] = undefined;
};

/**
 * Discover function entries reachable from the vector table and direct call sites.
 *
 * This deliberately follows only statically decodable branches. Register-dependent calls are
 * followed when the preceding block loaded a Thumb code pointer; an unresolved indirect call
 * simply ends that path instead of guessing a target.
 */
function discoverFunctions(
  code: CodeBytes,
  firmwareLength: number,
  decodeAt: (pc: number, regs: KnownRegs) => ReturnType<typeof decode>,
): readonly number[] {
  const functions = new Map<number, true>();
  const pending: number[] = [];
  const addFunction = (address: number): void => {
    const pc = normalize(address);

    if (!inside(pc, firmwareLength) || functions.has(pc)) return;
    functions.set(pc, true);
    pending.push(pc);
  };

  const reset = wordAt(code, 4);

  if ((reset & 1) !== 0) addFunction(reset & ~1);

  while (pending.length > 0) {
    const start = pending.pop()!;
    const blocks: Array<{ readonly pc: number; readonly regs: KnownRegs }> = [
      { pc: start, regs: emptyRegs() },
    ];
    const visited = new Set<number>();

    while (blocks.length > 0) {
      const block = blocks.pop()!;

      if (visited.has(block.pc)) continue;
      visited.add(block.pc);
      let cursor = block.pc;
      const regs = block.regs;

      while (inside(cursor, firmwareLength)) {
        const h1 = halfAt(code, cursor);
        const h2 = h1 >= 0xe800 ? halfAt(code, cursor + 2) : 0;
        const snapshot = regs.slice();
        const decoded = decodeAt(cursor, regs);
        const flow = flowAt(cursor, h1, h2, snapshot, decoded.endsBatch);

        if (flow.target !== undefined) {
          if (flow.kind === 'call') addFunction(flow.target);
          else blocks.push({ pc: normalize(flow.target), regs: regs.slice() });
        }
        if (!flow.fallthrough) break;
        if (decoded.itCount > 0) break;
        if (flow.clearsCallerSaved === true) clobberCallerSaved(regs);
        cursor = (cursor + decoded.size) >>> 0;
      }
    }
  }

  return [...functions.keys()].sort((left, right) => left - right);
}

function mergeFacts(target: KnownRegs, source: KnownRegs): void {
  for (let register = 0; register < 16; register += 1)
    if (target[register] !== source[register]) target[register] = undefined;
}

export interface RegisterFacts {
  /** Linear-path constants at `pc`, or `undefined` when the entry is not proven. */
  at(pc: number): KnownRegs | undefined;
}

const cachedFacts = new WeakMap<object, Map<number, RegisterFacts>>();

/**
 * Build entry-register facts for the straight-line prefix of every discovered function.
 *
 * Service blocks resume in the middle of a function after a side-effecting instruction. A fresh
 * translation at that PC otherwise loses constants such as literals loaded by an earlier block.
 * Restricting the analysis to a function's linear prefix keeps the result path-independent: the
 * scan stops at every branch, call, return or IT boundary.
 */
export function createRegisterFacts(code: CodeBytes, firmwareLength: number): RegisterFacts {
  let byLength = cachedFacts.get(code);
  const cached = byLength?.get(firmwareLength);

  if (cached !== undefined) return cached;
  const length = Math.min(firmwareLength, code.byteLength);
  const facts = new Map<number, KnownRegs>();
  const decodeAt = (pc: number, regs: KnownRegs): ReturnType<typeof decode> =>
    decode(code as JitTranslateInput['code'], (FLASH_BASE + pc) >>> 0, regs, length, false);

  const entries = length > 0 ? discoverFunctions(code, length, decodeAt) : [];

  if (length > 0) {
    for (const start of entries) {
      const regs = emptyRegs();
      let cursor = start;

      while (inside(cursor, length)) {
        const current = facts.get(cursor);

        if (current === undefined) facts.set(cursor, regs.slice());
        else mergeFacts(current, regs);

        const decoded = decodeAt(cursor, regs);
        const h1 = halfAt(code, cursor);
        const h2 = h1 >= 0xe800 ? halfAt(code, cursor + 2) : 0;
        const flow = flowAt(cursor, h1, h2, regs.slice(), decoded.endsBatch);

        if (flow.target !== undefined || !flow.fallthrough || decoded.itCount > 0) break;
        cursor = (cursor + decoded.size) >>> 0;
      }
    }
  }

  const result: RegisterFacts = {
    at(pc: number): KnownRegs | undefined {
      const found = facts.get(normalize(pc));

      return found?.some((value) => value !== undefined) === true ? found.slice() : undefined;
    },
  };

  if (byLength === undefined) {
    byLength = new Map();
    cachedFacts.set(code, byLength);
  }
  byLength.set(firmwareLength, result);

  return result;
}
