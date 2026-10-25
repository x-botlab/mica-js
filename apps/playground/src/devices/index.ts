import type { DeviceDefinition } from '@mica-js/device';
import { parseDeviceDescription } from '@mica-js/device';
import type { DeviceDescription, SchematicDeviceBinding } from '@mica-js/simulator';
import { ADC_MODULE_DEVICE, ADC_MODULE_PACKAGE, createAdcModuleDescription } from './adc-module';
import { DAC_MODULE_DEVICE, DAC_MODULE_PACKAGE, createDacModuleDescription } from './dac-module';
import { I2C_EEPROM_DEVICE, I2C_EEPROM_PACKAGE, createI2cEepromDescription } from './i2c-eeprom';
import { I2C_MASTER_DEVICE, I2C_MASTER_PACKAGE, createI2cMasterDescription } from './i2c-master';
import { INDICATOR_DEVICE, INDICATOR_PACKAGE, createIndicatorDescription } from './indicator';
import { LED_MATRIX_DEVICE, LED_MATRIX_PACKAGE, createLedMatrixDescription } from './led-matrix';
import { POT_MODULE_DEVICE, POT_MODULE_PACKAGE, createPotModuleDescription } from './pot-module';
import { POWER_LOAD_DEVICE, POWER_LOAD_PACKAGE, createPowerLoadDescription } from './power-load';
import {
  SHIFT_REGISTER_DEVICE,
  SHIFT_REGISTER_PACKAGE,
  createShiftRegisterDescription,
} from './shift-register';
import {
  SERIAL_CONSOLE_DEVICE,
  SERIAL_CONSOLE_PACKAGE,
  createSerialConsoleDescription,
} from './serial-console';

/**
 * Playground-only peripheral parts.
 *
 * None of these live in a published package: they exist to demonstrate the RFC
 * surface (`pin.sampleAnalog`, `pin.writeAnalog`, pin groups, open-drain plus
 * weak pull-up, power domains) on top of the teaching MCU, and they are small
 * enough to read in one sitting. A real product would ship them from a device
 * package with the same two halves:
 *
 * - `package` — the description `@mica-js/device` parses: pins with their drawn
 *   side, pin groups, topic ports. The schematic compiler derives symbol
 *   geometry from it.
 * - `create()` — the unified-IR description the electrical compiler runs.
 */

export interface PlaygroundDevice {
  /** `<package>:<device>` reference used by `.sch` documents. */
  readonly id: string;
  /** Device id after the package prefix. */
  readonly deviceId: string;
  readonly displayName: string;
  readonly description: string;
  /** `@mica-js/device` description: pins, groups, ports. */
  readonly package: Readonly<Record<string, unknown>>;
  /** Unified-IR description with the electrical behaviour. */
  readonly create: () => DeviceDescription;
}

function define(
  id: string,
  displayName: string,
  description: string,
  packageDescription: Readonly<Record<string, unknown>>,
  create: () => DeviceDescription,
): PlaygroundDevice {
  return Object.freeze({
    id,
    deviceId: id.slice(id.indexOf(':') + 1),
    displayName,
    description,
    package: packageDescription,
    create,
  });
}

/** Every part this bench ships, in the order the device catalogue shows them. */
export const PLAYGROUND_DEVICES: readonly PlaygroundDevice[] = Object.freeze([
  define(
    ADC_MODULE_DEVICE,
    'ADC 模块',
    '四通道 SPI ADC：tick 里用 pin.sampleAnalog 读 AIN0–AIN3 的电压，结果通过 ch0–ch3 发布。',
    ADC_MODULE_PACKAGE,
    createAdcModuleDescription,
  ),
  define(
    DAC_MODULE_DEVICE,
    'DAC 模块',
    '双通道 SPI DAC：用 pin.writeAnalog 把电压意图写到 VOUT0/VOUT1，由解网仲裁。',
    DAC_MODULE_PACKAGE,
    createDacModuleDescription,
  ),
  define(
    POT_MODULE_DEVICE,
    '电位器',
    '滑臂电压由 voltage 主题设置，用 pin.writeAnalog 驱动 WIPER；接在 ADC 的模拟输入上。',
    POT_MODULE_PACKAGE,
    createPotModuleDescription,
  ),
  define(
    I2C_EEPROM_DEVICE,
    'I²C EEPROM',
    '0x50 的 256 B EEPROM：SCL/SDA 开漏 + 弱上拉，时钟沿组装字节，ACK 时拉低 SDA。',
    I2C_EEPROM_PACKAGE,
    createI2cEepromDescription,
  ),
  define(
    I2C_MASTER_DEVICE,
    'I²C 主机（开漏侧）',
    '总线上另一个开漏驱动：默认释放两线，用 sda/scl 端点拉低，演示线与（wired-AND）。',
    I2C_MASTER_PACKAGE,
    createI2cMasterDescription,
  ),
  define(
    LED_MATRIX_DEVICE,
    '8×8 LED 矩阵',
    '行扫描矩阵：用 pinGroup 批量读取 ROW0–ROW7 与 D0–D7，锁存一帧后按 (row, data) 发布。',
    LED_MATRIX_PACKAGE,
    createLedMatrixDescription,
  ),
  define(
    SHIFT_REGISTER_DEVICE,
    '74HC595 移位寄存器',
    '串入并出：pinGroup 一次写入 Q0–Q7，再批量读回解网后的电平。',
    SHIFT_REGISTER_PACKAGE,
    createShiftRegisterDescription,
  ),
  define(
    POWER_LOAD_DEVICE,
    '受电门控缓冲器',
    '声明 powerDomains 的负载：域断电时驱动释放、采样归零、阶段跳过。',
    POWER_LOAD_PACKAGE,
    createPowerLoadDescription,
  ),
  define(
    SERIAL_CONSOLE_DEVICE,
    '串口控制台',
    'widget 演示用的 MCU 端点：rx/tx 收发字符串，image/picture 选择图片。',
    SERIAL_CONSOLE_PACKAGE,
    createSerialConsoleDescription,
  ),
  define(
    INDICATOR_DEVICE,
    '布尔指示器',
    '把 widget 发布的布尔值锁存后从 output 端发布，供 LED 等 widget 绑定。',
    INDICATOR_PACKAGE,
    createIndicatorDescription,
  ),
]);

const BY_ID = new Map(PLAYGROUND_DEVICES.map((device) => [device.id, device] as const));
const BY_DEVICE_ID = new Map(
  PLAYGROUND_DEVICES.map((device) => [device.deviceId, device] as const),
);

/** Resolves one `lab:` reference to its parsed package description. */
export function createPlaygroundDefinition(id: string): DeviceDefinition | undefined {
  const device = BY_ID.get(id);
  if (device === undefined) {
    return undefined;
  }
  const definition = parseDeviceDescription(device.package, {
    name: id,
    displayName: device.displayName,
    description: device.description,
  });
  return Object.freeze({ definition, code: '' });
}

/**
 * Binds a schematic reference to the unified-IR description of a part.
 *
 * Returns `undefined` for every other device id, which keeps the compiler's
 * passive package description in charge (topic ports still work).
 */
export function resolvePlaygroundDevice(reference: {
  readonly deviceId: string;
}): SchematicDeviceBinding | undefined {
  const device = BY_DEVICE_ID.get(reference.deviceId);
  if (device === undefined) {
    return undefined;
  }
  return { type: device.deviceId, description: device.create() };
}

/** Catalogue rows for the UI: id, name and the RFC each part demonstrates. */
export function playgroundDeviceCatalogue(): readonly {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
}[] {
  return PLAYGROUND_DEVICES.map((device) => ({
    id: device.id,
    displayName: device.displayName,
    description: device.description,
  }));
}
