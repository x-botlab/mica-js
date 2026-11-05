import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { normalizeOptions as normalizeTypicalOptions, limits } from './typical-mcu.mjs';
import {
  timing,
  snapshotFields,
  translator,
  byteAt,
  iterationsPerPeriod,
  createWorkOracle,
} from './workloads/typical-mcu.mjs';
import { boardModelFor, senderModelFor, traceCapacity } from './workloads/board-mcu.mjs';

export { timing, limits, traceCapacity };
export const defaults = Object.freeze({
  execution: 'throughput',
  waiting: 'wfi',
  busyPercent: 1,
  uartPeriodMs: 10,
  cycles: 2_000_000,
});
export function normalizeOptions(options = {}) {
  // Delegate type/key/range checking, including the duration/cycles exclusion.
  normalizeTypicalOptions(options);
  const { cycles, ...rest } = defaults;
  return normalizeTypicalOptions({
    ...rest,
    ...(!Object.hasOwn(options, 'cycles') && !Object.hasOwn(options, 'duration') ? { cycles } : {}),
    ...options,
  });
}
const periodPs = timing.timerCycles * timing.cyclePs;
const irqBoundPs = timing.quantumPs + (timing.workCycles + 2) * timing.cyclePs;
const quantumCycles = timing.quantumPs / timing.cyclePs;

/**
 * Calibrated board-local counterpart of typical-mcu. Every step makes exactly one
 * positive-time runUntil call. UART bursts and sampled RX->FIFO/IRQ delivery run
 * in modeled processes, never in sync callbacks. verify() is an untimed oracle
 * and explicitly accounts for its separate zero-time snapshot call.
 */
export function create(sdk, options = {}) {
  const config = normalizeOptions(options);
  if (typeof sdk?.createBoard !== 'function' || typeof sdk?.createDeviceLibrary !== 'function')
    throw new TypeError('Supply the public simulator SDK module');
  const model = boardModelFor(config.busyPercent);
  const frames = [],
    reverseFrames = [],
    timerAcks = [],
    rxAcks = [],
    gpioEdges = [],
    drops = [];
  let cpu;
  const library = sdk.createDeviceLibrary([
    {
      id: 'cpu',
      model,
      create(ctx) {
        cpu = ctx;
        const binding = ctx.attachJit({
          entry: 'cpu',
          code: 'code',
          pc: 'pc',
          beforeInstruction: { when: 'takeIrq', call: 'enterIrq' },
          ...(config.waiting === 'poll' ? { polling: [{ pc: 0, predicate: 'canResume' }] } : {}),
          translate: translator(config),
        });
        ctx.loadBytes(
          'code',
          Uint8Array.from({ length: 256 }, (_, index) => index),
        );
        return {
          sync(batch) {
            frames.push(...batch.outputs.received);
            timerAcks.push(...batch.outputs.timerAck);
            rxAcks.push(...batch.outputs.rxAck);
            gpioEdges.push(...batch.outputs.gpioEdge);
            drops.push(...batch.outputs.txDropped);
          },
          dispose() {
            binding.dispose();
          },
        };
      },
    },
    {
      id: 'sender',
      model: senderModelFor(config.uartPeriodMs),
      create() {
        return {
          sync(batch) {
            reverseFrames.push(...batch.outputs.received);
            drops.push(...batch.outputs.txDropped);
          },
          dispose() {},
        };
      },
    },
  ]);
  const endpoint = (instance, pin) => ({ instance, pin });
  const board = sdk.createBoard(
    library,
    {
      instances: ['cpu', 'sender'].map((id) => ({
        id,
        type: id,
        props: { bitTime: timing.bitTimePs },
      })),
      nets: [
        ...[
          ['supply', 3.3],
          ['reference', 0],
        ].map(([id, voltage]) => ({
          id,
          voltage,
          pins: ['cpu', 'sender'].map((instance) => endpoint(instance, id)),
        })),
        { id: 'serial', pins: [endpoint('sender', 'tx'), endpoint('cpu', 'rx')] },
        { id: 'return', pins: [endpoint('cpu', 'tx'), endpoint('sender', 'rx')] },
        { id: 'gpio', pins: [endpoint('cpu', 'gpio')] },
      ],
    },
    { execution: config.execution, cpuQuantum: timing.quantumPs },
  );
  const oracle = createWorkOracle();
  let cycles = 0,
    wallSeconds = 0,
    runUntilCalls = 0,
    oracleRunUntilCalls = 0;
  let disposed = false;
  const valid = () => {
    if (disposed) throw new Error('Board-local MCU is disposed');
  };
  const calls = () => ({
    runUntilCalls,
    oracleRunUntilCalls,
    totalRunUntilCalls: runUntilCalls + oracleRunUntilCalls,
  });
  return {
    board,
    model,
    config,
    mode: 'board-local',
    description:
      'Synthetic 100MHz scalar/RAM MCU, 1kHz timer, 100Hz GPIO; autonomous ' +
      `11-byte/${config.uartPeriodMs}ms 115200baud full-bit electrical UART; ` +
      'sample-time modeled RX delivery into persistent 16-byte FIFO. One host runUntil per step.',
    get progress() {
      return {
        cycles,
        time: cycles * timing.cyclePs,
        simulatedSeconds: cycles / timing.frequencyHz,
        wallSeconds,
        budgetCycles: config.cycles,
        mode: 'board-local',
        ...calls(),
      };
    },
    step(count = Math.min(1_000_000, config.cycles - cycles)) {
      valid();
      if (!Number.isSafeInteger(count) || count < 1 || cycles + count > config.cycles)
        throw new RangeError('Step must be positive integral cycles within the cumulative budget');
      if (board.time !== cycles * timing.cyclePs) throw new Error('Advance through step() only');
      const from = board.time,
        to = (cycles + count) * timing.cyclePs;
      const start = performance.now();
      board.runUntil(to);
      const elapsed = (performance.now() - start) / 1_000;
      runUntilCalls++;
      cycles += count;
      wallSeconds += elapsed;
      const simulatedSeconds = count / timing.frequencyHz;
      return {
        from,
        to,
        cycles: count,
        simulatedSeconds,
        wallSeconds: elapsed,
        realTimeFactor: simulatedSeconds / elapsed,
        runUntilCalls: 1,
        oracleRunUntilCalls: 0,
        mode: 'board-local',
      };
    },
    verify() {
      valid();
      assert.equal(board.status, 'ready');
      assert.equal(board.time, cycles * timing.cyclePs);
      cpu.inputs.snapshotRequest.notify();
      board.runUntil(board.time);
      oracleRunUntilCalls++;
      const bytes = Uint8Array.from(cpu.memory.snapshot);
      const view = new DataView(bytes.buffer);
      const state = Object.fromEntries(
        snapshotFields.map((name, index) => [name, view.getUint32(index * 4, true)]),
      );
      const expected = oracle.advance(state.workCount);
      const ram = Uint8Array.from(cpu.memory.ram);
      assert.equal(state.acc, expected.acc, 'independent ALU checksum');
      assert.deepEqual(ram, expected.ram, 'all 64 useful-work RAM bytes');
      assert.equal(state.timerTicks, Math.floor(cycles / timing.timerCycles), 'real 1kHz timer');
      assert.equal(state.rxDropped, 0, 'persistent 16-byte hardware FIFO must not drop');
      assert.equal(drops.length, 0, 'hardware TX FIFO must not drop');
      assert.equal(reverseFrames.length, 0, 'no unintended reverse transmission');
      const quota = iterationsPerPeriod(config.busyPercent);
      if (config.busyPercent !== 100) {
        assert.equal(
          state.workCount + state.remaining,
          (state.timerTicks + 1) * quota,
          'no lost work releases',
        );
        const settledCycles = cycles - quota * timing.workCycles - 3 * quantumCycles;
        assert.ok(
          state.workCount >=
            (settledCycles <= 0 ? 0 : Math.ceil(settledCycles / timing.timerCycles)) * quota,
          'useful-work deadline progress',
        );
      } else {
        const overhead = (frames.length + state.timerTicks + 2) * 32 + 2 * quantumCycles;
        assert.ok(
          state.workCount >= Math.max(0, Math.floor((cycles - overhead) / timing.workCycles)),
          'full-busy CPU makes real work progress',
        );
      }
      assert.ok(state.workCount <= Math.ceil(cycles / timing.workCycles));
      const uartPeriodPs = config.uartPeriodMs * periodPs;
      let frameCount = 0;
      for (let burst = 0; burst * uartPeriodPs <= board.time; burst++) {
        const first = burst * uartPeriodPs + 9.5 * timing.bitTimePs;
        frameCount += Math.max(
          0,
          Math.min(
            timing.bytesPerPeriod,
            Math.floor((board.time - first) / (10 * timing.bitTimePs)) + 1,
          ),
        );
      }
      assert.equal(frames.length, frameCount, 'independent full-bit frame schedule');
      frames.forEach((frame, ordinal) => {
        const burst = Math.floor(ordinal / timing.bytesPerPeriod);
        const index = ordinal % timing.bytesPerPeriod;
        assert.deepEqual(
          frame,
          {
            time: burst * uartPeriodPs + (10 * index + 9.5) * timing.bitTimePs,
            value: { value: byteAt(ordinal), framingError: false, unknown: false },
          },
          'exact electrical frame bytes and timestamps',
        );
      });
      assert.equal(state.rxCount, frames.length, 'RX enters CPU FIFO at the decoded frame time');
      rxAcks.forEach((ack, ordinal) => {
        const frame = frames[ordinal];
        assert.ok(frame, 'cannot acknowledge an undecoded frame');
        assert.equal(ack.value, frame.value.value, 'FIFO byte order');
        assert.ok(
          ack.time >= frame.time && ack.time - frame.time <= irqBoundPs + 8 * timing.cyclePs,
          'sample-time RX IRQ response bound',
        );
      });
      assert.equal(state.rxServiced, rxAcks.length);
      assert.ok(state.rxCount >= state.rxServiced && state.rxCount - state.rxServiced <= 16);
      for (let index = rxAcks.length; index < frames.length; index++)
        assert.ok(
          board.time - frames[index].time <= irqBoundPs + 8 * timing.cyclePs,
          'no silent RX IRQ loss',
        );
      timerAcks.forEach((ack, index) => {
        assert.equal(ack.value, index + 1, 'one ISR per timer tick');
        assert.ok(
          ack.time >= ack.value * periodPs && ack.time - ack.value * periodPs <= irqBoundPs,
          'timer IRQ response bound',
        );
      });
      assert.equal(state.irqCount, timerAcks.length);
      assert.ok(state.irqCount <= state.timerTicks);
      if (state.irqCount < state.timerTicks)
        assert.ok(board.time - (state.irqCount + 1) * periodPs <= irqBoundPs, 'no lost timer IRQ');
      gpioEdges.forEach((edge, index) => {
        assert.equal(edge.value, (index + 1) % 2);
        assert.ok(edge.time >= (index + 1) * 10 * periodPs);
      });
      assert.equal(state.gpioCount, Math.floor(state.irqCount / 10));
      assert.equal(state.gpioCount, gpioEdges.length);
      return {
        mode: 'board-local',
        time: board.time,
        simulatedSeconds: cycles / timing.frequencyHz,
        nominalMHz: 100,
        state,
        ram: Array.from(ram),
        configuredUsefulBusyPercent: config.busyPercent,
        configuredUsefulCyclesPerPeriod: config.busyPercent * 1_000,
        usefulCyclesIssued: state.workCount * timing.workCycles,
        maxTimerIrqResponsePs: timerAcks.reduce(
          (max, ack) => Math.max(max, ack.time - ack.value * periodPs),
          0,
        ),
        timerIrqResponseBoundPs: irqBoundPs,
        hostCalls: calls(),
        traces: {
          frames: [...frames],
          rxAcks: [...rxAcks],
          timerAcks: [...timerAcks],
          gpioEdges: [...gpioEdges],
        },
        uart: {
          baud: 1e12 / timing.bitTimePs,
          bitTimePs: timing.bitTimePs,
          burstPeriodMs: config.uartPeriodMs,
          burstPeriodPs: uartPeriodPs,
          burstBytes: timing.bytesPerPeriod,
          delivery: 'model-at-frame-time',
          handoffPeriodPs: 0,
          pendingHandoff: 0,
          offeredBytesPerSecond: (timing.bytesPerPeriod * 1_000) / config.uartPeriodMs,
          received: frames.length,
          serviced: rxAcks.length,
          fifoPending: state.rxCount - state.rxServiced,
          fifoCapacity: 16,
          dropped: state.rxDropped + drops.length,
          framingErrors: 0,
          unknownSamples: 0,
          traceCapacity,
          receivedBytesPerSimulatedSecond: cycles
            ? frames.length / (cycles / timing.frequencyHz)
            : 0,
        },
      };
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        board.dispose();
      }
    },
  };
}
