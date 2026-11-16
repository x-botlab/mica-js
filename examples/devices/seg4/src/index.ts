/**
 * 四位七段数码管的统一器件适配器。
 *
 * DDL 仍在一次扫描稳定后锁存每一位的段码；这里把四个输出通道收拢成一份显示状态，
 * 仅在任一数位真正变化时触发一次 `onDidDisplayChange`。初始状态通过 `getDisplay`
 * 查询，展示先订阅事件再查询，符合统一模型「先监听、再查询」的交付顺序。
 */

const DIGITS = ['digit1', 'digit2', 'digit3', 'digit4'] as const;

type Digit = (typeof DIGITS)[number];

export const create: DeviceFactory = (context) => {
  const display: Record<Digit, number> = {
    digit1: 0,
    digit2: 0,
    digit3: 0,
    digit4: 0,
  };

  const snapshot = (): Record<Digit, number> => ({
    digit1: display.digit1,
    digit2: display.digit2,
    digit3: display.digit3,
    digit4: display.digit4,
  });

  const methods: DeviceMethods = {
    getDisplay: () => snapshot(),
  };

  return {
    methods,
    sync(batch) {
      let changed = false;

      for (const name of DIGITS) {
        const messages = batch.outputs[name];
        const latest = messages[messages.length - 1];

        if (latest === undefined) continue;

        const value = Math.max(0, Math.min(255, Math.trunc(latest.value)));

        if (display[name] === value) continue;

        display[name] = value;
        changed = true;
      }

      if (changed) context.events.onDidDisplayChange.fire(snapshot());
    },
    dispose() {},
  };
};
