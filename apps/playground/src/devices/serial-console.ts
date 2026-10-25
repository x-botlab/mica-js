import type { Value } from '@mica-js/ir';
import type { DeviceBehaviorApi, DeviceDescription } from '@mica-js/simulator';
import { LOGIC_VOLTAGE, packagePins } from './shared';

/**
 * Serial console: the MCU-side endpoint the widget demo binds to.
 *
 * The unified compiler cannot mount a device package's own code yet, so a
 * `teaching-mcu` symbol behaves as a passive part in this bench. This model is
 * the missing piece for the widget demo: a UART-shaped port pair plus the two
 * control values a widget needs.
 *
 * - `rx` receives a `string` the widget published and stores all nine encoded
 *   scalars (length + eight UTF-8 words). `tx` republishes them, which closes the
 *   loop: IME → device → display.
 * - `image` latches the picture index the MCU wants, `picture` republishes it for
 *   the image viewer.
 *
 * Strings travel as `u32` words on an IR output (RFC 0015's payload encoding), so
 * the model keeps one `u32` per word plus the length instead of building a byte
 * buffer.
 */

/** Package device id of the console. */
export const SERIAL_CONSOLE_DEVICE = 'lab:serial-console';

/** IR device type of the console. */
export const SERIAL_CONSOLE_TYPE = 'serial-console';

/** `u32` words a `string` topic payload occupies (32 UTF-8 bytes). */
export const SERIAL_CONSOLE_WORDS = 8;

/** Pins block of the device-package description. */
export const SERIAL_CONSOLE_PACKAGE = Object.freeze({
  pins: {
    ...packagePins(['TX', 'RX'], 'right'),
  },
  ports: {
    rx: {
      title: '接收文本',
      description: 'widget 通过 send 端口发布的文本；最多 32 字节 UTF-8。',
      direction: 'input',
      type: 'string',
    },
    tx: {
      title: '发送文本',
      description: '把最近一次接收到的文本原样发布，供 text-display 显示。',
      direction: 'output',
      type: 'string',
    },
    image: {
      title: '选择图片',
      description: '0–2：MCU 要求图像 widget 显示哪一张。',
      direction: 'input',
      type: 'number',
    },
    picture: {
      title: '当前图片',
      description: '最近一次选择的槽位，供 image-viewer 的 select 端口接收。',
      direction: 'output',
      type: 'number',
    },
  },
  designatorPrefix: 'U',
});

function wordStates(): readonly string[] {
  return Array.from({ length: SERIAL_CONSOLE_WORDS }, (_, index) => `w${index}`);
}

function initialize(api: DeviceBehaviorApi): void {
  const b = api.builder;
  api.pin('TX').configure('push-pull');
  api.pin('TX').writeDigital(b.const('bool', false));
  api.pin('RX').configure('high-z');
  api.pin('RX').pull('up');

  api.topics.subscribe('rx', (handler) => {
    const [length, ...words] = handler.args;
    if (length !== undefined) {
      handler.state<'u32'>('length').store(length as Value<'u32'>);
    }
    for (const [index, name] of wordStates().entries()) {
      const word = words[index];
      handler.state<'u32'>(name).store((word ?? handler.builder.const('u32', 0)) as Value<'u32'>);
    }
    handler.state<'bool'>('updated').store(handler.builder.const('bool', true));
  });
  api.topics.subscribe('image', (handler) => {
    const value = handler.args[0];
    if (value === undefined) return;
    handler
      .state<'u32'>('picture')
      .store(handler.builder.convert.floatToInt('u32', value as Value<'f64'>));
    handler.state<'bool'>('updated').store(handler.builder.const('bool', true));
  });
}

function update(api: DeviceBehaviorApi): void {
  const b = api.builder;
  const args: Value<'u32'>[] = [api.state<'u32'>('length').load()];
  for (const name of wordStates()) {
    args.push(api.state<'u32'>(name).load());
  }
  api.topics.publish('tx', args);
  api.topics.publish('picture', [b.convert.intToFloat('f64', api.state<'u32'>('picture').load())]);
  api.pin('TX').writeDigital(b.const('bool', false));
  api.state<'bool'>('updated').store(b.const('bool', false));
}

/** Unified-IR description of the console. */
export function createSerialConsoleDescription(): DeviceDescription {
  const states: Record<
    string,
    { readonly type: 'u32' | 'bool'; readonly initial: number | boolean }
  > = {
    length: { type: 'u32', initial: 0 },
    picture: { type: 'u32', initial: 0 },
    updated: { type: 'bool', initial: false },
  };
  for (const name of wordStates()) {
    states[name] = { type: 'u32', initial: 0 };
  }
  return {
    name: SERIAL_CONSOLE_TYPE,
    pins: {
      TX: { direction: 'output' },
      RX: { direction: 'input' },
    },
    states,
    powerDomains: [{ name: 'vdd', voltage: LOGIC_VOLTAGE }],
    ports: {
      rx: { direction: 'input', type: 'string', title: '接收文本' },
      tx: { direction: 'output', type: 'string', title: '发送文本' },
      image: { direction: 'input', type: 'number', title: '选择图片' },
      picture: { direction: 'output', type: 'number', title: '当前图片' },
    },
    behaviors: { initialize, update },
  };
}
