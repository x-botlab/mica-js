import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  timing,
  snapshotFields,
  modelFor,
  uartModel,
  translator,
  byteAt,
  iterationsPerPeriod,
  createWorkOracle,
} from './workloads/typical-mcu.mjs';

export { timing };
export const limits = Object.freeze({ cycles: 100_000_000, matrixCycles: 200_000_000 });
export const defaults = Object.freeze({
  waiting: 'wfi',
  busyPercent: 1,
  execution: 'throughput',
  uartPeriodMs: 1,
  cycles: 1_000_000,
});
const periodPs = timing.timerCycles * timing.cyclePs;
const handoffPs = timing.handoffCycles * timing.cyclePs;
const irqBoundPs = timing.quantumPs + (timing.workCycles + 2) * timing.cyclePs;
const integer = (value, min, max, label) => {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${label} must be an integer in [${min}, ${max}]`);
};

/** duration is seconds; cycles is an alternative cumulative run budget, not work MHz. */
export function normalizeOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('Options must be an object');
  for (const key of Object.keys(options))
    if (![...Object.keys(defaults), 'duration'].includes(key))
      throw new TypeError(`Unknown option: ${key}`);
  if (Object.hasOwn(options, 'duration') && Object.hasOwn(options, 'cycles'))
    throw new RangeError('Specify duration or cycles, not both');
  const config = { ...defaults, ...options };
  if (Object.hasOwn(options, 'duration')) {
    if (!Number.isFinite(options.duration) || options.duration <= 0 || options.duration > 1)
      throw new RangeError('duration must be in (0, 1] seconds');
    config.cycles = Math.round(options.duration * timing.frequencyHz);
    if (Math.abs(config.cycles / timing.frequencyHz - options.duration) > 1e-15)
      throw new RangeError('duration must be an integral number of 100MHz cycles');
    delete config.duration;
  }
  if (!['wfi', 'poll'].includes(config.waiting))
    throw new RangeError('waiting must be wfi or poll');
  if (![1, 10, 30, 100].includes(config.busyPercent))
    throw new RangeError('busyPercent must be 1, 10, 30, or 100');
  if (!['throughput', 'precise'].includes(config.execution))
    throw new RangeError('execution must be throughput or precise');
  integer(config.cycles, 1, limits.cycles, 'cycles');
  integer(config.uartPeriodMs, 1, 1_000, 'uartPeriodMs');
  return Object.freeze(config);
}

/**
 * Single nominal-100MHz synthetic MCU, 1kHz timer IRQ, hardware UART, 100Hz GPIO.
 * Timed calls contain only board.runUntil. Output append-only sync is part of SDK
 * execution; input generation, fixed-grid UART handoff, captures and oracle are not.
 * UART TX offers 11-byte bursts every uartPeriodMs (default 1ms, 11000 B/s)
 * into the unchanged full-bit fixture, independently of the 1ms CPU/timer period.
 * RX hands off at fixed 10us boundaries into a modeled persistent 16-byte FIFO.
 * These external delivery times are identical for precise and throughput boards.
 * create() is cold: it never advances the board or captures state.
 */
export function create(sdk, options = {}) {
  const config = normalizeOptions(options);
  if (typeof sdk?.createBoard !== 'function' || typeof sdk?.createDeviceLibrary !== 'function')
    throw new TypeError('Supply the public simulator SDK module');
  const model = modelFor(config.busyPercent);
  const uartPeriodPs = config.uartPeriodMs * periodPs;
  const cpu = [];
  const uarts = [];
  const frames = [];
  const reverseFrames = [];
  const timerAcks = [];
  const rxAcks = [];
  const gpioEdges = [];
  const drops = [];
  const deliveries = [];
  const library = sdk.createDeviceLibrary([
    {
      id: 'cpu',
      model,
      create(ctx) {
        cpu.push(ctx);
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
            timerAcks.push(...batch.outputs.timerAck);
            rxAcks.push(...batch.outputs.rxAck);
            gpioEdges.push(...batch.outputs.gpioEdge);
          },
          dispose() {
            binding.dispose();
          },
        };
      },
    },
    {
      id: 'uart',
      model: uartModel,
      create(ctx) {
        const index = uarts.length;
        uarts.push(ctx);
        return {
          sync(batch) {
            (index === 1 ? frames : reverseFrames).push(...batch.outputs.received);
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
      instances: [
        { id: 'cpu', type: 'cpu' },
        { id: 'sender', type: 'uart', props: { bitTime: timing.bitTimePs } },
        { id: 'receiver', type: 'uart', props: { bitTime: timing.bitTimePs } },
      ],
      nets: [
        ...[
          ['supply', 3.3],
          ['reference', 0],
        ].map(([id, voltage]) => ({
          id,
          voltage,
          pins: ['cpu', 'sender', 'receiver'].map((instance) => endpoint(instance, id)),
        })),
        { id: 'serial', pins: [endpoint('sender', 'tx'), endpoint('receiver', 'rx')] },
        { id: 'return', pins: [endpoint('receiver', 'tx'), endpoint('sender', 'rx')] },
        { id: 'gpio', pins: [endpoint('cpu', 'gpio')] },
      ],
    },
    { execution: config.execution, cpuQuantum: timing.quantumPs },
  );
  const oracle = createWorkOracle();
  let cycles = 0;
  let disposed = false;
  let stagedFrames = 0;
  let injectedPeriods = 0;
  let checkedFrames = 0;
  let checkedAcks = 0;
  let checkedTimer = 0;
  let checkedGpio = 0;
  let totalWallSeconds = 0;
  const valid = () => {
    if (disposed) throw new Error('Typical MCU is disposed');
  };
  function feed() {
    const offset = injectedPeriods * timing.bytesPerPeriod;
    uarts[0].inputs.transmit.send(
      Uint8Array.from({ length: timing.bytesPerPeriod }, (_, n) => byteAt(offset + n)),
    );
    injectedPeriods++;
  }
  feed();
  function handoff() {
    while (stagedFrames < frames.length) {
      const frame = frames[stagedFrames++];
      deliveries.push({ time: board.time, frameTime: frame.time, value: frame.value.value });
      cpu[0].inputs.rxByte.send(frame.value.value);
    }
    if (board.time % uartPeriodPs === 0 && board.time < config.cycles * timing.cyclePs) feed();
  }
  return {
    board,
    model,
    config,
    description:
      'Synthetic 100MHz scalar/RAM MCU, not ARM/AVR. 1kHz timer IRQ; full 8N1 electrical UART fixture; ' +
      `11-byte TX bursts every ${config.uartPeriodMs}ms; fixed 10us host RX handoff into persistent ` +
      '16-byte hardware FIFO. No per-instruction host instrumentation.',
    get progress() {
      return {
        cycles,
        time: cycles * timing.cyclePs,
        simulatedSeconds: cycles / timing.frequencyHz,
        wallSeconds: totalWallSeconds,
        budgetCycles: config.cycles,
      };
    },
    step(count = Math.min(timing.timerCycles, config.cycles - cycles)) {
      valid();
      integer(count, 1, config.cycles, 'step cycles');
      if (cycles + count > config.cycles) throw new RangeError('Cumulative cycle budget exceeded');
      if (board.time !== cycles * timing.cyclePs) throw new Error('Advance through step() only');
      const from = board.time;
      const to = (cycles + count) * timing.cyclePs;
      let wallSeconds = 0;
      let calls = 0;
      while (board.time < to) {
        const next = Math.min(to, (Math.floor(board.time / handoffPs) + 1) * handoffPs);
        const start = performance.now();
        board.runUntil(next);
        wallSeconds += (performance.now() - start) / 1_000;
        calls++;
        if (next % handoffPs === 0) handoff();
      }
      cycles += count;
      totalWallSeconds += wallSeconds;
      const simulatedSeconds = (to - from) / 1e12;
      return {
        from,
        to,
        cycles: count,
        simulatedSeconds,
        wallSeconds,
        realTimeFactor: simulatedSeconds / wallSeconds,
        runUntilCalls: calls,
      };
    },
    verify() {
      valid();
      assert.equal(board.status, 'ready');
      assert.equal(board.time, cycles * timing.cyclePs);
      cpu[0].inputs.snapshotRequest.notify();
      board.runUntil(board.time);
      const bytes = Uint8Array.from(cpu[0].memory.snapshot);
      const view = new DataView(bytes.buffer);
      const state = Object.fromEntries(
        snapshotFields.map((name, index) => [name, view.getUint32(index * 4, true)]),
      );
      const expected = oracle.advance(state.workCount);
      assert.equal(state.acc, expected.acc, 'independent ALU checksum');
      assert.deepEqual(
        Uint8Array.from(cpu[0].memory.ram),
        expected.ram,
        'all useful-work RAM bytes',
      );
      assert.equal(state.timerTicks, Math.floor(cycles / timing.timerCycles), 'real 1kHz timer');
      assert.equal(state.rxDropped, 0, 'persistent hardware RX FIFO must not drop bytes');
      assert.equal(drops.length, 0, 'UART hardware TX FIFO must not drop bytes');
      assert.equal(reverseFrames.length, 0, 'no unintended reverse transmission');
      const quota = iterationsPerPeriod(config.busyPercent);
      if (config.busyPercent !== 100) {
        assert.equal(
          state.workCount + state.remaining,
          (state.timerTicks + 1) * quota,
          'no lost work releases',
        );
        // Every release must finish by its useful-work budget plus IRQ/observation margin.
        const settledCycles = cycles - quota * timing.workCycles - 3 * timing.handoffCycles;
        const completedReleases =
          settledCycles <= 0 ? 0 : Math.ceil(settledCycles / timing.timerCycles);
        assert.ok(
          state.workCount >= completedReleases * quota,
          'useful work must make independent deadline progress',
        );
        assert.ok(
          state.workCount <= Math.ceil(Math.max(0, cycles) / timing.workCycles),
          'work cannot exceed elapsed CPU cycles',
        );
      } else {
        const overheadBound =
          (frames.length + state.timerTicks + 2) * 32 + 2 * timing.handoffCycles;
        assert.ok(
          state.workCount >= Math.max(0, Math.floor((cycles - overheadBound) / timing.workCycles)),
          'full-busy reference must execute real work',
        );
        assert.ok(state.workCount <= Math.ceil(cycles / timing.workCycles));
      }
      const expectedFrameCount = (() => {
        let count = 0;
        for (let period = 0; period < injectedPeriods; period++) {
          const first = period * uartPeriodPs + timing.bitTimePs * 9.5;
          count += Math.max(
            0,
            Math.min(
              timing.bytesPerPeriod,
              Math.floor((board.time - first) / (10 * timing.bitTimePs)) + 1,
            ),
          );
        }
        return count;
      })();
      assert.equal(frames.length, expectedFrameCount, 'independent full-bit UART frame schedule');
      for (; checkedFrames < frames.length; checkedFrames++) {
        const frame = frames[checkedFrames];
        const period = Math.floor(checkedFrames / timing.bytesPerPeriod);
        const index = checkedFrames % timing.bytesPerPeriod;
        assert.deepEqual(
          frame,
          {
            time: period * uartPeriodPs + (10 * index + 9.5) * timing.bitTimePs,
            value: { value: byteAt(checkedFrames), framingError: false, unknown: false },
          },
          'UART bytes, order, electrical sample and timestamp',
        );
      }
      for (; checkedAcks < rxAcks.length; checkedAcks++) {
        const ack = rxAcks[checkedAcks];
        const delivery = deliveries[checkedAcks];
        assert.ok(delivery, 'CPU cannot consume an undelivered byte');
        assert.equal(ack.value, byteAt(checkedAcks), 'CPU FIFO retains every UART byte in order');
        assert.ok(
          ack.time >= delivery.time && ack.time - delivery.time <= irqBoundPs + 8 * timing.cyclePs,
          'UART service response bound',
        );
      }
      assert.equal(state.rxServiced, rxAcks.length);
      assert.ok(state.rxCount <= deliveries.length && state.rxCount >= rxAcks.length);
      for (let index = rxAcks.length; index < deliveries.length; index++)
        assert.ok(
          board.time - deliveries[index].time <= irqBoundPs + 8 * timing.cyclePs,
          'no silent UART loss',
        );
      for (; checkedTimer < timerAcks.length; checkedTimer++) {
        const ack = timerAcks[checkedTimer];
        assert.equal(ack.value, checkedTimer + 1, 'one ISR per timer tick, in order');
        assert.ok(
          ack.time >= ack.value * periodPs && ack.time - ack.value * periodPs <= irqBoundPs,
          'actual timer IRQ response <= quantum + intrinsic work/entry',
        );
      }
      assert.equal(state.irqCount, timerAcks.length);
      assert.ok(state.irqCount <= state.timerTicks);
      if (state.irqCount < state.timerTicks)
        assert.ok(board.time - (state.irqCount + 1) * periodPs <= irqBoundPs, 'no lost timer IRQ');
      for (; checkedGpio < gpioEdges.length; checkedGpio++) {
        const edge = gpioEdges[checkedGpio];
        assert.equal(edge.value, (checkedGpio + 1) % 2);
        assert.ok(edge.time >= (checkedGpio + 1) * 10 * periodPs);
      }
      assert.equal(state.gpioCount, Math.floor(state.irqCount / 10));
      assert.equal(state.gpioCount, gpioEdges.length);
      const usefulCyclesIssued = state.workCount * timing.workCycles;
      const serviceCyclesIssuedEstimate = (state.irqCount + state.rxServiced) * 8;
      const eligibleWaitingCyclesEstimate =
        config.busyPercent === 100
          ? 0
          : Math.max(0, cycles - usefulCyclesIssued - serviceCyclesIssuedEstimate);
      return {
        time: board.time,
        simulatedSeconds: cycles / timing.frequencyHz,
        nominalMHz: 100,
        state,
        configuredUsefulBusyPercent: config.busyPercent,
        configuredUsefulCyclesPerPeriod: config.busyPercent * 1_000,
        usefulCyclesIssued,
        serviceCyclesIssuedEstimate,
        eligibleWaitingCyclesEstimate,
        cycleEstimates: {
          executed:
            config.waiting === 'poll' && config.execution === 'precise'
              ? cycles
              : Math.min(cycles, usefulCyclesIssued + serviceCyclesIssuedEstimate),
          idle: config.waiting === 'wfi' ? eligibleWaitingCyclesEstimate : 0,
          skipped:
            config.waiting === 'poll' && config.execution === 'throughput'
              ? eligibleWaitingCyclesEstimate
              : 0,
          derivation:
            'Precise polling executes the elapsed timeline. Otherwise executed is issued useful work plus acknowledged 8-cycle IRQ service; WFI residual is idle-eligible, throughput-poll residual is skip-eligible. Residual estimates include uncounted dispatch/partial-instruction cycles, not runtime statistics.',
        },
        accounting:
          'Useful cycles are work-result count x 10 (issued; last instruction may be incomplete). Service estimate is acknowledgments x 8; excludes terminal partial entry. Waiting estimate is residual elapsed cycles, includes dispatch/partial-instruction uncertainty. No backend executed/idle/skipped counters are available; estimates are not measured CPU MHz.',
        waitingClassification:
          config.waiting === 'poll' && config.execution === 'precise'
            ? 'Residual waiting executes real polling instructions; no skipped-cycle claim.'
            : 'Residual waiting is eligible for WFI/poll parking; actual skipped cycles are not instrumented.',
        maxTimerIrqResponsePs: timerAcks.reduce(
          (max, ack) => Math.max(max, ack.time - ack.value * periodPs),
          0,
        ),
        timerIrqResponseBoundPs: irqBoundPs,
        uart: {
          baud: 1e12 / timing.bitTimePs,
          bitTimePs: timing.bitTimePs,
          burstPeriodMs: config.uartPeriodMs,
          burstPeriodPs: uartPeriodPs,
          burstBytes: timing.bytesPerPeriod,
          handoffPeriodPs: handoffPs,
          offeredBytesPerSecond: (timing.bytesPerPeriod * 1_000) / config.uartPeriodMs,
          received: frames.length,
          serviced: rxAcks.length,
          pendingHandoff: frames.length - deliveries.length,
          fifoPending: state.rxCount - state.rxServiced,
          fifoCapacity: 16,
          dropped: state.rxDropped + drops.length,
          framingErrors: 0,
          unknownSamples: 0,
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

export function parseArgs(args) {
  const config = {
    durationMs: 10,
    warmupMs: 1,
    uartPeriodMs: defaults.uartPeriodMs,
    executions: ['throughput'],
    waitings: ['wfi', 'poll'],
    busy: [1, 10, 30, 100],
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const value = args[++index];
    if (value === undefined) throw new RangeError(`Missing value for ${arg}`);
    if (arg === '--duration-ms') config.durationMs = Number(value);
    else if (arg === '--warmup-ms') config.warmupMs = Number(value);
    else if (arg === '--uart-period-ms') config.uartPeriodMs = Number(value);
    else if (arg === '--execution')
      config.executions = value === 'all' ? ['throughput', 'precise'] : [value];
    else if (arg === '--waiting') config.waitings = value === 'both' ? ['wfi', 'poll'] : [value];
    else if (arg === '--busy') config.busy = value.split(',').map(Number);
    else throw new RangeError(`Unknown argument: ${arg}`);
  }
  integer(config.durationMs * 100_000, 1, limits.cycles, 'duration cycles');
  integer(config.warmupMs * 100_000, 1, config.durationMs * 100_000 - 1, 'warmup cycles');
  for (const execution of config.executions)
    for (const waiting of config.waitings)
      for (const busyPercent of config.busy)
        normalizeOptions({
          execution,
          waiting,
          busyPercent,
          duration: config.durationMs / 1_000,
          uartPeriodMs: config.uartPeriodMs,
        });
  for (const entries of [config.executions, config.waitings, config.busy])
    if (new Set(entries).size !== entries.length) throw new RangeError('Duplicate matrix entry');
  if (
    config.durationMs *
      100_000 *
      config.executions.length *
      config.waitings.length *
      config.busy.length >
    limits.matrixCycles
  )
    throw new RangeError('Aggregate matrix budget exceeded; select fewer cases for long runs');
  return config;
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      'Usage: node packages\\simulator\\bench\\typical-mcu.mjs ' +
        '[--duration-ms 10] [--warmup-ms 1] [--uart-period-ms 1] [--execution throughput|precise|all] ' +
        '[--waiting wfi|poll|both] [--busy 1,10,30,100]\n' +
        'Default: 8 throughput cases (2 waiting modes x 4 busy levels), each with ' +
        '1ms cold/warm-up advancement and one 9ms warm sample; 10ms total simulation per case. ' +
        'No repeated-sample flag. For a 10ms warm sample use --duration-ms 11 --warmup-ms 1.\n' +
        'UART: 11-byte bursts at 115200 baud; --uart-period-ms 1 offers 11000 B/s (default stress), ' +
        '--uart-period-ms 10 offers 1100 B/s (moderate); IRQ and CPU periods stay 1ms.\n' +
        'Bounds: duration >0 and <=1000ms, warmup >0 and <duration, integral 100MHz cycles; ' +
        'uart-period-ms integer 1..1000; ' +
        '<=100M cycles/case, <=200M aggregate cycles. Select fewer cases for long runs. ' +
        'JSON stdout. Synthetic MCU, not physical ARM/AVR. Only board.runUntil is timed; ' +
        'setup, host UART handoff and verification are excluded.',
    );
    return;
  }
  const options = parseArgs(args);
  const sdk = await import('../dist/index.js');
  for (const execution of options.executions)
    for (const waiting of options.waitings)
      for (const busyPercent of options.busy) {
        const bench = create(sdk, {
          execution,
          waiting,
          busyPercent,
          uartPeriodMs: options.uartPeriodMs,
          duration: options.durationMs / 1_000,
        });
        try {
          const cold = bench.step(options.warmupMs * 100_000);
          bench.verify();
          const warm = bench.step(bench.config.cycles - bench.progress.cycles);
          const evidence = bench.verify();
          console.log(
            JSON.stringify({
              execution,
              waiting,
              busyPercent,
              uartPeriodMs: options.uartPeriodMs,
              timingScope:
                'Only board.runUntil, including SDK sync; excludes setup, host handoff and verification.',
              cold: { ...cold, label: 'first advancement including lazy board/JIT setup' },
              warm: {
                ...warm,
                label: 'same board after cold advancement and untimed verification',
              },
              evidence,
            }),
          );
        } finally {
          bench.dispose();
        }
      }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
