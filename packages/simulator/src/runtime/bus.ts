// PROTOTYPE: 传输级旁路——只支持 parallel-sync（并行同步总线）与 spi 两个 profile。
//
// 目标：在一个有界突发里把「逐引脚 + 逐边沿」的数据搬运换成一次同步切片交付。
// 任何守卫不满足时 `transfer` 返回 false，调用方必须退回逐引脚路径；本模块不改写
// 任何既有校验语义，只新增可选入口。
import type { ElectricalTopology } from '../electrical';
import type {
  BusAttachOptions,
  BusBinding,
  BusEffects,
  BusEndpoint,
  BusSlice,
  BusTransferRequest,
} from '../types';
import type { Instance, InstanceBoard } from './instance';

/** PROTOTYPE: 各 profile 必须两侧一致的配置项（键名是 profile 语义，不含任何器件名）。 */
const profileKeys: Readonly<Record<'spi' | 'parallel-sync', readonly string[]>> = Object.freeze({
  spi: Object.freeze([
    'mode',
    'bitOrder',
    'bitsPerWord',
    'clockKey',
    'serialKey',
    'clockIdle',
    'highPin',
    'lowPin',
    'resistance',
  ]),
  'parallel-sync': Object.freeze([
    'pclkEdge',
    'width',
    'bitOrder',
    'clockKey',
    'dataKey',
    'clockIdle',
    'highPin',
    'lowPin',
    'resistance',
  ]),
});

const nonEmpty = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0)
    throw new TypeError(`${label} must be a non-empty string`);
  return value;
};

/** 引脚下标里的 `string | readonly string[]` 归一成数组；单名称包一层。 */
function pinNames(value: string | readonly string[]): readonly string[] {
  return typeof value === 'string' ? [value] : value;
}

/** PROTOTYPE: 板侧登记的端点条目；`InstanceBoard` 只依赖这个结构。 */
export interface BusEndpointHost {
  readonly instance: Instance;
  readonly options: BusAttachOptions;
  dispose(): void;
}

interface ResolvedPair {
  readonly target: BusEndpointHost;
  readonly initiatorBinding: BusBinding;
  readonly targetBinding: BusBinding;
}

/**
 * 守卫 3：两侧引脚必须落在同一组电气节点上，且每组节点只有这两个端点的引脚。
 */
function sameNodes(
  initiator: Instance,
  target: Instance,
  groups: readonly { readonly left: readonly string[]; readonly right: readonly string[] }[],
  topology: ElectricalTopology,
): boolean {
  const seen = new Set<number>();
  for (const group of groups) {
    for (let index = 0; index < group.left.length; index++) {
      const left = initiator.pins.get(group.left[index]!);
      const right = target.pins.get(group.right[index]!);
      if (left === undefined || right === undefined) return false;
      const node = topology.node(left);
      if (node < 0 || node !== topology.node(right)) return false;
      const pins = topology.pins(node);
      if (pins.length !== 2) return false;
      if (!pins.includes(left) || !pins.includes(right)) return false;
      if (left.instance === right.instance) return false;
      if (seen.has(node)) return false;
      seen.add(node);
    }
  }
  return true;
}

/** 守卫 4：这些引脚上不能有第三方订阅者。 */
function noThirdPartySubscribers(
  initiator: Instance,
  target: Instance,
  pins: readonly (readonly [Instance, string])[],
): boolean {
  for (const [instance, name] of pins) {
    const slot = instance.sampleResources.get(name);
    if (slot === undefined) return false;
    for (const subscriber of slot.subscribers) {
      const owner = (subscriber as { readonly instance?: Instance }).instance;
      if (owner !== initiator && owner !== target) return false;
    }
  }
  return true;
}

/** PROTOTYPE: 一个绑定在实例上的传输端点。 */
export class PrototypeBusEndpoint implements BusEndpoint, BusEndpointHost {
  readonly endpoint: BusEndpoint = this;
  #disposed = false;

  constructor(
    readonly instance: Instance,
    readonly options: BusAttachOptions,
  ) {}

  get disposed(): boolean {
    return this.#disposed;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.instance.board.unregisterBus(this);
  }

  get effects(): BusEffects {
    const owner = this.instance;
    return Object.freeze({
      get time(): number {
        return owner.board.time;
      },
      writeState: (name: string, value: number | boolean): void => owner.busWriteState(name, value),
      writeMemory: (name: string, offset: number, bytes: Uint8Array): void =>
        owner.busWriteMemory(name, offset, bytes),
      emit: (channel: string, value: unknown): void => owner.busEmit(channel, value),
    });
  }

  /** 守卫 2 + 3 + 4：解析两侧绑定并核对；返回唯一合法的对端，否则 undefined。 */
  private pair(): ResolvedPair | undefined {
    const initiator = this.instance;
    const board: InstanceBoard = initiator.board;
    if (this.options.role !== 'initiator') return undefined;
    const mine = this.options.resolve();
    if (mine === undefined) return undefined;
    const keys = profileKeys[this.options.profile];
    let found: ResolvedPair | undefined;
    for (const candidate of board.busEndpoints()) {
      if (candidate === this || candidate.instance === initiator) continue;
      if (candidate.options.role !== 'target') continue;
      if (candidate.options.profile !== this.options.profile) continue;
      const theirs = candidate.options.resolve();
      if (theirs === undefined) continue;
      // 关键项一致：同一组键、同名键值相同。
      let same = true;
      for (const key of keys) {
        const left = mine.config[key];
        const right = theirs.config[key];
        if (
          left === undefined ||
          right === undefined ||
          typeof left !== typeof right ||
          left !== right
        ) {
          same = false;
          break;
        }
      }
      if (!same) continue;
      const groups: { left: readonly string[]; right: readonly string[] }[] = [];
      let layout = true;
      for (const key of Object.keys(mine.pins)) {
        const theirsPins = theirs.pins[key];
        if (theirsPins === undefined) {
          layout = false;
          break;
        }
        const left = pinNames(mine.pins[key]!);
        const right = pinNames(theirsPins);
        if (left.length !== right.length) {
          layout = false;
          break;
        }
        groups.push({ left, right });
      }
      for (const key of Object.keys(theirs.pins))
        if (mine.pins[key] === undefined) {
          layout = false;
          break;
        }
      if (!layout || groups.length === 0) continue;
      if (!this.commitShape(mine)) continue;
      if (!sameNodes(initiator, candidate.instance, groups, board.busTopology())) continue;
      const pins: (readonly [Instance, string])[] = [];
      for (const group of groups) {
        for (const name of group.left) pins.push([initiator, name] as const);
        for (const name of group.right) pins.push([candidate.instance, name] as const);
      }
      if (!noThirdPartySubscribers(initiator, candidate.instance, pins)) continue;
      if (found !== undefined) return undefined; // 多个同构对端：原型不做选择。
      found = { target: candidate, initiatorBinding: mine, targetBinding: theirs };
    }
    return found;
  }

  /** 守卫 5：事务期间的电气叶方案纪元必须保持不变。 */
  private leafEpoch(): number {
    return this.instance.board.busTopology().leafEpoch;
  }

  /** 提交所需配置的静态校验：不合法时整笔事务在交付前就放弃。 */
  private commitShape(binding: BusBinding): boolean {
    const config = binding.config;
    const instance = this.instance;
    for (const key of ['highPin', 'lowPin', 'clockKey']) {
      const name = config[key];
      if (typeof name !== 'string' || !instance.pins.has(name)) return false;
    }
    const resistance = config.resistance;
    if (typeof resistance !== 'number' || !(resistance >= 0.001 && resistance <= 1e9)) return false;
    if (config.clockIdle !== 'low' && config.clockIdle !== 'high') return false;
    if (config.bitOrder !== 'msb-first' && config.bitOrder !== 'lsb-first') return false;
    if (this.options.profile === 'spi') {
      const serialKey = config.serialKey;
      return typeof serialKey === 'string' && instance.pins.has(serialKey);
    }
    const dataKey = config.dataKey;
    if (typeof dataKey !== 'string') return false;
    const pins = binding.pins[dataKey];
    const width = config.width;
    return pins !== undefined && typeof width === 'number' && pinNames(pins).length === width;
  }

  /** 提交末态电平：时钟回到 idle，数据 / 串行数据保持最后一个单位的值。 */
  private commit(binding: BusBinding, tx: Uint8Array, total: number): void {
    const instance = this.instance;
    const config = binding.config;
    const highPin = nonEmpty(config.highPin, 'config.highPin');
    const lowPin = nonEmpty(config.lowPin, 'config.lowPin');
    const resistance = config.resistance;
    if (typeof resistance !== 'number' || !Number.isFinite(resistance))
      throw new TypeError('config.resistance must be a finite number');
    const high = instance.resistorIntent(highPin, resistance);
    const low = instance.resistorIntent(lowPin, resistance);
    const drive = (name: string, level: boolean): void => {
      instance.writeIntent(name, level ? high : low);
    };
    drive(nonEmpty(config.clockKey, 'config.clockKey'), config.clockIdle === 'high');
    if (total === 0) return;
    const last = tx[total - 1]!;
    const msbFirst = config.bitOrder === 'msb-first';
    if (this.options.profile === 'spi') {
      drive(
        nonEmpty(config.serialKey, 'config.serialKey'),
        (msbFirst ? (last >> 7) & 1 : last & 1) === 1,
      );
      return;
    }
    const dataKey = nonEmpty(config.dataKey, 'config.dataKey');
    const pins = pinNames(binding.pins[dataKey]!);
    const width = config.width;
    if (typeof width !== 'number' || pins.length !== width)
      throw new TypeError('config.width must match the data pin group');
    for (let bit = 0; bit < width; bit++) {
      const highBit = msbFirst ? (last >> (width - 1 - bit)) & 1 : (last >> bit) & 1;
      drive(pins[bit]!, highBit === 1);
    }
  }

  transfer(request: BusTransferRequest): boolean {
    if (this.#disposed) throw new TypeError('Bus endpoint is disposed');
    const instance = this.instance;
    const board = instance.board;
    // 守卫 1：只有 throughput 执行模式才允许旁路。
    if (board.execution !== 'throughput') return false;
    // 原型限定：由宿主在 runUntil 窗口之间驱动，执行中不允许改变时间。
    if (board.status !== 'ready' || board.phase !== 'idle') return false;
    const total = request.totalUnits;
    const unit = request.unitDurationPs;
    if (!Number.isSafeInteger(total) || total <= 0)
      throw new RangeError('totalUnits must be a positive safe integer');
    if (!Number.isSafeInteger(unit) || unit < 0)
      throw new RangeError('unitDurationPs must be a non-negative safe integer');
    if ((request.tx === undefined) === (request.fill === undefined))
      throw new TypeError('Provide exactly one of tx or fill');
    let tx: Uint8Array;
    if (request.tx !== undefined) {
      if (!(request.tx instanceof Uint8Array)) throw new TypeError('tx must be a Uint8Array');
      if (request.tx.length < total) throw new RangeError('tx is shorter than totalUnits');
      tx = request.tx.length === total ? request.tx : request.tx.subarray(0, total);
    } else {
      const buffer = new Uint8Array(total);
      request.fill!(buffer);
      tx = buffer;
    }
    const pair = this.pair();
    if (pair === undefined) return false;
    const duration = total * unit;
    if (!Number.isSafeInteger(duration)) return false;
    const epoch = this.leafEpoch();
    // 时间切片：horizon 取「本窗口结束」与「下一个到期事件」的较小者，
    // 交付后按 k * unitDurationPs 推进，绝不跨 executionEnd，也不跨到期事件。
    const horizon = Math.min(board.events.time, board.busHorizon());
    if (horizon - board.time < duration) return false;
    let delivered = 0;
    while (delivered < total) {
      const remaining = total - delivered;
      const available = horizon - board.time;
      const k = Math.min(remaining, unit === 0 ? remaining : Math.floor(available / unit));
      if (k <= 0) return false;
      const startTimePs = board.time;
      const endTimePs = startTimePs + k * unit;
      const slice: BusSlice = Object.freeze({
        count: k,
        tx: tx.subarray(delivered, delivered + k),
        startTimePs,
        endTimePs,
      });
      pair.targetBinding.onSlice?.(slice);
      board.busAdvance(endTimePs);
      delivered += k;
      if (this.leafEpoch() !== epoch) return false;
    }
    this.commit(pair.initiatorBinding, tx, total);
    return true;
  }
}

/** PROTOTYPE: 为器件上下文创建一个传输端点。 */
export function attachBus(instance: Instance, options: BusAttachOptions): BusEndpoint {
  if (options === null || typeof options !== 'object')
    throw new TypeError('attachBus options must be an object');
  const profile = options.profile;
  if (profile !== 'spi' && profile !== 'parallel-sync')
    throw new RangeError('Unsupported bus profile');
  const role = options.role;
  if (role !== 'initiator' && role !== 'target')
    throw new RangeError('Bus role must be initiator or target');
  if (typeof options.resolve !== 'function') throw new TypeError('resolve must be a function');
  instance.assertCallAllowed();
  if (instance.board.phase !== 'initialize')
    throw new TypeError('attachBus is initialization-only');
  const endpoint = new PrototypeBusEndpoint(
    instance,
    Object.freeze({ profile, role, resolve: options.resolve }),
  );
  instance.resources.push(endpoint);
  instance.board.registerBus(endpoint);
  return endpoint.endpoint;
}
