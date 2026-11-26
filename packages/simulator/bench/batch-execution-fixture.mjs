/**
 * Shared batch-execution acceptance fixture. It stays environment-neutral so the Node
 * benchmark and the Chromium bundle run the same model, admission variants, correctness
 * checks and paired sampling loop.
 *
 * The measured workload is one long clean window: 65,536 byte stores with one 10 ps tick
 * per round. `done` publishes the final cursor value and its message timestamp is the
 * observable completion time. Scheduling counts come from an untimed run that wraps the
 * board's real EventQueue push/pop methods; timed runs never install probes.
 */

export const DEFAULT_ITERATIONS = 65_536;
export const DEFAULT_TICK_PS = 10;
export const FILL_VALUE = 42;
export const MEMORY_NAME = 'video';
export const DONE_CHANNEL = 'done';

const PROCESS_PROBE = Symbol.for('mica-js.simulator/processes');
const CHECKPOINT_PROBE = Symbol.for('mica-js.simulator/checkpoints');
const CHECKPOINT_EXPERIMENT = Symbol.for('mica-js.simulator/checkpoint-experiment');

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be positive`);
  return value;
}

export function normalizeConfig(input = {}) {
  const iterations = positiveInteger(input.iterations ?? DEFAULT_ITERATIONS, 'iterations');
  const tickPs = positiveInteger(input.tickPs ?? DEFAULT_TICK_PS, 'tickPs');
  if (iterations > 1_000_000) throw new RangeError('iterations must be <= 1,000,000');
  if (tickPs > 1_000_000_000) throw new RangeError('tickPs must be <= 1,000,000,000');
  const donePs = iterations * tickPs;
  const runUntilPs = donePs + tickPs;
  if (!Number.isSafeInteger(donePs) || !Number.isSafeInteger(runUntilPs))
    throw new RangeError('fixture time exceeds the safe integer range');
  return Object.freeze({
    iterations,
    tickPs,
    fillValue: FILL_VALUE,
    memory: MEMORY_NAME,
    channel: DONE_CHANNEL,
    donePs,
    runUntilPs,
  });
}

export function fillDeviceSource(input = {}) {
  const { iterations, tickPs } = normalizeConfig(input);
  return `device BatchFill {
  state cursor: number = 0;
  public memory ${MEMORY_NAME}[${iterations}];
  output channel ${DONE_CHANNEL}: number(capacity: 1);
  process start {
    while cursor < ${iterations} {
      store8(${MEMORY_NAME}, cursor, ${FILL_VALUE});
      cursor = cursor + 1;
      await ticks(${tickPs});
    }
    ${DONE_CHANNEL}.send(cursor);
  }
}`;
}

function fail(message) {
  throw new Error(`batch-execution fixture: ${message}`);
}

function machineOptions(variant) {
  const options = { execution: variant.execution ?? 'throughput' };
  if (variant.batchExecution !== undefined) options.batchExecution = variant.batchExecution;
  return options;
}

/**
 * Build one library, board and adapter. Creation is kept outside every timed run.
 * `register: true` exercises the process registration; `register: false` with
 * `batchExecution: true` is the enabled-but-no-candidate control.
 */
export function createExercise(sdk, model, configInput, variant) {
  const config = normalizeConfig(configInput);
  if (variant.register && typeof sdk?.createDeviceLibrary !== 'function')
    fail('SDK is missing createDeviceLibrary');
  const messages = [];
  let context;
  let registration;
  let registrationSupported = false;
  const library = sdk.createDeviceLibrary([
    {
      id: 'fill',
      model,
      create(device) {
        context = device;
        registrationSupported = typeof device.registerProcessBatch === 'function';
        if (variant.register) {
          if (!registrationSupported)
            fail('enabled board does not expose context.registerProcessBatch');
          registration = device.registerProcessBatch({
            process: { kind: 'start', index: 0 },
            loop: 0,
          });
        }
        return {
          sync(batch) {
            const channel = batch.outputs[DONE_CHANNEL];
            if (channel !== undefined)
              for (const message of channel)
                messages.push({ time: message.time, value: message.value });
          },
          dispose() {
            registration?.dispose?.();
            registration = undefined;
          },
        };
      },
    },
  ]);
  const board = sdk.createBoard(
    library,
    { instances: [{ id: 'fill', type: 'fill' }], nets: [] },
    machineOptions(variant),
  );
  return {
    board,
    messages,
    config,
    variant,
    get registrationSupported() {
      return registrationSupported;
    },
    memoryBytes() {
      if (!context) fail('factory did not run');
      return Uint8Array.from(context.memory[MEMORY_NAME]);
    },
    dispose() {
      board.dispose();
      context = undefined;
    },
  };
}

/**
 * Correctness precedes timing: exact bytes, final cursor and completion timestamp,
 * plus the final board time. Returns JSON-safe evidence.
 */
export function verifyExercise(exercise) {
  const { board, messages, config } = exercise;
  if (board.status !== 'ready') fail(`board status is ${board.status}`);
  if (board.time !== config.runUntilPs) fail(`board time ${board.time} != ${config.runUntilPs}`);
  if (messages.length !== 1) fail(`expected one done message, got ${messages.length}`);
  const [done] = messages;
  if (done.value !== config.iterations) fail(`done cursor ${done.value} != ${config.iterations}`);
  if (done.time !== config.donePs) fail(`done time ${done.time} != ${config.donePs}`);
  const bytes = exercise.memoryBytes();
  if (bytes.length !== config.iterations)
    fail(`memory length ${bytes.length} != ${config.iterations}`);
  let allBytes = true;
  let checksum = 0x811c9dc5;
  for (const byte of bytes) {
    if (byte !== config.fillValue) allBytes = false;
    checksum = Math.imul(checksum ^ byte, 0x01000193) >>> 0;
  }
  if (!allBytes) fail(`memory contains bytes other than ${config.fillValue}`);
  return Object.freeze({
    status: board.status,
    boardTime: board.time,
    cursor: done.value,
    doneTime: done.time,
    messageCount: messages.length,
    memoryLength: bytes.length,
    expectedByte: config.fillValue,
    allBytes,
    checksum,
  });
}

/**
 * Probe the public option shape with a registered-free factory, then report whether
 * the context exposes process registration. A baseline SDK rejects the unknown option
 * with INVALID_CONFIGURATION; every other failure is preserved.
 */
export function probeBatchSupport(sdk, model, configInput, execution = 'throughput') {
  let exercise;
  try {
    exercise = createExercise(sdk, model, configInput, {
      name: 'support-probe',
      batchExecution: true,
      register: false,
      execution,
    });
  } catch (cause) {
    if (cause?.code === 'INVALID_CONFIGURATION' && /batchExecution/.test(String(cause.message)))
      return Object.freeze({
        option: false,
        registration: false,
        error: Object.freeze({ code: cause.code, message: String(cause.message) }),
      });
    throw cause;
  }
  try {
    return Object.freeze({
      option: true,
      registration: exercise.registrationSupported,
      error: null,
    });
  } finally {
    exercise.dispose();
  }
}

export function candidateVariants(sdk, support) {
  const variants = [];
  if (support.option) {
    variants.push({
      name: 'disabled',
      sdk,
      batchExecution: false,
      // The plan validates the same declaration with the feature off; the opened board
      // pays its cold binding cost. Only the baseline SHA build cannot register.
      register: support.registration,
    });
    if (support.registration)
      variants.push({
        name: 'active',
        sdk,
        batchExecution: true,
        register: true,
      });
    variants.push({
      name: 'enabled-no-registration',
      sdk,
      batchExecution: true,
      register: false,
    });
  } else {
    variants.push({
      name: 'baseline-control',
      sdk,
      register: false,
    });
  }
  return variants;
}

/**
 * Candidate-only series used by the browser page. Node additionally mixes in an
 * isolated baseline SDK; the browser can pass the same baseline bundle through a
 * separate module graph.
 */
export function runCandidateAcceptance({
  sdk,
  baselineSdk,
  model,
  configInput,
  warmup = 5,
  samples = 25,
  execution = 'throughput',
  requireBatch = false,
  now = () => globalThis.performance.now(),
}) {
  const config = normalizeConfig(configInput);
  const support = probeBatchSupport(sdk, model, config, execution);
  if (requireBatch) {
    if (!support.option)
      throw new Error(
        'batchExecution option is not supported by the selected bundle; omit --require-batch ' +
          'to record the baseline control',
      );
    if (!support.registration)
      throw new Error('batchExecution is accepted but context.registerProcessBatch is unavailable');
  }
  const variants = candidateVariants(sdk, support);
  if (baselineSdk !== undefined)
    variants.push({ name: 'baseline-disabled', sdk: baselineSdk, register: false });
  const series = runSeries({ model, variants, configInput: config, warmup, samples, now });
  const acceptance = support.option
    ? acceptanceSummary(series, { baseline: baselineSdk !== undefined })
    : null;
  return Object.freeze({
    config,
    support,
    variants: series.variants,
    samples: series.samples,
    acceptance,
  });
}

/** Benchmark-local instrumentation over the board's real EventQueue. */
export function instrumentEventQueue(board) {
  const queue = board?.events;
  if (
    !queue ||
    typeof queue.push !== 'function' ||
    typeof queue.pop !== 'function' ||
    typeof queue.time !== 'number'
  )
    return null;
  let pushes = 0;
  let pops = 0;
  const originalPush = queue.push;
  const originalPop = queue.pop;
  queue.push = function push(time, value) {
    pushes++;
    return originalPush.call(this, time, value);
  };
  queue.pop = function pop() {
    pops++;
    return originalPop.call(this);
  };
  return {
    read() {
      return { pushes, pops };
    },
  };
}

/** Untimed admission probe over the existing scheduler gate; absent on baseline. */
export function instrumentBatchAdmission(board) {
  const prepareBatch = board?.prepareBatch;
  if (typeof prepareBatch !== 'function') return null;
  let attempts = 0;
  let admissions = 0;
  board.prepareBatch = function prepareBatchProbe(...args) {
    attempts++;
    const prepared = prepareBatch.apply(this, args);
    if (prepared !== undefined) admissions++;
    return prepared;
  };
  return {
    read() {
      return {
        available: true,
        basis:
          'board.prepareBatch wrapper in the untimed correctness run only; prepared results ' +
          'are committed by that verified run, real queue counts remain the main assertion',
        attempts,
        admissions,
        declines: attempts - admissions,
      };
    },
  };
}

function readBoardProbe(board, symbol) {
  try {
    const probe = board?.[symbol];
    if (typeof probe !== 'function') return null;
    return probe.call(board);
  } catch (cause) {
    return { error: String(cause?.message ?? cause) };
  }
}

export function withCheckpointDiagnostics(callback) {
  const hadPrevious = Object.hasOwn(globalThis, CHECKPOINT_EXPERIMENT);
  const previous = globalThis[CHECKPOINT_EXPERIMENT];
  const next =
    typeof previous === 'object' && previous !== null
      ? { ...previous, diagnostics: true }
      : { diagnostics: true };
  globalThis[CHECKPOINT_EXPERIMENT] = next;
  try {
    return callback();
  } finally {
    if (hadPrevious) globalThis[CHECKPOINT_EXPERIMENT] = previous;
    else delete globalThis[CHECKPOINT_EXPERIMENT];
  }
}

export function percentile(values, ratio) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * ratio) - 1];
}

export function summarize(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return Object.freeze({
    samples: sorted.length,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    meanMs: total / sorted.length,
  });
}

function rotate(variants, offset) {
  const start = offset % variants.length;
  return variants.slice(start).concat(variants.slice(0, start));
}

/**
 * Run correctness instrumentation, one cold create-to-complete sample per variant,
 * `warmup` discarded rounds, then `samples` recorded rounds. Variant order rotates
 * every round so each group sees the same alternating cache/thermal conditions.
 */
export function runSeries({
  model,
  variants,
  configInput,
  warmup,
  samples,
  now = () => globalThis.performance.now(),
}) {
  if (!Array.isArray(variants) || variants.length === 0) fail('at least one variant is required');
  if (!Number.isSafeInteger(warmup) || warmup < 0) fail('warmup must be a non-negative integer');
  if (!Number.isSafeInteger(samples) || samples < 1) fail('samples must be positive');
  const config = normalizeConfig(configInput);
  const evidence = Object.create(null);
  const timers = new Map();
  for (const variant of variants) {
    if (evidence[variant.name] !== undefined) fail(`duplicate variant ${variant.name}`);
    // A per-variant closure keeps the timed `runUntil` call site monomorphic. Sharing one
    // call site across candidate and baseline BoardRuntime classes would make the harness
    // pay a polymorphic dispatch that production does not.
    timers.set(variant.name, (exercise) => {
      const start = now();
      exercise.board.runUntil(config.runUntilPs);
      return now() - start;
    });
    evidence[variant.name] = {
      name: variant.name,
      options: machineOptions(variant),
      registration: variant.register === true,
      correctness: null,
      scheduling: null,
      batchAdmission: null,
      probes: null,
      cold: null,
      warm: null,
    };
  }

  // 1. Untimed correctness run with diagnostics, real queue counters and the existing
  // scheduler admission gate.
  for (const variant of variants) {
    let exercise;
    try {
      const result = withCheckpointDiagnostics(() => {
        exercise = createExercise(variant.sdk, model, config, variant);
        const queue = instrumentEventQueue(exercise.board);
        const admission = instrumentBatchAdmission(exercise.board);
        exercise.board.runUntil(config.runUntilPs);
        const verification = verifyExercise(exercise);
        return {
          verification,
          scheduling: queue ? Object.freeze({ ...queue.read(), instrumented: true }) : null,
          batchAdmission: admission ? Object.freeze(admission.read()) : null,
          probes: Object.freeze({
            processes: readBoardProbe(exercise.board, PROCESS_PROBE),
            checkpoints: readBoardProbe(exercise.board, CHECKPOINT_PROBE),
          }),
        };
      });
      evidence[variant.name].correctness = result.verification;
      evidence[variant.name].scheduling = result.scheduling;
      evidence[variant.name].batchAdmission = result.batchAdmission;
      evidence[variant.name].probes = result.probes;
    } finally {
      exercise?.dispose();
    }
  }

  // 2. A fresh board timed through completion. This shares the already-warmed JS engine
  // with the correctness probes, so it is not process/browser startup or a cold VM.
  const coldOrder = rotate(variants, 0);
  for (const variant of coldOrder) {
    let exercise;
    try {
      const createStart = now();
      exercise = createExercise(variant.sdk, model, config, variant);
      const createEnd = now();
      const runMs = timers.get(variant.name)(exercise);
      const runEnd = now();
      verifyExercise(exercise);
      evidence[variant.name].cold = Object.freeze({
        label: 'new board / pre-sampled create-to-complete',
        createMs: createEnd - createStart,
        runMs,
        totalMs: runEnd - createStart,
      });
    } finally {
      exercise?.dispose();
    }
  }

  // 3. Warmups and recorded paired samples. Only runUntil is inside the timer.
  const recorded = [];
  for (let round = 0; round < warmup + samples; round++) {
    const order = rotate(variants, round);
    const measured = Object.create(null);
    for (const variant of order) {
      let exercise;
      try {
        exercise = createExercise(variant.sdk, model, config, variant);
        measured[variant.name] = timers.get(variant.name)(exercise);
        verifyExercise(exercise);
      } finally {
        exercise?.dispose();
      }
    }
    if (round >= warmup)
      recorded.push(
        Object.freeze({
          index: round - warmup,
          order: Object.freeze(order.map((variant) => variant.name)),
          ms: Object.freeze({ ...measured }),
        }),
      );
  }
  for (const variant of variants) {
    evidence[variant.name].warm = summarize(recorded.map((sample) => sample.ms[variant.name]));
  }
  return Object.freeze({ config, variants: evidence, samples: Object.freeze(recorded) });
}

export function pairedComparison(series, candidate, reference) {
  const candidateEvidence = series.variants[candidate];
  const referenceEvidence = series.variants[reference];
  if (!candidateEvidence || !referenceEvidence) return null;
  const ratios = series.samples.map((sample) => sample.ms[candidate] / sample.ms[reference]);
  return Object.freeze({
    candidate,
    reference,
    ratioOfMedians: candidateEvidence.warm.medianMs / referenceEvidence.warm.medianMs,
    medianPairedRatio: percentile(ratios, 0.5),
    p95PairedRatio: percentile(ratios, 0.95),
    pairs: ratios.length,
  });
}

export function expectedProcessScheduling(configInput) {
  const { iterations } = normalizeConfig(configInput);
  // The initial start round runs normally; the first wake at `tickPs` can then fold the
  // remaining rounds into one wake at `donePs`. With fewer than three iterations there
  // is no eligible fold, so each ordinary round leaves one real wake.
  const runsBatch = iterations >= 3;
  const expectedPushes = runsBatch ? 2 : iterations;
  return Object.freeze({
    runsBatch,
    expectedPushes,
    expectedPops: expectedPushes,
    expectedWakeReduction: iterations > 0 ? 1 - expectedPushes / iterations : null,
    basis:
      'pure-fill process topology; first round stays ordinary, then one real fold wake ' +
      'when at least three rounds fit before the end target',
  });
}

export function schedulingSummary(series) {
  const disabled = series.variants.disabled?.scheduling;
  const active = series.variants.active?.scheduling;
  const noRegistration = series.variants['enabled-no-registration']?.scheduling;
  if (!disabled || !active || !noRegistration) return null;
  const expected = expectedProcessScheduling(series.config);
  return Object.freeze({
    measurement: 'real EventQueue push/pop counts',
    topology: 'pure-fill process fixture',
    note:
      'Avoided wakeups are the measured disabled-minus-active push delta; folded rounds are ' +
      'not directly instrumented.',
    disabledPushes: disabled.pushes,
    disabledPops: disabled.pops,
    activePushes: active.pushes,
    activePops: active.pops,
    enabledNoRegistrationPushes: noRegistration.pushes,
    enabledNoRegistrationPops: noRegistration.pops,
    avoidedWakeups: disabled.pushes - active.pushes,
    wakeReduction: disabled.pushes > 0 ? 1 - active.pushes / disabled.pushes : null,
    admission: series.variants.active.batchAdmission,
    expected,
    activeExpectedPushes: expected.expectedPushes,
  });
}

export function acceptanceSummary(series, { baseline = false, thresholds } = {}) {
  const schedule = schedulingSummary(series);
  const activeVsDisabled = pairedComparison(series, 'active', 'disabled');
  const noRegistrationVsDisabled = pairedComparison(series, 'enabled-no-registration', 'disabled');
  const baselineComparison = baseline
    ? pairedComparison(series, 'disabled', 'baseline-disabled')
    : null;
  const noRegistrationVsBaseline = baseline
    ? pairedComparison(series, 'enabled-no-registration', 'baseline-disabled')
    : null;
  const limits = {
    minWakeReduction: thresholds?.minWakeReduction ?? 0.9,
    minActiveMedianSpeedup: thresholds?.minActiveMedianSpeedup ?? 0.1,
    maxNoCandidateOverhead: thresholds?.maxNoCandidateOverhead ?? 0.03,
  };
  const checks = {
    wakeReduction:
      schedule?.wakeReduction == null ? null : schedule.wakeReduction >= limits.minWakeReduction,
    activeMedianSpeedup:
      activeVsDisabled == null
        ? null
        : 1 - activeVsDisabled.ratioOfMedians >= limits.minActiveMedianSpeedup,
    disabledOverheadVsBaseline:
      baselineComparison == null
        ? null
        : baselineComparison.ratioOfMedians - 1 <= limits.maxNoCandidateOverhead,
    noRegistrationOverheadVsBaseline:
      noRegistrationVsBaseline == null
        ? null
        : noRegistrationVsBaseline.ratioOfMedians - 1 <= limits.maxNoCandidateOverhead,
    noRegistrationOverheadVsDisabled:
      noRegistrationVsDisabled == null
        ? null
        : noRegistrationVsDisabled.ratioOfMedians - 1 <= limits.maxNoCandidateOverhead,
  };
  const required = [
    checks.wakeReduction,
    checks.activeMedianSpeedup,
    baseline ? checks.disabledOverheadVsBaseline : checks.noRegistrationOverheadVsDisabled,
  ];
  if (baseline) required.push(checks.noRegistrationOverheadVsBaseline);
  return Object.freeze({
    thresholdBasis:
      'ratioOfMedians across steady-state samples; medianPairedRatio is retained as a ' +
      'pairing/noise diagnostic',
    schedule,
    comparisons: Object.freeze({
      activeVsDisabled,
      enabledNoRegistrationVsDisabled: noRegistrationVsDisabled,
      disabledVsBaseline: baselineComparison,
      enabledNoRegistrationVsBaseline: noRegistrationVsBaseline,
    }),
    thresholds: Object.freeze(limits),
    checks: Object.freeze(checks),
    passed: required.every((value) => value === true),
  });
}
