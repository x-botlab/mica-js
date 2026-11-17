import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { createDeviceBuilder, createJitBlockBuilder, types } from '@mica-js/sdk/model';
import { asBody } from '@mica-js/stm32g431rbt6-core/ir';
import { describe, expect, it } from 'vitest';
import {
  CPU_WAIT_ADVANCE,
  CPU_WAIT_WAIT_PS,
  CPU_WFE_POLL,
  CPU_WFI_POLL,
  beginWait,
  clearWait,
  cpuWaitPolling,
  waitExceptionReturnPc,
} from '@mica-js/stm32g431rbt6-core/wait';
import { FLASH_ALIAS_BASE, FLASH_BASE } from '@mica-js/stm32g431rbt6-core/layout';
import { codeOf } from './cpu-rig';

describe('WFI/WFE polling contract helper', () => {
  it('finds WFI/WFE at both Flash aliases with the DDL names', () => {
    const code = codeOf([
      0x30, 0xbf, // wfi
      0x20, 0xbf, // wfe
      0x00, 0xbf,
    ]);
    const polling = cpuWaitPolling(code, code.length, [FLASH_BASE, FLASH_ALIAS_BASE]);

    expect(polling).toHaveLength(4);
    expect(polling[0]).toMatchObject({
      pc: FLASH_BASE,
      predicate: CPU_WFI_POLL,
      wait: { delay: CPU_WAIT_WAIT_PS, advance: CPU_WAIT_ADVANCE },
    });
    expect(polling[1]).toMatchObject({ pc: FLASH_ALIAS_BASE, predicate: CPU_WFI_POLL });
    expect(polling[2]).toMatchObject({ pc: FLASH_BASE + 2, predicate: CPU_WFE_POLL });
    expect(polling[3]).toMatchObject({ pc: FLASH_ALIAS_BASE + 2, predicate: CPU_WFE_POLL });
  });

  it('does not register WFI inside an IT block', () => {
    const code = codeOf([
      0x08, 0xbf, // it eq
      0x30, 0xbf, // wfi (conditional)
      0x30, 0xbf, // wfi at top level
    ]);
    const polling = cpuWaitPolling(code, code.length, [FLASH_BASE]);

    expect(polling.map((entry) => entry.pc)).toEqual([FLASH_BASE + 4]);
  });

  it('uses waitNext for exception return only while waiting', () => {
    const model = (() => {
      const builder = createDeviceBuilder({ name: 'WaitHelperRig' });

      builder.memory({ name: 'code', length: 0x10 });
      builder.memory({ name: 'sys', length: 0x200 });
      builder.state({ name: 'pc', type: types.number, initial: 0 });
      builder.state({ name: 'activeResult', type: types.number, initial: 0 });
      builder.state({ name: 'inactiveResult', type: types.number, initial: 0 });
      builder.state({ name: 'done', type: types.number, initial: 0 });

      return builder.finish();
    })();
    const block = (() => {
      const builder = createJitBlockBuilder();

      builder.instruction({ pc: 0, nextPc: 0 }, (body) => {
        const scope = asBody(body);

        beginWait(scope, 0x10, 0x12);
        scope.writeState(
          'activeResult',
          waitExceptionReturnPc(scope, scope.constant(types.number, 0xaaaa)),
        );
        clearWait(scope);
        scope.writeState(
          'inactiveResult',
          waitExceptionReturnPc(scope, scope.constant(types.number, 0xaaaa)),
        );
        scope.writeState('done', scope.constant(types.number, 1));
        scope.writeState('pc', scope.constant(types.number, 0));
        scope.stop();
      });

      return builder.finish();
    })();

    const board = createBoard(
      createDeviceLibrary([
        {
          id: 'wait',
          model,
          create: ((context: {
            attachJit(options: {
              entry: string;
              code: string;
              pc: string;
              translate: () => typeof block;
            }): void;
            loadBytes(memory: string, bytes: Uint8Array, offset?: number): void;
          }) => {
            context.attachJit({
              entry: 'run',
              code: 'code',
              pc: 'pc',
              translate: () => block,
            });
            context.loadBytes('code', new Uint8Array(0x10));

            return { sync() {}, dispose() {} };
          }) as never,
        },
      ] as never),
      {
        instances: [{ id: 'wait', type: 'wait' }],
        nets: [],
      } as never,
    );

    try {
      board.runUntil(1_000_000);

      const instance = (
        board as unknown as {
          readonly instances?: readonly {
            readonly states?: ReadonlyMap<string, unknown>;
          }[];
        }
      ).instances?.[0];

      expect(instance?.states?.get('done')).toBe(1);
      expect(instance?.states?.get('activeResult')).toBe(0x12);
      expect(instance?.states?.get('inactiveResult')).toBe(0xaaaa);
    } finally {
      board.dispose();
    }
  });
});
