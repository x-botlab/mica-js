/* global clearInterval, setInterval */
import {
  createPowerRuntime,
  createScheduler,
  timePs,
  type PowerRuntime,
  type TimePs,
} from '@mica-js/core';
import {
  createDeviceInstance,
  DeviceError,
  loadDeviceModule,
  type DeviceDescription,
  type DeviceInstance,
  type IDeviceProvider,
  type LoadedDeviceModule,
  type TopicPayload,
} from '@mica-js/device';
import {
  createDeviceSimExecutor,
  type AdvanceReport,
  type DeviceSimExecutor,
  type DeviceSimHost,
  type SimulationDiagnostic,
  type SimulationState,
} from '@mica-js/simulator';
import { createExampleProvider } from './devices';
import {
  parseHexBytes,
  type Probe,
  type Scenario,
  type ScenarioAction,
  type ScenarioInput,
} from './scenarios';
import {
  describeError,
  describePayload,
  digestTrace,
  type DiagnosticEntry,
  type TraceEntry,
} from './trace';

/** Every advance covers this slice of virtual time; 10 ns matches one teaching-MCU instruction. */
export const STEP_PS = 10_000;
/** Wall-clock spacing of the run loop; virtual time only ever moves by {@link STEP_PS}. */
const TICK_MS = 16;

export type SessionPhase = 'idle' | 'loading' | 'ready' | 'faulted' | 'disposed' | 'failed';

export interface ProbeReading {
  readonly id: string;
  readonly title: string;
  readonly value: string;
  readonly ready: boolean;
}

export interface DevicePortInfo {
  readonly key: string;
  readonly direction: 'input' | 'output';
  readonly type: string;
  readonly title?: string;
}

export interface DeviceCapability {
  readonly symbol: string;
  /** Designator shown to the reader; the schematic id stays available as {@link symbol}. */
  readonly label: string;
  readonly deviceId: string;
  readonly displayName: string;
  readonly pins: readonly string[];
  readonly connections: readonly string[];
  readonly ports: readonly DevicePortInfo[];
  /** Whether the model's own reset lifecycle is declared; the executor reset is separate. */
  readonly reset: 'supported' | 'unsupported' | 'unknown';
  readonly resetDetail: string;
}

export interface ReplayResult {
  readonly equal: boolean;
  readonly digests: readonly string[];
  readonly steps: number;
  readonly entries: number;
}

export interface SessionSnapshot {
  readonly phase: SessionPhase;
  readonly running: boolean;
  readonly simTime: TimePs;
  readonly steps: number;
  readonly state: SimulationState | 'loading' | 'failed';
  readonly lastReport: (AdvanceReport & { readonly step: number }) | undefined;
  readonly lastError: string | undefined;
  readonly probes: readonly ProbeReading[];
  readonly trace: readonly TraceEntry[];
  readonly diagnostics: readonly DiagnosticEntry[];
  readonly capabilities: readonly DeviceCapability[];
  readonly topics: readonly string[];
}

/**
 * One loaded scenario: the executor, the host wiring it runs against, the probe readings and the
 * event trace.
 *
 * Everything here is DOM-free, so the same class drives the browser bench and the deterministic
 * replay unit test. The canvas and the widget sandbox stay with the app layer.
 */
export class SimulationSession {
  readonly scenario: Scenario;

  readonly #provider: IDeviceProvider = createExampleProvider();
  readonly #traceLimit: number;
  readonly #listeners = new Set<() => void>();
  #executor: DeviceSimExecutor | undefined;
  #power: PowerRuntime | undefined;
  #phase: SessionPhase = 'idle';
  #running = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #steps = 0;
  #seq = 0;
  #trace: TraceEntry[] = [];
  #diagnostics: DiagnosticEntry[] = [];
  #readings: ProbeReading[] = [];
  #capabilities: readonly DeviceCapability[] = [];
  #lastReport: (AdvanceReport & { readonly step: number }) | undefined;
  #lastError: string | undefined;

  constructor(scenario: Scenario, traceLimit = 200) {
    this.scenario = scenario;
    this.#traceLimit = traceLimit;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  get executor(): DeviceSimExecutor | undefined {
    return this.#executor;
  }

  getPhase(): SessionPhase {
    return this.#phase;
  }

  getTrace(): readonly TraceEntry[] {
    return this.#trace;
  }

  getSnapshot(): SessionSnapshot {
    return {
      phase: this.#phase,
      running: this.#running,
      simTime: this.#executor?.getSimTime() ?? timePs(0),
      steps: this.#steps,
      state: this.#phase === 'failed' ? 'failed' : (this.#executor?.getState() ?? 'idle'),
      lastReport: this.#lastReport,
      lastError: this.#lastError,
      probes: this.#readings,
      trace: this.#trace,
      diagnostics: this.#diagnostics,
      capabilities: this.#capabilities,
      topics: (this.#executor?.getTopics() ?? []).map(
        (topic) => `${this.#symbolLabel(topic.symbol)}.${topic.port}`,
      ),
    };
  }

  async load(): Promise<void> {
    if (this.#phase === 'disposed') {
      throw new Error('会话已销毁，不能再次加载。');
    }
    this.#phase = 'loading';
    this.#lastError = undefined;
    this.#notify();

    const executor = createDeviceSimExecutor({
      devices: this.#provider,
      onDiagnostic: (diagnostic) => this.#pushDiagnostic(diagnostic),
      host: (context) => this.#createHost(context.scheduler),
    });
    this.#executor = executor;
    executor.onPublish((publish) => {
      this.#push({
        kind: 'publish',
        simTime: publish.simTime,
        label: `${this.#symbolLabel(publish.target.symbol)}.${publish.target.port}`,
        detail: describePayload(publish.payload),
      });
    });

    try {
      await executor.loadSchematic(this.scenario.schematic);
      this.#phase = 'ready';
      this.#steps = 0;
      this.#readings = [];
      this.#sampleProbes();
      this.#push({
        kind: 'system',
        simTime: timePs(0),
        label: '加载完成',
        detail: `${this.scenario.schematic.sheet.symbols.length} 个器件实例，时钟归零`,
      });
    } catch (error) {
      this.#phase = 'failed';
      this.#lastError = describeError(error);
      this.#push({ kind: 'error', simTime: timePs(0), label: '加载失败', detail: this.#lastError });
      this.#notify();
      return;
    }
    try {
      this.#capabilities = await this.#describeDevices();
    } catch (error) {
      this.#diagnostics = [
        ...this.#diagnostics,
        {
          seq: this.#nextSeq(),
          code: 'bench/capability-failed',
          message: describeError(error),
        },
      ].slice(-40);
    }
    this.#notify();
  }

  start(): void {
    if (this.#running || this.#executor?.getState() !== 'ready') {
      return;
    }
    this.#running = true;
    this.#timer = setInterval(() => {
      this.step();
    }, TICK_MS);
    this.#push({
      kind: 'system',
      simTime: this.#executor.getSimTime(),
      label: '启动',
      detail: `每 ${TICK_MS} ms 推进 ${STEP_PS} ps 虚拟时间`,
    });
    this.#notify();
  }

  pause(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    if (!this.#running) {
      return;
    }
    this.#running = false;
    this.#push({
      kind: 'system',
      simTime: this.#executor?.getSimTime() ?? timePs(0),
      label: '暂停',
      detail: '虚拟时间停在当前值，未执行的条目保持排队',
    });
    this.#notify();
  }

  /** Advances exactly one {@link STEP_PS} slice. */
  step(): void {
    const executor = this.#executor;
    if (executor === undefined || executor.getState() !== 'ready') {
      return;
    }
    try {
      const report = executor.advance(timePs(STEP_PS));
      this.#steps += 1;
      this.#lastReport = { ...report, step: this.#steps };
      this.#lastError = undefined;
      this.#sampleProbes();
    } catch (error) {
      this.#handleAdvanceFailure(error);
    }
    this.#notify();
  }

  reset(): void {
    const executor = this.#executor;
    if (executor === undefined || executor.getState() === 'disposed') {
      return;
    }
    this.pause();
    try {
      executor.reset();
      this.#phase = 'ready';
      this.#steps = 0;
      this.#lastReport = undefined;
      this.#lastError = undefined;
      this.#readings = [];
      this.#push({
        kind: 'system',
        simTime: timePs(0),
        label: '复位',
        detail: '实例按当前原理图重建，时钟归零；器件 reset 生命周期由能力面板单独标注',
      });
      this.#sampleProbes();
    } catch (error) {
      this.#lastError = describeError(error);
      this.#push({
        kind: 'error',
        simTime: executor.getSimTime(),
        label: '复位失败',
        detail: this.#lastError,
      });
    }
    this.#notify();
  }

  /** Keeps the executor and its host wiring; the app tears the widget host down separately. */
  dispose(): void {
    this.pause();
    try {
      this.#executor?.dispose();
    } catch (error) {
      this.#lastError = describeError(error);
    }
    this.#executor = undefined;
    this.#power = undefined;
    this.#phase = 'disposed';
    this.#readings = [];
    this.#notify();
    this.#listeners.clear();
  }

  /**
   * Delivers one payload through the executor.
   *
   * Invalid targets and payloads are rejected out loud: the return value says whether the value
   * was queued, and the reason lands in the diagnostics instead of being dropped.
   */
  deliver(symbol: string, port: string, payload: TopicPayload, label: string): boolean {
    const executor = this.#executor;
    if (executor === undefined || executor.getState() !== 'ready') {
      this.#reject(
        `执行器当前状态为 ${executor?.getState() ?? 'idle'}，无法投递 ${symbol}.${port}。`,
      );
      return false;
    }
    try {
      executor.deliver({ symbol, port }, payload);
    } catch (error) {
      this.#reject(`${label} 被拒绝：${describeError(error)}`);
      return false;
    }
    this.#push({
      kind: 'input',
      simTime: executor.getSimTime(),
      label,
      detail: `${symbol}.${port} ← ${describePayload(payload)}（排入下一次 advance）`,
    });
    this.#notify();
    return true;
  }

  /** Presses a scenario's `press` input; the canvas widget uses the same endpoint. */
  pressInput(inputId: string, pressed: boolean): boolean {
    const input = this.#inputs().find((entry) => entry.id === inputId);
    if (input === undefined || input.kind !== 'press') {
      this.#reject(`场景 ${this.scenario.id} 没有按压输入 ${inputId}。`);
      return false;
    }
    return this.deliver(
      input.symbol,
      input.port,
      pressed,
      `${input.title}：${pressed ? '按下' : '松开'}`,
    );
  }

  /** Records a widget publish for the trace; the widget host routes the payload itself. */
  noteWidgetPublish(endpoint: string, payload: unknown, simTime: number): void {
    // A widget may report `0` when it did not attach a simulation time; keep the trace typed.
    const stamp = Number.isSafeInteger(simTime) && simTime > 0 ? timePs(simTime) : timePs(0);
    this.#push({
      kind: 'input',
      simTime: stamp,
      label: `widget → ${endpoint}`,
      detail: describePayload(payload),
    });
    this.#notify();
  }

  /** Parses hex bytes and delivers them; a malformed string is rejected before it reaches the device. */
  sendHex(inputId: string, hex: string): boolean {
    const input = this.#inputs().find((entry) => entry.id === inputId);
    if (input === undefined || input.kind !== 'bytes') {
      this.#reject(`场景 ${this.scenario.id} 没有字节输入 ${inputId}。`);
      return false;
    }
    let bytes: Uint8Array;
    try {
      bytes = parseHexBytes(hex);
    } catch (error) {
      this.#reject(`${input.title}：${describeError(error)}`);
      return false;
    }
    return this.deliver(input.symbol, input.port, bytes, input.title);
  }

  /** Sends a payload the port type does not accept, so the bench can show a real rejection. */
  sendUnsupportedPayload(inputId: string): boolean {
    const input = this.#inputs().find((entry) => entry.id === inputId);
    if (input === undefined || input.kind !== 'bytes') {
      this.#reject(`场景 ${this.scenario.id} 没有字节输入 ${inputId}。`);
      return false;
    }
    return this.deliver(input.symbol, input.port, 'not-bytes', `${input.title}（非法载荷演示）`);
  }

  /**
   * Loads the scenario twice and runs the fixed script on both: two fresh runtimes must produce
   * the same virtual-time event trace. Nothing from the interactive session is reused.
   */
  async replay(): Promise<ReplayResult> {
    this.pause();
    const digests: string[] = [];
    let entries = 0;
    for (let run = 0; run < 2; run += 1) {
      const session = new SimulationSession(this.scenario, Number.POSITIVE_INFINITY);
      try {
        await session.load();
        session.#runScript();
        const trace = session.getTrace();
        entries = trace.length;
        digests.push(
          digestTrace(trace, session.#executor?.getSimTime() ?? timePs(0), session.#steps),
        );
      } finally {
        session.dispose();
      }
    }
    const first = digests[0] ?? '';
    const second = digests[1] ?? '';
    this.#push({
      kind: 'system',
      simTime: this.#executor?.getSimTime() ?? timePs(0),
      label: '确定性回放',
      detail: `${this.scenario.replaySteps} 步 × 2 次，摘要 ${first} / ${second}`,
    });
    this.#notify();
    return { equal: first === second, digests, steps: this.scenario.replaySteps, entries };
  }

  #runScript(): void {
    for (let step = 1; step <= this.scenario.replaySteps; step += 1) {
      for (const action of this.scenario.script) {
        if (action.step === step) {
          this.#applyAction(action);
        }
      }
      this.step();
    }
  }

  #applyAction(action: ScenarioAction): void {
    const input = this.#inputs().find((entry) => entry.id === action.input);
    if (input === undefined) {
      this.#reject(`回放脚本引用了未知输入 ${action.input}。`);
      return;
    }
    if (input.kind === 'press') {
      this.pressInput(input.id, action.value === 'true');
      return;
    }
    this.sendHex(input.id, action.value);
  }

  #inputs(): readonly ScenarioInput[] {
    return this.scenario.inputs;
  }

  #createHost(scheduler: ReturnType<typeof createScheduler>): DeviceSimHost {
    const power = createPowerRuntime(scheduler, this.scenario.board.power, {
      instanceId: 'bench-power',
      pinStates: this.scenario.board.pinStates,
      floating: { seed: 63 },
    });
    this.#power = power;
    const grants = this.scenario.updateResources;
    return {
      pinHost: power,
      topology: power,
      instanceOptions: (symbol) => {
        const resources = grants?.[symbol.device];
        return resources === undefined ? undefined : { updateResources: resources };
      },
      dispose: () => {
        if (this.#power === power) {
          this.#power = undefined;
        }
        power.destroy();
      },
    };
  }

  #sampleProbes(): void {
    const power = this.#power;
    if (power === undefined) {
      return;
    }
    const now = this.#executor?.getSimTime() ?? timePs(0);
    const next: ProbeReading[] = [];
    for (const probe of this.scenario.probes) {
      const reading = this.#read(probe, power);
      next.push(reading);
      const previous = this.#readings.find((entry) => entry.id === probe.id);
      if (
        previous !== undefined &&
        previous.value === reading.value &&
        previous.ready === reading.ready
      ) {
        continue;
      }
      this.#push({
        kind: 'electrical',
        simTime: now,
        label: probe.title,
        detail: `${reading.value}${reading.ready ? '' : '（未就绪）'}`,
      });
    }
    this.#readings = next;
  }

  #read(probe: Probe, power: PowerRuntime): ProbeReading {
    if (probe.kind === 'digital') {
      const sample = power.sampleDigital(probe.target);
      return {
        id: probe.id,
        title: probe.title,
        value: sample.value === 1 ? '1' : '0',
        ready: sample.ready,
      };
    }
    return {
      id: probe.id,
      title: probe.title,
      value: power.connectionState(probe.instanceId, probe.connectionId),
      ready: true,
    };
  }

  #handleAdvanceFailure(error: unknown): void {
    const executor = this.#executor;
    const faulted = executor?.getState() === 'faulted';
    this.#lastError = describeError(error);
    this.#push({
      kind: 'error',
      simTime: executor?.getSimTime() ?? timePs(0),
      label: faulted ? '调度器故障' : '输入被器件层拒绝',
      detail: this.#lastError,
    });
    if (!faulted) {
      // The executor stays `ready`: a rejected payload never advanced the clock.
      this.#diagnostics = [
        ...this.#diagnostics,
        {
          seq: this.#nextSeq(),
          code: 'bench/delivery-rejected',
          message: this.#lastError,
        },
      ].slice(-40);
      return;
    }
    this.pause();
    this.#phase = 'faulted';
  }

  #reject(message: string): void {
    this.#lastError = message;
    this.#diagnostics = [
      ...this.#diagnostics,
      { seq: this.#nextSeq(), code: 'bench/rejected', message },
    ].slice(-40);
    this.#push({
      kind: 'error',
      simTime: this.#executor?.getSimTime() ?? timePs(0),
      label: '请求被拒绝',
      detail: message,
    });
    this.#notify();
  }

  #pushDiagnostic(diagnostic: SimulationDiagnostic): void {
    this.#diagnostics = [
      ...this.#diagnostics,
      {
        seq: this.#nextSeq(),
        code: diagnostic.code,
        message: diagnostic.message,
        ...(diagnostic.symbol === undefined ? {} : { symbol: diagnostic.symbol }),
      },
    ].slice(-40);
  }

  #push(entry: Omit<TraceEntry, 'seq'>): void {
    const next = [...this.#trace, { seq: this.#nextSeq(), ...entry }];
    this.#trace = next.slice(-this.#traceLimit);
  }

  #nextSeq(): number {
    this.#seq += 1;
    return this.#seq;
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // A throwing renderer must not break the simulation.
      }
    }
  }

  /** Describes every symbol and probes the model's own reset lifecycle on a scratch scheduler. */
  async #describeDevices(): Promise<readonly DeviceCapability[]> {
    const devices: DeviceCapability[] = [];
    for (const symbol of this.scenario.schematic.sheet.symbols) {
      const loaded = await loadDeviceModule(symbol.device, this.#provider);
      const probe = this.#probeReset(loaded, symbol.id);
      devices.push({
        symbol: symbol.id,
        label: symbol.designator ?? symbol.id,
        deviceId: symbol.device,
        displayName: loaded.description.displayName,
        pins: [...loaded.description.pins.keys()],
        connections: [...loaded.description.connections.keys()],
        ports: portInfo(loaded.description),
        reset: probe.reset,
        resetDetail: probe.detail,
      });
    }
    return devices;
  }

  /** Designator of one schematic symbol; the topic and publish traces stay readable. */
  #symbolLabel(symbolId: string): string {
    const symbol = this.scenario.schematic.sheet.symbols.find((entry) => entry.id === symbolId);
    return symbol?.designator ?? symbolId;
  }

  /**
   * Builds a throwaway instance on its own scheduler and asks the model to reset.
   *
   * This is how the bench tells "the model declares reset" apart from "the executor rebuilds
   * instances": an undeclared lifecycle rejects with `device/lifecycle-unsupported`.
   */
  #probeReset(
    loaded: LoadedDeviceModule,
    instanceId: string,
  ): { reset: DeviceCapability['reset']; detail: string } {
    const scheduler = createScheduler();
    const power = createPowerRuntime(scheduler, this.scenario.board.power, {
      instanceId: 'bench-probe-power',
      pinStates: this.scenario.board.pinStates,
      floating: { seed: 63 },
    });
    let instance: DeviceInstance | undefined;
    try {
      const resources = this.scenario.updateResources?.[loaded.deviceId];
      instance = createDeviceInstance(loaded, scheduler, {
        instanceId,
        pinHost: power,
        connections: { topology: power },
        ...(resources === undefined ? {} : { updateResources: resources }),
      });
      // `initialize` has to finish before a reset is legal; this scheduler is throwaway.
      scheduler.start({ until: scheduler.now });
      instance.reset();
      return { reset: 'supported', detail: '模型声明了 reset，实例接受复位请求' };
    } catch (error) {
      if (error instanceof DeviceError && error.code === 'device/lifecycle-unsupported') {
        return { reset: 'unsupported', detail: error.message };
      }
      return { reset: 'unknown', detail: describeError(error) };
    } finally {
      try {
        instance?.destroy();
      } catch {
        // The probe never advances, so a destroy failure is not worth reporting.
      }
      power.destroy();
    }
  }
}

function portInfo(description: DeviceDescription): readonly DevicePortInfo[] {
  return [...description.ports.values()].map((port) => ({
    key: port.key,
    direction: port.direction,
    type: port.type,
    ...(port.title === undefined ? {} : { title: port.title }),
  }));
}
