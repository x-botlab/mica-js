import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { gpioAfr0State, gpioAfr1State, gpioModerState } from './layout';
import { boolAnd, num } from './ir';
import type { Body } from './ir';

/**
 * 一根脚当前是否被配置为指定 AF：MODER=10 且 AFR nibble 等于 af。
 * I2C/SPI 的采样和引脚同步共用，避免两套重复的寄存器判定。
 */
export function pinConfigured(
  b: Body,
  port: number,
  pin: number,
  af: number,
): Value<boolean> {
  const moderate = b.equal(
    types.number,
    b.bitAnd(
      b.shiftRightUnsigned(b.readState(gpioModerState(port), types.number), num(b, pin * 2)),
      num(b, 3),
    ),
    num(b, 2),
  );
  const afRegister =
    pin < 8
      ? b.readState(gpioAfr0State(port), types.number)
      : b.readState(gpioAfr1State(port), types.number);
  const selected = b.bitAnd(
    b.shiftRightUnsigned(afRegister, num(b, (pin & 7) * 4)),
    num(b, 0xf),
  );

  return boolAnd(b, moderate, b.equal(types.number, selected, num(b, af)));
}
