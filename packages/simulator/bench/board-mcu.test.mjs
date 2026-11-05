import assert from 'node:assert/strict';
import test from 'node:test';
import * as sdk from '../dist/index.js';
import { create, defaults, normalizeOptions, timing, traceCapacity } from './board-mcu.mjs';
import { snapshotFields, uartModel } from './workloads/typical-mcu.mjs';
import { validateDeviceIR } from '../../device-model/dist/index.js';
import { boardModelFor, senderModelFor } from './workloads/board-mcu.mjs';

function run(options, targets) {
  const bench = create(sdk, options);
  try {
    for (const target of targets) {
      const step = bench.step(target - bench.progress.cycles);
      assert.equal(step.runUntilCalls, 1);
      assert.equal(step.oracleRunUntilCalls, 0);
      bench.verify();
    }
    const { hostCalls, ...evidence } = bench.verify();
    assert.equal(hostCalls.runUntilCalls, targets.length);
    assert.equal(hostCalls.oracleRunUntilCalls, targets.length + 1);
    return evidence;
  } finally {
    bench.dispose();
  }
}

for (const waiting of ['wfi', 'poll']) {
  test(`board-local throughput/${waiting}: 20ms equals 2x10ms and irregular slicing`, () => {
    const options = { waiting, execution: 'throughput', cycles: 2_000_000 };
    const whole = run(options, [2_000_000]);
    const halves = run(options, [1_000_000, 2_000_000]);
    const irregular = run(
      options,
      [1, 8246, 8247, 91146, 100000, 999999, 1000000, 1000001, 1008246, 1008247, 1800003, 2000000],
    );
    assert.deepEqual(halves, whole);
    assert.deepEqual(irregular, whole);
    assert.equal(whole.ram.length, 64);
    assert.equal(whole.state.timerTicks, 20);
    assert.equal(whole.state.workCount, 2000);
    assert.equal(whole.uart.received, 22);
    assert.equal(whole.uart.serviced, 22);
    assert.equal(whole.uart.fifoCapacity, 16);
    assert.equal(whole.uart.dropped, 0);
    assert.equal(whole.uart.handoffPeriodPs, 0);
    assert.equal(whole.uart.delivery, 'model-at-frame-time');
    assert.ok(whole.maxTimerIrqResponsePs <= whole.timerIrqResponseBoundPs);
  });
}

test('board-local precise WFI preserves electrical frames and work with smaller irregular slices', () => {
  const precise = run({ execution: 'precise', cycles: 112_000 }, [112_000]);
  const sliced = run({ execution: 'precise', cycles: 112_000 }, [1, 8246, 8247, 99999, 112000]);
  assert.deepEqual(sliced, precise);
  const throughput = run({ execution: 'throughput', cycles: 112_000 }, [112_000]);
  assert.deepEqual(throughput.ram, precise.ram);
  assert.equal(throughput.state.workCount, precise.state.workCount);
  assert.deepEqual(throughput.traces.frames, precise.traces.frames);
  assert.equal(precise.uart.received, 11);
  assert.equal(precise.uart.serviced, 11);
});

test('board-local host instrumentation observes one real advance per 10/20ms step and separate oracle calls', () => {
  const calls = [];
  const observed = {
    ...sdk,
    createBoard(...args) {
      const board = sdk.createBoard(...args);
      return new Proxy(board, {
        get(target, property) {
          if (property === 'runUntil')
            return (to) => {
              calls.push({ from: target.time, to });
              return target.runUntil(to);
            };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
  const bench = create(observed, { cycles: 3_000_000, waiting: 'poll' });
  try {
    assert.equal(bench.board.time, 0, 'cold creation');
    assert.equal(calls.length, 0);
    assert.equal(bench.step(1_000_000).runUntilCalls, 1);
    assert.deepEqual(calls, [{ from: 0, to: 10e9 }]);
    bench.verify();
    assert.deepEqual(calls[1], { from: 10e9, to: 10e9 });
    assert.equal(bench.step(2_000_000).runUntilCalls, 1);
    assert.deepEqual(calls[2], { from: 10e9, to: 30e9 });
    const result = bench.verify();
    assert.deepEqual(result.hostCalls, {
      runUntilCalls: 2,
      oracleRunUntilCalls: 2,
      totalRunUntilCalls: 4,
    });
    assert.equal(bench.progress.mode, 'board-local');
    assert.equal(bench.progress.runUntilCalls, 2);
    assert.equal(calls.filter(({ from, to }) => to > from).length, 2);
    assert.equal(calls.length, 4);
  } finally {
    bench.dispose();
  }
});

test('board-local sampled RX enters hardware FIFO exactly at the frame timestamp, without host sends', () => {
  let cpu;
  const observed = {
    ...sdk,
    createDeviceLibrary(entries) {
      return sdk.createDeviceLibrary(
        entries.map((entry) =>
          entry.id !== 'cpu'
            ? entry
            : {
                ...entry,
                create(ctx) {
                  cpu = ctx;
                  return entry.create(ctx);
                },
              },
        ),
      );
    },
  };
  const bench = create(observed);
  const snapshot = () => {
    cpu.inputs.snapshotRequest.notify();
    bench.board.runUntil(bench.board.time);
    const bytes = Uint8Array.from(cpu.memory.snapshot);
    const view = new DataView(bytes.buffer);
    return Object.fromEntries(snapshotFields.map((name, i) => [name, view.getUint32(i * 4, true)]));
  };
  try {
    const firstFrame = timing.bitTimePs * 9.5;
    bench.board.runUntil(firstFrame - 1);
    assert.equal(snapshot().rxCount, 0);
    bench.board.runUntil(firstFrame);
    const atFrame = snapshot();
    assert.equal(atFrame.rxCount, 1, 'same timestamp as the stop-bit sample');
    assert.equal(atFrame.rxServiced, 0, 'FIFO enqueue precedes later CPU service instructions');
    bench.board.runUntil(firstFrame + 20 * timing.cyclePs);
    assert.equal(snapshot().rxServiced, 1);
  } finally {
    bench.dispose();
  }
});

test('board-local diagnostic capacities support unsliced 40ms and 50ms warmup without changing hardware FIFO', () => {
  const whole = run({ cycles: 4_000_000 }, [4_000_000]);
  const sliced = run({ cycles: 4_000_000 }, [1_000_000, 2_000_000, 3_000_000, 4_000_000]);
  assert.deepEqual(sliced, whole);
  assert.equal(whole.uart.received, 44);
  assert.equal(whole.uart.dropped, 0);
  const warm = create(sdk, { cycles: 7_000_000 });
  try {
    assert.equal(warm.step(5_000_000).runUntilCalls, 1);
    assert.equal(warm.verify().uart.received, 55);
    assert.equal(warm.step(2_000_000).runUntilCalls, 1);
    const result = warm.verify();
    assert.equal(result.uart.received, 77);
    assert.equal(result.uart.fifoCapacity, 16);
    assert.equal(result.uart.traceCapacity, traceCapacity);
    assert.equal(result.uart.dropped, 0);
  } finally {
    warm.dispose();
  }
});

test('board-local autonomous bursts and diagnostic traces also tolerate 1ms UART periods', () => {
  const result = run({ uartPeriodMs: 1, cycles: 4_000_000 }, [4_000_000]);
  assert.equal(result.uart.received, 440);
  assert.equal(result.uart.serviced, 440);
  assert.equal(result.uart.dropped, 0);
  assert.equal(result.uart.framingErrors, 0);
  assert.equal(result.uart.unknownSamples, 0);
});

test('board-local oracle rejects corruption of any RAM byte, including byte 63', () => {
  let corrupt = false;
  const observed = {
    ...sdk,
    createDeviceLibrary(entries) {
      return sdk.createDeviceLibrary(
        entries.map((entry) =>
          entry.id !== 'cpu'
            ? entry
            : {
                ...entry,
                create(ctx) {
                  return entry.create({
                    ...ctx,
                    memory: {
                      get snapshot() {
                        return ctx.memory.snapshot;
                      },
                      get ram() {
                        const bytes = Uint8Array.from(ctx.memory.ram);
                        if (corrupt) bytes[63] ^= 1;
                        return bytes;
                      },
                    },
                  });
                },
              },
        ),
      );
    },
  };
  const bench = create(observed);
  try {
    bench.step(1_000_000);
    bench.verify();
    corrupt = true;
    assert.throws(() => bench.verify(), /all 64 useful-work RAM bytes/);
  } finally {
    bench.dispose();
  }
});

test('board-local composition retains unchanged UART waveform logic and distinct 16-byte hardware FIFOs', () => {
  const cpu = boardModelFor(1);
  const sender = senderModelFor(10);
  for (const name of ['sendFrames', 'detectStart', 'rxHigh', 'driveTx']) {
    const original = uartModel.declarations.find((d) => d.name === name);
    assert.deepEqual(
      cpu.declarations.find((d) => d.name === name),
      original,
    );
    assert.deepEqual(
      sender.declarations.find((d) => d.name === name),
      original,
    );
  }
  const receive = cpu.declarations.find((d) => d.name === 'receiveFrame');
  const calls = receive.body.operations.filter(
    (op) => op.kind === 'call' && op.name === 'enqueueRx',
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(
    {
      ...receive,
      body: {
        ...receive.body,
        operations: receive.body.operations.filter((op) => !calls.includes(op)),
      },
    },
    uartModel.declarations.find((d) => d.name === 'receiveFrame'),
  );
  assert.equal(
    cpu.declarations.some((d) => d.name === 'rxByte'),
    false,
  );
  assert.equal(
    sender.declarations.some((d) => d.name === 'transmit'),
    false,
  );
  assert.equal(
    cpu.declarations.find((d) => d.name === 'rxFifo').length.body.operations[0].constant.value,
    16,
  );
  assert.equal(
    sender.declarations.find((d) => d.name === 'txFifo').length.body.operations[0].constant.value,
    16,
  );
  assert.equal(
    uartModel.declarations.find((d) => d.name === 'received').capacity.body.operations[0].constant
      .value,
    16,
  );
  assert.ok(
    traceCapacity >= 11 * 1_000,
    'diagnostics cover even 1ms bursts for the maximum 1s budget',
  );
});

test('board-local fully busy CPU still executes oracle-checked useful ALU and RAM instructions', () => {
  const result = run({ busyPercent: 100, waiting: 'poll', cycles: 112_000 }, [112_000]);
  assert.ok(result.state.workCount > 10_000);
  assert.equal(result.uart.serviced, 11);
  assert.equal(result.uart.dropped, 0);
});

test('board-local public IR validation, stable model identity, and option/budget contracts', () => {
  assert.deepEqual(normalizeOptions(), defaults);
  assert.equal(normalizeOptions({ duration: 0.04 }).cycles, 4_000_000);
  assert.throws(() => normalizeOptions({ duration: 0.02, cycles: 1 }), /not both/);
  assert.throws(() => normalizeOptions({ unknown: true }), /Unknown option/);
  assert.throws(() => normalizeOptions({ duration: 2 }), /duration/);
  const model = boardModelFor(1);
  assert.equal(boardModelFor(1), model);
  assert.doesNotThrow(() => validateDeviceIR(model));
  assert.doesNotThrow(() => validateDeviceIR(senderModelFor(10)));
  const outputs = model.declarations.filter(
    (d) => d.kind === 'channel' && d.direction === 'output',
  );
  for (const output of outputs)
    assert.equal(output.capacity.body.operations[0].constant.value, traceCapacity);
  const bench = create(sdk, { cycles: 1 });
  try {
    assert.throws(() => bench.step(0), /positive/);
    assert.throws(() => bench.step(2), /budget/);
    bench.step(1);
    assert.throws(() => bench.step(1), /budget/);
  } finally {
    bench.dispose();
  }
  assert.throws(() => bench.step(1), /disposed/);
});
