import { describe, expect, it } from 'vitest';
import { I2cProgram, idleFirmware } from './i2c-firmware';
import { createI2cHarness } from './i2c-harness';

/**
 * CT117E-M4 §2：AT24C02（0x50）与 MCP4017（0x2F）共用 PB6/PB7 bit-bang I²C。
 *
 * 固件是真实 Thumb 机器码，从 `dist/model.js` 的 MCU JIT 执行，只通过 GPIOB
 * BSRR/MODER/ODR 拉低/释放 PB6/PB7；ACK、读数据、NACK 和 STOP 都由物理总线电平
 * 决定。测试只读 SRAM 结果槽与 manifest 方法/事件，不直接改模型 EEPROM/wiper 状态。
 */

function result(
  harness: { memory(name: string): Uint8Array },
  firmware: ReturnType<I2cProgram['build']>,
  slot: number,
): number {
  return firmware.readResult(harness.memory('sram'), slot);
}

describe('CT117E-M4 板载 I²C', () => {
  it('真实主控拉低只看 GPIO 输出/时钟；输入弱下拉与 OD 释放都读高', async () => {
    const program = new I2cProgram();

    // PB6/PB7 输出开漏；先把 SCL 拉到低，避免构造 SDA 低时产生 START。
    program.setModer(0x5000);
    program.setOtyper(0x00c0);
    program.setPupdr(0);
    program.setScl(false);
    program.setSda(false);
    const outputLow = program.sampleSda();

    // PB7 改成输入 + 弱下拉。意图仍朝地，但不是开漏主动拉低。
    program.setModer(0x1000);
    program.setPupdr(0x8000);
    const inputPullDown = program.sampleSda();

    // 恢复推/开漏输出，ODR=1 释放。
    program.setModer(0x5000);
    program.setPupdr(0);
    program.setOtyper(0x00c0);
    program.setSda(true);
    const openDrainRelease = program.sampleSda();

    // 输出低后关闭 GPIOB 时钟：不能再算主动拉低。
    program.setSda(false);
    program.setGpioClock(false);
    const clockOff = program.sampleSda();
    program.setGpioClock(true);

    // PB6/PB7 都改成输入弱下拉：外部 10 kΩ 上拉仍给出高电平。
    program.setModer(0x0000);
    program.setPupdr(0xc000);
    const sclPullDown = program.sampleScl();
    const sdaPullDown = program.sampleSda();
    program.spin();

    const firmware = program.build();
    const harness = await createI2cHarness({ firmware: firmware.image });

    try {
      harness.run(5_000_000_000);

      expect(harness.errors).toEqual([]);
      expect(harness.faults).toEqual([]);
      expect(result(harness, firmware, outputLow)).toBe(0);
      expect(result(harness, firmware, inputPullDown)).toBe(1);
      expect(result(harness, firmware, openDrainRelease)).toBe(1);
      expect(result(harness, firmware, clockOff)).toBe(1);
      expect(result(harness, firmware, sclPullDown)).toBe(1);
      expect(result(harness, firmware, sdaPullDown)).toBe(1);
    } finally {
      harness.dispose();
    }
  });

  it('EEPROM 单字节写→重复 START 随机读回一致；ACK 窗口翻转主控 SDA 不产生边沿', async () => {
    const program = new I2cProgram();

    program.start();
    const ackWindow = program.writeByteWithAckToggles(0xa0);
    const wordAck = program.writeByte(0x10);
    const dataAck = program.writeByte(0x5a);
    program.stop();

    program.start();
    const randomAddressAck = program.writeByte(0xa0);
    const randomWordAck = program.writeByte(0x10);
    program.start();
    const readAddressAck = program.writeByte(0xa1);
    const value = program.readByte(false);
    const released = program.sampleSda();
    program.stop();
    program.spin();

    const firmware = program.build();
    const harness = await createI2cHarness({ firmware: firmware.image });

    try {
      harness.run(5_000_000_000);

      expect(harness.errors).toEqual([]);
      expect(harness.faults).toEqual([]);
      // ACK 高窗口内三次采样（释放、再次拉低、再次释放）都仍是低。
      for (const slot of ackWindow)
        expect(result(harness, firmware, slot), `ACK slot ${slot}`).toBe(0);
      for (const slot of [wordAck, dataAck, randomAddressAck, randomWordAck, readAddressAck])
        expect(result(harness, firmware, slot), `ACK slot ${slot}`).toBe(0);

      expect(result(harness, firmware, value)).toBe(0x5a);
      // NACK 后主机和从机都释放 SDA；不是只检查内部 phase。
      expect(result(harness, firmware, released)).toBe(1);
      expect(harness.state('i2cSdaLow')).toBe(false);

      const image = harness.readEeprom();

      expect(image[0x10]).toBe(0x5a);
      expect(harness.eepromWrites).toContainEqual({ address: 0x10, value: 0x5a });
    } finally {
      harness.dispose();
    }
  });

  it('EEPROM 写指针在 8 B 页内回卷，跨页不串写', async () => {
    const program = new I2cProgram();

    program.start();
    program.writeByte(0xa0);
    program.writeByte(0x06);
    for (let value = 0x11; value <= 0x18; value += 1) program.writeByte(value);
    program.stop();

    program.start();
    program.writeByte(0xa0);
    program.writeByte(0x0f);
    program.writeByte(0xaa);
    program.writeByte(0xbb);
    program.stop();
    program.spin();

    const firmware = program.build();
    const harness = await createI2cHarness({ firmware: firmware.image });

    try {
      harness.run(5_000_000_000);

      const image = harness.readEeprom();

      expect(harness.errors).toEqual([]);
      expect(harness.faults).toEqual([]);
      // 0x06 页 = 0x00..0x07：第 3 个数据字节回卷到 0x00。
      expect([...image.subarray(0x00, 0x08)]).toEqual([
        0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x11, 0x12,
      ]);
      expect(image[0x08]).toBe(0x00);
      // 0x0f 页 = 0x08..0x0f：第二个数据字节回到 0x08。
      expect(image[0x0f]).toBe(0xaa);
      expect(image[0x08]).toBe(0xbb);
      expect(
        harness.eepromWrites.filter((event) => event.address >= 0x08 && event.address <= 0x0f),
      ).toEqual([
        { address: 0x0f, value: 0xaa },
        { address: 0x08, value: 0xbb },
      ]);
    } finally {
      harness.dispose();
    }
  });

  it('EEPROM 当前地址读跨 0xFF→0x00 回卷', async () => {
    const program = new I2cProgram();

    program.start();
    program.writeByte(0xa0);
    program.writeByte(0xfe);
    program.writeByte(0x11);
    program.writeByte(0x22);
    program.stop();

    program.start();
    program.writeByte(0xa0);
    program.writeByte(0xff);
    program.start();
    program.writeByte(0xa1);
    const low = program.readByte(true);
    const wrap = program.readByte(true);
    const final = program.readByte(false);
    program.stop();
    program.spin();

    const firmware = program.build();
    const harness = await createI2cHarness({ firmware: firmware.image });

    try {
      harness.run(5_000_000_000);

      expect(harness.errors).toEqual([]);
      expect(result(harness, firmware, low)).toBe(0x22);
      expect(result(harness, firmware, wrap)).toBe(0x00);
      expect(result(harness, firmware, final)).toBe(0x00);
      expect(harness.state('i2cSdaLow')).toBe(false);
      expect(harness.state('i2cPhase')).toBe(0);
    } finally {
      harness.dispose();
    }
  });

  it('只应答 0x50/0x2F：general call 与 0x51 NACK，忽略阶段不驱动 SDA', async () => {
    const program = new I2cProgram();

    program.start();
    const general = program.writeByte(0x00);
    const generalData = program.writeByte(0x5a);
    program.stop();

    program.start();
    const eepromNeighbour = program.writeByte(0xa2);
    const neighbourData = program.writeByte(0x5a);
    program.stop();

    program.start();
    const eepromAddress = program.writeByte(0xa0);
    const eepromWord = program.writeByte(0x40);
    const eepromData = program.writeByte(0x5a);
    program.stop();

    program.start();
    const potAddress = program.writeByte(0x5e);
    const potData = program.writeByte(0x20);
    program.stop();
    program.spin();

    const firmware = program.build();
    const harness = await createI2cHarness({ firmware: firmware.image });

    try {
      harness.run(5_000_000_000);

      expect(harness.errors).toEqual([]);
      expect(result(harness, firmware, general)).toBe(1);
      expect(result(harness, firmware, generalData)).toBe(1);
      expect(result(harness, firmware, eepromNeighbour)).toBe(1);
      expect(result(harness, firmware, neighbourData)).toBe(1);
      expect(result(harness, firmware, eepromAddress)).toBe(0);
      expect(result(harness, firmware, eepromWord)).toBe(0);
      expect(result(harness, firmware, eepromData)).toBe(0);
      expect(result(harness, firmware, potAddress)).toBe(0);
      expect(result(harness, firmware, potData)).toBe(0);

      expect(harness.readEeprom()[0x40]).toBe(0x5a);
      expect(harness.query('getWiper')).toBe(0x20);
    } finally {
      harness.dispose();
    }
  });

  it('MCP4017 写/读 wiper、低 7 位截断与重复 START', async () => {
    const program = new I2cProgram();

    program.start();
    program.writeByte(0x5e);
    program.writeByte(0x60);
    program.start();
    program.writeByte(0x5f);
    const first = program.readByte(false);
    program.stop();

    program.start();
    program.writeByte(0x5e);
    program.writeByte(0xff);
    program.stop();
    program.start();
    program.writeByte(0x5f);
    const saturated = program.readByte(false);
    program.stop();

    program.start();
    program.writeByte(0x5e);
    program.writeByte(0x80);
    program.stop();
    program.start();
    program.writeByte(0x5f);
    const zero = program.readByte(false);
    program.stop();
    program.spin();

    const firmware = program.build();
    const harness = await createI2cHarness({ firmware: firmware.image });

    try {
      expect(harness.query('getWiper')).toBe(0x3f);
      harness.run(5_000_000_000);

      expect(harness.errors).toEqual([]);
      expect(result(harness, firmware, first)).toBe(0x60);
      expect(result(harness, firmware, saturated)).toBe(0x7f);
      expect(result(harness, firmware, zero)).toBe(0x00);
      expect(harness.query('getWiper')).toBe(0x00);
      expect(harness.wiperEvents).toEqual([0x3f, 0x60, 0x7f, 0x00]);
      expect(harness.state('potWiper')).toBe(0x00);
    } finally {
      harness.dispose();
    }
  });

  it('宿主 readEeprom/writeEeprom/getWiper/setWiper 与事件边界', async () => {
    const harness = await createI2cHarness({ firmware: idleFirmware() });

    try {
      harness.run(1_000_000_000);
      expect(harness.errors).toEqual([]);

      const initial = harness.readEeprom();

      expect(initial).toBeInstanceOf(Uint8Array);
      expect(initial).toHaveLength(256);
      expect(initial.every((value) => value === 0)).toBe(true);
      expect(harness.query('getWiper')).toBe(0x3f);

      // readEeprom 必须是独立快照：改返回值不能影响模型内存。
      initial[0x10] = 0x7e;
      expect(harness.readEeprom()[0x10]).toBe(0x00);

      // address 0xFE 起 3 B：0xFE、0xFF、0x00 回卷。
      harness.query('writeEeprom', {
        address: 0xfe,
        data: Uint8Array.of(0x11, 0x22, 0x33),
      });
      harness.run(1_000_000_000);

      let image = harness.readEeprom();

      expect(image[0xfe]).toBe(0x11);
      expect(image[0xff]).toBe(0x22);
      expect(image[0x00]).toBe(0x33);
      expect(harness.eepromWrites).toEqual([
        { address: 0xfe, value: 0x11 },
        { address: 0xff, value: 0x22 },
        { address: 0x00, value: 0x33 },
      ]);

      const written = harness.eepromWrites.length;

      harness.query('writeEeprom', {
        address: 0xfe,
        data: Uint8Array.of(0x11, 0x22, 0x33),
      });
      harness.run(1_000_000_000);
      expect(harness.eepromWrites).toHaveLength(written);

      harness.query('setWiper', 0);
      harness.run(1_000_000_000);
      expect(harness.query('getWiper')).toBe(0);
      expect(harness.wiperEvents).toEqual([0x3f, 0]);

      harness.query('setWiper', 0);
      harness.run(1_000_000_000);
      expect(harness.wiperEvents).toEqual([0x3f, 0]);

      harness.query('setWiper', 127);
      harness.run(1_000_000_000);
      expect(harness.query('getWiper')).toBe(127);
      expect(harness.wiperEvents).toEqual([0x3f, 0, 127]);

      expect(() => harness.query('setWiper', 128)).toThrow(/wiper/i);
      expect(() => harness.query('setWiper', -1)).toThrow(/wiper/i);
      expect(() => harness.query('writeEeprom', { address: 256, data: Uint8Array.of(1) })).toThrow(
        /address/i,
      );
      expect(() => harness.query('writeEeprom', { address: 0, data: new Uint8Array(0) })).toThrow(
        /data/i,
      );

      image = harness.readEeprom();
      expect(image[0xfe]).toBe(0x11);
      expect(harness.faults).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

  it('宿主 writeEeprom 输入队列满时明确报错，不静默丢写命令', async () => {
    const harness = await createI2cHarness({ firmware: idleFirmware() });

    try {
      harness.run(1_000_000_000);
      for (let index = 0; index < 16; index += 1)
        harness.query('writeEeprom', {
          address: index,
          data: Uint8Array.of(index),
        });

      expect(() =>
        harness.query('writeEeprom', {
          address: 16,
          data: Uint8Array.of(16),
        }),
      ).toThrow(/overflow|CHANNEL/i);
    } finally {
      harness.dispose();
    }
  });

  it('MCP4017 wiper 经 PB14/ADC1_IN5 三点读数符合 10 kΩ 公式', async () => {
    const expectedCode = (code: number): number => {
      const rwb = (100_000 * code) / 127 + 100;
      return Math.floor((rwb / (10_000 + rwb)) * 4095);
    };

    for (const code of [0, 63, 127]) {
      const program = new I2cProgram();

      program.start();
      program.writeByte(0x5e);
      program.writeByte(code);
      program.stop();
      const slot = program.sampleAdc(5);
      program.spin();

      const firmware = program.build();
      const harness = await createI2cHarness({ firmware: firmware.image });

      try {
        harness.run(10_000_000_000);

        expect(harness.errors, `code ${code}`).toEqual([]);
        expect(harness.faults, `code ${code}`).toEqual([]);
        expect(result(harness, firmware, slot), `code ${code} ADC`).toBe(expectedCode(code));
      } finally {
        harness.dispose();
      }
    }
  });
});
