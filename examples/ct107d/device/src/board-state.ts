/**
 * CT107D 板面展示状态：只保存 View2D 需要读取的权威输出。
 *
 * 模型事件和初始快照可能交错到达，因此每个字段单独记录版本。初始查询开始时取得一个
 * 基线版本，回包只写入基线之后没有事件更新的字段，避免迟到的快照覆盖较新的模型事件。
 * 工具函数不依赖编辑器或 SDK 运行时，可直接在单测里构造。
 */

import {
  JUMPER_DEFAULT_STATES,
  JUMPER_DESIGNATORS,
  JUMPER_SIGNAL_PORTS,
  type JumperDesignator,
} from './jumper-map.js';

export { JUMPER_DESIGNATORS, type JumperDesignator } from './jumper-map.js';

/** 17 个独立/矩阵按键的位号，顺序与模型快照一致。 */
export const KEY_DESIGNATORS = [
  'S1',
  'S4',
  'S5',
  'S6',
  'S7',
  'S8',
  'S9',
  'S10',
  'S11',
  'S12',
  'S13',
  'S14',
  'S15',
  'S16',
  'S17',
  'S18',
  'S19',
] as const;
export type KeyDesignator = (typeof KEY_DESIGNATORS)[number];

export const DISPLAY_DESIGNATORS = ['DS1', 'DS2'] as const;
export type DisplayDesignator = (typeof DISPLAY_DESIGNATORS)[number];

const KEY_SET: ReadonlySet<string> = new Set(KEY_DESIGNATORS);
const DISPLAY_SET: ReadonlySet<string> = new Set(DISPLAY_DESIGNATORS);
const JUMPER_SET: ReadonlySet<string> = new Set(JUMPER_DESIGNATORS);
const LED_PATTERN = /^D([1-8])$/;
const DIGIT_PATTERN = /^digit([1-4])$/;

/** `onDidSignal` 的事件载荷；只消费与板面显示有关的信号。 */
export interface BoardSignal {
  readonly designator: string;
  readonly port: string;
  readonly value: number;
}

/** 初始查询 `getSnapshot(null)` 中展示需要的字段。 */
export interface BoardSnapshot {
  readonly displays: Readonly<Record<DisplayDesignator, readonly number[]>>;
  readonly leds: readonly number[];
  readonly relay: boolean;
  readonly buzzer: boolean;
  readonly switches: Readonly<Record<KeyDesignator, boolean>>;
  readonly jumpers: Readonly<Record<JumperDesignator, boolean>>;
}

/** 可变的展示缓存；只允许状态仓库修改，绘制代码只读。 */
export interface BoardState {
  displays: Record<DisplayDesignator, number[]>;
  leds: number[];
  relay: boolean;
  buzzer: boolean;
  switches: Record<KeyDesignator, boolean>;
  jumpers: Record<JumperDesignator, boolean>;
}

export interface BoardStateStore {
  readonly state: BoardState;
  /** 初始查询开始时的版本基线。 */
  beginSnapshot(): number;
  /** 只应用基线之后未被事件覆盖的字段；返回是否有字段变化。 */
  applySnapshot(snapshot: BoardSnapshot, baseRevision: number): boolean;
  /** 应用一条模型信号；返回是否改变了绘制状态。 */
  applySignal(signal: BoardSignal): boolean;
}

export function createBoardStateStore(): BoardStateStore {
  const state = createInitialState();
  let revision = 0;
  const fieldRevisions = new Map<string, number>();

  function markField(key: string): void {
    revision += 1;
    fieldRevisions.set(key, revision);
  }

  function acceptsField(key: string, baseRevision: number): boolean {
    return (fieldRevisions.get(key) ?? 0) <= baseRevision;
  }

  const store: BoardStateStore = {
    state,
    beginSnapshot: () => revision,
    applySnapshot(snapshot, baseRevision) {
      let changed = false;

      for (const designator of DISPLAY_DESIGNATORS) {
        const source = snapshot.displays[designator];
        for (let index = 0; index < 4; index += 1) {
          if (!acceptsField(displayField(designator, index), baseRevision)) continue;
          const next = clampByte(source[index] ?? 0);
          if (state.displays[designator][index] === next) continue;
          state.displays[designator][index] = next;
          changed = true;
        }
      }

      for (let index = 0; index < state.leds.length; index += 1) {
        if (!acceptsField(ledField(index), baseRevision)) continue;
        const next = clampLevel(snapshot.leds[index] ?? 0);
        if (state.leds[index] === next) continue;
        state.leds[index] = next;
        changed = true;
      }

      if (acceptsField('actuator:relay', baseRevision) && state.relay !== snapshot.relay) {
        state.relay = snapshot.relay;
        changed = true;
      }
      if (acceptsField('actuator:buzzer', baseRevision) && state.buzzer !== snapshot.buzzer) {
        state.buzzer = snapshot.buzzer;
        changed = true;
      }

      for (const designator of KEY_DESIGNATORS) {
        if (!acceptsField(switchField(designator), baseRevision)) continue;
        const next = snapshot.switches[designator];
        if (state.switches[designator] === next) continue;
        state.switches[designator] = next;
        changed = true;
      }

      for (const designator of JUMPER_DESIGNATORS) {
        if (!acceptsField(jumperField(designator), baseRevision)) continue;
        const next = snapshot.jumpers[designator];
        if (state.jumpers[designator] === next) continue;
        state.jumpers[designator] = next;
        changed = true;
      }

      return changed;
    },
    applySignal(signal) {
      if (!Number.isFinite(signal.value)) return false;

      if (DISPLAY_SET.has(signal.designator)) {
        const designator = signal.designator as DisplayDesignator;
        const match = DIGIT_PATTERN.exec(signal.port);
        if (match === null) return false;
        const index = Number.parseInt(match[1]!, 10) - 1;
        const next = clampByte(signal.value);
        markField(displayField(designator, index));
        if (state.displays[designator][index] === next) return false;
        state.displays[designator][index] = next;
        return true;
      }

      const led = LED_PATTERN.exec(signal.designator);
      if (led !== null) {
        if (signal.port !== 'brightness') return false;
        const index = Number.parseInt(led[1]!, 10) - 1;
        const next = clampLevel(signal.value);
        markField(ledField(index));
        if (state.leds[index] === next) return false;
        state.leds[index] = next;
        return true;
      }

      if (signal.designator === 'K1' && signal.port === 'energized') {
        const next = signal.value !== 0;
        markField('actuator:relay');
        if (state.relay === next) return false;
        state.relay = next;
        return true;
      }

      if (signal.designator === 'SP1' && signal.port === 'active') {
        const next = signal.value !== 0;
        markField('actuator:buzzer');
        if (state.buzzer === next) return false;
        state.buzzer = next;
        return true;
      }

      if (KEY_SET.has(signal.designator)) {
        if (signal.port !== 'press' && signal.port !== 'pressed') return false;
        const designator = signal.designator as KeyDesignator;
        const next = signal.value !== 0;
        markField(switchField(designator));
        if (state.switches[designator] === next) return false;
        state.switches[designator] = next;
        return true;
      }

      if (JUMPER_SET.has(signal.designator)) {
        const designator = signal.designator as JumperDesignator;
        if (signal.port !== JUMPER_SIGNAL_PORTS[designator]) return false;
        const next = signal.value !== 0;
        markField(jumperField(designator));
        if (state.jumpers[designator] === next) return false;
        state.jumpers[designator] = next;
        return true;
      }

      return false;
    },
  };

  return store;
}

function createInitialState(): BoardState {
  return {
    displays: { DS1: [0, 0, 0, 0], DS2: [0, 0, 0, 0] },
    leds: Array.from({ length: 8 }, () => 0),
    relay: false,
    buzzer: false,
    switches: {
      S1: false,
      S4: false,
      S5: false,
      S6: false,
      S7: false,
      S8: false,
      S9: false,
      S10: false,
      S11: false,
      S12: false,
      S13: false,
      S14: false,
      S15: false,
      S16: false,
      S17: false,
      S18: false,
      S19: false,
    },
    // 整板融合模型的装配默认值：J13/J5 为 2-3，J3 闭合，J2 选 VS1838；
    // J6 默认 ON 仅为板面装配状态，不进入融合电气。
    jumpers: { ...JUMPER_DEFAULT_STATES },
  };
}

function displayField(designator: DisplayDesignator, index: number): string {
  return `display:${designator}:${index}`;
}

function ledField(index: number): string {
  return `led:${index}`;
}

function switchField(designator: KeyDesignator): string {
  return `switch:${designator}`;
}

function jumperField(designator: JumperDesignator): string {
  return `jumper:${designator}`;
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.trunc(value)));
}

function clampLevel(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 从模型事件值里读出板面信号；其他声明事件或畸形载荷返回 `undefined`。 */
export function readBoardSignal(value: unknown): BoardSignal | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  const designator = record['designator'];
  const port = record['port'];
  const payload = record['value'];
  if (
    typeof designator !== 'string' ||
    typeof port !== 'string' ||
    typeof payload !== 'number' ||
    !Number.isFinite(payload)
  ) {
    return undefined;
  }
  return { designator, port, value: payload };
}

/**
 * 校验并复制 `getSnapshot(null)` 的返回值。
 *
 * 模型清单和 View2D 同属一个包；快照字段缺失说明二者已经不一致，因此这里直接抛错，让
 * `initialize()` 明确失败，而不是拿默认值继续画一块错误状态的板。
 */
export function readBoardSnapshot(value: unknown): BoardSnapshot {
  const record = readRecord(value, 'CT107D snapshot');
  const displays = readRecord(record['displays'], 'CT107D snapshot.displays');
  const switches = readRecord(record['switches'], 'CT107D snapshot.switches');
  const jumpers = readRecord(record['jumpers'], 'CT107D snapshot.jumpers');

  return {
    displays: {
      DS1: readNumberArray(displays['DS1'], 'CT107D snapshot.displays.DS1', 4),
      DS2: readNumberArray(displays['DS2'], 'CT107D snapshot.displays.DS2', 4),
    },
    leds: readNumberArray(record['leds'], 'CT107D snapshot.leds', 8),
    relay: readBoolean(record['relay'], 'CT107D snapshot.relay'),
    buzzer: readBoolean(record['buzzer'], 'CT107D snapshot.buzzer'),
    switches: {
      S1: readBoolean(switches['S1'], 'CT107D snapshot.switches.S1'),
      S4: readBoolean(switches['S4'], 'CT107D snapshot.switches.S4'),
      S5: readBoolean(switches['S5'], 'CT107D snapshot.switches.S5'),
      S6: readBoolean(switches['S6'], 'CT107D snapshot.switches.S6'),
      S7: readBoolean(switches['S7'], 'CT107D snapshot.switches.S7'),
      S8: readBoolean(switches['S8'], 'CT107D snapshot.switches.S8'),
      S9: readBoolean(switches['S9'], 'CT107D snapshot.switches.S9'),
      S10: readBoolean(switches['S10'], 'CT107D snapshot.switches.S10'),
      S11: readBoolean(switches['S11'], 'CT107D snapshot.switches.S11'),
      S12: readBoolean(switches['S12'], 'CT107D snapshot.switches.S12'),
      S13: readBoolean(switches['S13'], 'CT107D snapshot.switches.S13'),
      S14: readBoolean(switches['S14'], 'CT107D snapshot.switches.S14'),
      S15: readBoolean(switches['S15'], 'CT107D snapshot.switches.S15'),
      S16: readBoolean(switches['S16'], 'CT107D snapshot.switches.S16'),
      S17: readBoolean(switches['S17'], 'CT107D snapshot.switches.S17'),
      S18: readBoolean(switches['S18'], 'CT107D snapshot.switches.S18'),
      S19: readBoolean(switches['S19'], 'CT107D snapshot.switches.S19'),
    },
    jumpers: Object.fromEntries(
      JUMPER_DESIGNATORS.map((designator) => [
        designator,
        readBoolean(jumpers[designator], `CT107D snapshot.jumpers.${designator}`),
      ]),
    ) as Record<JumperDesignator, boolean>,
  };
}

function readRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean.`);
  return value;
}

function readNumberArray(value: unknown, label: string, minimum: number): number[] {
  if (!Array.isArray(value) || value.length < minimum) {
    throw new TypeError(`${label} must contain at least ${minimum} numbers.`);
  }
  const items: readonly unknown[] = value;
  return items.map((item, index) => {
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      throw new TypeError(`${label}[${index}] must be a finite number.`);
    }
    return item;
  });
}
