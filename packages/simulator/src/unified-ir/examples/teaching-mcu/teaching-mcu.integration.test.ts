import { describe, expect, it } from 'vitest';
import { createLedDescription } from '../../compiler';
import { Circuit } from '../../runtime';
import {
  createTeachingMCUCircuit,
  createTeachingMCUIR,
  RAM_BASE,
  TEACHING_MCU_IR_TYPE,
  type TeachingMCUAccessor,
  type TeachingMCUConfig,
} from './index';
import {
  Cond,
  Op,
  encodeB,
  encodeI,
  encodeR,
  interruptFirmware,
  loopFirmware,
  wordsToBytes,
} from './teaching-mcu.test-helpers';

function mcuInput(
  config: TeachingMCUConfig,
  connections: readonly { readonly from: string; readonly to: string }[] = [],
) {
  const mcu = createTeachingMCUIR('mcu', config);
  return {
    mcu,
    input: {
      devices: [
        {
          id: 'mcu',
          type: TEACHING_MCU_IR_TYPE,
          description: mcu.device.description,
        },
      ],
      connections,
    } as const,
  };
}

function mcuLedInput(config: TeachingMCUConfig) {
  const mcu = createTeachingMCUIR('mcu', config);
  return {
    mcu,
    input: {
      devices: [
        {
          id: 'mcu',
          type: TEACHING_MCU_IR_TYPE,
          description: mcu.device.description,
        },
        { id: 'led1', type: 'ideal-led' as const, description: createLedDescription() },
      ],
      connections: [
        { from: 'mcu.PA0', to: 'led1.anode' },
        { from: 'led1.cathode', to: 'GND' },
      ],
    } as const,
  };
}

function assertMcu(accessor: unknown): asserts accessor is TeachingMCUAccessor {
  if (typeof (accessor as TeachingMCUAccessor).getPC !== 'function') {
    throw new Error('expected a typed teaching MCU accessor');
  }
}

describe('circuit integration', () => {
  it('creates a circuit with the typed teaching MCU accessor', async () => {
    const { input } = mcuInput({
      isa: 'm3',
      firmware: wordsToBytes([encodeR(Op.HALT, 0, 0, 0)]),
    });
    const circuit = await Circuit.create(input);
    const accessor = circuit.devices.mcu;
    assertMcu(accessor);
    expect(accessor.deviceId).toBe('mcu');
    expect(accessor.type).toBe(TEACHING_MCU_IR_TYPE);
    expect(accessor.pinNames).toContain('PA0');
    expect(accessor.pinNames).toContain('PB15');
    expect(accessor.registerNames).toContain('r15');
    expect(accessor.getPC()).toBe(0);
    circuit.dispose();
  });

  it('patches firmware through the circuit accessor', async () => {
    const { input } = mcuInput({
      isa: 'm3',
      firmware: wordsToBytes([encodeI(Op.MOVI, 0, 0, 1), encodeR(Op.HALT, 0, 0, 0)]),
    });
    const circuit = await Circuit.create(input);
    const accessor = circuit.devices.mcu;
    assertMcu(accessor);
    accessor.patchFirmware(0, wordsToBytes([encodeI(Op.MOVI, 0, 0, 7)]));
    circuit.step();
    expect(accessor.readRegister('r0')).toBe(7n);
    circuit.reset();
    circuit.step();
    expect(accessor.readRegister('r0')).toBe(1n);
    circuit.dispose();
  });

  it('publishes host GPIO writes to the electrical solve in the same tick', async () => {
    const { input } = mcuLedInput({
      isa: 'm3',
      firmware: wordsToBytes([encodeR(Op.HALT, 0, 0, 0)]),
    });
    const circuit = await Circuit.create(input);
    assertMcu(circuit.devices.mcu);
    expect(circuit.devices.led1.isOn()).toBe(false);
    circuit.devices.mcu.writeGPIODirection('A', 1);
    circuit.devices.mcu.writeGPIO('A', 1);
    circuit.step();
    expect(circuit.getPin('mcu.PA0')).toBe(true);
    expect(circuit.getPin('led1.anode')).toBe(true);
    expect(circuit.devices.led1.isOn()).toBe(true);
    circuit.devices.mcu.writeGPIO('A', 0);
    circuit.step();
    expect(circuit.devices.led1.isOn()).toBe(false);
    circuit.dispose();
  });

  it('drives the LED from guest MMIO stores', async () => {
    const firmware = wordsToBytes([
      encodeI(Op.MOVI, 1, 0, 0x0000),
      encodeI(Op.MOVT, 1, 0, 0x4000),
      encodeI(Op.MOVI, 0, 0, 0x0001),
      encodeI(Op.STR, 0, 1, 0x04), // DIR
      encodeI(Op.STR, 0, 1, 0x00), // ODR
      encodeR(Op.HALT, 0, 0, 0),
    ]);
    const { input } = mcuLedInput({ isa: 'm3', firmware });
    const circuit = await Circuit.create(input);
    assertMcu(circuit.devices.mcu);
    circuit.runBatch(6);
    expect(circuit.devices.mcu.readGPIO('A')).toBe(1);
    expect(circuit.devices.mcu.isHalted()).toBe(true);
    expect(circuit.devices.led1.isOn()).toBe(true);
    circuit.dispose();
  });

  it('writes RAM from the host and reads it from the guest', async () => {
    const firmware = wordsToBytes([
      encodeI(Op.MOVI, 1, 0, 0x0000),
      encodeI(Op.MOVT, 1, 0, 0x2000),
      encodeI(Op.ADDI, 1, 1, 0x100),
      encodeI(Op.LDR, 0, 1, 0),
      encodeR(Op.HALT, 0, 0, 0),
    ]);
    const { input } = mcuInput({ isa: 'm3', firmware });
    const circuit = await Circuit.create(input);
    assertMcu(circuit.devices.mcu);
    circuit.devices.mcu.writeMemory(RAM_BASE + 0x100, 0xabcd, 4);
    circuit.runBatch(5);
    expect(circuit.devices.mcu.readRegister('r0')).toBe(0xabcdn);
    circuit.dispose();
  });

  it('enters an IRQ and publishes GPIO changes from the handler', async () => {
    const words = new Array<number>(0x120 / 4).fill(0);
    words[16] = 0x100;
    words[0x80 / 4] = encodeI(Op.MOVI, 3, 0, 0x55);
    words[0x84 / 4] = encodeR(Op.HALT, 0, 0, 0);
    words[0x100 / 4] = encodeI(Op.MOVI, 1, 0, 0x0000);
    words[0x104 / 4] = encodeI(Op.MOVT, 1, 0, 0x4000);
    words[0x108 / 4] = encodeI(Op.MOVI, 0, 0, 0x0001);
    words[0x10c / 4] = encodeI(Op.STR, 0, 1, 0x04);
    words[0x110 / 4] = encodeI(Op.STR, 0, 1, 0x00);
    words[0x114 / 4] = encodeR(Op.BX, 0, 14, 0);
    const { input } = mcuLedInput({
      isa: 'm3',
      firmware: wordsToBytes(words),
      pc: 0x80,
    });
    const circuit = await Circuit.create(input);
    assertMcu(circuit.devices.mcu);
    circuit.devices.mcu.enableInterrupt(0);
    circuit.devices.mcu.raiseInterrupt(0);
    circuit.runBatch(8);
    expect(circuit.devices.mcu.getIPSR()).toBe(0);
    expect(circuit.devices.mcu.isInterruptActive(0)).toBe(false);
    // The handler's r0 write was restored from the exception frame.
    expect(circuit.devices.mcu.readRegister('r0')).toBe(0n);
    expect(circuit.devices.mcu.readRegister('r3')).toBe(0x55n);
    expect(circuit.devices.led1.isOn()).toBe(true);
    // The handler returned to the main program, which then halted.
    expect(circuit.devices.mcu.isHalted()).toBe(true);
    circuit.dispose();
  });

  it('keeps single-step and batch execution semantically identical', async () => {
    const firmware = loopFirmware(100);
    const stepped = mcuInput({ isa: 'm3', firmware, instructionsPerTick: 1 });
    const batched = mcuInput({ isa: 'm3', firmware, instructionsPerTick: 1 });
    const stepCircuit = await Circuit.create(stepped.input);
    const batchCircuit = await Circuit.create(batched.input);
    assertMcu(stepCircuit.devices.mcu);
    assertMcu(batchCircuit.devices.mcu);
    const ticks = 2 + 100 * 3 + 1;
    for (let index = 0; index < ticks; index += 1) stepCircuit.step();
    batchCircuit.runBatch(ticks);
    for (const name of ['r0', 'r1', 'r2', 'pc', 'cycles', 'xpsr']) {
      expect(batchCircuit.devices.mcu.readRegister(name)).toBe(
        stepCircuit.devices.mcu.readRegister(name),
      );
    }
    expect(batchCircuit.devices.mcu.isHalted()).toBe(true);
    expect(stepCircuit.devices.mcu.isHalted()).toBe(true);
    stepCircuit.dispose();
    batchCircuit.dispose();
  });

  it('resets the device, the pins and the tick counter', async () => {
    const { input } = mcuLedInput({
      isa: 'm3',
      firmware: wordsToBytes([encodeR(Op.HALT, 0, 0, 0)]),
    });
    const circuit = await Circuit.create(input);
    assertMcu(circuit.devices.mcu);
    circuit.devices.mcu.writeGPIODirection('A', 1);
    circuit.devices.mcu.writeGPIO('A', 1);
    circuit.step();
    expect(circuit.devices.led1.isOn()).toBe(true);
    expect(circuit.tickCount).toBe(1n);
    circuit.reset();
    expect(circuit.tickCount).toBe(0n);
    expect(circuit.devices.mcu.getPC()).toBe(0);
    expect(circuit.devices.mcu.readGPIO('A')).toBe(0);
    expect(circuit.devices.mcu.readGPIODirection('A')).toBe(0);
    expect(circuit.devices.led1.isOn()).toBe(false);
    circuit.dispose();
  });

  it('rejects accessor calls after dispose', async () => {
    const { input } = mcuInput({
      isa: 'm3',
      firmware: wordsToBytes([encodeR(Op.HALT, 0, 0, 0)]),
    });
    const circuit = await Circuit.create(input);
    assertMcu(circuit.devices.mcu);
    const accessor = circuit.devices.mcu;
    circuit.dispose();
    expect(() => accessor.getPC()).toThrow(/disposed/);
    expect(() => accessor.step()).toThrow(/disposed/);
  });

  it('exposes a one-device circuit factory', async () => {
    const circuit = await createTeachingMCUCircuit('mcu', {
      isa: 'm3',
      firmware: wordsToBytes([encodeR(Op.HALT, 0, 0, 0)]),
    });
    const accessor = circuit.devices.mcu;
    expect(accessor.getPC()).toBe(0);
    circuit.step();
    expect(accessor.isHalted()).toBe(true);
    circuit.dispose();
  });

  it('supports conditional branches through the circuit loop', async () => {
    const firmware = wordsToBytes([
      encodeI(Op.MOVI, 0, 0, 0),
      encodeI(Op.ADDI, 0, 0, 1),
      encodeI(Op.CMPI, 0, 0, 5),
      encodeB(Cond.NE, -3),
      encodeR(Op.HALT, 0, 0, 0),
    ]);
    const { input } = mcuInput({ isa: 'm3', firmware, instructionsPerTick: 1 });
    const circuit = await Circuit.create(input);
    assertMcu(circuit.devices.mcu);
    circuit.runBatch(20);
    expect(circuit.devices.mcu.readRegister('r0')).toBe(5n);
    expect(circuit.devices.mcu.isHalted()).toBe(true);
    circuit.dispose();
  });

  it('reports IRQ state and NVIC words through the accessor', async () => {
    const { input } = mcuInput({
      isa: 'm3',
      firmware: interruptFirmware(),
      pc: 0x80,
    });
    const circuit = await Circuit.create(input);
    assertMcu(circuit.devices.mcu);
    circuit.devices.mcu.enableInterrupt(3);
    expect(circuit.devices.mcu.readInterruptRegisters().enabled).toBe(1 << 3);
    circuit.devices.mcu.raiseInterrupt(3);
    expect(circuit.devices.mcu.isInterruptPending(3)).toBe(true);
    circuit.devices.mcu.clearInterrupt(3);
    expect(circuit.devices.mcu.isInterruptPending(3)).toBe(false);
    circuit.dispose();
  });
});
