import assert from 'node:assert/strict';
import test from 'node:test';

import { fixtureNames, firmwareFor } from './firmware/index.mjs';
import { createReference } from './reference.mjs';

const CYCLE_PS = 10_000;
const WINDOW_CYCLES = 10_000;
const WINDOW_PS = WINDOW_CYCLES * CYCLE_PS;

const ALU_MASK = 0x5a5a5a5a;
const RAM_BASE = 0x20000000;
const RAM_SIZE = 32 * 1024;
const FLASH_BASE = 0x08000000;
const FLASH_SIZE = 128 * 1024;

function wordOf(bytes, offset) {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function bytesFor(halfwords) {
  const image = new Uint8Array(0x100 + halfwords.length * 2);
  const write = (offset, value) => {
    image[offset] = value & 0xff;
    image[offset + 1] = (value >>> 8) & 0xff;
    image[offset + 2] = (value >>> 16) & 0xff;
    image[offset + 3] = (value >>> 24) & 0xff;
  };
  write(0, 0x20008000);
  write(4, 0x08000101);
  halfwords.forEach((halfword, index) => {
    image[0x100 + index * 2] = halfword & 0xff;
    image[0x100 + index * 2 + 1] = (halfword >>> 8) & 0xff;
  });
  return image;
}

const op = {
  movs: (rd, imm) => 0x2000 | (rd << 8) | (imm & 0xff),
  cmpImm: (rn, imm) => 0x2800 | (rn << 8) | (imm & 0xff),
  subsImm: (rd, imm) => 0x3800 | (rd << 8) | (imm & 0xff),
  addsReg: (rd, rn, rm) => 0x1800 | (rm << 6) | (rn << 3) | rd,
  lslsImm: (rd, rm, amount) => 0x0000 | ((amount & 0x1f) << 6) | (rm << 3) | rd,
  nop: () => 0xbf00,
  b: (offset) => 0xe000 | ((offset >> 1) & 0x7ff),
  beq: (offset) => 0xd000 | ((offset >> 1) & 0xff),
  bne: (offset) => 0xd100 | ((offset >> 1) & 0xff),
  bx: (rm) => 0x4700 | (rm << 3),
  push: (list) => 0xb400 | list,
  pop: (list) => 0xbc00 | list,
  strImm: (rt, rn, offset) => 0x6000 | (((offset / 4) & 0x1f) << 6) | (rn << 3) | rt,
  ldrImm: (rt, rn, offset) => 0x6800 | (((offset / 4) & 0x1f) << 6) | (rn << 3) | rt,
  ldrLiteral: (rt, target, pc) => {
    const base = ((pc + 4) & ~3) >>> 0;
    return 0x4800 | (rt << 8) | (((target - base) / 4) & 0xff);
  },
};

function movw(rd, imm) {
  return [
    0xf240 | ((imm >>> 12) & 0xf) | (((imm >>> 11) & 1) << 10),
    (((imm >>> 8) & 7) << 12) | (rd << 8) | (imm & 0xff),
  ];
}

function movt(rd, imm) {
  return [
    0xf2c0 | ((imm >>> 12) & 0xf) | (((imm >>> 11) & 1) << 10),
    (((imm >>> 8) & 7) << 12) | (rd << 8) | (imm & 0xff),
  ];
}

function movConst(rd, value) {
  return [...movw(rd, value & 0xffff), ...movt(rd, (value >>> 16) & 0xffff)];
}

function signature(snapshot) {
  let hash = 0x811c9dc5;
  const mix = (byte) => {
    hash = (hash ^ byte) >>> 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  for (const byte of snapshot.ram) mix(byte);
  for (const edge of snapshot.gpioEdges) {
    mix(edge.value);
    for (let shift = 0; shift < 32; shift += 8) mix((edge.time >>> shift) & 0xff);
  }
  mix(snapshot.pa5Level);
  const ramHead = [0, 4, 8, 12, 16, 20, 24, 28]
    .map((offset) => wordOf(snapshot.ram, offset).toString(16))
    .join(',');
  return {
    hash: hash.toString(16).padStart(8, '0'),
    summary:
      `ram[00:20]=${ramHead} insn=${snapshot.instructionsIssued} exc=${snapshot.exceptionEntries} ` +
      `edges=${snapshot.gpioEdges.length} writes=${snapshot.gpioWrites.length} ` +
      `pc=0x${snapshot.states.pc.toString(16)} pa5=${snapshot.pa5Level}`,
  };
}

function runWhole(bytes, cycles = WINDOW_CYCLES) {
  return createReference({ firmware: bytes }).advance(cycles * CYCLE_PS);
}

function runSliced(bytes, cycles = WINDOW_CYCLES) {
  const reference = createReference({ firmware: bytes });
  const total = cycles * CYCLE_PS;
  const fractions = [
    1, 7, 8, 999, 5000, 12345, 100_000, 999_999, 1_000_000, 1_000_001, 2_000_000, 5_000_000,
    7_777_777,
  ];
  reference.snapshot();
  for (const fraction of fractions) {
    if (fraction >= total) continue;
    reference.advance(fraction);
  }
  return reference.advance(total);
}

/** Tracked flash images; the benchmark fixtures need no ARM toolchain at test time. */
function loadFirmware() {
  return fixtureNames.map((name) => ({ name, bytes: firmwareFor(name).bytes }));
}

function firmwareByName(images, name) {
  const image = images.find((candidate) => candidate.name === name);
  assert.ok(image, `firmware fixture ${name} is missing`);
  return image;
}

function findFlashCopies(ram, flash, words) {
  const byteLength = words * 4;
  const copies = [];
  for (let ramOffset = 0; ramOffset + byteLength <= ram.length; ramOffset += 4) {
    let allZero = true;
    for (let index = 0; index < words; index += 1) {
      if (wordOf(ram, ramOffset + index * 4) !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) continue;
    for (let flashOffset = 0; flashOffset + byteLength <= flash.length; flashOffset += 4) {
      let matches = true;
      for (let index = 0; index < words; index += 1) {
        if (wordOf(ram, ramOffset + index * 4) !== wordOf(flash, flashOffset + index * 4)) {
          matches = false;
          break;
        }
      }
      if (matches) {
        copies.push({ ramOffset, flashOffset });
        break;
      }
    }
  }
  return copies;
}

const images = loadFirmware();

test('firmware images run 10000 cycles deterministically and publish signatures', (t) => {
  assert.ok(images.length > 0, 'no firmware fixtures');
  for (const image of images) {
    const whole = runWhole(image.bytes);
    const sliced = runSliced(image.bytes);
    const wholeSignature = signature(whole);
    const slicedSignature = signature(sliced);
    t.diagnostic(`${image.name}: ${wholeSignature.hash} ${wholeSignature.summary}`);
    assert.equal(
      slicedSignature.hash,
      wholeSignature.hash,
      `${image.name} is not deterministic across irregular advances`,
    );
    assert.equal(sliced.instructionsIssued, whole.instructionsIssued);
    assert.equal(sliced.exceptionEntries, whole.exceptionEntries);
    assert.deepEqual(
      sliced.gpioEdges.map((edge) => [edge.time, edge.value]),
      whole.gpioEdges.map((edge) => [edge.time, edge.value]),
    );
    assert.deepEqual(
      sliced.gpioWrites.map((write) => [write.time, write.register, write.value, write.odr]),
      whole.gpioWrites.map((write) => [write.time, write.register, write.value, write.odr]),
    );
    assert.equal(sliced.pa5Level, whole.pa5Level);
    assert.equal(whole.cycles, WINDOW_CYCLES);
    assert.ok(whole.instructionsIssued > 100, `${image.name} executed too little`);
    assert.ok(
      whole.states.pc >= FLASH_BASE && whole.states.pc < FLASH_BASE + FLASH_SIZE,
      `${image.name} pc escaped flash`,
    );
    assert.ok(
      whole.states.r13 >= RAM_BASE && whole.states.r13 <= RAM_BASE + RAM_SIZE,
      `${image.name} sp escaped SRAM`,
    );
  }
});

test('firmware accepts the { bytes } wrapper and the default cycle period', () => {
  const image = images[0];
  assert.ok(image, 'no firmware images');
  const wrapped = createReference({ firmware: { bytes: image.bytes } });
  const plain = createReference({ firmware: image.bytes });
  assert.equal(
    wrapped.advance(WINDOW_PS).instructionsIssued,
    plain.advance(WINDOW_PS).instructionsIssued,
  );
});

test('alu-branch reproduces its documented 24-iteration round arithmetic', () => {
  const snapshot = runWhole(firmwareByName(images, 'alu-branch').bytes);
  const rounds = wordOf(snapshot.ram, 8);
  assert.ok(rounds > 0, 'no completed rounds');
  let a = 1;
  let b = 0;
  for (let round = 0; round < rounds; round += 1) {
    for (let iteration = 0; iteration < 24; iteration += 1) {
      b = (b + a) >>> 0;
      const mixed = ((((a ^ b) << 1) >>> 0) + (b >>> 3)) >>> 0;
      a = ((a + (mixed & ALU_MASK)) & ALU_MASK) >>> 0;
    }
  }
  assert.equal(wordOf(snapshot.ram, 0), a);
  assert.equal(wordOf(snapshot.ram, 4), b);
  if (a === b) {
    assert.equal(wordOf(snapshot.ram, 12), ((b & ALU_MASK) | a) >>> 0);
    assert.equal(wordOf(snapshot.ram, 20), (rounds * 24) >>> 0);
  } else {
    assert.equal(wordOf(snapshot.ram, 12), (a & 0xffff) >>> 0);
  }
});

test('gpio-blink drives PA5 through BSRR and records every edge', () => {
  const snapshot = runWhole(firmwareByName(images, 'gpio-blink').bytes);
  assert.equal(wordOf(snapshot.ram, 0), 0x20);
  assert.equal(wordOf(snapshot.ram, 4), 0x20);
  assert.equal(wordOf(snapshot.ram, 8), 0x00);
  assert.equal(
    wordOf(snapshot.ram, 12),
    0x00,
    'IDR mirrors the ODR latch, sampled after PA5 was cleared',
  );
  const transitions = wordOf(snapshot.ram, 16);
  assert.ok(transitions > 0, 'no pin transitions recorded by the firmware');
  assert.ok(snapshot.gpioEdges.length > 0, 'no host edge frames');
  const values = snapshot.gpioEdges.map((edge) => edge.value);
  assert.equal(values.length, transitions + (snapshot.pa5Level === 1 ? 1 : 0));
  let previousTime = -1;
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0) assert.notEqual(values[index], values[index - 1], 'GPIO edges must alternate');
    assert.ok(snapshot.gpioEdges[index].time > previousTime, 'GPIO edge times must increase');
    previousTime = snapshot.gpioEdges[index].time;
  }
  assert.equal(values.at(-1), snapshot.pa5Level);
  assert.equal(snapshot.pa5Level, snapshot.states.pa5.level);
});

test('ram-copy leaves matching flash table copies, checksum and counters', () => {
  const image = firmwareByName(images, 'ram-copy');
  const snapshot = runWhole(image.bytes);
  const copies = findFlashCopies(snapshot.ram, image.bytes, 16);
  assert.ok(copies.length >= 3, `expected three table copies, found ${copies.length}`);
  const sourceOffset = copies[0].flashOffset;
  assert.ok(
    copies.every((copy) => copy.flashOffset === sourceOffset),
    'copies disagree with the flash table',
  );
  const table = [];
  for (let index = 0; index < 16; index += 1)
    table.push(wordOf(image.bytes, sourceOffset + index * 4));
  let checksum = 0;
  for (const value of table) checksum = (checksum ^ value) >>> 0;
  assert.equal(wordOf(snapshot.ram, 0), checksum);
  assert.ok(wordOf(snapshot.ram, 4) > 0, 'no completed passes');
  assert.equal(wordOf(snapshot.ram, 8), table[0]);
  assert.equal(wordOf(snapshot.ram, 12), table[15]);
});

test('SysTick fixtures enter and return from the exception', () => {
  const systick = runWhole(firmwareByName(images, 'systick-irq').bytes);
  const ticks = wordOf(systick.ram, 0);
  assert.ok(ticks > 30, `expected roughly 10000/256 ticks, saw ${ticks}`);
  assert.equal(systick.exceptionEntries, ticks);
  assert.ok(wordOf(systick.ram, 8) <= ticks, 'thread tick snapshot outran the handler');

  const mixedImage = firmwareByName(images, 'mixed');
  const mixed = runWhole(mixedImage.bytes);
  const mixedTicks = wordOf(mixed.ram, 0);
  assert.ok(mixedTicks > 30);
  assert.equal(mixed.exceptionEntries, mixedTicks);
  assert.ok(wordOf(mixed.ram, 12) > 0, 'thread passes did not advance');
  assert.ok(wordOf(mixed.ram, 8) <= mixedTicks);
  assert.ok(
    findFlashCopies(mixed.ram, mixedImage.bytes, 8).length >= 1,
    'flash table copy missing',
  );
  assert.ok(mixed.gpioEdges.length <= mixedTicks + 2);
  assert.ok(mixed.gpioEdges.length >= mixedTicks - 2);
  assert.ok(
    mixed.gpioWrites.length >= mixedTicks,
    'handler BSRR writes are missing from the trace',
  );
});

test('thumb32-coverage executes MOVW/MOVT/BL and an IT block', () => {
  const snapshot = runWhole(firmwareByName(images, 'thumb32-coverage').bytes);
  assert.equal(wordOf(snapshot.ram, 0), 0xff);
  assert.equal(wordOf(snapshot.ram, 4), 3);
  assert.equal(wordOf(snapshot.ram, 8), 0xa5a500a5);
  assert.ok(wordOf(snapshot.ram, 12) > 0, 'no completed passes');
});

test('reference starts only instructions before the target', () => {
  const bytes = bytesFor([op.nop(), op.nop(), op.nop(), op.b(-4)]);
  const reference = createReference({ firmware: bytes, cyclePs: 1 });

  let snapshot = reference.advance(2);
  assert.equal(snapshot.instructionsIssued, 2);
  assert.equal(snapshot.states.pc, 0x08000104);
  assert.equal(snapshot.cpuTimePs, 2);

  snapshot = reference.advance(4);
  assert.equal(snapshot.instructionsIssued, 4);
  assert.equal(snapshot.states.pc, 0x08000106);
  assert.equal(snapshot.cpuTimePs, 6);

  snapshot = reference.advance(10);
  assert.equal(snapshot.instructionsIssued, 6);
  assert.equal(snapshot.cpuTimePs, 12);
  assert.equal(snapshot.cycles, 10);
  assert.equal(snapshot.time, 10);
});

test('reference retires load target writes only after the access deadline', () => {
  const code = [
    op.ldrLiteral(0, 0x08000108, 0x08000100),
    op.movs(1, 9),
    0xbf00,
    0xbf00,
    0x8000,
    0x2000,
  ];
  const reference = createReference({ firmware: bytesFor(code), cyclePs: 1 });
  let snapshot = reference.advance(2);
  assert.equal(snapshot.states.pc, 0x08000102);
  assert.equal(snapshot.states.r0, 0, 'load target must not be visible at the deadline');
  assert.equal(snapshot.cpuTimePs, 2);
  snapshot = reference.advance(3);
  assert.equal(snapshot.states.r0, 0x20008000);
  assert.equal(snapshot.states.r1, 9);
});

test('reference applies the documented ALU, memory and push/pop costs', () => {
  const code = [
    op.ldrLiteral(0, 0x0800010c, 0x08000100),
    op.movs(1, 5),
    op.strImm(1, 0, 0),
    op.ldrImm(2, 0, 0),
    op.push(0x01),
    op.pop(0x01),
    0x0000,
    0x2000,
  ];
  const snapshot = createReference({ firmware: bytesFor(code), cyclePs: 1 }).advance(11);
  assert.equal(snapshot.instructionsIssued, 6);
  assert.equal(snapshot.cpuTimePs, 11);
  assert.equal(snapshot.ram[0], 5);
  assert.equal(snapshot.states.r2, 5);
  assert.equal(snapshot.states.r13, 0x20008000);
});

test('reference costs taken and not-taken branches differently', () => {
  const taken = [op.movs(0, 1), op.cmpImm(0, 1), op.beq(0), op.movs(1, 7), op.nop(), op.b(-4)];
  let snapshot = createReference({ firmware: bytesFor(taken), cyclePs: 1 }).advance(5);
  assert.equal(snapshot.states.r1, 0);
  assert.equal(snapshot.states.pc, 0x08000108);
  assert.equal(snapshot.cpuTimePs, 5);

  const notTaken = [op.movs(0, 1), op.cmpImm(0, 2), op.beq(3), op.movs(1, 7), op.b(-4)];
  const reference = createReference({ firmware: bytesFor(notTaken), cyclePs: 1 });
  snapshot = reference.advance(3);
  assert.equal(snapshot.states.r1, 0);
  assert.equal(snapshot.states.pc, 0x08000106);
  snapshot = reference.advance(4);
  assert.equal(snapshot.states.r1, 7);
});

test('reference sets NZCV like the Thumb ALU', () => {
  const code = [op.movs(0, 1), op.subsImm(0, 2)];
  let snapshot = createReference({ firmware: bytesFor(code.slice(0, 2)), cyclePs: 1 }).advance(2);
  assert.equal(snapshot.states.r0, 0xffffffff);
  assert.deepEqual(
    [snapshot.states.n, snapshot.states.z, snapshot.states.c, snapshot.states.v],
    [true, false, false, false],
  );

  const overflow = [op.movs(1, 1), op.lslsImm(1, 1, 31), op.addsReg(1, 1, 1)];
  snapshot = createReference({ firmware: bytesFor(overflow), cyclePs: 1 }).advance(3);
  assert.equal(snapshot.states.r1, 0);
  assert.deepEqual(
    [snapshot.states.n, snapshot.states.z, snapshot.states.c, snapshot.states.v],
    [false, true, true, true],
  );
});

test('reference gates IT-block instructions on the condition flags', () => {
  const code = [
    op.movs(1, 1),
    op.movs(2, 2),
    op.cmpImm(1, 2),
    0xbf1c, // ITT NE
    0x460b, // movne r3, r1
    0x189b, // addne r3, r3, r2
    op.b(-4),
  ];
  let snapshot = createReference({ firmware: bytesFor(code), cyclePs: 1 }).advance(6);
  assert.equal(snapshot.states.r3, 3);
  assert.equal(snapshot.states.itstate, 0);

  const falseCode = [
    op.movs(1, 3),
    op.movs(2, 3),
    op.cmpImm(1, 3),
    0xbf1c,
    0x460b,
    0x189b,
    op.b(-4),
  ];
  snapshot = createReference({ firmware: bytesFor(falseCode), cyclePs: 1 }).advance(6);
  assert.equal(snapshot.states.r3, 0);
});

test('reference executes BL with the Thumb return address', () => {
  const code = [0xf000, 0xf802, op.b(-4), op.nop(), op.movs(0, 5), op.bx(14)];
  const snapshot = createReference({ firmware: bytesFor(code), cyclePs: 1 }).advance(7);
  assert.equal(snapshot.states.r0, 5);
  assert.equal(snapshot.states.r14, 0x08000105);
  assert.equal(snapshot.states.pc, 0x08000104);
});

test('reference gates PA5 on the GPIO clock and records edge times', () => {
  const code = [
    ...movConst(0, 0x48000000),
    ...movConst(1, 0x00000400),
    op.strImm(1, 0, 0), // dropped: GPIOA clock is still off
    op.movs(2, 0x20),
    op.strImm(2, 0, 0x18), // dropped as well
    ...movConst(3, 0x4002104c),
    op.movs(1, 1),
    op.strImm(1, 3, 0),
    ...movConst(1, 0x00000400),
    op.strImm(1, 0, 0),
    op.movs(2, 0x20),
    op.strImm(2, 0, 0x18),
    ...movConst(2, 0x00200000),
    op.strImm(2, 0, 0x18),
    op.b(-4),
  ];
  const bytes = bytesFor(code);
  const reference = createReference({ firmware: bytes, cyclePs: 1 });
  const early = reference.advance(9);
  assert.equal(early.pa5Level, 2, 'rail before the GPIOA clock is gated stays floating');
  assert.equal(early.states.gpioa.moder, 0xffffebff, 'unclocked MODER writes are dropped');
  assert.equal(early.states.gpioa.odr, 0, 'unclocked BSRR writes are dropped');
  assert.deepEqual(early.gpioWrites, []);
  const snapshot = reference.advance(30);
  assert.deepEqual(
    snapshot.gpioEdges.map((edge) => [edge.time, edge.value]),
    [
      [19, 1],
      [23, 0],
    ],
  );
  assert.deepEqual(
    snapshot.gpioWrites.map((write) => [write.time, write.register, write.odr]),
    [
      [19, 'BSRR', 0x20],
      [23, 'BSRR', 0],
    ],
  );
  assert.equal(snapshot.pa5Level, 0);
  assert.equal(snapshot.states.gpioa.moder, 0x400);
  assert.equal(snapshot.states.pa5.level, 0);
  assert.equal(snapshot.states.pa5.floating, false);
});

test('reference gates GPIOA reads while the clock is off', () => {
  const code = [
    ...movConst(3, 0x4002104c),
    op.movs(1, 1),
    op.strImm(1, 3, 0),
    ...movConst(0, 0x48000000),
    ...movConst(1, 0x00000400),
    op.strImm(1, 0, 0),
    op.movs(2, 0x20),
    op.strImm(2, 0, 0x18),
    op.movs(1, 0),
    op.strImm(1, 3, 0), // drop the GPIOA clock while PA5 is driven high
    op.ldrImm(1, 0, 0x14), // unclocked ODR read must return zero
    ...movConst(5, 0x20000000),
    op.strImm(1, 5, 0),
    op.b(-4),
  ];
  const snapshot = createReference({ firmware: bytesFor(code), cyclePs: 1 }).advance(60);
  assert.equal(snapshot.ram[0], 0, 'unclocked GPIOA reads return zero');
  assert.equal(snapshot.pa5Level, 2);
  assert.deepEqual(
    snapshot.gpioEdges.map((edge) => [edge.time, edge.value]),
    [
      [12, 1],
      [15, 0],
    ],
  );
});

test('reference follows the bus register conventions', () => {
  const code = [
    ...movConst(3, 0x4002104c),
    op.movs(1, 1),
    op.strImm(1, 3, 0),
    ...movConst(0, 0x48000000),
    ...movConst(1, 0x00000400),
    op.strImm(1, 0, 0),
    op.movs(2, 0x20),
    op.strImm(2, 0, 0x18),
    ...movConst(2, 0x00200020), // set and reset PA5 in the same BSRR write
    op.strImm(2, 0, 0x18),
    0xb672, // cpsid i: keep the forced pending flag from entering an exception
    ...movConst(4, 0xe000e010),
    ...movConst(5, 0xe000ed04),
    ...movConst(6, 0x06000000), // PENDSTSET and PENDSTCLR together
    op.strImm(6, 5, 0),
    ...movConst(6, 0x08000040), // deliberately unaligned VTOR
    op.strImm(6, 5, 4),
    op.b(-4),
  ];
  const snapshot = createReference({ firmware: bytesFor(code), cyclePs: 1 }).advance(40);
  assert.equal(snapshot.states.gpioa.odr, 0x20, 'BSRR set must win over reset');
  assert.equal(snapshot.pa5Level, 1);
  assert.equal(snapshot.states.systick.pending, true, 'PENDSTSET must win over PENDSTCLR');
  assert.equal(snapshot.states.vtor, 0x08000040, 'VTOR keeps the written value');
});

test('reference exposes SysTick registers and the 12+12 cycle exception loop', () => {
  const code = new Array(0x20).fill(op.nop());
  code.splice(
    0,
    8,
    ...movConst(0, 0xe000e010),
    op.movs(1, 0),
    op.strImm(1, 0, 8),
    op.movs(1, 7),
    op.strImm(1, 0, 0),
  );
  code[0x1f] = op.b(-4);
  code[0x20] = op.bx(14);
  const bytes = bytesFor(code);
  bytes[60] = 0x41;
  bytes[61] = 0x01;
  bytes[62] = 0x00;
  bytes[63] = 0x08;
  const reference = createReference({ firmware: bytes, cyclePs: 1 });
  const early = reference.advance(10_000);
  assert.ok(early.exceptionEntries > 100, 'SysTick did not interrupt');
  assert.equal(early.states.systick.load, 0);
  assert.equal(early.states.systick.enabled, true);
  const later = reference.advance(12_400);
  assert.equal(later.exceptionEntries - early.exceptionEntries, 100);
  assert.equal(later.instructionsIssued - early.instructionsIssued, 100);
  assert.equal(later.cpuTimePs - early.cpuTimePs, 2400);
});

test('reference reports SysTick ticks exactly at the target boundary', () => {
  const code = [
    ...movConst(0, 0xe000e010),
    op.movs(1, 2),
    op.strImm(1, 0, 4),
    op.movs(1, 0),
    op.strImm(1, 0, 8),
    op.movs(1, 7),
    op.strImm(1, 0, 0),
    op.nop(),
    op.b(-4),
  ];
  const reference = createReference({ firmware: bytesFor(code), cyclePs: 1 });
  const before = reference.advance(11);
  assert.equal(before.states.systick.ticks, 0);
  assert.equal(before.states.systick.pending, false);
  assert.equal(before.states.systick.val, 0);
  const atTick = reference.advance(12);
  assert.equal(atTick.states.systick.ticks, 1);
  assert.equal(atTick.states.systick.pending, true);
  assert.equal(atTick.states.systick.val, 2);
  assert.equal(atTick.states.systick.countflag, true);
});

test('reference rejects instructions it does not model', () => {
  const reference = createReference({ firmware: bytesFor([0xde00]), cyclePs: 1 });
  assert.throws(() => reference.advance(4), /reference:.*(unknown|unsupported)/);
});

test('reference snapshots expose the documented state shape', () => {
  const image = images[0];
  assert.ok(image, 'no firmware images');
  const reference = createReference({ firmware: image.bytes });
  const snapshot = reference.snapshot();
  for (let index = 0; index <= 14; index += 1) {
    assert.equal(typeof snapshot.states[`r${index}`], 'number', `missing r${index}`);
  }
  for (const flag of ['n', 'z', 'c', 'v'])
    assert.equal(typeof snapshot.states[flag], 'boolean', flag);
  assert.equal(snapshot.states.pc, 0x08000100);
  assert.equal(snapshot.states.r13, 0x20008000);
  assert.equal(snapshot.states.r14, 0);
  assert.equal(snapshot.states.gpioa.moder, 0xffffebff);
  assert.equal(snapshot.states.primask, 0);
  assert.equal(snapshot.states.ipsr, 0);
  assert.equal(snapshot.ram.length, RAM_SIZE);
  assert.equal(snapshot.instructionsIssued, 0);
  assert.equal(snapshot.cycles, 0);
  assert.equal(snapshot.pa5Level, 2);
  assert.deepEqual(snapshot.gpioEdges, []);
  assert.deepEqual(snapshot.gpioWrites, []);
  assert.throws(() => reference.advance(-1), RangeError);
});

test('reference stacks the eight-word frame and restores it on BX LR', () => {
  const code = [
    ...movConst(0, 0xe000e010),
    op.movs(1, 63),
    op.strImm(1, 0, 4),
    op.movs(1, 0),
    op.strImm(1, 0, 8),
    op.movs(1, 7),
    op.strImm(1, 0, 0),
    op.movs(4, 0x63),
    op.b(-4),
  ];
  code[0x10] = op.bx(14);
  const bytes = bytesFor(code);
  bytes[60] = 0x21;
  bytes[61] = 0x01;
  bytes[62] = 0x00;
  bytes[63] = 0x08;
  const reference = createReference({ firmware: bytes, cyclePs: 1 });
  const entered = reference.advance(76);

  assert.equal(entered.exceptionEntries, 1);
  assert.equal(entered.states.ipsr, 15);
  assert.equal(entered.states.r14, 0xfffffff9);
  assert.equal(entered.states.r13, 0x20007fe0);
  assert.equal(entered.states.pc, 0x08000120);
  assert.equal(wordOf(entered.ram, 0x7fe0), 0xe000e010);
  assert.equal(wordOf(entered.ram, 0x7fe4), 7);
  assert.equal(wordOf(entered.ram, 0x7ff4), 0);
  assert.equal(wordOf(entered.ram, 0x7ff8), 0x08000116);
  assert.equal(wordOf(entered.ram, 0x7ffc) >>> 24, 0x01, 'stacked xPSR must keep the Thumb bit');

  const before = entered.instructionsIssued;
  const returned = reference.advance(88);
  assert.equal(returned.states.ipsr, 0);
  assert.equal(returned.states.r13, 0x20008000);
  assert.equal(returned.states.pc, 0x08000116);
  assert.equal(returned.instructionsIssued, before + 1);
});
