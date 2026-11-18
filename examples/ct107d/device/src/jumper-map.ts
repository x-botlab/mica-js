/**
 * CT107D 跳线位号映射：模型适配器、View2D 展示缓存和 HTML 面板共用同一份顺序。
 *
 * 前四项保持历史 DDL 编号；J2Tx 是 J2 下排（slot 4）的状态键，不是实体位号。
 * J6 是蜂鸣器下方的装配状态，没有 DDL 接线。
 */
export const ELECTRICAL_JUMPER_DESIGNATORS = ['J13', 'J3', 'J2', 'J5', 'J2Tx'] as const;
export const JUMPER_DESIGNATORS = [...ELECTRICAL_JUMPER_DESIGNATORS, 'J6'] as const;

export type ElectricalJumperDesignator = (typeof ELECTRICAL_JUMPER_DESIGNATORS)[number];
export type JumperDesignator = (typeof JUMPER_DESIGNATORS)[number];

export function jumperSignal(key: JumperDesignator): { designator: string; port: string } {
  if (key === 'J2Tx') return { designator: 'J2', port: 'closedState1' };
  return { designator: key, port: key === 'J2' ? 'closedState2' : 'closedState' };
}

export function jumperKeyForSignal(designator: string, port: string): JumperDesignator | undefined {
  if (!port.startsWith('closedState')) return undefined;
  return JUMPER_DESIGNATORS.find((key) => {
    const target = jumperSignal(key);
    return target.designator === designator && target.port === port;
  });
}

export function jumperParams(
  key: JumperDesignator,
  closed: boolean,
): { designator: string; closed: boolean } | { designator: 'J2'; closed: boolean; channel: 1 } {
  return key === 'J2Tx' ? { designator: 'J2', channel: 1, closed } : { designator: key, closed };
}

/**
 * 模型与展示的初始状态。J6 默认 ON 仅是照片板面的装配约定；未从可靠资料确认
 * 其电气接线，因此不参与供电、蜂鸣器或继电器计算。
 */
export const JUMPER_DEFAULT_STATES = {
  J13: true,
  J3: true,
  J2: true,
  J2Tx: false,
  J5: true,
  J6: true,
} as const satisfies Readonly<Record<JumperDesignator, boolean>>;
