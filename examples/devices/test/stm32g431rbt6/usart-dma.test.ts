import { types } from '@mica-js/sdk/model';
import { compileDDL } from '@mica-js/sdk/ddl';
import type { DeviceIR } from '@mica-js/sdk/model';
import { describe, expect, it } from 'vitest';
import { activateMachine } from '@mica-js/stm32g431rbt6-core/machine';
import type { Machine } from '@mica-js/stm32g431rbt6-core/machine';
import { USARTS, usartDmaRequestReady } from '@mica-js/stm32g431rbt6-core/usart';
import { asBody, num, writeWordAt } from '@mica-js/stm32g431rbt6-core/ir';
import { PERIPH } from '@mica-js/stm32g431rbt6-core/layout';
import { createBoardWith } from '../harness';
import type { DeviceModule } from '../harness';

const DDL = `
device UsartDmaProbe(dmat: number default 0, dmar: number default 0) {
  memory periph[0x1000];
  memory code[16];
  state pc: number = 0;
  state tx1Active: number = 0;
  state tx1Remaining: number = 0;
  state tx1Queue: number = 0;
  state tx1Count: number = 0;
  state tx1Period: number = 1;
  state tx1Publish: number = -1;
  output channel txReady: number(capacity: 1);
  output channel rxReady: number(capacity: 1);
}
`;

let moduleCache: Promise<DeviceModule> | undefined;

function loadProbe(): Promise<DeviceModule> {
  moduleCache ??= (async () => {
    const model: DeviceIR = await compileDDL(DDL, { uri: 'mica:test/usart-dma-probe.ddl' });
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
        const props = context.props as { readonly dmat?: number; readonly dmar?: number };
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

                // UE|TE，DMAT/DMAR 由实例属性控制；TXE/RXNE 置为有效。
                writeWordAt(body, PERIPH, 0x300, num(body, 0x0d));
                writeWordAt(
                  body,
                  PERIPH,
                  0x308,
                  num(body, (props.dmat === 1 ? 0x80 : 0) | (props.dmar === 1 ? 0x40 : 0)),
                );
                writeWordAt(body, PERIPH, 0xcd0, num(body, 1 << 13));
                const tx = usartDmaRequestReady(body, USARTS[0]!, true);
                const rx = usartDmaRequestReady(body, USARTS[0]!, false);

                body.send(
                  'txReady',
                  body.select(
                    types.number,
                    tx,
                    (yes) => yes.constant(types.number, 1),
                    (no) => no.constant(types.number, 0),
                  ),
                );
                body.send(
                  'rxReady',
                  body.select(
                    types.number,
                    rx,
                    (yes) => yes.constant(types.number, 1),
                    (no) => no.constant(types.number, 0),
                  ),
                );
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
        name: 'usart-dma-probe',
        version: '1.0.0',
        engines: { mica: '^0.3.0' },
        displayName: 'USART DMA probe',
        model: { entry: 'model.js', types: {}, methods: {}, events: {} },
      },
    };
  })();

  return moduleCache;
}

async function probe(dmat: number, dmar: number): Promise<{ tx: unknown; rx: unknown }> {
  const board = await createBoardWith(
    [{ id: 'dut', type: 'usart-dma-probe', device: await loadProbe(), props: { dmat, dmar } }],
    { nets: [] },
  );

  try {
    board.runUntil(10);
    return { tx: board.outputs.txReady, rx: board.outputs.rxReady };
  } finally {
    board.dispose();
  }
}

describe('USART DMA 请求门控', () => {
  it('DMAT/DMAR 为 0 时 TXE/RXNE 不产生请求', async () => {
    const value = await probe(0, 0);

    expect(value).toEqual({ tx: 0, rx: 0 });
  });

  it('DMAT=1 且 TXE=1 时请求，DMAR=1 且 RXNE=1 时请求', async () => {
    const value = await probe(1, 1);

    expect(value).toEqual({ tx: 1, rx: 1 });
  });
});
