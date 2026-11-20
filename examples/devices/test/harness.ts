import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { DeviceLibraryEntry } from '@mica-js/sdk';
import { compileDDL } from '@mica-js/sdk/ddl';
import type { DeviceIR } from '@mica-js/sdk/model';

/**
 * 统一器件库测试夹具。
 *
 * 每个器件是一个独立开发项目：清单在 `<id>/package.json`，模型在
 * `<id>/src/model.ddl`，工厂具名导出 `create` 于 `<id>/src/index.ts`。本轮只验证
 * 仿真内核与模型/清单合同；夹具按新接口注入 `props` / `inputs` / `events`，不向适配器
 * 提供 `topics`。测试读取的 `topics` 只是把新事件按旧字段名归档，确保适配器事件真的
 * 被执行。
 *
 * 电气求解、通道、执行引擎仍走真实的 `@mica-js/simulator` 板。辅助器件只有线性电阻、
 * 电平探针和数字源，与被测器件无关。
 */

const PACKAGE_DIR = join(import.meta.dirname, '..');
const DEVICE_ROOT = PACKAGE_DIR;

export interface ManifestPin {
  readonly label?: string;
  readonly description?: string;
}

export interface ManifestProperty {
  readonly type: string;
  readonly default?: unknown;
  readonly title?: string;
  readonly description?: string;
  readonly nullable?: boolean;
  readonly [key: string]: unknown;
}

export interface ManifestEventType {
  readonly type?: string;
  readonly ref?: string;
}

export interface ManifestMethod {
  readonly params: unknown;
  readonly returns: unknown;
}

/**
 * 测试只读取清单中的必要字段；完整结构、类型和几何合法性由 SDK 的 `mica prepare`
 * 校验，测试不维护第二套合同。
 */
export interface Manifest {
  readonly publisher: string;
  readonly name: string;
  readonly version: string;
  readonly engines: { readonly mica: string };
  readonly displayName: string;
  readonly description?: string;
  readonly designatorPrefix?: string;
  readonly properties?: Readonly<Record<string, ManifestProperty>>;
  readonly pins?: Readonly<Record<string, ManifestPin>>;
  readonly model: {
    readonly entry: string;
    readonly types: Readonly<Record<string, unknown>>;
    readonly methods: Readonly<Record<string, ManifestMethod>>;
    readonly events: Readonly<Record<string, ManifestEventType>>;
  };
}

export interface Message {
  readonly value: unknown;
}

export interface Adapter {
  readonly methods?: Readonly<Record<string, (params: unknown) => unknown>>;
  sync(batch: { readonly outputs: Readonly<Record<string, readonly Message[]>> }): void;
  dispose(): void;
}

export interface DeviceModule {
  readonly model: DeviceIR;
  readonly create: (context: unknown) => Adapter;
  readonly manifest: Manifest;
}

const modules = new Map<string, Promise<DeviceModule>>();

/** 装载 `<id>/`：编译 DDL、读取清单并导入具名 `create` 工厂，按 id 缓存。 */
export function loadSourceDevice(id: string): Promise<DeviceModule> {
  const cached = modules.get(id);

  if (cached !== undefined) return cached;

  const directory = join(DEVICE_ROOT, id);
  const loaded = (async (): Promise<DeviceModule> => {
    const [manifest, model, source] = await Promise.all([
      readMetadata(id),
      compileDDL(readFileSync(join(directory, 'src', 'model.ddl'), 'utf8'), {
        uri: `mica:devices/${id}/model.ddl`,
      }),
      import(pathToFileURL(join(directory, 'src', 'index.ts')).href) as Promise<{
        create: (context: unknown) => Adapter;
      }>,
    ]);
    if (typeof source.create !== 'function') throw new Error(`${id}: missing named create export`);

    return { model, create: source.create, manifest };
  })();

  modules.set(id, loaded);

  return loaded;
}

/**
 * 读取 `<id>/package.json`。完整清单和类型/属性/引脚一致性由 SDK 的 `mica prepare`
 * （聚合 build/typecheck 的前置步骤）作为权威校验；测试只断必要不变量。
 */
export function readMetadata(id: string): Manifest {
  return JSON.parse(readFileSync(join(DEVICE_ROOT, id, 'package.json'), 'utf8')) as Manifest;
}

/**
 * 旧测试断言的 topic 字段名到新事件的显式映射。
 *
 * 这里不按事件名猜话题：每个器件、每个事件都必须明确列出；未列出的新事件只出现在
 * `board.events`，不会伪造 `board.topics` 字段。新业务代码直接订阅 `onDidXxx`。
 */
type LegacyTopic =
  string | { readonly topic: string; readonly transform?: (value: unknown) => unknown };

export const LEGACY_EVENT_TOPICS: Readonly<Record<string, Readonly<Record<string, LegacyTopic>>>> =
  {
    '74hc138': { onDidSelect: 'select', onDidEnabled: 'enabled', onDidCode: 'code' },
    '74hc573': { onDidLatch: 'latch' },
    at24c02: { onDidDump: 'dump' },
    'blue-led': {
      onDidBrightness: 'brightness',
      onDidCurrent: 'current',
      onDidVoltage: 'voltage',
    },
    buzzer: { onDidActive: 'active' },
    cx20106a: { onDidReceiving: 'receiving' },
    ds1302: { onDidDatetime: 'datetime', onDidRunning: 'running' },
    ds18b20: { onDidTemperatureOut: 'temperatureOut' },
    jumper: { onDidClosedState: 'closedState' },
    'jumper-2x3': { onDidClosedState2: 'closedState2' },
    lm386: { onDidActive: 'active' },
    ne555: { onDidFrequency: 'frequency', onDidDutyCycle: 'dutyCycle' },
    pcf8591: { onDidAout: 'aout', onDidChannel: 'channel' },
    'push-button': { onDidPress: 'press' },
    relay: { onDidEnergized: 'energized' },
    'uart-probe': { onDidTx: 'tx', onDidRx: 'rx' },
    uln2003: { onDidMask: 'mask', onDidChannels: 'channels' },
    vs1838: { onDidReceiving: 'receiving' },
    iap15f2k61s2: {
      onDidUart1Tx: { topic: 'uart1Tx', transform: serialBytes },
      onDidUart1Rx: { topic: 'uart1Rx', transform: serialBytes },
    },
  };

interface RuntimeContext {
  readonly props: Readonly<Record<string, unknown>>;
  readonly inputs: Record<string, { send(value: unknown): void }>;
  readonly memory: Record<string, unknown>;
  readonly topics: {
    publish(topic: string, payload: unknown): void;
    onDidReceive?(listener: (message: { topic: string; payload: unknown }) => void): {
      dispose(): void;
    };
  };
  reportError(error: unknown): void;
  attachJit(options: unknown): { dispose(): void };
  loadBytes(name: string, bytes: Uint8Array, offset?: number): void;
}

interface EventSink {
  readonly api: Record<
    string,
    { fire(value: unknown): void; fireTransferred(value: unknown): void }
  >;
  readonly topics: Record<string, unknown>;
  readonly history: Record<string, unknown[]>;
  readonly log: { name: string; value: unknown }[];
}

function serialBytes(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || !('data' in value)) return value;
  return (value as { readonly data: unknown }).data;
}

function createEventSink(
  eventNames: readonly string[],
  topicNames: Readonly<Record<string, LegacyTopic>>,
): EventSink {
  const topics: Record<string, unknown> = {};
  const history: Record<string, unknown[]> = {};
  const log: { name: string; value: unknown }[] = [];
  const emitters: Record<
    string,
    { fire(value: unknown): void; fireTransferred(value: unknown): void }
  > = {};
  const record = (name: string, value: unknown): void => {
    const mapping = topicNames[name];
    if (mapping !== undefined) {
      const topic = typeof mapping === 'string' ? mapping : mapping.topic;
      const payload =
        typeof mapping === 'string' || mapping.transform === undefined
          ? value
          : mapping.transform(value);
      topics[topic] = payload;
      (history[topic] ??= []).push(payload);
    }
    log.push({ name, value });
  };
  for (const name of eventNames) {
    emitters[name] = Object.freeze({
      fire(value: unknown) {
        record(name, value);
      },
      fireTransferred(value: unknown) {
        record(name, value);
      },
    });
  }
  for (const name of Object.keys(topicNames)) {
    if (!eventNames.includes(name)) throw new Error(`旧 topic 映射引用了清单未声明的事件：${name}`);
  }
  const api = new Proxy(emitters, {
    get(target, key) {
      if (typeof key === 'string' && !Object.hasOwn(target, key))
        throw new Error(`事件 ${key} 未在清单 model.events 中声明`);
      return Reflect.get(target, key);
    },
  }) as EventSink['api'];

  return { api, topics, history, log };
}

/** 板上的一颗真实器件：`id` 是实例名，`type` 是 `<id>/` 目录名。 */
export interface DeviceInstance {
  readonly id: string;
  readonly type: string;
  readonly device?: DeviceModule;
  readonly props?: Readonly<Record<string, unknown>>;
}

export interface PinRef {
  readonly instance: string;
  readonly pin: string;
}

export interface NetDescription {
  readonly id: string;
  readonly voltage?: number;
  readonly pins: readonly PinRef[];
}

export interface ResistorInstance {
  readonly id: string;
  readonly resistance: number;
}

export interface BoardOptions {
  readonly props?: Readonly<Record<string, unknown>>;
  readonly resistors?: readonly ResistorInstance[];
  readonly probes?: readonly string[];
  readonly sources?: readonly string[];
  readonly nets: readonly NetDescription[];
}

export interface TestBoard {
  /** 新事件按旧字段名归档后的最后一条负载；适配器必须真的发出事件才会出现。 */
  readonly topics: Readonly<Record<string, unknown>>;
  /** 每个事件字段的完整事件顺序。 */
  readonly history: Readonly<Record<string, readonly unknown[]>>;
  /** 适配器事件完整日志，保留 `onDidXxx` 名称。 */
  readonly events: readonly { readonly name: string; readonly value: unknown }[];
  /** DDL 输出通道批次里的最后一条负载，用于验证模型原始输出。 */
  readonly outputs: Readonly<Record<string, unknown>>;
  probe(id: string): number;
  /** 向测试辅助器件投递通道值，或调用真实器件的公共方法。 */
  send(instance: string, method: string, value: unknown): void;
  /** 仅用于测试期注入 DDL 输入通道；不经过真实器件的公共方法。 */
  injectInput(instance: string, channel: string, value: unknown): void;
  /** 同步调用真实器件的公共方法；适配器方法按合同同步执行。 */
  call(instance: string, method: string, params?: unknown): unknown;
  /** 调用真实器件的公共查询方法。 */
  query(instance: string, method: string, params?: unknown): Promise<unknown>;
  run(durationPs: number): void;
  runUntil(timePs: number): void;
  readonly time: number;
  readonly faults: readonly string[];
  dispose(): void;
}

const resistorModels = new Map<number, Promise<DeviceIR>>();

export function resistorModel(resistance: number): Promise<DeviceIR> {
  const cached = resistorModels.get(resistance);
  if (cached !== undefined) return cached;

  const model = compileDDL(
    `device TestResistor(resistance: number default ${resistance}) {
       assert resistance >= 0.001 && resistance <= 1_000_000_000;
       pin a = [resistor(to: b, resistance: resistance)];
       pin b;
     }`,
  );
  resistorModels.set(resistance, model);
  return model;
}

let probeCache: Promise<DeviceIR> | undefined;

export function probeModel(): Promise<DeviceIR> {
  probeCache ??= compileDDL(
    `device TestProbe {
       pin y(low: 1.5, high: 3.5);
       output channel level: number(capacity: 8, overflow: Overflow.drop_oldest);
       pure fn code(sampled: Logic) -> number {
         if sampled == Logic.high {
           return 1;
         } else if sampled == Logic.low {
           return 0;
         }
         return 2;
       }
       derived current: number = code(y.sample.level);
       process start {
         level.send(current);
       }
       process changed on current {
         level.send(current);
       }
     }`,
  );
  return probeCache;
}

let sourceCache: Promise<DeviceIR> | undefined;

export function sourceModel(): Promise<DeviceIR> {
  sourceCache ??= compileDDL(
    `device TestSource(outputResistance: number default 25) {
       pin y;
       pin vcc;
       pin gnd;
       input channel level: number(capacity: 8, overflow: Overflow.drop_oldest);
       state wanted: number = 2;
       fn apply() {
         if wanted == 1 {
           y.intent <- [resistor(to: vcc, resistance: outputResistance)];
         } else if wanted == 0 {
           y.intent <- [resistor(to: gnd, resistance: outputResistance)];
         } else {
           y.intent <- [];
         }
       }
       process start {
         apply();
         loop {
           wanted = await level.receive();
           apply();
         }
       }
     }`,
  );
  return sourceCache;
}

/**
 * 建立一块多器件板。每颗真实器件先创建新接口适配器，再把事件记录器注入上下文；
 * 旧 `topics` 不进入适配器，避免交互测试绕过新方法/新事件。
 */
export async function createBoardWith(
  devices: readonly DeviceInstance[],
  options: BoardOptions,
): Promise<TestBoard> {
  const topics: Record<string, unknown> = {};
  const history: Record<string, unknown[]> = {};
  const eventLog: { name: string; value: unknown }[] = [];
  const outputs: Record<string, unknown> = {};
  const inputs: Record<string, Record<string, { send(value: unknown): void }>> = {};
  const methodsByInstance: Record<string, Adapter['methods']> = {};
  const levels: Record<string, number> = {};
  const faults: string[] = [];
  const realTypes = new Set<string>();

  const instrument = (
    instanceId: string,
    factory: (context: unknown) => Adapter,
    eventNames: readonly string[],
    topicNames: Readonly<Record<string, LegacyTopic>>,
  ) => {
    return (simulatorContext: RuntimeContext) => {
      inputs[instanceId] = simulatorContext.inputs;
      const sink = createEventSink(eventNames, topicNames);
      const capabilities: Record<string, unknown> = { ...simulatorContext };
      delete capabilities.topics;
      const adapter = factory({ ...capabilities, events: sink.api });
      methodsByInstance[instanceId] = adapter.methods ?? {};

      return {
        sync(batch: { readonly outputs: Readonly<Record<string, readonly Message[]>> }) {
          adapter.sync(batch);
          for (const [name, messages] of Object.entries(batch.outputs)) {
            const latest = messages[messages.length - 1];
            if (latest === undefined) continue;
            if (name === 'level' && instanceId !== 'dut')
              levels[instanceId] = latest.value as number;
            else if (instanceId === 'dut') outputs[name] = latest.value;
            else outputs[`${instanceId}.${name}`] = latest.value;
          }
          for (const [name, value] of Object.entries(sink.topics)) topics[name] = value;
          for (const [name, values] of Object.entries(sink.history))
            (history[name] ??= []).push(...values);
          eventLog.push(...sink.log);
          sink.log.length = 0;
          for (const name of Object.keys(sink.history)) delete sink.history[name];
          for (const name of Object.keys(sink.topics)) delete sink.topics[name];
        },
        dispose: () => adapter.dispose(),
      };
    };
  };

  const entries: DeviceLibraryEntry[] = [];
  const instances: { id: string; type: string; props?: Readonly<Record<string, unknown>> }[] = [];
  const idle = () => ({ sync() {}, dispose() {} });
  const used = new Set<string>();

  for (const instance of devices) {
    if (used.has(instance.id)) throw new Error(`实例名重复：${instance.id}`);
    used.add(instance.id);
    const device = instance.device ?? (await loadSourceDevice(instance.type));
    realTypes.add(instance.id);
    entries.push({
      id: instance.id,
      model: device.model,
      create: instrument(
        instance.id,
        device.create,
        Object.keys(device.manifest.model.events),
        LEGACY_EVENT_TOPICS[device.manifest.name] ?? {},
      ) as unknown as DeviceLibraryEntry['create'],
    });
    instances.push({ id: instance.id, type: instance.id, props: instance.props ?? {} });
  }

  for (const resistor of options.resistors ?? []) {
    entries.push({
      id: resistor.id,
      model: await resistorModel(resistor.resistance),
      create: (() => idle()) as unknown as DeviceLibraryEntry['create'],
    });
    instances.push({ id: resistor.id, type: resistor.id });
  }

  if ((options.probes ?? []).length > 0) {
    const model = await probeModel();
    for (const probe of options.probes ?? []) {
      entries.push({
        id: probe,
        model,
        create: instrument(
          probe,
          () => idle() as Adapter,
          [],
          {},
        ) as unknown as DeviceLibraryEntry['create'],
      });
      instances.push({ id: probe, type: probe });
    }
  }

  if ((options.sources ?? []).length > 0) {
    const model = await sourceModel();
    for (const source of options.sources ?? []) {
      entries.push({
        id: source,
        model,
        create: instrument(
          source,
          () => idle() as Adapter,
          [],
          {},
        ) as unknown as DeviceLibraryEntry['create'],
      });
      instances.push({ id: source, type: source });
    }
  }

  const library = createDeviceLibrary(entries);
  const board = createBoard(library, {
    instances: instances as never,
    nets: options.nets.map((net) => ({ ...net })),
  });
  const subscription = board.onDidError((event) => faults.push(event.message));

  return {
    topics,
    history,
    events: eventLog,
    outputs,
    probe(probeId) {
      const level = levels[probeId];
      if (level === undefined) throw new Error(`探针还没有读数：${probeId}`);
      return level;
    },
    send(instance, method, value) {
      if (!realTypes.has(instance)) {
        const target = inputs[instance]?.[method];
        if (target === undefined) throw new Error(`未知输入通道：${instance}.${method}`);
        target.send(value);
        return;
      }
      const target = methodsByInstance[instance]?.[method];
      if (target === undefined) throw new Error(`未知公共方法：${instance}.${method}`);
      target(value);
    },
    injectInput(instance, channel, value) {
      const target = inputs[instance]?.[channel];
      if (target === undefined) throw new Error(`未知输入通道：${instance}.${channel}`);
      target.send(value);
    },
    call(instance, method, params = null) {
      if (!realTypes.has(instance)) throw new Error(`不是真实器件：${instance}`);
      const target = methodsByInstance[instance]?.[method];
      if (target === undefined) throw new Error(`未知公共方法：${instance}.${method}`);
      return target(params);
    },
    async query(instance, method, params = null) {
      if (!realTypes.has(instance)) throw new Error(`不是真实器件：${instance}`);
      const target = methodsByInstance[instance]?.[method];
      if (target === undefined) throw new Error(`未知公共方法：${instance}.${method}`);
      return await target(params);
    },
    run: (durationPs) => board.runUntil(board.time + durationPs),
    runUntil: (timePs) => board.runUntil(timePs),
    get time() {
      return board.time;
    },
    faults,
    dispose() {
      subscription.dispose();
      board.dispose();
    },
  };
}

export function createTestBoard(id: string, options: BoardOptions): Promise<TestBoard> {
  return createBoardWith(
    [
      {
        id: 'dut',
        type: id,
        ...(options.props === undefined ? {} : { props: options.props }),
      },
    ],
    options,
  );
}

export const US = 1_000_000;
export const MS = 1_000_000_000;
