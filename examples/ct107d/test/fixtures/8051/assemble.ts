/**
 * Minimal, strict 8051 assembler for reproducible CT107D test firmware.
 *
 * Only the instructions used by `test/fixtures/8051/*.asm` are supported. Unknown
 * mnemonics, operands, labels or out-of-range values throw with the source line; nothing
 * is silently skipped or truncated.
 */

const SFR: Readonly<Record<string, number>> = {
  P0: 0x80,
  SP: 0x81,
  DPL: 0x82,
  DPH: 0x83,
  PCON: 0x87,
  AUXR: 0x8e,
  TCON: 0x88,
  TMOD: 0x89,
  TL0: 0x8a,
  TL1: 0x8b,
  TH0: 0x8c,
  TH1: 0x8d,
  P1: 0x90,
  SCON: 0x98,
  SBUF: 0x99,
  P2: 0xa0,
  IE: 0xa8,
  P3: 0xb0,
  IP: 0xb8,
  PSW: 0xd0,
  ACC: 0xe0,
  B: 0xf0,
  P1M1: 0x91,
  P1M0: 0x92,
  P0M1: 0x93,
  P0M0: 0x94,
  P2M1: 0x95,
  P2M0: 0x96,
  P3M1: 0xb1,
  P3M0: 0xb2,
};

const BIT: Readonly<Record<string, number>> = {
  IT0: 0x88,
  IE0: 0x89,
  IT1: 0x8a,
  IE1: 0x8b,
  TR0: 0x8c,
  TF0: 0x8d,
  TR1: 0x8e,
  TF1: 0x8f,
  RI: 0x98,
  TI: 0x99,
  ES: 0xac,
  EA: 0xaf,
};

/** Code space is 60 KiB (0x0000..0xEFFF). */
const CODE_LIMIT = 60 * 1024;

function parseNumber(text: string, line: number): number {
  const token = text.trim();
  let value: number;
  if (/^0x[0-9a-f]+$/i.test(token)) value = Number.parseInt(token.slice(2), 16);
  else if (/^0b[01]+$/i.test(token)) value = Number.parseInt(token.slice(2), 2);
  else if (/^0o[0-7]+$/i.test(token)) value = Number.parseInt(token.slice(2), 8);
  else if (/^[0-9a-f]+h$/i.test(token)) value = Number.parseInt(token.slice(0, -1), 16);
  else if (/^\d+$/.test(token)) value = Number.parseInt(token, 10);
  else throw new Error(`line ${line}: invalid number ${text}`);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`line ${line}: invalid number`);
  return value;
}

function parseByte(text: string, line: number): number {
  const value = parseNumber(text, line);
  if (value > 0xff) throw new Error(`line ${line}: byte value out of range ${text.trim()}`);
  return value;
}

function parseOrigin(text: string, line: number): number {
  const value = parseNumber(text, line);
  if (value >= CODE_LIMIT)
    throw new Error(`line ${line}: ORG 0x${value.toString(16)} is outside the 60 KiB code space`);
  return value;
}

function parseBit(text: string, line: number): number {
  const token = text.trim();
  const member = /^([A-Za-z_]\w*)\.(\d+)$/.exec(token);
  if (member !== null) {
    const base = SFR[member[1]!];
    if (base === undefined) throw new Error(`line ${line}: unknown bit base ${member[1]}`);
    const bit = Number(member[2]);
    if (bit > 7) throw new Error(`line ${line}: bit index ${bit}`);
    return base + bit;
  }
  const named = BIT[token];
  if (named === undefined) throw new Error(`line ${line}: unknown bit ${token}`);
  return named;
}

function directForm(text: string, line: number): 'sfr' | 'label' | 'number' {
  const token = text.trim();
  if (token.length === 0) throw new Error(`line ${line}: missing direct operand`);
  if (/^(A|C)$/i.test(token)) throw new Error(`line ${line}: ${token} is not a direct operand`);
  if (SFR[token] !== undefined) return 'sfr';
  if (/^[A-Za-z_]\w*$/.test(token)) return 'label';
  parseByte(token, line);
  return 'number';
}

function parseDirect(text: string, labels: ReadonlyMap<string, number>, line: number): number {
  const form = directForm(text, line);
  const token = text.trim();
  if (form === 'sfr') return SFR[token]!;
  if (form === 'label') {
    const label = labels.get(token);
    if (label === undefined) throw new Error(`line ${line}: unknown symbol ${token}`);
    if (label > 0xff) throw new Error(`line ${line}: direct address ${token} is too large`);
    return label;
  }
  return parseByte(token, line);
}

interface Statement {
  readonly line: number;
  readonly mnemonic?: string;
  readonly operands?: string;
  readonly label?: string;
  readonly origin?: string;
}

function parse(source: string): Statement[] {
  const statements: Statement[] = [];
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = index + 1;
    const text = raw.replace(/;.*$/, '').trim();
    if (text.length === 0) continue;
    const label = /^([A-Za-z_]\w*):\s*(.*)$/.exec(text);
    if (label !== null) {
      const name = label[1];
      const rest = label[2];
      if (name === undefined || rest === undefined)
        throw new Error(`line ${line}: invalid label statement`);
      statements.push({ line, label: name });
      if (rest.length > 0) statements.push({ line, ...instructionOf(rest, line) });
      continue;
    }
    const origin = /^ORG\s+(.+)$/i.exec(text);
    if (origin !== null) {
      const value = origin[1];
      if (value === undefined) throw new Error(`line ${line}: invalid ORG statement`);
      statements.push({ line, origin: value });
      continue;
    }
    statements.push({ line, ...instructionOf(text, line) });
  }
  return statements;
}

function instructionOf(text: string, line: number): { mnemonic: string; operands: string } {
  const match = /^([A-Za-z]+)\s*(.*)$/.exec(text);
  if (match === null) throw new Error(`line ${line}: invalid statement ${text}`);
  return { mnemonic: match[1]!.toUpperCase(), operands: match[2]!.trim() };
}

function splitOperands(operands: string, count: number, line: number): string[] {
  const parts = operands.split(',').map((part) => part.trim());
  if (parts.length !== count) throw new Error(`line ${line}: expected ${count} operands`);
  return parts;
}

function isRegister(text: string): boolean {
  return /^R[0-7]$/i.test(text.trim());
}

function registerNumber(text: string, line: number): number {
  const match = /^R([0-7])$/i.exec(text.trim());
  if (match === null) throw new Error(`line ${line}: invalid register ${text}`);
  return Number(match[1]);
}

function requireNoOperands(mnemonic: string, operands: string, line: number): void {
  if (operands.trim().length !== 0)
    throw new Error(`line ${line}: ${mnemonic} does not take operands`);
}

function requireAccumulator(mnemonic: string, operands: string, line: number): void {
  if (operands.trim().toUpperCase() !== 'A')
    throw new Error(`line ${line}: ${mnemonic} requires the A operand`);
}

function parseLabelOperand(text: string, line: number): string {
  const token = text.trim();
  if (!/^[A-Za-z_]\w*$/.test(token)) throw new Error(`line ${line}: expected label, got ${text}`);
  return token;
}

function sizeOf(mnemonic: string, operands: string, line: number): number {
  switch (mnemonic) {
    case 'NOP':
    case 'RET':
      requireNoOperands(mnemonic, operands, line);
      return 1;
    case 'SJMP':
    case 'JC':
    case 'JNC':
    case 'JZ':
    case 'JNZ':
      parseLabelOperand(operands, line);
      return 2;
    case 'LJMP':
      parseLabelOperand(operands, line);
      return 3;
    case 'ACALL':
      parseLabelOperand(operands, line);
      return 2;
    case 'JNB':
    case 'JB': {
      const [bit, target] = splitOperands(operands, 2, line);
      parseBit(bit!, line);
      parseLabelOperand(target!, line);
      return 3;
    }
    case 'DJNZ': {
      const [target, destination] = splitOperands(operands, 2, line);
      parseLabelOperand(destination!, line);
      if (isRegister(target!)) {
        registerNumber(target!, line);
        return 2;
      }
      directForm(target!, line);
      return 3;
    }
    case 'SETB':
      if (operands.trim().toUpperCase() === 'A')
        throw new Error(`line ${line}: SETB does not accept A`);
      parseBit(operands, line);
      return 2;
    case 'CLR':
    case 'CPL':
      if (operands.trim().toUpperCase() === 'A') return 1;
      parseBit(operands, line);
      return 2;
    case 'RLC':
    case 'RRC':
    case 'RL':
    case 'RR':
    case 'SWAP':
      requireAccumulator(mnemonic, operands, line);
      return 1;
    case 'INC':
    case 'DEC':
      if (isRegister(operands)) {
        registerNumber(operands, line);
        return 1;
      }
      directForm(operands, line);
      return 2;
    case 'ANL':
    case 'ORL':
    case 'XRL': {
      const [target, source] = splitOperands(operands, 2, line);
      if (!source!.startsWith('#')) throw new Error(`line ${line}: expected #immediate`);
      parseByte(source!.slice(1), line);
      if (target!.toUpperCase() === 'A') return 2;
      directForm(target!, line);
      return 3;
    }
    case 'MOV': {
      const [target, source] = splitOperands(operands, 2, line);
      const targetText = target!.toUpperCase();
      const sourceText = source!.toUpperCase();
      if (targetText === 'A') {
        if (sourceText === 'C') throw new Error(`line ${line}: unsupported MOV A,C`);
        if (source!.startsWith('#')) {
          parseByte(source!.slice(1), line);
          return 2;
        }
        if (isRegister(source!)) {
          registerNumber(source!, line);
          return 1;
        }
        directForm(source!, line);
        return 2;
      }
      if (targetText === 'C') {
        parseBit(source!, line);
        return 2;
      }
      if (parseBitTarget(target!)) {
        if (sourceText !== 'C') throw new Error(`line ${line}: unsupported MOV ${operands}`);
        parseBit(target!, line);
        return 2;
      }
      if (sourceText === 'A') {
        if (isRegister(target!)) {
          registerNumber(target!, line);
          return 1;
        }
        directForm(target!, line);
        return 2;
      }
      if (source!.startsWith('#')) {
        parseByte(source!.slice(1), line);
        if (isRegister(target!)) {
          registerNumber(target!, line);
          return 2;
        }
        directForm(target!, line);
        return 3;
      }
      if (isRegister(source!)) {
        registerNumber(source!, line);
        directForm(target!, line);
        return 2;
      }
      throw new Error(`line ${line}: unsupported MOV ${operands}`);
    }
    default:
      throw new Error(`line ${line}: unsupported mnemonic ${mnemonic}`);
  }
}

function absolute(target: number, line: number): [number, number] {
  if (target < 0 || target > 0xffff) throw new Error(`line ${line}: address out of range`);
  return [(target >> 8) & 0xff, target & 0xff];
}

function relative(target: number, pc: number, size: number, line: number): number {
  const offset = target - (pc + size);
  if (offset < -128 || offset > 127) throw new Error(`line ${line}: relative branch out of range`);
  return offset & 0xff;
}

function labelValue(text: string, labels: ReadonlyMap<string, number>, line: number): number {
  const value = labels.get(parseLabelOperand(text, line));
  if (value === undefined) throw new Error(`line ${line}: unknown label ${text}`);
  return value;
}

function encode(
  mnemonic: string,
  operands: string,
  labels: ReadonlyMap<string, number>,
  pc: number,
  line: number,
): number[] {
  switch (mnemonic) {
    case 'NOP':
      requireNoOperands(mnemonic, operands, line);
      return [0x00];
    case 'RET':
      requireNoOperands(mnemonic, operands, line);
      return [0x22];
    case 'SJMP':
      return [0x80, relative(labelValue(operands, labels, line), pc, 2, line)];
    case 'LJMP':
      return [0x02, ...absolute(labelValue(operands, labels, line), line)];
    case 'ACALL': {
      const target = labelValue(operands, labels, line);
      if ((target & 0xf800) !== ((pc + 2) & 0xf800))
        throw new Error(
          `line ${line}: ACALL target 0x${target.toString(16)} is on a different 2 KiB page`,
        );
      return [0x11 | ((target >> 3) & 0xe0), target & 0xff];
    }
    case 'JC':
    case 'JNC':
    case 'JZ':
    case 'JNZ': {
      const opcode = { JC: 0x40, JNC: 0x50, JZ: 0x60, JNZ: 0x70 }[mnemonic]!;
      return [opcode, relative(labelValue(operands, labels, line), pc, 2, line)];
    }
    case 'JNB':
    case 'JB': {
      const [bit, target] = splitOperands(operands, 2, line);
      return [
        mnemonic === 'JNB' ? 0x30 : 0x20,
        parseBit(bit!, line),
        relative(labelValue(target!, labels, line), pc, 3, line),
      ];
    }
    case 'DJNZ': {
      const [target, destination] = splitOperands(operands, 2, line);
      if (isRegister(target!))
        return [
          0xd8 + registerNumber(target!, line),
          relative(labelValue(destination!, labels, line), pc, 2, line),
        ];
      return [
        0xd5,
        parseDirect(target!, labels, line),
        relative(labelValue(destination!, labels, line), pc, 3, line),
      ];
    }
    case 'SETB':
    case 'CLR':
    case 'CPL':
      if (operands.trim().toUpperCase() === 'A') {
        if (mnemonic === 'SETB') throw new Error(`line ${line}: SETB does not accept A`);
        return [mnemonic === 'CLR' ? 0xe4 : 0xf4];
      }
      return [{ SETB: 0xd2, CLR: 0xc2, CPL: 0xb2 }[mnemonic]!, parseBit(operands, line)];
    case 'RLC':
      requireAccumulator(mnemonic, operands, line);
      return [0x33];
    case 'RRC':
      requireAccumulator(mnemonic, operands, line);
      return [0x13];
    case 'RL':
      requireAccumulator(mnemonic, operands, line);
      return [0x23];
    case 'RR':
      requireAccumulator(mnemonic, operands, line);
      return [0x03];
    case 'SWAP':
      requireAccumulator(mnemonic, operands, line);
      return [0xc4];
    case 'INC':
    case 'DEC':
      return isRegister(operands)
        ? [{ INC: 0x08, DEC: 0x18 }[mnemonic]! + registerNumber(operands, line)]
        : [{ INC: 0x05, DEC: 0x15 }[mnemonic]!, parseDirect(operands, labels, line)];
    case 'ANL':
    case 'ORL':
    case 'XRL': {
      const [target, source] = splitOperands(operands, 2, line);
      if (!source!.startsWith('#')) throw new Error(`line ${line}: expected #immediate`);
      const immediate = parseByte(source!.slice(1), line);
      if (target!.toUpperCase() === 'A')
        return [{ ANL: 0x54, ORL: 0x44, XRL: 0x64 }[mnemonic]!, immediate];
      return [
        { ANL: 0x53, ORL: 0x43, XRL: 0x63 }[mnemonic]!,
        parseDirect(target!, labels, line),
        immediate,
      ];
    }
    case 'MOV': {
      const [target, source] = splitOperands(operands, 2, line);
      const targetText = target!.toUpperCase();
      const sourceText = source!.toUpperCase();
      if (targetText === 'A') {
        if (sourceText === 'C') throw new Error(`line ${line}: unsupported MOV A,C`);
        if (source!.startsWith('#')) return [0x74, parseByte(source!.slice(1), line)];
        if (isRegister(source!)) return [0xe8 + registerNumber(source!, line)];
        return [0xe5, parseDirect(source!, labels, line)];
      }
      if (targetText === 'C') return [0xa2, parseBit(source!, line)];
      if (parseBitTarget(target!)) {
        if (sourceText !== 'C') throw new Error(`line ${line}: unsupported MOV ${operands}`);
        return [0x92, parseBit(target!, line)];
      }
      if (sourceText === 'A') {
        if (isRegister(target!)) return [0xf8 + registerNumber(target!, line)];
        return [0xf5, parseDirect(target!, labels, line)];
      }
      if (source!.startsWith('#')) {
        const immediate = parseByte(source!.slice(1), line);
        if (isRegister(target!)) return [0x78 + registerNumber(target!, line), immediate];
        return [0x75, parseDirect(target!, labels, line), immediate];
      }
      if (isRegister(source!))
        return [0x88 + registerNumber(source!, line), parseDirect(target!, labels, line)];
      throw new Error(`line ${line}: unsupported MOV ${operands}`);
    }
    default:
      throw new Error(`line ${line}: unsupported mnemonic ${mnemonic}`);
  }
}

function parseBitTarget(text: string): boolean {
  return /^[A-Za-z_]\w*\.\d+$/.test(text) || Object.hasOwn(BIT, text);
}

export function assemble(source: string): Uint8Array {
  const statements = parse(source);
  const labels = new Map<string, number>();
  let pc = 0;
  for (const statement of statements) {
    if (statement.label !== undefined) {
      if (labels.has(statement.label)) throw new Error(`line ${statement.line}: duplicate label`);
      labels.set(statement.label, pc);
      continue;
    }
    if (statement.origin !== undefined) {
      pc = parseOrigin(statement.origin, statement.line);
      continue;
    }
    const size = sizeOf(statement.mnemonic!, statement.operands!, statement.line);
    if (pc + size > CODE_LIMIT)
      throw new Error(`line ${statement.line}: instruction exceeds the 60 KiB code space`);
    pc += size;
  }

  const output: number[] = [];
  const used = new Uint8Array(CODE_LIMIT);
  let cursor = 0;
  for (const statement of statements) {
    if (statement.label !== undefined) continue;
    if (statement.origin !== undefined) {
      cursor = parseOrigin(statement.origin, statement.line);
      continue;
    }
    const bytes = encode(statement.mnemonic!, statement.operands!, labels, cursor, statement.line);
    const expected = sizeOf(statement.mnemonic!, statement.operands!, statement.line);
    if (bytes.length !== expected)
      throw new Error(`line ${statement.line}: internal size mismatch for ${statement.mnemonic}`);
    if (cursor + bytes.length > CODE_LIMIT)
      throw new Error(`line ${statement.line}: write exceeds the 60 KiB code space`);
    while (output.length < cursor) output.push(0);
    for (const [index, value] of bytes.entries()) {
      const address = cursor + index;
      if (used[address] === 1)
        throw new Error(
          `line ${statement.line}: ORG/write overlaps emitted code at 0x${address.toString(16)}`,
        );
      used[address] = 1;
      output[address] = value;
    }
    cursor += bytes.length;
  }
  while (output.length < cursor) output.push(0);
  return Uint8Array.from(output, (value) => value ?? 0);
}
