import type { Factory } from './model.ddl';
import createMcu from './mcu';
import createLcd from './lcd';
import model from './hot-model';
import { fuseBlock, FUSED_FRAME_BLOCK, FUSED_FRAME_PC } from './fusion';

/** One model and one JIT: the fixed LCD bus is internal to this device. */
const create: Factory = (context) => {
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
  return {
    sync(batch) {
      mcu.sync(batch);
      lcd.sync(batch);
    },
    dispose() {
      mcu.dispose();
      lcd.dispose();
    },
  };
};

export default create;
