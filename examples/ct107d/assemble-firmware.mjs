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
 *
 * 固件资源只有一个来源：本文件从 `firmware/demo.asm` 得到的同一份字节，同时写出
 *
 * - `device/src/assets/ct107d-demo.bin`：正式器件包 BIN 资源；
 * - `device/src/assets/ct107d-demo.hex`：正式器件包确定性 Intel HEX 资源。
 *
 * 两份资源是同一份字节的 BIN/HEX 两种编码；运行时只从器件包加载。
 *
 * `--check` 只比较、不写文件；默认执行（`pnpm firmware`）才写资源。主 build 不隐式调用
 * 本脚本，避免静默重写用户源码。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(PROJECT, 'firmware', 'demo.asm');
const PACKAGE_BIN = join(PROJECT, 'device', 'src', 'assets', 'ct107d-demo.bin');
const PACKAGE_HEX = join(PROJECT, 'device', 'src', 'assets', 'ct107d-demo.hex');

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
    const originMatch = /^ORG\s+(.+)$/i.exec(line);
    if (originMatch !== null) {
      statements.push({ kind: 'org', text: originMatch[1], line: index + 1 });
      continue;
    }
    statements.push({ kind: 'instruction', text: line, line: index + 1 });
  }
  return { statements };
}

/**
 * Assembles one source text into a deterministic 8051 BIN image.
 *
 * @param {string} text
 * @returns {{ bytes: Uint8Array, labels: ReadonlyMap<string, number> }}
 */
export function assembleFirmware(text) {
  const { statements } = parseSource(text);

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
  const bytes = new Uint8Array(pc);
  let cursor = 0;
  for (const statement of statements) {
    if (statement.kind === 'label') continue;
    if (statement.kind === 'org') {
      cursor = parseValue(statement.text, labels);
      continue;
    }
    const [mnemonic, ...rest] = statement.text.split(/\s+/);
    const encoded = encode(mnemonic.toUpperCase(), rest.join(' '), labels, cursor);
    bytes.set(encoded, cursor);
    cursor += encoded.length;
  }
  return { bytes, labels };
}

/**
 * Encodes bytes as deterministic, strict Intel HEX: uppercase, LF records, 16 data bytes
 * per record, and exactly one EOF record. The 8051 code space is 60 KiB, so a 16-bit
 * record address is always sufficient.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function encodeIntelHex(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Intel HEX input must be a Uint8Array');
  if (bytes.length === 0) throw new RangeError('Intel HEX image must not be empty');
  if (bytes.length > 0x1_0000)
    throw new RangeError('Intel HEX image exceeds the 16-bit record address range');
  const lines = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const length = Math.min(16, bytes.length - offset);
    const record = Buffer.alloc(4 + length + 1);
    record[0] = length;
    record[1] = (offset >> 8) & 0xff;
    record[2] = offset & 0xff;
    record[3] = 0x00;
    record.set(bytes.subarray(offset, offset + length), 4);
    const sum = record.subarray(0, 4 + length).reduce((total, value) => total + value, 0);
    record[4 + length] = (0x100 - (sum & 0xff)) & 0xff;
    lines.push(`:${record.toString('hex').toUpperCase()}`);
  }
  lines.push(':00000001FF');
  return `${lines.join('\n')}\n`;
}

/** One generated resource and the exact bytes it must carry. */
function assetsFromBytes(bytes) {
  const hex = Buffer.from(encodeIntelHex(bytes), 'utf8');
  return Object.freeze([
    Object.freeze({ path: PACKAGE_BIN, data: bytes }),
    Object.freeze({ path: PACKAGE_HEX, data: hex }),
  ]);
}

/** One generated resource set from the assembly source. */
export function firmwareAssets(text) {
  return assetsFromBytes(assembleFirmware(text).bytes);
}

/**
 * Compares generated assets with their current files.
 *
 * @param {readonly { path: string, data: Uint8Array }[]} assets
 * @param {(path: string) => Uint8Array} read
 * @returns {readonly string[]} paths whose bytes are missing or different
 */
export function staleFirmwareAssets(assets, read = readFileSync) {
  const stale = [];
  for (const asset of assets) {
    let current;
    try {
      current = read(asset.path);
    } catch {
      stale.push(asset.path);
      continue;
    }
    if (!Buffer.from(current).equals(Buffer.from(asset.data))) stale.push(asset.path);
  }
  return stale;
}

function summary(bytes, labels) {
  const checksum = bytes.reduce((total, byte) => (total + byte) & 0xff, 0);
  const relative = (path) => path.slice(PROJECT.length + 1);
  const lines = [
    `firmware: ${bytes.length} 字节，校验和 0x${checksum.toString(16).padStart(2, '0')}`,
    ...[PACKAGE_BIN, PACKAGE_HEX].map((path) => `  ${relative(path)}`),
  ];
  for (const [name, address] of labels)
    lines.push(`  ${name} = 0x${address.toString(16).padStart(4, '0')}`);
  return lines.join('\n');
}

/**
 * Runs the firmware resource generator. With `--check` it compares without writing.
 *
 * @param {readonly string[]} argv
 * @returns {number} process exit code
 */
export function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((argument) => argument !== '--check');
  if (unknown.length > 0) {
    console.error(`usage: node assemble-firmware.mjs [--check]`);
    return 2;
  }
  const check = argv.includes('--check');
  const { bytes, labels } = assembleFirmware(readFileSync(SOURCE, 'utf8'));
  const assets = assetsFromBytes(bytes);
  if (check) {
    const stale = staleFirmwareAssets(assets);
    if (stale.length > 0) {
      console.error(
        `firmware assets are stale; run "node assemble-firmware.mjs":\n${stale
          .map((path) => `  ${path.slice(PROJECT.length + 1)}`)
          .join('\n')}`,
      );
      return 1;
    }
    console.log(`firmware assets are current (${bytes.length} 字节)`);
    return 0;
  }
  for (const asset of assets) {
    mkdirSync(dirname(asset.path), { recursive: true });
    writeFileSync(asset.path, asset.data);
  }
  console.log(summary(bytes, labels));
  return 0;
}

const invoked =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) process.exitCode = main();
