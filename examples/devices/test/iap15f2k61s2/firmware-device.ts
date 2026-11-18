import { firmwareImage } from '../support/legacy-model-bridge.mjs';
import { loadSourceDevice, type DeviceModule } from '../harness.ts';

/**
 * 为 CT107D 共享测试夹具准备 IAP 器件：板属性只保留 DDL 的 `clockFrequency`，固件在
 * 工厂闭包里转换成真实 `FirmwareImage` 后作为完整 resolved props 注入模型上下文。
 *
 * 共享 `test/harness.ts` 的旧板边界只能传普通 IR 属性，不能携带复合 `FirmwareImage`；
 * 这里不修改共享夹具，也不把 `Uint8Array` 塞进 `BoardDescription.props`。
 */

interface DeviceContextShape {
  readonly events: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

function contextOf(value: unknown): DeviceContextShape {
  if (value === null || typeof value !== 'object')
    throw new Error('Missing IAP factory context');

  const record = value as Record<string, unknown>;

  if (record.events === null || typeof record.events !== 'object')
    throw new Error('Missing model event outlets');

  return value as DeviceContextShape;
}

export async function iapDeviceWithFirmware(
  firmware: Uint8Array,
  clockFrequency = 1_000_000,
): Promise<DeviceModule> {
  const device = await loadSourceDevice('iap15f2k61s2');
  const image = firmwareImage([
    { addressSpace: 'code', address: 0, data: new Uint8Array(firmware) },
  ]);

  return {
    ...device,
    create(context) {
      const resolved = contextOf(context);

      return device.create({
        ...resolved,
        props: { clockFrequency, firmware: image },
        events: resolved.events,
      });
    },
  };
}
