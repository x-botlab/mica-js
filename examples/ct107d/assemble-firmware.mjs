/**
 * 极简 8051 汇编器：只实现 `firmware/demo.asm` 用到的助记符，两遍扫描解析标号。
 *
 * 支持的指令（大小写不敏感）：
 * - `ORG addr`、`label:`
 * - `NOP`、`RET`、`RL A`
 * - `LJMP label`、`SJMP label`、`ACALL label`
 * - `MOV A, Rn`、`MOV Rn, A`、`MOV Rn, #imm`、`MOV direct, #imm`、`MOV direct, Rn`
 * - `DJNZ Rn, label`
 *
 * 操作数里可以直接写 SFR 名字（`P0`、`P2`、`P0M0` …）或数值；数值支持 `0x7F`、
 * `7FH`、`127` 三种写法。解析失败一律抛错，不做静默猜测。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(PROJECT, 'firmware', 'demo.asm');
const OUTPUT = join(PROJECT, 'assets', 'ct107d-demo.bin');

const DIRECT = {
  P0: 0x80,
  SP: 0x81,
  DPL: 0x82,
  DPH: 0x83,
  PSW: 0x88,
  ACC: 0xe0,
  B: 0xf0,
  P0M1: 0x93,
  P0M0: 0x94,
  P1M1: 0x91,
  P1M0: 0x92,
  P2M1: 0x95,
  P2M0: 0x96,
  P3M1: 0xb1,
  P3M0: 0xb2,
  P2: 0xa0,
  P3: 0xb0,
  P1: 0x90,
};

function parseValue(text, labels) {
  const token = text.trim();
  if (token.length === 0) throw new Error('缺少操作数');
  const known = DIRECT[token.toUpperCase()];
  if (known !== undefined) return known;
  const label = labels.get(token);
  if (label !== undefined) return label;
  if (/^[0-9a-f]+h$/i.test(token)) return Number.parseInt(token.slice(0, -1), 16);
  if (/^0x[0-9a-f]+$/i.test(token)) return Number.parseInt(token.slice(2), 16);
  if (/^-?\d+$/.test(token)) return Number.parseInt(token, 10);
  throw new Error(`无法解析的操作数 ${token}`);
}

function registerIndex(text) {
  const match = /^R([0-7])$/i.exec(text.trim());
  if (match === null) throw new Error(`不是寄存器 ${text}`);
  return Number(match[1]);
}

/** 指令长度，只依赖助记符与操作数形状，第一遍扫描用它推进地址。 */
function lengthOf(mnemonic, operands) {
  switch (mnemonic) {
    case 'NOP':
    case 'RET':
    case 'RL':
      return 1;
    case 'LJMP':
      return 3;
    case 'SJMP':
    case 'ACALL':
    case 'DJNZ':
      return 2;
    case 'MOV': {
      const [first, second] = splitOperands(operands, 2);
      if (/^A$/i.test(first.trim())) return 1;
      if (second.trim().startsWith('#')) return /^R[0-7]$/i.test(first.trim()) ? 2 : 3;
      if (/^A$/i.test(second.trim())) return 1;
      return 2;
    }
    default:
      throw new Error(`不支持的助记符 ${mnemonic}`);
  }
}

/** 解析一行，返回字节数组（标号地址用 `labels` 解析）。 */
function encode(mnemonic, operands, labels, pc) {
  switch (mnemonic) {
    case 'NOP':
      return [0x00];
    case 'RET':
      return [0x22];
    case 'RL':
      if (operands.trim().toUpperCase() !== 'A') throw new Error('RL 只支持 A');
      return [0x23];
    case 'LJMP':
      return [0x02, ...absolute(parseValue(operands, labels))];
    case 'SJMP':
      return [0x80, ...relative(parseValue(operands, labels), pc, 2)];
    case 'ACALL': {
      const target = parseValue(operands, labels);
      return [0x11 | ((target >> 3) & 0xe0), target & 0xff];
    }
    case 'DJNZ': {
      const [name, target] = splitOperands(operands, 2);
      const register = registerIndex(name);
      return [0xd8 + register, ...relative(parseValue(target, labels), pc, 2)];
    }
    case 'MOV':
      return encodeMov(splitOperands(operands, 2), labels);
    default:
      throw new Error(`不支持的助记符 ${mnemonic}`);
  }
}

/** 两个字节的目标地址。 */
function absolute(address) {
  return [(address >> 8) & 0xff, address & 0xff];
}

/** 相对跳转：偏移基于下一条指令的地址。 */
function relative(target, pc, length) {
  const offset = target - (pc + length);
  if (offset < -128 || offset > 127) throw new Error(`跳转超出范围：${offset}`);
  return [offset & 0xff];
}

function splitOperands(text, count) {
  const parts = text.split(',').map((part) => part.trim());
  if (parts.length !== count) throw new Error(`操作数个数不是 ${count}：${text}`);
  return parts;
}

function encodeMov([first, second], labels) {
  const target = first.trim();
  const source = second.trim();
  const isAccumulator = (text) => /^A$/i.test(text);
  const isRegister = (text) => /^R[0-7]$/i.test(text);

  if (isAccumulator(target)) {
    if (!isRegister(source)) throw new Error(`不支持的 MOV A,${source}`);
    return [0xe8 + registerIndex(source)];
  }
  if (source.startsWith('#')) {
    const value = parseValue(source.slice(1), labels);
    if (isRegister(target)) return [0x78 + registerIndex(target), value & 0xff];
    return [0x75, parseValue(target, labels), value & 0xff];
  }
  if (isAccumulator(source)) {
    if (!isRegister(target)) throw new Error(`不支持的 MOV ${target},A`);
    return [0xf8 + registerIndex(target)];
  }
  if (isRegister(source)) return [0x88 + registerIndex(source), parseValue(target, labels)];
  throw new Error(`不支持的 MOV ${target},${source}`);
}

/** 把源码切成「地址, 助记符, 操作数」的中间表示。 */
function parseSource(text) {
  const statements = [];
  let origin = 0;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/;.*$/, '').trim();
    if (line.length === 0) continue;
    const label = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    if (label !== null) {
      statements.push({ kind: 'label', name: label[1], line: index + 1 });
      const rest = line.slice(label[0].length).trim();
      if (rest.length === 0) continue;
      statements.push({ kind: 'instruction', text: rest, line: index + 1 });
      continue;
    }
    const origin_match = /^ORG\s+(.+)$/i.exec(line);
    if (origin_match !== null) {
      statements.push({ kind: 'org', text: origin_match[1], line: index + 1 });
      continue;
    }
    statements.push({ kind: 'instruction', text: line, line: index + 1 });
  }
  return { statements, origin };
}

const source = readFileSync(SOURCE, 'utf8');
const { statements } = parseSource(source);

// 第一遍：确定每个标号的地址（只算长度，不解析标号值）。
const labels = new Map();
let pc = 0;
for (const statement of statements) {
  if (statement.kind === 'label') {
    labels.set(statement.name, pc);
    continue;
  }
  if (statement.kind === 'org') {
    pc = parseValue(statement.text, labels);
    continue;
  }
  const [mnemonic, ...rest] = statement.text.split(/\s+/);
  pc += lengthOf(mnemonic.toUpperCase(), rest.join(' '));
}

// 第二遍：用完整标号表重新编码，确保前向引用正确。
const output = new Uint8Array(pc);
let cursor = 0;
for (const statement of statements) {
  if (statement.kind === 'label') continue;
  if (statement.kind === 'org') {
    cursor = parseValue(statement.text, labels);
    continue;
  }
  const [mnemonic, ...rest] = statement.text.split(/\s+/);
  const bytes = encode(mnemonic.toUpperCase(), rest.join(' '), labels, cursor);
  output.set(bytes, cursor);
  cursor += bytes.length;
}

writeFileSync(OUTPUT, output);
const checksum = output.reduce((total, byte) => (total + byte) & 0xff, 0);
console.log(
  `firmware: ${output.length} 字节 → ${OUTPUT}（校验和 0x${checksum.toString(16).padStart(2, '0')}）`,
);
for (const [name, address] of labels)
  console.log(`  ${name} = 0x${address.toString(16).padStart(4, '0')}`);
