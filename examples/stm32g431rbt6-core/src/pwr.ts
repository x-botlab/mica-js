import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { PERIPH, PWR_STATE } from './layout';
import { asBody, num, readWord } from './ir';
import type { Body } from './ir';

/**
 * PWR 的寄存器读回。
 *
 * 其余偏移直接读后备字；只有 SR1/SR2 的「就绪」位需要合成：它们由硬件在配置生效后
 * 置位，固件从不写入，所以后备区永远是 0。HAL 的
 * `HAL_PWREx_ControlVoltageScaling` 会在这里轮询 `SR2.VOSF`（bit 10，见
 * `stm32g431xx.h` 的 `PWR_SR2_VOSF_Pos`），不合成就会一直等到超时。
 *
 * 合成规则：CR1 的 VOS 字段（bit15..14）非零即视为目标电压档已生效，同时置 VOSF
 * 与 SR2 里对应的 VOS 副本。这是「写后即就绪」的理想化，不模拟电压爬升时间。
 */
const CR1 = 0x00;
const SR2 = 0x14;
/** VOSF = bit10；SR2 的 VOS[1:0] 副本 = bit15..14。 */
const SR2_VOSF = 1 << 10;
const SR2_VOS = 0xc000;

function extract(b: Body, word: Value<number>, offset: Value<number>, size: number): Value<number> {
  if (size === 4) return word;
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));

  return b.bitAnd(b.shiftRightUnsigned(word, shift), num(b, size === 2 ? 0xffff : 0xff));
}

export function readPwr(b: Body, offset: Value<number>, size: number): Value<number> {
  const wordOffset = b.bitAnd(offset, num(b, 0x3fc));
  const stored = readWord(b, PERIPH, b.add(num(b, PWR_STATE), wordOffset));
  const result = b.local(types.number, stored);

  b.if(b.equal(types.number, wordOffset, num(b, SR2)), (sr2) => {
    const body = asBody(sr2);
    const vos = body.bitAnd(
      body.shiftRightUnsigned(readWord(body, PERIPH, num(body, PWR_STATE + CR1)), num(body, 14)),
      num(body, 3),
    );
    const ready = body.select(
      types.number,
      body.notEqual(types.number, vos, num(body, 0)),
      (yes) => yes.constant(types.number, SR2_VOSF | SR2_VOS),
      (no) => no.constant(types.number, 0),
    );

    body.setLocal(result, body.bitOr(stored, ready));
  });

  return extract(b, b.getLocal(result), offset, size);
}
