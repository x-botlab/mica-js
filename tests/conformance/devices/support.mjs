import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export const endpoint = (instance, pin) => ({ instance, pin });
export const net = (id, pins, voltage) =>
  voltage === undefined ? { id, pins } : { id, pins, voltage };
export const passive = () => ({ sync() {}, dispose() {} });

// Public output messages are the only electrical observation surface.
const probeSource = `device ConformanceProbe {
  pin measured(low: 0.8, high: 2.0);
  record Reading { voltage: number; knownVoltage: bool; high: bool; low: bool; }
  output channel readings: Reading(capacity: 256, overflow: Overflow.error);
  fn publishReading() {
    const sampled = measured.sample;
    const voltage = sampled.voltage;
    let numericVoltage = 0;
    if voltage != none { numericVoltage = voltage; }
    readings.send({ voltage: numericVoltage, knownVoltage: voltage != none,
      high: sampled.level == Logic.high, low: sampled.level == Logic.low });
  }
  process start { publishReading(); }
  reaction changed on measured.sample as (previous, current) { publishReading(); }
}`;

export async function fixture(adapter, name) {
  return adapter.compileDDL(
    await readFile(new URL(`./${name}/${name}.ddl`, import.meta.url), 'utf8'),
  );
}

export async function assemble(adapter, entries, description, observations) {
  const probe = await adapter.compileDDL(probeSource);
  const library = adapter.createDeviceLibrary([
    ...entries,
    ...Object.entries(observations).map(([id, messages]) => ({
      id: `probe-${id}`,
      model: probe,
      create: () => ({
        sync(batch) {
          messages.push(...batch.outputs.readings);
        },
        dispose() {},
      }),
    })),
  ]);
  const board = adapter.createBoard(library, description);
  assert.equal(board.status, 'ready');
  assert.equal(board.time, 0);
  for (const messages of Object.values(observations)) {
    assert.equal(messages.length, 0, 'assembly must not execute model output');
  }
  return board;
}

export function advance(board, time) {
  board.runUntil(time);
  assert.equal(board.time, time);
  assert.equal(board.status, 'ready');
}

export function reading(messages) {
  assert.ok(messages.length, 'probe must deliver public output messages');
  const value = messages.at(-1).value;
  assert.equal(value.knownVoltage, true, 'expected a referenced electrical net');
  return value;
}

export function level(messages, high) {
  const value = reading(messages);
  assert.equal(value.high, high);
  assert.equal(value.low, !high);
}

// Supply/reference are ordinary device pins, not implicit runtime resources.
export function rails(instances) {
  return [
    net(
      'supply',
      instances.map((id) => endpoint(id, 'supply')),
      3.3,
    ),
    net(
      'reference',
      instances.map((id) => endpoint(id, 'reference')),
      0,
    ),
  ];
}

export function driverSource(body) {
  return `device ConformanceDriver {
    pin a = [resistor(to: reference, resistance: 25)];
    pin b = [resistor(to: reference, resistance: 25)];
    pin c = [resistor(to: reference, resistance: 25)];
    pin supply;
    pin reference;
    process start { ${body} }
  }`;
}

export const drive = (pin, high) =>
  `${pin}.intent <- [resistor(to: ${high ? 'supply' : 'reference'}, resistance: 25)];`;
