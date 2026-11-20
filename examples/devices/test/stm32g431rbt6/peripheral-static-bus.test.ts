import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { createDeviceBuilder, createJitBlockBuilder, types } from '@mica-js/sdk/model';
import { describe, expect, it } from 'vitest';
import { activateMachine } from '@mica-js/stm32g431rbt6-core/machine';
import type { Machine } from '@mica-js/stm32g431rbt6-core/machine';
import type { BlockIR } from '@mica-js/sdk/model';
import type { PeripheralModule } from '@mica-js/stm32g431rbt6-core/peripheral';
import { PERIPHERALS } from '@mica-js/stm32g431rbt6-core/peripherals';
import { readPeripheral, writePeripheral } from '@mica-js/stm32g431rbt6-core/bus';
import { timerModule } from '@mica-js/stm32g431rbt6-core/tim';
import { captureFifoModel } from './capture-fifo-rig';

const TIM2 = 0x4000_0000;
const ARR = 0x2c;

function machine(): Machine {
  return {
    clockFrequency: 16_000_000,
    cyclePs: 62_500,
    alternateDrivers: [],
    peripherals: PERIPHERALS,
    interruptSources: PERIPHERALS.flatMap((peripheral) => peripheral.interrupts ?? []),
    profile: 'peripheral-static-test',
  };
}

function walk(value: unknown, visit: (node: Record<string, unknown>) => void): number {
  if (Array.isArray(value)) return value.reduce((sum, entry) => sum + walk(entry, visit), 0);
  if (value === null || typeof value !== 'object') return 0;

  const node = value as Record<string, unknown>;
  let count = 1;

  visit(node);
  for (const child of Object.values(node)) count += walk(child, visit);

  return count;
}

describe('peripheral static hook', () => {
  it('TIM2 ARR static write only expands TIM2 register semantics', async () => {
    const model = await captureFifoModel();
    const summarize = (block: BlockIR) => {
      const writes = new Set<string>();
      const reads = new Set<string>();
      const nodes = walk(block, (node) => {
        if (node.resource !== 'state' || typeof node.name !== 'string') return;
        if (node.kind === 'write') writes.add(node.name);
        if (node.kind === 'read') reads.add(node.name);
      });

      return { nodes, writes, reads };
    };
    const address = TIM2 + ARR;
    const staticBlock = activateMachine(machine(), () => {
      const builder = createJitBlockBuilder({ device: model });

      builder.instruction({ pc: 0, nextPc: 0 }, (body) => {
        writePeripheral(
          body,
          body.constant(types.number, address),
          4,
          body.constant(types.number, 7),
          false,
          address,
          7,
        );
        body.stop();
      });

      return builder.finish();
    });
    const dynamicBlock = activateMachine(machine(), () => {
      const builder = createJitBlockBuilder({ device: model });

      builder.instruction({ pc: 0, nextPc: 0 }, (body) => {
        timerModule.write(
          body,
          body.constant(types.number, address),
          4,
          body.constant(types.number, 7),
        );
        body.stop();
      });

      return builder.finish();
    });
    const fast = summarize(staticBlock);
    const legacy = summarize(dynamicBlock);

    // 旧路径单写约 43k nodes；现在只展开 TIM2 的 register/wake 树。
    expect(fast.nodes).toBeLessThan(10_000);
    expect(fast.nodes * 4).toBeLessThan(legacy.nodes);
    expect([...fast.writes].some((name) => /^tim(?:1|3|4|6|7|8|15|16|17)/.test(name))).toBe(false);
    expect([...fast.reads].some((name) => /^tim(?:1|3|4|6|7|8|15|16|17)/.test(name))).toBe(false);
    expect([...fast.writes].some((name) => name.startsWith('tim2'))).toBe(true);
    // 反证旧动态路径会展开全部 TIM 实例，避免把“变小”归因于测试没生成树。
    expect([...legacy.writes].some((name) => name.startsWith('tim1'))).toBe(true);
    expect([...legacy.writes].some((name) => name.startsWith('tim3'))).toBe(true);
  });

  // 孤立 PeripheralModule 合同 unit：只验证 bus 的静态模块分派/回退，不是生产 profile 验收。
  it.each([false, true])(
    'static hook decline falls back once to legacy read/write (defer=%s)',
    async (defer) => {
      const builder = createDeviceBuilder({ name: 'FallbackModule' });

      builder.memory({ name: 'code', length: 0x10 });
      builder.state({ name: 'pc', type: types.number, initial: 0 });
      builder.state({ name: 'fallbackValue', type: types.number, initial: 0 });
      builder.state({ name: 'reads', type: types.number, initial: 0 });
      builder.state({ name: 'writes', type: types.number, initial: 0 });
      builder.state({ name: 'result', type: types.number, initial: 0 });
      const model = builder.finish();
      const module: PeripheralModule = {
        id: 'nohook',
        ranges: [{ base: 0x5000_0000, size: 0x100 }],
        read: (body) => {
          const value = body.readState('fallbackValue', types.number);

          body.writeState(
            'reads',
            body.add(body.readState('reads', types.number), body.constant(types.number, 1)),
          );

          return value;
        },
        readStatic: () => undefined,
        write: (body, _address, _size, value) => {
          body.writeState('fallbackValue', value);
          body.writeState(
            'writes',
            body.add(body.readState('writes', types.number), body.constant(types.number, 1)),
          );
        },
        writeStatic: () => false,
      };
      const testMachine: Machine = {
        ...machine(),
        peripherals: [module],
        interruptSources: [],
      };
      const staticAddress = 0x5000_0010;
      const block = activateMachine(testMachine, () => {
        const b = createJitBlockBuilder({ device: model });

        b.instruction({ pc: 0, nextPc: 0 }, (body) => {
          writePeripheral(
            body,
            body.constant(types.number, staticAddress),
            4,
            body.constant(types.number, 0x55),
            defer,
            staticAddress,
            0x55,
          );
          body.writeState(
            'result',
            readPeripheral(
              body,
              body.constant(types.number, staticAddress),
              4,
              undefined,
              staticAddress,
            ),
          );
          body.stop();
        });

        return b.finish();
      });
      const board = createBoard(
        createDeviceLibrary([
          {
            id: 'fallback',
            model,
            create: ((context: {
              attachJit(options: {
                entry: string;
                code: string;
                pc: string;
                translate: () => BlockIR;
              }): void;
              loadBytes(memory: string, bytes: Uint8Array, offset?: number): void;
            }) => {
              context.attachJit({
                entry: 'fallback',
                code: 'code',
                pc: 'pc',
                translate: () => block,
              });
              context.loadBytes('code', new Uint8Array(0x10));

              return { sync() {}, dispose() {} };
            }) as never,
          },
        ] as never),
        { instances: [{ id: 'fallback', type: 'fallback' }], nets: [] } as never,
      );
      const instance = (
        board as unknown as {
          readonly instances: readonly { readonly states: ReadonlyMap<string, unknown> }[];
        }
      ).instances[0]!;

      try {
        board.runUntil(1_000_000);
        expect(instance.states.get('fallbackValue')).toBe(0x55);
        expect(instance.states.get('reads')).toBe(1);
        expect(instance.states.get('writes')).toBe(1);
        expect(instance.states.get('result')).toBe(0x55);
      } finally {
        board.dispose();
      }
    },
  );
});
