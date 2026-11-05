import assert from 'node:assert/strict';
import { createDeviceBuilder, types, validateDeviceIR } from '../../../device-model/dist/index.js';
import { modelFor, uartModel, timing } from './typical-mcu.mjs';

// Diagnostic traces, not hardware FIFOs: enough for the complete <=1s budget,
// including 50ms warmup calls. Hardware RX and TX FIFOs remain 16 bytes.
export const traceCapacity = 16_384;
const cpus = new Map();
const senders = new Map();
const capacityBuilder = createDeviceBuilder();
capacityBuilder.channel({
  name: 'trace',
  direction: 'output',
  type: types.number,
  capacity: traceCapacity,
});
const capacity = capacityBuilder.finish().declarations[0].capacity;
const startupBuilder = createDeviceBuilder();
startupBuilder.state({ name: 'timerStarted', type: types.bool, initial: false });
startupBuilder.start((b) => b.writeState('timerStarted', true));
const cpuStart = startupBuilder.finish().declarations.find((d) => d.kind === 'start');
const diagnostic = (declaration) =>
  declaration.kind === 'channel' && declaration.direction === 'output'
    ? { ...declaration, capacity }
    : declaration;

function autonomousProducer(uartPeriodMs) {
  const d = createDeviceBuilder();
  d.memory({ name: 'txFifo', length: 16 });
  for (const name of ['txTail', 'txCount', 'burstOrdinal'])
    d.state({ name, type: types.number, initial: 0 });
  d.channel({
    name: 'txDropped',
    direction: 'output',
    type: types.number,
    capacity: traceCapacity,
  });
  d.start((b) =>
    b.loop((c) => {
      for (let index = 0; index < timing.bytesPerPeriod; index++) {
        const ordinal = c.readState('burstOrdinal', types.number);
        const value = c.bitAnd(
          c.add(
            c.add(c.multiply(ordinal, 29), c.multiply(c.floor(c.divide(ordinal, 256)), 17)),
            85,
          ),
          255,
        );
        c.if(
          c.lessThan(c.readState('txCount', types.number), 16),
          (e) => {
            e.store8('txFifo', e.readState('txTail', types.number), value);
            e.writeState('txTail', e.remainder(e.add(e.readState('txTail', types.number), 1), 16));
            e.writeState('txCount', e.add(e.readState('txCount', types.number), 1));
          },
          (e) => e.send('txDropped', value),
        );
        c.writeState('burstOrdinal', c.add(ordinal, 1));
      }
      c.wait(uartPeriodMs * timing.timerCycles * timing.cyclePs);
    }),
  );
  return d.finish();
}

export function senderModelFor(uartPeriodMs) {
  if (senders.has(uartPeriodMs)) return senders.get(uartPeriodMs);
  const producer = autonomousProducer(uartPeriodMs);
  const model = validateDeviceIR({
    kind: 'device',
    name: 'AutonomousMcuUart',
    declarations: [
      ...uartModel.declarations
        .filter((d) => d.kind !== 'start' && d.name !== 'transmit')
        .map(diagnostic),
      ...producer.declarations.filter((d) => d.name === 'burstOrdinal' || d.kind === 'start'),
    ],
  });
  senders.set(uartPeriodMs, model);
  return model;
}

export function boardModelFor(busyPercent) {
  if (cpus.has(busyPercent)) return cpus.get(busyPercent);
  const receive = uartModel.declarations.find((d) => d.kind === 'on' && d.name === 'receiveFrame');
  assert.ok(receive, 'UART fixture must expose its receiveFrame process');
  const operations = receive.body.operations;
  const sends = operations.filter((op) => op.kind === 'send' && op.channel === 'received');
  assert.equal(sends.length, 1, 'exactly one decoded-frame send in the UART fixture');
  const send = sends[0];
  const frame = operations.find((op) => op.kind === 'record' && op.result === send.value);
  assert.equal(frame?.type.name, 'Frame');
  const value = frame.fields.find((field) => field.name === 'value');
  assert.ok(value, 'decoded byte must be a field of the actual sampled frame');
  // Use the existing decoded value in the same process segment as received.send.
  // No result IDs, source bindings, sampling logic or wait durations are rewritten.
  const integratedReceive = {
    ...receive,
    body: {
      ...receive.body,
      operations: operations.flatMap((op) =>
        op === send
          ? [
              op,
              {
                kind: 'call',
                name: 'enqueueRx',
                pure: false,
                args: [{ kind: 'value', value: value.value }],
              },
            ]
          : [op],
      ),
    },
  };
  const cpu = modelFor(busyPercent);
  const sharedPins = new Set(['supply', 'reference']);
  for (const name of sharedPins) {
    assert.equal(cpu.declarations.find((d) => d.name === name)?.kind, 'pin');
    assert.equal(uartModel.declarations.find((d) => d.name === name)?.kind, 'pin');
  }
  const model = validateDeviceIR({
    kind: 'device',
    name: 'BoardLocalMcu',
    declarations: [
      ...cpu.declarations
        .filter((d) => d.name !== 'rxByte')
        .map((d) => diagnostic(d.kind === 'start' ? cpuStart : d)),
      ...uartModel.declarations
        .filter((d) => d.kind !== 'start' && d.name !== 'transmit' && !sharedPins.has(d.name))
        .map((d) => diagnostic(d === receive ? integratedReceive : d)),
    ],
  });
  cpus.set(busyPercent, model);
  return model;
}
