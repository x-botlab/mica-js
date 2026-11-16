import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assemble } from './assemble';

const HERE = import.meta.dirname;
const FIXTURES = [
  'uart-echo',
  'i2c-eeprom-pcf',
  'ds18b20-temp',
  'ds1302-read',
  'ultrasonic-echo',
  'key-scan',
  'actuators',
  'ir-j2',
  'latch',
  'resistor-mixed',
  'resistor-opendrain',
];

describe('8051 test fixture assembler', () => {
  for (const name of FIXTURES) {
    it(`${name}.asm is valid`, () => {
      const bytes = assemble(readFileSync(join(HERE, `${name}.asm`), 'utf8'));
      expect(bytes.length).toBeGreaterThan(8);
      expect(bytes.some((value) => value !== 0)).toBe(true);
    });
  }

  it('encodes the UART echo prologue and rejects unknown mnemonics', () => {
    const bytes = assemble(readFileSync(join(HERE, 'uart-echo.asm'), 'utf8'));
    expect([...bytes.slice(0, 7)]).toEqual([0x75, 0x8e, 0x00, 0x75, 0xb0, 0xff, 0x75]);
    expect(() => assemble('BOGUS A\n')).toThrow(/unsupported mnemonic/);
    expect(() => assemble('SJMP missing\n')).toThrow(/unknown label/);
  });

  it('keeps MOV A,Rn size and downstream branch offsets consistent', () => {
    const bytes = assemble(`ORG 0
MOV A,R0
SJMP target
MOV R1,#0x11
target:
NOP
`);
    expect([...bytes]).toEqual([0xe8, 0x80, 0x02, 0x79, 0x11, 0x00]);
  });

  it('rejects immediate bytes outside 0..255', () => {
    expect(() => assemble('MOV A,#256\n')).toThrow(/byte value out of range/);
    expect(() => assemble('MOV R7,#0x100\n')).toThrow(/byte value out of range/);
    expect(() => assemble('ANL A,#0x100\n')).toThrow(/byte value out of range/);
  });

  it('rejects overlapping and out-of-range ORG regions', () => {
    expect(() => assemble('ORG 0\nNOP\nORG 0\nNOP\n')).toThrow(/overlaps emitted code/);
    expect(() => assemble('ORG 0xF000\nNOP\n')).toThrow(/outside the 60 KiB/);
    expect(() => assemble('ORG 0xEFFF\nSJMP end\nend:\nNOP\n')).toThrow(/exceeds the 60 KiB/);
  });

  it('enforces the ACALL 2 KiB page contract', () => {
    expect(() => assemble('ORG 0\nACALL target\nORG 0x800\ntarget:\nNOP\n')).toThrow(
      /different 2 KiB page/,
    );
    expect([...assemble('ORG 0x100\nACALL target\ntarget:\nRET\n').slice(0x100)]).toEqual([
      0x31, 0x02, 0x22,
    ]);
  });

  it('rejects unsupported operands instead of ignoring them', () => {
    for (const source of [
      'NOP A',
      'RET A',
      'RLC',
      'RLC B',
      'RL A, B',
      'SETB A',
      'CLR',
      'CPL 1',
      'MOV A,R8',
    ])
      expect(() => assemble(`${source}\n`), source).toThrow();
  });
});
