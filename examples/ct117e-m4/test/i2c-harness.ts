import { createBoardHarness } from './board-harness';
import type { BoardHarness } from './board-harness';

/**
 * §2 私有包装：装载路径统一走底座 `test/board-harness.ts`，只在包装层额外订阅
 * I²C 事件并提供 manifest 方法查询。共享测试夹具不在这里复制。
 */

export interface EepromWrite {
  readonly address: number;
  readonly value: number;
}

export interface I2cHarness extends BoardHarness {
  readonly eepromWrites: readonly EepromWrite[];
  readonly wiperEvents: readonly number[];
  readonly faults: readonly number[];
  readonly readEeprom: () => Uint8Array;
  query(method: string, params?: unknown): unknown;
}

export interface I2cHarnessOptions {
  readonly firmware: Uint8Array;
}

export async function createI2cHarness(options: I2cHarnessOptions): Promise<I2cHarness> {
  const base = await createBoardHarness(options.firmware);
  const eepromWrites: EepromWrite[] = [];
  const wiperEvents: number[] = [];
  const faults: number[] = [];
  const subscription = base.board.topics.onDidReceive((message) => {
    if (message.topic === 'eepromWrite') {
      const payload = message.payload as EepromWrite;

      if (payload !== null && typeof payload === 'object')
        eepromWrites.push({ address: Number(payload.address), value: Number(payload.value) });
    } else if (message.topic === 'wiper') {
      wiperEvents.push(Number(message.payload));
    } else if (message.topic === 'fault') {
      faults.push(Number(message.payload));
    }
  });

  return {
    ...base,
    eepromWrites,
    wiperEvents,
    faults,
    readEeprom() {
      return base.methods.readEeprom(null) as Uint8Array;
    },
    query(method, params = null) {
      const target = base.methods[method];

      if (target === undefined) throw new Error(`Unknown method ${method}`);
      return target(params);
    },
    dispose() {
      subscription.dispose();
      base.dispose();
    },
  };
}
