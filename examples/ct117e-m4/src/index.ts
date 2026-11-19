import createMcu from './mcu';
import createLcd from './lcd';
import createBoardDevices from './board';
import createBoardI2c from './board-i2c';
import createTimers from './timers';
import model from './hot-model';
import { fuseBlock, FUSED_FRAME_BLOCK, FUSED_FRAME_PC } from './fusion';

/** One model and one JIT: the fixed LCD bus is internal to this device. */
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
  const i2c = createBoardI2c(context);
  const timers = createTimers(context);

  const methods: DeviceMethods = {
    getFramebuffer: () => lcd.methods.getFramebuffer(),
    getLedState: board.methods.getLedState,
    setButton: board.methods.setButton,
    getButton: board.methods.getButton,
    setPotentiometer: board.methods.setPotentiometer,
    getPotentiometer: board.methods.getPotentiometer,
    readEeprom: i2c.methods.readEeprom,
    writeEeprom: i2c.methods.writeEeprom,
    getWiper: i2c.methods.getWiper,
    setWiper: i2c.methods.setWiper,
    setTimerPotentiometer: timers.methods.setTimerPotentiometer,
    getTimerPotentiometer: timers.methods.getTimerPotentiometer,
    getTimerFrequency: timers.methods.getTimerFrequency,
  };

  return {
    methods,
    sync(batch) {
      mcu.sync(batch);
      lcd.sync(batch);
      board.sync(batch);
      i2c.sync(batch);
      timers.sync(batch);
    },
    dispose() {
      mcu.dispose();
      lcd.dispose();
      board.dispose();
      i2c.dispose();
      timers.dispose();
    },
  };
};
