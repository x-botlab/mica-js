import { MethodError } from '@mica-js/sdk/fused';

type Batch = Parameters<ReturnType<DeviceFactory>['sync']>[0];

export function createBoardDevices(context: DeviceModelContext) {
  let ledMask = 0;
  let wiper = 0x3f;
  let eeprom = new Uint8Array(256);

  function control(kind: number, id: number, max: number, value: number): null {
    if (!Number.isInteger(id) || id < 1 || id > max)
      throw new MethodError('ct117e-m4/control-id', `Expected id in 1..${max}`, { id });
    if (!Number.isFinite(value) || value < 0 || value > 1)
      throw new MethodError('ct117e-m4/control-position', 'Expected a position in [0, 1]');
    context.inputs.boardControl.send({ kind, id, value });
    return null;
  }

  return {
    methods: {
      getLedState: () => ledMask,
      setButton: ({ id, pressed }) => control(0, id, 4, Number(pressed)),
      setPotentiometer: ({ id, position }) => control(1, id, 2, position),
      setTimerPotentiometer: ({ id, position }) => control(2, id, 2, position),
      setReset: (pressed) => control(3, 1, 1, Number(pressed)),
      readEeprom: () => eeprom.slice(),
      getWiper: () => wiper,
    } satisfies Omit<DeviceMethods, 'getFramebuffer'>,
    sync(batch: Batch) {
      const dump = batch.outputs.u2_dump.at(-1);
      if (dump) eeprom = new Uint8Array(dump.value.slice());
      for (const { value } of batch.outputs.ledMask) {
        ledMask = value;
        context.events.onDidLed.fire(value);
      }
      for (const { value } of batch.outputs.u3_wiper) {
        wiper = value;
        context.events.onDidWiper.fire(value);
      }
    },
  };
}
