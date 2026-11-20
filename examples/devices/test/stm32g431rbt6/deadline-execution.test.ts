import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { createDeviceBuilder, createJitBlockBuilder, types } from '@mica-js/sdk/model';
import type { BlockIR, DeviceIR } from '@mica-js/sdk/model';
import { describe, expect, it } from 'vitest';
import { activatePeripheralSlot } from '@mica-js/stm32g431rbt6-core/peripheral';
import { asBody } from '@mica-js/stm32g431rbt6-core/ir';
import { periphDeadlineState } from '@mica-js/stm32g431rbt6-core/layout';

function model(): DeviceIR {
  const builder = createDeviceBuilder({ name: 'DeadlineRig' });

  builder.memory({ name: 'code', length: 0x10 });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  builder.state({ name: 'periphActive', type: types.number, initial: 0 });
  builder.state({ name: 'periphDeadline3', type: types.number, initial: 0 });
  builder.state({ name: 'done', type: types.number, initial: 0 });

  return builder.finish();
}

function block(): BlockIR {
  const builder = createJitBlockBuilder();

  builder.instruction({ pc: 0, nextPc: 0 }, (body) => {
    const scope = asBody(body);

    activatePeripheralSlot(scope, 3, scope.constant(types.number, 5_000_000_000));
    scope.writeState('done', scope.constant(types.number, 1));
    scope.writeState('pc', scope.constant(types.number, 0));
    scope.stop();
  });

  return builder.finish();
}

describe('peripheral deadline long-ps execution', () => {
  it('writes and reads 5e9 ps through real IR without u32 truncation', () => {
    const image = block();
    const diagnostics: string[] = [];
    const board = createBoard(
      createDeviceLibrary([
        {
          id: 'deadline',
          model: model(),
          create: ((context: {
            attachJit(options: { entry: string; code: string; pc: string; translate: () => BlockIR }): void;
            loadBytes(memory: string, bytes: Uint8Array, offset?: number): void;
          }) => {
            context.attachJit({
              entry: 'run',
              code: 'code',
              pc: 'pc',
              translate: () => image,
            });
            context.loadBytes('code', new Uint8Array(0x10));

            return { sync() {}, dispose() {} };
          }) as never,
        },
      ] as never),
      {
        instances: [{ id: 'deadline', type: 'deadline' }],
        nets: [],
      } as never,
    );
    const errors = board.onDidError((error) => diagnostics.push(error.message));

    try {
      board.runUntil(1_000_000);

      const instance = (
        board as unknown as {
          readonly instances?: readonly { readonly states?: ReadonlyMap<string, unknown> }[];
        }
      ).instances?.[0];

      expect(diagnostics).toEqual([]);
      expect(instance?.states?.get('done')).toBe(1);
      expect(instance?.states?.get('periphActive')).toBe(1 << 3);
      expect(instance?.states?.get(periphDeadlineState(3))).toBe(5_000_000_000);
    } finally {
      errors.dispose();
      board.dispose();
    }
  });
});
