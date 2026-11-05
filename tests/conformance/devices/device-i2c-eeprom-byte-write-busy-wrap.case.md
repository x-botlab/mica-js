---
kind: comparison
---

# I2C EEPROM byte write, busy polling and wrapped reads

## 规范来源

[Electrical intents](../../../docs/spec/electrical.rst),
[publication and reaction capture](../../../docs/spec/execution/scheduling.rst), and
[fixture protocol](./i2c-eeprom/i2c-eeprom.ddl).

## 验收义务

Use real open-drain master intents, external 4.7 kohm pull-ups on both wires,
and explicit 3.3 V/0 V rails. Publish SDA setup and every SCL edge separately
at integer ps times. Verify ninth-clock ACK drive/release, wrong-slave and
invalid-word-address NACK, zero reads, STOP-triggered 1 ms busy writes,
pre-deadline NACK/post-deadline ACK, first-byte-only write acceptance,
repeated START discarding staged data, master ACK continuation with 15-to-0
pointer wrap, and master NACK termination. Read data only from public probes;
private EEPROM storage is never inspected.

## 对照输入

```json
{ "fixture": "i2c-eeprom", "writeDuration": 1000000000 }
```

## 执行步骤

```typescript
const { fixture, assemble, advance, reading, level, endpoint, net, rails, passive } =
  await importModule('./support.mjs');
const { pinDriver } = await importModule('./smoke-support.mjs');
const driver = await pinDriver(adapter, ['scl', 'sda']);
const pullups = await adapter.compileDDL(`device Pullups {
  pin scl = [resistor(to: supply, resistance: 4700)];
  pin sda = [resistor(to: supply, resistance: 4700)];
  pin supply;
  pin reference;
}`);
const scl = [];
const sda = [];
let disposed = 0;
const board = await assemble(
  adapter,
  [
    {
      id: 'dut',
      model: await fixture(adapter, inputs.fixture),
      create: () => ({
        sync() {},
        dispose() {
          disposed++;
        },
      }),
    },
    driver.entry,
    { id: 'pullups', model: pullups, create: passive },
  ],
  {
    instances: [
      { id: 'dut', type: 'dut' },
      { id: 'driver', type: 'driver' },
      { id: 'pullups', type: 'pullups' },
      { id: 'scl', type: 'probe-scl' },
      { id: 'sda', type: 'probe-sda' },
    ],
    nets: [
      ...rails(['dut', 'driver', 'pullups']),
      ...['scl', 'sda'].map((pin) =>
        net(pin, [
          endpoint('dut', pin),
          endpoint('driver', pin),
          endpoint('pullups', pin),
          endpoint(pin, 'measured'),
        ]),
      ),
    ],
  },
  { scl, sda },
);
t.after(() => board.dispose());
// High means release, never an active source. Each command has its own publication.
const lines = (clockHigh, dataHigh) => {
  advance(board, board.time + 1);
  driver.send(0, (clockHigh ? 0 : 1) | (dataHigh ? 0 : 2));
  advance(board, board.time);
};
const start = () => {
  lines(true, true);
  lines(true, false);
  lines(false, false);
};
const stop = () => {
  lines(false, false);
  lines(true, false);
  lines(true, true);
};
const writeByte = (value) => {
  for (let bit = 7; bit >= 0; bit--) {
    const high = (value & (1 << bit)) !== 0;
    lines(false, high);
    lines(true, high);
    lines(false, high);
  }
  lines(false, true);
  const before = reading(sda);
  lines(true, true);
  const ninth = reading(sda);
  const time = board.time;
  lines(false, true);
  return { before, ninth, after: reading(sda), time };
};
const readByte = (acknowledge) => {
  let value = 0;
  for (let bit = 7; bit >= 0; bit--) {
    lines(false, true);
    lines(true, true);
    const sampled = reading(sda);
    assert.ok(sampled.high || sampled.low, 'every read bit must resolve to a defined logic level');
    value = (value << 1) | (sampled.high ? 1 : 0);
    lines(false, true);
  }
  lines(false, !acknowledge);
  lines(true, !acknowledge);
  lines(false, !acknowledge);
  return value;
};
const ack = (result, accepted, released = true) => {
  for (const value of [result.before, result.ninth]) {
    assert.equal(value.low, accepted);
    assert.equal(value.high, !accepted);
    assert.ok(Math.abs(value.voltage - (accepted ? (3.3 * 25) / 4725 : 3.3)) < 1e-9);
  }
  if (released) assert.equal(result.after.high, true, 'ACK sink releases on ninth falling edge');
};
```

## 断言

```typescript
advance(board, 0);
level(sda, true);
level(scl, true);
assert.ok(Math.abs(reading(sda).voltage - 3.3) < 1e-9);
assert.ok(Math.abs(reading(scl).voltage - (3.3 * 1000000) / 1004700) < 1e-9);
start();
ack(writeByte(0xa2), false);
stop();
start();
ack(writeByte(0xa0), true);
ack(writeByte(0x10), false);
ack(writeByte(0x55), false);
stop();
// Address-only write sets the pointer without starting a busy write.
start();
ack(writeByte(0xa0), true);
ack(writeByte(0), true);
start();
ack(writeByte(0xa1), true, false);
assert.equal(readByte(false), 0);
assert.equal(readByte(false), 0xff, 'master NACK terminates slave transmission');
stop();
start();
ack(writeByte(0xa0), true);
ack(writeByte(15), true);
ack(writeByte(0xa5), true);
ack(writeByte(0x3c), false, false);
stop();
const stopped = board.time;
const deadline = stopped + inputs.writeDuration;
start();
ack(writeByte(0xa0), false);
stop();
advance(board, deadline - 40);
start();
const preDeadline = writeByte(0xa0);
ack(preDeadline, false);
assert.ok(preDeadline.time < deadline);
stop();
advance(board, deadline - 1);
level(sda, true);
advance(board, deadline);
start();
const postDeadline = writeByte(0xa0);
ack(postDeadline, true);
assert.ok(postDeadline.time > deadline);
ack(writeByte(15), true);
start();
ack(writeByte(0xa1), true);
assert.equal(readByte(true), 0xa5, 'only the first accepted data byte commits');
assert.equal(readByte(false), 0, 'master ACK continues through address 15 to address 0');
assert.equal(readByte(false), 0xff, 'NACK ends continuation');
stop();
// Repeated START discards the staged byte instead of initiating a write cycle.
start();
ack(writeByte(0xa0), true);
ack(writeByte(0), true);
ack(writeByte(0x3c), true);
start();
ack(writeByte(0xa1), true, false);
assert.equal(readByte(false), 0);
stop();
start();
ack(writeByte(0xa0), true);
stop();
level(sda, true);
level(scl, true);
assert.ok(scl.every((message) => message.value.knownVoltage));
assert.ok(sda.every((message) => message.value.knownVoltage));
board.dispose();
board.dispose();
assert.equal(board.status, 'disposed');
assert.equal(disposed, 1);
assert.throws(() => driver.send(0, 0), { code: 'OBJECT_DISPOSED' });
```
