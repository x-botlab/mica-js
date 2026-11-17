import type {
  ICanvasAdvanceSample,
  ICanvasEditorMeasurement,
  ICanvasRenderSample,
  ICanvasTopicMessageSample,
  ICanvasWidgetFrameSample,
} from '@mica-js/editor';

/**
 * Browser-side canvas measurement.
 *
 * - Only `?measure=1` exposes an editor observer; the default page samples nothing.
 * - `start()` assumes a just-reset simulation paused at simTime=0. `warmupMs` and `windowMs` are
 *   simulated milliseconds, never wall-clock milliseconds.
 * - Cold and steady windows split on completed tick `simTime`; a tick spanning a boundary is
 *   excluded from both windows and counted as a crossing. Paused rounds (`dt = 0`) record nothing.
 * - Section wall time starts at `start()` for the cold start and at the last warmup round's
 *   completion for steady state, so scheduling idle before the first steady round is counted.
 * - Raw records use fixed-capacity rings; evictions are reported as `dropped`.
 * - `start()` is only accepted from `idle` or `stopped`. A running, stopping, or in-flight
 *   measurement must settle first; `start()` throws instead of orphaning the pending `stop()`.
 * - The warmup-boundary tick's wall completion and simulation position are kept outside the ring
 *   buffers, so evicting warmup records cannot move the steady wall anchor back to `start()`.
 * - A missing or non-contiguous advance record marks the window incomplete.
 * - Artifact hashing is a host concern; `setArtifacts()` only stores a pre-measurement snapshot.
 */

export type MeasurementPhase = 'idle' | 'warmup' | 'window' | 'stopped';
export type MeasurementPayload = string | number | boolean | null;

/** Simulated-time durations, not wall-clock durations. */
export const MEASURE_WARMUP_SIM_MS = 512;
export const MEASURE_WINDOW_SIM_MS = 1024;
export const MEASURE_DEFAULT_CAPACITY = 8192;
const PS_PER_MS = 1_000_000_000;

export interface IMeasurementClock {
  now(): number;
}

export interface IMeasurementOptions {
  /** Defaults to `?measure=1`. */
  readonly enabled?: boolean;
  /** Ring-buffer capacity per lane; defaults to 8192 records. */
  readonly capacity?: number;
  readonly clock?: IMeasurementClock;
}

export interface IMeasurementStartOptions {
  /** Simulated warmup duration in ms; defaults to 512. */
  readonly warmupMs?: number;
  /** Simulated steady window in ms; defaults to 1024. Zero keeps it open until stop(). */
  readonly windowMs?: number;
}

export interface IMeasurementScenario {
  readonly documentId?: string;
  readonly stepMs?: number;
  readonly execution?: 'throughput' | 'precise';
  readonly clockFrequencyHz?: number;
  readonly firmware?: string;
  readonly notes?: readonly string[];
}

export interface IMeasurementSection {
  readonly advances: number;
  readonly sim: { readonly fromPs: number; readonly toPs: number; readonly elapsedMs: number };
  /**
   * Wall-clock span of the section. For steady state this starts at the last warmup round's
   * completion, so scheduling idle before the first steady round is included.
   */
  readonly elapsedWallMs: number;
  /** Backward-compatible alias of `elapsedWallMs`. */
  readonly wallMs: number;
  /** Simulation milliseconds per wall millisecond; wall clock only. */
  readonly realtimeRatio: number | null;
  readonly renders: number;
  readonly frames: number;
  readonly topics: number;
}

export type IMeasurementTopicRecord = Omit<ICanvasTopicMessageSample, 'payload'> & {
  readonly payload: MeasurementPayload;
};

export interface IMeasurementArtifact {
  readonly path: string;
  readonly source: string;
  readonly bytes: number | null;
  readonly sha256: string | null;
  readonly error: string | null;
}

export interface IMeasurementArtifacts {
  readonly status: 'disabled' | 'pending' | 'ok' | 'partial' | 'failed';
  readonly note: string;
  readonly files: readonly IMeasurementArtifact[];
}

interface ILaneBuffer {
  readonly retained: number;
  readonly dropped: number;
}

export interface IMeasurementReport {
  readonly version: 1;
  readonly tool: 'mica-browser-measure';
  readonly createdAt: number;
  readonly phase: MeasurementPhase;
  readonly cpu: { readonly available: false; readonly reason: string };
  readonly scenario: IMeasurementScenario;
  readonly controls: {
    readonly startedAt: number | null;
    readonly stoppedAt: number | null;
    readonly warmupSimMs: number;
    readonly windowSimMs: number;
    readonly boundarySimPs: number;
    readonly endSimPs: number | null;
    readonly complete: boolean;
    readonly incompleteReason: string | null;
    readonly crossBoundary: number;
    readonly crossEnd: number;
  };
  readonly artifacts: IMeasurementArtifacts;
  readonly coldStart: IMeasurementSection;
  readonly steadyState: IMeasurementSection;
  readonly raw: {
    readonly advances: readonly ICanvasAdvanceSample[];
    readonly renders: readonly ICanvasRenderSample[];
    readonly frames: readonly ICanvasWidgetFrameSample[];
    readonly topics: readonly IMeasurementTopicRecord[];
  };
  readonly buffers: {
    readonly capacity: number;
    readonly advances: ILaneBuffer;
    readonly renders: ILaneBuffer;
    readonly frames: ILaneBuffer;
    readonly topics: ILaneBuffer;
  };
  readonly warnings: readonly string[];
}

export interface IMeasurementApi {
  readonly enabled: boolean;
  start(options?: IMeasurementStartOptions): void;
  stop(): Promise<IMeasurementReport>;
  report(): IMeasurementReport;
  setScenario(scenario: IMeasurementScenario): void;
  setArtifacts(artifacts: IMeasurementArtifacts): void;
  readonly editorMeasurement: ICanvasEditorMeasurement | undefined;
}

class BoundedBuffer<T> {
  readonly capacity: number;
  #items: T[] = [];
  #head = 0;
  #dropped = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0)
      throw new RangeError('capacity must be a positive integer.');
    this.capacity = capacity;
  }

  get size(): number {
    return this.#items.length;
  }

  get dropped(): number {
    return this.#dropped;
  }

  push(value: T): void {
    if (this.#items.length < this.capacity) {
      this.#items.push(value);
      return;
    }
    this.#items[this.#head] = value;
    this.#head = (this.#head + 1) % this.capacity;
    this.#dropped += 1;
  }

  clear(): void {
    this.#items = [];
    this.#head = 0;
    this.#dropped = 0;
  }

  oldest(): T | undefined {
    return this.#items.length === 0 ? undefined : this.#items[this.#head];
  }

  toArray(): T[] {
    return [...this.#items.slice(this.#head), ...this.#items.slice(0, this.#head)];
  }
}

type AdvanceClass = 'cold' | 'steady' | 'cross-start' | 'cross-end' | 'after';

interface IRawRecords {
  readonly advances: readonly ICanvasAdvanceSample[];
  readonly renders: readonly ICanvasRenderSample[];
  readonly frames: readonly ICanvasWidgetFrameSample[];
  readonly topics: readonly IMeasurementTopicRecord[];
}

/** Last round that started before the warmup boundary, retained outside the ring buffers. */
interface IBoundaryAnchor {
  /** Simulation time when that round completed; the next steady round must start here. */
  readonly simPs: number;
  /** Wall-clock completion used as the steady-state wall anchor. */
  readonly completedAt: number;
}

interface ISelection {
  readonly advances: readonly ICanvasAdvanceSample[];
  readonly renders: readonly ICanvasRenderSample[];
  readonly frames: readonly ICanvasWidgetFrameSample[];
  readonly topics: readonly IMeasurementTopicRecord[];
  readonly crossStart: number;
  readonly crossEnd: number;
}

function isMeasurementLocationEnabled(): boolean {
  const location = (globalThis as { readonly location?: { readonly search?: string } }).location;
  return new URLSearchParams(location?.search ?? '').get('measure') === '1';
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function summarizePayload(payload: unknown): MeasurementPayload {
  if (payload === null) return null;
  switch (typeof payload) {
    case 'number':
    case 'boolean':
      return payload;
    case 'string':
      return payload.length <= 64 ? payload : `${payload.slice(0, 64)}…`;
    case 'bigint':
      return `${payload.toString()}n`;
    case 'undefined':
      return 'undefined';
    case 'object':
      if (payload instanceof Uint8Array) return `bytes:${payload.byteLength}`;
      if (Array.isArray(payload)) return `array:${payload.length}`;
      return 'object';
    default:
      return typeof payload;
  }
}

function advanceClass(
  sample: ICanvasAdvanceSample,
  boundaryPs: number,
  endPs: number | null,
): AdvanceClass {
  const startedPs = sample.simTime - sample.dt;
  if (startedPs >= boundaryPs && (endPs === null || sample.simTime <= endPs)) return 'steady';
  if (sample.simTime <= boundaryPs && startedPs >= 0) return 'cold';
  if (startedPs < boundaryPs && sample.simTime > boundaryPs) return 'cross-start';
  if (endPs !== null && startedPs < endPs && sample.simTime > endPs) return 'cross-end';
  return 'after';
}

function selectSection(
  kind: 'cold' | 'steady',
  raw: IRawRecords,
  boundaryPs: number,
  endPs: number | null,
  boundaryWall: number,
): ISelection {
  const classes = raw.advances.map((sample) => advanceClass(sample, boundaryPs, endPs));
  const classifyAt = (at: number, simTime?: number): AdvanceClass => {
    for (let index = 0; index < raw.advances.length; index += 1) {
      const sample = raw.advances[index]!;
      if (at >= sample.startedAt && at <= sample.completedAt) return classes[index]!;
    }
    if (simTime !== undefined)
      return simTime <= boundaryPs
        ? 'cold'
        : endPs === null || simTime <= endPs
          ? 'steady'
          : 'after';
    return at < boundaryWall ? 'cold' : 'steady';
  };
  return {
    advances: raw.advances.filter((_, index) => classes[index] === kind),
    renders: raw.renders.filter((sample) => classifyAt(sample.startedAt) === kind),
    frames: raw.frames.filter((sample) => classifyAt(sample.at) === kind),
    topics: raw.topics.filter((sample) => classifyAt(sample.at, sample.simTime) === kind),
    crossStart: classes.filter((value) => value === 'cross-start').length,
    crossEnd: classes.filter((value) => value === 'cross-end').length,
  };
}

/**
 * Wall-clock anchor for a section. Steady state anchors at the last round that started before
 * the warmup boundary, so idle scheduling gaps are not silently dropped from the ratio.
 */
function buildSection(
  selection: ISelection,
  fallbackFromPs: number,
  wallFrom: number | null,
): IMeasurementSection {
  const first = selection.advances[0];
  const last = selection.advances[selection.advances.length - 1];
  const fromPs = first === undefined ? fallbackFromPs : first.simTime - first.dt;
  const toPs = last === undefined ? fallbackFromPs : last.simTime;
  const wallMs =
    wallFrom === null || last === undefined ? 0 : Math.max(0, last.completedAt - wallFrom);
  const simMs = (toPs - fromPs) / PS_PER_MS;
  return {
    advances: selection.advances.length,
    sim: { fromPs, toPs, elapsedMs: round(simMs) },
    elapsedWallMs: round(wallMs),
    wallMs: round(wallMs),
    realtimeRatio: wallMs > 0 ? round(simMs / wallMs, 4) : null,
    renders: selection.renders.length,
    frames: selection.frames.length,
    topics: selection.topics.length,
  };
}

/** Creates one recorder. `browserMeasurement` below is the page-wide instance. */
export function createMeasurementRecorder(options: IMeasurementOptions = {}): IMeasurementApi {
  return new MeasurementRecorder(options);
}

class MeasurementRecorder implements IMeasurementApi {
  readonly enabled: boolean;
  readonly #capacity: number;
  readonly #clock: IMeasurementClock;
  readonly #callbacks: ICanvasEditorMeasurement;
  readonly #advances: BoundedBuffer<ICanvasAdvanceSample>;
  readonly #renders: BoundedBuffer<ICanvasRenderSample>;
  readonly #frames: BoundedBuffer<ICanvasWidgetFrameSample>;
  readonly #topics: BoundedBuffer<IMeasurementTopicRecord>;
  #phase: MeasurementPhase = 'idle';
  #startedAt: number | null = null;
  #stoppedAt: number | null = null;
  #warmupSimMs = MEASURE_WARMUP_SIM_MS;
  #windowSimMs = MEASURE_WINDOW_SIM_MS;
  #boundarySimPs = MEASURE_WARMUP_SIM_MS * PS_PER_MS;
  #endSimPs = (MEASURE_WARMUP_SIM_MS + MEASURE_WINDOW_SIM_MS) * PS_PER_MS;
  #baselineChecked = false;
  #baselineMismatch: number | null = null;
  #boundary: IBoundaryAnchor | null = null;
  #firstSteadyStartedPs: number | null = null;
  #lastSteadySimPs: number | null = null;
  #lastAdvanceSimPs: number | null = null;
  #advanceGap = false;
  #steadyEvicted = false;
  #inFlight = 0;
  #idleWaiters: (() => void)[] = [];
  #stopping: Promise<IMeasurementReport> | undefined;
  #cached: IMeasurementReport | undefined;
  #scenario: IMeasurementScenario = {};
  #artifacts: IMeasurementArtifacts | undefined;

  constructor(options: IMeasurementOptions) {
    this.enabled = options.enabled ?? isMeasurementLocationEnabled();
    this.#capacity = options.capacity ?? MEASURE_DEFAULT_CAPACITY;
    this.#clock = options.clock ?? { now: () => performance.now() };
    this.#advances = new BoundedBuffer<ICanvasAdvanceSample>(this.#capacity);
    this.#renders = new BoundedBuffer<ICanvasRenderSample>(this.#capacity);
    this.#frames = new BoundedBuffer<ICanvasWidgetFrameSample>(this.#capacity);
    this.#topics = new BoundedBuffer<IMeasurementTopicRecord>(this.#capacity);
    this.#callbacks = {
      advanceStart: () => this.#onAdvanceStart(),
      advanceSettled: () => this.#onAdvanceSettled(),
      advance: (sample) => this.#onAdvance(sample),
      render: (sample) => this.#onRender(sample),
      widgetFrame: (sample) => this.#onFrame(sample),
      topic: (message) => this.#onTopic(message),
    };
  }

  get editorMeasurement(): ICanvasEditorMeasurement | undefined {
    return this.enabled ? this.#callbacks : undefined;
  }

  setScenario(scenario: IMeasurementScenario): void {
    this.#scenario = scenario;
  }

  setArtifacts(artifacts: IMeasurementArtifacts): void {
    this.#artifacts = artifacts;
  }

  start(options: IMeasurementStartOptions = {}): void {
    if (!this.enabled) throw new Error('Measurement is disabled; open the page with ?measure=1.');
    if (this.#phase === 'warmup' || this.#phase === 'window')
      throw new Error(
        this.#stopping === undefined
          ? 'Measurement is already running; await stop() before start().'
          : 'Measurement is stopping; await the pending stop() before start().',
      );
    if (this.#inFlight > 0)
      throw new Error('An editor advance is still in flight; await advanceSettled before start().');
    const warmupMs = options.warmupMs ?? MEASURE_WARMUP_SIM_MS;
    const windowMs = options.windowMs ?? MEASURE_WINDOW_SIM_MS;
    if (!Number.isFinite(warmupMs) || warmupMs < 0)
      throw new RangeError('warmupMs must be a non-negative finite number of simulated ms.');
    if (!Number.isFinite(windowMs) || windowMs < 0)
      throw new RangeError('windowMs must be a non-negative finite number of simulated ms.');
    this.#advances.clear();
    this.#renders.clear();
    this.#frames.clear();
    this.#topics.clear();
    this.#phase = warmupMs > 0 ? 'warmup' : 'window';
    this.#startedAt = this.#clock.now();
    this.#stoppedAt = null;
    this.#stopping = undefined;
    this.#cached = undefined;
    this.#baselineChecked = false;
    this.#baselineMismatch = null;
    this.#boundary = null;
    this.#firstSteadyStartedPs = null;
    this.#lastSteadySimPs = null;
    this.#lastAdvanceSimPs = null;
    this.#advanceGap = false;
    this.#steadyEvicted = false;
    this.#warmupSimMs = warmupMs;
    this.#windowSimMs = windowMs;
    this.#boundarySimPs = warmupMs * PS_PER_MS;
    this.#endSimPs = this.#boundarySimPs + windowMs * PS_PER_MS;
  }

  stop(): Promise<IMeasurementReport> {
    if (this.#phase === 'idle')
      return Promise.reject(new Error('Measurement has not started; call start().'));
    if (this.#cached !== undefined) return Promise.resolve(this.#cached);
    this.#stopping ??= this.#finish();
    return this.#stopping;
  }

  report(): IMeasurementReport {
    return this.#cached ?? this.#buildReport(this.#artifacts ?? this.#missingArtifacts());
  }

  #onAdvanceStart(): void {
    // While stopping, new rounds must not keep the pending stop() waiting. Outside an active
    // measurement, still count the round so start() can refuse to begin mid-advance instead of
    // resetting the counter and faking a clean baseline.
    if (this.#stopping !== undefined && (this.#phase === 'warmup' || this.#phase === 'window'))
      return;
    this.#inFlight += 1;
  }

  #onAdvanceSettled(): void {
    if (this.#inFlight === 0) return;
    this.#inFlight -= 1;
    if (this.#inFlight > 0) return;
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  #onAdvance(sample: ICanvasAdvanceSample): void {
    if (this.#stopping !== undefined && this.#inFlight === 0) return;
    if (this.#phase !== 'warmup' && this.#phase !== 'window') return;
    // Paused frames and dispatch refreshes run no simulation tick (`dt === 0`). Letting them
    // through would satisfy the baseline check, advance the phase, or stop the window early.
    if (sample.dt <= 0) return;
    const startedPs = sample.simTime - sample.dt;
    if (!this.#baselineChecked) {
      this.#baselineChecked = true;
      if (startedPs !== 0) this.#baselineMismatch = startedPs;
    }
    // Buffer eviction must not lose the steady window's anchor or simulated boundary. A jump
    // means an advance record (or simulated time) is missing, so the window is not verifiable
    // as complete even when its retained endpoints look right.
    if (this.#lastAdvanceSimPs !== null && startedPs !== this.#lastAdvanceSimPs)
      this.#advanceGap = true;
    this.#lastAdvanceSimPs = sample.simTime;
    const endPs = this.#windowSimMs > 0 ? this.#endSimPs : null;
    const kind = advanceClass(sample, this.#boundarySimPs, endPs);
    if (kind === 'cold' || kind === 'cross-start')
      this.#boundary = { simPs: sample.simTime, completedAt: sample.completedAt };
    else if (kind === 'steady') {
      this.#firstSteadyStartedPs ??= startedPs;
      this.#lastSteadySimPs = sample.simTime;
    }
    const evicted =
      this.#advances.size === this.#advances.capacity ? this.#advances.oldest() : undefined;
    this.#advances.push(sample);
    if (evicted !== undefined && advanceClass(evicted, this.#boundarySimPs, endPs) === 'steady')
      this.#steadyEvicted = true;
    if (this.#phase === 'warmup' && sample.simTime > this.#boundarySimPs) this.#phase = 'window';
    if (this.#windowSimMs > 0 && sample.simTime >= this.#endSimPs)
      void this.stop().catch(() => undefined);
  }

  #onRender(sample: ICanvasRenderSample): void {
    if (this.#stopping !== undefined && this.#inFlight === 0) return;
    if (this.#phase === 'warmup' || this.#phase === 'window') this.#renders.push(sample);
  }

  #onFrame(sample: ICanvasWidgetFrameSample): void {
    if (this.#stopping !== undefined && this.#inFlight === 0) return;
    if (this.#phase === 'warmup' || this.#phase === 'window') this.#frames.push(sample);
  }

  #onTopic(message: ICanvasTopicMessageSample): void {
    if (this.#stopping !== undefined && this.#inFlight === 0) return;
    if (this.#phase !== 'warmup' && this.#phase !== 'window') return;
    this.#topics.push({ ...message, payload: summarizePayload(message.payload) });
  }

  async #finish(): Promise<IMeasurementReport> {
    while (this.#inFlight > 0)
      await new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
    this.#phase = 'stopped';
    this.#stoppedAt = this.#clock.now();
    const report = this.#buildReport(this.#artifacts ?? this.#missingArtifacts());
    this.#cached = report;
    return report;
  }

  #missingArtifacts(): IMeasurementArtifacts {
    return {
      status: 'pending',
      note: 'Artifacts were not verified before measurement; no source match is claimed.',
      files: [],
    };
  }

  #buildReport(artifacts: IMeasurementArtifacts): IMeasurementReport {
    const now = this.#clock.now();
    const raw: IRawRecords = {
      advances: this.#advances.toArray(),
      renders: this.#renders.toArray(),
      frames: this.#frames.toArray(),
      topics: this.#topics.toArray(),
    };
    const boundaryPs = this.#boundarySimPs;
    const endPs = this.#windowSimMs > 0 ? this.#endSimPs : null;
    const classes = raw.advances.map((sample) => advanceClass(sample, boundaryPs, endPs));
    const coldSamples = raw.advances.filter((_, index) => classes[index] === 'cold');
    const steadySamples = raw.advances.filter((_, index) => classes[index] === 'steady');
    const firstSteady = steadySamples[0];
    const boundaryWall =
      this.#boundary?.completedAt ??
      firstSteady?.startedAt ??
      coldSamples[coldSamples.length - 1]?.completedAt ??
      this.#startedAt ??
      now;
    const coldSelection = selectSection('cold', raw, boundaryPs, endPs, boundaryWall);
    const steadySelection = selectSection('steady', raw, boundaryPs, endPs, boundaryWall);
    // Steady state is measured from the last round that started before the boundary. The anchor
    // lives outside the ring buffers, so evicting warmup records cannot fall back to start() and
    // mix the cold start into steady-state wall time. Starting at the first steady round would
    // discard scheduling idle and inflate the realtime ratio.
    const steadyWallFrom = this.#boundary?.completedAt ?? this.#startedAt ?? firstSteady?.startedAt;
    const coldWallFrom = this.#startedAt ?? coldSamples[0]?.startedAt;
    const complete =
      this.#windowSimMs > 0 &&
      this.#baselineMismatch === null &&
      !this.#advanceGap &&
      !this.#steadyEvicted &&
      this.#firstSteadyStartedPs === boundaryPs &&
      (this.#boundary === null || this.#boundary.simPs === boundaryPs) &&
      endPs !== null &&
      this.#lastSteadySimPs !== null &&
      this.#lastSteadySimPs >= endPs;
    let incompleteReason: string | null = null;
    if (this.#baselineMismatch !== null)
      incompleteReason = `The first tick started at ${round(
        this.#baselineMismatch / PS_PER_MS,
      )} simulated ms, not 0; call start() after reset() and pause().`;
    else if (this.#windowSimMs <= 0)
      incompleteReason =
        'windowMs=0 keeps the steady window open until stop(); no complete window is defined.';
    else if (this.#advanceGap)
      incompleteReason =
        'Advance records are missing or the simulated timeline skipped ahead; the steady window is not contiguous.';
    else if (this.#steadyEvicted)
      incompleteReason =
        'Steady advance samples were evicted by the fixed-capacity buffer; the window cannot be verified.';
    else if (this.#firstSteadyStartedPs === null)
      incompleteReason = 'No steady tick completed inside the requested window.';
    else if (this.#firstSteadyStartedPs !== boundaryPs)
      incompleteReason =
        'The first steady tick did not start at the warmup boundary; the boundary-crossing tick was excluded.';
    else if (endPs === null || this.#lastSteadySimPs === null || this.#lastSteadySimPs < endPs)
      incompleteReason = `The steady window did not reach ${this.#windowSimMs} simulated ms; the window-ending tick was in flight or stop() was called early.`;
    const warnings: string[] = [];
    if (this.#phase === 'idle') warnings.push('Measurement has not started; call start().');
    if (this.#phase === 'warmup' || this.#phase === 'window')
      warnings.push('Measurement is still running; call stop() after the window closes.');
    if (!complete)
      warnings.push(
        `Measurement window is incomplete: ${incompleteReason} Steady-state values are not valid data.`,
      );
    if (raw.advances.length === 0) warnings.push('No advance samples were recorded.');
    if (artifacts.status !== 'ok' && artifacts.status !== 'disabled')
      warnings.push(`Artifact verification is ${artifacts.status}.`);
    const dropped =
      this.#advances.dropped + this.#renders.dropped + this.#frames.dropped + this.#topics.dropped;
    if (dropped > 0)
      warnings.push(
        `${dropped} raw records were dropped by fixed-capacity buffers; sections only cover retained records.`,
      );
    return {
      version: 1,
      tool: 'mica-browser-measure',
      createdAt: now,
      phase: this.#phase,
      cpu: {
        available: false,
        reason:
          'Browser JavaScript cannot read process.cpuUsage(); realtimeRatio is simulation wall-clock time only.',
      },
      scenario: this.#scenario,
      controls: {
        startedAt: this.#startedAt,
        stoppedAt: this.#stoppedAt,
        warmupSimMs: this.#warmupSimMs,
        windowSimMs: this.#windowSimMs,
        boundarySimPs: boundaryPs,
        endSimPs: endPs,
        complete,
        incompleteReason,
        crossBoundary: coldSelection.crossStart,
        crossEnd: coldSelection.crossEnd,
      },
      artifacts,
      coldStart: buildSection(coldSelection, 0, coldWallFrom ?? null),
      steadyState: buildSection(steadySelection, boundaryPs, steadyWallFrom ?? null),
      raw,
      buffers: {
        capacity: this.#capacity,
        advances: { retained: this.#advances.size, dropped: this.#advances.dropped },
        renders: { retained: this.#renders.size, dropped: this.#renders.dropped },
        frames: { retained: this.#frames.size, dropped: this.#frames.dropped },
        topics: { retained: this.#topics.size, dropped: this.#topics.dropped },
      },
      warnings,
    };
  }
}

/** Page-wide singleton; only installed on `window.__micaMeasure` with `?measure=1`. */
export const browserMeasurement: IMeasurementApi = createMeasurementRecorder();

if (browserMeasurement.enabled)
  (globalThis as { __micaMeasure?: IMeasurementApi }).__micaMeasure = browserMeasurement;
