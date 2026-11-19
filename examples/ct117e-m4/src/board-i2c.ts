import { MethodError } from '@mica-js/sdk/fused';

/**
 * §2 板载 I²C 的宿主适配器。
 *
 * DDL 负责位级总线、EEPROM 映像和 wiper；这里只做参数校验、输入投递、事件桥接。
 * `readEeprom` 每次从公共 memory 生成独立快照，宿主修改返回值不会影响模型。
 * `writeEeprom`/`setWiper` 只有在输入成功入队后才更新缓存；队列满由 DDL 的
 * `Overflow.error` 明确报错，不静默丢弃。
 */

export interface EepromWrite {
  readonly address: number;
  readonly value: number;
}

export interface WriteEepromParams {
  readonly address: number;
  readonly data: Uint8Array;
}

export interface I2cBoardContext {
  readonly inputs: {
    readonly writeEeprom: { send(value: Uint8Array): void };
    readonly setWiper: { send(value: number): void };
  };
  readonly memory: {
    readonly eeprom: { slice(): Uint8Array };
  };
  readonly events: {
    readonly onDidEepromWrite: { fire(value: EepromWrite): void };
    readonly onDidWiper: { fire(value: number): void };
  };
}

export interface I2cBoardMethods {
  readonly readEeprom: (params: null) => Uint8Array;
  readonly writeEeprom: (params: WriteEepromParams) => null;
  readonly getWiper: (params: null) => number;
  readonly setWiper: (params: number) => null;
}

export interface I2cBoardBatch {
  readonly outputs: {
    readonly eepromWrite?: readonly { readonly value: EepromWrite }[];
    readonly wiper?: readonly { readonly value: number }[];
  };
}

export interface I2cBoard {
  readonly methods: I2cBoardMethods;
  sync(batch: I2cBoardBatch): void;
  dispose(): void;
}

const POR_WIPER = 0x3f;
const EEPROM_SIZE = 256;

function writeEepromParams(value: unknown): WriteEepromParams {
  if (value === null || typeof value !== 'object')
    throw new MethodError('ct117e-m4/eeprom-write-params', 'writeEeprom expects { address, data }');

  const params = value as Record<string, unknown>;
  const address = params['address'];
  const data = params['data'];

  if (!Number.isInteger(address) || (address as number) < 0 || (address as number) >= EEPROM_SIZE)
    throw new MethodError('ct117e-m4/eeprom-address', 'address must be an integer within 0..255', {
      address: Number(address),
    });
  if (!(data instanceof Uint8Array) || data.length < 1 || data.length > EEPROM_SIZE)
    throw new MethodError('ct117e-m4/eeprom-data', 'data must be a Uint8Array of 1..256 bytes');

  return { address: address as number, data };
}

function wiperCode(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0x7f)
    throw new MethodError('ct117e-m4/wiper', 'wiper must be an integer within 0..127', {
      value: Number(value),
    });

  return value as number;
}

export function createBoardI2c(context: I2cBoardContext): I2cBoard {
  // POR 0x3F 与 DDL 初值一致；启动后的首个 wiper 输出仍是 0x3F。
  let wiper = POR_WIPER;

  const methods: I2cBoardMethods = {
    readEeprom: () => new Uint8Array(context.memory.eeprom.slice()),
    writeEeprom: (params) => {
      const { address, data } = writeEepromParams(params);
      const payload = new Uint8Array(data.length + 1);

      payload[0] = address;
      payload.set(data, 1);
      context.inputs.writeEeprom.send(payload);
      return null;
    },
    getWiper: () => wiper,
    setWiper: (params) => {
      const next = wiperCode(params);

      // 重复设置同一值不投递输入，也不产生事件。
      if (next === wiper) return null;
      context.inputs.setWiper.send(next);
      wiper = next;
      return null;
    },
  };

  return {
    methods,
    sync(batch) {
      for (const message of batch.outputs.eepromWrite ?? [])
        context.events.onDidEepromWrite.fire(message.value);
      for (const message of batch.outputs.wiper ?? []) {
        wiper = message.value;
        context.events.onDidWiper.fire(wiper);
      }
    },
    dispose() {},
  };
}

export default createBoardI2c;
