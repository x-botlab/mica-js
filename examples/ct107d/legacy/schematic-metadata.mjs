/**
 * `ct107d.sch v1` / `ct107d.cnv v1` 校验用的最小器件投影。
 *
 * 统一器件包只发布清单与 `model.js`，不发布旧 `symbol` / `ports`。旧原理图需要引脚锚点
 * 才能折网表、旧画布需要端口方向与载荷类型才能校验绑定，因此本文件按清单推导这两项：
 * 符号由引脚集合合成，端口按 `model.methods` / `model.events` 与设备桥的旧话题映射推导。
 *
 * 它只服务 `build-schematic.mjs` / `verify-schematic.mjs` / `verify-canvas.mjs`，
 * 不进入仿真运行时，也不把推导结果伪装成统一包的新格式。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { synthesizeDeviceSymbol } from '@mica-js/document/schematic';

/** 旧画布输入端口名 -> 统一模型方法名，与 `device-package.mjs` 的桥保持一致。 */
const INPUT_ALIASES = {
  jumper: { control: 'setClosed' },
  'jumper-2x3': { control2: 'selectVs1838' },
};

/** 旧画布订阅的 `seg4` 四位端口；统一模型只发整份显示快照。 */
const DISPLAY_DIGITS = ['digit1', 'digit2', 'digit3', 'digit4'];

/** 旧画布只认识这些原子载荷类型。 */
const PAYLOAD_TYPES = new Set([
  'boolean',
  'number',
  'string',
  'vec2d',
  'vec3d',
  'bytes',
  'bytes<rgb565>',
  'bytes<segments>',
]);

/** 统一 IR 的 `binary` 在旧画布端口里叫 `bytes`。 */
const PAYLOAD_TYPE_ALIASES = { binary: 'bytes' };

/** 由统一事件名导出旧话题名：`onDidLatch` -> `latch`。 */
export const eventTopic = (name) => name.slice(5, 6).toLowerCase() + name.slice(6);

/**
 * 读取器件库构建产物 `<root>/dist/<id>/`。
 *
 * @param {string} root 器件库根目录（`examples/devices`）。
 * @param {string} id 器件目录名，也是清单的 `name`。
 * @returns {{ directory: string, manifest: any }}
 */
export function loadDevicePackage(root, id) {
  const directory = join(root, 'dist', id);
  const path = join(directory, 'package.json');
  if (!existsSync(path)) {
    throw new Error(`缺少器件包 ${path}：先运行 pnpm --filter @mica-js/example-devices build`);
  }
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest.name !== id) {
    throw new Error(`器件包 ${path} 的 name ${manifest.name} 与目录 ${id} 不一致`);
  }
  return { directory, manifest };
}

/**
 * 按清单引脚集合合成旧原理图符号。
 *
 * 统一包不声明 body 尺寸与引脚位置，`synthesizeDeviceSymbol` 会按引脚数生成矩形本体，
 * 所有引脚落在左侧。旧 `.sch` 的布局与连线段因此可重复生成，但不再逐引脚标注原名。
 *
 * @param {any} manifest 统一器件清单。
 */
export function legacyDeviceSymbol(manifest) {
  const pins = Object.keys(manifest.pins ?? {});
  if (pins.length === 0) throw new Error(`器件 ${manifest.name} 未声明引脚`);
  return synthesizeDeviceSymbol({
    name: manifest.displayName,
    pins: Object.fromEntries(pins.map((pin) => [pin, {}])),
  });
}

/**
 * 把统一端口声明解析成旧画布的原子载荷类型；对象载荷与查询方法没有旧端口。
 *
 * @param {{ type?: string, ref?: string } | undefined} declaration
 * @param {Record<string, { type?: string }> | undefined} types
 */
function payloadType(declaration, types) {
  const direct = declaration?.type;
  const resolved = declaration?.ref === undefined ? undefined : types?.[declaration.ref]?.type;
  for (const candidate of [direct, resolved]) {
    const type = PAYLOAD_TYPE_ALIASES[candidate];
    if (type !== undefined) return type;
    if (typeof candidate === 'string' && PAYLOAD_TYPES.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * 推导旧画布校验用的端口表。
 *
 * - 输出：`model.events` 的 `onDidXxx` 映射到旧话题 `xxx`；
 * - 输入：`model.methods` 中带非空参数的方法按旧端口别名映射，查询方法（`null` 参数）
 *   不是端口；
 * - `seg4` 沿用设备桥的展开规则：整份显示快照拆成 `digit1`–`digit4` 四个输出。
 *
 * @param {any} manifest 统一器件清单。
 * @returns {Record<string, { direction: 'input' | 'output', type: string }>}
 */
export function legacyDevicePorts(manifest) {
  const ports = {};
  const types = manifest.model?.types;
  for (const [name, event] of Object.entries(manifest.model?.events ?? {})) {
    const type = payloadType(event, types);
    if (type !== undefined) ports[eventTopic(name)] = { direction: 'output', type };
  }
  if (manifest.name === 'seg4') {
    for (const digit of DISPLAY_DIGITS) ports[digit] = { direction: 'output', type: 'number' };
  }
  const aliases = INPUT_ALIASES[manifest.name] ?? {};
  for (const [name, method] of Object.entries(manifest.model?.methods ?? {})) {
    const type = payloadType(method?.params, types);
    if (type === undefined) continue;
    const port = Object.entries(aliases).find(([, target]) => target === name)?.[0] ?? name;
    ports[port] = { direction: 'input', type };
  }
  return ports;
}
