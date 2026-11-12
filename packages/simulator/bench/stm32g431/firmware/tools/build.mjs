// Regenerate fixtures.mjs from the assembly sources.
//
// Requires clang, ld.lld, llvm-objcopy and llvm-objdump (any recent LLVM).
// Tests and benchmarks only consume the tracked fixtures.mjs bytes and never
// invoke this script, so an ARM toolchain is not needed to run the suite.
//
// Usage:
//   node tools/build.mjs            # rebuild, verify with the reference model, write fixtures.mjs
//   node tools/build.mjs --check    # rebuild and fail if fixtures.mjs is stale
//   node tools/build.mjs --dry-run  # build and verify, print a summary, write nothing

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReference } from './reference-run.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const srcDir = join(root, 'src');
const buildDir = join(root, 'build');
const linkerScript = join(root, 'linker', 'stm32g431.ld');
const fixturesFile = join(root, 'fixtures.mjs');

const FLASH_BASE = 0x08000000;
const FLASH_SIZE = 0x20000;
const SRAM_BASE = 0x20000000;
const SRAM_SIZE = 0x8000;
const STACK_TOP = 0x20008000;
const RESET_PC = 0x08000100;

const FIXTURES = [
  {
    name: 'alu-branch',
    benchmark: true,
    source: 'src/alu-branch.s',
    mainLoop: 'alu_round_loop',
    description:
      '16-bit integer ALU chain (adds/eors/lsls/lsrs/ands/orrs) with push/pop saves and a cmp-driven branch pair.',
    peripherals: ['RCC_AHB2ENR', 'GPIOA'],
    invariants: [
      'reset: SRAM 0x20000000..0x200000ff is zero, GPIOA MODER = 0x400, SysTick CSR = 0, MSP = 0x20008000',
      'ram[0x20000000] = a, ram[0x20000004] = b after the last completed round',
      'per iteration: b += a; a = (a + (((a ^ b) << 1) + (b >> 3))) & 0x5a5a5a5a, 24 iterations per round',
      'ram[0x20000008] counts completed rounds; ram[0x20000014] = 24 * rounds on the a == b path',
    ],
  },
  {
    name: 'ram-copy',
    benchmark: true,
    source: 'src/ram-copy.s',
    mainLoop: 'ram_copy_pass_loop',
    description:
      'Flash-to-SRAM word copy, SRAM-to-SRAM word copy, byte copy with register offsets, and an XOR checksum fold.',
    peripherals: ['RCC_AHB2ENR', 'GPIOA'],
    invariants: [
      '0x20000020..0x2000005f, 0x20000060..0x2000009f and 0x200000a0..0x200000df hold the 64-byte flash table',
      'ram[0x20000000] = XOR of the 16 words at 0x20000060',
      'ram[0x20000004] counts completed passes; ram[0x20000008] = table word 0; ram[0x2000000c] = table word 15',
    ],
  },
  {
    name: 'gpio-blink',
    benchmark: true,
    source: 'src/gpio-blink.s',
    mainLoop: 'gpio_toggle_loop',
    description:
      'GPIOA PA5 driven high and low through BSRR with ODR/IDR readback and a 24-iteration busy-wait delay.',
    peripherals: ['RCC_AHB2ENR', 'GPIOA'],
    invariants: [
      'each loop writes BSRR 0x00000020 then 0x00200000',
      'ram[0x20000004] = ODR while set = 0x00000020; ram[0x20000008] = ODR while cleared = 0',
      'ram[0x20000010] advances by 2 per loop and is even',
      'ram[0x2000000c] is the IDR sample and follows the modelled PA5 level',
    ],
  },
  {
    name: 'systick-irq',
    benchmark: true,
    source: 'src/systick-irq.s',
    mainLoop: 'systick_thread_loop',
    description:
      'SysTick LOAD=255, VAL=0, CTRL=7 with a handler that increments an SRAM counter and returns through bx lr.',
    peripherals: ['RCC_AHB2ENR', 'GPIOA', 'SysTick'],
    invariants: [
      'handler entry pushes r0/r1, increments the word at 0x20000000, pops and executes bx lr with EXC_RETURN 0xfffffff9',
      'handler is the only writer of 0x20000000; the thread is the only writer of 0x20000004 and 0x20000008',
      'ram[0x20000008] <= ram[0x20000000] at every instruction boundary outside the handler',
      'exception period is 256 core cycles once the counter has reloaded',
    ],
  },
  {
    name: 'mixed',
    benchmark: true,
    source: 'src/mixed.s',
    mainLoop: 'mixed_thread_loop',
    helper: 'mixed_copy_helper',
    description:
      'SysTick handler toggling PA5 through BSRR while the thread calls a push/pop BL helper, runs an ITE block on tick parity, mixes the tick count and samples GPIO ODR/IDR.',
    peripherals: ['RCC_AHB2ENR', 'GPIOA', 'SysTick'],
    invariants: [
      'handler increments 0x20000000 and writes BSRR once per tick (0x00200000 or 0x00000020)',
      'ram[0x20000008] <= ram[0x20000000]; ram[0x2000000c] counts completed thread passes',
      'ram[0x20000010] = XOR of the eight copied flash words, returned by the BL helper',
      'ram[0x20000004] = ((tick + delta) << 1) & 0x5a5a5a5a with the ITE delta 0x10 or 0x20',
      'ram[0x20000014] and ram[0x20000018] sample the PA5 ODR/IDR level (0x00000000 or 0x00000020)',
      '0x20000020..0x2000003f always equals the eight-word flash table after a completed pass',
    ],
  },
  {
    name: 'stress',
    benchmark: true,
    source: 'src/stress.s',
    mainLoop: 'stress_loop',
    description:
      'Large unrolled loop (~300 distinct PCs) mixing ALU chains with immediate and register shifts (including asrs), RAM word/halfword/byte traffic, GPIOA ODR/IDR reads, BSRR writes, literal-pool loads and cmp/bne/beq/bhi branches with a SysTick handler.',
    peripherals: ['RCC_AHB2ENR', 'GPIOA', 'SysTick'],
    invariants: [
      'handler increments 0x20000000 and writes BSRR once per tick',
      'ram[0x20000004] counts completed passes; every pass stores ram[0x20000008] = accumulator',
      'ram[0x20000020] = ram[0x20000008] ^ ram[0x20000000] at the end of the pass',
      'ram[0x2000000c] is read and rewritten inside every unrolled block',
      '0x20000010..0x2000001f is read with ldrb and written with strb every sixth block',
      '0x20000014..0x2000001a receives strh halfwords read with ldrh from the scratch word',
      'lsls/lsrs/asrs with a register shift amount run every fourth block (select/boolean IR)',
      'bhi on tick parity is both taken and not taken across passes (0x20000028/0x2000002c)',
      'the thread writes BSRR six times per pass; ODR/IDR are sampled every third block',
    ],
  },
  {
    name: 'thumb32-coverage',
    benchmark: false,
    source: 'src/thumb32-coverage.s',
    mainLoop: 'thumb32_coverage_loop',
    description:
      'Correctness fixture: MOVW/MOVT, BL subroutine call, IT block and CPSID/CPSIE inside a steady loop.',
    peripherals: ['RCC_AHB2ENR', 'GPIOA'],
    invariants: [
      'ram[0x20000000] = 255 (sum of 1,2,4,8,16,32,64,128 through the BL subroutine)',
      'ram[0x20000004] = 3 (IT block with the ne condition taken)',
      'ram[0x20000008] = 0xa5a500a5 built by movw/movt; ram[0x2000000c] counts completed passes',
    ],
  },
];

const options = {
  check: process.argv.includes('--check'),
  dryRun: process.argv.includes('--dry-run'),
};

function findTool(envName, names, fallback) {
  const override = process.env[envName];
  if (override) {
    if (!existsSync(override)) throw new Error(`${envName} points at a missing file: ${override}`);
    return override;
  }
  for (const name of names) {
    try {
      const found = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (found) return found;
    } catch {
      // fall through to the next candidate
    }
    if (fallback && existsSync(fallback)) return fallback;
  }
  throw new Error(
    `cannot find ${names[0]}; install LLVM or set ${envName}. ` +
      'fixtures.mjs already contains the built bytes, so only regeneration needs the toolchain.',
  );
}

const llvmBin = 'C:\\Program Files\\LLVM\\bin';
const tools = {
  clang: findTool('MICA_STM32_CLANG', ['clang', 'clang.exe'], join(llvmBin, 'clang.exe')),
  ldll: findTool('MICA_STM32_LD_LLD', ['ld.lld', 'ld.lld.exe'], join(llvmBin, 'ld.lld.exe')),
  objcopy: findTool(
    'MICA_STM32_OBJCOPY',
    ['llvm-objcopy', 'llvm-objcopy.exe'],
    join(llvmBin, 'llvm-objcopy.exe'),
  ),
  objdump: findTool(
    'MICA_STM32_OBJDUMP',
    ['llvm-objdump', 'llvm-objdump.exe'],
    join(llvmBin, 'llvm-objdump.exe'),
  ),
};

const run = (tool, args) =>
  execFileSync(tool, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function findPrettier() {
  let directory = root;
  for (let level = 0; level < 8; level++) {
    const candidate = join(directory, 'node_modules', 'prettier', 'bin', 'prettier.cjs');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

const prettier = findPrettier();
const formatSource = (source) =>
  prettier
    ? execFileSync(process.execPath, [prettier, '--stdin-filepath', fixturesFile], {
        input: source,
        encoding: 'utf8',
        cwd: root,
      })
    : source;

const displayPath = (path) => relative(root, path).replaceAll('\\', '/');
const quoteArg = (value) => (value.includes(' ') ? `"${value}"` : value);
const displayPathForArg = (value) =>
  value.startsWith(root) ? quoteArg(displayPath(value)) : quoteArg(value);

const formatHexLines = (bytes) => {
  const lines = [];
  for (let index = 0; index < bytes.length; index += 16) {
    lines.push(
      [...bytes.subarray(index, index + 16)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(' '),
    );
  }
  return lines;
};

const parseDisassembly = (text) => {
  const instructions = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([0-9a-f]+):\s+([0-9a-f ]+?)\s*\t(.*)$/.exec(line);
    if (!match) continue;
    const address = parseInt(match[1], 16);
    const hexBytes = match[2].replace(/\s+/g, '');
    const textPart = match[3].trim();
    if (textPart.startsWith('.word') || textPart === '...') continue;
    instructions.push({
      address,
      bytes: hexBytes,
      width: hexBytes.length / 2,
      text: textPart,
      mnemonic: /^[a-z]+/.exec(textPart)?.[0] ?? textPart,
    });
  }
  return instructions;
};

const parseSymbols = (text) => {
  const symbols = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{8})\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const fields = match[2].split(/\s+/);
    const name = fields[fields.length - 1];
    if (!/^[A-Za-z_.][\w.$]*$/.test(name)) continue;
    symbols.set(name, parseInt(match[1], 16));
  }
  return symbols;
};

const words = (bytes, offset, count) => {
  const values = [];
  for (let index = 0; index < count; index++) {
    const position = offset + index * 4;
    values.push(
      (bytes[position] |
        (bytes[position + 1] << 8) |
        (bytes[position + 2] << 16) |
        (bytes[position + 3] << 24)) >>>
        0,
    );
  }
  return values;
};

function compileFixture(entry) {
  const stem = entry.name;
  const sourcePath = join(root, entry.source);
  const objectPath = join(buildDir, `${stem}.o`);
  const elfPath = join(buildDir, `${stem}.elf`);
  const binaryPath = join(buildDir, `${stem}.bin`);

  const compileArgs = [
    '--target=arm-none-eabi',
    '-mcpu=cortex-m4',
    '-mthumb',
    '-ffreestanding',
    '-fno-builtin',
    '-nostdlib',
    '-I',
    srcDir,
    '-c',
    sourcePath,
    '-o',
    objectPath,
  ];
  const linkArgs = [
    '-T',
    linkerScript,
    '--entry=reset_handler',
    '--fatal-warnings',
    '-o',
    elfPath,
    objectPath,
  ];
  const copyArgs = ['-O', 'binary', elfPath, binaryPath];

  run(tools.clang, compileArgs);
  run(tools.ldll, linkArgs);
  run(tools.objcopy, copyArgs);

  const bytes = new Uint8Array(readFileSync(binaryPath));
  const disassemblyText = run(tools.objdump, ['-d', '--mcpu=cortex-m4', elfPath]);
  const instructions = parseDisassembly(disassemblyText);
  const symbolTable = parseSymbols(run(tools.objdump, ['-t', elfPath]));

  const symbol = (name) => {
    const address = symbolTable.get(name);
    if (address === undefined) throw new Error(`${stem}: missing symbol ${name}`);
    return address;
  };

  const vectors = words(bytes, 0, 16);
  const initialSp = vectors[0];
  const resetVector = vectors[1];
  const systickVector = vectors[15];

  if (initialSp !== STACK_TOP) throw new Error(`${stem}: MSP is 0x${initialSp.toString(16)}`);
  if ((resetVector & ~1) !== RESET_PC || (resetVector & 1) === 0) {
    throw new Error(`${stem}: reset vector is 0x${resetVector.toString(16)}, expected 0x08000101`);
  }
  if ((systickVector & 1) === 0) throw new Error(`${stem}: SysTick vector is not a Thumb address`);

  const narrow = instructions.filter((instruction) => instruction.width === 2);
  const wide = instructions.filter((instruction) => instruction.width === 4);
  const mnemonics = {};
  for (const instruction of narrow)
    mnemonics[instruction.mnemonic] = (mnemonics[instruction.mnemonic] ?? 0) + 1;

  const symbols = {
    reset: symbol('reset_handler'),
    workload: symbol('run_workload'),
    mainLoop: symbol(entry.mainLoop),
    systickHandler: symbol('systick_handler'),
  };
  if (entry.helper) symbols.helper = symbol(entry.helper);
  if (symbols.reset !== RESET_PC) throw new Error(`${stem}: reset_handler is not at 0x08000100`);

  return {
    name: stem,
    benchmark: entry.benchmark,
    description: entry.description,
    source: ['src/startup.inc', entry.source],
    bytes,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    resetPc: RESET_PC,
    initialSp,
    vectorTable: {
      address: FLASH_BASE,
      initialSp,
      reset: resetVector,
      systick: systickVector,
      entries: vectors,
    },
    memory: {
      flash: { base: FLASH_BASE, size: FLASH_SIZE },
      sram: { base: SRAM_BASE, size: SRAM_SIZE },
      stackTop: STACK_TOP,
    },
    symbols,
    peripherals: entry.peripherals,
    invariants: entry.invariants,
    instructions: {
      total: narrow.length + wide.length,
      narrow: narrow.length,
      wide: wide.length,
      mnemonics,
      wideMnemonics: [...new Set(wide.map((instruction) => instruction.mnemonic))].sort(),
    },
    disassembly: instructions.map(
      (instruction) =>
        `${instruction.address.toString(16).padStart(8, '0')}  ${instruction.bytes}  ${instruction.text}`,
    ),
    build: {
      command: 'node tools/build.mjs',
      clang: [quoteArg(tools.clang), ...compileArgs.map(displayPathForArg)].join(' '),
      ld: [quoteArg(tools.ldll), ...linkArgs.map(displayPathForArg)].join(' '),
      objcopy: [quoteArg(tools.objcopy), ...copyArgs.map(displayPathForArg)].join(' '),
      objdump: [quoteArg(tools.objdump), '-d', '--mcpu=cortex-m4', displayPath(elfPath)].join(' '),
    },
    expected: null,
  };
}

const compactSnapshot = (snapshot) => ({
  instructions: snapshot.instructions,
  cycles: snapshot.cycles,
  pc: snapshot.pc,
  sp: snapshot.registers.sp,
  ram: snapshot.ram.map((entry) => entry.value),
  registers: snapshot.registers,
  gpio: snapshot.gpio,
  systick: {
    enable: snapshot.systick.enable,
    tickint: snapshot.systick.tickint,
    clksource: snapshot.systick.clksource,
    load: snapshot.systick.load,
    val: snapshot.systick.val,
    countflag: snapshot.systick.countflag,
  },
  systickExceptions: snapshot.systickExceptions,
});

const hex32 = (value) => `0x${(value >>> 0).toString(16).padStart(8, '0')}`;

const emit = (fixtures) => {
  const header = `// Generated by tools/build.mjs from src/*.s and linker/stm32g431.ld.
// Do not edit by hand; run \`node tools/build.mjs\` after changing the assembly.
//
// Every fixture is a complete STM32G431 flash image: the vector table sits at
// FLASH_BASE 0x08000000, reset handler at 0x08000100, MSP at 0x20008000. The
// image contains only real Thumb instructions executed from flash, no host
// constants and no data that is not also used by the code. Reset clears the
// 256-byte scratch window at 0x20000000, enables the GPIOA clock, configures
// PA5 as a push-pull output, leaves SysTick disabled and zeroes r0-r7 before
// entering run_workload.

export const FLASH_BASE = 0x08000000;
export const FLASH_SIZE = 0x20000;
export const SRAM_BASE = 0x20000000;
export const SRAM_SIZE = 0x8000;
export const STACK_TOP = 0x20008000;
export const RESET_PC = 0x08000100;
export const VECTOR_TABLE_ADDRESS = 0x08000000;
export const VECTOR_TABLE_ENTRIES = 16;

export function decodeHex(lines) {
  const compact = lines.join('').replace(/\\s+/g, '');
  if (compact.length % 2 !== 0) throw new Error('odd number of hex digits');
  const bytes = new Uint8Array(compact.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export const fixtures = [
`;

  const body = fixtures
    .map((fixture) => {
      const expected = fixture.expected;
      const lines = [];
      lines.push('  {');
      lines.push(`    name: ${JSON.stringify(fixture.name)},`);
      lines.push(`    benchmark: ${fixture.benchmark},`);
      lines.push(`    description: ${JSON.stringify(fixture.description)},`);
      lines.push(`    source: ${JSON.stringify(fixture.source)},`);
      lines.push(`    size: ${fixture.size},`);
      lines.push(`    sha256: ${JSON.stringify(fixture.sha256)},`);
      lines.push(`    resetPc: ${hex32(fixture.resetPc)},`);
      lines.push(`    initialSp: ${hex32(fixture.initialSp)},`);
      lines.push('    hex: [');
      for (const line of formatHexLines(fixture.bytes)) lines.push(`      '${line}',`);
      lines.push('    ],');
      lines.push(
        `    vectorTable: { address: ${hex32(fixture.vectorTable.address)}, initialSp: ${hex32(fixture.vectorTable.initialSp)}, reset: ${hex32(fixture.vectorTable.reset)}, systick: ${hex32(fixture.vectorTable.systick)}, entries: [${fixture.vectorTable.entries.map(hex32).join(', ')}] },`,
      );
      lines.push(`    memory: ${JSON.stringify(fixture.memory)},`);
      lines.push(
        `    symbols: { reset: ${hex32(fixture.symbols.reset)}, workload: ${hex32(fixture.symbols.workload)}, mainLoop: ${hex32(fixture.symbols.mainLoop)}, systickHandler: ${hex32(fixture.symbols.systickHandler)}${fixture.symbols.helper === undefined ? '' : `, helper: ${hex32(fixture.symbols.helper)}`} },`,
      );
      lines.push(`    peripherals: ${JSON.stringify(fixture.peripherals)},`);
      lines.push('    invariants: [');
      for (const invariant of fixture.invariants) lines.push(`      ${JSON.stringify(invariant)},`);
      lines.push('    ],');
      lines.push(
        `    instructions: { total: ${fixture.instructions.total}, narrow: ${fixture.instructions.narrow}, wide: ${fixture.instructions.wide}, mnemonics: ${JSON.stringify(fixture.instructions.mnemonics)}, wideMnemonics: ${JSON.stringify(fixture.instructions.wideMnemonics)} },`,
      );
      lines.push('    disassembly: [');
      for (const instruction of fixture.disassembly)
        lines.push(`      ${JSON.stringify(instruction)},`);
      lines.push('    ],');
      lines.push('    expected: {');
      lines.push(
        `      cycleDependent: ${expected.cycleDependent}, instructionBudget: ${expected.instructionBudget},`,
      );
      lines.push(`      postReset: ${JSON.stringify(compactSnapshot(expected.postReset))},`);
      lines.push('      samples: [');
      for (const sample of expected.samples)
        lines.push(`        ${JSON.stringify(compactSnapshot(sample))},`);
      lines.push('      ],');
      lines.push(`      settled: ${JSON.stringify(compactSnapshot(expected.settled))},`);
      lines.push(`      final: ${JSON.stringify(compactSnapshot(expected.final))},`);
      lines.push('    },');
      lines.push(`    build: ${JSON.stringify(fixture.build, null, 2).replace(/\n/g, '\n    ')},`);
      lines.push('  },');
      return lines.join('\n');
    })
    .join('\n');

  return `${header}${body}\n];\n\nexport const fixtureNames = fixtures.map((fixture) => fixture.name);\n\nexport const benchmarkNames = fixtures.filter((fixture) => fixture.benchmark).map((fixture) => fixture.name);\n`;
};

mkdirSync(buildDir, { recursive: true });

const built = FIXTURES.map((entry) => {
  const fixture = compileFixture(entry);
  fixture.expected = runReference(fixture);
  return fixture;
});

const source = formatSource(emit(built));
const current = existsSync(fixturesFile) ? readFileSync(fixturesFile, 'utf8') : null;
const stale = current !== source;

if (options.check) {
  if (stale) {
    console.error('fixtures.mjs is stale: run `node tools/build.mjs`');
    process.exit(1);
  }
  console.log('fixtures.mjs matches the rebuilt firmware');
} else if (!options.dryRun) {
  writeFileSync(fixturesFile, source);
  console.log(`wrote ${displayPath(fixturesFile)}${stale ? '' : ' (unchanged)'}`);
} else {
  console.log('dry run: fixtures.mjs not written');
}

for (const fixture of built) {
  console.log(
    `${fixture.name.padEnd(18)} ${String(fixture.size).padStart(4)} B  ` +
      `${String(fixture.instructions.narrow).padStart(3)} x 16-bit  ` +
      `${String(fixture.instructions.wide).padStart(2)} x 32-bit  ` +
      `sha256 ${fixture.sha256.slice(0, 16)}…  reset 0x${fixture.vectorTable.reset.toString(16)}`,
  );
}
