import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { createDeviceBuilder, createJitBlockBuilder, types } from '@mica-js/sdk/model';
import type { BlockIR, DeviceIR } from '@mica-js/sdk/model';
import { describe, expect, it } from 'vitest';
import { activateMachine } from '@mica-js/stm32g431rbt6-core/machine';
import type { Machine } from '@mica-js/stm32g431rbt6-core/machine';
import { flashModule, readFlash, writeFlash } from '@mica-js/stm32g431rbt6-core/flash';
import {
  FLASH_CR,
  FLASH_CR_PER,
  FLASH_CR_STRT,
  FLASH_KEY1,
  FLASH_KEY2,
  FLASH_KEYR,
  FLASH_SR,
  FLASH_SR_BSY,
} from '@mica-js/stm32g431rbt6-core/flash-layout';
import {
  FLASH_BASE_REGISTER,
  FLASH_STATE_MEMORY,
  PENDING_PS,
  TICK_ACTIVE,
  TICK_PS,
  periphDeadlineState,
} from '@mica-js/stm32g431rbt6-core/layout';
import { asBody } from '@mica-js/stm32g431rbt6-core/ir';

const MACHINE: Machine = {
  clockFrequency: 16_000_000,
  cyclePs: 62_500,
  alternateDrivers: [],
  peripherals: [flashModule],
  interruptSources: [],
  profile: 'flash-deadline-rig',
};

function model(): DeviceIR {
  const builder = createDeviceBuilder({ name: 'FlashDeadlineRig' });

  builder.memory({ name: 'code', length: 0x20000 });
  builder.memory({ name: FLASH_STATE_MEMORY, length: 0x100 });
  builder.memory({ name: 'sys', length: 0x200 });
  builder.memory({ name: 'periph', length: 0x1000 });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  builder.state({ name: PENDING_PS, type: types.number, initial: 0 });
  builder.state({ name: TICK_PS, type: types.number, initial: 1_000_000_000_000 });
  builder.state({ name: TICK_ACTIVE, type: types.bool, initial: false });
  builder.state({ name: 'periphActive', type: types.number, initial: 0 });
  builder.state({ name: periphDeadlineState(8), type: types.number, initial: 0 });
  builder.state({ name: 'serviceMask', type: types.number, initial: 0 });
  builder.state({ name: 'irqDirty', type: types.bool, initial: false });
  builder.state({ name: 'primask', type: types.number, initial: 0 });
  builder.state({ name: 'systickOn', type: types.bool, initial: false });
  builder.state({ name: 'systickLoad', type: types.number, initial: 0 });
  builder.state({ name: 'txMask', type: types.number, initial: 0 });
  for (let index = 1; index <= 5; index += 1) {
    for (const field of ['Active', 'Remaining', 'Queue', 'Count']) {
      const initial = field === 'Count' ? 0 : 0;
      builder.state({ name: `tx${index}${field}`, type: types.number, initial });
    }
    builder.state({ name: `tx${index}Period`, type: types.number, initial: 1 });
    builder.state({ name: `tx${index}Publish`, type: types.number, initial: -1 });
  }
  builder.state({ name: 'deadlineBusy', type: types.number, initial: -1 });
  builder.state({ name: 'bsyBusy', type: types.number, initial: -1 });
  builder.state({ name: 'deadlineDone', type: types.number, initial: -1 });
  builder.state({ name: 'bsyDone', type: types.number, initial: -1 });

  return builder.finish();
}

function block(): BlockIR {
  const builder = createJitBlockBuilder();

  builder.instruction({ pc: 0, nextPc: 0 }, (body) => {
    const scope = asBody(body);
    const flash = FLASH_BASE_REGISTER;

    writeFlash(scope, scope.constant(types.number, flash + FLASH_KEYR), 4, scope.constant(types.number, FLASH_KEY1));
    writeFlash(scope, scope.constant(types.number, flash + FLASH_KEYR), 4, scope.constant(types.number, FLASH_KEY2));
    writeFlash(
      scope,
      scope.constant(types.number, flash + FLASH_CR),
      4,
      scope.constant(types.number, FLASH_CR_PER | (2 << 3) | FLASH_CR_STRT),
    );

    flashModule.advance!(scope, scope.constant(types.number, 19_999_999_999));
    scope.writeState('deadlineBusy', scope.readState(periphDeadlineState(8), types.number));
    scope.writeState(
      'bsyBusy',
      scope.bitAnd(
        readFlash(scope, scope.constant(types.number, flash + FLASH_SR), 4),
        scope.constant(types.number, FLASH_SR_BSY),
      ),
    );

    flashModule.advance!(scope, scope.constant(types.number, 1));
    scope.writeState('deadlineDone', scope.readState(periphDeadlineState(8), types.number));
    scope.writeState(
      'bsyDone',
      scope.bitAnd(
        readFlash(scope, scope.constant(types.number, flash + FLASH_SR), 4),
        scope.constant(types.number, FLASH_SR_BSY),
      ),
    );
    scope.writeState('pc', scope.constant(types.number, 0));
    scope.stop();
  });

  return builder.finish();
}

describe('flash long deadline', () => {
  it('stays BSY at 19_999_999_999 ps and completes on +1 ps through shared helper state', () => {
    const diagnostics: string[] = [];
    const board = createBoard(
      createDeviceLibrary([
        {
          id: 'flash-deadline',
          model: model(),
          create: ((context: {
            attachJit(options: { entry: string; code: string; pc: string; translate: () => BlockIR }): void;
            loadBytes(memory: string, bytes: Uint8Array, offset?: number): void;
          }) => {
            context.attachJit({
              entry: 'run',
              code: 'code',
              pc: 'pc',
              translate: () => activateMachine(MACHINE, block),
            });
            context.loadBytes('code', new Uint8Array(0x20000));

            return { sync() {}, dispose() {} };
          }) as never,
        },
      ] as never),
      { instances: [{ id: 'flash-deadline', type: 'flash-deadline' }], nets: [] } as never,
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
      expect(instance?.states?.get('bsyBusy')).toBe(FLASH_SR_BSY);
      expect(instance?.states?.get('deadlineBusy')).toBe(1);
      expect(instance?.states?.get('bsyDone')).toBe(0);
      expect(instance?.states?.get('deadlineDone')).toBe(0);
    } finally {
      errors.dispose();
      board.dispose();
    }
  });
});
