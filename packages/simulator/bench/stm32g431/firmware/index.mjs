// Public entry for the STM32G431 Thumb firmware fixtures.
//
// `firmwareFor(name)` returns a complete flash image plus the metadata a CPU
// benchmark needs: reset PC, initial MSP, symbol addresses for independent
// reset/loop/ISR accounting, peripheral addresses, instruction composition and
// a disassembly the CPU model can cross-check line by line.

import {
  FLASH_BASE,
  FLASH_SIZE,
  RESET_PC,
  SRAM_BASE,
  SRAM_SIZE,
  STACK_TOP,
  VECTOR_TABLE_ADDRESS,
  VECTOR_TABLE_ENTRIES,
  benchmarkNames,
  decodeHex,
  fixtureNames,
  fixtures,
} from './fixtures.mjs';

export {
  FLASH_BASE,
  FLASH_SIZE,
  RESET_PC,
  SRAM_BASE,
  SRAM_SIZE,
  STACK_TOP,
  VECTOR_TABLE_ADDRESS,
  VECTOR_TABLE_ENTRIES,
  fixtureNames,
};

export const workloadNames = benchmarkNames;

const byName = new Map(fixtures.map((fixture) => [fixture.name, fixture]));

const clone = (value) => JSON.parse(JSON.stringify(value));

export function firmwareFor(name) {
  const fixture = byName.get(name);
  if (!fixture) {
    throw new Error(`unknown STM32G431 firmware "${name}"; available: ${fixtureNames.join(', ')}`);
  }
  return {
    name: fixture.name,
    benchmark: fixture.benchmark,
    description: fixture.description,
    source: [...fixture.source],
    bytes: decodeHex(fixture.hex),
    size: fixture.size,
    sha256: fixture.sha256,
    resetPc: fixture.resetPc,
    initialSp: fixture.initialSp,
    vectorTable: { ...fixture.vectorTable },
    memory: clone(fixture.memory),
    symbols: { ...fixture.symbols },
    peripherals: [...fixture.peripherals],
    invariants: [...fixture.invariants],
    instructions: clone(fixture.instructions),
    disassembly: [...fixture.disassembly],
    expected: clone(fixture.expected),
    build: clone(fixture.build),
  };
}
