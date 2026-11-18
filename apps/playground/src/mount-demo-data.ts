export type Role = 'pwr' | 'gnd' | 'io';
export type ConnectorKind = 'header' | 'fpc' | 'jst' | 'pigtail';
export type CableForm = 'round' | 'ribbon';

export interface Point {
  x: number;
  y: number;
}

export interface PinSpec {
  id: string;
  label: string;
  role: Role;
  /** 所属接头 id，在同一个器件内唯一。 */
  connector: string;
  /** Offsets in mm from the part origin. */
  dx: number;
  dy: number;
}

/** 一次插拔的物理整体：多根芯共同住在一个接头里。 */
export interface Connector {
  id: string;
  label: string;
  kind: ConnectorKind;
  /** 触点间距 mm。 */
  pitch: number;
  gender: 'male' | 'female';
  contacts: number;
  /** 能与哪些形态的接头插合。 */
  mates: ConnectorKind[];
  /** 这个接头引出的线缆形态。 */
  cable: CableForm;
  /** FPC 可选的标准长度 mm，选中的在 length。 */
  lengths?: number[];
  length?: number;
  /** FPC 根部不可弯段长度 mm（加强板）。 */
  stiffener?: number;
  /** FPC 触点与基材同面，或折到底面。 */
  contactSide?: 'same' | 'opposite';
}

export interface Part {
  id: string;
  designator: string;
  title: string;
  onboard: boolean;
  kind: 'chip' | 'terminal' | 'motor' | 'servo' | 'sensor' | 'camera';
  /** Footprint and body size in mm. */
  w: number;
  d: number;
  h: number;
  connectors: Connector[];
  pins: PinSpec[];
}

export type PinRef = { device: string; pin: string };

export interface Wire {
  a: PinRef;
  b: PinRef;
  color: string;
}

export const KIND_LABEL: Record<ConnectorKind, string> = {
  header: '排针排母',
  fpc: 'FPC 座',
  jst: 'JST 端子',
  pigtail: '散线端子',
};

/** 排针、JST、散线端子之间可以互插。 */
const LEAD_MATES: ConnectorKind[] = ['header', 'jst', 'pigtail'];

/** Scene unit: 6 px per mm, matching the 2D canvas. */
export const MM = 6;
export const PLANE_W = 1200;
export const PLANE_H = 860;

export const board = { x: 60, y: 40, w: 456, h: 360 };

export const parts: Part[] = [
  {
    id: 'u1',
    designator: 'U1',
    title: 'AT89C52',
    onboard: true,
    kind: 'chip',
    w: 15.24,
    d: 50.8,
    h: 4,
    connectors: [],
    pins: [],
  },
  {
    id: 'j1',
    designator: 'J1',
    title: '6P 排针',
    onboard: true,
    kind: 'terminal',
    w: 15.24,
    d: 2.54,
    h: 2.5,
    connectors: [
      {
        id: 'cn1',
        label: 'J1',
        kind: 'header',
        pitch: 2.54,
        gender: 'male',
        contacts: 6,
        mates: LEAD_MATES,
        cable: 'round',
      },
    ],
    pins: [
      { id: '1', label: '+5V', role: 'pwr', connector: 'cn1', dx: -6.35, dy: 0 },
      { id: '2', label: 'GND', role: 'gnd', connector: 'cn1', dx: -3.81, dy: 0 },
      { id: '3', label: 'P2.0', role: 'io', connector: 'cn1', dx: -1.27, dy: 0 },
      { id: '4', label: 'P2.1', role: 'io', connector: 'cn1', dx: 1.27, dy: 0 },
      { id: '5', label: 'P2.2', role: 'io', connector: 'cn1', dx: 3.81, dy: 0 },
      { id: '6', label: 'P2.3', role: 'io', connector: 'cn1', dx: 6.35, dy: 0 },
    ],
  },
  {
    id: 'j2',
    designator: 'J2',
    title: '8P FPC 座',
    onboard: true,
    kind: 'terminal',
    w: 5.6,
    d: 3.4,
    h: 1.6,
    connectors: [
      {
        id: 'cn1',
        label: 'J2',
        kind: 'fpc',
        pitch: 0.5,
        gender: 'female',
        contacts: 8,
        mates: ['fpc'],
        cable: 'ribbon',
        lengths: [100, 150, 200],
        length: 150,
        stiffener: 6,
        contactSide: 'opposite',
      },
    ],
    pins: Array.from({ length: 8 }, (_, index) => ({
      id: `${index + 1}`,
      label: `D${index}`,
      role: 'io' as const,
      connector: 'cn1',
      dx: -1.75 + index * 0.5,
      dy: 0,
    })),
  },
  {
    id: 'cam1',
    designator: 'CAM1',
    title: '并口摄像头',
    onboard: false,
    kind: 'camera',
    w: 20,
    d: 20,
    h: 8,
    connectors: [
      {
        id: 'cn1',
        label: 'CN1',
        kind: 'fpc',
        pitch: 0.5,
        gender: 'male',
        contacts: 8,
        mates: ['fpc'],
        cable: 'ribbon',
        lengths: [100, 150, 200],
        length: 150,
        stiffener: 5,
        contactSide: 'same',
      },
      {
        id: 'cn2',
        label: 'CN2',
        kind: 'jst',
        pitch: 1.25,
        gender: 'male',
        contacts: 2,
        mates: LEAD_MATES,
        cable: 'round',
      },
    ],
    pins: [
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `${index + 1}`,
        label: `D${index}`,
        role: 'io' as const,
        connector: 'cn1',
        dx: -3.6 + index * 0.5,
        dy: 10,
      })),
      { id: 'BL+', label: 'BL+', role: 'pwr', connector: 'cn2', dx: 4, dy: 10 },
      { id: 'BL-', label: 'BL−', role: 'gnd', connector: 'cn2', dx: 6, dy: 10 },
    ],
  },
  {
    id: 'm1',
    designator: 'M1',
    title: 'TT 直流电机',
    onboard: false,
    kind: 'motor',
    w: 70.7,
    d: 29,
    h: 45.7,
    connectors: [
      {
        id: 'cn1',
        label: 'CN1',
        kind: 'pigtail',
        pitch: 2.54,
        gender: 'male',
        contacts: 2,
        mates: LEAD_MATES,
        cable: 'round',
      },
    ],
    pins: [
      { id: '+', label: 'M+', role: 'io', connector: 'cn1', dx: -1.27, dy: 14.5 },
      { id: '-', label: 'M−', role: 'gnd', connector: 'cn1', dx: 1.27, dy: 14.5 },
    ],
  },
  {
    id: 'm2',
    designator: 'M2',
    title: '舵机 SG90',
    onboard: false,
    kind: 'servo',
    w: 23,
    d: 12.2,
    h: 29,
    connectors: [
      {
        id: 'cn1',
        label: 'CN1',
        kind: 'header',
        pitch: 2.54,
        gender: 'female',
        contacts: 3,
        mates: LEAD_MATES,
        cable: 'round',
      },
    ],
    pins: [
      { id: 'V+', label: 'V+', role: 'pwr', connector: 'cn1', dx: -2.54, dy: 6.1 },
      { id: 'GND', label: 'GND', role: 'gnd', connector: 'cn1', dx: 0, dy: 6.1 },
      { id: 'SIG', label: 'SIG', role: 'io', connector: 'cn1', dx: 2.54, dy: 6.1 },
    ],
  },
  {
    id: 'q1',
    designator: 'Q1',
    title: '超声波 HC-SR04',
    onboard: false,
    kind: 'sensor',
    w: 45,
    d: 27.4,
    h: 17.6,
    connectors: [
      {
        id: 'cn1',
        label: 'CN1',
        kind: 'header',
        pitch: 2.54,
        gender: 'female',
        contacts: 4,
        mates: LEAD_MATES,
        cable: 'round',
      },
    ],
    pins: [
      { id: 'V+', label: 'VCC', role: 'pwr', connector: 'cn1', dx: -3.81, dy: 13.7 },
      { id: 'TRIG', label: 'TRIG', role: 'io', connector: 'cn1', dx: -1.27, dy: 13.7 },
      { id: 'ECHO', label: 'ECHO', role: 'io', connector: 'cn1', dx: 1.27, dy: 13.7 },
      { id: 'GND', label: 'GND', role: 'gnd', connector: 'cn1', dx: 3.81, dy: 13.7 },
    ],
  },
];

export const initial: Record<string, Point> = {
  u1: { x: 190, y: 240 },
  j1: { x: 430, y: 320 },
  j2: { x: 430, y: 200 },
  m1: { x: 280, y: 660 },
  m2: { x: 570, y: 690 },
  q1: { x: 830, y: 660 },
  cam1: { x: 1000, y: 520 },
};

export const roleColor: Record<Role, string> = {
  pwr: '#b8766e',
  gnd: '#8893a6',
  io: '#6280cf',
};

export const byId = (id: string) => parts.find((part) => part.id === id)!;
export const pinOf = (ref: PinRef) => byId(ref.device).pins.find((pin) => pin.id === ref.pin)!;
export const pinPoint = (ref: PinRef, at: Record<string, Point>): Point => {
  const part = byId(ref.device);
  const center = at[part.id]!;
  const pin = pinOf(ref);
  return { x: center.x + pin.dx * MM, y: center.y + pin.dy * MM };
};
export const sameRef = (a: PinRef, b: PinRef) => a.device === b.device && a.pin === b.pin;
export const refLabel = (ref: PinRef) => `${byId(ref.device).designator}.${ref.pin}`;
export const pinName = (ref: PinRef) => `${refLabel(ref)}·${pinOf(ref).label}`;

export const connectorOf = (ref: PinRef): Connector => {
  const pin = pinOf(ref);
  return byId(ref.device).connectors.find((item) => item.id === pin.connector)!;
};
/** 接头外形：塑料壳高度、露出的金属高度、进深，单位 mm。 */
export interface TerminalSpec {
  housingH: number;
  postH: number;
  depth: number;
}
export const TERMINAL_SPEC: Record<ConnectorKind, TerminalSpec> = {
  header: { housingH: 2.5, postH: 1.2, depth: 2.54 },
  jst: { housingH: 2.4, postH: 1.0, depth: 3.6 },
  pigtail: { housingH: 1.8, postH: 1.4, depth: 2.4 },
  fpc: { housingH: 1.4, postH: 0.4, depth: 3.4 },
};
/**
 * 线接在金属顶部，所以锚点要从安装面抬到一个接头实体的高度。
 * 板端端子本身就是那块塑料壳，只算露出的金属段。
 */
export const terminalHeight = (ref: PinRef) => {
  const part = byId(ref.device);
  const spec = TERMINAL_SPEC[connectorOf(ref).kind];
  return (part.onboard && part.kind === 'terminal' ? 0 : spec.housingH) + spec.postH;
};
/** 接头固定参数的可读描述，侧栏与检查器共用。 */
export const connectorSpec = (connector: Connector) =>
  `${connector.contacts}P ${KIND_LABEL[connector.kind]} · ${connector.pitch} mm 间距 · ${
    connector.gender === 'female' ? '母座' : '公头'
  }${connector.length ? ` · 线长 ${connector.length} mm` : ''}`;
/** 接头在整个系统里的唯一 key，用于把多根芯聚成一束。 */
export const connectorKey = (ref: PinRef) => `${ref.device}:${pinOf(ref).connector}`;
/** 引脚在自己接头里的序号，0 起。 */
export const connectorOrdinal = (ref: PinRef) => {
  const pin = pinOf(ref);
  return byId(ref.device)
    .pins.filter((item) => item.connector === pin.connector)
    .findIndex((item) => item.id === pin.id);
};

export const boardEndOf = (wire: Wire): PinRef => (byId(wire.a.device).onboard ? wire.a : wire.b);
export const deviceEndOf = (wire: Wire): PinRef => (byId(wire.a.device).onboard ? wire.b : wire.a);

export const wiresAt = (ref: PinRef, wires: Wire[]) =>
  wires.filter((wire) => sameRef(wire.a, ref) || sameRef(wire.b, ref));

export const reference: Wire[] = [
  { a: { device: 'j1', pin: '3' }, b: { device: 'm1', pin: '+' }, color: roleColor.io },
  { a: { device: 'j1', pin: '2' }, b: { device: 'm1', pin: '-' }, color: roleColor.gnd },
  { a: { device: 'j1', pin: '1' }, b: { device: 'm2', pin: 'V+' }, color: roleColor.pwr },
  { a: { device: 'j1', pin: '2' }, b: { device: 'm2', pin: 'GND' }, color: roleColor.gnd },
  { a: { device: 'j1', pin: '4' }, b: { device: 'm2', pin: 'SIG' }, color: roleColor.io },
  { a: { device: 'j1', pin: '1' }, b: { device: 'q1', pin: 'V+' }, color: roleColor.pwr },
  { a: { device: 'j1', pin: '2' }, b: { device: 'q1', pin: 'GND' }, color: roleColor.gnd },
  { a: { device: 'j1', pin: '5' }, b: { device: 'q1', pin: 'TRIG' }, color: roleColor.io },
  { a: { device: 'j1', pin: '6' }, b: { device: 'q1', pin: 'ECHO' }, color: roleColor.io },
  { a: { device: 'j1', pin: '1' }, b: { device: 'cam1', pin: 'BL+' }, color: roleColor.pwr },
  { a: { device: 'j1', pin: '2' }, b: { device: 'cam1', pin: 'BL-' }, color: roleColor.gnd },
  ...Array.from({ length: 8 }, (_, index) => ({
    a: { device: 'j2', pin: `${index + 1}` },
    b: { device: 'cam1', pin: `${index + 1}` },
    color: '#c08a52',
  })),
];

export interface Verdict {
  ok: boolean;
  reason?: string;
  warn?: string;
}

/**
 * 三层校验：接头能不能插 → 引脚角色是否匹配 → 系统级拓扑是否合法。
 */
export function judge(a: PinRef, b: PinRef, wires: Wire[]): Verdict {
  const partA = byId(a.device);
  const partB = byId(b.device);
  if (partA.id === partB.id) return { ok: false, reason: '两个引脚在同一个器件上' };
  if (partA.onboard && partB.onboard)
    return { ok: false, reason: '板内连接在 2D 编辑器里布线，不走线束' };
  if (!partA.onboard && !partB.onboard) return { ok: false, reason: '线束必须有一端在板上' };

  const boardRef = partA.onboard ? a : b;
  const deviceRef = partA.onboard ? b : a;
  const boardConn = connectorOf(boardRef);
  const deviceConn = connectorOf(deviceRef);

  const taken = wiresAt(deviceRef, wires)[0];
  if (taken) {
    const other = sameRef(taken.a, deviceRef) ? taken.b : taken.a;
    return {
      ok: false,
      reason: `${pinName(deviceRef)} 已经接到 ${refLabel(other)}，器件引脚只有一根`,
    };
  }

  const canMate =
    deviceConn.mates.includes(boardConn.kind) || boardConn.mates.includes(deviceConn.kind);
  if (!canMate)
    return {
      ok: false,
      reason: `${KIND_LABEL[deviceConn.kind]}插不进${KIND_LABEL[boardConn.kind]}`,
    };
  if (deviceConn.contacts > boardConn.contacts)
    return {
      ok: false,
      reason: `板端 ${boardConn.contacts} 芯，接不下 ${deviceConn.contacts} 芯的接头`,
    };

  const siblings = wires.filter(
    (wire) =>
      deviceEndOf(wire).device === deviceRef.device &&
      connectorOf(deviceEndOf(wire)).id === deviceConn.id,
  );
  const landed = siblings.find((wire) => connectorKey(boardEndOf(wire)) !== connectorKey(boardRef));
  if (landed)
    return {
      ok: false,
      reason: `${deviceConn.label} 其余芯已经落在 ${connectorOf(boardEndOf(landed)).label}，整组必须插在同一个板端接头`,
    };

  if (deviceConn.cable === 'ribbon' && connectorOrdinal(boardRef) !== connectorOrdinal(deviceRef))
    return {
      ok: false,
      reason: `排线是固定线序：${boardConn.label}.${boardRef.pin} 应对 ${deviceConn.label}.${deviceRef.pin}（同序号触点）`,
    };

  const roleDevice = pinOf(deviceRef).role;
  const roleBoard = pinOf(boardRef).role;
  if (
    (roleDevice === 'pwr' && roleBoard === 'gnd') ||
    (roleDevice === 'gnd' && roleBoard === 'pwr')
  )
    return { ok: false, reason: '不能把 +5V 与 GND 接在一起' };
  if (roleDevice === 'pwr' && roleBoard === 'io')
    return { ok: true, warn: `${pinName(deviceRef)} 通常接 +5V，接 GPIO 只能低压试机` };
  if (roleDevice === 'io' && roleBoard === 'pwr')
    return { ok: true, warn: `${pinName(deviceRef)} 接的是电源而不是 GPIO` };
  if (deviceConn.contacts > 1 && boardConn.contacts < deviceConn.contacts)
    return { ok: true, warn: '板端接头芯数不足，剩余芯只能悬空' };
  return { ok: true };
}

/* ---------- 线束：一束线 = 一次接头插合，单根芯只是电气细节 ---------- */

export interface Bundle {
  key: string;
  form: CableForm;
  boardConnector: Connector;
  deviceConnector: Connector;
  indexes: number[];
  /** 两端直线距离，mm。 */
  spanMm: number;
  /** FPC 选用的标准长度 mm。 */
  lengthMm: number | undefined;
  /** FPC 长度不够跨到对端。 */
  tooShort: boolean;
  /** FPC 余量超过线长四成，需要额外盘绕。 */
  tooLong: boolean;
}

export function bundlesOf(wires: Wire[], at: Record<string, Point>): Bundle[] {
  const groups = new Map<string, number[]>();
  wires.forEach((wire, index) => {
    const key = `${connectorKey(boardEndOf(wire))}|${connectorKey(deviceEndOf(wire))}`;
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  return [...groups.entries()].map(([key, indexes]) => {
    const first = wires[indexes[0]!]!;
    const boardRef = boardEndOf(first);
    const deviceRef = deviceEndOf(first);
    const boardConnector = connectorOf(boardRef);
    const deviceConnector = connectorOf(deviceRef);
    const start = pinPoint(boardRef, at);
    const end = pinPoint(deviceRef, at);
    const spanMm = Math.hypot(end.x - start.x, end.y - start.y) / MM;
    const lengthMm = deviceConnector.length;
    return {
      key,
      form: deviceConnector.cable,
      boardConnector,
      deviceConnector,
      indexes,
      spanMm,
      lengthMm,
      tooShort: deviceConnector.cable === 'ribbon' && !!lengthMm && lengthMm < spanMm,
      tooLong: !!lengthMm && lengthMm - spanMm > lengthMm * 0.4,
    };
  });
}

/** FPC 排线带宽 mm：触点跨距 + 两侧余边。 */
export const ribbonWidth = (connector: Connector) => connector.pitch * connector.contacts + 1.4;

interface Anchor {
  ref: PinRef;
  point: Point;
}

const centroid = (points: Point[]): Point => ({
  x: points.reduce((sum, item) => sum + item.x, 0) / points.length,
  y: points.reduce((sum, item) => sum + item.y, 0) / points.length,
});

/** Catmull-Rom 转三次贝塞尔，交给 SVG 渲染平滑线束。 */
export function smoothPath(points: Point[]): string {
  if (points.length < 2) return '';
  let d = `M${points[0]!.x},${points[0]!.y}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[index - 1] ?? points[index]!;
    const p1 = points[index]!;
    const p2 = points[index + 1]!;
    const p3 = points[index + 2] ?? p2;
    d += ` C${p1.x + (p2.x - p0.x) / 6},${p1.y + (p2.y - p0.y) / 6} ${
      p2.x - (p3.x - p1.x) / 6
    },${p2.y - (p3.y - p1.y) / 6} ${p2.x},${p2.y}`;
  }
  return d;
}

/** 把同一条样条按点采样，用来做等距偏移（排线里每根芯的走线）。 */
function sampleSmooth(points: Point[], steps: number): Point[] {
  const out: Point[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[index - 1] ?? points[index]!;
    const p1 = points[index]!;
    const p2 = points[index + 1]!;
    const p3 = points[index + 2] ?? p2;
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    for (let step = index === 0 ? 0 : 1; step <= steps; step += 1) {
      const t = step / steps;
      const u = 1 - t;
      out.push({
        x: u * u * u * p1.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p2.x,
        y: u * u * u * p1.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p2.y,
      });
    }
  }
  return out;
}

/** 沿法向平移一条样条，得到排线里某根导体所在的线。 */
function offsetSmooth(points: Point[], distance: number): string {
  const samples = sampleSmooth(points, 12);
  const shifted = samples.map((point, index) => {
    const previous = samples[Math.max(0, index - 1)]!;
    const next = samples[Math.min(samples.length - 1, index + 1)]!;
    const tx = next.x - previous.x;
    const ty = next.y - previous.y;
    const length = Math.max(0.0001, Math.hypot(tx, ty));
    return { x: point.x - (ty / length) * distance, y: point.y + (tx / length) * distance };
  });
  return smoothPath(shifted);
}

export interface BundlePath {
  key: string;
  form: CableForm;
  /** 束的主干中心线。 */
  trunk: string;
  /** 排线带宽，px。 */
  widthPx: number;
  widthMm: number;
  lengthMm: number | undefined;
  spanMm: number;
  tooShort: boolean;
  tooLong: boolean;
  /** 束内的芯索引，点选整束时用。 */
  indexes: number[];
  /** 每根芯的独立走线；排线只有主干。 */
  cores: { index: number; d: string; color: string }[];
}

/** 2D 画布上的束线路由：主干共用一段，两端散开成扇，和 3D 里的形态一致。 */
export function bundlePaths(wires: Wire[], at: Record<string, Point>): BundlePath[] {
  return bundlesOf(wires, at).map((bundle) => {
    const anchors: Anchor[] = bundle.indexes.map((index) => {
      const boardRef = boardEndOf(wires[index]!);
      return { ref: boardRef, point: pinPoint(boardRef, at) };
    });
    const deviceAnchors: Anchor[] = bundle.indexes.map((index) => {
      const deviceRef = deviceEndOf(wires[index]!);
      return { ref: deviceRef, point: pinPoint(deviceRef, at) };
    });
    const from = centroid(anchors.map((item) => item.point));
    const to = centroid(deviceAnchors.map((item) => item.point));
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const span = Math.max(1, Math.hypot(dx, dy));
    const dir = { x: dx / span, y: dy / span };
    const perpendicular = { x: -dir.y, y: dir.x };
    const sag = Math.min(120, 34 + span * 0.16);
    const trunkMid = {
      x: (from.x + to.x) / 2,
      y: (from.y + to.y) / 2 + sag,
    };
    const widthMm = ribbonWidth(bundle.deviceConnector);

    if (bundle.form === 'ribbon') {
      const widthPx = widthMm * MM;
      const conductors = bundle.deviceConnector.contacts;
      const trunkPoints = [from, trunkMid, to];
      return {
        key: bundle.key,
        form: bundle.form,
        trunk: smoothPath(trunkPoints),
        widthPx,
        widthMm,
        lengthMm: bundle.lengthMm,
        spanMm: bundle.spanMm,
        tooShort: bundle.tooShort,
        tooLong: bundle.tooLong,
        indexes: bundle.indexes,
        cores: Array.from({ length: conductors }, (_, slot) => ({
          index: bundle.indexes[slot] ?? bundle.indexes[0]!,
          d: offsetSmooth(trunkPoints, (slot - (conductors - 1) / 2) * (widthPx / conductors)),
          color: '#a9762f',
        })),
      };
    }

    const lead = Math.min(70, Math.max(24, span * 0.22));
    const breakFrom = { x: from.x + dir.x * lead, y: from.y + dir.y * lead };
    const breakTo = { x: to.x - dir.x * lead, y: to.y - dir.y * lead };
    const spread = 6;
    const cores = bundle.indexes.map((index, slot) => {
      const offset = (slot - (bundle.indexes.length - 1) / 2) * spread;
      const shift = { x: perpendicular.x * offset, y: perpendicular.y * offset };
      const points = [
        anchors[slot]!.point,
        { x: breakFrom.x + shift.x, y: breakFrom.y + shift.y },
        { x: trunkMid.x + shift.x, y: trunkMid.y + shift.y },
        { x: breakTo.x + shift.x, y: breakTo.y + shift.y },
        deviceAnchors[slot]!.point,
      ];
      return { index, d: smoothPath(points), color: wires[index]!.color };
    });

    return {
      key: bundle.key,
      form: bundle.form,
      trunk: smoothPath([breakFrom, trunkMid, breakTo]),
      widthPx: 0,
      widthMm,
      lengthMm: bundle.lengthMm,
      spanMm: bundle.spanMm,
      tooShort: bundle.tooShort,
      tooLong: bundle.tooLong,
      indexes: bundle.indexes,
      cores,
    };
  });
}
