import { describe, expect, it } from 'vitest';
import { buildAccessor } from './teaching-mcu.ac';
import { TeachingMCUError } from './teaching-mcu.errors';
import {
  createTeachingMCUIR,
  resolveTeachingMCUConfig,
  RAM_BASE,
  REGISTER_COUNT,
  TEACHING_MCU_IR_TYPE,
} from './teaching-mcu';
import {
  Cond,
  Op,
  createStandalone,
  encodeB,
  encodeI,
  encodeR,
  interruptFirmware,
  loopFirmware,
  runTeachingReference,
  wordsToBytes,
} from './teaching-mcu.test-helpers';

const TEACHING_FIRMWARE = Object.freeze([0x10, 1, 0x10, 2, 0x30, 8, 0x00, 0x00, 0x10, 4, 0x20, 0]);

function m3(words: readonly number[], config: Parameters<typeof createTeachingMCUIR>[1] = {}) {
  return createTeachingMCUIR('mcu', {
    isa: 'm3',
    firmware: wordsToBytes(words),
    ...config,
  });
}

describe('teaching MCU configuration', () => {
  it('resolves the documented defaults', () => {
    const config = resolveTeachingMCUConfig();
    expect(config.isa).toBe('m3');
    expect(config.ports).toEqual(['A', 'B']);
    expect(config.portWidth).toBe(16);
    expect(config.flashSize).toBe(64 * 1024);
    expect(config.ramSize).toBe(32 * 1024);
    expect(config.instructionsPerTick).toBe(1);
    expect(config.irqCount).toBe(32);
    expect(config.firmware).toEqual(Uint8Array.from([0, 0, 0, 0]));
    expect(config.registers).toHaveLength(REGISTER_COUNT);
    expect(config.registers[13]).toBe(RAM_BASE + config.ramSize);
    expect(config.registers[15]).toBe(RAM_BASE);
  });

  it('resolves the legacy teaching defaults', () => {
    const config = resolveTeachingMCUConfig({ isa: 'teaching' });
    expect(config.firmware).toEqual(Uint8Array.from(TEACHING_FIRMWARE));
    expect(config.initialDirections.A).toBe(1);
  });

  it.each([
    [{ isa: 'arm' }, 'isa'],
    [{ ports: [] }, 'ports'],
    [{ ports: ['A', 'A'] }, 'ports'],
    [{ ports: ['AB'] }, 'ports'],
    [{ portWidth: 0 }, 'portWidth'],
    [{ portWidth: 33 }, 'portWidth'],
    [{ flashSize: 0 }, 'flashSize'],
    [{ ramSize: 0 }, 'ramSize'],
    [{ firmware: new Uint8Array(10), flashSize: 8 }, 'firmware'],
    [{ instructionsPerTick: 0 }, 'instructionsPerTick'],
    [{ maxBlockInstructions: 0 }, 'maxBlockInstructions'],
    [{ irqCount: 33 }, 'irqCount'],
    [{ interrupts: [{ irq: 32, port: 'A', bit: 0 }] }, 'IRQ'],
    [{ interrupts: [{ irq: 0, port: 'Z', bit: 0 }] }, 'port'],
    [{ interrupts: [{ irq: 0, port: 'A', bit: 16 }] }, 'bit'],
  ])('rejects invalid config %j', (config, fragment) => {
    expect(() => resolveTeachingMCUConfig(config as never)).toThrow(TeachingMCUError);
    expect(() => resolveTeachingMCUConfig(config as never)).toThrow(fragment as string);
  });

  it('rejects a non-identifier device id', () => {
    expect(() => createTeachingMCUIR('mcu-1')).toThrow(/identifier/);
  });

  it('builds the declared pin space and register names', () => {
    const device = createTeachingMCUIR('mcu', { ports: ['A', 'B'], portWidth: 16 });
    expect(device.type).toBe(TEACHING_MCU_IR_TYPE);
    expect(device.layout.pinNames).toHaveLength(32);
    expect(device.layout.pinNames[0]).toBe('PA0');
    expect(device.layout.pinNames[31]).toBe('PB15');
    expect(device.layout.registerNames).toHaveLength(16);
    expect(device.layout.registerNames[15]).toBe('r15');
    expect(device.device.type).toBe(TEACHING_MCU_IR_TYPE);
    expect(device.device.description.pins).toHaveProperty('PA0');
    expect(device.device.description.pins).toHaveProperty('PB15');
  });
});

describe('M3-class execution', () => {
  it('executes MOVI, ADDI and HALT', () => {
    const device = m3([
      encodeI(Op.MOVI, 0, 0, 5),
      encodeI(Op.ADDI, 0, 0, 3),
      encodeR(Op.HALT, 0, 0, 0),
    ]);
    const { accessor } = createStandalone(device);
    expect(accessor.getPC()).toBe(0);
    accessor.step(3);
    expect(accessor.readRegister('r0')).toBe(8n);
    expect(accessor.getPC()).toBe(12);
    expect(accessor.isHalted()).toBe(true);
    expect(accessor.isFaulted()).toBe(false);
    expect(accessor.getCycles()).toBe(3);
  });

  it('reads and writes the register file through names and indices', () => {
    const device = m3([encodeR(Op.HALT, 0, 0, 0)]);
    const { accessor } = createStandalone(device);
    accessor.writeRegister('r7', 0xdead_beefn);
    expect(accessor.readRegister('R7')).toBe(0xdead_beefn);
    expect(accessor.readRegister(7)).toBe(0xdead_beefn);
    accessor.writeRegister(1, -1);
    expect(accessor.readRegister('r1')).toBe(0xffff_ffffn);
    expect(accessor.getSP()).toBe(RAM_BASE + device.config.ramSize);
    accessor.setSP(0x2000_1000);
    expect(accessor.readRegister('sp')).toBe(0x2000_1000n);
    accessor.setLR(0x1234);
    expect(accessor.getLR()).toBe(0x1234);
  });

  it('computes NZCV flags and follows conditional branches', () => {
    const firmware = wordsToBytes([
      encodeI(Op.MOVI, 0, 0, 3),
      encodeI(Op.MOVI, 1, 0, 5),
      encodeR(Op.CMP, 0, 0, 1),
      encodeB(Cond.GE, 1),
      encodeI(Op.MOVI, 2, 0, 0x1111),
      encodeR(Op.HALT, 0, 0, 0),
    ]);
    const device = createTeachingMCUIR('mcu', { isa: 'm3', firmware });
    const { accessor } = createStandalone(device);
    accessor.step(6);
    // 3 - 5 sets N and clears C; GE is false, so the fall-through MOVI wins.
    expect(accessor.readRegister('r2')).toBe(0x1111n);
    expect(accessor.getFlags()).toEqual({ n: true, z: false, c: false, v: false });
    expect(accessor.isHalted()).toBe(true);
  });

  it('executes ADDS and SUBS flag updates', () => {
    const device = m3([
      encodeI(Op.MOVI, 0, 0, 0xffff),
      encodeI(Op.MOVT, 0, 0, 0xffff),
      encodeI(Op.MOVI, 1, 0, 1),
      encodeR(Op.ADDS, 2, 0, 1),
      encodeR(Op.SUBS, 3, 0, 1),
      encodeR(Op.HALT, 0, 0, 0),
    ]);
    const { accessor } = createStandalone(device);
    accessor.step(4);
    expect(accessor.readRegister('r2')).toBe(0n);
    expect(accessor.getFlags().z).toBe(true);
    expect(accessor.getFlags().c).toBe(true);
    accessor.step();
    expect(accessor.readRegister('r3')).toBe(0xffff_fffen);
    expect(accessor.getFlags().z).toBe(false);
    expect(accessor.getFlags().n).toBe(true);
    expect(accessor.getFlags().c).toBe(true);
  });

  it('wraps u32 addition and branches on the runtime value', () => {
    const firmware = wordsToBytes([
      encodeI(Op.MOVI, 0, 0, 0xffff),
      encodeI(Op.MOVT, 0, 0, 0xffff),
      encodeI(Op.MOVI, 1, 0, 1),
      encodeR(Op.ADDS, 0, 0, 1),
      encodeB(Cond.EQ, 1),
      encodeI(Op.MOVI, 2, 0, 0xdead),
      encodeI(Op.MOVI, 2, 0, 1),
      encodeR(Op.HALT, 0, 0, 0),
    ]);
    const device = createTeachingMCUIR('mcu', { isa: 'm3', firmware });
    const { accessor } = createStandalone(device);
    accessor.step(7);
    expect(accessor.readRegister('r0')).toBe(0n);
    expect(accessor.readRegister('r2')).toBe(1n);
    expect(accessor.getFlags()).toEqual({ n: false, z: true, c: true, v: true });
    expect(accessor.isHalted()).toBe(true);
  });

  it('loads and stores u32/u8 values in RAM', () => {
    const firmware = wordsToBytes([
      encodeI(Op.MOVI, 1, 0, 0x0000),
      encodeI(Op.MOVT, 1, 0, 0x2000),
      encodeI(Op.MOVI, 0, 0, 0x1234),
      encodeI(Op.STR, 0, 1, 0),
      encodeI(Op.MOVI, 0, 0, 0xff),
      encodeI(Op.STRB, 0, 1, 4),
      encodeI(Op.MOVI, 0, 0, 0),
      encodeI(Op.LDR, 0, 1, 0),
      encodeI(Op.LDRB, 2, 1, 4),
      encodeR(Op.HALT, 0, 0, 0),
    ]);
    const device = createTeachingMCUIR('mcu', { isa: 'm3', firmware });
    const { accessor } = createStandalone(device);
    accessor.step(10);
    expect(accessor.readRegister('r0')).toBe(0x1234n);
    expect(accessor.readRegister('r2')).toBe(0xffn);
    expect(accessor.readMemory(RAM_BASE, 4)).toBe(0x1234);
    expect(accessor.readMemory(RAM_BASE + 4, 1)).toBe(0xff);
    expect(accessor.readMemoryBlock(RAM_BASE, 5)).toEqual(
      Uint8Array.from([0x34, 0x12, 0, 0, 0xff]),
    );
  });

  it('reads the flash window through the data path', () => {
    const words = [encodeI(Op.MOVI, 0, 0, 0xbeef), encodeR(Op.HALT, 0, 0, 0)];
    const firmware = wordsToBytes(words);
    const device = createTeachingMCUIR('mcu', { isa: 'm3', firmware });
    const { accessor } = createStandalone(device);
    expect(accessor.readMemory(0, 4)).toBe(words[0]);
    expect(() => accessor.writeMemory(0, 1)).toThrow(TeachingMCUError);
    expect(() => accessor.writeMemory(0, 1)).toThrow(/read-only/);
  });

  it('faults on out-of-range data accesses and unknown instructions', () => {
    const badRam = m3([
      encodeI(Op.MOVI, 1, 0, 0x0000),
      encodeI(Op.MOVT, 1, 0, 0x3000),
      encodeI(Op.LDR, 0, 1, 0),
      encodeR(Op.HALT, 0, 0, 0),
    ]);
    const ramRun = createStandalone(badRam);
    ramRun.accessor.step(3);
    expect(ramRun.accessor.isFaulted()).toBe(true);
    expect(ramRun.accessor.isHalted()).toBe(true);

    const badOpcode = createTeachingMCUIR('mcu', {
      isa: 'm3',
      firmware: wordsToBytes([0xffff_ffff, encodeR(Op.HALT, 0, 0, 0)]),
    });
    const opcodeRun = createStandalone(badOpcode);
    opcodeRun.accessor.step();
    expect(opcodeRun.accessor.isFaulted()).toBe(true);
    expect(opcodeRun.accessor.isHalted()).toBe(true);
  });

  it('runs a branch loop and counts each retired instruction', () => {
    const device = createTeachingMCUIR('mcu', {
      isa: 'm3',
      firmware: loopFirmware(50),
      instructionsPerTick: 8,
      maxBlockInstructions: 8,
    });
    const { accessor } = createStandalone(device);
    accessor.run(40);
    expect(accessor.isHalted()).toBe(true);
    expect(accessor.readRegister('r1')).toBe(50n);
    // 2 setup instructions + 50 iterations × 3 instructions + HALT.
    expect(accessor.getCycles()).toBe(2 + 50 * 3 + 1);
  });

  it('supports WFI sleep and wake-up through an enabled IRQ', () => {
    const words = new Array<number>(0x108 / 4).fill(0);
    words[16] = 0x100;
    words[0x80 / 4] = encodeR(Op.WFI, 0, 0, 0);
    words[0x84 / 4] = encodeI(Op.ADDI, 0, 0, 1);
    words[0x88 / 4] = encodeR(Op.HALT, 0, 0, 0);
    words[0x100 / 4] = encodeR(Op.BX, 0, 14, 0);
    const device = createTeachingMCUIR('mcu', {
      isa: 'm3',
      firmware: wordsToBytes(words),
      pc: 0x80,
    });
    const { accessor } = createStandalone(device);
    accessor.step();
    expect(accessor.isSleeping()).toBe(true);
    expect(accessor.getPC()).toBe(0x84);
    accessor.step();
    expect(accessor.getPC()).toBe(0x84);
    accessor.enableInterrupt(0);
    accessor.raiseInterrupt(0);
    accessor.step();
    // The one-instruction handler (BX LR) enters and returns in the same tick.
    expect(accessor.getIPSR()).toBe(0);
    expect(accessor.isSleeping()).toBe(false);
    expect(accessor.getPC()).toBe(0x84);
    accessor.step();
    expect(accessor.readRegister('r0')).toBe(1n);
    accessor.step();
    expect(accessor.isHalted()).toBe(true);
  });

  it('charges exceptionCycles for interrupt entry', () => {
    const words = new Array<number>(0x108 / 4).fill(0);
    words[16] = 0x100;
    words[0x80 / 4] = encodeI(Op.MOVI, 0, 0, 0);
    words[0x84 / 4] = encodeR(Op.HALT, 0, 0, 0);
    words[0x100 / 4] = encodeR(Op.HALT, 0, 0, 0);
    const device = createTeachingMCUIR('mcu', {
      isa: 'm3',
      firmware: wordsToBytes(words),
      pc: 0x80,
      exceptionCycles: 7,
    });
    const { accessor } = createStandalone(device);
    accessor.enableInterrupt(0);
    accessor.raiseInterrupt(0);
    accessor.step();
    // Seven entry cycles, then the HALT in the handler.
    expect(accessor.getCycles()).toBe(8);
    expect(accessor.getIPSR()).toBe(16);
    expect(accessor.isHalted()).toBe(true);
  });
});

describe('GPIO', () => {
  it('publishes ODR/DIR through the accessor and pin memory', () => {
    const device = createTeachingMCUIR('mcu', { isa: 'm3', firmware: wordsToBytes([0]) });
    const { accessor } = createStandalone(device);
    accessor.writeGPIODirection('A', 0b101);
    accessor.writeGPIO('A', 0b101);
    expect(accessor.readGPIODirection('A')).toBe(0b101);
    expect(accessor.readGPIO('A')).toBe(0b101);
    expect(accessor.readPin('PA0')).toBe(true);
    expect(accessor.readPin('PA1')).toBe(false);
    expect(accessor.readPin('PA2')).toBe(true);
    expect(accessor.readPin('PB0')).toBe(false);
    accessor.writePin('PA3', true);
    expect(accessor.readPin('PA3')).toBe(true);
    expect(() => accessor.readPin('PZ0')).toThrow(/no pin/);
  });

  it('writes GPIO through MMIO stores and samples IDR', () => {
    const firmware = wordsToBytes([
      encodeI(Op.MOVI, 1, 0, 0x0000),
      encodeI(Op.MOVT, 1, 0, 0x4000),
      encodeI(Op.MOVI, 0, 0, 0x0001),
      encodeI(Op.STR, 0, 1, 0x04), // DIR
      encodeI(Op.STR, 0, 1, 0x00), // ODR
      encodeR(Op.HALT, 0, 0, 0),
    ]);
    const device = createTeachingMCUIR('mcu', {
      isa: 'm3',
      firmware,
      initialDirections: { A: 0, B: 0 },
    });
    const { accessor } = createStandalone(device);
    accessor.step(6);
    expect(accessor.readGPIODirection('A')).toBe(1);
    expect(accessor.readGPIO('A')).toBe(1);
    expect(accessor.readPin('PA0')).toBe(true);
  });
});

describe('NVIC', () => {
  it('enters and returns from an interrupt with a full stack frame', () => {
    const device = createTeachingMCUIR('mcu', {
      isa: 'm3',
      firmware: interruptFirmware(),
      pc: 0x80,
    });
    const { accessor } = createStandalone(device);
    const spBefore = accessor.getSP();
    accessor.writeRegister('r4', 0x44);
    accessor.enableInterrupt(0);
    accessor.raiseInterrupt(0);
    accessor.step();
    expect(accessor.getPC()).toBe(0x104);
    expect(accessor.getIPSR()).toBe(16);
    expect(accessor.readRegister('r0')).toBe(7n);
    expect(accessor.isInterruptActive(0)).toBe(true);
    expect(accessor.isInterruptPending(0)).toBe(false);
    expect(accessor.getSP()).toBe(spBefore - 32);
    accessor.step();
    expect(accessor.getIPSR()).toBe(0);
    expect(accessor.isInterruptActive(0)).toBe(false);
    expect(accessor.getSP()).toBe(spBefore);
    expect(accessor.readRegister('r4')).toBe(0x44n);
    expect(accessor.getPC()).toBe(0x80);
    accessor.step();
    expect(accessor.isHalted()).toBe(true);
  });

  it('ignores pending IRQs that are not enabled and can clear pending bits', () => {
    const device = createTeachingMCUIR('mcu', {
      isa: 'm3',
      firmware: interruptFirmware(),
      pc: 0x80,
    });
    const { accessor } = createStandalone(device);
    accessor.raiseInterrupt(0);
    accessor.step();
    expect(accessor.getIPSR()).toBe(0);
    expect(accessor.isInterruptPending(0)).toBe(true);
    accessor.clearInterrupt(0);
    expect(accessor.isInterruptPending(0)).toBe(false);
    accessor.enableInterrupt(0);
    accessor.disableInterrupt(0);
    expect(accessor.readInterruptRegisters().enabled).toBe(0);
  });

  it('does not nest a second exception while one is active', () => {
    const device = createTeachingMCUIR('mcu', {
      isa: 'm3',
      firmware: interruptFirmware(),
      pc: 0x80,
    });
    const { accessor } = createStandalone(device);
    accessor.enableInterrupt(0);
    accessor.enableInterrupt(1);
    accessor.raiseInterrupt(0);
    accessor.raiseInterrupt(1);
    accessor.step();
    expect(accessor.getIPSR()).toBe(16);
    expect(accessor.isInterruptPending(1)).toBe(true);
    accessor.step();
    expect(accessor.getIPSR()).toBe(0);
    expect(accessor.isInterruptPending(1)).toBe(true);
    accessor.step();
    expect(accessor.getIPSR()).toBe(17);
  });
});

describe('legacy teaching ISA parity', () => {
  it('matches the JavaScript reference over 40 blocks', () => {
    const device = createTeachingMCUIR('legacy', { isa: 'teaching' });
    const { accessor } = createStandalone(device);
    const firmware = device.config.firmware;
    for (let blocks = 1; blocks <= 40; blocks += 1) {
      accessor.step();
      const expected = runTeachingReference(firmware, blocks);
      expect(accessor.readRegister('r0')).toBe(BigInt(expected.r0));
      expect(accessor.getPC()).toBe(expected.pc);
      expect(accessor.readPin('PA0')).toBe(expected.gpio);
      expect(accessor.isHalted()).toBe(expected.halted);
      expect(accessor.isFaulted()).toBe(expected.faulted);
    }
  });

  it('applies firmware patches to cached legacy blocks', () => {
    const device = createTeachingMCUIR('legacy', { isa: 'teaching' });
    const { accessor } = createStandalone(device);
    accessor.step();
    expect(accessor.readRegister('r0')).toBe(3n);
    // The first block is ADD 1, ADD 2, JNZ; replace the second immediate.
    accessor.patchFirmware(3, Uint8Array.from([10]));
    accessor.writeRegister('r0', 0);
    accessor.setPC(0);
    accessor.step();
    expect(accessor.readRegister('r0')).toBe(11n);
    expect(accessor.getPC()).toBe(8);
  });

  it('halts on the legacy HALT opcode and faults on unknown opcodes', () => {
    const halted = createTeachingMCUIR('legacy', {
      isa: 'teaching',
      firmware: Uint8Array.from([0x10, 5, 0x00, 0x00]),
    });
    const haltedRun = createStandalone(halted);
    haltedRun.accessor.step();
    expect(haltedRun.accessor.readRegister('r0')).toBe(5n);
    expect(haltedRun.accessor.isHalted()).toBe(true);

    const faulted = createTeachingMCUIR('legacy', {
      isa: 'teaching',
      firmware: Uint8Array.from([0xff, 0x00]),
    });
    const faultedRun = createStandalone(faulted);
    faultedRun.accessor.step();
    expect(faultedRun.accessor.isFaulted()).toBe(true);
    expect(faultedRun.accessor.isHalted()).toBe(true);
  });
});

describe('accessor surface', () => {
  it('exposes state aliases and a complete snapshot', () => {
    const device = m3([encodeR(Op.HALT, 0, 0, 0)]);
    const { accessor } = createStandalone(device);
    expect(accessor.getState('stopped')).toBe(false);
    expect(accessor.getState('guestFault')).toBe(false);
    accessor.setState('stopped', true);
    expect(accessor.isHalted()).toBe(true);
    expect(accessor.getState('halted')).toBe(true);
    expect(() => accessor.setState('nope', 1)).toThrow(/Register|no state/i);
    const snapshot = accessor.snapshot();
    expect(snapshot.registers).toHaveLength(16);
    expect(snapshot.gpio).toHaveProperty('A');
    expect(snapshot.gpio).toHaveProperty('B');
    expect(snapshot.nvic.enabled).toBe(0);
    expect(accessor.stateNames).toContain('pc');
    expect(accessor.registerNames).toContain('xpsr');
    expect(accessor.isa).toBe('m3');
    expect(accessor.ports).toEqual(['A', 'B']);
  });

  it('rejects unknown registers, ports and states', () => {
    const device = m3([encodeR(Op.HALT, 0, 0, 0)]);
    const { accessor } = createStandalone(device);
    expect(() => accessor.readRegister('q7')).toThrow(/Register/);
    expect(() => accessor.writeRegister('r99', 1)).toThrow(/outside/);
    expect(() => accessor.readGPIO('Z')).toThrow(/Port/);
    expect(() => accessor.getState('nope')).toThrow(/no state/);
    expect(() => accessor.raiseInterrupt(32)).toThrow(/IRQ/);
  });

  it('reports flash writes and out-of-range addresses', () => {
    const device = m3([encodeR(Op.HALT, 0, 0, 0)]);
    const { accessor } = createStandalone(device);
    expect(() => accessor.writeMemory(0, 0)).toThrow(/read-only/);
    expect(() => accessor.readMemory(0x1000_0000)).toThrow(/outside/);
    expect(() => accessor.readMemoryBlock(0x1000_0000, 1)).toThrow(/outside/);
  });

  it('requires a runner for step() when none was supplied', () => {
    const device = m3([encodeR(Op.HALT, 0, 0, 0)]);
    const { jit } = createStandalone(device);
    const accessor = device.buildAccessor(jit.storage);
    expect(() => accessor.step()).toThrow(/without a runner/);
    expect(() => accessor.step(0)).not.toThrow();
  });

  it('builds an accessor from the layout registry', () => {
    const device = m3([encodeR(Op.HALT, 0, 0, 0)]);
    const { jit } = createStandalone(device);
    const accessor = buildAccessor(device.id, jit.storage);
    expect(accessor.deviceId).toBe('mcu');
    expect(accessor.getPC()).toBe(0);
    expect(accessor.readRegister('r0')).toBe(0n);
  });

  it('writes memory blocks and syncs GPIO words', () => {
    const device = createTeachingMCUIR('mcu', { isa: 'm3', firmware: wordsToBytes([0]) });
    const { accessor } = createStandalone(device);
    accessor.writeMemoryBlock(RAM_BASE, Uint8Array.from([1, 2, 3, 4]));
    expect(accessor.readMemoryBlock(RAM_BASE, 4)).toEqual(Uint8Array.from([1, 2, 3, 4]));
    // ODR at 0x40000000, DIR at 0x40000004.
    accessor.writeMemory(0x4000_0004, 1, 4);
    accessor.writeMemory(0x4000_0000, 1, 4);
    expect(accessor.readPin('PA0')).toBe(true);
  });

  it('patches firmware and invalidates cached provider blocks', () => {
    const device = m3([encodeI(Op.MOVI, 0, 0, 1), encodeR(Op.HALT, 0, 0, 0)]);
    const { accessor } = createStandalone(device);
    accessor.step();
    expect(accessor.readRegister('r0')).toBe(1n);
    accessor.patchFirmware(0, wordsToBytes([encodeI(Op.MOVI, 0, 0, 2)]));
    accessor.setPC(0);
    accessor.step();
    expect(accessor.readRegister('r0')).toBe(2n);
    expect(accessor.readMemory(0, 4)).toBe(encodeI(Op.MOVI, 0, 0, 2));
    expect(() => accessor.patchFirmware(device.config.flashSize, Uint8Array.from([0]))).toThrow(
      /outside flash/,
    );
  });
});
