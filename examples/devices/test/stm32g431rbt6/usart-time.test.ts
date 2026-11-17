import { types } from '@mica-js/sdk/model';
import { compileDDL } from '@mica-js/sdk/ddl';
import type { DeviceIR } from '@mica-js/sdk/model';
import { describe, expect, it } from 'vitest';
import { activateMachine } from '@mica-js/stm32g431rbt6-core/machine';
import type { Machine } from '@mica-js/stm32g431rbt6-core/machine';
import { USARTS, updateUsartBitPeriod, usartNextEventPs } from '@mica-js/stm32g431rbt6-core/usart';
import { asBody, num, writeWordAt } from '@mica-js/stm32g431rbt6-core/ir';
import { PERIPH } from '@mica-js/stm32g431rbt6-core/layout';
import { createBoardWith } from '../harness';
import type { DeviceModule } from '../harness';

const DDL = `
device UsartTimeProbe(mode: number default 0) {
  memory periph[0x1000];
  memory code[16];
  state pc: number = 0;
  state txMask: number = 0;
  state tx1Active: number = 0;
  state tx1Remaining: number = 0;
  state tx1Queue: number = 0;
  state tx1Count: number = 0;
  state tx1Period: number = 1;
  state tx1Publish: number = -1;
  state tx2Active: number = 0;
  state tx2Remaining: number = 0;
  state tx2Queue: number = 0;
  state tx2Count: number = 0;
  state tx2Period: number = 1;
  state tx2Publish: number = -1;
  state tx3Active: number = 0;
  state tx3Remaining: number = 0;
  state tx3Queue: number = 0;
  state tx3Count: number = 0;
  state tx3Period: number = 1;
  state tx3Publish: number = -1;
  output channel result: number(capacity: 1);
}
`;

let moduleCache: Promise<DeviceModule> | undefined;

function loadProbe(): Promise<DeviceModule> {
  moduleCache ??= (async () => {
    const model: DeviceIR = await compileDDL(DDL, { uri: 'mica:test/usart-time-probe.ddl' });
    const machine: Machine = {
      clockFrequency: 16_000_000,
      cyclePs: 62_500,
      alternateDrivers: [],
      peripherals: [],
      interruptSources: [],
      profile: 'test',
    };

    return {
      model,
      create: ((context: Record<string, unknown>) => {
        const props = context.props as { readonly mode?: number };
        const mode = props.mode ?? 0;
        const inputs = context as unknown as {
          attachJit(options: unknown): { dispose(): void };
          loadBytes(name: string, bytes: Uint8Array): void;
        };
        const registration = inputs.attachJit({
          entry: 'cpu',
          code: 'code',
          pc: 'pc',
          translate: ({ pc }: { pc: number }, block: unknown) =>
            activateMachine(machine, () => {
              const builder = block as {
                instruction(
                  options: { pc: number; nextPc: number },
                  emit: (body: unknown) => void,
                ): void;
                finish(): unknown;
              };

              builder.instruction({ pc, nextPc: pc }, (raw) => {
                const body = asBody(raw);

                if (mode === 0) {
                  // USART1：1 MHz / BRR 5000 -> 5 ms = 5e12 ps，超过 2^32。
                  writeWordAt(body, PERIPH, 0x30c, num(body, 5000));
                  updateUsartBitPeriod(body, USARTS[0]!, num(body, 1_000_000));
                  body.send('result', body.readState('tx1Period', types.number));
                  body.stop();

                  return;
                }

                // LPUART1：1 MHz / 256*5000 = 1.28e12 ps。
                writeWordAt(body, PERIPH, 0x40c, num(body, 5000));
                updateUsartBitPeriod(body, USARTS[4]!, num(body, 1_000_000));
                const expected = 1_280_000_000_000;
                const lo = expected % 0x1_0000_0000;
                const hi = Math.floor(expected / 0x1_0000_0000);

                writeWordAt(body, PERIPH, 0xc20, num(body, 1)); // Active
                writeWordAt(body, PERIPH, 0xc30, num(body, lo));
                writeWordAt(body, PERIPH, 0xc34, num(body, hi));
                body.writeState('txMask', num(body, 1 << 4));
                body.send('result', usartNextEventPs(body));
                body.stop();
              });

              return builder.finish();
            }),
        });

        inputs.loadBytes('code', new Uint8Array(16));

        return { sync() {}, dispose: () => registration.dispose() };
      }) as DeviceModule['create'],
      manifest: {
        publisher: 'test',
        name: 'usart-time-probe',
        version: '1.0.0',
        engines: { mica: '^0.3.0' },
        displayName: 'USART time probe',
        model: { entry: 'model.js', types: {}, methods: {}, events: {} },
      },
    };
  })();

  return moduleCache;
}

async function result(mode: number): Promise<unknown> {
  const board = await createBoardWith(
    [{ id: 'dut', type: 'usart-time-probe', device: await loadProbe(), props: { mode } }],
    { nets: [] },
  );

  try {
    board.runUntil(10);
    return board.outputs.result;
  } finally {
    board.dispose();
  }
}

describe('USART 时间字段不被 32 位截断', () => {
  it('USART1 number state 保存 5 ms 位长', async () => {
    expect(await result(0)).toBe(5_000_000_000);
  });

  it('LPUART1 lo/hi word 保存 1.28 s 位长，并参与下一事件期限', async () => {
    expect(await result(1)).toBe(1_280_000_000_000);
  });
});
