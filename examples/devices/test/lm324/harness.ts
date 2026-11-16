import { compileDDL } from '@mica-js/sdk/ddl';
import { createBoardWith, US } from '../harness.ts';
import type {
  Adapter,
  BoardOptions,
  DeviceInstance,
  DeviceModule,
  Manifest,
  NetDescription,
  TestBoard,
} from '../harness.ts';

/**
 * LM324 测试夹具：用一颗测试专用模拟探针把 `out` 网络的真实求解电压送回宿主。
 * 探针只声明一个无意图引脚和一个输出通道，不参与被测器件的增益或反馈。
 */

const probeSource = `device Lm324AnalogProbe {
  pin y;
  output channel voltage: number(capacity: 16, overflow: Overflow.drop_oldest);

  fn report() {
    const sampled = y.sample.voltage;
    if sampled != none { voltage.send(sampled); }
  }

  process start { report(); }
  reaction changed on y.sample.voltage as (previous, current) { report(); }
}`;

let probeModule: Promise<DeviceModule> | undefined;

async function createProbeModule(): Promise<DeviceModule> {
  const create: DeviceModule['create'] = () => {
    let voltage = 0;
    return {
      methods: { getVoltage: () => voltage },
      sync(batch) {
        for (const message of batch.outputs.voltage ?? []) voltage = message.value as number;
      },
      dispose() {},
    } satisfies Adapter;
  };
  const manifest: Manifest = {
    publisher: 'test',
    name: 'lm324-analog-probe',
    version: '0.0.0',
    engines: { mica: '^0.3.0' },
    displayName: 'LM324 测试模拟探针',
    model: { entry: 'model.js', types: {}, methods: {}, events: {} },
  };

  return {
    model: await compileDDL(probeSource, { uri: 'mica:test/lm324/analog-probe.ddl' }),
    create,
    manifest,
  };
}

export function analogProbe(): Promise<DeviceModule> {
  probeModule ??= createProbeModule();
  return probeModule;
}

export interface Lm324BoardOptions {
  readonly props?: Readonly<Record<string, unknown>>;
  readonly device?: DeviceModule;
  readonly plusVoltage?: number;
  readonly minusVoltage?: number;
  readonly supplyVoltage?: number;
  readonly groundVoltage?: number;
  readonly connectInputs?: boolean;
  readonly connectVcc?: boolean;
  readonly connectGnd?: boolean;
  readonly loadResistance?: number;
  readonly loadTo?: 'gnd' | 'vcc';
  readonly pullUpResistance?: number;
  readonly pullUpVoltage?: number;
  readonly runtimeInput?: {
    readonly seriesResistance: number;
    readonly shuntResistance: number;
  };
  readonly settleUs?: number;
}

export interface Lm324Board {
  readonly board: TestBoard;
  readonly output: () => Promise<number>;
  readonly runPeriods: (periods: number) => void;
  readonly setSourceLevel?: (level: number) => void;
}

export function expectedGain(
  position: number,
  props: {
    readonly feedbackResistance?: number;
    readonly potResistance?: number;
    readonly minPotResistance?: number;
  } = {},
): number {
  const feedback = props.feedbackResistance ?? 100_000;
  const pot = props.potResistance ?? 10_000;
  const minPot = props.minPotResistance ?? 100;
  const clamped = Math.min(1, Math.max(0, position));
  return 1 + (2 * feedback) / (minPot + (pot - minPot) * (1 - clamped));
}

export function expectedLoadedVoltage(
  target: number,
  supply: number,
  outputResistance: number,
  loadResistance: number,
  loadTo: 'gnd' | 'vcc',
): number {
  const targetCurrent = target / outputResistance;
  const loadCurrent = (loadTo === 'vcc' ? supply : 0) / loadResistance;
  return (targetCurrent + loadCurrent) / (1 / outputResistance + 1 / loadResistance);
}

/** 测试源 `vin` 的 25 Ω 推挽输出 + series/shunt 分压后的输入电压。 */
export function expectedRuntimeInput(
  level: 0 | 1,
  seriesResistance: number,
  shuntResistance: number,
  supply = 5,
  sourceResistance = 25,
): number {
  if (level === 0) return 0;
  return (supply * shuntResistance) / (sourceResistance + seriesResistance + shuntResistance);
}

export async function createLm324Board(options: Lm324BoardOptions = {}): Promise<Lm324Board> {
  const supply = options.supplyVoltage ?? 5;
  const ground = options.groundVoltage ?? 0;
  const connectInputs = options.connectInputs !== false;
  const connectVcc = options.connectVcc !== false;
  const connectGnd = options.connectGnd !== false;
  const runtimeInput = options.runtimeInput;
  const props = options.props ?? {};
  const updatePeriodUs = (props.updatePeriodUs as number | undefined) ?? 10;
  const sources: string[] = [];

  const outPins = [
    { instance: 'dut', pin: 'out' },
    { instance: 'probe', pin: 'y' },
  ];
  const vccPins: { instance: string; pin: string }[] = [];
  const gndPins: { instance: string; pin: string }[] = [];
  const resistors: { readonly id: string; readonly resistance: number }[] = [];
  const nets: NetDescription[] = [];

  if (connectVcc) vccPins.push({ instance: 'dut', pin: 'vcc' });
  if (connectGnd) gndPins.push({ instance: 'dut', pin: 'gnd' });
  if (connectInputs && runtimeInput === undefined) {
    nets.push({
      id: 'in-plus',
      voltage: options.plusVoltage ?? 0,
      pins: [{ instance: 'dut', pin: 'inPlus' }],
    });
    nets.push({
      id: 'in-minus',
      voltage: options.minusVoltage ?? 0,
      pins: [{ instance: 'dut', pin: 'inMinus' }],
    });
  }

  if (runtimeInput !== undefined) {
    sources.push('vin');
    vccPins.push({ instance: 'vin', pin: 'vcc' });
    gndPins.push({ instance: 'vin', pin: 'gnd' });
    gndPins.push({ instance: 'dut', pin: 'inMinus' });
    resistors.push({ id: 'series', resistance: runtimeInput.seriesResistance });
    resistors.push({ id: 'shunt', resistance: runtimeInput.shuntResistance });
    nets.push({
      id: 'source-out',
      pins: [
        { instance: 'vin', pin: 'y' },
        { instance: 'series', pin: 'a' },
      ],
    });
    nets.push({
      id: 'in-plus',
      pins: [
        { instance: 'series', pin: 'b' },
        { instance: 'shunt', pin: 'a' },
        { instance: 'dut', pin: 'inPlus' },
      ],
    });
    gndPins.push({ instance: 'shunt', pin: 'b' });
  }

  if (options.loadResistance !== undefined) {
    outPins.push({ instance: 'load', pin: 'a' });
    resistors.push({ id: 'load', resistance: options.loadResistance });
    if (options.loadTo === 'vcc') vccPins.push({ instance: 'load', pin: 'b' });
    else gndPins.push({ instance: 'load', pin: 'b' });
  }

  if (options.pullUpResistance !== undefined) {
    outPins.push({ instance: 'pull', pin: 'a' });
    resistors.push({ id: 'pull', resistance: options.pullUpResistance });
    nets.push({
      id: 'pull',
      voltage: options.pullUpVoltage ?? supply,
      pins: [{ instance: 'pull', pin: 'b' }],
    });
  }

  nets.push({ id: 'out', pins: outPins });
  if (vccPins.length > 0) nets.push({ id: 'vcc', voltage: supply, pins: vccPins });
  if (gndPins.length > 0) nets.push({ id: 'gnd', voltage: ground, pins: gndPins });

  const devices: DeviceInstance[] = [
    {
      id: 'dut',
      type: 'lm324',
      ...(options.device === undefined ? {} : { device: options.device }),
      props,
    },
    { id: 'probe', type: 'lm324-probe', device: await analogProbe() },
  ];
  const boardOptions: BoardOptions = { props, resistors, sources, nets };
  const board = await createBoardWith(devices, boardOptions);
  const settleUs = options.settleUs ?? Math.max(30, updatePeriodUs * 3);

  board.run(settleUs * US);

  return {
    board,
    output: async () => (await board.query('probe', 'getVoltage')) as number,
    runPeriods: (periods) => board.run(updatePeriodUs * periods * US),
    ...(runtimeInput === undefined
      ? {}
      : { setSourceLevel: (level: number) => board.send('vin', 'level', level) }),
  };
}
