import createMcu from './mcu';
import createLcd from './lcd';
import model from './hot-model';
import { fuseBlock, FUSED_FRAME_BLOCK, FUSED_FRAME_PC } from './fusion';
import { createBoardDevices } from './board';

/** One model and one JIT: the fixed board nets are internal to this device. */
export const create: DeviceFactory = (context) => {
  const mcu = createMcu({
    ...context,
    attachJit(options) {
      return context.attachJit({
        ...options,
        translate: (input, builder) =>
          input.pc === FUSED_FRAME_PC
            ? FUSED_FRAME_BLOCK
            : fuseBlock(options.translate(input, builder), model),
      });
    },
  });
  const lcd = createLcd(context);
  const board = createBoardDevices(context);

  const methods: DeviceMethods = {
    ...board.methods,
    getFramebuffer: () => lcd.methods.getFramebuffer(),
  };

  return {
    methods,
    sync(batch) {
      mcu.sync(batch);
      lcd.sync(batch);
      board.sync(batch);
    },
    dispose() {
      mcu.dispose();
      lcd.dispose();
    },
  };
};
