---
kind: comparison
---

# Asynchronous SRAM samples the closing write-window boundary

## 规范来源

[Electrical publication](../../../docs/spec/electrical.rst),
[reaction capture](../../../docs/spec/execution/scheduling.rst), and
[fixture policy](./asynchronous-sram/asynchronous-sram.ddl).

## 验收义务

Wire explicit 3.3 V/0 V rails and observe all eight bidirectional data pins.
Read all four zero-initialized addresses. Write 0xa5, 0xff and 0x00, close
windows using either writeEnable or selected, and change address/data together
with closure. Writes take priority over outputEnable; data outputs must release
while writing or disabled. In-window changes do not commit. Closing with
floating data decodes zero by this fixture's documented policy. Reading other
addresses must preserve their independent values.

## 对照输入

```json
{ "fixture": "asynchronous-sram" }
```

## 执行步骤

```typescript
const { fixture, assemble, advance, reading, endpoint, net, rails, passive } =
  await importModule('./support.mjs');
const { pinDriver } = await importModule('./smoke-support.mjs');
const dataPins = Array.from({ length: 8 }, (_, bit) => `d${bit}`);
const pins = ['a0', 'a1', 'selected', 'writeEnable', 'outputEnable', ...dataPins];
const driver = await pinDriver(adapter, pins);
const observations = Object.fromEntries(dataPins.map((pin) => [pin, []]));
const board = await assemble(
  adapter,
  [{ id: 'dut', model: await fixture(adapter, inputs.fixture), create: passive }, driver.entry],
  {
    instances: [
      { id: 'dut', type: 'dut' },
      { id: 'driver', type: 'driver' },
      ...dataPins.map((id) => ({ id, type: `probe-${id}` })),
    ],
    nets: [
      ...rails(['dut', 'driver']),
      ...pins.map((pin) =>
        net(pin, [
          endpoint('dut', pin),
          endpoint('driver', pin),
          ...(dataPins.includes(pin) ? [endpoint(pin, 'measured')] : []),
        ]),
      ),
    ],
  },
  observations,
);
t.after(() => board.dispose());
const bus = (time, address, selected, writing, outputEnabled, data = null) => {
  advance(board, time);
  const controls = address | (selected ? 4 : 0) | (writing ? 8 : 0) | (outputEnabled ? 16 : 0);
  driver.send(controls | ((data ?? 0) << 5), 31 | (data === null ? 0 : 255 << 5));
  advance(board, time);
};
const expectByte = (expected) => {
  for (const [bit, pin] of dataPins.entries()) {
    const value = reading(observations[pin]);
    const high = (expected & (1 << bit)) !== 0;
    assert.equal(value.high, high, pin);
    assert.equal(value.low, !high, pin);
    assert.ok(Math.abs(value.voltage - (high ? 3.3 : 0)) < 1e-9, pin);
  }
};
const floating = () => {
  for (const pin of dataPins) {
    const value = observations[pin].at(-1).value;
    assert.equal(value.knownVoltage, false, pin);
    assert.equal(value.high, false, pin);
    assert.equal(value.low, false, pin);
  }
};
```

## 断言

```typescript
advance(board, 0);
floating();
for (let address = 0; address < 4; address++) {
  bus(address + 1, address, true, false, true);
  expectByte(0);
}
// Begin a write while read-enable remains high; the SRAM must release its drive.
bus(5, 0, true, true, true, 0xa5);
expectByte(0xa5);
bus(6, 0, true, true, true);
floating();
bus(7, 1, true, true, true, 0xff);
expectByte(0xff);
// New address and data publish together with writeEnable falling.
bus(8, 2, true, false, false, 0xa5);
bus(9, 2, true, false, true);
expectByte(0xa5);
bus(10, 0, true, false, true);
expectByte(0);
bus(11, 1, true, false, true);
expectByte(0);
// selected falling is also a closing boundary; sample its new address/data.
bus(12, 0, true, true, true, 0);
bus(13, 1, false, true, true, 0xff);
bus(14, 1, true, false, true);
expectByte(0xff);
bus(15, 2, true, false, true);
expectByte(0xa5);
// Overwrite a nonzero byte with zero, not an unchanged default value.
bus(16, 1, true, true, false, 0xff);
bus(17, 1, true, true, false, 0);
bus(18, 1, true, false, false, 0);
bus(19, 1, true, false, true);
expectByte(0);
bus(20, 3, true, true, false, 0xff);
bus(21, 3, true, false, false, 0xff);
bus(22, 3, true, false, true);
expectByte(0xff);
// Publish the SRAM's release before closing with undriven, unknown data.
bus(23, 3, true, true, true);
floating();
bus(24, 3, true, false, false);
floating();
bus(25, 3, true, false, true);
expectByte(0);
bus(26, 2, true, false, false);
floating();
bus(27, 2, false, false, true);
floating();
bus(28, 2, true, false, true);
expectByte(0xa5);
board.dispose();
assert.equal(board.status, 'disposed');
assert.throws(() => driver.send(0), { code: 'OBJECT_DISPOSED' });
```
