/**
 * 旧 `createBoard` 的显式引擎兼容边界。
 *
 * 统一器件包只发布 `package.json`、`model.js`（以及可选的 headless 视图资源）。本文件
 * 不投影旧 `DeviceMetadata`、不生成旧符号，也不服务编辑器；它只把统一工厂接到旧
 * simulator：完整属性（含 `FirmwareImage`）、统一事件到旧话题、旧输入话题到统一方法。
 *
 * 旧 `.sch v1` / `.cnv v1` 不是 RFC 0024/0025 文档，本文件不提供文档迁移。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { adaptModelFactory, firmwareImage } from '@mica-js/sdk/device';

/** 旧画布使用的输入端口名 -> 统一模型方法名。 */
const INPUT_ALIASES = {
  jumper: { control: 'setClosed' },
  'jumper-2x3': { control2: 'selectVs1838' },
};

/** 旧话题事件到统一事件的显式映射；未列出的设备按 `onDidXxx` 推导。 */
const LEGACY_EVENTS = {
  seg4: {
    onDidDisplayChange: { topic: 'displayChange' },
  },
  iap15f2k61s2: {
    onDidUart1Tx: {
      topic: 'uart1Tx',
      transform: (value) => value?.data?.slice?.() ?? new Uint8Array(0),
    },
    onDidUart1Rx: {
      topic: 'uart1Rx',
      transform: (value) => value?.data?.slice?.() ?? new Uint8Array(0),
    },
  },
};

/** 由统一事件名导出旧话题名：`onDidLatch` -> `latch`。 */
export function eventTopic(name) {
  return name.slice(5, 6).toLowerCase() + name.slice(6);
}

/** 旧画布输入端口名到统一模型方法的显式映射。 */
export function legacyInputs(manifest) {
  const inputs = {};
  const aliases = INPUT_ALIASES[manifest.name] ?? {};
  for (const [name, method] of Object.entries(manifest.model?.methods ?? {})) {
    const params = method?.params;
    if (params === null || params === undefined || params.type === 'null') continue;
    const port = Object.entries(aliases).find(([, target]) => target === name)?.[0] ?? name;
    inputs[port] = name;
  }
  return inputs;
}

/** 旧板只接受字节属性；统一模型需要 FirmwareImage，按清单默认空间包装。 */
export function firmwareProperties(manifest) {
  return Object.entries(manifest.properties ?? {}).filter(
    ([, property]) => property?.type === 'firmware',
  );
}

function adaptProps(manifest) {
  const firmware = firmwareProperties(manifest);
  if (firmware.length === 0) return undefined;
  return (context) => {
    const props = { ...context.props };
    for (const [name, property] of firmware) {
      const value = props[name];
      if (!(value instanceof Uint8Array)) continue;
      props[name] = firmwareImage([
        {
          addressSpace: property.addressSpace,
          address: property.loadAddress,
          data: value,
        },
      ]);
    }
    return props;
  };
}

/**
 * Loads one unified package for a legacy simulator consumer.
 *
 * @param {string} root Directory containing `<id>/package.json` packages.
 * @param {string} id Package directory name.
 */
export async function loadLegacyDevice(root, id) {
  const directory = join(root, id);
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const module = await import(pathToFileURL(join(directory, 'model.js')).href);
  const events =
    LEGACY_EVENTS[manifest.name] ??
    Object.fromEntries(
      Object.keys(manifest.model?.events ?? {}).map((name) => [name, eventTopic(name)]),
    );
  const props = adaptProps(manifest);
  const adapted = adaptModelFactory(module.create, {
    events,
    inputs: legacyInputs(manifest),
    ...(props === undefined ? {} : { props }),
  });
  const create =
    manifest.name === 'seg4'
      ? (context) =>
          adapted({
            ...context,
            topics: {
              ...context.topics,
              publish(topic, payload) {
                if (topic !== 'displayChange' || payload === null || typeof payload !== 'object') {
                  context.topics.publish(topic, payload);
                  return;
                }
                for (const digit of ['digit1', 'digit2', 'digit3', 'digit4'])
                  if (typeof payload[digit] === 'number')
                    context.topics.publish(digit, payload[digit]);
              },
            },
          })
      : adapted;
  return {
    manifest,
    module: { ...module, create },
  };
}

/**
 * Wraps a loaded package factory with a resolved firmware image for legacy boards whose
 * instance props are validated against the DDL and therefore cannot carry `firmware`.
 */
export function legacyCreateWithFirmware(device, bytes) {
  const [name, property] = firmwareProperties(device.manifest)[0] ?? [];
  if (name === undefined || property === undefined) return device.module.create;
  const image = firmwareImage([
    {
      addressSpace: property.addressSpace,
      address: property.loadAddress,
      data: bytes,
    },
  ]);
  return (context) =>
    device.module.create({
      ...context,
      props: { ...context.props, [name]: image },
    });
}
