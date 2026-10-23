import type { TopologyPinRef } from '@mica-js/core';
import { parseCanvas, type CanvasBindingTarget, type CanvasDocument } from '@mica-js/core/canvas';
import {
  parseSchematic,
  type SchematicDocument,
  type SchematicSymbol,
} from '@mica-js/core/schematic';
import { BUTTON_BOARD, BUTTON_RELAY_BOARD, MCU_BOARD, type BoardFixture } from './board';
import { BUTTON_SYMBOL, MCU_SYMBOL, RELAY_SYMBOL, type BenchSymbol } from './symbols';

export type Probe =
  | {
      readonly kind: 'digital';
      readonly id: string;
      readonly title: string;
      readonly target: TopologyPinRef;
    }
  | {
      readonly kind: 'connection';
      readonly id: string;
      readonly title: string;
      readonly instanceId: string;
      readonly connectionId: string;
    };

export interface BytesPreset {
  readonly label: string;
  /** Hex pairs separated by spaces; the first unit (8 B) of the teaching MCU firmware. */
  readonly hex: string;
}

/**
 * One host-side input the bench can deliver.
 *
 * `press` inputs are bound to the sandboxed canvas widget instead of a DOM control; they exist so
 * the deterministic replay can drive the same endpoint without the canvas.
 */
export type ScenarioInput =
  | {
      readonly kind: 'press';
      readonly id: string;
      readonly title: string;
      readonly symbol: string;
      readonly port: string;
    }
  | {
      readonly kind: 'bytes';
      readonly id: string;
      readonly title: string;
      readonly description: string;
      readonly symbol: string;
      readonly port: string;
      readonly presets: readonly BytesPreset[];
    };

/** One action of the deterministic replay script, applied before the numbered step runs. */
export interface ScenarioAction {
  /** 1-based step index; the action is delivered before that step's `advance`. */
  readonly step: number;
  readonly input: string;
  readonly value: string;
}

export type ScenarioId = 'button' | 'relay' | 'mcu';

export interface Scenario {
  readonly id: ScenarioId;
  readonly title: string;
  readonly summary: string;
  readonly schematic: SchematicDocument;
  readonly board: BoardFixture;
  readonly probes: readonly Probe[];
  readonly inputs: readonly ScenarioInput[];
  /** `.cnv` snapshot the sandboxed widget runs; omitted when no device port is widget-friendly. */
  readonly canvas?: CanvasDocument;
  /** Explains why a scenario has no canvas, so the empty stage is never mistaken for a bug. */
  readonly canvasNote?: string;
  /** Model limits the bench refuses to hide, copied from the example documentation. */
  readonly limitations: readonly string[];
  /**
   * Extra `updateResources` grants per device id. The teaching MCU needs the independent
   * `updateBytes` path for its readonly firmware resource; nothing else is granted here.
   */
  readonly updateResources?: Readonly<Record<string, readonly string[]>>;
  readonly script: readonly ScenarioAction[];
  readonly replaySteps: number;
}

function symbolOf(symbol: BenchSymbol): SchematicSymbol {
  return {
    id: symbol.id,
    designator: symbol.designator,
    device: symbol.device,
    x: 0,
    y: 0,
    rotation: 0,
  };
}

function schematicOf(symbols: readonly BenchSymbol[]): SchematicDocument {
  return parseSchematic(
    JSON.stringify({
      version: 1,
      sheet: { symbols: symbols.map(symbolOf), wires: [], junctions: [] },
    }),
  );
}

function canvasOf(instance: {
  readonly id: string;
  readonly widget: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly bindings: Readonly<Record<string, CanvasBindingTarget>>;
}): CanvasDocument {
  return parseCanvas(JSON.stringify({ version: 1, widgets: [{ ...instance, rotation: 0 }] }));
}

const BUTTON_CANVAS = canvasOf({
  id: '5f2c1a3b-4d5e-4f60-8a7b-9c1d2e3f4051',
  widget: 'demo:button',
  x: 24,
  y: 16,
  width: 200,
  height: 96,
  properties: { label: '按下', radius: 10 },
  bindings: { press: { symbol: BUTTON_SYMBOL.id, port: 'pressed' } },
});

const BUTTON_SCENARIO: Scenario = {
  id: 'button',
  title: '理想按钮',
  summary:
    '被动双向触点接在 VCC 与下拉检测网络之间：按下闭合 A–B，板级 SENSE 随之升高。按钮控件跑在 widget sandbox 里，点击通过 WidgetHost 投递到 S1.pressed。',
  schematic: schematicOf([BUTTON_SYMBOL]),
  board: BUTTON_BOARD,
  probes: [
    {
      kind: 'connection',
      id: 'contact',
      title: 'S1.contact',
      instanceId: BUTTON_SYMBOL.id,
      connectionId: 'contact',
    },
    {
      kind: 'digital',
      id: 'sense',
      title: 'board.SENSE',
      target: { instanceId: 'board', pinName: 'SENSE' },
    },
  ],
  inputs: [
    {
      kind: 'press',
      id: 'press',
      title: '按下按钮（画布）',
      symbol: BUTTON_SYMBOL.id,
      port: 'pressed',
    },
  ],
  canvas: BUTTON_CANVAS,
  limitations: [
    '无抖动、无接触电阻、无机械延迟；按下与松开只改变这一个被动触点。',
    '触点是被动连接，器件永不驱动引脚，电平来自板级 VCC 与下拉。',
    '示例声明了 initialize 与 reset 两个生命周期；复位按钮走执行器的实例重建。',
  ],
  script: [
    { step: 1, input: 'press', value: 'true' },
    { step: 3, input: 'press', value: 'false' },
    { step: 5, input: 'press', value: 'true' },
  ],
  replaySteps: 8,
};

const RELAY_SCENARIO: Scenario = {
  id: 'relay',
  title: '按钮 → 继电器',
  summary:
    '按钮触点把 VCC 送到继电器线圈（board.COIL 下拉），继电器在同一个 patch 内原子切换 COM–NO 与 COM–NC；触点侧由独立 LOAD 供电，与线圈侧电气隔离。',
  schematic: schematicOf([BUTTON_SYMBOL, RELAY_SYMBOL]),
  board: BUTTON_RELAY_BOARD,
  probes: [
    {
      kind: 'digital',
      id: 'coil',
      title: 'K1.IN（线圈）',
      target: { instanceId: RELAY_SYMBOL.id, pinName: 'IN' },
    },
    {
      kind: 'connection',
      id: 'normallyOpen',
      title: 'K1.normallyOpen',
      instanceId: RELAY_SYMBOL.id,
      connectionId: 'normallyOpen',
    },
    {
      kind: 'connection',
      id: 'normallyClosed',
      title: 'K1.normallyClosed',
      instanceId: RELAY_SYMBOL.id,
      connectionId: 'normallyClosed',
    },
    {
      kind: 'digital',
      id: 'no',
      title: 'board.NO（触点侧）',
      target: { instanceId: 'board', pinName: 'NO' },
    },
  ],
  inputs: [
    {
      kind: 'press',
      id: 'press',
      title: '按下按钮（画布）',
      symbol: BUTTON_SYMBOL.id,
      port: 'pressed',
    },
  ],
  canvas: BUTTON_CANVAS,
  limitations: [
    '继电器示例只声明 initialize，没有 reset 生命周期；复位只能重建实例，不会执行器件 reset。',
    '无机械抖动、接触电阻、线圈电流与吸合阈值；IN 的边沿由 observeDigital 捕获。',
    '两路触点在同一个 connection.apply patch 里切换，不表示真实机械联动时序。',
  ],
  script: [
    { step: 1, input: 'press', value: 'true' },
    { step: 4, input: 'press', value: 'false' },
    { step: 6, input: 'press', value: 'true' },
  ],
  replaySteps: 9,
};

const MCU_SCENARIO: Scenario = {
  id: 'mcu',
  title: '教学 MCU',
  summary:
    '两字节合成 ISA（ADD / JMP / JNZ / HALT）在块边界可观察：每个基本块结束时写 GPIO，GPIO 经板级 SENSE 下拉网络读出。固件补丁通过 U1.firmwarePatch 端口更新前 8 B 单元。',
  schematic: schematicOf([MCU_SYMBOL]),
  board: MCU_BOARD,
  probes: [
    {
      kind: 'digital',
      id: 'gpio',
      title: 'U1.GPIO',
      target: { instanceId: MCU_SYMBOL.id, pinName: 'GPIO' },
    },
    {
      kind: 'digital',
      id: 'sense',
      title: 'board.SENSE',
      target: { instanceId: 'board', pinName: 'SENSE' },
    },
  ],
  inputs: [
    {
      kind: 'bytes',
      id: 'firmware',
      title: '固件补丁（前 8 B）',
      description:
        '按 provider 的 8 B 版本单元从偏移 0 更新只读固件；宿主通过 updateResources: ["firmware"] 单独授权 updateBytes。',
      symbol: MCU_SYMBOL.id,
      port: 'firmwarePatch',
      presets: [
        { label: '默认固件', hex: '10 01 10 02 30 08 00 00' },
        { label: '停机（HALT）', hex: '00 00 00 00 00 00 00 00' },
        { label: '加法后停机', hex: '10 01 00 00 00 00 00 00' },
        { label: '改第二条 ADD 立即数', hex: '10 01 10 05 30 08 00 00' },
      ],
    },
  ],
  canvasNote:
    '该模型的输入是 bytes（firmwarePatch），没有可绑定的布尔/数值端口，因此不挂 canvas；输入走下方固件面板。',
  limitations: [
    '只在块边界可观察：GPIO 是块末 r0 最低位的教学调试镜像，块内不可观察。',
    '合成 ISA 不是 AVR/8051；不模拟中断、流水线、MMIO 或逐周期时序，也不允许据此声称真实 MCU 可整块提前提交。',
    '示例没有声明 reset 生命周期；复位只能重建实例。',
    '固件声明为 readonly，普通客体写入被拒绝；只有宿主显式 updateResources 才开放更新路径。',
  ],
  updateResources: { [MCU_SYMBOL.device]: ['firmware'] },
  script: [{ step: 2, input: 'firmware', value: '00 00 00 00 00 00 00 00' }],
  replaySteps: 12,
};

export const SCENARIOS: readonly Scenario[] = Object.freeze([
  BUTTON_SCENARIO,
  RELAY_SCENARIO,
  MCU_SCENARIO,
]);

export function scenarioById(id: string): Scenario {
  const scenario = SCENARIOS.find((entry) => entry.id === id);
  if (scenario === undefined) {
    throw new Error(`Unknown scenario ${JSON.stringify(id)}`);
  }
  return scenario;
}

/** Parses a hex preset / textarea value; throws a readable error instead of guessing. */
export function parseHexBytes(hex: string): Uint8Array {
  const tokens = hex
    .trim()
    .split(/[\s,]+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    throw new Error('补丁为空：请输入形如 “10 01 00 00” 的十六进制字节。');
  }
  const bytes = tokens.map((token) => {
    if (!/^[0-9a-fA-F]{2}$/.test(token)) {
      throw new Error(`无法解析 “${token}”：每个字节必须是两位十六进制。`);
    }
    return Number.parseInt(token, 16);
  });
  return Uint8Array.from(bytes);
}
