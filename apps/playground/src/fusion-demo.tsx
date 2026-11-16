import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowDownToLine,
  Cable,
  Check,
  ChevronRight,
  Cpu,
  Keyboard,
  LayoutGrid,
  Lightbulb,
  Link2,
  Play,
  RotateCcw,
  Unplug,
  X,
} from 'lucide-react';
import './fusion-demo.css';

const switchIds = [
  'sw0',
  'sw1',
  'sw2',
  'sw3',
  'sw4',
  'sw5',
  'sw6',
  'sw7',
  'sw8',
  'sw9',
  'sw10',
  'sw11',
  'sw12',
  'sw13',
  'sw14',
  'sw15',
] as const;
type SwitchId = (typeof switchIds)[number];
type DeviceId = 'mcu' | 'led' | 'resistor' | SwitchId;
type Mode = 'edit' | 'run';
type Level = '0' | '1' | 'Z' | 'X';
interface Point {
  x: number;
  y: number;
}
interface Endpoint {
  device: DeviceId;
  pin: string;
}
interface Pin extends Point {
  id: string;
  number: number;
  alternate: string;
  side: 'left' | 'right' | 'top' | 'bottom';
}
interface Device {
  designator: string;
  title: string;
  package: string;
  width: number;
  height: number;
  pins: Pin[];
}
interface Net {
  id: string;
  name: string;
  color: string;
  members: Endpoint[];
  rail?: 'VCC' | 'GND';
  /** Daisy-chain the members in order, like a matrix row or column bus. */
  chain?: boolean;
}
interface Scene {
  positions: Record<DeviceId, Point>;
  nets: Net[];
}
interface Camera {
  zoom: number;
  pan: Point;
}

/** Scene unit is 0.2 mm, so each part keeps its datasheet proportions. */
const UNITS_PER_MM = 5;
const pinPitch = 2.54 * UNITS_PER_MM;
const detailScale = 1.5;
const mcuFocusScale = 1.8;

function zoomAround(camera: Camera, requested: number, point: Point): Camera {
  const zoom = Math.max(0.25, Math.min(32, requested));
  const ratio = zoom / camera.zoom;
  return {
    zoom,
    pan: {
      x: point.x - (point.x - camera.pan.x) * ratio,
      y: point.y - (point.y - camera.pan.y) * ratio,
    },
  };
}

/** DIP-40 pinout in package order; pin 1 is the top-left lead. */
const dipPins: readonly (readonly [string, number, string?])[] = [
  ['P1.0', 1, 'T2'],
  ['P1.1', 2, 'T2EX'],
  ['P1.2', 3],
  ['P1.3', 4],
  ['P1.4', 5],
  ['P1.5', 6],
  ['P1.6', 7],
  ['P1.7', 8],
  ['RST', 9],
  ['P3.0', 10, 'RXD'],
  ['P3.1', 11, 'TXD'],
  ['P3.2', 12, 'INT0'],
  ['P3.3', 13, 'INT1'],
  ['P3.4', 14, 'T0'],
  ['P3.5', 15, 'T1'],
  ['P3.6', 16, '/WR'],
  ['P3.7', 17, '/RD'],
  ['XTAL2', 18],
  ['XTAL1', 19],
  ['GND', 20],
  ['P2.0', 21],
  ['P2.1', 22],
  ['P2.2', 23],
  ['P2.3', 24],
  ['P2.4', 25],
  ['P2.5', 26],
  ['P2.6', 27],
  ['P2.7', 28],
  ['PSEN', 29, '/PSEN'],
  ['ALE', 30],
  ['EA', 31, '/EA'],
  ['P0.7', 32],
  ['P0.6', 33],
  ['P0.5', 34],
  ['P0.4', 35],
  ['P0.3', 36],
  ['P0.2', 37],
  ['P0.1', 38],
  ['P0.0', 39],
  ['VCC', 40],
];

const mcuWidth = 15.24 * UNITS_PER_MM;
const mcuHeight = 50.8 * UNITS_PER_MM;
const mcuPins: Pin[] = dipPins.map(([id, number, alternate = '']) => {
  const onLeft = number <= 20;
  const row = onLeft ? number - 1 : 40 - number;
  return {
    id,
    number,
    alternate,
    side: onLeft ? 'left' : 'right',
    x: onLeft ? 0 : mcuWidth,
    y: pinPitch / 2 + row * pinPitch,
  };
});

const smdWidth = 1.6 * UNITS_PER_MM;
const smdHeight = 3.2 * UNITS_PER_MM;
/** 6 × 6 × 5 mm SMD tact switch: 1.6 × 1.2 mm corner pads, 3.5 mm plunger. */
const switchSize = 6.6 * UNITS_PER_MM;
const switchPadW = 1.6 * UNITS_PER_MM;
const switchPadH = 1.2 * UNITS_PER_MM;
const switchPitch = 12.4 * UNITS_PER_MM;
const switchLegend = [
  '1',
  '2',
  '3',
  'A',
  '4',
  '5',
  '6',
  'B',
  '7',
  '8',
  '9',
  'C',
  '*',
  '0',
  '#',
  'D',
];
const smdPins = (): Pin[] => [
  { id: 'A', number: 1, alternate: '阳极', side: 'top', x: smdWidth / 2, y: 0 },
  { id: 'K', number: 2, alternate: '阴极', side: 'bottom', x: smdWidth / 2, y: smdHeight },
];

/** Corner pads of a tact switch: 1-2 on one contact, 3-4 on the other. */
const switchPins: Pin[] = [
  { id: '1', number: 1, alternate: 'A', side: 'top', x: switchPadW / 2, y: switchPadH / 2 },
  {
    id: '2',
    number: 2,
    alternate: 'A',
    side: 'bottom',
    x: switchPadW / 2,
    y: switchSize - switchPadH / 2,
  },
  {
    id: '3',
    number: 3,
    alternate: 'B',
    side: 'top',
    x: switchSize - switchPadW / 2,
    y: switchPadH / 2,
  },
  {
    id: '4',
    number: 4,
    alternate: 'B',
    side: 'bottom',
    x: switchSize - switchPadW / 2,
    y: switchSize - switchPadH / 2,
  },
];

const devices: Record<DeviceId, Device> = {
  mcu: {
    designator: 'U1',
    title: 'AT89C52',
    package: 'DIP-40 · 50.8 × 15.2 mm',
    width: mcuWidth,
    height: mcuHeight,
    pins: mcuPins,
  },
  led: {
    designator: 'D1',
    title: '红色 LED',
    package: 'SMD 1206 · 3.2 × 1.6 mm',
    width: smdWidth,
    height: smdHeight,
    pins: smdPins(),
  },
  resistor: {
    designator: 'R1',
    title: '330 Ω',
    package: 'SMD 1206 · 3.2 × 1.6 mm',
    width: smdWidth,
    height: smdHeight,
    pins: [
      { id: '1', number: 1, alternate: '', side: 'top', x: smdWidth / 2, y: 0 },
      { id: '2', number: 2, alternate: '', side: 'bottom', x: smdWidth / 2, y: smdHeight },
    ],
  },
  ...Object.fromEntries(
    switchLegend.map((label, index) => [
      `sw${index}`,
      {
        designator: `S${index + 1}`,
        title: `按键 ${label}`,
        package: 'SMD 轻触开关 · 6 × 6 × 5 mm',
        width: switchSize,
        height: switchSize,
        pins: switchPins,
      } satisfies Device,
    ]),
  ),
} as Record<DeviceId, Device>;
const isSwitch = (id: DeviceId): id is SwitchId => id.startsWith('sw');
const deviceIds: DeviceId[] = ['mcu', ...switchIds, 'led', 'resistor'];
const endpoint = (device: DeviceId, pin: string): Endpoint => ({ device, pin });
const gridOrigin = { x: 300, y: 205 };
const initialScene: Scene = {
  positions: {
    mcu: { x: 745, y: 174 },
    resistor: { x: 925, y: 194 },
    led: { x: 925, y: 304 },
    ...Object.fromEntries(
      switchIds.map((id, index) => [
        id,
        {
          x: gridOrigin.x + (index % 4) * switchPitch,
          y: gridOrigin.y + Math.floor(index / 4) * switchPitch,
        },
      ]),
    ),
  } as Record<DeviceId, Point>,
  nets: [
    ...Array.from({ length: 4 }, (_, row): Net => ({
      id: `row-${row}`,
      name: `ROW${row}`,
      color: '#bd8457',
      chain: true,
      members: [
        ...switchIds
          .filter((_, index) => Math.floor(index / 4) === row)
          .map((id) => endpoint(id, '1')),
        endpoint('mcu', `P1.${row}`),
      ],
    })),
    ...Array.from({ length: 4 }, (_, column): Net => ({
      id: `col-${column}`,
      name: `COL${column}`,
      color: '#428d89',
      chain: true,
      members: [
        ...switchIds.filter((_, index) => index % 4 === column).map((id) => endpoint(id, '3')),
        endpoint('mcu', `P1.${column + 4}`),
      ],
    })),
    {
      id: 'led-drive',
      name: 'LED_K',
      color: '#6280cf',
      members: [endpoint('mcu', 'P2.0'), endpoint('led', 'K')],
    },
    {
      id: 'led-anode',
      name: 'LED_A',
      color: '#b8766e',
      members: [endpoint('resistor', '2'), endpoint('led', 'A')],
    },
    {
      id: 'vcc',
      name: '+5V',
      rail: 'VCC',
      color: '#b8766e',
      members: [endpoint('mcu', 'VCC'), endpoint('mcu', 'EA'), endpoint('resistor', '1')],
    },
    { id: 'gnd', name: 'GND', rail: 'GND', color: '#8893a6', members: [endpoint('mcu', 'GND')] },
  ],
};
const sameEndpoint = (a: Endpoint, b: Endpoint) => a.device === b.device && a.pin === b.pin;
/** Pins 2 and 4 are internally tied to 1 and 3 inside the switch. */
const contact = (value: Endpoint): Endpoint => {
  if (!isSwitch(value.device)) return value;
  const tie = value.pin === '2' ? '1' : value.pin === '4' ? '3' : value.pin;
  return { device: value.device, pin: tie };
};
const endpointLabel = (value: Endpoint) => `${devices[value.device].designator}.${value.pin}`;
const netAt = (scene: Scene, value: Endpoint) => {
  const target = contact(value);
  return scene.nets.find((net) =>
    net.members.some((member) => sameEndpoint(contact(member), target)),
  );
};
const connected = (scene: Scene, a: Endpoint, b: Endpoint) => {
  const net = netAt(scene, a);
  return net?.members.some((member) => sameEndpoint(contact(member), contact(b))) === true;
};
function pinAt(value: Endpoint): Pin {
  return devices[value.device].pins.find((pin) => pin.id === value.pin)!;
}
function anchor(scene: Scene, value: Endpoint): Point {
  const pin = pinAt(value);
  const point = scene.positions[value.device];
  return { x: point.x + pin.x, y: point.y + pin.y };
}
function pathFor(scene: Scene, a: Endpoint, b: Endpoint): string {
  if (a.device === 'mcu' && b.device !== 'mcu') return pathFor(scene, b, a);
  const start = anchor(scene, a);
  const end = anchor(scene, b);
  if (start.x === end.x || start.y === end.y) return `M${start.x},${start.y} L${end.x},${end.y}`;
  const escape = (value: Endpoint, point: Point): Point => {
    const pin = pinAt(value);
    const distance = value.device === 'mcu' ? pinPitch * 0.9 : pinPitch * 1.4;
    return {
      x: point.x + (pin.side === 'left' ? -distance : pin.side === 'right' ? distance : 0),
      y: point.y + (pin.side === 'top' ? -distance : pin.side === 'bottom' ? distance : 0),
    };
  };
  const from = escape(a, start);
  const to = escape(b, end);
  const bend =
    pinAt(b).side === 'left' || pinAt(b).side === 'right'
      ? `H${to.x} V${to.y}`
      : `V${to.y} H${to.x}`;
  return `M${start.x},${start.y} L${from.x},${from.y} ${bend} L${end.x},${end.y}`;
}
/** Chain nets wire consecutive members; every other net fans out from the first one. */
function netSegments(net: Net): [Endpoint, Endpoint][] {
  return net.chain
    ? net.members.slice(1).map((member, index) => [net.members[index]!, member])
    : net.members.slice(1).map((member) => [net.members[0]!, member]);
}

interface MatrixWire {
  bus: string;
  stubs: string[];
  lead: string;
}

/** Matrix rows run a bus above the row, columns a bus beside the column. */
function matrixWire(scene: Scene, net: Net): MatrixWire | null {
  const points = net.members.map((member) => ({ member, at: anchor(scene, member) }));
  const switches = points.filter((point) => isSwitch(point.member.device));
  const mcu = points.find((point) => point.member.device === 'mcu');
  if (switches.length < 2 || !mcu) return null;
  const gap = switchSize * 0.62;
  const index = Number(net.id.slice(-1)) || 0;
  const horizontal = switches.every((point) => Math.abs(point.at.y - switches[0]!.at.y) < 0.5);
  if (horizontal) {
    const xs = switches.map((point) => point.at.x);
    const left = Math.min(...xs);
    const right = Math.max(...xs);
    const busY = switches[0]!.at.y - gap;
    const channelX = mcu.at.x - pinPitch * (1.2 + index * 0.9);
    return {
      bus: `M${left},${busY} L${right},${busY}`,
      stubs: switches.map((point) => `M${point.at.x},${point.at.y} L${point.at.x},${busY}`),
      lead: `M${right},${busY} L${channelX},${busY} L${channelX},${mcu.at.y} L${mcu.at.x},${mcu.at.y}`,
    };
  }
  const ys = switches.map((point) => point.at.y);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  const busX = switches[0]!.at.x + gap;
  const laneY = bottom + gap + 14 * index;
  const channelX = mcu.at.x - pinPitch * 1.2;
  return {
    bus: `M${busX},${top} L${busX},${bottom}`,
    stubs: switches.map((point) => `M${point.at.x},${point.at.y} L${busX},${point.at.y}`),
    lead: `M${busX},${bottom} L${busX},${laneY} L${channelX},${laneY} L${channelX},${mcu.at.y} L${mcu.at.x},${mcu.at.y}`,
  };
}

function switchPort(scene: Scene, value: Endpoint, group: 'row' | 'column'): number | undefined {
  const net = netAt(scene, value);
  const indexes = net?.members
    .filter((member) => member.device === 'mcu' && /^P1\.[0-7]$/.test(member.pin))
    .map((member) => Number(member.pin.slice(-1)))
    .filter((index) => (group === 'row' ? index < 4 : index >= 4));
  return indexes?.length === 1 ? indexes[0] : undefined;
}
const switchRow = (scene: Scene, id: SwitchId) => switchPort(scene, endpoint(id, '1'), 'row');
const switchColumn = (scene: Scene, id: SwitchId) => switchPort(scene, endpoint(id, '3'), 'column');
const switchLegendOf = (id: SwitchId) => switchLegend[switchIds.indexOf(id)] ?? '';

function FusionDemo() {
  const [scene, setScene] = useState<Scene>(() => structuredClone(initialScene));
  const [mode, setMode] = useState<Mode>('edit');
  const [bodiesVisible, setBodiesVisible] = useState(true);
  const [hiddenBodies, setHiddenBodies] = useState<Partial<Record<DeviceId, boolean>>>({});
  const [wiringInRun, setWiringInRun] = useState(false);
  const [designatorsInRun, setDesignatorsInRun] = useState(true);
  const [selected, setSelected] = useState<DeviceId>('mcu');
  const [selectedNet, setSelectedNet] = useState<string | null>(null);
  const [pending, setPending] = useState<Endpoint | null>(null);
  const [heldSwitches, setHeldSwitches] = useState<SwitchId[]>([]);
  const [scanRow, setScanRow] = useState(0);
  const [showAll, setShowAll] = useState(true);
  const [allPins, setAllPins] = useState(false);
  const [camera, setCamera] = useState<Camera>({ zoom: 1, pan: { x: 0, y: 0 } });
  const [size, setSize] = useState({ width: 1280, height: 740 });
  const [hoveredPin, setHoveredPin] = useState<Endpoint | null>(null);
  const [panning, setPanning] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [notice, setNotice] = useState('器件按封装尺寸绘制。滚轮缩放，中键或空格 + 拖动平移。');
  const viewport = useRef<HTMLDivElement>(null);
  const panDrag = useRef<{ pointer: number; x: number; y: number; pan: Point } | null>(null);
  const drag = useRef<{
    device: DeviceId;
    pointer: number;
    start: Point;
    x: number;
    y: number;
  } | null>(null);
  const suppressClick = useRef(false);
  /** Pointer handlers read these refs so a pan never waits for the next render. */
  const spaceHeldRef = useRef(false);
  const canvasActiveRef = useRef(false);

  const fit = Math.min(size.width / 660, size.height / 440, 1.6);
  const scale = fit * camera.zoom;
  const stageStyle = {
    width: 1280,
    height: 740,
    transform: `translate(${size.width / 2 + camera.pan.x}px, ${size.height / 2 + camera.pan.y}px) scale(${scale}) translate(-640px, -370px)`,
    '--inverse-scale': 1 / scale,
    '--pin-hit': `${Math.min(11 / scale, pinPitch * 0.85)}px`,
  } as CSSProperties;
  const powered =
    netAt(scene, endpoint('mcu', 'VCC'))?.rail === 'VCC' &&
    netAt(scene, endpoint('mcu', 'EA'))?.rail === 'VCC' &&
    netAt(scene, endpoint('mcu', 'GND'))?.rail === 'GND';
  const detectedKeys = powered
    ? heldSwitches.filter(
        (id) => switchRow(scene, id) !== undefined && switchColumn(scene, id) !== undefined,
      )
    : [];
  const gpioLow = detectedKeys.length > 0;
  const ledOn =
    gpioLow &&
    connected(scene, endpoint('mcu', 'P2.0'), endpoint('led', 'K')) &&
    connected(scene, endpoint('resistor', '2'), endpoint('led', 'A')) &&
    netAt(scene, endpoint('resistor', '1'))?.rail === 'VCC';
  const activeNet = scene.nets.find((net) => net.id === selectedNet);
  const definition = devices[selected];

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        setSize({
          width: Math.max(1, entry.contentRect.width),
          height: Math.max(1, entry.contentRect.height),
        });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const delta =
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
      const point = {
        x: event.clientX - rect.left - rect.width / 2,
        y: event.clientY - rect.top - rect.height / 2,
      };
      setCamera((value) => zoomAround(value, value.zoom * Math.exp(-delta * 0.002), point));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);
  useEffect(() => {
    if (mode !== 'run' || !powered) return;
    const timer = setInterval(() => setScanRow((row) => (row + 1) % 4), 240);
    return () => clearInterval(timer);
  }, [mode, powered]);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      const activationTarget =
        event.target instanceof HTMLElement &&
        (event.target.closest('input, select, textarea, .switch-hit') ||
          event.target.isContentEditable);
      if (event.code === 'Space' && canvasActiveRef.current && !activationTarget) {
        event.preventDefault();
        spaceHeldRef.current = true;
        setSpaceHeld(true);
      }
      if (event.key === 'Escape') {
        setPending(null);
        setHeldSwitches([]);
        spaceHeldRef.current = false;
        setSpaceHeld(false);
      }
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        spaceHeldRef.current = false;
        setSpaceHeld(false);
      }
    };
    const release = () => {
      setHeldSwitches([]);
      spaceHeldRef.current = false;
      setSpaceHeld(false);
      panDrag.current = null;
      setPanning(false);
    };
    const visibility = () => {
      if (document.hidden) release();
    };
    document.addEventListener('keydown', cancel);
    document.addEventListener('keyup', keyUp);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      document.removeEventListener('keydown', cancel);
      document.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);

  function focusDevice(id: DeviceId) {
    const position = scene.positions[id];
    const device = devices[id];
    const targetScale =
      id === 'mcu' ? mcuFocusScale : isSwitch(id) ? 6 : Math.min(3, 420 / device.width);
    const zoom = Math.max(0.25, Math.min(32, targetScale / fit));
    const actualScale = zoom * fit;
    setCamera({
      zoom,
      pan: {
        x: (640 - position.x - device.width / 2) * actualScale,
        y: (370 - position.y - device.height / 2) * actualScale,
      },
    });
    setSelected(id);
  }

  function level(net: Net | undefined): Level {
    if (!net || mode !== 'run') return 'Z';
    const drives: Level[] = net.rail ? [net.rail === 'VCC' ? '1' : '0'] : [];
    if (powered) {
      for (const member of net.members) {
        if (member.device === 'mcu' && /^P1\.[0-3]$/.test(member.pin))
          drives.push(Number(member.pin.slice(-1)) === scanRow ? '0' : '1');
        if (member.device === 'mcu' && member.pin === 'P2.0') drives.push(gpioLow ? '0' : '1');
      }
      const columnSwitch = net.members.find(
        (member) => isSwitch(member.device) && contact(member).pin === '3',
      );
      if (columnSwitch) {
        const column = switchColumn(scene, columnSwitch.device as SwitchId);
        drives.push(
          heldSwitches.some(
            (id) => switchColumn(scene, id) === column && switchRow(scene, id) === scanRow,
          )
            ? '0'
            : '1',
        );
      }
    }
    if (drives.includes('0') && drives.includes('1')) return 'X';
    return drives[0] ?? 'Z';
  }
  function changeMode(next: Mode) {
    setMode(next);
    setPending(null);
    setHeldSwitches([]);
    setNotice(
      next === 'run'
        ? '运行中：按住任意开关点亮 LED。导线与引脚按底部选项显示或隐藏，可随时切回编辑。'
        : '编辑：拖动器件，点击引脚接线；布局与接线在同一个模式完成。',
    );
  }
  function selectDevice(id: DeviceId) {
    setSelected(id);
    setSelectedNet(null);
  }
  function connect(value: Endpoint) {
    setSelected(value.device);
    if (mode !== 'edit') {
      setSelectedNet(netAt(scene, value)?.id ?? null);
      return;
    }
    if (value.device === 'mcu' && scale < detailScale) {
      focusDevice('mcu');
      setNotice('已放大到可读倍率；再点一次该引脚开始接线。');
      return;
    }
    if (!pending) {
      setPending(value);
      setSelectedNet(netAt(scene, value)?.id ?? null);
      setNotice(`已选择 ${endpointLabel(value)}，点击目标引脚。Esc 取消。`);
      return;
    }
    if (sameEndpoint(pending, value)) {
      setPending(null);
      return;
    }
    const first = netAt(scene, pending);
    const second = netAt(scene, value);
    if (first && first === second) {
      setSelectedNet(first.id);
      setNotice('两个引脚已在同一网络中。');
    } else if (first?.rail && second?.rail && first.rail !== second.rail) {
      setNotice('连接被拒绝：+5V 与 GND 不能直接短接。');
    } else {
      const rail = first?.rail ?? second?.rail;
      const primary = first?.rail ? first : second?.rail ? second : (first ?? second);
      const net: Net = {
        id: first?.id ?? second?.id ?? crypto.randomUUID(),
        name: primary?.name ?? `NET_${crypto.randomUUID().slice(0, 4)}`,
        color: primary?.color ?? '#6280cf',
        members: [...(first?.members ?? [pending]), ...(second?.members ?? [value])],
        ...(rail ? { rail } : {}),
      };
      setScene({
        ...scene,
        nets: [...scene.nets.filter((item) => item !== first && item !== second), net],
      });
      setSelectedNet(net.id);
      setNotice(`${endpointLabel(pending)} ↔ ${endpointLabel(value)} 已连接。`);
    }
    setPending(null);
  }
  function startDrag(event: PointerEvent<HTMLButtonElement>, id: DeviceId) {
    if (spaceHeldRef.current || panDrag.current || event.button !== 0) return;
    selectDevice(id);
    if (mode === 'run') return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* capture is best effort */
    }
    drag.current = {
      device: id,
      pointer: event.pointerId,
      start: scene.positions[id],
      x: event.clientX,
      y: event.clientY,
    };
  }
  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    const device = devices[current.device];
    const x = Math.max(
      30,
      Math.min(1250 - device.width, current.start.x + (event.clientX - current.x) / scale),
    );
    const y = Math.max(
      45,
      Math.min(710 - device.height, current.start.y + (event.clientY - current.y) / scale),
    );
    if (
      deviceIds.some((id) => {
        const other = scene.positions[id];
        return (
          id !== current.device &&
          x < other.x + devices[id].width + 12 &&
          x + device.width + 12 > other.x &&
          y < other.y + devices[id].height + 12 &&
          y + device.height + 12 > other.y
        );
      })
    ) {
      setNotice('器件本体之间保留 12 单位间距（约 2.4 mm），避免重叠。');
      return;
    }
    setScene((value) => ({
      ...value,
      positions: { ...value.positions, [current.device]: { x, y } },
    }));
  }
  function holdSwitch(id: SwitchId) {
    setSelected(id);
    if (mode !== 'run') return;
    setHeldSwitches((keys) => (keys.includes(id) ? keys : [...keys, id]));
    setNotice(
      `按下 ${devices[id].designator}（${switchLegendOf(id)}）：ROW${Math.floor(switchIds.indexOf(id) / 4)} ↔ COL${switchIds.indexOf(id) % 4} 闭合。`,
    );
  }
  function releaseSwitch(id: SwitchId) {
    setHeldSwitches((keys) => keys.filter((item) => item !== id));
  }
  function reset() {
    setScene(structuredClone(initialScene));
    setHeldSwitches([]);
    setPending(null);
    setSelectedNet(null);
    setScanRow(0);
    setCamera({ zoom: 1, pan: { x: 0, y: 0 } });
    setNotice('已恢复按封装尺寸绘制的场景与接线。');
  }
  function download() {
    const data = {
      format: 'mica-fusion-prototype',
      version: 3,
      units: '0.2mm',
      devices: deviceIds.map((id) => ({
        id,
        designator: devices[id].designator,
        package: devices[id].package,
        type: devices[id].title,
        pins: devices[id].pins.map(({ id: pin, number, alternate }) => ({
          id: pin,
          number,
          alternate,
        })),
      })),
      nets: scene.nets,
      representations: deviceIds.map((id) => ({
        id: `view-${id}`,
        device: id,
        ...scene.positions[id],
        width: devices[id].width,
        height: devices[id].height,
        kind: isSwitch(id) || id === 'led' ? 'widget' : 'symbol',
        bindings: isSwitch(id)
          ? { press: { device: id, port: 'press' } }
          : id === 'led'
            ? { brightness: { device: 'led', port: 'brightness' } }
            : {},
      })),
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = '89c52-keys-led.demo.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice('已导出引脚、网络、按 mm 换算的尺寸与 widget 绑定。');
  }
  const visiblePins = definition.pins.filter(
    (pin) => allPins || netAt(scene, endpoint(selected, pin.id)),
  );

  return (
    <div className="fusion-app">
      <header className="fusion-header">
        <a className="fusion-brand" href="/">
          <span>m</span> mica <small>实验室</small>
        </a>
        <div className="project-title">
          AT89C52 <ChevronRight size={13} /> LED + 16 键矩阵 <span>交互原型</span>
        </div>
        <button className="quiet-button" onClick={download}>
          <ArrowDownToLine size={14} />
          导出场景
        </button>
      </header>
      <div className="fusion-workspace">
        <aside className="fusion-sidebar">
          <h2>
            器件 <span>{String(deviceIds.length).padStart(2, '0')}</span>
          </h2>
          <div className="device-list">
            {deviceIds.map((id) => {
              const Icon =
                id === 'mcu' ? Cpu : isSwitch(id) ? Keyboard : id === 'led' ? Lightbulb : Cable;
              return (
                <button
                  key={id}
                  className={selected === id ? 'selected' : ''}
                  onClick={() => selectDevice(id)}
                >
                  <Icon size={16} />
                  <span>
                    {devices[id].title}
                    <small>
                      {devices[id].designator} · {devices[id].pins.length} pins
                    </small>
                  </span>
                  <ChevronRight size={12} />
                </button>
              );
            })}
          </div>
          <h2 className="network-heading">
            网络 <span>{scene.nets.length}</span>
          </h2>
          <div className="net-list">
            {scene.nets.map((net) => (
              <button
                key={net.id}
                className={selectedNet === net.id ? 'selected' : ''}
                onClick={() => {
                  setSelectedNet(net.id);
                  setPending(null);
                }}
              >
                <i style={{ background: net.color }} />
                <span>{net.name}</span>
                <small className={`level level-${level(net)}`}>
                  {mode === 'run' ? level(net) : net.members.length}
                </small>
              </button>
            ))}
          </div>
          <div className="sidebar-note">
            <span>REAL SCALE</span>
            <p>
              1 单位 = 0.2 mm
              <br />
              脚距 2.54 mm · SMD 1206 · 开关 6 mm
            </p>
            <small>按封装尺寸绘制</small>
          </div>
        </aside>
        <main className="fusion-main">
          <div className="canvas-toolbar">
            <div className="mode-switch">
              {(
                [
                  ['edit', LayoutGrid, '编辑'],
                  ['run', Play, '运行'],
                ] as const
              ).map(([value, Icon, label]) => (
                <button
                  key={value}
                  aria-pressed={mode === value}
                  className={mode === value ? 'active' : ''}
                  onClick={() => changeMode(value)}
                >
                  <Icon size={14} />
                  {label}
                </button>
              ))}
            </div>
            <div className="canvas-tools">
              <button onClick={reset} aria-label="重置场景">
                <RotateCcw size={14} />
              </button>
              <button
                aria-label="缩小画布"
                disabled={camera.zoom <= 0.25}
                onClick={() =>
                  setCamera((value) => zoomAround(value, value.zoom / 1.5, { x: 0, y: 0 }))
                }
              >
                −
              </button>
              <button
                onClick={() => setCamera({ zoom: 1, pan: { x: 0, y: 0 } })}
                aria-label="适应画布"
              >
                {Math.round(scale * 100)}%
              </button>
              <button
                aria-label="放大画布"
                disabled={camera.zoom >= 32}
                onClick={() =>
                  setCamera((value) => zoomAround(value, value.zoom * 1.5, { x: 0, y: 0 }))
                }
              >
                +
              </button>
            </div>
          </div>
          <div className="canvas-context">
            <div>
              <span className="eyebrow">REAL PROPORTIONS · FLAT DRAWING</span>
              <h1>按封装尺寸摆，按需要放大。</h1>
              <p>DIP-40 · SMD 1206 · 16 × 6 mm 轻触开关 · 1 单位 = 0.2 mm</p>
            </div>
            <span className={`mode-badge ${mode === 'run' ? 'running' : ''}`}>
              <i />
              {mode === 'run'
                ? powered
                  ? '矩阵扫描中'
                  : '主控未供电'
                : scale >= detailScale
                  ? '精细接线'
                  : '整体布局'}
            </span>
          </div>
          <div
            className={`scene-viewport ${panning ? 'panning' : spaceHeld ? 'pan-ready' : ''}`}
            ref={viewport}
            tabIndex={0}
            role="region"
            aria-label="电路画布"
            onPointerEnter={() => {
              canvasActiveRef.current = true;
            }}
            onPointerLeave={() => {
              canvasActiveRef.current = document.activeElement === viewport.current;
              setHoveredPin(null);
            }}
            onFocus={() => {
              canvasActiveRef.current = true;
            }}
            onPointerDownCapture={(event) => {
              if (event.button !== 1 && !(event.button === 0 && spaceHeldRef.current)) {
                if (event.target === event.currentTarget || event.target instanceof SVGSVGElement)
                  event.currentTarget.focus();
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              panDrag.current = {
                pointer: event.pointerId,
                x: event.clientX,
                y: event.clientY,
                pan: camera.pan,
              };
              suppressClick.current = event.button === 0;
              setPanning(true);
              setHoveredPin(null);
            }}
            onPointerMove={(event) => {
              const current = panDrag.current;
              if (!current || current.pointer !== event.pointerId) return;
              setCamera((value) => ({
                ...value,
                pan: {
                  x: current.pan.x + event.clientX - current.x,
                  y: current.pan.y + event.clientY - current.y,
                },
              }));
            }}
            onPointerUp={(event) => {
              if (panDrag.current?.pointer !== event.pointerId) return;
              panDrag.current = null;
              setPanning(false);
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onLostPointerCapture={(event) => {
              if (panDrag.current?.pointer === event.pointerId) {
                panDrag.current = null;
                setPanning(false);
              }
            }}
            onPointerCancel={() => {
              panDrag.current = null;
              setPanning(false);
              suppressClick.current = false;
            }}
            onClickCapture={(event) => {
              if (suppressClick.current) {
                event.preventDefault();
                event.stopPropagation();
                suppressClick.current = false;
              }
            }}
          >
            <div
              className="scene-stage"
              data-scale={scale}
              data-detail={scale >= detailScale ? 'full' : 'compact'}
              data-bodies={mode === 'edit' || bodiesVisible ? 'on' : 'off'}
              data-wiring={mode === 'run' && !wiringInRun ? 'off' : 'full'}
              data-designators={mode === 'edit' || designatorsInRun ? 'on' : 'off'}
              style={stageStyle}
            >
              <svg className="wire-layer" width="1280" height="740" aria-label="逐引脚电气连接">
                {scene.nets.map((net) => {
                  const visible =
                    showAll ||
                    net.id === selectedNet ||
                    net.members.some((member) => member.device === selected);
                  if (!visible) return null;
                  const muted = selectedNet !== null && selectedNet !== net.id;
                  const bus = net.chain ? matrixWire(scene, net) : null;
                  const selectThis = () => setSelectedNet(net.id);
                  return (
                    <g key={net.id} opacity={muted ? 0.14 : 1}>
                      {net.rail ? (
                        net.members.map((member) => {
                          const at = anchor(scene, member);
                          const pin = pinAt(member);
                          const dx = pin.side === 'left' ? -1 : pin.side === 'right' ? 1 : 0;
                          const dy = pin.side === 'top' ? -1 : pin.side === 'bottom' ? 1 : 0;
                          return (
                            <g
                              key={endpointLabel(member)}
                              className="rail-label"
                              onClick={() => setSelectedNet(net.id)}
                            >
                              <path
                                d={`M${at.x},${at.y} l${dx * pinPitch},${dy * pinPitch}`}
                                stroke={net.color}
                              />
                              <text
                                x={at.x + dx * (pinPitch + 3)}
                                y={at.y + dy * (pinPitch + 3) + (dy === 0 ? 3 / scale : 0)}
                                style={{ fontSize: 8 / scale }}
                                textAnchor={dx === 0 ? 'middle' : dx > 0 ? 'start' : 'end'}
                                fill={net.color}
                              >
                                {net.name}
                              </text>
                            </g>
                          );
                        })
                      ) : bus ? (
                        <g>
                          <path className="wire-hit" d={bus.lead} onClick={selectThis} />
                          <path
                            className={`wire ${selectedNet === net.id ? 'highlight' : ''} ${mode === 'run' && level(net) === '0' ? 'low' : ''}`}
                            d={bus.lead}
                            stroke={net.color}
                          />
                          <path className="wire" d={bus.bus} stroke={net.color} />
                          {bus.stubs.map((d) => (
                            <path key={d} className="wire" d={d} stroke={net.color} />
                          ))}
                        </g>
                      ) : (
                        netSegments(net).map(([from, to]) => (
                          <g key={`${endpointLabel(from)}-${endpointLabel(to)}`}>
                            <path
                              className="wire-hit"
                              d={pathFor(scene, from, to)}
                              onClick={() => {
                                setSelectedNet(net.id);
                                setPending(null);
                              }}
                            />
                            <path
                              className={`wire ${selectedNet === net.id ? 'highlight' : ''} ${mode === 'run' && level(net) === '0' ? 'low' : ''}`}
                              d={pathFor(scene, from, to)}
                              stroke={net.color}
                            />
                          </g>
                        ))
                      )}
                    </g>
                  );
                })}
              </svg>
              {deviceIds.map((id) => {
                const device = devices[id];
                const position = scene.positions[id];
                const bodyHidden = mode === 'run' && hiddenBodies[id] === true;
                const dragProps = {
                  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => startDrag(event, id),
                  onPointerMove: moveDrag,
                  onPointerUp: () => {
                    drag.current = null;
                  },
                  onPointerCancel: () => {
                    drag.current = null;
                  },
                  onClick: () => selectDevice(id),
                };
                return (
                  <section
                    key={id}
                    aria-label={`${device.designator} ${device.title}`}
                    className={`scene-device device-${id} ${isSwitch(id) ? 'device-switch' : ''} ${selected === id ? 'selected' : ''} ${bodyHidden ? 'body-hidden' : ''}`}
                    style={{
                      left: position.x,
                      top: position.y,
                      width: device.width,
                      height: device.height,
                    }}
                  >
                    <button
                      {...dragProps}
                      className="device-grab"
                      aria-label={`选择或拖动 ${device.designator}`}
                      title={`${device.designator} · ${device.package}`}
                    />
                    <div className="device-body" onDoubleClick={() => focusDevice(id)}>
                      {id === 'mcu' ? (
                        <>
                          <span className="mcu-notch" />
                          <span className="mcu-text">89C52</span>
                          <span className="mcu-text sub">AT89C52 · DIP-40</span>
                        </>
                      ) : isSwitch(id) ? (
                        <>
                          <span className="switch-body" />
                          <span className="switch-pad pad-tl" />
                          <span className="switch-pad pad-bl" />
                          <span className="switch-pad pad-tr" />
                          <span className="switch-pad pad-br" />
                          <span className="switch-tie tie-left" />
                          <span className="switch-tie tie-right" />
                        </>
                      ) : id === 'led' ? (
                        <>
                          <span className="smd-pad pad-top" />
                          <span className="smd-pad pad-bottom" />
                          <span className="smd-case" />
                        </>
                      ) : (
                        <>
                          <span className="smd-pad pad-top" />
                          <span className="smd-pad pad-bottom" />
                          <span className="smd-case" />
                        </>
                      )}
                    </div>
                    <div className={`device-state ${id === 'led' && ledOn ? 'lit' : ''}`}>
                      {isSwitch(id) ? (
                        <>
                          {mode === 'run' ? (
                            <button
                              aria-label={`${devices[id].designator} 按键 ${switchLegendOf(id)}`}
                              aria-pressed={heldSwitches.includes(id)}
                              className={`switch-hit ${heldSwitches.includes(id) ? 'held' : ''} ${powered && switchRow(scene, id) === scanRow ? 'scanning' : ''}`}
                              onPointerDown={(event) => {
                                if (event.button !== 0) return;
                                try {
                                  event.currentTarget.setPointerCapture(event.pointerId);
                                } catch {
                                  /* capture is best effort */
                                }
                                holdSwitch(id);
                              }}
                              onPointerUp={() => releaseSwitch(id)}
                              onPointerCancel={() => releaseSwitch(id)}
                              onLostPointerCapture={() => releaseSwitch(id)}
                              onKeyDown={(event) => {
                                if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
                                  event.preventDefault();
                                  holdSwitch(id);
                                }
                              }}
                              onKeyUp={(event) => {
                                if (event.key === ' ' || event.key === 'Enter') {
                                  event.preventDefault();
                                  releaseSwitch(id);
                                }
                              }}
                              onBlur={() => releaseSwitch(id)}
                            >
                              <span className="switch-plunger" />
                              <span className="switch-key">{switchLegendOf(id)}</span>
                            </button>
                          ) : (
                            <>
                              <span className="switch-plunger" />
                              <span className="switch-key">{switchLegendOf(id)}</span>
                            </>
                          )}
                          <span className="device-caption switch-caption">
                            <span className="designator">{devices[id].designator}</span>
                          </span>
                        </>
                      ) : id === 'led' ? (
                        <>
                          <span className="led-dot" />
                          <span className="led-glow" />
                          <span className="smd-label led-label">
                            <span className="designator">D1</span>
                            <strong data-testid="led-state">{ledOn ? 'ON' : 'OFF'}</strong>
                          </span>
                        </>
                      ) : id === 'resistor' ? (
                        <span className="smd-label resistor-label">
                          <span className="designator">R1</span>
                          <small>330Ω</small>
                        </span>
                      ) : (
                        <span className="device-caption mcu-caption">
                          <span className="designator">U1</span>
                        </span>
                      )}
                    </div>
                    {device.pins.map((pin) => {
                      const value = endpoint(id, pin.id);
                      const net = netAt(scene, value);
                      const logic = level(net);
                      return (
                        <button
                          key={pin.id}
                          aria-label={`引脚 ${device.designator}.${pin.id}`}
                          title={`${endpointLabel(value)} · 脚号 ${pin.number}${pin.alternate ? ` / ${pin.alternate}` : ''} · ${net?.name ?? '未连接'}`}
                          data-pin-number={pin.number}
                          data-level={logic}
                          className={`device-pin side-${pin.side} ${net ? 'connected' : ''} ${pending && sameEndpoint(pending, value) ? 'pending' : ''}`}
                          style={{ left: pin.x, top: pin.y, color: net?.color ?? '#9aa4b5' }}
                          onPointerEnter={() => setHoveredPin(value)}
                          onPointerLeave={() => setHoveredPin(null)}
                          onFocus={() => setHoveredPin(value)}
                          onBlur={() => setHoveredPin(null)}
                          onClick={() => connect(value)}
                        >
                          <i />
                          {id === 'mcu' ? (
                            <>
                              <span className="pin-number">{pin.number}</span>
                              <span className="pin-name">
                                {pin.id}
                                {pin.alternate && <small>{pin.alternate}</small>}
                              </span>
                            </>
                          ) : (
                            <span className="pin-name">{pin.id}</span>
                          )}
                          {mode === 'run' && net && (
                            <span className={`pin-level level-${logic}`}>{logic}</span>
                          )}
                        </button>
                      );
                    })}
                  </section>
                );
              })}
            </div>
            <div className="view-hint">
              {mode === 'run' && !wiringInRun
                ? '运行态隐藏导线与引脚；勾选「运行时显示接线」查看连接'
                : hoveredPin
                  ? `${endpointLabel(hoveredPin)} · 脚号 ${pinAt(hoveredPin).number} · ${netAt(scene, hoveredPin)?.name ?? '未连接'}`
                  : scale < detailScale
                    ? '放大后显示脚名与脚号；SMD 器件需放大才能精确接线'
                    : '精细接线 · 引脚命中按屏幕像素计算'}
            </div>
            <div className="scene-legend">
              <span>
                <i className="row-dot" />
                行扫描
              </span>
              <span>
                <i className="col-dot" />
                列读取
              </span>
              <span>
                <i className="led-dot" />
                LED 驱动
              </span>
              <span>1 单位 = 0.2 mm</span>
            </div>
          </div>
          <div className="canvas-bottom">
            <span role="status">{notice}</span>
            <div className="canvas-toggles">
              <label>
                <input
                  type="checkbox"
                  checked={bodiesVisible}
                  onChange={(event) => setBodiesVisible(event.target.checked)}
                />
                运行时显示底图
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={wiringInRun}
                  onChange={(event) => setWiringInRun(event.target.checked)}
                />
                运行时显示接线
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={designatorsInRun}
                  onChange={(event) => setDesignatorsInRun(event.target.checked)}
                />
                运行时显示位号
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={showAll}
                  onChange={(event) => setShowAll(event.target.checked)}
                />
                全部网络
              </label>
            </div>
          </div>
          <footer className="canvas-footer">
            <span>DIP-40 · 16 个轻触开关 · 2 SMD parts · {scene.nets.length} nets</span>
            <span>真实比例 · 滚轮缩放 · 中键平移</span>
          </footer>
        </main>
        <aside className="fusion-inspector">
          <div className="inspector-heading">
            器件检查器<span>INSPECTOR</span>
          </div>
          <div className="inspector-device">
            <span>{definition.designator}</span>
            <h2>{definition.title}</h2>
            <small>{definition.package}</small>
            <button className="focus-device" onClick={() => focusDevice(selected)}>
              {selected === 'mcu' ? '放大引脚' : '聚焦器件'}
            </button>
            <label className="body-toggle">
              <input
                type="checkbox"
                checked={hiddenBodies[selected] !== true}
                onChange={(event) =>
                  setHiddenBodies((current) => ({ ...current, [selected]: !event.target.checked }))
                }
              />
              运行时显示此器件底图
            </label>
            <p className="inspector-tip">
              运行视图的显示选项在编辑态即可设置，运行后生效；编辑态始终显示底图、接线、引脚与位号。
            </p>
          </div>
          <section className="inspector-section">
            <h3>
              运行观察<span>LIVE</span>
            </h3>
            <div className="runtime-row">
              <span>扫描行</span>
              <strong>{mode === 'run' && powered ? `P1.${scanRow} = 0` : '暂停'}</strong>
            </div>
            <div className="runtime-row">
              <span>识别按键</span>
              <strong data-testid="detected-keys">
                {detectedKeys.map((id) => switchLegendOf(id)).join(', ') || '—'}
              </strong>
            </div>
            <div className="runtime-row">
              <span>P2.0</span>
              <strong data-testid="gpio-state">
                {powered && mode === 'run' ? (gpioLow ? '0 · 点亮' : '1 · 熄灭') : '—'}
              </strong>
            </div>
            <p className="inspector-tip">
              运行后按住任意开关。断开任一行或列，该行或列的开关将无法识别。
            </p>
          </section>
          <section className="inspector-section">
            <h3>
              <Link2 size={13} />
              展示与绑定
            </h3>
            <div className="binding-summary">
              {isSwitch(selected) ? (
                <>
                  <code>{definition.designator}.press → 按键 widget</code>
                  <span>boolean 输入；1 / 2 为同一触点，3 / 4 为另一触点，按下即短接两侧。</span>
                </>
              ) : selected === 'led' ? (
                <>
                  <code>D1.brightness → LED widget</code>
                  <span>number 输出表示亮度；A / K 决定电气连接。</span>
                </>
              ) : (
                <>
                  <code>{definition.package}</code>
                  <span>按封装尺寸绘制，不附加模块卡片。</span>
                </>
              )}
            </div>
            <div className="binding-valid">
              <Check size={12} />
              展示绑定到稳定器件 ID
            </div>
          </section>
          <section className="inspector-section">
            <h3>
              <Cable size={13} />
              引脚与网络
              <label>
                <input
                  type="checkbox"
                  checked={allPins}
                  onChange={(event) => setAllPins(event.target.checked)}
                />
                全部
              </label>
            </h3>
            <div className="inspector-pins">
              {visiblePins.map((pin) => {
                const net = netAt(scene, endpoint(selected, pin.id));
                return (
                  <button
                    key={pin.id}
                    className={net?.id === selectedNet ? 'selected' : ''}
                    onClick={() => setSelectedNet(net?.id ?? null)}
                  >
                    <small>{pin.number}</small>
                    <span>{pin.id}</span>
                    <em>{net?.name ?? '开放'}</em>
                    <i className={`level level-${level(net)}`}>
                      {mode === 'run' ? level(net) : '·'}
                    </i>
                  </button>
                );
              })}
            </div>
            <p className="pin-count">
              显示 {visiblePins.length} / {definition.pins.length} · 放大后显示引脚标注
            </p>
            {activeNet && (
              <div className="net-detail">
                <div>
                  <strong style={{ color: activeNet.color }}>{activeNet.name}</strong>
                  <button aria-label="关闭网络详情" onClick={() => setSelectedNet(null)}>
                    <X size={13} />
                  </button>
                </div>
                {activeNet.members.map((member) => (
                  <span key={endpointLabel(member)}>{endpointLabel(member)}</span>
                ))}
                <button
                  className="disconnect-button"
                  onClick={() => {
                    setScene({
                      ...scene,
                      nets: scene.nets.filter((net) => net.id !== activeNet.id),
                    });
                    setSelectedNet(null);
                    setPending(null);
                    setHeldSwitches([]);
                    setNotice(`已断开 ${activeNet.name}。在编辑模式下可逐引脚重连。`);
                  }}
                >
                  <Unplug size={13} />
                  断开此网络
                </button>
              </div>
            )}
          </section>
          <div className="prototype-note">
            <span>INTERACTION PROTOTYPE</span>
            <p>
              尺寸按封装绘制，运行使用本地矩阵扫描逻辑；未执行 8051
              固件、未接入仿真内核。供电为理想网标，时钟与复位由演示逻辑提供。
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<FusionDemo />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
