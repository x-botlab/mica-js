import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { PERIPH, RCC_RCC_STATE, RCC_STATE_SIZE } from './layout';
import { asBody, num, readWord, readWordAt, u32, writeWord } from './ir';
import type { Body } from './ir';

/**
 * RCC 的寄存器后备模型。
 *
 * 只保证固件常见的「使能—等待就绪—读回时钟源」序列可用：
 * - CR 的 HSION/HSEON/PLLON 写入后对应就绪位立即为 1；
 * - CFGR 的 SWS 跟随 SW，固件可以轮询到目标时钟源；
 * - 各 AHB/APB 时钟使能位原样保存，GPIO/USART 访问不检查使能位（已知简化）。
 * 真正的 PLL 倍频、HSE 晶振与时钟安全系统不在模型内，指令耗时由 `clockFrequency`
 * 属性直接给出。
 *
 * CR 与 CFGR 是仅有的两个「读值经过合成」的寄存器，其余偏移直接读后备字；
 * 写路径就是一次字节合并写，不再逐个偏移生成比较。
 */

const CR = 0x00;
const CFGR = 0x08;

const at = (b: Body, offset: Value<number>): Value<number> => b.add(num(b, RCC_RCC_STATE), offset);

function readMerged(b: Body, offset: number): Value<number> {
  const stored = readWordAt(b, PERIPH, RCC_RCC_STATE + offset);

  if (offset === CR) {
    const hsi = b.bitOr(stored, b.shiftLeft(b.bitAnd(stored, num(b, 1)), num(b, 1)));
    const hse = b.bitOr(hsi, b.shiftLeft(b.bitAnd(stored, num(b, 1 << 16)), num(b, 1)));
    const pll = b.bitOr(hse, b.shiftLeft(b.bitAnd(stored, num(b, 1 << 24)), num(b, 1)));

    return b.bitOr(pll, num(b, 1 << 10)); // HSIRDY 复位后为 1
  }

  const sw = b.bitAnd(stored, num(b, 3));

  return b.bitOr(b.bitAnd(stored, num(b, 0xfffffff3)), b.shiftLeft(sw, num(b, 2)));
}

export function readRcc(b: Body, offset: Value<number>, size: number): Value<number> {
  const wordOffset = b.bitAnd(offset, num(b, RCC_STATE_SIZE - 4));
  const result = b.local(types.number, 0);

  b.if(
    b.equal(types.number, wordOffset, num(b, CR)),
    (cr) => {
      cr.setLocal(result, readMerged(asBody(cr), CR));
    },
    (other) => {
      const body = asBody(other);

      body.if(
        body.equal(types.number, wordOffset, num(body, CFGR)),
        (cfgr) => {
          cfgr.setLocal(result, readMerged(asBody(cfgr), CFGR));
        },
        (plain) => {
          const scope = asBody(plain);

          plain.setLocal(result, readWord(scope, PERIPH, at(scope, wordOffset)));
        },
      );
    },
  );

  const value = b.getLocal(result);

  if (size === 4) return value;
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));
  const mask = size === 2 ? 0xffff : 0xff;

  return b.bitAnd(b.shiftRightUnsigned(value, shift), num(b, mask));
}

export function writeRcc(b: Body, offset: Value<number>, size: number, value: Value<number>): void {
  const wordOffset = b.bitAnd(offset, num(b, RCC_STATE_SIZE - 4));

  if (size === 4) {
    writeWord(b, PERIPH, at(b, wordOffset), u32(b, value));

    return;
  }

  const current = readWord(b, PERIPH, at(b, wordOffset));
  const width = size === 2 ? 0xffff : 0xff;
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));
  const placed = b.shiftLeft(b.bitAnd(u32(b, value), num(b, width)), shift);
  const mask = b.shiftLeft(num(b, width), shift);

  writeWord(b, PERIPH, at(b, wordOffset), b.bitOr(b.bitAnd(current, b.bitNot(mask)), placed));
}
