import type { Value } from '@mica-js/ir';
import type { DeviceBehaviorApi, DeviceDescription } from '@mica-js/simulator';
import { LOGIC_VOLTAGE, packagePins } from './shared';

/**
 * 256-byte I²C EEPROM at address `0x50` (RFC 0002 open-drain + weak pull-up).
 *
 * Both bus lines are declared `bidirectional` and driven as **open-drain** with
 * a weak **pull-up**. The part never drives a line high: it either releases it
 * (the pull-up wins, the network reads 1) or sinks it (the network reads 0). A
 * second driver that also sinks the line therefore cannot create a short — the
 * wired-AND of the bus is exactly what RFC 0002 describes.
 *
 * Command path on the wire (write direction):
 *
 * ```text
 * START | address byte (0x50 << 1 | R/W) | ACK | data byte | ACK | … | STOP
 * ```
 *
 * The address byte is decoded (ACK versus NACK, write versus read) but it does
 * **not** move the internal pointer: data bytes continue at the pointer last set
 * by an earlier transaction or by the `address` topic. That keeps the model to
 * one address byte instead of the two a real 24Cxx needs.
 *
 * `WP` high blocks stores, so the part can be demonstrated as read-only.
 * Master-read is not shifted out on the wire; the `read` topic performs the same
 * array load so the bench can exercise the whole memory.
 */

/** Package device id of the EEPROM. */
export const I2C_EEPROM_DEVICE = 'lab:i2c-eeprom';

/** IR device type of the EEPROM. */
export const I2C_EEPROM_TYPE = 'i2c-eeprom';

/** 7-bit bus address; the address byte is `0x50 << 1`. */
export const I2C_EEPROM_ADDRESS = 0x50;

/** Size of the array in bytes. */
export const I2C_EEPROM_SIZE = 256;

/** Pins block of the device-package description. */
export const I2C_EEPROM_PACKAGE = Object.freeze({
  pins: {
    ...packagePins(['SCL', 'SDA'], 'left'),
    WP: { kind: 'signal', side: 'left' },
  },
  pinGroups: {
    bus: { pins: ['SCL', 'SDA'] },
  },
  ports: {
    address: {
      title: '地址',
      description: '宿主写入 0–255 的字节地址；随后的 data 写入落在该地址。',
      direction: 'input',
      type: 'number',
    },
    data: {
      title: '写入',
      description: '宿主写入一个字节，地址自动加一（绕回 0）。',
      direction: 'input',
      type: 'number',
    },
    read: {
      title: '读取',
      description: '投递任意布尔值，把当前地址的字节发布到 value。',
      direction: 'input',
      type: 'boolean',
    },
    value: {
      title: '读出字节',
      description: '最近一次读取的字节（0–255）。',
      direction: 'output',
      type: 'number',
    },
    ack: {
      title: 'ACK',
      description: '从机正在拉低 SDA 应答时为 true。',
      direction: 'output',
      type: 'boolean',
    },
  },
  designatorPrefix: 'U',
});

const SCL = 'SCL';
const SDA = 'SDA';
const WP = 'WP';

type CellReader = (index: Value<'u32'>) => Value<'u8'>;
type CellWriter = (index: Value<'u32'>, value: Value<'u8'>) => void;

function initialize(api: DeviceBehaviorApi): void {
  const b = api.builder;
  // RFC 0002: open-drain drive plus a weak pull-up is the I²C idle state.
  api.pin(SCL).configure('open-drain');
  api.pin(SCL).pull('up');
  api.pin(SDA).configure('open-drain');
  api.pin(SDA).pull('up');
  // An open-drain pin with a `false` latch sinks the line, so both lines start
  // released.
  api.pin(SCL).writeDigital(b.const('bool', true));
  api.pin(SDA).writeDigital(b.const('bool', true));
  api.pin(WP).configure('high-z');
  api.pin(WP).pull('down');

  api.topics.subscribe('address', (handler) => {
    const value = handler.args[0];
    if (value === undefined) return;
    handler
      .state<'u32'>('address')
      .store(handler.builder.convert.floatToInt('u32', value as Value<'f64'>));
  });
  api.topics.subscribe('data', (handler) => {
    const value = handler.args[0];
    if (value === undefined) return;
    handler
      .state<'u32'>('write')
      .store(handler.builder.convert.floatToInt('u32', value as Value<'f64'>));
    handler.state<'bool'>('store').store(handler.builder.const('bool', true));
  });
  api.topics.subscribe('read', (handler) => {
    handler.state<'bool'>('load').store(handler.builder.const('bool', true));
  });
}

/** One tick of the I²C slave: clock recovery, byte assembly and the ACK sink. */
function tick(api: DeviceBehaviorApi, readCell: CellReader, writeCell: CellWriter): void {
  const b = api.builder;
  const scl = api.pin(SCL).sampleDigital();
  const sda = api.pin(SDA).sampleDigital();
  const writeProtected = api.pin(WP).sampleDigital();

  const previousScl = api.state<'bool'>('scl');
  const previousSda = api.state<'bool'>('sda');
  const active = api.state<'bool'>('active');
  const bits = api.state<'u32'>('bits');
  const shift = api.state<'u32'>('shift');
  const pointer = api.state<'u32'>('address');
  const writing = api.state<'bool'>('writing');
  const expectAddress = api.state<'bool'>('expectAddress');
  const ack = api.state<'bool'>('ack');
  const value = api.state<'u32'>('value');
  const load = api.state<'bool'>('load');
  const store = api.state<'bool'>('store');
  const write = api.state<'u32'>('write');

  const wasScl = previousScl.load();
  const wasSda = previousSda.load();
  const startEdge = b.bool.and(scl, b.bool.and(wasSda, b.bool.not(sda)));
  const stopEdge = b.bool.and(scl, b.bool.and(b.bool.not(wasSda), sda));
  const rising = b.bool.and(scl, b.bool.not(wasScl));
  const falling = b.bool.and(b.bool.not(scl), wasScl);

  const inFrame = b.bool.and(b.bool.not(startEdge), active.load());
  const belowEight = b.int.cmp('lt', bits.load(), b.const('u32', 8));
  const sampling = b.bool.and(inFrame, b.bool.and(rising, belowEight));
  const complete = b.bool.and(
    inFrame,
    b.bool.and(rising, b.int.cmp('eq', bits.load(), b.const('u32', 7))),
  );
  const addressFrame = b.bool.and(complete, expectAddress.load());
  const dataFrame = b.bool.and(complete, b.bool.not(expectAddress.load()));

  const bit = b.select(sda, b.const('u32', 1), b.const('u32', 0));
  const shifted = b.int.and(
    b.int.or(b.int.shl(shift.load(), b.const('u32', 1)), bit),
    b.const('u32', 0xff),
  );

  const address = pointer.load();
  const writable = b.bool.and(dataFrame, b.bool.and(writing.load(), b.bool.not(writeProtected)));
  writeCell(address, b.select(writable, b.int.trunc('u8', shifted), readCell(address)));

  // Advance the pointer for a data byte; an address frame leaves it alone.
  const advanced = b.int.and(b.int.add(address, b.const('u32', 1)), b.const('u32', 0xff));
  pointer.store(b.select(dataFrame, advanced, address));

  // Host-requested store through the topic endpoints.
  const storeNow = store.load();
  writeCell(pointer.load(), b.select(storeNow, b.int.trunc('u8', write.load()), readCell(address)));
  pointer.store(
    b.select(
      storeNow,
      b.int.and(b.int.add(address, b.const('u32', 1)), b.const('u32', 0xff)),
      pointer.load(),
    ),
  );
  store.store(b.const('bool', false));

  expectAddress.store(
    b.select(
      startEdge,
      b.const('bool', true),
      b.select(complete, b.const('bool', false), expectAddress.load()),
    ),
  );
  writing.store(
    b.select(
      addressFrame,
      b.int.cmp('eq', b.int.and(shifted, b.const('u32', 1)), b.const('u32', 0)),
      writing.load(),
    ),
  );

  shift.store(
    b.select(
      startEdge,
      b.const('u32', 0),
      b.select(complete, b.const('u32', 0), b.select(sampling, shifted, shift.load())),
    ),
  );
  bits.store(
    b.select(
      startEdge,
      b.const('u32', 0),
      b.select(
        complete,
        b.const('u32', 0),
        b.select(sampling, b.int.add(bits.load(), b.const('u32', 1)), bits.load()),
      ),
    ),
  );
  active.store(
    b.select(
      startEdge,
      b.const('bool', true),
      b.select(stopEdge, b.const('bool', false), active.load()),
    ),
  );

  const loadNow = load.load();
  value.store(b.select(loadNow, b.int.zext('u32', readCell(pointer.load())), value.load()));
  load.store(b.const('bool', false));

  // The only drive: sink SDA while acknowledging, release it otherwise.
  const nextAck = b.select(
    complete,
    b.const('bool', true),
    b.select(falling, b.const('bool', false), ack.load()),
  );
  ack.store(nextAck);
  api.pin(SDA).writeDigital(b.bool.not(nextAck));

  // Mark updated when we load a value or complete a frame
  const updated = api.state<'bool'>('updated');
  updated.store(b.bool.or(updated.load(), b.bool.or(loadNow, complete)));

  previousScl.store(scl);
  previousSda.store(sda);
}

function update(api: DeviceBehaviorApi): void {
  const b = api.builder;
  api.topics.publish('value', [b.convert.intToFloat('f64', api.state<'u32'>('value').load())]);
  api.topics.publish('ack', [api.state<'bool'>('ack').load()]);
  api.state<'bool'>('updated').store(b.const('bool', false));
}

/** Unified-IR description of the EEPROM. */
export function createI2cEepromDescription(): DeviceDescription {
  return {
    name: I2C_EEPROM_TYPE,
    pins: {
      SCL: { direction: 'bidirectional' },
      SDA: { direction: 'bidirectional' },
      WP: { direction: 'input' },
    },
    states: {
      scl: { type: 'bool', initial: true },
      sda: { type: 'bool', initial: true },
      active: { type: 'bool', initial: false },
      bits: { type: 'u32', initial: 0 },
      shift: { type: 'u32', initial: 0 },
      address: { type: 'u32', initial: 0 },
      writing: { type: 'bool', initial: true },
      expectAddress: { type: 'bool', initial: true },
      ack: { type: 'bool', initial: false },
      value: { type: 'u32', initial: 0 },
      write: { type: 'u32', initial: 0 },
      store: { type: 'bool', initial: false },
      load: { type: 'bool', initial: false },
      updated: { type: 'bool', initial: false },
    },
    powerDomains: [{ name: 'vdd', voltage: LOGIC_VOLTAGE }],
    ports: {
      address: { direction: 'input', type: 'number', title: '地址' },
      data: { direction: 'input', type: 'number', title: '写入' },
      read: { direction: 'input', type: 'boolean', title: '读取' },
      value: { direction: 'output', type: 'number', title: '读出字节' },
      ack: { direction: 'output', type: 'boolean', title: 'ACK' },
    },
    kernel: (context) => {
      // The array is private to this instance; the device id is an identifier,
      // so it can be part of the module-level name.
      const cells = context.module.array(
        `i2c_eeprom_${context.deviceId}`,
        'u8',
        Array.from({ length: I2C_EEPROM_SIZE }, () => 0),
      );
      return {
        initialize,
        tick: (api) =>
          tick(
            api,
            (index) => api.builder.array.load(cells, index),
            (index, cellValue) => api.builder.array.store(cells, index, cellValue),
          ),
        update,
      };
    },
  };
}
