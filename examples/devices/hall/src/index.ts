import { MethodError } from '@mica-js/sdk/device';

/** 磁场输入由公共方法提交并缓存；吸合状态由模型输出并缓存。 */
const MIN_FIELD = 0;
const MAX_FIELD = 1000;

export const create: DeviceFactory = (context) => {
  let field = context.props.field;
  let active = false;

  const methods: DeviceMethods = {
    setField: (value) => {
      if (!Number.isFinite(value) || value < MIN_FIELD || value > MAX_FIELD)
        throw new MethodError(
          'hall/invalid-field',
          'Magnetic field must be a finite value within 0..1000 mT',
          Number.isFinite(value) ? { field: value } : null,
        );
      context.inputs.fieldInput.send(value);
      field = value;
      return null;
    },
    getField: () => field,
    isActive: () => active,
  };

  return {
    methods,
    sync(batch) {
      for (const message of batch.outputs.active) {
        active = message.value;
        context.events.onDidActive.fire(active);
      }
    },
    dispose() {},
  };
};
