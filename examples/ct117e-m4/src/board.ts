import { MethodError } from '@mica-js/sdk/fused';

type Batch = Parameters<ReturnType<DeviceFactory>['sync']>[0];
type SetButtonParams = Parameters<DeviceMethods['setButton']>[0];
type GetButtonParams = Parameters<DeviceMethods['getButton']>[0];
type SetPotentiometerParams = Parameters<DeviceMethods['setPotentiometer']>[0];
type GetPotentiometerParams = Parameters<DeviceMethods['getPotentiometer']>[0];
type BoardMethods = Pick<
  DeviceMethods,
  'getLedState' | 'setButton' | 'getButton' | 'setPotentiometer' | 'getPotentiometer'
>;

const POT_DEFAULT = 0.5;

function buttonIndex(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 4)
    throw new MethodError('ct117e-m4/button-id', 'button id must be an integer within 1..4', {
      id: value,
    });
  return value - 1;
}

function potIndex(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 2)
    throw new MethodError('ct117e-m4/potentiometer-id', 'potentiometer id must be 1 or 2', {
      id: value,
    });
  return value - 1;
}

/**
 * 板载按键、LED 与 ADC 电位器的公共接口。
 *
 * DDL 负责引脚电平和锁存语义；这里只做参数校验、缓存和事件桥接。方法与事件都
 * 通过 `package.json` 的 model 清单声明，宿主不需要接触内部 `fusedWireNN` 状态。
 * setter 只有在输入消息成功入队后才更新缓存，避免 send 抛错时宿主看到未应用的值。
 */
export default function createBoardDevices(context: DeviceModelContext): {
  readonly methods: BoardMethods;
  sync(batch: Batch): void;
  dispose(): void;
} {
  let ledState = 0;
  const buttons: boolean[] = [false, false, false, false];
  const positions = [POT_DEFAULT, POT_DEFAULT];

  const methods = {
    getLedState: (): number => ledState,
    setButton: (params: SetButtonParams): null => {
      const index = buttonIndex(params.id);
      if (typeof params.pressed !== 'boolean')
        throw new MethodError('ct117e-m4/button-pressed', 'pressed must be a boolean', {
          id: params.id,
        });
      if (buttons[index] === params.pressed) return null;
      context.inputs.setButton.send({ id: params.id, pressed: params.pressed });
      buttons[index] = params.pressed;
      return null;
    },
    getButton: (params: GetButtonParams): boolean => buttons[buttonIndex(params.id)]!,
    setPotentiometer: (params: SetPotentiometerParams): null => {
      const index = potIndex(params.id);
      if (!Number.isFinite(params.position) || params.position < 0 || params.position > 1)
        throw new MethodError(
          'ct117e-m4/potentiometer-position',
          'position must be a finite value within 0..1',
          { id: params.id },
        );
      if (positions[index] === params.position) return null;
      context.inputs.setPotentiometer.send({ id: params.id, position: params.position });
      positions[index] = params.position;
      return null;
    },
    getPotentiometer: (params: GetPotentiometerParams): number => positions[potIndex(params.id)]!,
  } satisfies BoardMethods;

  return {
    methods,
    sync(batch) {
      for (const message of batch.outputs.led) {
        ledState = message.value;
        context.events.onDidLed.fire(ledState);
      }
      for (const message of batch.outputs.button) {
        buttons[message.value.id - 1] = message.value.pressed;
        context.events.onDidPress.fire(message.value);
      }
      for (const message of batch.outputs.potentiometer) {
        positions[message.value.id - 1] = message.value.position;
        context.events.onDidPotentiometer.fire(message.value);
      }
    },
    dispose() {},
  };
}
