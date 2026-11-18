/**
 * CT107D 跳线位号映射：模型适配器、View2D 展示缓存和 HTML 面板共用同一份顺序。
 *
 * 前四项是融合 DDL 的 jumper slot 0..3，编号必须保持历史顺序；J6 只是蜂鸣器
 * 下方的三针装配状态，没有网表或 DDL 连接，因此追加在末尾，不改变旧编号。
 */
export const ELECTRICAL_JUMPER_DESIGNATORS = ['J13', 'J3', 'J2', 'J5'] as const;
export const JUMPER_DESIGNATORS = [...ELECTRICAL_JUMPER_DESIGNATORS, 'J6'] as const;

export type ElectricalJumperDesignator = (typeof ELECTRICAL_JUMPER_DESIGNATORS)[number];
export type JumperDesignator = (typeof JUMPER_DESIGNATORS)[number];

/** 每个跳线在 `onDidSignal` 上使用的端口；J2 是第二路可选状态。 */
export const JUMPER_SIGNAL_PORTS = {
  J13: 'closedState',
  J3: 'closedState',
  J2: 'closedState2',
  J5: 'closedState',
  J6: 'closedState',
} as const satisfies Readonly<Record<JumperDesignator, string>>;

/**
 * 模型与展示的初始状态。J6 默认 ON 仅是照片板面的装配约定；未从可靠资料确认
 * 其电气接线，因此不参与供电、蜂鸣器或继电器计算。
 */
export const JUMPER_DEFAULT_STATES = {
  J13: true,
  J3: true,
  J2: true,
  J5: true,
  J6: true,
} as const satisfies Readonly<Record<JumperDesignator, boolean>>;
